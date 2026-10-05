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
