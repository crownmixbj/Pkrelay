-- ============================================================================
-- 20250101000070_driver_availability.sql — who is on shift with nothing to carry
-- ============================================================================
--
-- Run after 01–69. Re-runnable.
--
-- The Dispatch screen has always asked one direction of the matching question:
-- here is a parcel, who could take it (`unassigned_parcels` → `assignable_
-- drivers` → `admin_assign_parcel`). This adds the other direction — here is a
-- driver sitting on an open shift with nothing in their hands, and here is what
-- they could be given.
--
-- ⚠ Both directions matter and they are not the same list.
--
--   Parcel-first answers "why has this not moved". Driver-first answers "why is
--   this person idle", which is the question behind every message a driver sends
--   asking whether the app is working. A platform that can only answer the first
--   finds out about the second from the driver.
--
-- ⚠ "Still on shift" is the matcher's expression, not a second opinion.
--
--   `journey_matches` (26) gates on `coalesce(journey_departure,
--   journey_departs_before) > now()`. This file uses that same expression,
--   deliberately character-for-character, because the one thing worse than no
--   availability screen is one that lists a driver the matcher has already
--   written off — an operator would reasonably conclude dispatch was broken and
--   start assigning by hand around it.
--
-- ⚠ Approved is not enough, so this repeats `is_approved_driver`'s three
--   conditions.
--
--   That function (09) reads `auth.uid()` and therefore can only answer about
--   the caller; it cannot be asked about somebody else. So the join to
--   `profiles` and the two null checks — `driving_banned_at`, `deleted_at` — are
--   written out here. A banned driver with a journey still open is exactly the
--   row that must not appear on a screen whose next button assigns them a
--   parcel. `assignable_drivers` (32) checks neither, which is a gap in that
--   function rather than a precedent to copy.
--
-- ⚠ What this file does NOT do: it writes nothing. Assignment stays in
--   `admin_assign_parcel`, repaired in 69 — one audited write path, called from
--   both directions, rather than a second one that would drift from it.

do $$
begin
  if to_regclass('public.driver_journeys') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;

  if to_regprocedure(
       'public.journey_matches(text,text,timestamptz,timestamptz,numeric,text,text,numeric,text,timestamptz)'
     ) is null then
    raise exception 'Run 20250101000026_departure_time.sql first.';
  end if;

  if to_regprocedure('public.documents_permit_dispatch(uuid)') is null then
    raise exception 'Run 20250101000031_document_expiry.sql first.';
  end if;
end
$$;

-- -------------------------------------------------------------- the shifts --

/**
 * Drivers on an open shift, with nothing in their hands.
 *
 * The five conditions, and why each one is here:
 *
 *   approved, unbanned, not erased   they can legally carry a parcel
 *   documents permit dispatch        a blocking document has not expired
 *   an open journey, window live     they have said they are working, now
 *   no offer outstanding             they are not already deciding on one
 *   nothing undelivered in hand      they are free rather than merely online
 *
 * ⚠ The last two are what makes this a work queue rather than a roster.
 *
 *   A driver halfway through a delivery is online and is not waiting for
 *   anything; a driver with a live offer is about to have an answer. Listing
 *   either as "waiting" means an operator assigns a second parcel to somebody
 *   who is already busy, which is how a driver ends up holding two parcels
 *   going opposite ways.
 *
 * ⚠ `phone` is returned, and that is this screen's one deliberate exception to
 *   the rule the admin functions otherwise keep.
 *
 *   17 keeps customer contact details behind an audited reveal, and this file
 *   does not weaken that — a *driver's* number is already returned by
 *   `assignable_drivers` (32) for the same audience doing the same job. The
 *   reason it earns its place is that the action after "this driver has been
 *   waiting two hours and there are four parcels for their route" is to ring
 *   them, and a screen that makes somebody look that up elsewhere is a screen
 *   they stop using.
 */
