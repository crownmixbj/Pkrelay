-- ============================================================================
-- pg-net-call-repair.sql — a sender cannot post a parcel at all
-- ============================================================================
--
-- Paste the WHOLE file into the SQL editor of the project that is refusing
-- parcels. Safe to run twice. It changes no rows and deletes no data.
--
-- ⚠ Every statement is migration 24's and migration 67's, unmodified.
--
-- WHAT IS WRONG
--
--   Posting a parcel fails with:
--
--     cross-database references are not implemented: extensions.net.http_post (0A000)
--
--   `extensions.net.http_post` is THREE names, and Postgres reads three names as
--   database.schema.function. It refuses before looking anything up, so it fails
--   identically whether pg_net lives in `net`, in `extensions`, or is not
--   installed at all.
--
--   The call sits in `notify_dispatch_offer`, an AFTER INSERT trigger on
--   `dispatch_offers`. Dispatch runs inside the booking insert, so the raise
--   rolls the whole booking back and the sender is told the parcel could not be
--   posted. Migration 24 exists to fix precisely this and says so in its own
--   comments — it has not been applied here. Migration 19's broken version is
--   still the one running.
--
--   `notify_new_driver_application` carries the same three-part name. That one
--   has an exception handler, so instead of breaking anything it has silently
--   never sent a single new-application alert on any project. Migration 67 fixes
--   it, and is included because it is the same defect and the same line.
--
-- WHAT CHANGES
--
--   Both functions resolve pg_net through `private.pg_net_post_fn()` instead of
--   guessing, and call it through `execute format(...)` so the schema is
--   whatever this database actually has. Both wrap the call so a notification
--   can never again roll back the thing it is notifying about, and both record
--   a failure in `app_events` rather than in a server log nobody reads.
--
--   `private.pg_net_post_fn()` already exists on this database. Nothing here
--   creates or changes it.

-- ------------------------------------------------- preflight --

do $preflight$
begin
  if to_regprocedure('private.pg_net_post_fn()') is null then
    raise exception
      'private.pg_net_post_fn() is missing — apply migration 53 (or 24) first. Stopping.';
  end if;
  if to_regclass('public.app_events') is null then
    raise exception 'public.app_events is missing — migration 5 has not been applied. Stopping.';
  end if;
  if to_regclass('public.dispatch_offers') is null then
    raise exception 'public.dispatch_offers is missing — migration 15 has not been applied. Stopping.';
  end if;
end
$preflight$;


-- ####################################################################
-- from migration 20250101000024_push_delivery.sql
-- ####################################################################

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


-- ####################################################################
-- migration 20250101000067_application_alert_pg_net.sql
-- ####################################################################

-- ============================================================================
-- 67 — the new-application alert has never once fired
-- ============================================================================
--
-- Run after 24. Re-runnable.
--
-- ⚠ `extensions.net.http_post` is three names, and Postgres reads three names
--   as database.schema.function.
--
--     ERROR: cross-database references are not implemented:
--            extensions.net.http_post  (0A000)
--
--   It is refused before anything is looked up, so it fails identically whether
--   pg_net lives in `net`, in `extensions`, or is not installed at all. 24 was
--   written to fix exactly this in `notify_dispatch_offer` and explains it at
--   length. `notify_new_driver_application`, created in 5, was never revisited
--   and still carries it.
--
-- ⚠ Which is why nobody noticed for a year.
--
--   That function ends in `exception when others then raise warning`, so the
--   failure never reached a user and never reached `app_events` — it went to a
--   server log nobody reads. The Slack alert for a new driver application has
--   therefore never arrived on any project, and the symptom of that is silence,
--   which looks exactly like "no applications today".
--
--   The handler stays: an alert must never roll back an application. It just
--   stops being the reason this was invisible, because the call it is wrapping
--   now works, and the failure path writes to `app_events` where it can be read.
--
-- ⚠ The payload is unchanged, deliberately.
--
--   No NIN, no bank account, no guarantor details. A Slack channel is not an
--   appropriate home for identity documents, and this payload crosses a
--   third-party boundary.

