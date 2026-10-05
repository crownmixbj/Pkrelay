-- ============================================================================
-- 20250101000073_parcels_in_flight.sql — what has been collected, and what has not
-- ============================================================================
--
-- Run after 01–72. Re-runnable.
--
-- The admin area can see a parcel waiting for a driver and a parcel that has
-- been delivered. What it cannot see is the middle: a parcel somebody claimed
-- three days ago and never collected looks exactly like one collected an hour
-- ago, because the Overview's "In transit" tile counts both as `driver_id is
-- not null`.
--
-- ⚠ The gap between claimed and collected is where parcels die quietly.
--
--   A driver claims a job, something comes up, and nothing in the system
--   notices. The sender sees "Assigned" and waits. Nobody is told, because
--   there is no event — the absence of a pickup is not a thing that happens.
--   Separating "claimed, not collected" from "collected and moving" is the whole
--   point of this file.
--
-- ⚠ `status_changed_at` is new, and it exists because the stage clock was
--   unmeasurable without it.
--
--   `bookings` records `accepted_at`, `picked_up_at` and `delivered_at`. The two
--   middle stages — In Transit and Out for Delivery — have no timestamp at all,
--   so "how long has this parcel been sitting at this stage" could not be asked
--   of a parcel in either of them. One column, written by a trigger on the
--   status change, answers it for every stage including the ones added later.
--
--   It is not derived from `app_events` instead, for two reasons: that table is
--   swept, so the answer would silently become wrong for old parcels, and it
--   would mean a join against the busiest write-only table in the schema on a
--   screen somebody refreshes.
--
-- ⚠ Nothing here writes. An admin still cannot advance a parcel's stage — 10 is
--   explicit that only the carrying driver may, so that the record of who
--   handled a parcel is never ambiguous. This file reads.

do $$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'Run 20250101000001_bookings.sql first.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bookings' and column_name = 'picked_up_at'
  ) then
    raise exception 'Run 20250101000010_delivery.sql first.';
  end if;
end
$$;

-- -------------------------------------------------------- the stage clock --

/*
 * Nullable, backfilled, then given a default — in that order, so the file can
 * run twice.
 *
 * Adding it `not null default now()` would stamp every historical parcel with
 * the moment of the migration, and a re-run would do it again — wiping the real
 * timestamps the trigger had since recorded. Nullable means the backfill below
 * can be `where status_changed_at is null`, which is a no-op the second time.
 */
alter table public.bookings
  add column if not exists status_changed_at timestamptz;

/*
 * The best available truth for a parcel that already exists.
 *
 * Newest stamp first: a delivered parcel last moved when it was delivered, a
 * collected one when it was collected, a claimed one when it was claimed, and a
 * parcel still waiting for a driver has not moved since it was booked.
 */
update public.bookings
   set status_changed_at = coalesce(delivered_at, picked_up_at, accepted_at, created_at)
 where status_changed_at is null;

alter table public.bookings
  alter column status_changed_at set default now();

comment on column public.bookings.status_changed_at is
  'When status last changed. Written by set_booking_status_changed_at; the only '
  'clock the two middle stages have, since In Transit and Out for Delivery '
  'record no timestamp of their own.';

create or replace function public.set_booking_status_changed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  /*
   * ⚠ Not `security definer`, and it must not become one.
   *
   *   It writes one column on the row already being written by whoever is
   *   allowed to write it. Definer rights would let it run where the caller's
   *   own update would have been refused, which is a privilege this needs none
   *   of.
   */
  new.status_changed_at := now();
  return new;
end;
$$;

drop trigger if exists bookings_status_changed_at on public.bookings;
create trigger bookings_status_changed_at
  before update on public.bookings
  for each row
  /* Only on a real move. An update that leaves the status alone is not one. */
  when (new.status is distinct from old.status)
  execute function public.set_booking_status_changed_at();

-- ------------------------------------------------------------ the board ----

/**
 * Every parcel a driver is holding: claimed, collected, or on its way.
 *
 * ⚠ `collected` is the line down the middle of this list, and it is
 *   `picked_up_at is not null` rather than a status test.
 *
 *   The two are equivalent today and would not stay that way — a stage added
 *   between Assigned and Picked Up, or a correction that moves a status without
 *   a collection, would quietly reclassify half the board. The timestamp is the
 *   fact: somebody took this parcel from the sender at that moment.
 *
 * ⚠ The totals are window counts over the whole set, not over the page.
 *
 *   `count(*) over ()` is evaluated before the limit, so the tiles stay right
 *   when the list is truncated. Tiles computed in the client from a capped list
 *   understate exactly when the number matters most.
 *
 * No names, no phone numbers, no addresses — the drawer's audited reveal is
 * still the only way to those, for 17's reasons.
 */
create or replace function public.admin_parcels_in_flight(max_rows integer default 100)
returns table (
  id uuid,
  tracking_id text,
  status text,
  delivery_type text,
  origin_city text,
  destination_city text,
  weight numeric,
  estimated_fee numeric,
  driver_id uuid,
  driver_name text,
  /** Null for a parcel an admin placed by hand: nobody accepted it. */
  accepted_at timestamptz,
  /** The collection from the sender. Null until it happens — the whole point. */
  picked_up_at timestamptz,
  status_changed_at timestamptz,
  collected boolean,
  /** Since the stage last changed. The stall clock. */
  minutes_since_move integer,
  /** Since it got a driver, however it got one. */
  minutes_since_claim integer,
  total_in_flight integer,
  total_awaiting_collection integer,
  total_collected integer,
  total_stalled integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with flight as (
    select
      b.id,
      b.tracking_id::text,
      b.status::text,
      b.delivery_type::text,
      b.origin_city::text,
      b.destination_city::text,
      b.weight,
      b.estimated_fee,
      b.driver_id,
      coalesce(nullif(btrim(b.driver), ''), 'Unnamed driver')::text as driver_name,
      b.accepted_at,
      b.picked_up_at,
      coalesce(b.status_changed_at, b.picked_up_at, b.accepted_at, b.created_at)
        as status_changed_at,
      (b.picked_up_at is not null) as collected,
      (extract(epoch from (
        now() - coalesce(b.status_changed_at, b.picked_up_at, b.accepted_at, b.created_at)
      )) / 60)::integer as minutes_since_move,
      (extract(epoch from (
        now() - coalesce(b.accepted_at, b.status_changed_at, b.created_at)
      )) / 60)::integer as minutes_since_claim
    from public.bookings b
    where public.is_admin()
      and b.driver_id is not null
      and b.status not in ('Delivered', 'Cancelled')
  )
  select
    f.id, f.tracking_id, f.status, f.delivery_type, f.origin_city, f.destination_city,
    f.weight, f.estimated_fee, f.driver_id, f.driver_name,
    f.accepted_at, f.picked_up_at, f.status_changed_at, f.collected,
    f.minutes_since_move, f.minutes_since_claim,
    count(*) over ()::integer,
    count(*) filter (where not f.collected) over ()::integer,
    count(*) filter (where f.collected) over ()::integer,
    /* Stalled is a day without a move, at any stage. The amber line is the client's. */
    count(*) filter (where f.minutes_since_move >= 24 * 60) over ()::integer
  from flight f
  /*
    Longest since a move first, and the uncollected above the moving.

    A parcel claimed yesterday and never collected is the most urgent row on
    this screen; one collected an hour ago needs nobody. Sorting by booking date
    would bury the first under a week of healthy deliveries.
  */
  order by f.collected asc, f.minutes_since_move desc
  limit greatest(1, least(coalesce(max_rows, 100), 500));
$$;

revoke all on function public.admin_parcels_in_flight(integer) from public, anon;
grant execute on function public.admin_parcels_in_flight(integer) to authenticated;
