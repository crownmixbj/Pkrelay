-- LOCI — a journey has a departure, not a window.
--
-- Run after 01–25. Re-runnable.
--
-- A driver used to say "leaving within 4 hours" and the form turned that into a
-- window: `departs_after = now()`, `departs_before = now() + 4h`. They now pick
-- an exact moment, and this stores it.
--
--   departure_time   the moment this driver leaves. Scheduled routes only.
--
-- ⚠ TWO COLUMNS FOR ONE FACT IS HOW THEY DRIFT.
--
--   `departs_before` already means "stop offering me parcels after this", which
--   for a scheduled route is exactly the departure. Adding `departure_time`
--   beside it creates two places to write the same thing, and the next person to
--   update one and not the other gets a route that stops listening at a time the
--   driver never chose.
--
--   So a trigger derives `departs_before` from `departure_time` on every insert
--   and update. `departure_time` is the input; `departs_before` is a cache of it
--   that the database maintains. They cannot disagree.
--
-- ⚠ FLASH SHIFTS HAVE NO DEPARTURE, AND THIS DOES NOT GIVE THEM ONE.
--
--   A flash shift is "I am in Ibadan and free until 16:33". There is no journey
--   and nothing departs. `departure_time` stays null on those rows and their
--   `departs_before` keeps meaning what it always meant — when the shift ends.
--   Forcing one column to mean "departure" on one kind of row and "end of
--   availability" on another would be the same drift in a different disguise.

do $$
begin
  if to_regclass('public.driver_journeys') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------ the column ---

alter table public.driver_journeys
  add column if not exists departure_time timestamptz;

comment on column public.driver_journeys.departure_time is
  'Exact departure for a scheduled route. Null for flash shifts, which end rather than depart. Mirrored into departs_before by journey_departure_sync.';

/*
  `departs_after` becomes "when this route started listening".

  It was the earliest possible departure under the window model. With an exact
  departure that concept is gone, and what the column is actually good for is
  ordering and the `journey_window_ordered` constraint. Defaulting it means the
  client stops sending a value it no longer has an opinion about.
*/
alter table public.driver_journeys
  alter column departs_after set default now();

-- --------------------------------------------------------- the backfill ---

/*
  Existing scheduled routes take their departure from `departs_before`.

  The true departure of a route declared as "within 4 hours" is unknowable —
  somewhere inside the window. `departs_before` is the outer bound, so using it
  can only ever *lengthen* how long a route keeps listening, never shorten it.

  A driver whose live route suddenly stopped matching because a migration
  guessed earlier than they meant would lose work and have no way to see why.
  The same reasoning as the in-flight offer fix in 20250101000021_offer_windows.sql: when
  the honest answer is unknown, err on the side that does not take anything
  away.
*/
update public.driver_journeys
   set departure_time = departs_before
 where departure_time is null
   and mode = 'scheduled';

-- ----------------------------------------------- one fact, one place ------

/**
 * Keeps `departs_before` equal to `departure_time` on scheduled routes.
 *
 * The trigger, rather than a generated column: a generated column would have to
 * produce `departs_before` for flash shifts too, and those have no
 * `departure_time` to generate it from.
 *
 * ⚠ `journey_window_ordered` (`departs_before > departs_after`) is doing real
 *   work after this. With `departs_after` defaulting to `now()`, it becomes the
 *   database's own guarantee that a departure is in the future — a route cannot
 *   be declared for a time that has already passed, whatever the client sends.
 */
create or replace function public.journey_departure_sync()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.departure_time is not null then
    new.departs_before := new.departure_time;
  end if;

  return new;
end;
$$;

drop trigger if exists driver_journeys_departure_sync on public.driver_journeys;
create trigger driver_journeys_departure_sync
  before insert or update on public.driver_journeys
  for each row execute function public.journey_departure_sync();

-- ------------------------------------------------------------ the matcher --

/*
  ⚠ The old signature has to go, not be overloaded.

    Adding a tenth parameter with a default would leave both functions callable
    with nine arguments, and Postgres refuses an ambiguous call:

        ERROR: function public.journey_matches(...) is not unique

    Every caller is rebuilt below in the same migration, so nothing is left
    pointing at the dropped version.
*/
drop function if exists public.journey_matches(
  text, text, timestamptz, timestamptz, numeric, text, text, numeric, text
);

