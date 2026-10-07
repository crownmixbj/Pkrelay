-- ============================================================================
-- 20250101000080_parcel_release.sql — handing a parcel back
-- ============================================================================
--
-- Run after 79. Re-runnable. Apply to BOTH staging and production.
--
-- Three things, one subject: a parcel that has been claimed but not collected
-- can be taken off the driver again — by them, or by an administrator.
--
-- ⚠ The driver half has never worked. Not once, on any environment.
--
--   `cancel_booking` (11) clears `driver_id` to put the parcel back on the
--   board. `bookings_guard_immutable` (01) refuses *any* change to `driver_id`
--   once it is set:
--
--     if old.driver_id is not null and new.driver_id is distinct from old.driver_id
--       then raise exception 'a claimed job cannot be reassigned';
--
--   01 predates 11 by ten migrations and nothing ever revisited it, so pressing
--   Release has always produced "That did not go through. a claimed job cannot
--   be reassigned (P0001)". The button on the mobile driver hub has been dead
--   since the day it shipped, and the web driver screen never had one at all.
--
-- ⚠ The guard was also breaking erasure, quietly.
--
--   `bookings.driver_id` is `on delete set null`. A referential action fires
--   row triggers, so deleting a driver's auth user ran this same guard against
--   `new.driver_id is null` and raised — aborting the erasure of anybody who
--   had ever carried a parcel. Relaxing the guard fixes both, which is why it
--   is relaxed rather than special-cased for `cancel_booking`.
--
-- ⚠ What the guard still refuses, and it is the thing it was written for:
--   driver A's parcel becoming driver B's in one UPDATE. Releasing goes through
--   null — back to the open board, where the next claim is a fresh decision by
--   somebody who can see the job — so there is no path that silently moves a
--   parcel between two people.
--
-- ⚠ A release is not a decline, and the difference is the whole of
--   `parcel_releases`.
--
--   23 made a decline a fifteen-minute cooldown rather than a permanent block,
--   and 78 removed the index that was still enforcing the old rule. None of
--   that should change: a driver who let an offer lapse at 07:00 may well want
--   it at 07:30. But a driver who *accepted* and then handed the parcel back
--   has answered a stronger question, and the matcher offering it to them again
--   fifteen minutes later is the loop the brief asks to close. So the pair is
--   recorded and `dispatch_booking` skips it from then on.
--
--   It is skipped for *offers*, not for everything. The parcel stays on the
--   open jobs board and that driver can still claim it by hand if they change
--   their mind back, and an administrator can still assign it to them —
--   `assignable_drivers` says so in the row's note rather than hiding them,
--   which is the call that file has always made.
--
-- ⚠ Both releases stop at collection.
--
--   'Assigned' is the whole window, for the driver and for the administrator.
--   Once the parcel is 'Picked Up' somebody is holding another person's
--   property and there is no flow in this app for giving it back; marking it
--   unassigned would leave a parcel on the open board that is physically in a
--   bag in Ibadan. The refusal says so and names what to do instead.

do $$
begin
  if to_regprocedure('public.cancel_booking(uuid,text)') is null then
    raise exception 'Run 20250101000011_cancellation.sql first.';
  end if;

  if to_regprocedure('public.dispatch_booking(uuid)') is null then
    raise exception 'Run 20250101000032_dispatch_mode.sql first.';
  end if;
end
$$;

-- ------------------------------------------------- 1. the guard, relaxed --

/**
 * The columns nobody may rewrite after the fact.
 *
 * Replaces 01's version. One change: `driver_id` may go to null.
 *
 * ⚠ `new.driver_id is not null` is the added condition, and it is doing two
 *   jobs — permitting a release, and permitting the `on delete set null` that
 *   erasure depends on. Both are a parcel losing its carrier, which is a thing
 *   that is allowed to happen; what is not allowed is a parcel gaining a
 *   different one without passing back through the board.
 */
