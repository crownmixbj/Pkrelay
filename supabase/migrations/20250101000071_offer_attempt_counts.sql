-- ============================================================================
-- 20250101000071_offer_attempt_counts.sql — attempts and drivers are not the
--                                            same number
-- ============================================================================
--
-- Run after 01–70. Re-runnable.
--
-- ⚠ Every screen that mentions dispatch attempts has been saying something
--   false, and it cost a day of looking in the wrong place.
--
--   `unassigned_parcels` (32), `admin_parcels_for_driver` (70) and
--   `admin_parcel_detail` (17) all return `offers_made` as
--
--       select count(*) from dispatch_offers where booking_id = …
--
--   which is the number of offer ROWS. Three different screens render that as
--   "Offered to N drivers already — declined or timed out".
--
--   On production, PKG-483203 read "Offered to 5 drivers already". The truth was
--   seven offers to *one* driver, every one of them a timeout, not a single
--   decline — the matcher re-offering on its 15-minute cooldown, all day, to a
--   driver who was never notified because 50 is not applied there. Five drivers
--   refusing a parcel is a pricing or routing problem. One driver never
--   answering is a notification problem. The sentence pointed at the first and
--   the cause was the second.
--
-- ⚠ One definition, not three.
--
--   The counts live in `offer_attempts()` below and every caller reads them from
--   there. Three hand-written `count(*) filter (…)` blocks is how the next
--   screen ends up disagreeing with the other two about what "tried" means.
--
-- ⚠ `offers_made` keeps its name and its meaning.
--
--   It has always been the number of attempts, and it is still useful. What was
--   wrong is the word "drivers" in front of it on screen. Renaming the column
--   would be a client-breaking change in service of a comment.
--
-- ⚠ `admin_parcel_detail` is NOT recreated here, deliberately.
--
--   It returns thirty columns and was last rewritten by 36. Dropping and
--   recreating it to add three would mean reproducing all thirty verbatim, and
--   recreating something while quietly losing one of its conditions is the
--   failure this codebase has hit most often. The parcel drawer calls
--   `offer_attempts` directly instead; `admin_parcel_detail.offers_made` stays,
--   now unread by that sentence.

do $$
begin
  if to_regclass('public.dispatch_offers') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;

  if to_regprocedure('public.unassigned_parcels(integer)') is null then
    raise exception 'Run 20250101000032_dispatch_mode.sql first.';
  end if;

  if to_regprocedure('public.admin_parcels_for_driver(uuid,integer)') is null then
    raise exception 'Run 20250101000070_driver_availability.sql first.';
  end if;
end
$$;

-- --------------------------------------------------------- the one counter --

/**
 * How dispatch has gone on one parcel.
 *
 * ⚠ `drivers_tried` is the number this file exists for. Everything else on a
 *   stuck parcel reads differently depending on it: seven attempts across seven
 *   drivers is a parcel the market has refused, and seven attempts at one driver
 *   is a parcel one person has not answered.
 *
 * `live` is counted separately rather than folded into the attempts, because a
 * parcel with an offer outstanding right now is not waiting for a decision from
 * the operator — it is waiting for one from a driver, for the next few minutes.
 *
 * Admin-gated: this is read beside names and routes on the dispatch screens, and
 * the tables behind it carry no select policy for anybody else.
 */
