/*
  20250101000032_dispatch_mode.sql — a switch that stands automatic dispatch down.

  LOCI matches parcels to drivers automatically: a booking inserts, a trigger
  fires, `dispatch_booking` picks the best open journey and makes an offer. That
  is the right default and it is not the right behaviour on every day. A public
  holiday with three drivers online, a hub outage, a corporate consignment that
  has to go to one particular rider — in each case an operator needs to place
  parcels by hand and needs the matcher to stop placing them first.

  ⚠ WHAT MANUAL MODE DOES NOT DO

    It does not pause the platform, and it does not touch a parcel already
    moving. Senders keep booking, drivers keep delivering, offers already live
    keep their countdowns and can still be accepted. The only thing that stops
    is the *making of new offers*.

    Stated because the opposite assumption is easy and expensive: an operator
    who believes Manual freezes everything will flip it during an incident and
    then be surprised that a driver accepted a parcel ten seconds later.

  ⚠ AND THE COST, PLAINLY

    In manual mode nothing assigns parcels except a person. A platform left in
    Manual overnight has every parcel from that night sitting unassigned in the
    morning, and no alarm will have gone off. `dispatch_health()` exists so the
    admin screen can show the queue and its age; a mode switch with no visible
    backlog is a foot-gun with a hair trigger.

  Scope is global — one switch, every city, flash and scheduled alike. Chosen
  over per-city because a Lagos→Abuja parcel under per-city modes has to answer
  "which end decides?", and every answer to that is arbitrary in a way an
  operator would have to memorise.

  Requires: 20250101000007_admin.sql, 20250101000025_dispatch_only.sql, 20250101000031_document_expiry.sql.
*/

do $$
begin
  if to_regprocedure('public.admin_assign_parcel(uuid, uuid)') is null then
    raise exception 'Run 20250101000025_dispatch_only.sql first.';
  end if;
  if to_regprocedure('public.documents_permit_dispatch(uuid)') is null then
    raise exception 'Run 20250101000031_document_expiry.sql first.';
  end if;
end
$$;

-- ---------------------------------------------------------------- the mode --

/**
 * 'auto' or 'manual'. Defaults to auto.
 *
 * ⚠ The default is the safe direction, and that is not an accident of ordering.
 *
 *   An unreadable setting, a typo in the row, a fresh database — every failure
 *   to determine the mode resolves to 'auto', which keeps parcels moving. The
 *   inverse default would mean a missing settings row silently halted dispatch
 *   platform-wide, with the symptom appearing hours later as a pile of
 *   unassigned parcels and nothing in the logs pointing at the cause.
 */
create or replace function public.dispatch_mode()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select value from private.app_settings where key = 'dispatch_mode') = 'manual'
      then 'manual'
    else 'auto'
  end;
$$;

revoke all on function public.dispatch_mode() from public, anon;
grant execute on function public.dispatch_mode() to authenticated;

/**
 * Flips the switch. Admins only, and always audited.
 *
 * Returns the mode it settled on, so a client renders what the server believes
 * rather than what it optimistically set — two admins on the screen at once is
 * a real situation, and the loser of that race must not be shown their own
 * choice.
 */
create or replace function public.set_dispatch_mode(mode text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous text := public.dispatch_mode();
  waiting integer;
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  if mode not in ('auto', 'manual') then
    raise exception 'Mode must be auto or manual';
  end if;

  insert into private.app_settings (key, value) values ('dispatch_mode', mode)
  on conflict (key) do update set value = excluded.value;

  select count(*) into waiting
  from public.bookings
  where status = 'Booked' and driver_id is null;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    -- `warn`, not `info`, for the switch into manual. It is the state where
    -- parcels stop moving on their own, and it should stand out in a log
    -- somebody is scrolling to work out why nothing was assigned last night.
    case when mode = 'manual' then 'warning' else 'info' end,
    'dispatch',
    'dispatch mode set to ' || mode,
    jsonb_build_object('from', previous, 'to', mode, 'unassigned_parcels', waiting),
    auth.uid()
  );

  /*
    Returning to auto sweeps immediately.

    Without this, every parcel booked during the manual window waits for the
    next scheduled sweep — so switching back looks like it did nothing, and an
    operator watching an unchanged queue will reasonably conclude the toggle is
    broken and start assigning by hand anyway.
  */
  if mode = 'auto' and previous = 'manual' then
    perform public.dispatch_booking(b.id)
    from public.bookings b
    where b.status = 'Booked' and b.driver_id is null;
  end if;

  return mode;
