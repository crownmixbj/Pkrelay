# Email: why nothing was being sent

A runbook, written after a guarantor invitation sat in `email_outbox` with
`sent_at` null and nothing anywhere explaining it.

## The short version

Three things have to be true before a single email leaves this system. Two of
them were false, and the third made both invisible.

1. **`notify-events` has to be deployed.** It is not. The deployed functions are
   `notify-application`, `notify-offer`, `erase-auth-user`, `places-lookup`,
   `verify-identity`, `verify-liveness`. A post to a function that does not exist
   is a 404 that pg_net swallows without comment.
2. **The database has to know where to post and with what key.** Neither
   `private.app_settings` nor the `app.settings.*` GUCs carry them on production.
3. **A failure has to be visible.** Until migration 53 it was not. `dispatch_email`
   returned silently when unconfigured and swallowed every exception, so an
   unconfigured project and a working one produced identical rows.

Production evidence, before any of this was fixed: two outbox rows queued in
August, `attempts = 0`, `error` null. No delivery had ever been attempted, and
nothing recorded that.

## The trigger was never missing

`on_email_queued` is an `after insert` trigger on `email_outbox`, created by
`20250101000038_transactional_email.sql`, calling `dispatch_email()`, which posts
`{"outbox_id": "…"}` to `<edge_url>/notify-events`. It has been firing correctly
on every queued email since 38 shipped. Adding a second trigger would double every
send the moment the configuration is filled in.

## Two places to configure it, which is the trap

`20250101000005`, `19`, `20`, `24` and `50` all read rows from
`private.app_settings` named `edge_url` and `service_key`. 38 alone read the GUCs
`app.settings.functions_url` and `app.settings.service_role_key`, and documented
them only as two `alter database` statements in a comment.

So a project where push notifications work can still have email completely dead,
with nothing pointing at the difference. Migration 53 reads **both**, settings
table first, so whichever half of the fleet was configured which way now works.

## Finding out which of the three it is

`scripts/sql/email-health.sql` answers that in one row. Paste it into the SQL
editor of whichever project you are asking about — it is read-only, returns no
address, no key and no personal data, and probes everything with `to_regclass`
so it still answers on a database that is three migrations behind. The
`next_step` column names the first thing standing in the way.

## Turning it on

⚠ **Push migration 53 before setting anything.** 38's dispatcher reads only the
`app.settings.*` GUCs — it never looks at `private.app_settings`. On a database
still on 38, setting the table writes two rows that nothing reads and email stays
exactly as broken, with no error to say so. `scripts/sql/email-enable.sql` opens
with a guard that refuses to run in that order rather than letting you find out
the slow way.

Then run `scripts/sql/email-enable.sql` yourself — it carries the service role
key, which is why it is not a migration.

```sql
-- 1. where the functions are, and the key that gets past their gate.
insert into private.app_settings (key, value) values
  ('edge_url',    'https://<project-ref>.supabase.co/functions/v1'),
  ('service_key', '<service role key>')
on conflict (key) do update set value = excluded.value;
```

```bash
# 2. the function itself, and the secrets it sends with
supabase functions deploy notify-events
supabase secrets set RESEND_API_KEY="re_..."
supabase secrets set LOCI_APP_URL="https://app.yourdomain.com"
supabase secrets set LOCI_SUPPORT_EMAIL="support@yourdomain.com"

# LOCI_FROM_EMAIL is OPTIONAL. Mail comes from DEFAULT_FROM in
# _shared/email.ts — Package Relay <noreply@app.pkrelay.com> — unless this
# secret is set, in which case the secret wins. Set it only to send from
# somewhere else, e.g. an obviously-not-production address on staging.

# ⚠ On staging, also set these two or it will email real people:
supabase secrets set LOCI_ENVIRONMENT="staging"
supabase secrets set LOCI_STAGING_EMAIL="you@yourdomain.com"
```

`_shared/environment.ts` fails closed: on staging with no `LOCI_STAGING_EMAIL` it
abandons the send rather than falling back to the real recipient. That is
deliberate — sending nothing is a bug somebody reports, and sending a real driver
a real-looking approval generated from test rows is an incident.