create or replace function public.bookings_guard_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sender_id     is distinct from old.sender_id
     or new.tracking_id  is distinct from old.tracking_id
     or new.estimated_fee is distinct from old.estimated_fee
     or new.created_at   is distinct from old.created_at then
    raise exception 'sender_id, tracking_id, estimated_fee and created_at are immutable';
  end if;

  /*
    A claimed job cannot be handed straight to a different driver. It can be
    let go of — `cancel_booking` and `admin_release_parcel` both do that by
    writing null, and so does erasing the driver's account.
  */
  if old.driver_id is not null
     and new.driver_id is not null
     and new.driver_id is distinct from old.driver_id then
    raise exception 'a claimed job cannot be handed to another driver — release it first';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_guard_immutable on public.bookings;
create trigger bookings_guard_immutable
  before update on public.bookings
  for each row execute function public.bookings_guard_immutable();

-- ------------------------------------------------ 2. who gave what back --

/**
 * One row per (parcel, driver) that was accepted and then handed back.
 *
 * ⚠ Keyed on the pair, so releasing the same parcel twice is one row.
 *
 *   A driver can only release a parcel they currently hold, so a second release
 *   means they claimed it again and changed their mind again. That is the same
 *   fact with a later timestamp, so both writers delete and re-insert rather
 *   than growing a row per episode.
 *
 *   ⚠ Delete-then-insert rather than `on conflict do update`, and the reason is
 *     the one 69 is about. `cancel_booking`'s parameters are named `booking_id`
 *     and `reason`; this table's columns are named `booking_id` and `reason`.
 *     Inside `on conflict (booking_id, …) do update set reason = …` plpgsql
 *     cannot tell which is meant and raises before writing anything. A
 *     qualified delete followed by a plain insert has no identifier that could
 *     mean two things.
 *
 * ⚠ No insert, update or delete policy, deliberately. The only writers are the
 *   two `security definer` functions below. A driver cannot un-record their own
 *   release and an administrator cannot hand-edit the history that explains why
 *   dispatch is skipping somebody.
 */
create table if not exists public.parcel_releases (
  booking_id  uuid not null references public.bookings (id) on delete cascade,
  driver_id   uuid not null references auth.users (id) on delete cascade,
  released_at timestamptz not null default now(),
  /** 'driver' gave it back; 'admin' took it off them. */
  released_by text not null check (released_by in ('driver', 'admin')),
  reason      text,
  primary key (booking_id, driver_id)
);

create index if not exists parcel_releases_driver_idx
  on public.parcel_releases (driver_id, released_at desc);

alter table public.parcel_releases enable row level security;

drop policy if exists "driver reads own releases" on public.parcel_releases;
create policy "driver reads own releases"
  on public.parcel_releases for select
  to authenticated
  using (driver_id = (select auth.uid()) or public.is_admin());

comment on table public.parcel_releases is
  'Parcels accepted and then handed back. dispatch_booking will not re-offer these pairs (80).';

-- ------------------------------------------- 3. the driver gives it back --

/**
 * Cancels a booking, or — for a driver — releases it back to the board.
 *
 * Replaces 11's version. Two changes to the driver branch, nothing else:
 * the release is recorded in `parcel_releases`, and any offer row the driver
 * still holds on this parcel is settled so `dispatch_booking` is not looking at
 * a live 'accepted' offer for a parcel that no longer has a driver.
 *
 * The sender branch is 11's, verbatim.
 */