create or replace function public.admin_waiting_drivers(max_rows integer default 50)
returns table (
  driver_id uuid,
  full_name text,
  phone text,
  vehicle_type text,
  base_city text,
  journey_id uuid,
  mode text,
  origin_city text,
  destination_city text,
  departs_after timestamptz,
  departs_before timestamptz,
  departure_time timestamptz,
  capacity_kg numeric,
  /** Since they declared the shift — how long they have been sitting there. */
  waiting_minutes integer,
  /** Until the shift lapses. Negative never appears; those rows are excluded. */
  leaves_in_minutes integer,
  /** Unassigned parcels this shift would match. The number that makes a row actionable. */
  matching_parcels integer,
  /** Offers they declined or let expire in the last 24h. */
  offers_passed integer,
  /** True while the matcher will skip them after a decline. See `offer_cooldown`. */
  in_cooldown boolean,
  /** Parcels they have delivered today, so a quiet driver is distinguishable. */
  delivered_today integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    j.driver_id,
    coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(a.full_name), ''), 'Unnamed driver')::text,
    /*
      The application's number first, because the signup guard normalises that
      one to +234 form while `profiles.phone` keeps whatever was typed. An
      operator is about to dial it.
    */
    coalesce(nullif(a.phone, ''), nullif(p.phone, ''), '')::text,
    a.vehicle_type::text,
    coalesce(a.base_city, a.state, '')::text,
    j.id,
    j.mode::text,
    j.origin_city::text,
    j.destination_city::text,
    j.departs_after,
    j.departs_before,
    j.departure_time,
    j.capacity_kg,
    (extract(epoch from (now() - j.created_at)) / 60)::integer,
    (extract(epoch from (coalesce(j.departure_time, j.departs_before) - now())) / 60)::integer,
    /*
      What this shift could take, counted through the matcher itself.

      Not "parcels from this city": a flash shift takes only parcels that start
      and end in its city, a scheduled one needs both ends of the route, and
      both are weight-capped. Reimplementing any of that here would give an
      operator a number the automation disagrees with.
    */
    (
      select count(*)::integer
      from public.bookings b
      where b.status = 'Booked'
        and b.driver_id is null
        and public.journey_matches(
          j.origin_city, j.destination_city, j.departs_after, j.departs_before,
          j.capacity_kg, b.origin_city, b.destination_city, b.weight,
          j.mode, j.departure_time
        )
    ),
    (
      select count(*)::integer
      from public.dispatch_offers o
      where o.driver_id = j.driver_id
        and o.status in ('declined', 'expired')
        and o.offered_at > now() - interval '24 hours'
    ),
    exists (
      select 1
      from public.dispatch_offers o
      where o.driver_id = j.driver_id
        and o.status = 'declined'
        and o.responded_at > now() - public.offer_cooldown()
    ),
    (
      select count(*)::integer
      from public.bookings b
      where b.driver_id = j.driver_id
        and b.status = 'Delivered'
        and b.delivered_at > date_trunc('day', now())
    )
  from public.driver_journeys j
  join public.driver_applications a on a.user_id = j.driver_id
  join public.profiles p on p.id = j.driver_id
  where public.is_admin()
    and j.status = 'open'
    /* The matcher's own liveness test. See the header. */
    and coalesce(j.departure_time, j.departs_before) > now()
    and a.status = 'approved'
    and p.driving_banned_at is null
    and p.deleted_at is null
    and public.documents_permit_dispatch(j.driver_id)
    and not exists (
      select 1 from public.dispatch_offers o
      where o.driver_id = j.driver_id
        and o.status = 'offered'
        and o.expires_at > now()
    )
    and not exists (
      select 1 from public.bookings b
      where b.driver_id = j.driver_id
        and b.status not in ('Delivered', 'Cancelled')
    )
  /*
    Longest wait first, and a driver with parcels available to them above one
    with none.

    The row at the top should be the most wasteful thing on the platform right
    now: somebody who has been sitting there for hours while parcels they could
    carry sit unassigned.
  */
  order by
    (
      select count(*)
      from public.bookings b
      where b.status = 'Booked' and b.driver_id is null
        and public.journey_matches(
          j.origin_city, j.destination_city, j.departs_after, j.departs_before,
          j.capacity_kg, b.origin_city, b.destination_city, b.weight,
          j.mode, j.departure_time
        )
    ) desc,
    j.created_at asc
  limit greatest(1, least(coalesce(max_rows, 50), 200));
