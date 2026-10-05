-- ============================================================================
-- 20250101000072_admin_on_the_way.sql — the parcels that are actually moving
-- ============================================================================
--
-- Run after 07 and 17. Re-runnable. No schema change, no data change — two
-- function bodies.
--
-- ⚠ The admin overview has a card labelled "In transit" that does not count
--   parcels in transit, and there is no view of the ones that are.
--
--   `admin_overview` counts it as `driver_id is not null and status <>
--   'Delivered'`. That is every parcel with a driver — Assigned and Picked Up
--   included, which have not left yet — and, because only 'Delivered' is
--   excluded, every cancelled parcel too. The card it feeds opens a drawer
--   scoped to 'assigned', which is the same broad set under a title that at
--   least admits it ("Parcels with a driver").
--
--   So an operator asking "what is on the road right now" has been reading a
--   number that answers a different question, and one that includes jobs
--   somebody called off.
--
-- ⚠ "On the way" is In Transit *and* Out for Delivery, not In Transit alone.
--
--   `next_booking_status` runs Assigned → Picked Up → In Transit → Out for
--   Delivery → Delivered. A driver on the last leg has not stopped travelling;
--   dropping them from the list would make a parcel vanish from the operator's
--   board at the exact moment it is closest to the recipient, which is when
--   they are most likely to be asked about it.
--
-- ⚠ Two counts are fixed in passing, and both are the same mistake.
--
--   `parcels_unclaimed` and `parcels_in_transit` each exclude 'Delivered' and
--   nothing else, so a cancelled parcel is counted as waiting for a driver or
--   as being carried by one, for ever. Cancelled is a terminal state like
--   Delivered and belongs on the same side of the line.

do $$
begin
  if to_regprocedure('public.admin_overview()') is null then
    raise exception 'Run 20250101000007_admin.sql first.';
  end if;
  if to_regprocedure('public.admin_parcels(text, text, integer)') is null then
    raise exception 'Run 20250101000017_admin_parcel_detail.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------ the counts ----

/**
 * Replaces 07's version. Three changes, everything else copied verbatim —
 * `create or replace` swaps the whole function, so anything left out would be
 * lost. 64 makes the same point about this exact hazard.
 */
create or replace function public.admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  select jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'admins', (select count(*) from public.profiles where is_admin),
    'applications_pending', (
      select count(*) from public.driver_applications where status = 'pending'
    ),
    'applications_under_review', (
      select count(*) from public.driver_applications where status = 'under_review'
    ),
    'drivers_approved', (
      select count(*) from public.driver_applications where status = 'approved'
    ),
    'applications_rejected', (
      select count(*) from public.driver_applications where status = 'rejected'
    ),
    'parcels_total', (select count(*) from public.bookings),

    /* Changed in 72: a cancelled parcel is not waiting for a driver. */
    'parcels_unclaimed', (
      select count(*) from public.bookings
      where driver_id is null and status not in ('Delivered', 'Cancelled')
    ),

    /*
     * Changed in 72: same correction. This remains the broad "has a driver"
     * figure, and the card that reads it is relabelled to say so — the name is
     * kept because the admin screen and `admin_parcels`' 'assigned' scope both
     * mean this set, and renaming the key would silently zero the card on any
     * client that had not shipped yet.
     */
    'parcels_in_transit', (
      select count(*) from public.bookings
      where driver_id is not null and status not in ('Delivered', 'Cancelled')
    ),

    /*
     * New in 72. The one an operator actually wants: wheels turning, right now.
     */
    'parcels_on_the_way', (
      select count(*) from public.bookings
      where status in ('In Transit', 'Out for Delivery')
    ),

    'parcels_delivered', (select count(*) from public.bookings where status = 'Delivered'),
    'parcels_last_7_days', (
      select count(*) from public.bookings where created_at > now() - interval '7 days'
    ),
    'errors_last_24h', (
      select count(*) from public.app_events
      where level = 'error' and created_at > now() - interval '24 hours'
    )
  ) into result;

  return result;
end;
$$;

-- ------------------------------------------------------------- the list -----

/**
 * Replaces 17's version. One new branch in the `case`; the signature, the
 * returned columns, the redaction and the ordering are untouched.
 *
 * ⚠ The return shape is deliberately not extended.
 *
 *   The obvious next column is "moving since", and there is nowhere honest to
 *   read it from: `bookings` stamps `picked_up_at` and `delivered_at` and
 *   nothing for the two legs between them. Adding `in_transit_at` means
 *   editing `advance_booking`, which is the function the whole delivery chain
 *   turns on, and it would be null for every parcel already on the road. That
 *   is a separate change with its own blast radius, not a column bolted onto
 *   this one.
 *
 * ⚠ Ordering stays oldest-first, and for this scope that is the useful end.
 *   The parcel that has been in transit longest is the one about to become a
 *   question.
 */
create or replace function public.admin_parcels(
  scope text default 'unassigned',
  city text default null,
  max_rows integer default 50
)
returns table (
  id uuid,
  tracking_id text,
  status text,
  origin_city text,
  destination_city text,
  weight numeric,
  estimated_fee numeric,
  created_at timestamptz,
  driver_name text,
  offer_outstanding boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  return query
    select
      b.id, b.tracking_id, b.status,
      b.origin_city::text, b.destination_city::text,
      b.weight, b.estimated_fee, b.created_at,
      b.driver,
      exists (
        select 1 from public.dispatch_offers o
        where o.booking_id = b.id and o.status = 'offered' and o.expires_at > now()
      )
    from public.bookings b
    where
      case scope
        when 'unassigned' then b.driver_id is null and b.status = 'Booked'
        when 'assigned' then b.driver_id is not null and b.status not in ('Delivered', 'Cancelled')
        /* New in 72. See the header for why Out for Delivery is included. */
        when 'on_the_way' then b.status in ('In Transit', 'Out for Delivery')
        else true
      end
      and (city is null or b.destination_city::text = city)
    order by b.created_at asc
    -- Bounded, and oldest first. An operator opening a backlog wants the parcel
    -- that has waited longest, not the newest one, and an unbounded query on a
    -- busy day would time out on the screen they open first every morning.
    limit greatest(1, least(coalesce(max_rows, 50), 200));
end;
$$;

/*
  Re-asserted rather than assumed. `create or replace` keeps the existing ACL,
  so these are already right on a database that has run 17 — but a fresh one
  built from migrations alone has not, and an admin reporting function readable
  by `anon` is the kind of thing nobody notices until it matters.
*/
revoke all on function public.admin_overview() from public, anon;
revoke all on function public.admin_parcels(text, text, integer) from public, anon;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_parcels(text, text, integer) to authenticated;

notify pgrst, 'reload schema';
