-- ============================================================================
-- email-enable.sql — tell the database where to post, and flush the backlog
-- ============================================================================
--
-- ⚠ Run this yourself, in the SQL editor. It carries the service role key,
--   which is why it is not a migration: a repository is not a secret store.
--
-- Replace both placeholders, run, and read the last result.

-- --------------------------------------------------------- 0. order check --

/*
 * ⚠ Migration 53 has to be pushed BEFORE this file, and the order is not
 *   cosmetic — it is the difference between fixing it and appearing not to.
 *
 *   38's dispatcher reads only the GUCs `app.settings.*`. It does not look at
 *   `private.app_settings` at all. So on a database that is still on 38, the
 *   insert below writes two rows that nothing reads, the sweep in step 2 does
 *   not exist, and email stays exactly as broken as it was — with no error to
 *   suggest you did anything wrong.
 *
 *   53 is what makes the settings table the source of truth for email, the way
 *   it already is for push and Slack. This block refuses to let you find that
 *   out the slow way.
 */
do $$
begin
  if to_regprocedure('public.email_dispatch_config()') is null then
    raise exception
      'Migration 53 is not applied on this database. Run `supabase db push` first — until then this file writes settings that nothing reads.';
  end if;
end
$$;

-- ------------------------------------------------------------- 1. settings --

/*
 * ⚠ The settings TABLE, not the GUCs.
 *
 *   38 read `app.settings.*` and every other notifier reads these rows. From 53
 *   the dispatcher reads the table first and falls back to the GUCs, so this is
 *   the one place worth setting — and setting it makes push, Slack and email
 *   agree for the first time.
 */
insert into private.app_settings (key, value) values
  /*
   * Staging. Production is https://ymfdnzeonkhvzncqcezo.supabase.co/functions/v1
   * — neither ref is a secret; both are already in CLAUDE.md. The key below is.
   */
  ('edge_url',    'https://ublqzvuzbyodjstzjvja.supabase.co/functions/v1'),
  ('service_key', 'PASTE_SERVICE_ROLE_KEY_HERE')
on conflict (key) do update set value = excluded.value;

-- -------------------------------------------------------------- 2. the flush --

/*
 * Re-posts everything still unsent, including rows queued while the project was
 * misconfigured. Safe to run twice: `notify-events` returns early on any row
 * that already has `sent_at`, and this selects only rows that do not.
 *
 * ⚠ Needs migration 53. On a database without it, re-queue instead by touching
 *   the row — or just push 53, which is the shorter path.
 */
select public.sweep_unsent_emails(interval '60 days') as retried;

-- ------------------------------------------------------------- 3. the check --

/* Give it a few seconds, then: */
select kind,
       count(*)                                        as queued,
       count(*) filter (where sent_at is not null)      as sent,
       count(*) filter (where error is not null)        as errored,
       max(attempts)                                    as attempts
  from public.email_outbox
 group by kind
 order by kind;

/* And whatever the dispatcher could not do: */
select created_at, level, message, context
  from public.app_events
 where area = 'email'
 order by created_at desc
 limit 20;
