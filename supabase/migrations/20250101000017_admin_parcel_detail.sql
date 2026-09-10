-- LOCI — what an operator can see about a parcel, and what it costs them to look.
--
-- Run after 01–16. Re-runnable.
--
-- Two things happen here, and the first is a fix rather than a feature.

do $$
begin
  if to_regclass('public.app_events') is null then
    raise exception 'Run 20250101000007_admin.sql first.';
  end if;
  if to_regclass('public.dispatch_offers') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;
end
$$;

-- ------------------------------------------- 1. the open board was too open --

/*
  The policy this replaces ended `or driver_id is null`, with no other
  qualification, granted to `authenticated`.

  That meant *any* signed-in account — not an approved driver, not a driver at
  all, anyone who could complete a sign-up form — could read every unclaimed
  parcel in full: the sender's name, their phone number, and the pickup address.
  A script with one account could have walked the whole board.

  The feed still exists, because a driver has to see a job before taking one. It
  is now limited to drivers who have actually been approved — the same gate that
  already decides who may claim.
*/
drop policy if exists "read own, carried, or unclaimed" on public.bookings;
create policy "read own, carried, or unclaimed"
  on public.bookings for select
  to authenticated
  using (
    sender_id = (select auth.uid())
    or driver_id = (select auth.uid())
    or (driver_id is null and public.is_approved_driver())
  );

/*
  ⚠ A narrower exposure remains, and is worth naming rather than leaving for
    someone to find.

    An *approved* driver browsing the board still reads the whole row, including
    the sender's phone and the pickup address, on parcels they have not claimed.
    They need the route, the weight and the fee to decide; they do not need a
    phone number until the parcel is theirs.

    Fixing that properly means a view exposing only the decision-making columns
    and pointing the board at it, because Postgres column privileges are per
    role, not per row — they cannot say "hide the phone on unclaimed rows but
    show it on your own". That refactor is not done here.
*/

-- -------------------------------------- 2. operator detail, without the keys --

/**
 * Everything an operator needs to answer "what is happening with this parcel",
 * and nothing that identifies the people involved.
 *
 * A `security definer` function rather than an admin read policy on `bookings`.
 * The difference matters: a policy would let an admin — or anything holding an
 * admin's token — select every column of every row, forever, unlogged. This
 * returns a fixed shape, so what an operator can see is decided here rather
 * than by whatever query they happen to write.
 *
 * Names and phone numbers are deliberately absent. They come from
 * `admin_reveal_parcel_contacts` below, which writes an audit line.
 */
create or replace function public.admin_parcel_detail(booking_id uuid)
returns table (
  id uuid,
  tracking_id text,
  status text,
  delivery_type text,
  origin_city text,
  destination_city text,
  pickup_area text,
  dropoff_area text,
  pickup_mode text,
  dropoff_mode text,
  weight numeric,
  declared_value numeric,
  estimated_fee numeric,
  category text,
  fragile boolean,
  created_at timestamptz,
  accepted_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  driver_name text,
  driver_id uuid,
  has_sender_photo boolean,
  liveness_status text,
  -- How dispatch has gone: how many drivers have been offered it, and whether
  -- one is holding it now. A stuck parcel is usually a dispatch story.
  offers_made bigint,
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
      b.id,
      b.tracking_id,
      b.status,
      b.delivery_type,
      b.origin_city::text,
      b.destination_city::text,
      b.pickup_area,
      b.dropoff_area,
      b.pickup_mode,
      b.dropoff_mode,
      b.weight,
      b.declared_value,
      b.estimated_fee,
      b.category,
      b.fragile,
      b.created_at,
      b.accepted_at,
      b.picked_up_at,
      b.delivered_at,
      b.cancelled_at,
      b.cancellation_reason,
      /*
        The driver's name is included and the sender's is not, deliberately.

        A driver is a counterparty LOCI has contracted with and vetted; an
        operator resolving a delivery needs to know who is carrying it. A sender
        is a customer whose name is not required to answer "where is this
        parcel".
      */
      b.driver,
      b.driver_id,
      (b.sender_photo_path is not null),
      b.liveness_status,
      (select count(*) from public.dispatch_offers o where o.booking_id = b.id),
      exists (
        select 1 from public.dispatch_offers o
        where o.booking_id = b.id and o.status = 'offered' and o.expires_at > now()
      )
    from public.bookings b
    where b.id = booking_id;
end;
$$;

/**
 * A page of parcels for the admin lists, in the same redacted shape.
 *
 * `scope` picks the list: 'unassigned' is the backlog, 'assigned' is everything
 * with a driver and not yet finished, 'all' is both plus finished ones.
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

-- --------------------------------------------- 3. contacts, and the record ---

/**
 * The names and phone numbers, and a line in the log saying who looked.
 *
 * Separate from `admin_parcel_detail` on purpose. Bundling them would mean
 * every glance at a stuck parcel pulled a customer's home address and phone
 * number onto someone's screen, and an audit log that fired on every list open
 * is an audit log nobody can read.
 *
 * This is the shape support tooling normally takes in a regulated business:
 * operational data is free, personal data costs a deliberate action and leaves
 * a trace.
 */
create or replace function public.admin_reveal_parcel_contacts(
  booking_id uuid,
  reason text default null
)
returns table (
  pickup_contact_name text,
  sender_phone text,
  pickup_address text,
  recipient_name text,
  recipient_phone text,
  dropoff_address text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  /*
    Logged before the data is returned, not after.

    If the insert fails the read does not happen — which is the correct way
    round for an audit trail. An audit written afterwards is one that can be
    skipped by an error.
  */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'privacy',
    'admin revealed parcel contact details',
    jsonb_build_object(
      'booking', booking_id,
      'reason', left(coalesce(reason, ''), 200)
    ),
    actor
  );

  return query
    select b.pickup_contact_name, b.sender_phone, b.pickup_address,
           b.recipient_name, b.recipient_phone, b.dropoff_address
    from public.bookings b
    where b.id = booking_id;
end;
$$;

revoke all on function public.admin_parcel_detail(uuid) from public, anon;
revoke all on function public.admin_parcels(text, text, integer) from public, anon;
revoke all on function public.admin_reveal_parcel_contacts(uuid, text) from public, anon;
grant execute on function public.admin_parcel_detail(uuid) to authenticated;
grant execute on function public.admin_parcels(text, text, integer) to authenticated;
grant execute on function public.admin_reveal_parcel_contacts(uuid, text) to authenticated;

/*
  ⚠ Still no admin read policy on `public.bookings`, and that is deliberate.

    Everything above goes through a function with a fixed column list. Adding a
    policy would quietly make all of this redundant and hand every admin token
    `select *` over every parcel — including the contact columns this file
    exists to put behind an audited door.
*/
