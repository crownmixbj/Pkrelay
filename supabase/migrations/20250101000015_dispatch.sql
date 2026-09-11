-- LOCI — automated dispatch.
--
-- Run after 01–14. Re-runnable.
--
-- Replaces "drivers browse a board and claim what they like" with "drivers
-- declare the journeys they are making, and parcels are offered to them".
--
-- ⚠ THIS CHANGES THE DEAL WITH DRIVERS. The About page said "Drivers pick the
--   jobs they want. No forced dispatch", and How It Works said "Claimed, not
--   auto-assigned". Both are edited in the same change as this file, because
--   shipping the mechanism while leaving the promise standing would be telling
--   drivers something untrue on a page they can read.
--
-- The design is an *offer*, not an assignment:
--
--   A parcel is offered to one driver at a time and held for them for a few
--   minutes. They accept, decline, or let it lapse; then it moves to the next
--   best journey. Nobody is committed to a parcel they have not looked at, and
--   nobody has to sit refreshing a list.
--
-- The alternative — assigning outright — was rejected because a driver who
-- declared "Ibadan to Lagos on Tuesday" has told us their route, not agreed in
-- advance to whatever turns up on it.

do $$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'Run 20250101000001_bookings.sql first.';
  end if;
  if to_regclass('public.app_events') is null then
    raise exception 'Run 20250101000007_admin.sql first — dispatch decisions are audited.';
  end if;
end
$$;

-- ------------------------------------------------------------- journeys ----

create table if not exists public.driver_journeys (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users (id) on delete cascade,

  origin_city text not null,
  destination_city text not null,

  /*
    When the driver is travelling.

    A window rather than a timestamp: nobody leaves at exactly 09:00, and a
    parcel posted at 08:55 for a 09:00 departure is a match a precise time would
    miss. `departs_after` is the useful end — a driver will wait, but cannot
    leave earlier than they said.
  */
  departs_after timestamptz not null,
  departs_before timestamptz not null,

  /** Kilograms this driver still has room for on this journey. */
  capacity_kg numeric not null check (capacity_kg > 0),

  /*
    Copied from the approved application rather than typed here.

    A driver who could declare their own vehicle type could claim a truck on a
    motorcycle licence, and the matching rules read this field.
  */
  vehicle_type text not null,

  /*
    'open' accepts offers. 'paused' keeps the declaration but stops new ones —
    the driver is mid-journey, or has changed their mind about today.
    'completed' and 'cancelled' are terminal.
  */
  status text not null default 'open'
    check (status in ('open', 'paused', 'completed', 'cancelled')),

  created_at timestamptz not null default now(),

  constraint journey_window_ordered check (departs_before > departs_after),
  constraint journey_route_distinct check (
    origin_city <> destination_city or origin_city is null
  )
);

create index if not exists driver_journeys_open_idx
  on public.driver_journeys (origin_city, destination_city, departs_after)
  where status = 'open';

create index if not exists driver_journeys_driver_idx
  on public.driver_journeys (driver_id, created_at desc);

alter table public.driver_journeys enable row level security;

drop policy if exists "driver reads own journeys" on public.driver_journeys;
create policy "driver reads own journeys"
  on public.driver_journeys for select
  to authenticated
  using (driver_id = (select auth.uid()) or public.is_admin());

/*
  Only an approved driver may declare a journey, and only for themselves.

  `is_approved_driver()` already excludes banned and erased accounts — see
  20250101000009_bans.sql — so a banned driver cannot quietly keep receiving offers by
  leaving an old declaration open.
*/
drop policy if exists "approved driver declares own journey" on public.driver_journeys;
create policy "approved driver declares own journey"
  on public.driver_journeys for insert
  to authenticated
  with check (driver_id = (select auth.uid()) and public.is_approved_driver());

drop policy if exists "driver updates own journey" on public.driver_journeys;
create policy "driver updates own journey"
  on public.driver_journeys for update
  to authenticated
  using (driver_id = (select auth.uid()))
  with check (driver_id = (select auth.uid()));

-- --------------------------------------------------------------- offers ----

create table if not exists public.dispatch_offers (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  journey_id uuid not null references public.driver_journeys (id) on delete cascade,
  driver_id uuid not null references auth.users (id) on delete cascade,

  status text not null default 'offered'
    check (status in ('offered', 'accepted', 'declined', 'expired')),

  offered_at timestamptz not null default now(),
  /*
    How long the parcel is held.

    Long enough for a driver to look at their phone and think; short enough that
    a parcel is not stuck behind someone who left it in their pocket. Five
    minutes is the starting figure — watch `app_events` for how often offers
    expire before tuning it, because a number picked without data will be wrong.
  */
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  responded_at timestamptz,

  constraint offer_response_consistent check (
    (status = 'offered' and responded_at is null)
    or (status <> 'offered' and responded_at is not null)
    or (status = 'expired')
  )
);

