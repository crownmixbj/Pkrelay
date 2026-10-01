-- ============================================================================
-- email-health.sql — why an email has not been sent, answered in one row
-- ============================================================================
--
-- Paste into the SQL editor of whichever project you are asking about. Read-only:
-- it writes nothing and returns no address, no key and no personal data.
--
-- ⚠ It runs on a database that has none of the newer migrations.
--
--   Everything is probed with `to_regclass` / `to_regprocedure` rather than
--   selected from, so this file answers on a project that is three migrations
--   behind rather than failing with "relation does not exist" — which is the
--   state you most need an answer in.
--
-- `next_step` names the FIRST thing standing in the way. Fix it, run this again.

with probe as (
  select
    to_regclass('public.guarantor_invitations') is not null            as m39_guarantor,
    to_regprocedure('public.driver_application_guarantor_optional()')
      is not null                                                      as m52_nullable,
    to_regprocedure('public.email_dispatch_config()') is not null      as m53_dispatch,

    (select count(*) from pg_extension where extname = 'pg_net') > 0   as pg_net_on,
    (select count(*) from pg_extension where extname = 'pg_cron') > 0  as pg_cron_on,

    /* Presence only. The key itself must never leave the database. */
    (select count(*) from private.app_settings
      where key = 'edge_url' and btrim(coalesce(value, '')) <> '') > 0 as table_url_set,
    (select count(*) from private.app_settings
      where key = 'service_key' and btrim(coalesce(value, '')) <> '') > 0 as table_key_set,

    /* 38's own mechanism, which is configured separately and often is not. */
    coalesce(nullif(current_setting('app.settings.functions_url', true), ''), '') <> ''
                                                                       as guc_url_set,
    coalesce(nullif(current_setting('app.settings.service_role_key', true), ''), '') <> ''
                                                                       as guc_key_set,

    (select count(*) from public.email_outbox)                         as queued_total,
    (select count(*) from public.email_outbox where sent_at is not null) as sent_total,
    (select count(*) from public.email_outbox where error is not null)   as errored_total,
    (select count(*) from public.email_outbox where sent_at is null)     as unsent_total,
    (select max(attempts) from public.email_outbox)                      as max_attempts,
    (select min(created_at) from public.email_outbox where sent_at is null)
                                                                         as oldest_unsent
),
state as (
  select *,
    (table_url_set and table_key_set) or (guc_url_set and guc_key_set) as configured
  from probe
)
select
  m39_guarantor, m52_nullable, m53_dispatch,
  pg_net_on, pg_cron_on,
  table_url_set, table_key_set, guc_url_set, guc_key_set,
  queued_total, sent_total, errored_total, unsent_total, max_attempts, oldest_unsent,
  case
    when not m39_guarantor then
      'Migration 39 is not applied — no guarantor is ever invited. Run supabase db push.'
    when not pg_net_on then
      'pg_net is not enabled. Database -> Extensions -> pg_net, then re-run this.'
    when not configured then
      'The database does not know where to post. Run scripts/sql/email-enable.sql.'
    when queued_total = 0 then
      'Nothing has ever been queued. The business trigger did not fire — check that the application carries a guarantor email.'
    when sent_total = 0 and coalesce(max_attempts, 0) = 0 then
      'Configured, but no request has ever been made. Deploy notify-events, then run select public.sweep_unsent_emails(interval ''60 days'');'
    when sent_total = 0 and coalesce(max_attempts, 0) > 0 then
      'Requests are being made and nothing is being marked sent. notify-events is deployed but failing — check its logs and RESEND_API_KEY.'
    when unsent_total > 0 then
      'Most mail is flowing; some rows are stuck. Check app_events where area = ''email''.'
    else
      'Healthy — everything queued has been sent.'
  end as next_step
from state;

-- ============================================================================
-- Guarantor invitations: is the thirty-day window actually in force?
-- ============================================================================
--
-- ⚠ An invitation minted before migration 54 keeps the window it was minted
--   with, and the email it produced keeps the date it stated. Neither is a bug:
--   `expires_at` is stamped once, and a sent email is a record of what somebody
--   was told. So "the expiry still says seven days" has three possible causes,
--   and this separates them.

select
  to_regprocedure('public.guarantor_invitation_window()') is not null as window_fn_exists,
  (select public.guarantor_invitation_window())                      as window_now,
  (select count(*) from public.guarantor_invitations
    where completed_at is null and expires_at > now())               as live_invitations,
  (select count(*) from public.guarantor_invitations
    where completed_at is null and expires_at > now()
      and expires_at - created_at < interval '29 days')              as still_on_the_old_window,
  case
    when (select public.guarantor_invitation_window()) < interval '29 days' then
      'Migration 54 is not applied — new invitations are still minted on the old window. Run supabase db push.'
    when (select count(*) from public.guarantor_invitations
           where completed_at is null and expires_at > now()
             and expires_at - created_at < interval '29 days') > 0 then
      'The window is right but some live invitations predate it. 54 extends them; if this persists, 54 ran before those rows existed — re-invite from the driver dashboard.'
    else
      'Every live invitation is on the thirty-day window. An email stating an older date was sent before the change and is a record of what was said, not a live value.'
  end as verdict;
