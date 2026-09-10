-- LOCI — Flash: local parcels, offered on the spot.
--
-- Run after 01–17. Re-runnable.
--
-- ⚠ This closes a gap the dispatch design had from the start, and it is worth
--   naming plainly: **no local parcel has ever been dispatchable.**
--
--   `driver_journeys` carries `journey_route_distinct`, which forbids
--   `origin_city = destination_city`. `journey_matches` requires the journey's
--   origin and destination to equal the parcel's. A local parcel has the same
--   city at both ends, so no journey could ever match one — every local parcel
--   posted since dispatch shipped has gone straight past the matcher onto the
--   open board, silently.
--
--   That is not a bug in the code; it is what the code says. But it means half
--   the business has been running on the manual board while the other half was
--   automated, and nothing on any screen said so.
--
-- Two modes now:
--
--   scheduled  "I am driving Ibadan → Lagos this afternoon." Planned ahead,
--              a route, a departure window. Interstate.
--   flash      "I am in Ibadan and free for the next two hours." No
--              destination, because a local job's destination is wherever the
--              parcel is going. Intrastate.

do $$
begin
  if to_regclass('public.driver_journeys') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;
end
$$;

-- ---------------------------------------------------------------- the mode --

alter table public.driver_journeys
  add column if not exists mode text not null default 'scheduled'
    check (mode in ('scheduled', 'flash'));

/*
  The route constraint, relaxed for flash only.

  A flash shift is a driver sitting in one city, so `origin_city =
  destination_city` is not a mistake there — it is the whole shape of it. A
  scheduled journey with the same city at both ends still is a mistake, and stays
  refused.
*/
alter table public.driver_journeys drop constraint if exists journey_route_distinct;
alter table public.driver_journeys add constraint journey_route_distinct check (
  mode = 'flash' or origin_city <> destination_city
);

create index if not exists driver_journeys_flash_idx
  on public.driver_journeys (origin_city, departs_before)
  where status = 'open' and mode = 'flash';

comment on column public.driver_journeys.mode is
  'scheduled = a planned interstate route. flash = an ad-hoc shift inside one '
  'city, taking local parcels only. See 20250101000018_flash_mode.sql.';

-- ------------------------------------------------------------- the matching --

/**
 * Whether a journey can carry a parcel, now aware of both modes.
 *
 * Replaces the version in 20250101000015_dispatch.sql. The scheduled branch is unchanged;
 * the flash branch is new.
 */
create or replace function public.journey_matches(
  journey_origin text,
  journey_destination text,
  journey_departs_after timestamptz,
  journey_departs_before timestamptz,
  journey_capacity numeric,
  parcel_origin text,
  parcel_destination text,
  parcel_weight numeric,
  journey_mode text default 'scheduled'
)
returns boolean language sql immutable set search_path = '' as $$
  select
    journey_capacity >= coalesce(parcel_weight, 0)
    and journey_departs_before > now()
    and case journey_mode
      /*
        Flash: the driver is *in* a city and the parcel stays in it.

        Both ends of the parcel must be that city. A flash driver has not said
        they are travelling anywhere — offering them an interstate parcel
        because its origin happens to match would be offering a trip to Lagos to
        somebody who said they had two free hours in Ibadan.
      */
      when 'flash' then
        parcel_origin = parcel_destination
        and parcel_origin = journey_origin

      -- Scheduled: unchanged. A named route, both ends.
      else
        journey_origin = parcel_origin
        and journey_destination = parcel_destination
    end;
$$;