/*
  One live offer per parcel, enforced by the database rather than by care.

  Without this, two matching runs racing each other could offer the same parcel
  to two drivers, and both would think it was theirs. A partial unique index is
  the right shape: any number of settled offers, at most one outstanding.
*/
create unique index if not exists dispatch_offers_one_live_per_booking
  on public.dispatch_offers (booking_id)
  where status = 'offered';

/*
  And a parcel is never offered to the same driver twice.

  A driver who declined has said no. Rotating back to them is how a dispatch
  system becomes something drivers turn off.
*/
create unique index if not exists dispatch_offers_once_per_driver
  on public.dispatch_offers (booking_id, driver_id);

create index if not exists dispatch_offers_driver_idx
  on public.dispatch_offers (driver_id, status, offered_at desc);

alter table public.dispatch_offers enable row level security;

drop policy if exists "driver reads own offers" on public.dispatch_offers;
create policy "driver reads own offers"
  on public.dispatch_offers for select
  to authenticated
  using (driver_id = (select auth.uid()) or public.is_admin());

/*
  No client insert, update or delete policy at all.

  Offers are created by the matcher and settled by `respond_to_offer` below,
  both `security definer`. A driver who could write this table could offer
  themselves any parcel in the country.
*/

-- ------------------------------------------------------------ the rules ----

/**
 * Whether a journey could carry a parcel.
 *
 * Split out so the matcher and the client can ask the same question, and so the
 * rule is readable in one place rather than buried in a join.
 */
create or replace function public.journey_matches(
  journey_origin text,
  journey_destination text,
  journey_departs_after timestamptz,
  journey_departs_before timestamptz,
  journey_capacity numeric,
  parcel_origin text,
  parcel_destination text,
  parcel_weight numeric
)
returns boolean language sql immutable set search_path = '' as $$
  select
    journey_origin = parcel_origin
    and journey_destination = parcel_destination
    and journey_capacity >= coalesce(parcel_weight, 0)
    /*
      The parcel has to be postable before the driver leaves. There is no
      pickup-time field on a booking, so "now" is the only honest proxy — a
      journey that has already departed cannot take anything new.
    */
    and journey_departs_before > now();
$$;

/**
 * Offers a parcel to the best available journey.
 *
 * Returns the offer id, or null when nothing matched — which is not a failure.
 * A parcel with no matching journey stays on the open board exactly as before,
 * so dispatch is additive: it takes work off drivers who have declared a route
 * and changes nothing for a parcel nobody is travelling for.
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
begin
  select id, origin_city, destination_city, weight, status, driver_id
    into parcel
  from public.bookings where id = booking_id;

  if parcel.id is null then
    return null;
  end if;

  -- Only an unclaimed, uncancelled parcel is dispatchable.
  if parcel.status <> 'Booked' or parcel.driver_id is not null then
    return null;
  end if;

  -- Already out with someone.
  if exists (
    select 1 from public.dispatch_offers
    where dispatch_offers.booking_id = dispatch_booking.booking_id
      and status = 'offered'
      and expires_at > now()
  ) then
    return null;
  end if;

  /*
    The ranking.

    Earliest departure first, then the driver with the least spare capacity that
    still fits. Preferring the tightest fit keeps the roomy journeys free for
    the bulky parcels that have fewer places to go — the same reasoning as
    best-fit bin packing, and it matters most on the routes with fewest drivers.

    Ties break on the oldest declaration, so a driver who declared first is
    offered first. Without that the ordering is arbitrary and drivers cannot
    tell why they are not getting work.
  */
  select j.id, j.driver_id
    into chosen
  from public.driver_journeys j
  where j.status = 'open'
    and public.journey_matches(
      j.origin_city, j.destination_city, j.departs_after, j.departs_before,
      j.capacity_kg, parcel.origin_city, parcel.destination_city, parcel.weight
    )
    -- Never re-offer to someone who already saw this parcel.
    and not exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id and o.driver_id = j.driver_id
    )
  order by j.departs_after asc, (j.capacity_kg - coalesce(parcel.weight, 0)) asc, j.created_at asc
  limit 1;

  if chosen.id is null then
    return null;
  end if;

  insert into public.dispatch_offers (booking_id, journey_id, driver_id)
  values (booking_id, chosen.id, chosen.driver_id)
  returning id into offer_id;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'dispatch', 'parcel offered to a driver',
    -- Ids only. Dispatch runs without a signed-in actor, and an admin reading
    -- this log has no need for the recipient's address or phone.
    jsonb_build_object('booking', booking_id, 'journey', chosen.id),
    null
  );

  return offer_id;
end;
$$;

/**
 * A driver's answer.
 *
 * Accepting claims the parcel here rather than through the normal claim policy,
 * because the offer is the permission — checking it and the claim separately
 * would let a driver accept an offer that had already expired.
 */