$$;

revoke all on function public.admin_waiting_drivers(integer) from public, anon;
grant execute on function public.admin_waiting_drivers(integer) to authenticated;

-- ------------------------------------------------------- what they can take --

/**
 * Unassigned parcels, from one driver's point of view.
 *
 * The mirror of `assignable_drivers` (32), and it keeps that function's most
 * important decision: parcels the matcher would NOT give this driver are in the
 * list too, marked. An operator is on this screen because they know something
 * the automation does not — the driver standing in the hub who has not updated
 * their route — and a list that hid everything off-route would be a slower copy
 * of the matcher.
 *
 * ⚠ Ordered matches first, then oldest. The first row is the one that needs no
 *   judgement; everything below it is an override the operator is making
 *   knowingly.
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
  /** Whether this driver's open shift would have been offered this parcel. */
  route_matches boolean,
  /** Plain English, for the row that is not a match. */
  note text
)
language sql
stable
security definer
set search_path = ''
as $$
  with shift as (
    /*
      Their live shift, if they have one — the newest, so an edited journey
      reads as one shift rather than two.
    */
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
      (select count(*)::integer from public.dispatch_offers o where o.booking_id = b.id)
        as offers_made,
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
    where public.is_admin()
      and b.status = 'Booked'
      and b.driver_id is null
  )
  select
    r.id, r.tracking_id, r.origin_city, r.destination_city, r.weight,
    r.delivery_type, r.estimated_fee, r.waiting_minutes, r.offers_made,
    r.route_matches,
    /*
      The reason, most specific first.

      Weight before route: a 40kg parcel offered to a driver with 20kg left is
      refused for a reason the operator cannot override by knowing something, and
      saying "not going this way" about it would send them looking at the map.
    */
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

-- --------------------------------------------------------------- the tiles --

/**
 * The counts above the list.
 *
 * ⚠ Every number here is about a driver the list does NOT show, except the
 *   first.
 *
 *   `waiting` is the list. `with_offer`, `carrying`, `off_shift` and `blocked`
 *   are the four reasons a driver is absent from it — which is the question an
 *   operator asks the moment the list is shorter than they expected ("where is
 *   everybody?"). Without them, an empty list is indistinguishable from a
 *   broken query, and that ambiguity is what made the dispatch health panel
 *   necessary in the first place.
 */
create or replace function public.admin_driver_availability()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  with approved as (
    select
      a.user_id,
      public.documents_permit_dispatch(a.user_id) as documents_ok,
      exists (
        select 1 from public.driver_journeys j
        where j.driver_id = a.user_id
          and j.status = 'open'
          and coalesce(j.departure_time, j.departs_before) > now()
      ) as on_shift,
      exists (
        select 1 from public.dispatch_offers o
        where o.driver_id = a.user_id
          and o.status = 'offered'
          and o.expires_at > now()
      ) as has_offer,
      exists (
        select 1 from public.bookings b
        where b.driver_id = a.user_id
          and b.status not in ('Delivered', 'Cancelled')
      ) as carrying
    from public.driver_applications a
    join public.profiles p on p.id = a.user_id
    where a.status = 'approved'
      and p.driving_banned_at is null
      and p.deleted_at is null
  )
  select jsonb_build_object(
    'approved', count(*),
    'waiting', count(*) filter (
      where on_shift and documents_ok and not has_offer and not carrying
    ),
    'with_offer', count(*) filter (where on_shift and has_offer),
    'carrying', count(*) filter (where carrying),
    /* Approved, allowed, and has not said they are working. */
    'off_shift', count(*) filter (where not on_shift and not carrying),
    /* On shift and refused by the document gate — the one an operator must fix. */
    'blocked', count(*) filter (where on_shift and not documents_ok),
    'unassigned_parcels', (
      select count(*) from public.bookings
      where status = 'Booked' and driver_id is null
    )
  )
  into result
  from approved;

  return coalesce(result, '{}'::jsonb);
end;
$$;

revoke all on function public.admin_driver_availability() from public, anon;
grant execute on function public.admin_driver_availability() to authenticated;
