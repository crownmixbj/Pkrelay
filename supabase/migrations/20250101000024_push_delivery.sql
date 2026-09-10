-- LOCI — the notifier would have taken dispatch down with it.
--
-- Run after 01–23. Re-runnable.
--
-- ⚠ THIS IS A BUG FIX, AND THE BUG WAS MINE. IT WAS ARMED, NOT SLEEPING.
--
-- `20250101000019_push.sql` calls pg_net like this:
--
--     perform extensions.net.http_post(url := ..., headers := ..., body := ...);
--
-- That is not valid SQL. Postgres reads a three-part name as
-- `database.schema.object`, so it looks for a database called `extensions` and
-- refuses before it ever looks for the function:
--
--     ERROR: cross-database references are not implemented:
--            extensions.net.http_post
--
-- The reason nobody has seen it is the guard directly above the call: if
-- `edge_url` or `service_key` is unset the function returns early and never
-- reaches the broken line. Both are unset on this project today.
--
-- So the failure is armed by *configuring push*. The moment those two settings
-- land, every insert into `dispatch_offers` runs a trigger that raises. It is an
-- AFTER INSERT trigger, so the raise aborts the insert, which aborts
-- `dispatch_booking`, which is called from the booking insert trigger — and
-- posting a parcel starts failing. Turning notifications on would have stopped
-- dispatch completely.
--
-- Two fixes, because the wrong schema is only half of it:
--
--   1. Resolve pg_net at runtime. Supabase installs it in `net` on some
--      projects and `extensions` on others depending on when the project was
--      created, and hard-coding either is a coin flip.
--   2. Never let a notification failure roll back an offer. The comment in
--      20250101000019_push.sql already claimed this — "a slow or dead notifier must not
--      roll back the offer" — and the code did not do it. An exception block
--      makes the claim true.

do $$
begin
  if to_regclass('public.push_tokens') is null then
    raise exception 'Run 20250101000019_push.sql first.';
  end if;
end
$$;

-- --------------------------------------------------- where does pg_net live --

/**
 * The fully-qualified name of pg_net's http_post, or null if it is not enabled.
 *
 * Looked up rather than assumed. `net.http_post` and `extensions.http_post` are
 * both real on real Supabase projects; which one you get depends on when the
 * project was created and whether pg_net was moved. A migration that guesses is
 * a migration that works on half the fleet.
 *
 * Returns null when pg_net is absent, which is a legitimate state — dispatch
 * works without notifications, and always has.
 */
create or replace function private.pg_net_post_fn()
returns text
language sql
stable
set search_path = ''
as $$
  select n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where p.proname = 'http_post'
    and n.nspname in ('net', 'extensions', 'public')
  order by array_position(array['net', 'extensions', 'public'], n.nspname)
  limit 1;
$$;

-- ------------------------------------------------------------ the notifier --

/**
 * Calls the notifier the moment an offer row appears.
 *
 * Replaces the version in 20250101000019_push.sql. Same intent, three differences:
 *
 *   1. pg_net is resolved through `private.pg_net_post_fn()` and called with
 *      EXECUTE, so the schema is whatever this database actually has.
 *   2. The whole send is wrapped in an exception block. A notifier that is
 *      missing, slow, misconfigured or broken now costs a notification and
 *      nothing else.
 *   3. A failure is recorded in `app_events` instead of vanishing. Silence was
 *      how the last three of these went unnoticed for weeks.
 *
 * Still a trigger rather than something the matcher does inline, because
 * `dispatch_booking` is called from four places — the booking insert, the
 * expiry sweeper, a decline, and a flash shift starting — and every one of them
 * should notify. Hanging it off the row means none of them can forget.
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
  post_fn text;
begin
  select value into edge_url from private.app_settings where key = 'edge_url';
  select value into service_key from private.app_settings where key = 'service_key';

  /*
    Unconfigured is silent, not an error.

    Every deployment that has not set these — including the preview builds
    testers are using — must still be able to dispatch. The offer exists either
    way; only the notification is missing, which is exactly the state the app
    was in before 20250101000019_push.sql.
  */
  if edge_url is null or service_key is null then
    return new;
  end if;

  post_fn := private.pg_net_post_fn();

  if post_fn is null then
    insert into public.app_events (level, area, message, context)
    values (
      'warning', 'push', 'pg_net is not enabled, so no offer notification was sent',
      jsonb_build_object('offer', new.id)
    );
    return new;
  end if;

  /*
    ⚠ The exception block is the point of this file.

      Everything below is a network call hanging off an AFTER INSERT trigger on
      `dispatch_offers`. Without this block, anything that raises in here — a
      bad schema name, a revoked grant, pg_net rejecting a malformed header —
      aborts the insert, and because dispatch runs inside the booking insert
      trigger, a sender cannot post a parcel at all.

      A driver who was not told about an offer is a bad afternoon. A parcel that
      could not be posted is a broken product. These are not the same size of
      problem and the code should not treat them as if they were.
  */
  begin
    execute format(
      'select %s(url := $1, headers := $2, body := $3)',
      post_fn
    )
    using
      edge_url || '/notify-offer',
      jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      /*
        Ids only.

        The notification body is built server-side from a second query. Passing
        the recipient's name or address through here would put customer data in
        `net._http_response`, which is a table nobody thinks of as containing
        it.
      */
      jsonb_build_object('offer_id', new.id);
  exception when others then
    insert into public.app_events (level, area, message, context)
    values (
      'error', 'push', 'could not queue an offer notification',
      -- SQLERRM only. The service key is in scope here and must never be
      -- anywhere near a log line.
      jsonb_build_object('offer', new.id, 'error', sqlerrm, 'via', post_fn)
    );
  end;

  return new;
end;
$$;

drop trigger if exists dispatch_offers_notify on public.dispatch_offers;
create trigger dispatch_offers_notify
  after insert on public.dispatch_offers
  for each row execute function public.notify_dispatch_offer();

revoke all on function private.pg_net_post_fn() from public, anon, authenticated;

/*
  ⚠ No `release_push_token` here, deliberately.

    Signing out already works: `push_tokens` carries a "drop own push token"
    delete policy scoped to `auth.uid()`, and `unregisterPush` in
    `src/store/push.ts` uses it. I wrote an RPC to do the same thing before
    checking, which would have been a second way to do one job — and two ways to
    delete a row is how they end up disagreeing.
*/

/*
  ⚠ Still not solved, and worth knowing before you rely on this.

    - Expo returns a *ticket*, not a delivery. The real outcome arrives later on
      the receipts endpoint, which `notify-offer` does not poll. A driver whose
      phone silently rejected the push looks identical to one who ignored it.
    - Nothing detects a driver who is nominally available and never responds.
    - iOS will not deliver to a build without a push key on the EAS credentials.
      `eas credentials` has to show a Push Notification Key before any of this
      reaches an iPhone, and there is no way for the database to know it does
      not.
*/
