/*
  RLS hardening.

  This migration introduces no features. It closes the distance between rules
  that already existed and the policies that were letting clients walk around
  them. `scripts/pg/rls-hardening-harness.mjs` runs the whole chain against a
  real Postgres under RLS and proves each of the four, twice: the guard refuses,
  and the honest path still works. A guard that refuses everything is not a fix,
  it is an outage.

  ⚠ Numbered 48, not 46.

    46 was reserved for this file while the hub rebrand shipped as 47. Because
    47 is already applied on staging, a file numbered 46 would sort before the
    last applied migration and `db push` would silently skip it without
    `--include-all`. The panel entry in `src/lib/schema-gap.ts` names 48 to
    match.
*/

-- ------------------------------------------- 1. a parcel carries a selfie ----
/*
  44's missing half.

  44 added `attach_capture_on_insert`, a BEFORE INSERT trigger that resolves a
  completed capture session into `sender_photo_path`. On a null session it
  returns early and leaves the refusal to the policy — so the policy is the
  only thing standing between the app and a parcel with no selfie on it.

  ⚠ Every earlier guard is repeated verbatim, for the fifth time.

    01 -> 09 -> 42 -> 44, and each one carried this warning forward: recreating
    this policy with only the new condition quietly drops the others and lets a
    client post a parcel pre-assigned to a driver. The list below is 44's,
    unchanged. Read it against 44 before editing it.
*/
drop policy if exists "sender creates own" on public.bookings;
create policy "sender creates own"
  on public.bookings for insert
  to authenticated
  with check (
    sender_id = (select auth.uid())
    -- A parcel cannot be posted pre-assigned; claiming is a separate step.
    and driver_id is null
    and driver is null
    and status = 'Booked'
    and not public.is_erased()
    and public.is_verified_sender()
    and sender_photo_path is not null
  );

-- ------------------------------ 2. the delivery record belongs to the server --
/*
  `advance_booking` owns the delivery record. Nothing else may write it.

  The update policy on bookings lets the carrier write their own row, which it
  has to — a driver edits notes and a sender edits an address. But "their own
  row" was column-blind, so a driver could PATCH `status = 'Delivered'` straight
  through PostgREST: no pickup, no proof, no recipient name. Worse than a wrong
  status, `record_delivery_earning` fires on any transition into Delivered, so
  that was a delivery that never happened, paid.

  ⚠ How the guard tells a client apart from the function that owns the column.

    `advance_booking`, `cancel_booking`, `respond_to_offer`, `admin_assign_parcel`
    and `erase_person` are all SECURITY DEFINER and owned by the migration role,
    so inside them `current_user` is that role. A PATCH arriving through
    PostgREST runs as `authenticated`. Checking `current_user` therefore needs no
    changes to any of those functions — which matters, because they are in
    migrations that have already been pushed and cannot be edited.

  ⚠ This function must NOT be SECURITY DEFINER.

    If it were, `current_user` inside it would always be the owner and the guard
    would never fire on anyone. The harness mutates exactly this and expects the
    delivery assertions to fail.
*/
create or replace function public.guard_delivery_state()
returns trigger language plpgsql as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.status       is distinct from old.status
     or new.picked_up_at is distinct from old.picked_up_at
     or new.delivered_at is distinct from old.delivered_at
     or new.received_by  is distinct from old.received_by
     or new.proof_path   is distinct from old.proof_path
     or new.proof_note   is distinct from old.proof_note
     or new.cancelled_at is distinct from old.cancelled_at
  then
    raise exception
      'The delivery record is written by advance_booking, not by the client. Call public.advance_booking(booking_id, received_by_name, proof, note), or public.cancel_booking to cancel.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists on_booking_guard_delivery_state on public.bookings;
create trigger on_booking_guard_delivery_state
  before update on public.bookings
  for each row execute function public.guard_delivery_state();

-- ------------------------------- 3. a ban holds until an admin lifts it -------
/*
  Approval was checked when the journey was created and never again.

  15 let a driver update their own journey on identity alone. So a driver who
  was banned after creating a journey could set it back to 'open' and carry on
  receiving offers — the ban held exactly until they pressed a button.
  `is_approved_driver()` already reads `driving_banned_at` and `deleted_at`
  (09), so re-checking it here is the whole fix.

  ⚠ A row an UPDATE policy hides is not an error, it is zero rows.

    The USING clause makes the banned driver's row match nothing, so the
    statement succeeds and reports no error. The harness asserts on what the row
    says afterwards, not on whether the call threw.
*/
/*
  ⚠ Recreated under 15's own name, not added alongside it.

    Policies for the same action are permissive and OR together. A new policy
    beside "driver updates own journey" would have left 15's identity-only
    branch intact, so the banned driver would still have matched it and the ban
    would still have done nothing. Replacing the name is the fix; adding one is
    not.
*/
drop policy if exists "driver updates own journey" on public.driver_journeys;
create policy "driver updates own journey"
  on public.driver_journeys for update
  to authenticated
using (driver_id = (select auth.uid()) and (select public.is_approved_driver()))
with check (driver_id = (select auth.uid()) and (select public.is_approved_driver()));

-- ---------------------------------- 4. the audit log names who wrote to it ----
/*
  `actor_id is null` is how a genuine system event is recorded.

  07 allowed a client to send it, which let any signed-in account sign an entry
  as the platform — in the one table an incident would be reconstructed from.
  The column already defaults to `auth.uid()`, so an honest client never sends
  it at all and nothing in the app changes.
*/
drop policy if exists "anyone signed in may log" on public.app_events;
create policy "anyone signed in may log"
  on public.app_events for insert
  to authenticated
with check (actor_id = (select auth.uid()));

notify pgrst, 'reload schema';
