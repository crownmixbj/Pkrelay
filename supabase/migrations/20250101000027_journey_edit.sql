-- LOCI — a driver can change their mind about a journey.
--
-- Run after 01–26. Re-runnable.
--
--   cancel_journey   withdraw a route entirely
--   update_journey   change where, when, or how much
--
-- Both are the driver's own route only, and both refuse once the route is no
-- longer something that can be changed.
--
-- ⚠ WHY THESE ARE FUNCTIONS RATHER THAN JUST THE EXISTING UPDATE POLICY.
--
--   `20250101000015_dispatch.sql` already lets a driver update their own journey row, so a
--   client could cancel one today with a plain PATCH. What it cannot express is
--   what has to happen *around* the change:
--
--     - cancelling has to settle any offer already out on that route, and put
--       the parcel back into dispatch rather than leaving it held for the rest
--       of its window by a driver who has just walked away;
--     - editing has to be refused while an offer is out, because the offer was
--       made against terms the driver is in the middle of changing.
--
--   A row-level policy can forbid a write. It cannot re-dispatch a parcel.

do $$
begin
  if to_regprocedure('public.dispatch_booking(uuid)') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------- cancelling --

/**
 * Withdraws a route.
 *
 * Any offer still out on it is expired and its parcel immediately re-dispatched,
 * so the parcel goes to the next eligible driver now rather than sitting held
 * for the remainder of a hold by somebody who has left.
 *
 * ⚠ Cancelling a route does not touch a parcel the driver has already accepted.
 *   Once accepted, the parcel is assigned to the *driver* (`bookings.driver_id`)
 *   and the journey is only how they came to have it. A driver who wants out of
 *   a parcel they accepted releases the job on Assigned Trip; withdrawing the
 *   route they found it on would be a confusing way to spell that, and would
 *   silently strand a parcel somebody is expecting.
 */
create or replace function public.cancel_journey(journey uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  owner uuid;
  current_status text;
  stranded uuid;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select driver_id, status into owner, current_status
  from public.driver_journeys where id = journey;

  if owner is null then
    raise exception 'No such journey';
  end if;

  if owner <> actor then
    raise exception 'Not your journey';
  end if;

  if current_status in ('cancelled', 'completed') then
    -- Already gone. Not an error: two taps on a slow connection should not
    -- produce a red banner for something that is in the state you wanted.
    return;
  end if;

  /*
    Settle and re-offer, one parcel at a time.

    `dispatch_booking` is called after the offer is marked expired so that the
    lazy-expiry guard inside it sees a parcel with nothing live on it. Doing it
    the other way round would hit the "genuinely out with someone" branch and
    return without re-offering.
  */
  for stranded in
    select booking_id from public.dispatch_offers
    where journey_id = journey and status = 'offered'
  loop
    update public.dispatch_offers
       set status = 'expired', responded_at = now()
     where journey_id = journey and booking_id = stranded and status = 'offered';

    perform public.dispatch_booking(stranded);
  end loop;

  update public.driver_journeys
     set status = 'cancelled'
   where id = journey;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'dispatch', 'driver cancelled a journey',
    jsonb_build_object('journey', journey), actor
  );
end;
$$;

-- ----------------------------------------------------------------- editing --

/**
 * Changes a route's terms before it has been acted on.
 *
 * ⚠ Refused while an offer is live on this route, and that refusal is the
 *   point of the function.
 *
 *   An offer says "this parcel, to you, because of this journey". Letting the
 *   journey change underneath it means a driver can be offered a Lagos parcel,
 *   edit the route to Abuja, and accept — arriving in the wrong city with
 *   somebody's parcel. Everything else here is bookkeeping; this is the rule.
 *
 * The driver is told to answer the offer first. Declining rolls the parcel
 * straight to the next driver, so the wait is theirs to end.
 *
 * Nulls mean "leave this as it is", so the client can send only what changed.
 */
create or replace function public.update_journey(
  journey uuid,
  new_origin text default null,
  new_destination text default null,
  new_capacity numeric default null,
  new_departure timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  route record;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select driver_id, status, mode, origin_city, destination_city
    into route
  from public.driver_journeys where id = journey;

  if route.driver_id is null then
    raise exception 'No such journey';
  end if;

  if route.driver_id <> actor then
    raise exception 'Not your journey';
  end if;

  if route.status in ('cancelled', 'completed') then
    raise exception 'That journey is % and cannot be edited', route.status;
  end if;

  /*
    A flash shift is not a route and has no terms to edit.

    Going offline and online again is how a driver changes a shift, and that
    path already exists (`end_flash_shift` / `start_flash_shift`). Editing one
    here would have to invent a meaning for "departure" on a row that has none.
  */
  if route.mode = 'flash' then
    raise exception 'Go offline and back online to change a flash shift';
  end if;

  if exists (
    select 1 from public.dispatch_offers
    where journey_id = journey and status = 'offered' and expires_at > now()
  ) then
    raise exception 'Answer the trip offered on this route before changing it';
  end if;

  update public.driver_journeys
     set origin_city = coalesce(new_origin, origin_city),
         destination_city = coalesce(new_destination, destination_city),
         capacity_kg = coalesce(new_capacity, capacity_kg),
         -- `departs_before` follows from this via journey_departure_sync.
         departure_time = coalesce(new_departure, departure_time)
   where id = journey;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'dispatch', 'driver edited a journey',
    jsonb_build_object('journey', journey), actor
  );
end;
$$;

revoke all on function public.cancel_journey(uuid) from public, anon;
revoke all on function public.update_journey(uuid, text, text, numeric, timestamptz)
  from public, anon;
grant execute on function public.cancel_journey(uuid) to authenticated;
grant execute on function public.update_journey(uuid, text, text, numeric, timestamptz)
  to authenticated;

/*
  ⚠ No re-sweep after an edit, deliberately.

    `driver_journeys_sweep` fires on insert only, so that pausing and resuming
    cannot be used to jump the queue (20250101000019_push.sql). An edit is the same lever
    with an extra step: change the capacity by a kilogram, collect a fresh sweep,
    change it back. The `loci-redispatch` cron picks the edited route up within
    five minutes, in the order everybody else is in.
*/

/*
  ⚠ And one gap this closes on the way past.

    `respond_to_offer` never checked the journey an offer came from. A driver
    could cancel a route and still accept an offer it had produced. Cancelling
    now expires those offers, so the state is hard to reach — but "hard to
    reach" is not "cannot happen" when a request is already in flight, so the
    accept path checks too.
*/
create or replace function public.journey_is_live(journey uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.driver_journeys
    where id = journey and status <> 'cancelled'
  );
$$;

revoke all on function public.journey_is_live(uuid) from public, anon, authenticated;
