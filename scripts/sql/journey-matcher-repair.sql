-- ============================================================================
-- journey-matcher-repair.sql — a driver cannot declare a route
-- ============================================================================
--
-- Paste into the SQL editor of the project that is refusing journeys. Safe to
-- run twice. It changes no rows and deletes no data.
--
-- ⚠ Both statements are migration 26's. This is not a patch: it finishes a
--   migration that was applied halfway.
--
-- WHAT IS WRONG
--
--   "Could not save that journey" on every attempt, for an approved driver with
--   a working connection. The approval is not the problem and neither is the
--   network — the insert is being aborted by a trigger.
--
--   `driver_journeys` has an insert trigger, `driver_journeys_sweep`, which runs
--   `sweep_for_journey` to offer the new route any parcel already waiting. On
--   this database that function still calls `journey_matches` with NINE
--   arguments — migration 22's shape. Migration 26 replaced the function with a
--   TEN-argument version and rewrote this caller to match, but here only the
--   first half happened: the new function was created, the old overload was
--   never dropped, and the trigger was never updated.
--
--   So three overloads now exist (8, 9 and 10 arguments), the trailing
--   parameters have defaults, and a nine-argument call fits two of them:
--
--       ERROR: function public.journey_matches(...) is not unique
--
--   The trigger raises, the insert rolls back, and the client reports it as a
--   connection problem. Migration 26's own header warns about exactly this:
--   "the old signature has to go, not be overloaded".
--
--   The last journey saved on this database was 18 August 2026. Every attempt
--   since has failed this way.

-- ------------------------------------------------- 1. one function, not three --

/*
  ⚠ Dropped, not replaced. `create or replace` cannot change a signature, which
    is how three overloads accumulated in the first place: 18 and 22 each added
    a parameter and left the previous function standing.

    Every caller in the schema — `dispatch_booking`, `redispatch_unassigned`,
    the offer sweeper — passes ten arguments, so removing the short ones takes
    nothing away. It also stops this returning: with one function there is
    nothing left for a call to be ambiguous against.
*/
drop function if exists public.journey_matches(
  text, text, timestamptz, timestamptz, numeric, text, text, numeric
);

drop function if exists public.journey_matches(
  text, text, timestamptz, timestamptz, numeric, text, text, numeric, text
);

-- ---------------------------------------- 2. the trigger calls the right one --

/*
  Migration 26's version, verbatim. The only difference from what is on this
  database is the last line of the call: `new.mode, new.departure_time` rather
  than `new.mode` alone.
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

-- --------------------------------------------------------------- 3. the check --

/*
  Every column must be true. `overloads` is the one that matters: while it is
  more than 1, a nine-argument call somewhere else in the schema can raise the
  same error with a different symptom.
*/
with probe as (
  select
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'journey_matches')              as overloads,
    (select pg_get_functiondef(p.oid) ~ 'new\.mode, new\.departure_time'
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'sweep_for_journey')            as trigger_passes_ten,
    exists (select 1 from pg_trigger
             where tgrelid = 'public.driver_journeys'::regclass
               and tgname = 'driver_journeys_sweep' and not tgisinternal)        as trigger_present,
    to_regprocedure('public.dispatch_booking(uuid)') is not null                 as dispatch_booking
)
select *,
  case
    when overloads = 0          then 'journey_matches is gone entirely — do not leave it like this.'
    when overloads > 1          then 'More than one journey_matches remains; a nine-argument call is still ambiguous.'
    when not trigger_passes_ten then 'sweep_for_journey still calls it with nine arguments.'
    when not trigger_present    then 'The driver_journeys_sweep trigger is missing — new routes will not pick up waiting parcels.'
    when not dispatch_booking   then 'dispatch_booking is missing — the trigger will raise for a different reason.'
    else 'Clear — an approved driver can declare a route again.'
  end as next_step
from probe;
