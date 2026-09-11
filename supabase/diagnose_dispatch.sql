-- Package Relay — why is no parcel being offered right now?
--
-- Read-only. Changes nothing. Safe to run on production, any number of times.
--
-- Paste into the Supabase SQL editor and run ONE BLOCK AT A TIME — the editor
-- only shows the result of the last statement, so running the whole file at once
-- hides everything except block D.
--
-- Read them in order. Block B is the one that answers the question.

-- ===========================================================================
-- BLOCK A — the shape of the problem
-- ===========================================================================

with waiting as (
  select b.id, b.status, b.driver_id,
         b.origin_city::text as oc, b.destination_city::text as dc,
         b.weight, b.created_at
  from public.bookings b
  where b.status = 'Booked' and b.driver_id is null
),
open_j as (
  select j.* from public.driver_journeys j where j.status = 'open'
)
select 'parcels waiting for a driver' as check,
       (select count(*) from waiting)::text as value,
       case when (select count(*) from waiting) = 0
            then 'Nothing is waiting. An empty offer card on the driver phone is CORRECT — post a new parcel to see one.'
            else 'Each of these should either have a live offer or a reason in block B.' end as reading
union all
select 'open journeys (any state)',
       (select count(*) from open_j)::text,
       case when (select count(*) from open_j) = 0
            then 'No driver is online and nobody has declared a route, so nothing can be offered to anyone.'
            else 'Includes shifts whose window has already passed — see the next line.' end
union all
select 'open journeys still inside their window',
       (select count(*) from open_j where departs_before > now())::text,
       'A shift stays status=open after departs_before passes. It matches nothing, but it still shows on the driver phone as "listening", which is why a driver can look online and be unreachable.'
union all
select 'live offers right now',
       (select count(*) from public.dispatch_offers
         where status = 'offered' and expires_at > now())::text,
       'This is exactly what the driver app renders. 0 means the offer card is empty for the right reason and the fault is upstream.'
union all
select 'offers that expired unanswered today',
       (select count(*) from public.dispatch_offers
         where status = 'expired' and offered_at > now() - interval '24 hours')::text,
       'Each one is work this driver was given and never saw. A high number here means notification/visibility, not matching.'
union all
select 'offers declined today',
       (select count(*) from public.dispatch_offers
         where status = 'declined' and offered_at > now() - interval '24 hours')::text,
       'A decline is permanent for that driver and parcel. Several declines can exhaust a small city.';

-- ===========================================================================
-- BLOCK B — the verdict, per waiting parcel and open journey
--
-- This is the answer. One row per (parcel, journey) pair, saying exactly which
-- rule is stopping it. If a row says ELIGIBLE and no offer exists, the matcher
-- is not being called — go to block C.
-- ===========================================================================