create or replace function public.respond_to_offer(offer_id uuid, accept boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  offer record;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select o.id, o.booking_id, o.driver_id, o.status, o.expires_at
    into offer
  from public.dispatch_offers o
  where o.id = offer_id;

  if offer.id is null then
    raise exception 'No such offer';
  end if;
  if offer.driver_id <> actor then
    raise exception 'That offer is not yours';
  end if;
  if offer.status <> 'offered' then
    raise exception 'You have already answered that offer';
  end if;

  if offer.expires_at <= now() then
    update public.dispatch_offers
       set status = 'expired', responded_at = now()
     where id = offer_id;
    /*
      Pass it on immediately rather than waiting for the sweeper.

      A driver opening a lapsed offer is the earliest moment anyone knows it
      lapsed, and the parcel should move on from that moment rather than from
      whenever a scheduled job next runs.
    */
    perform public.dispatch_booking(offer.booking_id);
    raise exception 'That offer expired. It has gone to another driver.';
  end if;

  if not accept then
    update public.dispatch_offers
       set status = 'declined', responded_at = now()
     where id = offer_id;

    insert into public.app_events (level, area, message, context, actor_id)
    values ('info', 'dispatch', 'driver declined an offer',
            jsonb_build_object('booking', offer.booking_id), actor);

    perform public.dispatch_booking(offer.booking_id);
    return 'declined';
  end if;

  if not public.is_approved_driver() then
    raise exception 'Your driver approval is not active';
  end if;

  /*
    Claim and settle together.

    `driver_id is null` inside the UPDATE is what makes this safe against a
    parcel claimed from the open board in the seconds since the offer was made:
    the update touches zero rows and the accept fails, rather than overwriting
    somebody else's claim.
  */
  update public.bookings b
     set driver_id = actor,
         driver = coalesce(
           (select p.full_name from public.profiles p where p.id = actor),
           'Driver'
         ),
         accepted_at = now(),
         status = 'Assigned'
   where b.id = offer.booking_id
     and b.driver_id is null
     and b.status = 'Booked';

  if not found then
    update public.dispatch_offers
       set status = 'expired', responded_at = now()
     where id = offer_id;
    raise exception 'That parcel has already been taken.';
  end if;

  update public.dispatch_offers
     set status = 'accepted', responded_at = now()
   where id = offer_id;

  insert into public.app_events (level, area, message, context, actor_id)
  values ('info', 'dispatch', 'driver accepted an offer',
          jsonb_build_object('booking', offer.booking_id), actor);

  return 'accepted';
end;
$$;

/**
 * Sweeps up offers nobody answered.
 *
 * Meant to run on a schedule — `select public.expire_dispatch_offers();` every
 * minute via pg_cron or an external scheduler. Without it a parcel whose driver
 * ignored the notification sits held until someone opens the app, which is the
 * one failure mode that strands a parcel silently.
 */
create or replace function public.expire_dispatch_offers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_booking uuid;
  swept integer := 0;
begin
  for expired_booking in
    update public.dispatch_offers
       set status = 'expired', responded_at = now()
     where status = 'offered' and expires_at <= now()
    returning booking_id
  loop
    swept := swept + 1;
    perform public.dispatch_booking(expired_booking);
  end loop;

  return swept;
end;
$$;

revoke all on function public.dispatch_booking(uuid) from public, anon, authenticated;
revoke all on function public.expire_dispatch_offers() from public, anon, authenticated;
revoke all on function public.respond_to_offer(uuid, boolean) from public, anon;
grant execute on function public.respond_to_offer(uuid, boolean) to authenticated;

/*
  `dispatch_booking` and `expire_dispatch_offers` are deliberately not granted to
  `authenticated`. Dispatch is something the system does, not something a driver
  can trigger — a driver who could call the matcher could hammer it until a
  parcel rotated round to them.
*/

-- ---------------------------------------------------- dispatch on posting --

/**
 * Every new parcel is offered as soon as it exists.
 *
 * A trigger rather than a client call: the client could simply not make it, and
 * a parcel that skipped dispatch would sit on the board looking normal.
 */
create or replace function public.dispatch_new_booking()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.dispatch_booking(new.id);
  return new;
end;
$$;

drop trigger if exists bookings_dispatch_on_insert on public.bookings;
create trigger bookings_dispatch_on_insert
  after insert on public.bookings
  for each row execute function public.dispatch_new_booking();

/*
  ⚠ Not built, and worth knowing before this goes anywhere near real drivers:

    - No push notification. An offer held for five minutes is useless if the
      driver does not know it exists, and nothing in this app sends a push yet.
      `expo-notifications` is not installed. **Dispatch is not finished until
      this is done** — until then an offer only surfaces when the driver happens
      to open the app, and every offer will expire.
    - No re-dispatch when a journey is declared. A parcel that matched nobody at
      posting time is only retried when an offer expires. A driver declaring a
      route should sweep the unclaimed board for anything matching it.
    - The five-minute hold and the best-fit ranking are both guesses. Watch
      `app_events` area 'dispatch' before tuning either.
*/
