-- ============================================================================
-- 20250101000053_email_dispatch_repair.sql — why no email has ever been sent
-- ============================================================================
--
-- ⚠ The trigger this file repairs is not missing. It has been there since 38,
--   firing correctly on every queued email, and doing nothing.
--
--   `on_email_queued` is an AFTER INSERT trigger on `email_outbox` calling
--   `dispatch_email()`, which posts the row's id to `notify-events`. It works.
--   What it does when it cannot work is the problem:
--
--     if endpoint is null or service_key is null then
--       return new;
--     end if;
--     ...
--     exception when others then
--       return new;
--
--   Two silent exits. A project with no configuration, no pg_net, a wrong
--   schema name or a revoked grant behaves *identically* to one that is working
--   — the row appears, `sent_at` stays null, and there is nothing anywhere
--   saying why. On production today: two rows queued in August, `attempts = 0`,
--   `error` null, and no record of a single delivery attempt ever being made.
--
-- ⚠ And there are two different places to configure it, which is the trap.
--
--   05, 19, 20, 24 and 50 all read `private.app_settings` rows named `edge_url`
--   and `service_key`. 38 alone invented a second mechanism — the GUCs
--   `app.settings.functions_url` and `app.settings.service_role_key` — and
--   documented them in a comment as two `alter database` statements for
--   somebody to run by hand. So configuring the push notifier correctly leaves
--   email dead, and neither the app nor the database says so.
--
--   This file reads both, `private.app_settings` first. Whichever half of the
--   fleet was configured which way now works, and 38's comment stops being a
--   footgun for the next person who sets one and not the other.
--
-- ⚠ What this migration does NOT do: make email start working.
--
--   Two things have to be true besides, and neither is SQL:
--
--     1. `edge_url` and `service_key` exist in `private.app_settings`.
--     2. `notify-events` is deployed. It is not, on either project — the
--        deployed list is notify-application, notify-offer, erase-auth-user,
--        places-lookup, verify-identity, verify-liveness. A post to a function
--        that does not exist is a 404 that pg_net swallows.
--
--   See `docs/EMAIL.md`. What this file buys is that the *next* failure says so
--   out loud instead of looking exactly like success.

-- ------------------------------------------------------------- the config --

/**
 * Where the edge functions live and the key that gets past their gate.
 *
 * ⚠ Both sources, in a fixed order, because the project has two.
 *
 *   `private.app_settings` is what everything except 38 uses, so it wins. The
 *   GUCs are read as a fallback rather than dropped: a database where somebody
 *   followed 38's comment is a database that is configured, and this migration
 *   must not un-configure it.
 *
 * Returns nulls when neither is set, which every caller treats as "not
 * configured" rather than as an error.
 */
create or replace function public.email_dispatch_config()
returns table (edge_url text, service_key text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  /*
   * ⚠ Not named `key`. `private.app_settings` has a column called `key`, and a
   *   plpgsql variable that shadows a column in its own query is an "ambiguous
   *   column reference" at call time — it passes `create function`, passes
   *   `db push`, and fails on the first email anybody queues.
   */
  found_url text;
  found_key text;
begin
  select a.value into found_url from private.app_settings a where a.key = 'edge_url';
  select a.value into found_key from private.app_settings a where a.key = 'service_key';

  /* 38's spelling, kept working. */
  found_url := coalesce(found_url, public.email_setting('app.settings.functions_url'));
  found_key := coalesce(found_key, public.email_setting('app.settings.service_role_key'));

  return query
    select nullif(btrim(coalesce(found_url, '')), ''), nullif(btrim(coalesce(found_key, '')), '');
end;
$$;

/**
 * Records why an email could not be dispatched, at most once an hour per reason.
 *
 * ⚠ Throttled, because the alternative is a log nobody can read.
 *
 *   An unconfigured project queues an email on every driver decision, every
 *   verification and every parcel status change. One `app_events` row per email
 *   would bury the one thing worth seeing under thousands of copies of itself
 *   within a day — and the whole point of this file is that somebody can find
 *   out what is wrong by looking.
 */
create or replace function private.note_email_failure(p_message text, p_context jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.app_events
     where area = 'email'
       and message = p_message
       and created_at > now() - interval '1 hour'
  ) then
    return;
  end if;

  insert into public.app_events (level, area, message, context)
  values ('warning', 'email', p_message, coalesce(p_context, '{}'::jsonb));
end;
$$;

-- ----------------------------------------------------------- the dispatch --

/**
 * Posts one outbox row to `notify-events`.
 *
 * Replaces 38's version. Same trigger, same contract — an id and nothing else,
 * for the reasons that function's own header gives — and three differences,
 * each one a lesson 24 already learned for push notifications and 38 did not
 * inherit:
 *
 *   1. pg_net is resolved through `private.pg_net_post_fn()` rather than
 *      hardcoded as `net.http_post`. Both `net` and `extensions` are real
 *      schemas on real Supabase projects depending on when the project was
 *      created; 19 hardcoded it, 24 exists because of that, and 38 hardcoded it
 *      again.
 *   2. Every path that does not send says so in `app_events`. Silence is how
 *      this went unnoticed from 38 until somebody sat watching a guarantor
 *      invitation that was never going to arrive.
 *   3. `attempts` is incremented when a request is actually made, so the column
 *      38 created means something and the sweeper below can stop trying.
 *
 * ⚠ Still cannot fail the transaction that queued the email.
 *
 *   This runs inside the insert that recorded a driver's approval or a parcel's
 *   delivery. A mail setting must never roll one of those back, so the
 *   exception block stays exactly as wide as it was — it just stopped being
 *   silent.
 */
create or replace function public.dispatch_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  config record;
  post_fn text;
begin
  select * into config from public.email_dispatch_config();

  if config.edge_url is null or config.service_key is null then
    perform private.note_email_failure(
      'email is not configured, so nothing is being sent',
      jsonb_build_object(
        'fix', 'insert edge_url and service_key into private.app_settings',
        'queued_kind', new.kind
      )
    );
    return new;
  end if;

  post_fn := private.pg_net_post_fn();

  if post_fn is null then
    perform private.note_email_failure(
      'pg_net is not enabled, so no email can be dispatched',
      jsonb_build_object('fix', 'create extension pg_net', 'queued_kind', new.kind)
    );
    return new;
  end if;

  execute format('select %s(url := $1, headers := $2, body := $3)', post_fn)
  using
    config.edge_url || '/notify-events',
    jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || config.service_key
    ),
    /*
     * ⚠ The id, never the content. 38's own reasoning, unchanged: a rendered
     *   email in a pg_net body puts a recipient address and somebody's parcel
     *   into `net._http_response`, and makes this an endpoint that mails
     *   whatever it is handed.
     */
    jsonb_build_object('outbox_id', new.id);

  update public.email_outbox set attempts = attempts + 1 where id = new.id;

  return new;