with waiting as (
  select b.id, b.status,
         b.origin_city::text as oc, b.destination_city::text as dc,
         b.weight, b.created_at
  from public.bookings b
  where b.status = 'Booked' and b.driver_id is null
),
open_j as (
  select j.* from public.driver_journeys j where j.status = 'open'
)
select
  left(w.id::text, 8) as parcel,
  w.oc || ' → ' || w.dc as parcel_route,
  coalesce(w.weight, 0)::text || ' kg' as parcel_weight,
  left(j.id::text, 8) as journey,
  j.mode,
  j.origin_city::text || ' → ' || j.destination_city::text as journey_route,
  case
    when j.departs_before <= now()
      then 'BLOCKED — the journey window closed ' ||
           to_char(now() - j.departs_before, 'HH24:MI') || ' ago'
    when j.capacity_kg < coalesce(w.weight, 0)
      then 'BLOCKED — parcel is ' || w.weight::text || 'kg, journey carries ' || j.capacity_kg::text
    when j.mode = 'flash' and w.oc <> w.dc
      then 'BLOCKED — parcel is interstate; a flash shift only takes parcels that stay in one city'
    when j.mode = 'flash' and w.oc <> j.origin_city::text
      then 'BLOCKED — parcel is in ' || w.oc || ', the flash shift is in ' || j.origin_city::text
    when j.mode <> 'flash'
      and (j.origin_city::text <> w.oc or j.destination_city::text <> w.dc)
      then 'BLOCKED — scheduled journeys must match both ends of the route'
    when exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = w.id and o.driver_id = j.driver_id and o.status = 'declined'
    )
      then 'BLOCKED — this driver declined this parcel, which is permanent'
    when exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = w.id and o.driver_id = j.driver_id
        and o.status = 'expired'
        and o.responded_at > now() - public.offer_hold(w.oc = w.dc)
    )
      then 'COOLING OFF — missed an offer less than ' ||
           extract(epoch from public.offer_hold(w.oc = w.dc))::int / 60 ||
           ' minutes ago; it will come back round'
    else 'ELIGIBLE — this pair should have an offer'
  end as verdict,
  -- What the matcher itself says, for comparison. If this disagrees with the
  -- verdict above, the matcher is the problem — see 20250101000022_matcher_volatility.sql.
  public.journey_matches(
    j.origin_city::text, j.destination_city::text, j.departs_after, j.departs_before,
    j.capacity_kg, w.oc, w.dc, w.weight, j.mode
  ) as matcher_says
from waiting w
cross join open_j j
order by w.created_at, j.created_at;

-- ===========================================================================
-- BLOCK C — is anything actually running the matcher?
--
-- Errors with "schema cron does not exist" if pg_cron was never enabled. That
-- itself is the answer: nothing re-offers a parcel while the app is idle.
-- ===========================================================================

select jobname,
       schedule,
       active,
       (select max(start_time) from cron.job_run_details d where d.jobid = j.jobid) as last_run,
       (select status from cron.job_run_details d where d.jobid = j.jobid
         order by start_time desc limit 1) as last_status
from cron.job j
where jobname like 'pkrelay-%'
order by jobname;

-- ===========================================================================
-- BLOCK D — which migrations actually reached this database
--
-- Every 'missing' here is a fix that was written and never applied. Several of
-- the behaviours the app promises live in these.
-- ===========================================================================

select '15_dispatch — dispatch_booking' as migration,
       case when to_regprocedure('public.dispatch_booking(uuid)') is null
            then 'MISSING' else 'present' end as state
union all
select '18_flash_mode — journey_matches',
       case when to_regprocedure(
              'public.journey_matches(text,text,timestamptz,timestamptz,numeric,text,text,numeric,text)'
            ) is null then 'MISSING' else 'present' end
union all
select '19_push — sweep when a driver comes online',
       case when to_regprocedure('public.sweep_for_journey()') is null
            then 'MISSING — going online will not pick up parcels already waiting'
            else 'present' end
union all
select '20_dispatch_repair — the stranding fix',
       case when to_regprocedure('public.redispatch_unassigned(integer)') is null
            then 'MISSING — a lapsed offer can still brick a parcel permanently'
            else 'present' end
union all
select '20_dispatch_repair — blanket per-driver index dropped',
       case when to_regclass('public.dispatch_offers_once_per_driver') is null
            then 'dropped (correct)'
            else 'STILL PRESENT — one missed offer retires the parcel forever' end
union all
select '21_offer_windows — 5/10 minute holds',
       case when to_regprocedure('public.offer_hold(boolean)') is null
            then 'MISSING — every offer is on the old flat window'
            else 'present' end
union all
select '22_matcher_volatility — journey_matches is STABLE not IMMUTABLE',
       coalesce(
         (select case when p.provolatile = 's' then 'present'
                      else 'MISSING — the matcher is labelled IMMUTABLE and calls now(), so a pooled connection may match against a cached clock' end
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'journey_matches'
           limit 1),
         'MISSING — journey_matches does not exist'
       );