## Checking it worked

```sql
-- anything the dispatcher could not do says so here
select created_at, level, message, context
  from public.app_events where area = 'email' order by created_at desc limit 20;

-- and the queue itself
select kind, count(*), count(*) filter (where sent_at is not null) as sent,
       count(*) filter (where error is not null) as errored, max(attempts)
  from public.email_outbox group by kind;
```

An `app_events` row saying *"email is not configured"* means step 1 is missing.
One saying *"pg_net is not enabled"* means the extension is off. One saying *"an
email could not be dispatched"* carries `SQLERRM` — never the key, deliberately.

## When the function is called and the row still does not move

Every decision `notify-events` makes is now one JSON line in its logs, tagged
with an 8-character request id. Open the function's logs in the dashboard and
look for `"stage"`:

| stage | what it means |
| --- | --- |
| `refused` | the caller was not the service role. `why` says which: `jwt-role:anon` means something is calling with the publishable key; `key-mismatch` means the key in `private.app_settings` is not a service key this deployment accepts |
| `unparseable-body` | something other than pg_net posted, or posted nothing |
| `no-such-row` | the id is real JSON but no such outbox row exists |
| `unreadable-row` | the REST read itself failed — the reason is written onto the row |
| `unconfigured` | `RESEND_API_KEY` is missing; also written onto the row. The sender cannot be missing — it defaults |
| `send-failed` | Resend refused; its answer is written onto the row |
| `write-back-refused` | **the email was sent and the row could not be marked.** The sweep will send it again in five minutes |
| `done` | sent and recorded |

⚠ **If you see `key-mismatch`, check which kind of key you stored.** The platform
injects `SUPABASE_SERVICE_ROLE_KEY` as the legacy JWT. If you pasted a newer
`sb_secret_…` key into `private.app_settings`, Supabase's own gateway may reject
it before the function runs at all — in which case pg_net gets a 401 and there is
no log line here to find. Store the JWT-format service role key.

## The sending domain

Mail comes from **`Package Relay <noreply@app.pkrelay.com>`** — `DEFAULT_FROM` in
`supabase/functions/_shared/email.ts`. It is a constant rather than a required
secret because it is not a secret and does not vary, and because an unset secret
used to mean a queued email was marked "LOCI_FROM_EMAIL is not set" and never
sent.

⚠ **`app.pkrelay.com` has to be verified in Resend before anything sends from
it.** Add the domain in the Resend dashboard and publish the DKIM and SPF records
it gives you. Until that resolves, every send comes back as `Resend 403: …`,
written onto the row — the one failure this default cannot prevent.

⚠ A set `LOCI_FROM_EMAIL` still wins. If mail is arriving from something else,
that secret is set:

```bash
supabase secrets list | grep LOCI_FROM_EMAIL
supabase secrets unset LOCI_FROM_EMAIL     # to fall back to the default
```

Note the app's own contact addresses in `src/constants/contact.ts` are still
`@pkrelay.ng` placeholders with `CONTACT_IS_PLACEHOLDER = true`, so a recipient
sees mail from `app.pkrelay.com` with support addresses on a different domain.
Worth reconciling before launch; not something to change quietly, because
`verify-about.ts` fails if that flag lies.

## Retries, and flushing a backlog

53 adds `sweep_unsent_emails()`, scheduled on pg_cron as `loci-unsent-emails`
every five minutes. It re-posts rows that are unsent, at least a minute old (so it
never races the trigger), under three attempts, and newer than three days.

To flush a backlog that built up while the project was misconfigured, widen the
window once by hand:

```sql
select public.sweep_unsent_emails(interval '60 days');
```

Re-posting is safe: `notify-events` returns early on any row that already has
`sent_at`, and the sweep selects only unsent rows.

## Still owed

- ~~Nothing writes `error`.~~ Fixed: every exit after the outbox id is known now
  writes either `sent_at` or a sentence into `error`.
- **`notify-push` is undeployed too.** Same shape of problem, same fix; the push
  sweeper in 50 will keep retrying into a 404 until it is deployed.