create or replace function public.cancel_booking(
  booking_id uuid,
  reason text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  row_status text;
  row_sender uuid;
  row_driver uuid;
  actor_role text;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select status, sender_id, driver_id
    into row_status, row_sender, row_driver
  from public.bookings where id = booking_id;

  if row_status is null then
    raise exception 'No such booking';
  end if;

  /*
    The actor's role is derived from the row, never taken as an argument.

    Passing it in would let a sender claim to be the driver and cancel inside
    the wrong window.
  */
  if row_sender = actor then
    actor_role := 'sender';
  elsif row_driver is not distinct from actor then
    actor_role := 'driver';
  else
    raise exception 'This parcel is not yours to cancel';
  end if;

  if row_status = 'Cancelled' then
    raise exception 'This parcel is already cancelled';
  end if;

  if not public.cancellation_allowed(row_status, actor_role) then
    if actor_role = 'sender' then
      raise exception 'A driver has already accepted this parcel, so it can no longer be cancelled here. Contact support.';
    else
      raise exception 'You have already collected this parcel, so it cannot be released. Contact support if you cannot complete the delivery.';
    end if;
  end if;

  if actor_role = 'driver' then
    /*
      ⚠ Recorded before the parcel is let go.

        `admin_assign_parcel` and `dispatch_booking` both read this table, and
        both can run the moment `driver_id` goes null — the redispatch sweep is
        a cron job, not a queue. Writing the release second would leave a window
        in which the matcher could hand the parcel straight back to the person
        who just gave it up, which is the exact loop this is for.
    */
    /*
      ⚠ `cancel_booking.booking_id`, qualified — the same trap 69 was written
        about, one table along. The parameter is named `booking_id` and so is
        the column it is being written into, and plpgsql's default
        `variable_conflict = error` raises on the ambiguity rather than guessing.
    */
    delete from public.parcel_releases r
     where r.booking_id = cancel_booking.booking_id
       and r.driver_id = actor;

    insert into public.parcel_releases (booking_id, driver_id, released_by, reason)
    values (
      cancel_booking.booking_id,
      actor,
      'driver',
      nullif(btrim(coalesce(reason, '')), '')
    );

    /*
      Their offer is settled rather than left at 'accepted'.

      An offer row that still says accepted, on a parcel with no driver, is a
      contradiction every count in the dispatch screen would have to special-
      case. 'expired' is the status the rest of the schema uses for an offer
      that ended without a delivery.
    */
    update public.dispatch_offers
       set status = 'expired', responded_at = coalesce(responded_at, now())
     where dispatch_offers.booking_id = cancel_booking.booking_id
       and driver_id = actor
       and status in ('offered', 'accepted');

    /*
      Back to the open board, in one statement.

      The parcel returns to 'Booked' with no driver, so any approved driver can
      claim it again. It is the sender's parcel and it has not moved — parking
      it for an admin would leave it invisible until someone woke up.

      Note this is *not* a cancellation of the parcel: the shipment survives,
      only the assignment ends. The audit line below records that distinction.
    */
    update public.bookings
       set status = 'Booked',
           driver = null,
           driver_id = null,
           accepted_at = null
     where id = booking_id;

    insert into public.app_events (level, area, message, context, actor_id)
    values (
      'warning',
      'delivery',
      'driver released an accepted job',
      jsonb_build_object(
        'booking', booking_id,
        'reason', left(coalesce(reason, ''), 200)
      ),
      actor
    );

    return 'Booked';
  end if;

  update public.bookings
     set status = 'Cancelled',
         cancelled_at = now(),
         cancelled_by = actor,
         cancelled_role = 'sender',
         cancellation_reason = nullif(trim(coalesce(reason, '')), '')
   where id = booking_id;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info',
    'delivery',
    'sender cancelled a parcel',
    -- Ids and a reason. No address, recipient name or phone: an admin reads
    -- this log and a parcel's contact details are not theirs by default.
    jsonb_build_object(
      'booking', booking_id,
      'reason', left(coalesce(reason, ''), 200)
    ),
    actor
  );

  return 'Cancelled';
end;
$$;

revoke all on function public.cancel_booking(uuid, text) from public, anon;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

-- --------------------------------------------- 4. the admin takes it back --

/**
 * Takes a parcel back off a driver who is sitting on it.
 *
 * ⚠ A reason is required, and this is the one argument that is not optional.
 *
 *   The driver is told nothing by the status change itself — their parcel
 *   simply disappears from their list — so the only record of why somebody's
 *   accepted job was taken away is this string, in `app_events`. An unexplained
 *   override is the kind an operator cannot defend a week later.
 *
 * ⚠ Logged at 'warning', like `admin_record_delivery`. One of these is an
 *   operator doing their job; a run of them is dispatch handing parcels to
 *   drivers who do not collect them, which is a matching problem rather than an
 *   admin habit.
 */