end;
$$;

revoke all on function public.set_dispatch_mode(text) from public, anon;
grant execute on function public.set_dispatch_mode(text) to authenticated;

-- ------------------------------------------------------- dispatch respects it --

/**
 * Dispatch, now standing down in manual mode.
 *
 * Identical to 20250101000031_document_expiry.sql apart from the guard at the top.
 *
 * ⚠ The check is HERE rather than on the insert trigger, and that placement is
 *   the load-bearing part of this file.
 *
 *   `dispatch_booking` is called from five places: the booking insert trigger,
 *   the offer sweeper, `respond_to_offer` on a decline, `sweep_for_journey`
 *   when a driver declares a route, and `cancel_journey`. Guarding the trigger
 *   would leave the other four cheerfully making offers in manual mode — and
 *   the decline path in particular would keep rotating a parcel through drivers
 *   while an operator believed they had control of it.
 *
 *   One function, one gate. Anything that wants to dispatch has to come through
 *   here, which is why the grant on this function is revoked from everyone.
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
  /*
    Manual mode: do nothing, quietly.

    No exception and no event row. This function runs inside the booking insert
    trigger, so raising would stop a sender posting a parcel — and logging every
    call would write one line per booking per sweep for as long as the mode is
    held, burying the mode change itself under its own consequences. The mode
    switch is audited once, in `set_dispatch_mode`, which is where somebody
    reading the log will look.
  */
  if public.dispatch_mode() = 'manual' then
    return null;
  end if;

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
    and public.documents_permit_dispatch(j.driver_id)
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
    (exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id and o.driver_id = j.driver_id
    )) asc,
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

revoke all on function public.dispatch_booking(uuid) from public, anon, authenticated;

-- ----------------------------------------------------- what a human needs --

/**
 * The parcels waiting for somebody, oldest first.
 *
 * ⚠ Returns the queue in BOTH modes, not only in manual.
 *
 *   Auto-dispatch leaves parcels unassigned all the time — nobody is going that
 *   way, every candidate is in cooldown, the only match has an expired licence.
 *   Those are exactly the parcels a human should be looking at, and hiding the
 *   queue whenever the toggle says Auto would mean the screen is blank
 *   precisely when the automation is quietly failing.
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
  offers_made integer
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
    (select count(*)::integer from public.dispatch_offers o where o.booking_id = b.id)
  from public.bookings b
  where public.is_admin()
    and b.status = 'Booked'
    and b.driver_id is null
  order by b.created_at asc
  limit greatest(1, least(coalesce(limit_rows, 100), 500));
$$;

revoke all on function public.unassigned_parcels(integer) from public, anon;
grant execute on function public.unassigned_parcels(integer) to authenticated;

/**
 * Who could take this parcel, best first, with the reasons they might not.
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
 *   ineligible *and* refused by `admin_assign_parcel` below. That is a legal
 *   limit rather than a matching preference, and an operator should not be able
 *   to click past it by mistake.
 */
create or replace function public.assignable_drivers(parcel uuid)
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
  note text
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
      public.documents_permit_dispatch(a.user_id) as documents_ok
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
    end
  from candidates c
  order by
    c.documents_ok desc,
    c.route_matches desc,
    c.has_open_journey desc,
    c.active_parcels asc,
    c.full_name asc;
$$;

revoke all on function public.assignable_drivers(uuid) from public, anon;
grant execute on function public.assignable_drivers(uuid) to authenticated;

