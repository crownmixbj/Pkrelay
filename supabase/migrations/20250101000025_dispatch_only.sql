-- LOCI — an offer becomes the only way a driver gets a parcel.
--
-- Run after 01–24. Re-runnable.
--
--   Flash (intrastate)     local parcels, offered automatically, 5-minute hold
--   Scheduled (interstate) declared routes, offered automatically, 10-minute hold
--
-- No browsing, no claiming, no board. A driver carries a parcel because LOCI
-- offered it and they accepted inside the window.
--
-- ⚠ REMOVING THE BUTTONS IS NOT REMOVING THE CAPABILITY.
--
--   `20250101000002_driver_applications.sql` grants this:
--
--       create policy "claim or advance" on public.bookings for update
--         using (
--           (driver_id is null and status = 'Booked' and public.is_approved_driver())
--           or driver_id = (select auth.uid())
--           or sender_id = (select auth.uid())
--         )
--
--   The first branch is a claim: any approved driver may write their own id onto
--   any unassigned parcel in the country, in one PATCH, with no offer involved.
--   Deleting the marketplace screen leaves that branch exactly where it is — the
--   separation would be a UI convention that anyone with the anon key and a
--   REST client can ignore, including a future screen of ours that forgets.
--
--   So the policy loses its claim branch. `respond_to_offer` is SECURITY
--   DEFINER and does not consult RLS, so accepting an offer keeps working; it
--   becomes the only door.
--
-- ⚠ AND THIS REMOVES THE ONLY THING THAT WORKS WHEN DISPATCH BREAKS.
--
--   Dispatch has failed silently twice on this project: a stale offer that
--   bricked a parcel permanently (20), and an ambiguous column that made every
--   call raise (23). Both times the open board was how parcels still moved.
--
--   Taking it away without a replacement means the next dispatch bug is total
--   rather than partial. `admin_assign_parcel` below is the replacement: one
--   audited human path, held by admins rather than offered to every driver.

do $$
begin
  if to_regprocedure('public.respond_to_offer(uuid, boolean)') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;
end
$$;

-- ------------------------------------------------ no more claiming a parcel --

/**
 * Advance a parcel you are already carrying, or one you sent.
 *
 * Replaces "claim or advance" from 20250101000002_driver_applications.sql. The name loses
 * "claim" because the policy does: what is left is advancing.
 *
 *   driver_id = auth.uid()   the carrier moves it through the stages
 *   sender_id = auth.uid()   the sender cancels, or edits before assignment
 *
 * A driver is no longer among the people who may touch a parcel that is not
 * theirs. Becoming its carrier happens in `respond_to_offer`, which checks the
 * offer is live, is theirs, and that they are still approved — three things a
 * row-level policy cannot express.
 */
drop policy if exists "claim or advance" on public.bookings;
drop policy if exists "advance own parcel" on public.bookings;
create policy "advance own parcel"
  on public.bookings for update
  to authenticated
  using (
    driver_id = (select auth.uid())
    or sender_id = (select auth.uid())
  )
  with check (
    /*
      A driver may not hand a parcel to somebody else, and may not take one.

      `driver_id = auth.uid()` on the check side means any row a driver writes
      still names them as the carrier — so this cannot be used to reassign.
    */
    driver_id = (select auth.uid())
    or (sender_id = (select auth.uid()) and driver_id is null)
  );

/*
  ⚠ One behaviour genuinely lost here, and it is worth being explicit.

    A sender could previously not claim their own parcel either — that branch
    required `is_approved_driver()` — so nothing changes for senders. What is
    lost is a driver taking an unassigned parcel directly. That is the point of
    the file, but it does mean any client code still calling `claimBooking`
    against an unassigned row now silently updates zero rows rather than
    erroring. `src/store/bookings.tsx` reads that as 'taken', which is the right
    thing to show, but the call should go — see `available-packages.tsx`.
*/

-- ------------------------------------------------------ the human fallback --

/**
 * Assigns a parcel to a driver, by hand, as an admin.
 *
 * The escape hatch that replaces the board. Dispatch is automatic and dispatch
 * has broken before; somebody has to be able to move a parcel that the matcher
 * will not.
 *
 * Deliberately narrower than the board it replaces:
 *
 *   - Admins only, not every approved driver.
 *   - The parcel must genuinely be unassigned, so this cannot take a trip off
 *     the driver already carrying it.
 *   - The driver must be approved, checked here rather than trusted from the
 *     caller.
 *   - Every use writes an `app_events` row naming the admin. A manual override
 *     that leaves no trace is indistinguishable from the bug it was working
 *     around.
 *
 * Any live offer on the parcel is settled, not left dangling — otherwise the
 * partial unique index and the offer row disagree about whether the parcel is
 * out with somebody, which is exactly the bug in 20250101000020_dispatch_repair.sql.
 */
create or replace function public.admin_assign_parcel(parcel uuid, driver uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  parcel_status text;
  parcel_driver uuid;
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  select status, driver_id into parcel_status, parcel_driver
  from public.bookings where id = parcel;

  if parcel_status is null then
    raise exception 'No such parcel';
  end if;

  if parcel_driver is not null then
    raise exception 'That parcel already has a driver';
  end if;

  if parcel_status <> 'Booked' then
    raise exception 'That parcel is % and cannot be assigned', parcel_status;
  end if;

  if not exists (
    select 1 from public.driver_applications a
    where a.user_id = driver and a.status = 'approved'
  ) then
    raise exception 'That driver is not approved';
  end if;

  -- Settle any live offer first, so nothing is left believing it is out.
  update public.dispatch_offers
     set status = 'expired', responded_at = coalesce(responded_at, now())
   where booking_id = parcel
     and status = 'offered';

  update public.bookings
     set driver_id = driver,
         status = 'Assigned'
   where id = parcel;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning', 'dispatch', 'admin assigned a parcel by hand',
    -- warn, not info: every row here is a parcel automatic dispatch did not
    -- move, and a run of them is a dispatch bug rather than an admin habit.
    jsonb_build_object('booking', parcel, 'driver', driver),
    actor
  );
end;
$$;

revoke all on function public.admin_assign_parcel(uuid, uuid) from public, anon;
grant execute on function public.admin_assign_parcel(uuid, uuid) to authenticated;

/*
  ⚠ What this file does not change, because it did not need to.

    The intrastate/interstate split is already total in `journey_matches`
    (20250101000018_flash_mode.sql, relabelled STABLE in 22):

      flash      parcel_origin = parcel_destination and parcel_origin = journey_origin
      scheduled  journey_origin = parcel_origin and journey_destination = parcel_destination

    A flash shift therefore cannot be offered an interstate parcel — both ends
    of the parcel must equal the one city the driver is sitting in. And a
    scheduled journey cannot be offered a local parcel, because
    `journey_route_distinct` forbids a scheduled route from having the same city
    at both ends, so it can never satisfy origin = destination.

    The windows follow the parcel, not the journey: `offer_hold(is_local)` in 21
    gives 5 minutes to a local trip and 10 to an interstate one, decided from the
    booking's own cities.

    The 15-minute cooldown (23) and the notifier (24) are unchanged and apply to
    both modes, because neither one asks what mode an offer came from.
*/