/**
 * Offers a parcel to the best available journey.
 *
 * Replaces the version in 20250101000015_dispatch.sql. The only changes are that the match
 * now passes the journey's mode, and that the ranking prefers a flash driver
 * for a local parcel.
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
    and not exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id and o.driver_id = j.driver_id
    )
  /*
    Earliest departure, then the tightest fit that still works, then the oldest
    declaration.

    For a flash shift `departs_after` is when the driver came online, so
    "earliest first" reads as "whoever has been waiting longest gets the next
    job" — which is the fairness rule a driver sitting in a car park expects,
    and the same one the scheduled branch already had.
  */
  order by j.departs_after asc, (j.capacity_kg - coalesce(parcel.weight, 0)) asc, j.created_at asc
  limit 1;

  if chosen.id is null then
    return null;
  end if;

  insert into public.dispatch_offers (booking_id, journey_id, driver_id)
  values (booking_id, chosen.id, chosen.driver_id)
  returning id into offer_id;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'dispatch', 'parcel offered to a driver',
    jsonb_build_object('booking', booking_id, 'journey', chosen.id),
    null
  );

  return offer_id;
end;
$$;

/**
 * Goes online for local work.
 *
 * A thin wrapper over the same table, because a flash shift *is* a journey with
 * a different shape — one city, a short window, no destination worth naming.
 * Giving it its own table would mean two things to match against, two things to
 * expire, and two places for the rules to drift apart.
 */
create or replace function public.start_flash_shift(
  city text,
  hours numeric default 2,
  capacity numeric default 20
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  vehicle text;
  shift_id uuid;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if not public.is_approved_driver() then
    raise exception 'Your driver approval is not active';
  end if;

  select a.vehicle_type into vehicle
  from public.driver_applications a
  where a.user_id = actor and a.status = 'approved'
  order by a.submitted_at desc
  limit 1;

  /*
    One flash shift at a time.

    Two open shifts in the same city would double a driver's chances of being
    offered the same parcel and halve everyone else's, for no reason a driver
    could explain.
  */
  update public.driver_journeys
     set status = 'completed'
   where driver_id = actor and mode = 'flash' and status = 'open';

  insert into public.driver_journeys (
    driver_id, origin_city, destination_city,
    departs_after, departs_before, capacity_kg, vehicle_type, mode
  )
  values (
    actor, city, city,
    now(),
    now() + (greatest(0.25, least(coalesce(hours, 2), 12)) * interval '1 hour'),
    greatest(1, coalesce(capacity, 20)),
    coalesce(vehicle, 'Motorcycle'),
    'flash'
  )
  returning id into shift_id;

  /*
    Sweep the unclaimed board on the way in.

    A driver coming online in Ibadan should be offered the local parcel that has
    been sitting there since this morning — not only the next one posted. This
    is the re-dispatch-on-declaration gap noted in 20250101000015_dispatch.sql, closed for
    flash because it is exactly the case where it hurts: a two-hour shift that
    only sees parcels posted during it is mostly an empty two hours.
  */
  perform public.dispatch_booking(b.id)
  from public.bookings b
  where b.status = 'Booked'
    and b.driver_id is null
    and b.origin_city::text = city
    and b.destination_city::text = city;

  return shift_id;
end;
$$;

/** Ends the shift. Offers already made stand; no new ones arrive. */
create or replace function public.end_flash_shift()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ended integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  with closed as (
    update public.driver_journeys
       set status = 'completed'
     where driver_id = auth.uid() and mode = 'flash' and status = 'open'
    returning 1
  )
  select count(*)::integer into ended from closed;

  return ended;
end;
$$;

revoke all on function public.start_flash_shift(text, numeric, numeric) from public, anon;
revoke all on function public.end_flash_shift() from public, anon;
grant execute on function public.start_flash_shift(text, numeric, numeric) to authenticated;
grant execute on function public.end_flash_shift() to authenticated;

/*
  ⚠ Still outstanding, and more pressing now than before:

    - No push notification, so a flash offer held for five minutes reaches a
      driver only if the app is open. That was already true for scheduled work,
      where a driver plans ahead. A flash shift is somebody sitting with the
      phone in their hand for two hours — the whole mode assumes a notification
      that does not exist yet.
    - A flash shift does not expire itself. `expire_dispatch_offers` sweeps
      offers, not shifts; a driver who closes the app leaves an open shift
      collecting offers until `departs_before` passes. Capped at 12 hours above,
      which bounds the damage without fixing it.
*/
