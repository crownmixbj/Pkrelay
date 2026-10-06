-- ============================================================================
-- 20250101000075_departure_priority.sql — the clock decides the order
-- ============================================================================
--
-- Run after 01–74. Re-runnable.
--
-- Two admin lists answer "who should take this parcel", and neither of them
-- knew what time anybody was leaving.
--
--   `admin_waiting_drivers` (70) returns `departs_before` and `departure_time`
--   and then ordered by `created_at` — the moment the shift was *declared*.
--   `assignable_drivers` (32) did not return a departure at all and ordered by
--   `full_name`.
--
-- ⚠ The matcher was already right, which is why this is a read-path change.
--
--   `dispatch_booking` (26, carried through 32) orders its candidates by
--   `coalesce(j.departure_time, j.departs_before) asc` and has since 26 — "a
--   driver leaving in twenty minutes should be offered the parcel ahead of one
--   leaving tomorrow" is that file's own sentence. Nothing in the automatic
--   path needs changing and nothing here changes it. What was wrong is that the
--   two screens an operator uses to assign *by hand* sorted on something else,
--   so a human working the queue undid the automation's priority without being
--   told they were doing it.
--
-- ⚠ Why departure is the second key on the waiting list rather than the first.
--
--   The top row of that list has to be actionable. A driver leaving in ten
--   minutes with nothing on their route is not a decision anybody can make; a
--   driver leaving in ten minutes with a parcel sitting for them is the most
--   perishable thing on the platform. So the first key stays "is there anything
--   this driver could take", reduced from 70's *count* to a boolean — because a
--   count as the leading key is exactly how a driver with nine matching parcels
--   leaving tomorrow outranked one with a single parcel leaving within the
--   hour. Among everybody who can be helped, the clock decides.
--
-- ⚠ `assignable_drivers` gains two columns, so it is dropped and recreated.
--
--   `create or replace` cannot change a function's output columns. 71 did the
--   same thing to `unassigned_parcels` for the same reason. Everything else in
--   that function — the ineligible drivers it deliberately still returns, the
--   notes, the document gate — is carried over verbatim; this file is the
--   current definition of it.

do $$
begin
  if to_regprocedure('public.admin_waiting_drivers(integer)') is null then
    raise exception 'Run 20250101000070_driver_availability.sql first.';
  end if;

  if to_regprocedure('public.assignable_drivers(uuid)') is null then
    raise exception 'Run 20250101000032_dispatch_mode.sql first.';
  end if;
end
$$;

-- ------------------------------------------------- the waiting-driver list --

/**
 * Drivers on an open shift with nothing in their hands — now in departure order.
 *
 * Replaces 70's version. The only change is the `order by`; every column, join
 * and condition is carried over unchanged, because `create or replace` swaps
 * the whole function and anything left out here would be lost.
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
    /* The matcher's own liveness test. See 70's header. */
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
    Anybody who can be helped first, then the one leaving soonest.

    New in 75. 70 ordered by the matching *count* and then by when the shift
    was declared, which put a driver with nine parcels leaving tomorrow above
    one with a single parcel leaving in fifteen minutes. The second of those two
    is the row that stops being actionable if nobody touches it.

    `coalesce(departure_time, departs_before)` is the same expression the
    matcher sorts on and the same one the `where` clause above gates on, so the
    order a human sees matches the order the automation would have chosen.
  */
  order by
    (
      exists (
        select 1
        from public.bookings b
        where b.status = 'Booked' and b.driver_id is null
          and public.journey_matches(
            j.origin_city, j.destination_city, j.departs_after, j.departs_before,
            j.capacity_kg, b.origin_city, b.destination_city, b.weight,
            j.mode, j.departure_time
          )
      )
    ) desc,
    coalesce(j.departure_time, j.departs_before) asc,
    j.created_at asc
  limit greatest(1, least(coalesce(max_rows, 50), 200));
$$;

revoke all on function public.admin_waiting_drivers(integer) from public, anon;
grant execute on function public.admin_waiting_drivers(integer) to authenticated;

-- ------------------------------------------------------ the candidate list --

/**
 * Who could take this parcel, soonest departure first, with the reasons they
 * might not.
 *
 * Replaces 32's version. Two new columns and one new sort key; the rest is 32
 * verbatim, including the decision that matters most in it:
 *
 * ⚠ Returns drivers the matcher would REFUSE as well as the ones it would pick,
 *   each carrying `eligible` and a plain-English `note`.
 *
 *   A manual assignment screen listing only auto-eligible drivers would be a
 *   slower copy of the automation. The entire reason a human is here is that
 *   they know something the matcher does not — the driver whose route is not
 *   declared, the one in cooldown from a decline they made by accident. So the
 *   list shows everyone approved and says what the matcher thinks, and the
 *   operator overrides it knowingly rather than being quietly denied the option.
 *
 *   The one exception is an expired blocking document, which is marked
 *   ineligible *and* refused by `admin_assign_parcel`. That is a legal limit
 *   rather than a matching preference, and an operator should not be able to
 *   click past it by mistake.
 *
 * ⚠ `next_departure` is the soonest *live* departure across their open
 *   journeys, matching or not.
 *
 *   Null for a driver with no live shift, which is also every driver the
 *   `has_open_journey` flag below reports as online on a journey whose window
 *   has already lapsed — 32 never checked that, and this column is the first
 *   thing on the screen that will show it. `nulls last` in the sort keeps those
 *   drivers below everybody with a real departure rather than above them, which
 *   is what plain `asc` would have done.
 */
drop function if exists public.assignable_drivers(uuid);

create function public.assignable_drivers(parcel uuid)
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
 * Reads both live function bodies rather than asserting the functions exist,
 * because both existed before this file and the thing that changed is what they
 * sort on. A re-run of 70 or 32 over this turns it false, which is the whole
 * point of reading the body.
 */
create or replace function public.departure_priority_live()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    pg_get_functiondef('public.admin_waiting_drivers(integer)'::regprocedure)
      like '%coalesce(j.departure_time, j.departs_before) asc%'
    and pg_get_functiondef('public.assignable_drivers(uuid)'::regprocedure)
      like '%c.next_departure asc nulls last%';
$$;

comment on function public.departure_priority_live() is
  'True when both admin lists sort by soonest departure (75).';

revoke all on function public.departure_priority_live() from public, anon;
grant execute on function public.departure_priority_live() to authenticated;
