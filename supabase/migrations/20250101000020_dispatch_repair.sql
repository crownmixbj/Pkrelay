-- LOCI — a parcel stops being dispatchable after the first missed offer.
--
-- Run after 01–19. Re-runnable. Safe to run on a database that is already stuck.
--
-- ⚠ THIS IS A BUG FIX, AND THE BUG WAS MINE.
--
-- Two places disagreed about what "live offer" means:
--
--   dispatch_offers_one_live_per_booking   where status = 'offered'
--   dispatch_booking's guard               status = 'offered' and expires_at > now()
--
-- A partial index cannot call `now()` — it is not immutable — so the index has
-- no time component. That is fine only while something promptly moves lapsed
-- offers to 'expired'. Nothing did: `expire_dispatch_offers()` was written to be
-- run on a schedule and the schedule was left as a line in a comment.
--
-- So the moment an offer lapsed unanswered:
--
--   * dispatch_booking's guard let it through — the offer had expired
--   * the INSERT then hit the unique index, which still saw status='offered'
--   * the whole function raised, and the parcel was never offered again
--
-- The parcel sits on the open board looking normal. Nothing errors anywhere a
-- person would see. It simply stops being assigned, forever.
--
-- Three fixes: expire lazily so dispatch heals itself, tell a decline apart from
-- a lapse so a one-driver city still works, and actually schedule the sweep.

do $$
begin
  if to_regclass('public.dispatch_offers') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;
end
$$;

-- --------------------------------- 1. a lapse is not a refusal ------------

/*
  The old index refused a second offer to a driver on any grounds at all:

      unique (booking_id, driver_id)

  That is right for a decline — they said no, and rotating back is how a driver
  learns to ignore dispatch. It is wrong for an expiry, which means they never
  saw it: there is no push notification yet, so an unanswered offer is the
  *normal* outcome, not a refusal.

  With one approved driver the old rule retired a parcel permanently after the
  first miss. Which is exactly the state this database is in.
*/
drop index if exists public.dispatch_offers_once_per_driver;

create unique index if not exists dispatch_offers_no_repeat_decline
  on public.dispatch_offers (booking_id, driver_id)
  where status = 'declined';

/*
  Still at most one outstanding offer per parcel. Unchanged, and still the thing
  that stops two drivers being told the same parcel is theirs.
*/
create unique index if not exists dispatch_offers_one_live_per_booking
  on public.dispatch_offers (booking_id)
  where status = 'offered';

-- --------------------------------- 2. dispatch heals itself ---------------

/**
 * Offers a parcel to the best available journey.
 *
 * Replaces the version in 20250101000018_flash_mode.sql. Three changes, all about not
 * getting stuck:
 *
 *   1. Lapsed offers on this parcel are settled *first*, so the index and the
 *      guard can no longer disagree.
 *   2. A driver who let an offer lapse is tried again, but only after every
 *      driver who has never seen the parcel — the queue still moves outward
 *      before it comes back round.
 *   3. The insert cannot raise. A losing race returns null instead of aborting
 *      the caller, which for the insert trigger means a parcel still gets
 *      posted even if dispatch has a bad moment.
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

  if parcel.status <> 'Booked' or parcel.driver_id is not null then
    return null;
  end if;

  /*
    Settle anything that has already lapsed on this parcel.

    This is the fix. Before, a lapsed row kept `status = 'offered'` until a
    scheduled sweep that was never scheduled, and the unique index treated it as
    live — so the insert below raised and the parcel was stranded.

    Doing it here means dispatch repairs the parcel it is about to work on,
    every time, whatever else is or is not running.
  */
  update public.dispatch_offers
     set status = 'expired', responded_at = coalesce(responded_at, now())
   where dispatch_offers.booking_id = dispatch_booking.booking_id
     and status = 'offered'
     and expires_at <= now();

  -- Genuinely out with someone right now.
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
    /*
      Never back to somebody who said no.

      A decline is an answer. An expiry is not — see the index above.
    */
    and not exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id
        and o.driver_id = j.driver_id
        and o.status = 'declined'
    )
    /*
      And not back to somebody whose offer lapsed in the last few minutes.

      Without this, a parcel with one eligible driver would re-offer to them the
      instant it expired, in a loop, every time anything called dispatch. Ten
      minutes is long enough that the retry is a genuine second chance rather
      than a spin.
    */
    and not exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id
        and o.driver_id = j.driver_id
        and o.status = 'expired'
        and o.responded_at > now() - interval '10 minutes'
    )
  order by
    /*
      Anyone who has never seen this parcel comes first.

      Only once that pool is empty does it come back round to a driver who
      missed it — which is what makes a one-driver city work at all without
      letting a busy city recycle instead of spreading.
    */
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

  /*
    Cannot raise.

    `on conflict do nothing` covers the case where a concurrent call inserted a
    live offer between the guard above and this statement. Losing that race is
    fine — the parcel is with somebody. Aborting the transaction is not: this
    runs inside the insert trigger, so a raise here would stop a sender posting
    a parcel at all.
  */
  insert into public.dispatch_offers (booking_id, journey_id, driver_id)
  values (booking_id, chosen.id, chosen.driver_id)
  on conflict do nothing
  returning id into offer_id;

  if offer_id is null then
    return null;
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'dispatch', 'parcel offered to a driver',
    jsonb_build_object('booking', booking_id, 'journey', chosen.id),
    null
  );

  return offer_id;