/**
 * Whether a journey can carry a parcel.
 *
 * Same rules as 20250101000022_matcher_volatility.sql, with the liveness test moved onto
 * the precise departure:
 *
 *   scheduled  listens until `journey_departure`, the moment the driver leaves
 *   flash      listens until `journey_departs_before`, the end of the shift
 *
 * `coalesce` is what lets one function serve both without asking which it is
 * looking at. On a scheduled row the two are equal anyway — the trigger above
 * guarantees it — so the coalesce is about intent rather than arithmetic: this
 * function is now explicitly about a departure.
 *
 * STABLE, not IMMUTABLE. It reads `now()`; see 22 for what mislabelling it
 * allows the planner to do.
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
  journey_mode text default 'scheduled',
  journey_departure timestamptz default null
)
returns boolean language sql stable set search_path = '' as $$
  select
    journey_capacity >= coalesce(parcel_weight, 0)
    and coalesce(journey_departure, journey_departs_before) > now()
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

      -- Scheduled: a named route, both ends.
      else
        journey_origin = parcel_origin
        and journey_destination = parcel_destination
    end;
$$;

-- ---------------------------------------------------- the callers, rebuilt --

/**
 * Offers a parcel to the best available journey.
 *
 * Replaces the version in 20250101000023_offer_cooldown.sql. Two changes:
 *
 *   1. `j.departure_time` is passed to the matcher.
 *   2. Ties break on the *soonest departure* rather than on `departs_after`.
 *      Under the window model `departs_after` was the earliest a driver might
 *      leave, which was the closest thing available to urgency. Now that the
 *      real departure is known, a driver leaving in twenty minutes should be
 *      offered the parcel ahead of one leaving tomorrow — they are the one who
 *      can actually take it today.
 *
 * Everything else — the 15-minute cooldown, untried drivers first, the insert
 * that cannot raise, the lazy expiry — is unchanged from 20250101000023_offer_cooldown.sql.
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
      j.mode, j.departure_time
    )
    /*
      One cooldown, both kinds of no. See 20250101000023_offer_cooldown.sql for why an
      expiry counts from `expires_at` and a decline from `responded_at`.
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
    -- Anyone who has never seen this parcel comes first.
    (exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id and o.driver_id = j.driver_id
    )) asc,
    -- Then whoever is leaving soonest.
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

/**
 * Sweeps the waiting parcels when a driver declares a route or goes online.
 *
 * Replaces the version in 20250101000019_push.sql. The only change is passing
 * `new.departure_time` — but it has to be rebuilt regardless, because the
 * signature it called was dropped above.
 */
create or replace function public.sweep_for_journey()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'open' then
    return new;
  end if;

  perform public.dispatch_booking(b.id)
  from public.bookings b
  where b.status = 'Booked'
    and b.driver_id is null
    and public.journey_matches(
      new.origin_city, new.destination_city, new.departs_after, new.departs_before,
      new.capacity_kg, b.origin_city::text, b.destination_city::text, b.weight,
      new.mode, new.departure_time
    );

  return new;
end;
$$;

drop trigger if exists driver_journeys_sweep on public.driver_journeys;
create trigger driver_journeys_sweep
  after insert on public.driver_journeys
  for each row execute function public.sweep_for_journey();

/*
  ⚠ Deliberately insert-only, unchanged from 20250101000019_push.sql.

    Firing on update too would let a driver pause and resume to re-sweep,
    jumping the queue at will.

  ⚠ And one consequence of the trigger ordering worth knowing.

    `driver_journeys_departure_sync` is BEFORE INSERT and
    `driver_journeys_sweep` is AFTER INSERT, so the sweep always sees a row
    whose `departs_before` has already been squared with `departure_time`.
    Reversing that order would sweep against the client's value rather than the
    database's.
*/

-- --------------------------------------------------------------- ordering --

/*
  The open-journey index carried `departs_after`, which is no longer what the
  matcher orders by.
*/
drop index if exists public.driver_journeys_open_idx;
create index if not exists driver_journeys_open_idx
  on public.driver_journeys (origin_city, destination_city, departure_time)
  where status = 'open';

/*
  ⚠ What an exact departure makes newly possible, and nothing here prevents.

    A driver can now declare a route two weeks out and it will listen for two
    weeks, collecting offers for parcels whose senders expect them to move
    today. The old form could not express that — it asked for hours.

    The client bounds it (`MAX_DEPARTURE_DAYS` in `src/store/dispatch.ts`), but
    a client bound is a courtesy, not a rule. If it matters, the rule belongs
    here as a check constraint on `departure_time`. It is not added yet because
    the right number is a product decision rather than a technical one.
*/