exception
  when others then
    /*
     * SQLERRM only. The service key is in scope in this function and must never
     * reach a log line.
     */
    perform private.note_email_failure(
      'an email could not be dispatched',
      jsonb_build_object('error', sqlerrm, 'queued_kind', new.kind)
    );
    return new;
end;
$$;

/* The trigger itself is 38's and is unchanged; recreated so this file is re-runnable. */
drop trigger if exists on_email_queued on public.email_outbox;
create trigger on_email_queued
  after insert on public.email_outbox
  for each row execute function public.dispatch_email();

-- -------------------------------------------------------------- the sweep --

/**
 * Re-posts emails that are still unsent, and returns how many it retried.
 *
 * ⚠ The trigger fires once. That was the whole retry policy.
 *
 *   If the request fails — a cold function, a 500, a deploy in progress, a
 *   project that was misconfigured at the moment the row was written — nothing
 *   ever tried again and `sent_at` stayed null for ever. The row is the queue;
 *   until now nothing drained it.
 *
 * ⚠ Re-posting an already-sent row is safe, and that is the function's
 *   guarantee rather than this one's.
 *
 *   `notify-events` returns early on any row with `sent_at` set. The batch below
 *   selects only unsent rows anyway; between them, a double send needs two
 *   failures at once.
 *
 * `p_max_age` is a parameter so a project that was misconfigured for a month can
 * flush its backlog once — `select public.sweep_unsent_emails(interval '60 days')`
 * — without the scheduled run trawling the same dead rows every five minutes.
 */
create or replace function public.sweep_unsent_emails(
  p_max_age interval default interval '3 days'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  pending record;
  config record;
  post_fn text;
  retried integer := 0;
begin
  select * into config from public.email_dispatch_config();
  if config.edge_url is null or config.service_key is null then
    return 0;
  end if;

  post_fn := private.pg_net_post_fn();
  if post_fn is null then
    return 0;
  end if;

  for pending in
    select id from public.email_outbox
     where sent_at is null
       /*
        * ⚠ Three attempts, then it stops.
        *
        *   A row that has failed three times is failing for a reason a fourth
        *   request will not fix — a dead address, a suspended Resend account, a
        *   template that throws. It stays in the table as the evidence, and
        *   `error` says what happened.
        */
       and attempts < 3
       /* A minute of grace, so this never races the trigger's own request. */
       and created_at < now() - interval '1 minute'
       and created_at > now() - p_max_age
     order by created_at
     limit 100
  loop
    begin
      execute format('select %s(url := $1, headers := $2, body := $3)', post_fn)
      using
        config.edge_url || '/notify-events',
        jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || config.service_key
        ),
        jsonb_build_object('outbox_id', pending.id);

      update public.email_outbox set attempts = attempts + 1 where id = pending.id;
      retried := retried + 1;
    exception when others then
      /* One bad row must not stop the batch. */
      null;
    end;
  end loop;

  return retried;
end;
$$;

-- ------------------------------------------------------------ the schedule --

/*
 * ⚠ Written here rather than left as an instruction, for the reason 20 gives:
 *   leaving it as an instruction is precisely what caused the bug above.
 *
 * Five minutes, matching `loci-unsent-pushes`. An email that missed its trigger
 * is not urgent enough to poll every minute, and a person waiting on a
 * guarantor invitation will not notice five minutes.
 */
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    perform cron.unschedule('loci-unsent-emails')
      where exists (select 1 from cron.job where jobname = 'loci-unsent-emails');

    perform cron.schedule(
      'loci-unsent-emails', '*/5 * * * *',
      'select public.sweep_unsent_emails()'
    );

    raise notice 'pg_cron: unsent emails retried every 5 minutes.';
  else
    insert into public.app_events (level, area, message, context)
    values (
      'warning', 'email',
      'pg_cron is not available, so a failed email is never retried',
      jsonb_build_object('fix', 'enable pg_cron in Database -> Extensions and re-run 53')
    );
  end if;
end
$$;

-- ----------------------------------------------------------------- grants --

/*
 * ⚠ `email_dispatch_config` returns the service role key, so it is reachable by
 *   definer functions and nothing else. `anon` or `authenticated` holding this
 *   would be the whole database.
 */
revoke all on function public.email_dispatch_config() from public, anon, authenticated;
revoke all on function private.note_email_failure(text, jsonb) from public, anon, authenticated;
revoke all on function public.sweep_unsent_emails(interval) from public, anon, authenticated;
