-- LOCI — journey_matches lies to the planner about depending on the clock.
--
-- Run after 01–21. Re-runnable. Read-only in effect: it redefines one function
-- and changes no data.
--
-- ⚠ THIS IS A BUG FIX, AND THE BUG WAS MINE.
--
-- `20250101000018_flash_mode.sql` declares:
--
--     create or replace function public.journey_matches(...)
--     returns boolean language sql immutable ...
--       select journey_capacity >= coalesce(parcel_weight, 0)
--         and journey_departs_before > now()
--         ...
--
-- IMMUTABLE is a promise to Postgres that the function returns the same answer
-- forever for the same arguments. This one calls `now()`, which is STABLE — its
-- answer changes with every transaction. The promise is false.
--
-- Postgres does not check this. It believes the label and is then entitled to
-- evaluate the call once and reuse the result: constant-folding at plan time,
-- caching in a prepared plan held open by the connection pooler, or reusing a
-- value across a long-running statement. Supabase reuses pooled connections for
-- hours, which is exactly the environment where a cached plan bites.
--
-- The symptom is a matcher that is right most of the time and then quietly
-- stops agreeing with the clock — journeys that have expired still matching, or
-- live ones not. It does not error. Nothing appears in a log.
--
-- STABLE is the correct label: constant within a single statement, re-evaluated
-- for the next one.

do $$
begin
  if to_regclass('public.driver_journeys') is null then
    raise exception 'Run 20250101000015_dispatch.sql and 20250101000018_flash_mode.sql first.';
  end if;
end
$$;

/**
 * Whether a journey can carry a parcel.
 *
 * Identical to 20250101000018_flash_mode.sql in every respect except the volatility label.
 * The body is repeated rather than patched because `create or replace` cannot
 * change volatility without restating the function.
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
returns boolean language sql stable set search_path = '' as $$
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

/*
  ⚠ Why this is not the whole answer to "no offer was created".

  A wrong volatility label is a real defect and worth removing, but it is a
  latent one: it makes the matcher *capable* of disagreeing with the clock, it
  does not prove that it did. Run `diagnose_dispatch.sql` to find out what is
  actually blocking a given parcel — it reports the verdict per parcel and
  journey rather than inferring it.
*/