create or replace function public.notify_new_driver_application()
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

  -- Not configured yet: applications must still succeed.
  if edge_url is null or service_key is null then
    return new;
  end if;

  /*
    Resolved rather than assumed, the way 24 does it. `net.http_post` and
    `extensions.http_post` are both real on real Supabase projects depending on
    when the project was created, and a hardcoded guess is what produced the
    three-part name above.
  */
  post_fn := private.pg_net_post_fn();

  if post_fn is null then
    insert into public.app_events (level, area, message, context)
    values (
      'warning', 'applications', 'pg_net is not enabled, so no application alert was sent',
      jsonb_build_object('reference', new.reference)
    );
    return new;
  end if;

  begin
    execute format(
      'select %s(url := $1, headers := $2, body := $3)',
      post_fn
    )
    using
      edge_url || '/notify-application',
      jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      jsonb_build_object(
        'reference', new.reference,
        'full_name', new.full_name,
        'phone', new.phone,
        'email', new.email,
        'state', new.state,
        'base_city', new.base_city,
        'vehicle_type', new.vehicle_type,
        'submitted_at', new.submitted_at
      );
  exception when others then
    /*
      ⚠ Still swallowed, now also recorded.

        An alert is a nice-to-have and must never roll back an application. But
        `raise warning` put this in a server log nobody reads, which is how a
        permanently broken call survived a year. `app_events` is where the email
        and push paths already report, so this reports there too.

        SQLERRM only. The service key is in scope here and must never be
        anywhere near a log line.
    */
    insert into public.app_events (level, area, message, context)
    values (
      'error', 'applications', 'could not queue the new-application alert',
      jsonb_build_object('reference', new.reference, 'error', sqlerrm, 'via', post_fn)
    );
  end;

  return new;
end;
$$;

drop trigger if exists on_driver_application_created on public.driver_applications;
create trigger on_driver_application_created
  after insert on public.driver_applications
  for each row execute function public.notify_new_driver_application();

-- -------------------------------------------------------------- the probe --

/**
 * Whether any trigger on this database still carries the three-part name.
 *
 * ⚠ Scans every function rather than naming the two we know about.
 *
 *   19 wrote it, 5 wrote it, 24 fixed one of them and this fixes the other. A
 *   probe that checked those two by name would pass on a database where a third
 *   one was hand-edited back in — which is precisely how production acquired
 *   its copy, and that one aborted every parcel.
 */
create or replace function public.pg_net_calls_are_resolvable()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and p.prokind = 'f'
       and pg_catalog.pg_get_functiondef(p.oid) like '%extensions.net.http_post%'
  );
$$;

revoke all on function public.pg_net_calls_are_resolvable() from public, anon;
grant execute on function public.pg_net_calls_are_resolvable() to authenticated, service_role;

notify pgrst, 'reload schema';

-- ####################################################################
-- the check
-- ####################################################################

/*
  Every column must be true. `no_three_part_names` scans every function in
  `public` and `private`, so it also catches a third copy nobody knew about.
*/
with probe as (
  select
    coalesce(public.pg_net_calls_are_resolvable(), false)                         as no_three_part_names,
    (select pg_get_functiondef(p.oid) like '%private.pg_net_post_fn()%'
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'notify_dispatch_offer')         as offer_resolves,
    (select pg_get_functiondef(p.oid) like '%private.pg_net_post_fn()%'
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'notify_new_driver_application') as application_resolves,
    exists (select 1 from pg_trigger
             where tgrelid = 'public.dispatch_offers'::regclass
               and tgname = 'dispatch_offers_notify' and not tgisinternal)        as offer_trigger,
    exists (select 1 from pg_trigger
             where tgrelid = 'public.driver_applications'::regclass
               and tgname = 'on_driver_application_created' and not tgisinternal) as application_trigger,
    /*
      Looked up inline rather than by calling `private.pg_net_post_fn()`, which
      not every role may execute — a check that errors on a permission is a check
      that tells you nothing about the thing you came to verify.
    */
    (select n.nspname || '.' || p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'http_post' and n.nspname in ('net','extensions','public')
      order by array_position(array['net','extensions','public'], n.nspname)
      limit 1)                                                                    as resolves_to
)
select *,
  case
    when not offer_resolves       then 'notify_dispatch_offer still hardcodes the schema — parcels will still fail.'
    when not application_resolves then 'notify_new_driver_application still hardcodes the schema.'
    when not no_three_part_names  then 'Some other function still contains extensions.net.http_post. Find it before calling this done.'
    when not offer_trigger        then 'The dispatch_offers_notify trigger is missing — drivers will not be told about offers.'
    when not application_trigger  then 'The on_driver_application_created trigger is missing.'
    when resolves_to is null      then 'pg_net is not installed, so nothing can be posted. Run: create extension pg_net;'
    else 'Clear — a sender can post a parcel again, and both notifications resolve pg_net properly.'
  end as next_step
from probe;