create or replace function public.offer_attempts(parcel uuid)
returns table (
  attempts integer,
  drivers_tried integer,
  declined integer,
  expired integer,
  live integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    count(*)::integer,
    count(distinct o.driver_id)::integer,
    count(*) filter (where o.status = 'declined')::integer,
    count(*) filter (where o.status = 'expired')::integer,
    count(*) filter (where o.status = 'offered' and o.expires_at > now())::integer
  from public.dispatch_offers o
  where o.booking_id = parcel
    and public.is_admin();
$$;

revoke all on function public.offer_attempts(uuid) from public, anon;
grant execute on function public.offer_attempts(uuid) to authenticated;

-- ------------------------------------------------------------- the queue ---

/*
 * ⚠ Dropped, not replaced.
 *
 *   `create or replace function` cannot add a column to a `returns table`
 *   signature — Postgres refuses with "cannot change return type of existing
 *   function". The drop is safe: nothing in the database references these two,
 *   and the only callers are the admin screens, which ship with this change.
 */
drop function if exists public.unassigned_parcels(integer);

/**
 * Parcels with no driver, oldest first. 32's function, three columns wider.
 *
 * Everything else is as 32 left it, including the deliberate absence of a
 * dispatch-mode gate: auto-dispatch leaves parcels unassigned routinely, and a
 * queue that blanked itself in auto mode would be blank exactly when the
 * automation was quietly failing.
 */
create or replace function public.unassigned_parcels(limit_rows integer default 100)
returns table (
  id uuid,
  tracking_id text,
  origin_city text,
  destination_city text,
  weight numeric,
  delivery_type text,
  estimated_fee numeric,
  created_at timestamptz,
  waiting_minutes integer,
  /** Attempts, as before: the number of offer rows. */
  offers_made integer,
  /** How many distinct drivers those attempts reached. */
  drivers_tried integer,
  offers_declined integer,
  offers_expired integer,
  offers_live integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.id,
    b.tracking_id,
    b.origin_city,
    b.destination_city,
    b.weight,
    b.delivery_type,
    b.estimated_fee,
    b.created_at,
    (extract(epoch from (now() - b.created_at)) / 60)::integer,
    a.attempts,
    a.drivers_tried,
    a.declined,
    a.expired,
    a.live
  from public.bookings b
  cross join lateral public.offer_attempts(b.id) a
  where public.is_admin()
    and b.status = 'Booked'
    and b.driver_id is null
  order by b.created_at asc
  limit greatest(1, least(coalesce(limit_rows, 100), 500));
$$;

revoke all on function public.unassigned_parcels(integer) from public, anon;
grant execute on function public.unassigned_parcels(integer) to authenticated;

-- --------------------------------------------- the same list, driver-first --

drop function if exists public.admin_parcels_for_driver(uuid, integer);

/**
 * Unassigned parcels from one driver's point of view. 70's function, three
 * columns wider, otherwise unchanged — including the decision that parcels the
 * matcher would refuse this driver stay in the list, marked.
 */
create or replace function public.admin_parcels_for_driver(
  driver uuid,
  max_rows integer default 50
)
returns table (
  id uuid,
  tracking_id text,
  origin_city text,
  destination_city text,
  weight numeric,
  delivery_type text,
  estimated_fee numeric,
  waiting_minutes integer,
  offers_made integer,
  drivers_tried integer,
  offers_declined integer,
  offers_expired integer,
  offers_live integer,
  route_matches boolean,
  note text
)
language sql
stable
security definer
set search_path = ''
as $$
  with shift as (
    select j.*
    from public.driver_journeys j
    where j.driver_id = admin_parcels_for_driver.driver
      and j.status = 'open'
      and coalesce(j.departure_time, j.departs_before) > now()
    order by j.created_at desc
    limit 1
  ),
  rows as (
    select
      b.id,
      b.tracking_id::text,
      b.origin_city::text,
      b.destination_city::text,
      b.weight,
      b.delivery_type::text,
      b.estimated_fee,
      (extract(epoch from (now() - b.created_at)) / 60)::integer as waiting_minutes,
      a.attempts,
      a.drivers_tried,
      a.declined,
      a.expired,
      a.live,
      coalesce(
        (
          select public.journey_matches(
            s.origin_city, s.destination_city, s.departs_after, s.departs_before,
            s.capacity_kg, b.origin_city, b.destination_city, b.weight,
            s.mode, s.departure_time
          )
          from shift s
        ),
        false
      ) as route_matches,
      (select s.capacity_kg from shift s) as capacity_kg,
      (select count(*) from shift) as has_shift
    from public.bookings b
    cross join lateral public.offer_attempts(b.id) a
    where public.is_admin()
      and b.status = 'Booked'
      and b.driver_id is null
  )
  select
    r.id, r.tracking_id, r.origin_city, r.destination_city, r.weight,
    r.delivery_type, r.estimated_fee, r.waiting_minutes,
    r.attempts, r.drivers_tried, r.declined, r.expired, r.live,
    r.route_matches,
    case
      when r.route_matches then 'Matches their shift'
      when r.has_shift = 0 then 'They have no live shift declared'
      when r.capacity_kg is not null and r.weight > r.capacity_kg
        then 'Over the capacity left on their shift'
      else 'Not on their declared route'
    end::text
  from rows r
  order by r.route_matches desc, r.waiting_minutes desc
  limit greatest(1, least(coalesce(max_rows, 50), 200));
$$;

revoke all on function public.admin_parcels_for_driver(uuid, integer) from public, anon;
grant execute on function public.admin_parcels_for_driver(uuid, integer) to authenticated;
