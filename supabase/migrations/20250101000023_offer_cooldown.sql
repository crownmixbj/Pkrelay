-- LOCI — one cooldown for both kinds of no.
--
-- Run after 01–22. Re-runnable.
--
--   A driver who declines a parcel, or lets its countdown run out, is not
--   offered that same parcel again for 15 minutes. The parcel keeps rotating
--   through everybody else in the meantime, and the driver stays eligible for
--   every other parcel.
--
-- This replaces two different rules with one:
--
--   before                                  after
--   ------                                  -----
--   decline  → permanent, per driver        decline  → 15 minutes
--   expiry   → the hold (5 or 10 minutes)   expiry   → 15 minutes
--
-- ⚠ A PERMANENT DECLINE BECOMING TEMPORARY IS A REAL PRODUCT CHANGE.
--
--   Until now a decline was an answer and it stuck. It is what let a driver say
--   "not this one" and be believed. After this file, a driver who declines a
--   parcel that nobody else takes will be asked about it again every 15 minutes
--   for as long as it sits unassigned — and in a city with one approved driver,
--   which is the state this project is in today, that is the same parcel coming
--   back four times an hour indefinitely.
--
--   That is what was asked for and it is implemented exactly. If the nagging
--   turns out to be the problem rather than the fix, the bound to add is a cap
--   on repeat declines — see the note at the foot of this file.

do $$
begin
  if to_regprocedure('public.offer_hold(boolean)') is null then
    raise exception 'Run 20250101000021_offer_windows.sql first.';
  end if;
end
$$;

-- ----------------------------------------------------------- the cooldown --

/**
 * How long a parcel stays away from a driver who said no to it.
 *
 * Genuinely immutable — unlike `journey_matches` before 22, this reads no
 * clock. One function so the number cannot be written in two places and drift;
 * the client mirrors it in `OFFER_COOLDOWN_MINUTES` and the verification suite
 * asserts the two agree.
 *
 * Deliberately not the same number as `offer_hold`. The hold is how long a
 * driver gets to answer; the cooldown is how long the parcel stays away
 * afterwards. They were briefly the same value and that was a coincidence, not
 * a relationship.
 */
create or replace function public.offer_cooldown()
returns interval language sql immutable set search_path = '' as $$
  select interval '15 minutes';
$$;

-- ------------------------------------------- the index that would now fight --

/*
  ⚠ This drop is the whole reason this file cannot be a one-line change.

  `20250101000020_dispatch_repair.sql` added:

      create unique index dispatch_offers_no_repeat_decline
        on public.dispatch_offers (booking_id, driver_id)
        where status = 'declined';

  That index encodes "a driver declines a parcel at most once", which was true
  while a decline was permanent. It is false the moment a decline expires after
  15 minutes: the driver is offered the parcel again, declines again, and the
  second declined row collides with the first.

  The insert that collides is inside `respond_to_offer`, so the *decline* would
  raise — the driver taps Decline, sees an error, and the parcel stays held by
  an offer they have already refused until it times out.

  This is the same shape as the bug that stranded a parcel two migrations ago: a
  partial index and a function guard disagreeing about what a row means, with no
  error anywhere until the exact sequence occurs. Removing the index is not
  cleanup — leaving it in would be the bug.
*/
drop index if exists public.dispatch_offers_no_repeat_decline;

/*
  Still exactly one outstanding offer per parcel. Untouched, and still the thing
  that stops two drivers being told the same parcel is theirs.
*/
create unique index if not exists dispatch_offers_one_live_per_booking
  on public.dispatch_offers (booking_id)
  where status = 'offered';

-- ------------------------------------------------------------- the matcher --

/**
 * Offers a parcel to the best available journey.
 *
 * Replaces the version in 20250101000021_offer_windows.sql. One change: the two separate
 * exclusions — permanent for a decline, hold-length for a lapse — collapse into
 * a single 15-minute cooldown covering both.
 *
 * The three properties that were asked for, and where each one lives:
 *
 *   1. Cooldown. The `not exists` below, keyed on (booking, driver).
 *   2. Queue continuity. That clause excludes a *driver*, not the parcel. Every
 *      other open journey in the city is still selected from on the very next
 *      call, which `respond_to_offer` makes the instant a decline lands.
 *   3. Other parcels unaffected. The clause is scoped by `o.booking_id =
 *      dispatch_booking.booking_id`. A driver in cooldown on one parcel is
 *      matched for every other parcel exactly as before — nothing in this
 *      function has a per-driver state.
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

  -- Settle anything already lapsed on this parcel, so the partial unique index
  -- and the guard below cannot disagree. See 20250101000020_dispatch_repair.sql.
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
      j.mode
    )
    /*
      One cooldown, both kinds of no.

      ⚠ The window is measured from when the offer actually ended, which is not
        always `responded_at`.

        For a decline the two are the same — the driver answered, and that is
        the moment. For a lapse `responded_at` is when the *sweeper noticed*,
        which is a minute later when cron is healthy and can be far worse when
        it is not: this project has a row that expired at 11:35 and was not
        settled until 12:49. Measuring from `responded_at` would have held that
        driver out of the queue for 74 minutes past their fifteen, for a parcel
        they were never shown.

        So an expiry counts from `expires_at`, which is when the driver's chance
        genuinely ran out, and the cooldown is 15 minutes from that whenever the
        bookkeeping happens to catch up.
    */
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
    /*
      Anyone who has never seen this parcel comes first.

      With declines no longer permanent this matters more, not less: it is the
      only thing keeping a parcel moving outward through the queue instead of
      cycling between the two drivers who have already refused it.
    */
    (exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id and o.driver_id = j.driver_id
    )) asc,
    j.departs_after asc,
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
      /*
        Whether this driver has had this parcel before. A parcel logging
        repeat = true over and over is the nagging loop described at the top of
        this file, and this is what makes it findable.

        ⚠ Two things this line got wrong the first time, both caught by running
          it rather than reading it:

          1. `o.booking_id = booking_id` is ambiguous. Inside a subquery over
             `dispatch_offers`, a bare `booking_id` could be the plpgsql
             parameter or the table column, and Postgres refuses to guess
             (42702). Every reference to the parameter inside a query has to be
             `dispatch_booking.booking_id`.
          2. The offer row was inserted a few lines above, so an unfiltered
             `exists` matches the offer being logged and `repeat` is true every
             single time — a flag that is always set is not a flag.
      */
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

revoke all on function public.offer_cooldown() from public, anon;
grant execute on function public.offer_cooldown() to authenticated;

-- ------------------------------------------------- move what is waiting now --

/*
  Parcels held out by the old rules are released immediately.

  Without this, a parcel declined this morning stays permanently retired for
  that driver — the new cooldown only ever applies to declines made after this
  file runs, and the one parcel actually stuck is the one from before it.
*/
do $$
declare
  offered integer;
begin
  select public.redispatch_unassigned() into offered;
  raise notice 'Re-offered % parcel(s) under the new cooldown.', offered;
end
$$;

/*
  ⚠ What this does not bound.

    A driver who declines the same parcel every 15 minutes is asked again every
    15 minutes, forever. There is no cap, because none was asked for and adding
    one silently would change the meaning of Decline a second time.

    If it needs one, the shape is a count rather than a longer window:

        and (select count(*) from public.dispatch_offers o
              where o.booking_id = dispatch_booking.booking_id
                and o.driver_id = j.driver_id
                and o.status = 'declined') < 3

    Three refusals is a driver saying no clearly. A longer cooldown would only
    space out the nagging; a cap ends it.
*/