/**
 * Manual assignment, with the document block enforced server-side.
 *
 * Replaces the version in 20250101000025_dispatch_only.sql. Same audited admin-only path,
 * plus the one refusal that is not a preference: a driver whose licence or
 * insurance has lapsed cannot be given a parcel by anybody, including an admin
 * who clicked past a warning.
 *
 * ⚠ Works in BOTH modes on purpose. "Manual" is about what the *matcher* does;
 *   an operator placing one difficult parcel while automation runs normally is
 *   the common case, and forcing them to halt platform-wide dispatch to do it
 *   would make the toggle something people flip far too readily.
 */
create or replace function public.admin_assign_parcel(parcel uuid, driver uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  parcel_status text;
  parcel_driver uuid;
  driver_approved boolean;
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  select status, driver_id into parcel_status, parcel_driver
  from public.bookings where id = parcel;

  if parcel_status is null then
    raise exception 'No such parcel';
  end if;

  if parcel_driver is not null then
    raise exception 'That parcel already has a driver';
  end if;

  if parcel_status <> 'Booked' then
    raise exception 'That parcel is % and cannot be assigned', parcel_status;
  end if;

  select exists (
    select 1 from public.driver_applications
    where user_id = driver and status = 'approved'
  ) into driver_approved;

  if not driver_approved then
    raise exception 'That driver is not approved';
  end if;

  if not public.documents_permit_dispatch(driver) then
    raise exception
      'That driver has an expired document and cannot carry parcels until it is renewed';
  end if;

  update public.bookings
     set driver_id = driver, status = 'Booked'
   where id = parcel;

  /*
    Any live offer on this parcel is settled, not left hanging.

    Otherwise a driver who was mid-countdown taps Accept on a parcel that now
    belongs to somebody else, and `respond_to_offer` refuses them with a message
    about a parcel they were legitimately offered thirty seconds earlier.
  */
  update public.dispatch_offers
     set status = 'expired', responded_at = now()
   where booking_id = parcel and status = 'offered';

  /*
    The level depends on the mode, and that is the honest reading.

    In manual mode a hand assignment is the *expected* thing — every parcel is
    placed this way, and logging each one as a warning would bury the ones that
    matter under the ones that do not. In auto mode it is an override: a run of
    them means the matcher is failing to place parcels, which is a dispatch bug
    somebody should see rather than an admin habit.

    20250101000025_dispatch_only.sql logged them all at 'warning', which was right when
    manual mode did not exist.
  */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    case when public.dispatch_mode() = 'manual' then 'info' else 'warning' end,
    'dispatch', 'admin assigned a parcel by hand',
    jsonb_build_object('booking', parcel, 'driver', driver, 'mode', public.dispatch_mode()),
    actor
  );
end;
$$;

revoke all on function public.admin_assign_parcel(uuid, uuid) from public, anon;
grant execute on function public.admin_assign_parcel(uuid, uuid) to authenticated;

-- ------------------------------------------------------------- the alarm ---

/**
 * How the queue is doing, for the admin screen.
 *
 * Exists so Manual mode has a visible cost. A toggle that silently stops
 * dispatch and shows nothing afterwards is how a platform spends a night not
 * assigning parcels; the oldest waiting parcel, in minutes, next to the switch
 * is what makes that impossible to miss.
 */
create or replace function public.dispatch_health()
returns table (
  mode text,
  unassigned integer,
  oldest_wait_minutes integer,
  live_offers integer,
  blocked_drivers integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.dispatch_mode(),
    (select count(*)::integer from public.bookings
      where status = 'Booked' and driver_id is null and public.is_admin()),
    (select coalesce(max(extract(epoch from (now() - created_at)) / 60), 0)::integer
      from public.bookings
      where status = 'Booked' and driver_id is null and public.is_admin()),
    (select count(*)::integer from public.dispatch_offers
      where status = 'offered' and expires_at > now() and public.is_admin()),
    (select count(distinct d.driver_id)::integer
      from public.driver_documents d
      join public.document_kinds k on k.key = d.kind
      where k.blocks_dispatch
        and d.expires_at is not null
        and d.expires_at < current_date
        and public.is_admin());
$$;

revoke all on function public.dispatch_health() from public, anon;
grant execute on function public.dispatch_health() to authenticated;
