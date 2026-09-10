-- LOCI — how long a driver has to answer, by trip type.
--
-- Run after 01–20. Re-runnable.
--
--   intrastate (flash)      5 minutes
--   interstate (scheduled) 10 minutes
--
-- The asymmetry is the point. A flash driver is holding the phone, waiting; five
-- minutes is generous and a longer hold just parks a local parcel that somebody
-- else could be carrying. A scheduled driver is doing something else entirely —
-- driving, loading, eating — and ten minutes is the difference between an offer
-- they can answer and one that was never really theirs.
--
-- ⚠ The window is decided by the *parcel*, not by the journey it matched.
--
--   Today they coincide: a flash journey only ever matches a local parcel. But
--   "how long does a driver get" is a property of the trip being offered, and
--   deriving it from the journey would silently change every hold if the
--   matching rules ever widen. The parcel is the thing the rule is about.

do $$
begin
  if to_regclass('public.dispatch_offers') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------ the windows --

/**
 * How long an offer is held.
 *
 * One function, so the number cannot be written in two places and drift. The
 * client mirrors it in `OFFER_HOLD_MINUTES` (`src/store/dispatch.ts`) and the
 * verification suite asserts the two agree.
 */
create or replace function public.offer_hold(is_local boolean)
returns interval language sql immutable set search_path = '' as $$
  select case when is_local then interval '5 minutes' else interval '10 minutes' end;
$$;

/*
  The column default becomes the *longer* window.

  Nothing but `dispatch_booking` inserts an offer, and it sets `expires_at`
  explicitly — so this is a fallback that should never fire. It is set to ten
  rather than five because if it ever does fire, holding a parcel slightly too
  long is recoverable and cutting a driver off early is not: they open the app
  to a trip that expired while they were reading the notification.
*/
alter table public.dispatch_offers
  alter column expires_at set default (now() + interval '10 minutes');

-- ------------------------------------------- dispatch sets the right window --

/**
 * Offers a parcel to the best available journey.
 *
 * Replaces the version in 20250101000020_dispatch_repair.sql. Two changes:
 *
 *   1. `expires_at` is set from the parcel's trip type rather than left to the
 *      column default.
 *   2. The cooldown before a lapsed offer may return to the same driver is now
 *      the hold length, rather than a flat ten minutes. A five-minute flash
 *      offer that could not come back for ten was waiting twice as long as it
 *      was ever held.
 *
 * Everything else — the lazy expiry that keeps a stale row from bricking the
 * parcel, the decline being permanent, untried drivers first, the insert that
 * cannot raise — is unchanged from 20250101000020_dispatch_repair.sql.
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
begin
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

  -- Settle anything already lapsed on this parcel, so the partial unique index
  -- and the guard below cannot disagree. See 20250101000020_dispatch_repair.sql.
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
      j.mode
    )
    -- A decline is an answer, and permanent.
    and not exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id
        and o.driver_id = j.driver_id
        and o.status = 'declined'
    )
    /*
      A lapse is not an answer, but it does not come straight back either.

      The cooldown is the hold length: long enough that the retry is a real
      second chance rather than the same offer bouncing, short enough that a
      one-driver city is not idle for twice the window it was holding.
    */
    and not exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id
        and o.driver_id = j.driver_id
        and o.status = 'expired'
        and o.responded_at > now() - hold
    )
  order by
    (exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id and o.driver_id = j.driver_id
    )) asc,
    j.departs_after asc,
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
    -- The window is logged, so a run of expiries can be read against the hold
    -- it was given rather than guessed at.
    jsonb_build_object(
      'booking', booking_id,
      'journey', chosen.id,
      'hold_minutes', extract(epoch from hold) / 60
    ),
    null
  );

  return offer_id;
end;
$$;

-- ---------------------------------------------------------- the rollover ---

/**
 * Marks lapsed offers expired and immediately re-offers each parcel.
 *
 * Replaces the version in 20250101000015_dispatch.sql. Same behaviour, written with a
 * data-modifying CTE.
 *
 * ⚠ Honest note: I could not run Postgres to check the original. plpgsql's
 *   `FOR ... IN <query>` documents a *query*, and an `UPDATE ... RETURNING`
 *   placed directly there is at best version-dependent. The CTE form below is
 *   unambiguously valid everywhere, so this removes the question rather than
 *   answering it.
 *
 * The re-dispatch inside the loop is what makes this a rollover rather than a
 * tidy-up: a parcel whose driver did not answer goes to the next eligible one
 * in the same pass, not on some later trigger.
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
    with lapsed as (
      update public.dispatch_offers
         set status = 'expired', responded_at = coalesce(responded_at, now())
       where status = 'offered'
         and expires_at <= now()
      returning booking_id
    )
    select booking_id from lapsed
  loop
    swept := swept + 1;
    /*
      Straight on to the next driver.

      `dispatch_booking` returns null when there is nobody eligible — that is a
      parcel waiting, not an error, and the sweep carries on with the rest.
    */
    perform public.dispatch_booking(expired_booking);
  end loop;

  return swept;
end;
$$;

revoke all on function public.expire_dispatch_offers() from public, anon, authenticated;
revoke all on function public.offer_hold(boolean) from public, anon;
grant execute on function public.offer_hold(boolean) to authenticated;

/*
  The minute-by-minute schedule from 20250101000020_dispatch_repair.sql already runs this.
  Re-asserted here so a database that took this file without that one still
  rolls offers over.
*/
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('loci-expire-offers');
    exception when others then null;
    end;

    perform cron.schedule(
      'loci-expire-offers', '* * * * *',
      $cron$select public.expire_dispatch_offers();$cron$
    );
    raise notice 'Offer rollover scheduled every minute.';
  else
    raise warning
      'pg_cron is not enabled, so nothing rolls an offer over while the app is idle. Dispatch still settles lapsed offers whenever it runs. Enable pg_cron in Database -> Extensions.';
  end if;
end
$$;

-- --------------------------------------------------- fix what is in flight --

/*
  Existing live offers keep whatever window they were given, except where that
  window is now too short.

  An interstate offer made under the old flat five-minute rule is extended to
  ten; nothing is ever shortened, because a driver watching a countdown should
  never see it jump backwards.
*/
update public.dispatch_offers o
   set expires_at = o.offered_at + public.offer_hold(false)
  from public.bookings b
 where b.id = o.booking_id
   and o.status = 'offered'
   and b.origin_city <> b.destination_city
   and o.expires_at < o.offered_at + public.offer_hold(false);

do $$
declare
  swept integer;
begin
  select public.expire_dispatch_offers() into swept;
  raise notice 'Rolled over % lapsed offer(s).', swept;
end
$$;