end;
$$;

-- ------------------------------- 3. sweep on a schedule, not in a comment --

/**
 * Re-offers everything that is unassigned and not currently out with anyone.
 *
 * The safety net. `expire_dispatch_offers` handles parcels whose offer lapsed;
 * this handles the ones that were never matched — posted when nobody was
 * available, and then somebody came online. Between them nothing sits forever.
 */
create or replace function public.redispatch_unassigned(max_parcels integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  parcel_id uuid;
  offered integer := 0;
begin
  for parcel_id in
    select b.id
    from public.bookings b
    where b.status = 'Booked'
      and b.driver_id is null
      and not exists (
        select 1 from public.dispatch_offers o
        where o.booking_id = b.id and o.status = 'offered' and o.expires_at > now()
      )
    -- Oldest first: the parcel that has waited longest gets the next driver.
    order by b.created_at asc
    limit greatest(1, least(coalesce(max_parcels, 200), 1000))
  loop
    if public.dispatch_booking(parcel_id) is not null then
      offered := offered + 1;
    end if;
  end loop;

  return offered;
end;
$$;

revoke all on function public.redispatch_unassigned(integer) from public, anon, authenticated;

/*
  The schedule itself.

  Written here rather than left as an instruction, because leaving it as an
  instruction is precisely what caused this bug. If pg_cron is not enabled on
  the project the DO block below says so and the rest of the file still applies
  — dispatch now heals itself on every call regardless, so cron is a safety net
  rather than the mechanism.

  Enable it once, in the dashboard: Database → Extensions → pg_cron.
*/
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    -- Re-scheduling is idempotent: unschedule first, ignoring "not found".
    begin
      perform cron.unschedule('loci-expire-offers');
    exception when others then null;
    end;
    begin
      perform cron.unschedule('loci-redispatch');
    exception when others then null;
    end;
    begin
      perform cron.unschedule('loci-apply-payout-changes');
    exception when others then null;
    end;

    perform cron.schedule(
      'loci-expire-offers', '* * * * *',
      $cron$select public.expire_dispatch_offers();$cron$
    );
    perform cron.schedule(
      'loci-redispatch', '*/5 * * * *',
      $cron$select public.redispatch_unassigned();$cron$
    );
    -- Scheduled here too. 20250101000016_driver_identity.sql documented it and stopped.
    perform cron.schedule(
      'loci-apply-payout-changes', '0 * * * *',
      $cron$select public.apply_due_payout_changes();$cron$
    );

    raise notice 'pg_cron: offer expiry every minute, re-dispatch every 5, payouts hourly.';
  else
    raise warning
      'pg_cron is not available. Dispatch still heals itself on every call, but nothing will re-offer a parcel while the app is idle. Enable pg_cron in Database -> Extensions and re-run this file.';
  end if;
end
$$;

-- ------------------------------------------------------------ the rescue ---

/*
  Unsticks whatever is already stranded.

  Runs now, once, as part of this migration — a fix that requires somebody to
  remember to run a second script is a fix that half-happens.
*/
do $$
declare
  swept integer;
  offered integer;
begin
  update public.dispatch_offers
     set status = 'expired', responded_at = coalesce(responded_at, now())
   where status = 'offered' and expires_at <= now();

  get diagnostics swept = row_count;

  select public.redispatch_unassigned() into offered;

  raise notice 'Repaired % stale offer(s); re-offered % parcel(s).', swept, offered;
end
$$;

/*
  ⚠ What this still does not fix:

    - There is no push notification, so an offer reaches a driver only if the
      app is open. That is why offers lapse in the first place, and it is why
      the retry rules above had to become forgiving. `20250101000019_push.sql` and the
      `notify-offer` function are written; they need `edge_url` and
      `service_key` in `private.app_settings` and a deploy before any of it
      leaves the database.
    - A driver who never opens the app still collects and lapses offers in
      rotation. Nothing yet notices a driver who is nominally available and
      never responds.
*/
