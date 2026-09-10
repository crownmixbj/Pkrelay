# Turning on push notifications

Everything below is written and tested. None of it is live. This is the order to
switch it on, and what breaks if you skip a step.

Nothing here is destructive except step 5, which replaces a broken trigger.

---

## 0. Run migration 24 first, before anything else

```
supabase/migrations/20250101000024_push_delivery.sql
```

**Do not set `edge_url` before running this.** `20250101000019_push.sql` shipped a call to
`extensions.net.http_post`, which Postgres rejects as a cross-database
reference. The guard above it returns early whenever `edge_url` is unset, so the
line has never run — the bug is armed by configuring push, not by writing it.

If you set `edge_url` on the current trigger, every insert into `dispatch_offers`
raises. It is an `AFTER INSERT` trigger, so the raise aborts the insert, which
aborts `dispatch_booking`, which runs inside the booking insert trigger. Posting
a parcel would start failing.

Migration 24 resolves pg_net at runtime and wraps the send so a notification
failure can never take an offer with it.

---

## 1. Enable pg_net

Dashboard → Database → Extensions → enable **pg_net**.

Check it landed:

```sql
select private.pg_net_post_fn();
```

`net.http_post` or `extensions.http_post` is fine — the trigger handles either.
`null` means pg_net is not enabled, and offers will dispatch with a `warn` in
`app_events` and no notification.

---

## 2. Deploy the function

```bash
supabase functions deploy notify-offer
```

It needs no secret of its own. Expo's push API is unauthenticated — the device
token *is* the credential — which is why nothing in `notify-offer` reads an API
key.

---

## 3. Tell the database where the function is

```sql
insert into private.app_settings (key, value) values
  ('edge_url', 'https://<project-ref>.functions.supabase.co'),
  ('service_key', '<service role key>')
on conflict (key) do update set value = excluded.value;
```

`<project-ref>` is the subdomain in your dashboard URL. **No trailing slash** —
the trigger appends `/notify-offer`.

The service role key is in Settings → API. It is the key that can read every
row in the database; `private.app_settings` is not readable by any client role,
which is why it lives there rather than in a public table.

---

## 4. iOS only: a push key on the build

```bash
eas credentials
```

Under iOS, there must be a **Push Notification Key**. Without one Apple accepts
the push and delivers nothing, and there is no way for the database or the
function to know — Expo returns a valid ticket either way.

Time Sensitive notifications also need the capability on the build. Without it
Apple downgrades the interruption level rather than rejecting the push, so the
failure mode is a notification that waits behind Focus rather than none.

---

## 5. Rebuild the app

There is no EAS Update on this project, so every JS change needs a new binary:

```bash
eas build --profile preview --platform all
```

The token registration at sign-in, the offer card on Assigned Trip, and the
15-minute cooldown copy are all in JS. A tester on the current build has none of
them.

---

## Checking it worked

**Did a token get stored?** After an approved driver signs in on a real device:

```sql
select user_id, platform, last_seen_at from public.push_tokens;
```

Empty means registration failed. Order to check: is it a physical device (no
tokens on simulators or web), was the permission granted, and does
`app.json` still carry `extra.eas.projectId`.

**Did the trigger fire?**

```sql
select created_at, level, message, context
from public.app_events
where area = 'push'
order by created_at desc
limit 20;
```

Silence here is good — the trigger only writes on failure.

**Did pg_net actually send it?**

```sql
select created, status_code, content_type
from net._http_response
order by created desc
limit 10;
```

`200` is Expo accepting the batch. Note this is the *ticket*, not delivery.

---

## What is still not solved

- **Delivery is not confirmed.** Expo returns a ticket immediately and the real
  outcome lands later on a receipts endpoint that `notify-offer` does not poll.
  A driver whose phone silently rejected the push is indistinguishable from one
  who ignored it.
- **A flash shift does not end when the driver closes the app.** Capped at 12
  hours; nothing detects absence.
- **Nothing notices a driver who is nominally available and never responds.**
  With the 15-minute cooldown they will keep collecting and lapsing offers in
  rotation.