create or replace function public.admin_release_parcel(
  parcel uuid,
  reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  parcel_status text;
  parcel_driver uuid;
  clean_reason text := nullif(btrim(coalesce(reason, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  select status, driver_id into parcel_status, parcel_driver
  from public.bookings where id = parcel;

  if parcel_status is null then
    raise exception 'No such parcel';
  end if;

  if parcel_driver is null then
    raise exception 'That parcel has no driver to take it off';
  end if;

  if parcel_status = 'Cancelled' then
    raise exception 'That parcel is cancelled';
  end if;

  if parcel_status = 'Delivered' then
    raise exception 'That parcel has been delivered';
  end if;

  /*
    After collection this is the wrong tool, and the message says which is the
    right one. A parcel in somebody's bag cannot be put back on the open board.
  */
  if parcel_status <> 'Assigned' then
    raise exception
      'That parcel is % — the driver already has it. Reassigning stops at collection; record the delivery or cancel it instead',
      parcel_status;
  end if;

  if clean_reason is null or length(clean_reason) < 4 then
    raise exception 'Say why this parcel is being taken off the driver';
  end if;

  /* Recorded first, for the reason in `cancel_booking`. */
  delete from public.parcel_releases r
   where r.booking_id = parcel and r.driver_id = parcel_driver;

  insert into public.parcel_releases (booking_id, driver_id, released_by, reason)
  values (parcel, parcel_driver, 'admin', clean_reason);

  update public.dispatch_offers
     set status = 'expired', responded_at = coalesce(responded_at, now())
   where booking_id = parcel
     and driver_id = parcel_driver
     and status in ('offered', 'accepted');

  update public.bookings
     set status = 'Booked',
         driver = null,
         driver_id = null,
         accepted_at = null
   where id = parcel;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning', 'dispatch', 'admin took a parcel off a driver',
    jsonb_build_object(
      'booking', parcel,
      'driver', parcel_driver,
      'reason', left(clean_reason, 200)
    ),
    actor
  );
end;
$$;

revoke all on function public.admin_release_parcel(uuid, text) from public, anon;
grant execute on function public.admin_release_parcel(uuid, text) to authenticated;

-- ------------------------------------- 5. the matcher stops offering it --

/**
 * Offers a parcel to the best available driver.
 *
 * Replaces 32's version. One new condition in the candidate query: a driver who
 * has released this parcel is not offered it again. Everything else — the
 * manual-mode early return, the cooldown, the untried-first tiebreak, the
 * soonest-departure ordering 75 relies on — is 32's, unchanged.
 */
create or replace function public.dispatch_booking(booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  parcel record;
  chosen record;
  offer_id uuid;
  local_trip boolean;
  hold interval;
  cooldown interval := public.offer_cooldown();
begin
  /*
    Manual mode: do nothing, quietly.

    No exception and no event row. This function runs inside the booking insert
    trigger, so raising would stop a sender posting a parcel — and logging every
    call would write one line per booking per sweep for as long as the mode is
    held, burying the mode change itself under its own consequences. The mode
    switch is audited once, in `set_dispatch_mode`, which is where somebody
    reading the log will look.
  */
  if public.dispatch_mode() = 'manual' then
    return null;
  end if;

  select id, origin_city, destination_city, weight, status, driver_id
    into parcel
  from public.bookings where id = booking_id;

  if parcel.id is null then
    return null;
  end if;

  if parcel.status <> 'Booked' or parcel.driver_id is not null then
    return null;
  end if;

  local_trip := parcel.origin_city = parcel.destination_city;
  hold := public.offer_hold(local_trip);

  update public.dispatch_offers
     set status = 'expired', responded_at = coalesce(responded_at, now())
   where dispatch_offers.booking_id = dispatch_booking.booking_id
     and status = 'offered'
     and expires_at <= now();

  if exists (
    select 1 from public.dispatch_offers
    where dispatch_offers.booking_id = dispatch_booking.booking_id
      and status = 'offered'
      and expires_at > now()
  ) then
    return null;
  end if;

  select j.id, j.driver_id
    into chosen
  from public.driver_journeys j
  where j.status = 'open'
    and public.journey_matches(
      j.origin_city, j.destination_city, j.departs_after, j.departs_before,
      j.capacity_kg, parcel.origin_city, parcel.destination_city, parcel.weight,
      j.mode, j.departure_time
    )
    and public.documents_permit_dispatch(j.driver_id)
    /*
      ⚠ New in 80, and not a cooldown — there is no window on it.

        A decline is "not right now" and comes back after `offer_cooldown()`. A
        release is "I took this and I am giving it back", and offering it again
        half an hour later is how a parcel spends a day bouncing between the
        matcher and one driver. They can still claim it from the board, and an
        admin can still assign it to them; what stops is the automatic offer.
    */
    and not exists (
      select 1 from public.parcel_releases r
      where r.booking_id = dispatch_booking.booking_id
        and r.driver_id = j.driver_id
    )
    and not exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id
        and o.driver_id = j.driver_id
        and o.status in ('declined', 'expired')
        and coalesce(
              case when o.status = 'expired' then o.expires_at else o.responded_at end,
              o.expires_at
            ) > now() - cooldown
    )
  order by
    (exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id and o.driver_id = j.driver_id
    )) asc,
    coalesce(j.departure_time, j.departs_before) asc,
    (j.capacity_kg - coalesce(parcel.weight, 0)) asc,
    j.created_at asc
  limit 1;

  if chosen.id is null then
    return null;
  end if;

  insert into public.dispatch_offers (booking_id, journey_id, driver_id, expires_at)
  values (booking_id, chosen.id, chosen.driver_id, now() + hold)
  on conflict do nothing
  returning id into offer_id;

  if offer_id is null then
    return null;
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'dispatch', 'parcel offered to a driver',
    jsonb_build_object(
      'booking', booking_id,
      'journey', chosen.id,
      'hold_minutes', extract(epoch from hold) / 60,
      'cooldown_minutes', extract(epoch from cooldown) / 60,
      'repeat', exists (
        select 1 from public.dispatch_offers o
        where o.booking_id = dispatch_booking.booking_id
          and o.driver_id = chosen.driver_id
          and o.id <> offer_id
      )
    ),
    null
  );

  return offer_id;
end;
$$;

revoke all on function public.dispatch_booking(uuid) from public, anon;
grant execute on function public.dispatch_booking(uuid) to authenticated;

-- ---------------------------------- 6. and the operator is told about it --

create or replace function public.assignable_drivers(parcel uuid)
returns table (
  driver_id uuid,
  full_name text,
  base_city text,
  vehicle_type text,
  phone text,
  active_parcels integer,
  has_open_journey boolean,
  route_matches boolean,
  documents_ok boolean,
  eligible boolean,
  note text,
  /** When their soonest live journey leaves. Null if none is live. New in 75. */
  next_departure timestamptz,
  /** 'scheduled' or 'flash' for that journey, so the time can be read correctly. */
  journey_mode text
)
language sql
stable
security definer
set search_path = ''
as $$
  with target as (
    select id, origin_city, destination_city, weight
    from public.bookings
    where id = parcel
  ),
  candidates as (
    select
      a.user_id as driver_id,
      a.full_name,
      coalesce(a.base_city, a.state) as base_city,
      a.vehicle_type,
      a.phone,
      (select count(*)::integer from public.bookings b
        where b.driver_id = a.user_id and b.status <> 'Delivered') as active_parcels,
      exists (
        select 1 from public.driver_journeys j
        where j.driver_id = a.user_id and j.status = 'open'
      ) as has_open_journey,
      exists (
        select 1 from public.driver_journeys j, target t
        where j.driver_id = a.user_id
          and j.status = 'open'
          and public.journey_matches(
            j.origin_city, j.destination_city, j.departs_after, j.departs_before,
            j.capacity_kg, t.origin_city, t.destination_city, t.weight,
            j.mode, j.departure_time
          )
      ) as route_matches,
      public.documents_permit_dispatch(a.user_id) as documents_ok,
      /*
        ⚠ New in 80. They took this parcel and gave it back, so the matcher
          will not offer it to them again — but they are still listed, and still
          assignable by hand. An operator is the one who knows the driver rang
          to say they are free after all, and a list that hid them would be a
          slower copy of the matcher, which is the decision this function has
          made since 32.
      */
      exists (
        select 1 from public.parcel_releases r
        where r.booking_id = parcel and r.driver_id = a.user_id
      ) as released_it,
      /*
        The soonest live departure, and the mode of that same journey — read in
        one subquery so the two cannot describe different journeys.
      */
      (
        select coalesce(j.departure_time, j.departs_before)
        from public.driver_journeys j
        where j.driver_id = a.user_id
          and j.status = 'open'
          and coalesce(j.departure_time, j.departs_before) > now()
        order by coalesce(j.departure_time, j.departs_before) asc
        limit 1
      ) as next_departure,
      (
        select j.mode::text
        from public.driver_journeys j
        where j.driver_id = a.user_id
          and j.status = 'open'
          and coalesce(j.departure_time, j.departs_before) > now()
        order by coalesce(j.departure_time, j.departs_before) asc
        limit 1
      ) as journey_mode
    from public.driver_applications a
    where public.is_admin()
      and a.status = 'approved'
  )
  select
    c.driver_id, c.full_name, c.base_city, c.vehicle_type, c.phone,
    c.active_parcels, c.has_open_journey, c.route_matches, c.documents_ok,
    c.documents_ok as eligible,
    case
      when not c.documents_ok then 'Blocked — a required document has expired'
      /*
        Said ahead of the route, because it outranks it. "Matches this route" on
        a driver who handed this very parcel back an hour ago is the one note
        that would mislead an operator into undoing their own decision.
      */
      when c.released_it then 'Released this parcel — not offered it again'
      when c.route_matches then 'Matches this route'
      when c.has_open_journey then 'Online, but not going this way'
      else 'No journey declared'
    end,
    c.next_departure,
    c.journey_mode
  from candidates c
  /*
    Departure is the third key, new in 75.

    It sits below the document gate and the route match — both of those are
    about whether this driver should be given the parcel at all — and above
    `active_parcels`, because a driver who is leaving within the hour is worth
    more than one carrying one fewer parcel and leaving tomorrow. This is the
    same preference `dispatch_booking` has applied since 26; until now the hand
    assignment screen contradicted it.
  */
  order by
    c.documents_ok desc,
    c.route_matches desc,
    c.next_departure asc nulls last,
    c.has_open_journey desc,
    c.active_parcels asc,
    c.full_name asc;
$$;

revoke all on function public.assignable_drivers(uuid) from public, anon;
grant execute on function public.assignable_drivers(uuid) to authenticated;

-- ------------------------------------------------------------------ probe --

/**
 * Deployment panel probe (src/lib/schema-gap.ts).
 *
 * ⚠ Asserts the relaxed guard, not just the new objects.
 *
 *   `parcel_releases` and `admin_release_parcel` can both exist on a database
 *   whose `bookings_guard_immutable` is still 01's — and on that database every
 *   release, by a driver or by an administrator, fails with the P0001 this file
 *   is named for. The guard is the half that was broken; it is the half worth
 *   probing.
 */
create or replace function public.release_controls_installed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    to_regclass('public.parcel_releases') is not null
    and to_regprocedure('public.admin_release_parcel(uuid,text)') is not null
    and pg_get_functiondef('public.bookings_guard_immutable()'::regprocedure)
        like '%handed to another driver%'
    and pg_get_functiondef('public.dispatch_booking(uuid)'::regprocedure)
        like '%public.parcel_releases%';
$$;

comment on function public.release_controls_installed() is
  'True when a claimed, uncollected parcel can be handed back and will not be re-offered (80).';

revoke all on function public.release_controls_installed() from public, anon;
grant execute on function public.release_controls_installed() to authenticated;

-- --------------------------------------------- 7. and the manifest grows --

/**
 * Objects defined in more than one migration, and whether the live database
 * still has the newest definition.
 *
 * Replaces 79's version. The body is 79's; the manifest gains the four objects
 * this file redefines, so a replay of 01, 11 or 32 over it is reported rather
 * than silently undoing the release path.
 *
 * ⚠ This is the maintenance cost 79 designed in, paid for the first time.
 *
 *   `verify:availability` parses the chain, works out which objects are now at
 *   risk, and fails the build if one is missing from here. Adding migration 80
 *   made four more objects at risk and the build said so before this paragraph
 *   was written, which is the whole point of the check.
 *
 * See 79 for why a marker string rather than a body comparison, and why
 * functions are matched by name across every overload.
 */
create or replace function public.stale_definitions()
returns table (object text, owner_migration text, state text)
language sql
stable
security definer
set search_path = ''
as $$
  with manifest(object, owner_migration, kind, obj_schema, obj_name, marker) as (values
    ('admin_assign_parcel'              , '069', 'fn',   'public', 'admin_assign_parcel'              , 'admin_assign_parcel.driver'),
    ('admin_guarantor_summary'          , '051', 'fn',   'public', 'admin_guarantor_summary'          , 'public.guarantor_invitations'),
    ('admin_identity_queue'             , '043', 'fn',   'public', 'admin_identity_queue'             , 'public.sender_selfie_path'),
    ('admin_overview'                   , '072', 'fn',   'public', 'admin_overview'                   , 'parcels_on_the_way'),
    ('admin_parcel_detail'              , '036', 'fn',   'public', 'admin_parcel_detail'              , 'b.item_photo_path'),
    ('admin_parcels'                    , '072', 'fn',   'public', 'admin_parcels'                    , 'on_the_way'),
    ('admin_parcels_for_driver'         , '071', 'fn',   'public', 'admin_parcels_for_driver'         , 'public.offer_attempts'),
    ('admin_payment_totals'             , '060', 'fn',   'public', 'admin_payment_totals'             , 'p.initialized_at'),
    ('admin_payments_ledger'            , '060', 'fn',   'public', 'admin_payments_ledger'            , 'public.commission_rate'),
    ('admin_reveal_identity_for_user'   , '043', 'fn',   'public', 'admin_reveal_identity_for_user'   , 'public.sender_selfie_path'),
    ('admin_review_identity'            , '043', 'fn',   'public', 'admin_review_identity'            , 'public.sender_selfie_path'),
    ('admin_waiting_drivers'            , '075', 'fn',   'public', 'admin_waiting_drivers'            , 'coalesce(j.departure_time, j.departs_before) asc'),
    ('assignable_drivers'               , '080', 'fn',   'public', 'assignable_drivers'               , 'public.parcel_releases'),
    ('begin_identity_check'             , '041', 'fn',   'public', 'begin_identity_check'             , 'review_note'),
    ('bookings_guard_immutable'         , '080', 'fn',   'public', 'bookings_guard_immutable'         , 'handed to another driver'),
    ('cancel_booking'                   , '080', 'fn',   'public', 'cancel_booking'                   , 'public.parcel_releases'),
    ('complete_guarantor_verification'  , '051', 'fn',   'public', 'complete_guarantor_verification'  , 'public.guarantor_documents'),
    ('consume_capture_session'          , '014', 'fn',   'public', 'consume_capture_session'          , 'liveness_environment'),
    ('default_application_status'       , '040', 'fn',   'public', 'default_application_status'       , 'new.review_note'),
    ('dispatch_booking'                 , '080', 'fn',   'public', 'dispatch_booking'                 , 'public.parcel_releases'),
    ('dispatch_email'                   , '053', 'fn',   'public', 'dispatch_email'                   , 'public.email_dispatch_config'),
    ('dispatch_new_booking'             , '056', 'fn',   'public', 'dispatch_new_booking'             , 'new.payment_status'),
    ('email_on_booking_status'          , '064', 'fn',   'public', 'email_on_booking_status'          , 'driver_first_name'),
    ('erase_person'                     , '033', 'fn',   'public', 'erase_person'                     , 'public.payout_change_requests'),
    ('expire_dispatch_offers'           , '021', 'fn',   'public', 'expire_dispatch_offers'           , 'coalesce'),
    ('guarantor_invitation_window'      , '054', 'fn',   'public', 'guarantor_invitation_window'      , 'interval ''30 days'''),
    ('guard_application_phone'          , '033', 'fn',   'public', 'guard_application_phone'          , 'current_setting'),
    ('guard_identity_columns'           , '034', 'fn',   'public', 'guard_identity_columns'           , 'loci.attaching_identity'),
    ('handle_new_user'                  , '045', 'fn',   'public', 'handle_new_user'                  , 'nullif(new.raw_user_meta_data'),
    ('invite_guarantor_on_submit'       , '051', 'fn',   'public', 'invite_guarantor_on_submit'       , 'public.queue_notification'),
    ('is_approved_driver'               , '009', 'fn',   'public', 'is_approved_driver'               , 'p.driving_banned_at'),
    ('journey_matches'                  , '026', 'fn',   'public', 'journey_matches'                  , 'journey_departure'),
    ('my_guarantor_status'              , '051', 'fn',   'public', 'my_guarantor_status'              , 'public.email_outbox'),
    ('notify_dispatch_offer'            , '024', 'fn',   'public', 'notify_dispatch_offer'            , 'private.pg_net_post_fn'),
    ('notify_new_driver_application'    , '067', 'fn',   'public', 'notify_new_driver_application'    , 'private.pg_net_post_fn'),
    ('open_guarantor_invitation'        , '051', 'fn',   'public', 'open_guarantor_invitation'        , 'invite.guarantor_email'),
    ('pg_net_calls_are_resolvable'      , '068', 'fn',   'public', 'pg_net_calls_are_resolvable'      , 'p.proname <> ''pg_net_calls_are_resolvable'''),
    ('queue_notification'               , '076', 'fn',   'public', 'queue_notification'               , 'foreign_key_violation'),
    ('record_identity_result'           , '041', 'fn',   'public', 'record_identity_result'           , 'candidate_path'),
    ('sweep_for_journey'                , '026', 'fn',   'public', 'sweep_for_journey'                , 'new.departure_time'),
    ('unassigned_parcels'               , '071', 'fn',   'public', 'unassigned_parcels'               , 'public.offer_attempts'),
    /*
      ⚠ The manifest lists itself, and that is not a joke.

        A replay that puts 79's `stale_definitions` back over 80's would leave a
        probe reporting on a manifest four objects short — green, and wrong,
        about the exact failure it exists to catch. The marker is a string only
        80's row set contains.
    */
    ('stale_definitions'                , '080', 'fn',   'public', 'stale_definitions'                , 'handed to another driver'),
    /*
      kind 'gone': the object must NOT exist. 23 dropped this index and 20 kept
      bringing it back with `create unique index if not exists`, so a replay of
      the early range resurrects it — which is how a driver came to be unable to
      decline the same parcel twice. 78 is the migration that found it; this row
      is what would have said so first.
    */
    ('dispatch_offers_no_repeat_decline', '078', 'gone', 'public', 'dispatch_offers_no_repeat_decline', ''),
    /*
      kind 'pol': the policy's expression must contain the marker. These two
      rows put the *table* in `obj_schema` — every policy here is on
      `public.bookings`, and giving the column a second meaning for three rows
      was cheaper than a sixth column that is null for the other forty.
    */
    ('bookings: sender creates own',             '056', 'pol', 'bookings', 'sender creates own',             'payment_status'),
    ('bookings: read own, carried, or unclaimed','056', 'pol', 'bookings', 'read own, carried, or unclaimed','payment_status')
  )
  select
    m.object::text,
    m.owner_migration::text,
    (case m.kind

      when 'gone' then
        case when to_regclass(m.obj_schema || '.' || m.obj_name) is null
             then 'current' else 'STALE' end

      when 'pol' then
        coalesce(
          (
            select case
              when coalesce(pg_get_expr(p.polqual, p.polrelid), '') ||
                   coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
                   like '%' || m.marker || '%'
              then 'current' else 'STALE' end
            from pg_policy p
            where p.polrelid = ('public.' || m.obj_schema)::regclass
              and p.polname = m.obj_name
          ),
          'MISSING'
        )

      /*
        ⚠ Looked up by name, not by signature, and `bool_or` across every
          overload.

          A signature would have to be written down here and would go wrong the
          first time a migration changed one — the probe would report MISSING on
          a function that is present and current, which is a worse lie than the
          one it exists to catch. `journey_matches` is the live example: 15
          declared it with eight arguments and 26 with ten, and both are in the
          database. A marker is absent from every older definition by
          construction, so "some overload contains it" is exactly "the newest
          definition is still there".
      */
      else
        coalesce(
          (
            select case
              when bool_or(pg_get_functiondef(p.oid) like '%' || m.marker || '%')
                then 'current'
              else 'STALE'
            end
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = m.obj_schema and p.proname = m.obj_name
          ),
          'MISSING'
        )
    end)::text
  from manifest m
  order by 3 desc, 1;
$$;

comment on function public.stale_definitions() is
  'Objects defined in more than one migration, and whether the live database still has the newest (79, extended in 80).';

revoke all on function public.stale_definitions() from public, anon;
grant execute on function public.stale_definitions() to authenticated;
