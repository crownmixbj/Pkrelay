-- LOCI — telling a driver an offer exists.
--
-- Run after 01–18. Re-runnable.
--
-- This is the piece every previous dispatch file called out as missing. An
-- offer is held for five minutes; without a push notification it reaches a
-- driver only if the app happens to be open, so in practice most offers expire.
-- Flash makes it worse — that mode assumes somebody is reachable *now*.
--
-- Two other things happen here, both about the same theme of "the queue notices
-- immediately":
--
--   * a scheduled route sweeps the waiting parcels when it is declared, the way
--     a flash shift already did
--   * ending a flash shift or pausing a route takes effect on the next match,
--     because the matcher reads `status = 'open'` live — no cache to bust

do $$
begin
  if to_regclass('public.dispatch_offers') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;
end
$$;

create extension if not exists pg_net with schema extensions;

-- --------------------------------------------------------------- tokens ----

create table if not exists public.push_tokens (
  /*
    The Expo push token is the primary key, not a surrogate id.

    A token identifies a device installation. Two rows for the same token would
    mean two notifications on one phone, and the natural key makes that
    impossible rather than merely unlikely.
  */
  token text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text check (platform in ('ios', 'android', 'web')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

/*
  A driver owns their own tokens and nobody else's.

  Reading another account's tokens would be enough to send them notifications
  through the Expo API, which needs no secret — the token *is* the credential.
  That is why this table is not readable across accounts even by an admin.
*/
drop policy if exists "own push tokens" on public.push_tokens;
create policy "own push tokens"
  on public.push_tokens for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "register own push token" on public.push_tokens;
create policy "register own push token"
  on public.push_tokens for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "refresh own push token" on public.push_tokens;
create policy "refresh own push token"
  on public.push_tokens for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "drop own push token" on public.push_tokens;
create policy "drop own push token"
  on public.push_tokens for delete
  to authenticated
  using (user_id = (select auth.uid()));

/**
 * Claims a token for the calling account.
 *
 * `on conflict` moves the token rather than failing, which is the case that
 * actually happens: two drivers sharing a phone, or one signing out and another
 * signing in. The token follows the person who is signed in now, or the
 * previous driver keeps getting the new one's offers.
 */
create or replace function public.register_push_token(
  push_token text,
  device_platform text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  -- Expo tokens look like ExponentPushToken[xxxxx] or ExpoPushToken[xxxxx].
  if push_token !~ '^Ex(ponent)?PushToken\[[A-Za-z0-9_-]+\]$' then
    raise exception 'That is not an Expo push token';
  end if;

  insert into public.push_tokens (token, user_id, platform)
  values (push_token, actor, nullif(device_platform, ''))
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = coalesce(excluded.platform, public.push_tokens.platform),
        last_seen_at = now();
end;
$$;

revoke all on function public.register_push_token(text, text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;

-- ---------------------------------------------------- the trigger that fires --

/**
 * Calls the notifier the moment an offer row appears.
 *
 * A trigger rather than something the matcher does inline, because
 * `dispatch_booking` is called from four places — the insert trigger, the
 * expiry sweeper, a decline, and a flash shift starting — and every one of them
 * should notify. Hanging it off the row means none of them can forget.
 *
 * `pg_net` sends asynchronously. A slow or dead notifier must not roll back the
 * offer: a driver who was not told is a worse outcome than a parcel nobody was
 * offered, but a transaction that fails leaves neither.
 */
create or replace function public.notify_dispatch_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  edge_url text;
  service_key text;
begin
  select value into edge_url from private.app_settings where key = 'edge_url';
  select value into service_key from private.app_settings where key = 'service_key';

  /*
    Unconfigured is silent, not an error.

    Every deployment that has not set these — including the preview builds
    testers are using — must still be able to dispatch. The offer exists either
    way; only the notification is missing, which is exactly the state the app
    was in before this file.
  */
  if edge_url is null or service_key is null then
    return new;
  end if;

  perform extensions.net.http_post(
    url := edge_url || '/notify-offer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    /*
      Ids only.

      The notification body is built server-side from a second query. Passing
      the recipient's name or address through here would put customer data in
      `net._http_response`, which is a table nobody thinks of as containing it.
    */
    body := jsonb_build_object('offer_id', new.id)
  );

  return new;
end;
$$;

drop trigger if exists dispatch_offers_notify on public.dispatch_offers;
create trigger dispatch_offers_notify
  after insert on public.dispatch_offers
  for each row execute function public.notify_dispatch_offer();

/**
 * What the notifier is allowed to say.
 *
 * A fixed shape, like `admin_parcel_detail`. The notification tells a driver
 * *that* there is a trip and roughly what it is worth — never who it is from or
 * where they live. A push notification renders on a lock screen, which is the
 * least private surface in the whole system.
 */
create or replace function public.offer_push_payload(offer_id uuid)
returns table (
  driver_id uuid,
  booking_id uuid,
  origin_city text,
  destination_city text,
  weight numeric,
  fee numeric,
  is_local boolean,
  expires_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    o.driver_id,
    b.id,
    b.origin_city::text,
    b.destination_city::text,
    b.weight,
    b.estimated_fee,
    (b.origin_city = b.destination_city),
    o.expires_at
  from public.dispatch_offers o
  join public.bookings b on b.id = o.booking_id
  where o.id = offer_id
    and o.status = 'offered';
$$;

revoke all on function public.offer_push_payload(uuid) from public, anon, authenticated;
-- Service role only: this is the notifier's query, not a client's.

/**
 * The tokens to send to.
 *
 * Separate from the payload so the notifier cannot accidentally join a driver's
 * devices onto a parcel's details in one result set and log the pair.
 */
create or replace function public.push_tokens_for(target uuid)
returns table (token text)
language sql
security definer
set search_path = ''
as $$
  select t.token from public.push_tokens t where t.user_id = target;
$$;

revoke all on function public.push_tokens_for(uuid) from public, anon, authenticated;

/** Drops a token Expo has told us is dead. Called by the notifier. */
create or replace function public.forget_push_token(dead_token text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.push_tokens where token = dead_token;
$$;

revoke all on function public.forget_push_token(text) from public, anon, authenticated;

-- ------------------------------------ a declared route picks up the backlog --

/**
 * Sweeps unclaimed parcels matching a journey that was just declared.
 *
 * Flash already did this on going online. A scheduled route did not, so a driver
 * declaring "Ibadan → Lagos, leaving in three hours" was offered only parcels
 * posted *after* that moment — every parcel already sitting on that route was
 * invisible to them. That was listed as an outstanding gap in 20250101000015_dispatch.sql;
 * this closes it.
 */
create or replace function public.sweep_for_journey()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'open' then
    return new;
  end if;

  perform public.dispatch_booking(b.id)
  from public.bookings b
  where b.status = 'Booked'
    and b.driver_id is null
    and public.journey_matches(
      new.origin_city, new.destination_city, new.departs_after, new.departs_before,
      new.capacity_kg, b.origin_city::text, b.destination_city::text, b.weight, new.mode
    );

  return new;
end;
$$;

drop trigger if exists driver_journeys_sweep on public.driver_journeys;
create trigger driver_journeys_sweep
  after insert on public.driver_journeys
  for each row execute function public.sweep_for_journey();

/*
  ⚠ Deliberately insert-only.

    Firing on update too would mean a driver pausing and resuming a route
    re-swept every time, which is a cheap way to jump the queue — resume, take
    the sweep, pause, repeat. Resuming picks up new parcels from that moment, in
    the order everyone else gets them.
*/

/*
  ⚠ Still not solved by this file:

    - A flash shift does not end itself when the driver closes the app. The
      12-hour cap in 20250101000018_flash_mode.sql bounds it; nothing detects absence.
    - Notification delivery is not confirmed. Expo returns a ticket, and the
      real outcome arrives later on a receipts endpoint this does not poll. A
      driver whose phone rejected the push looks identical to one who ignored it.
*/
