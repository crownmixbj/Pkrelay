-- ============================================================================
-- 20250101000049_notifications.sql — the in-app inbox, and the spine push rides on
-- ============================================================================
--
-- Run after 01–48. Re-runnable.
--
-- ⚠ This table is deliberately shaped like `email_outbox`, not like a feed.
--
--   The tempting version is four columns — who, title, body, read — and a
--   client that renders them. That version cannot answer the only question
--   anyone ever asks when a driver says "I never got the job": *was the driver
--   told, and did it leave the building?* Today that answer lives in three
--   places (an Expo ticket nobody stores, `app_events` if something threw, and
--   the driver's memory), which is the same as not having it.
--
--   So a row here is both the bell-icon entry and the delivery record. One
--   insert lights up the badge and queues the push; `pushed_at`, `push_error`
--   and `push_attempts` say what happened to the second half.
--
-- ⚠ `unique (user_id, kind, subject_id)` is the exactly-once guarantee, and it
--   is the same trick 38 uses, with one extra column.
--
--   `email_outbox` keys on (kind, subject_id) because an email has exactly one
--   recipient per kind. A notification does not: cancelling a parcel notifies
--   the sender *and* the driver carrying it, and both rows are about the same
--   booking. Dropping `user_id` from the key would make the second insert a
--   no-op and silently stop telling drivers their job was called off.
--
-- ⚠ What this file does NOT do, on purpose.
--
--   Nothing writes to this table yet, and no pg_net call leaves it. The status
--   triggers and the `notify-push` dispatch are the next migration. A table
--   that exists and is empty is a deploy you can roll forward from; a table
--   that arrives already wired into `bookings` is one where a bad check
--   constraint takes parcel booking down with it — which is exactly how
--   20250101000024_push_delivery.sql happened.
--
-- Applies cleanly on a project that has never had notifications. Nothing here
-- touches dispatch, email or bookings.

do $$
begin
  if to_regclass('public.push_tokens') is null then
    raise exception 'Run 20250101000019_push.sql first.';
  end if;

  if to_regclass('public.email_outbox') is null then
    raise exception 'Run 20250101000038_transactional_email.sql first.';
  end if;
end
$$;

-- ----------------------------------------------------------------- the table --

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),

  /*
   * ⚠ `auth.users`, not `profiles`, and not a driver id.
   *
   *   Senders already receive the same events by email at the same moments
   *   (38's `email_on_booking_status` fires for both sides of a cancellation).
   *   A drivers-only table means writing all of it twice the week senders get a
   *   notification centre, and then keeping two check constraints in step.
   *
   *   `on delete cascade` because `erase_person` must not leave an inbox behind
   *   — these rows carry tracking ids and route names.
   */
  user_id uuid not null references auth.users (id) on delete cascade,

  /*
   * Which notification. Checked, so a typo in a trigger fails at write time
   * rather than rendering a blank card in the app.
   *
   * ⚠ Named `kind`, not `type`.
   *
   *   `email_outbox.kind` means the same thing and these two tables get read
   *   side by side during every "did they get told" investigation. One word for
   *   one concept. (`type` is also a non-reserved keyword that quoting tools
   *   disagree about — a smaller reason, but a real one.)
   *
   * Grouped by the four stages of the driver lifecycle.
   */
  kind text not null check (kind in (
    -- 1. onboarding and account verification
    'email_confirmation_pending',
    'email_confirmed',
    'application_submitted',
    'application_under_review',
    'application_approved',
    'application_rejected',
    'guarantor_pending',
    'guarantor_completed',
    'document_expiring',
    'document_expired',
    'document_rejected',
    'identity_verified',
    'identity_rejected',

    -- 2. job matching and dispatch
    'offer_received',
    'offer_expiring',
    'offer_expired',
    'job_assigned',

    -- 3. pickup and transit milestones
    'pickup_reminder',
    'parcel_status_changed',
    'job_cancelled',
    'message_received',

    -- 4. completion and payouts
    'delivery_completed',
    'earning_recorded',
    'payout_requested',
    'payout_paid',
    'payout_failed',

    -- sender-side, same table
    'parcel_booked',
    'parcel_cancelled',
    'sender_verification_submitted',
    'sender_verified',
    'sender_rejected'
  )),

  /*
   * The row this notification is about: an offer id, a booking id, a payout id.
   *
   * ⚠ Chosen per kind, and the choice is the difference between "once" and
   *   "once ever".
   *
   *   `offer_received` keys on the offer id — one offer, one notification, and
   *   a re-offer after a decline is a *different* offer so it notifies again.
   *   `parcel_status_changed` keys on `booking_id || ':' || status`, because
   *   the booking id alone would announce Assigned and then go quiet for
   *   Picked Up, In Transit and Out for Delivery. 38 learned this the same way.
   */
  subject_id text not null,

  /*
   * ⚠ Rendered here, not in the client.
   *
   *   A title built in the app from `metadata` reads differently after the next
   *   release, so an old notification silently rewrites itself — and the push
   *   that went out months ago said something else again. The text is what was
   *   true when the thing happened, and it is the same text the push carries.
   */
  title text not null check (btrim(title) <> ''),
  body text not null default '',

  /*
   * Everything the app needs to act on the tap: booking_id, offer_id,
   * tracking_id, expires_at, amount. Snapshotted, for 38's reason — the row it
   * describes may have moved on by the time anybody opens the app.
   *
   * ⚠ Ids and small scalars only.
   *
   *   No addresses, no phone numbers, no NIN. This payload is copied verbatim
   *   into an Expo push body in the next migration, and Expo is a third party.
   *   `notify_dispatch_offer` already sends ids only for the same reason.
   */
  metadata jsonb not null default '{}'::jsonb,

  /*
   * Read state as a timestamp, not a boolean.
   *
   * "Unread" is `read_at is null`, which a partial index makes free, and the
   * timestamp answers "how long did that sit there" without a second column.
   */
  read_at timestamptz,

  created_at timestamptz not null default now(),

  -- ------------------------------------------------------------- delivery --
  /*
   * ⚠ These four columns are why the table is not just an inbox.
   *
   *   Some notifications should never buzz a phone — a status change the driver
   *   caused themselves by tapping "Picked up" is already on their screen.
   *   `push_requested = false` says "inbox only" explicitly, so `pushed_at is
   *   null` keeps one meaning: owed, and not yet sent.
   */
  push_requested boolean not null default true,
  pushed_at timestamptz,
  /* Null while unsent and after a success; Expo's or pg_net's message otherwise. */
  push_error text,
  push_attempts integer not null default 0,

  /* The exactly-once guarantee. See the header. */
  unique (user_id, kind, subject_id)
);

comment on table public.notifications is
  'In-app notification inbox and push delivery record. One row per (user, kind, subject). Written only by security-definer functions; clients read their own rows and mark them read via RPC.';

-- ---------------------------------------------------------------- indexes --

/* The notification centre's only query: one user, newest first. */
create index if not exists notifications_inbox_idx
  on public.notifications (user_id, created_at desc);

/* The badge. Partial, because read rows outnumber unread ones within a week. */
create index if not exists notifications_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;

/* What the sender in the next migration picks up, and what a retry sweeps. */
create index if not exists notifications_push_queue_idx
  on public.notifications (created_at)
  where pushed_at is null and push_requested;

/* The retention sweeper's scan. Cheap now, load-bearing at a million rows. */
create index if not exists notifications_created_idx
  on public.notifications (created_at);

-- -------------------------------------------------------------------- RLS --

alter table public.notifications enable row level security;

/*
 * ⚠ Own rows only, and no admin read policy.
 *
 *   An admin who needs to answer "was this driver told" has `app_events` and
 *   will get a `security definer` reporting RPC when there is a screen that
 *   needs one. A blanket admin select here would expose every sender's parcel
 *   titles through PostgREST the moment one admin account is phished — and
 *   unlike `email_outbox`, this table is read continuously by a Realtime
 *   subscription, so the policy is evaluated on a hot path.
 *
 *   `(select auth.uid())` rather than `auth.uid()` — 48's initplan rewrite, so
 *   the function is evaluated once per statement rather than once per row.
 */
drop policy if exists "own notifications" on public.notifications;
create policy "own notifications"
  on public.notifications for select
  to authenticated
  using (user_id = (select auth.uid()));

/*
 * ⚠ No insert, update or delete policy, deliberately.
 *
 *   A client that could update this table could set `pushed_at` on a
 *   notification that was never sent, which turns the delivery record into
 *   fiction. Marking something read goes through `mark_notification_read`
 *   below, which touches `read_at` and nothing else.
 *
 *   A client that could *insert* could write itself a row that looks like it
 *   came from dispatch — and, once the next migration lands, make the platform
 *   send a push on its behalf.
 */

-- --------------------------------------------------------------- the queue --

/*
 * Queues one notification. The only supported way to write this table.
 *
 * Returns the new row's id, or null when the notification already existed —
 * which is the signal the dispatch trigger in the next migration uses to decide
 * whether a push is owed. Mirrors `queue_email`, which returns void because
 * nothing needed to know; here something does.
 */
create or replace function public.queue_notification(
  p_user uuid,
  p_kind text,
  p_subject_id text,
  p_title text,
  p_body text default '',
  p_metadata jsonb default '{}'::jsonb,
  p_push boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
begin
  /*
   * ⚠ No recipient means no row, same as `queue_email`.
   *
   *   Callers resolve a user id from a booking, and `bookings.driver_id` is
   *   nullable. A null here would raise inside an AFTER trigger on `bookings`
   *   and abort the status change — the notifier taking the product down, which
   *   is the exact failure 24 was written to prevent.
   */
  if p_user is null or p_kind is null or btrim(coalesce(p_title, '')) = '' then
    return null;
  end if;

  insert into public.notifications
    (user_id, kind, subject_id, title, body, metadata, push_requested)
  values (
    p_user,
    p_kind,
    p_subject_id,
    btrim(p_title),
    coalesce(p_body, ''),
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_push, true)
  )
  on conflict (user_id, kind, subject_id) do nothing
  returning id into new_id;

  return new_id;
end;
$$;

-- ------------------------------------------------------------ read / unread --

/*
 * Marks one notification read.
 *
 * Scoped to the caller inside the function rather than by an RLS policy,
 * because the function is `security definer` and therefore bypasses RLS. The
 * `user_id = auth.uid()` in the where clause *is* the access control.
 *
 * Idempotent: a second call does not move `read_at`, so the timestamp keeps
 * meaning "first opened".
 */
create or replace function public.mark_notification_read(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.notifications
     set read_at = now()
   where id = p_id
     and user_id = (select auth.uid())
     and read_at is null;
$$;

/*
 * Marks everything read. Returns how many rows changed, so the client can
 * settle the badge from the answer rather than guessing and re-fetching.
 */
create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  touched integer;
begin
  update public.notifications
     set read_at = now()
   where user_id = (select auth.uid())
     and read_at is null;

  get diagnostics touched = row_count;
  return touched;
end;
$$;

/*
 * The badge number.
 *
 * A `select count(*)` from the client would work and is one round trip either
 * way — this exists so the badge cannot drift when the select policy changes,
 * and so it reads the partial index by construction.
 */
create or replace function public.unread_notification_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.notifications
   where user_id = (select auth.uid())
     and read_at is null;
$$;

-- ---------------------------------------------------------------- retention --

/*
 * Deletes notifications nobody will open again.
 *
 * ⚠ This table grows faster than anything else in the schema.
 *
 *   Every offer notifies every driver in the rotation, not just the one who
 *   takes it, and every parcel passes through five statuses. `email_outbox` is
 *   one row per event; this is one row per event *per person*.
 *
 * Read rows go at 90 days, unread at 180. Unread ones live longer because an
 * unread notification is the evidence in "I was never told" — deleting it on
 * the same clock as a read one destroys the record of the case it proves.
 */
create or replace function public.sweep_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.notifications
   where (read_at is not null and created_at < now() - interval '90 days')
      or (read_at is null and created_at < now() - interval '180 days');

  get diagnostics removed = row_count;

  if removed > 0 then
    insert into public.app_events (level, area, message, context)
    values (
      'info', 'notifications', 'swept expired notifications',
      jsonb_build_object('removed', removed)
    );
  end if;

  return removed;
end;
$$;

-- ------------------------------------------------------------------ grants --

/*
 * ⚠ Postgres grants EXECUTE to `public` on every new function.
 *
 *   Without these revokes, `anon` can call `queue_notification` over PostgREST
 *   and write an arbitrary user an arbitrary notification — a `security
 *   definer` function is a privilege escalation waiting for a missing revoke.
 */
revoke all on function public.queue_notification(uuid, text, text, text, text, jsonb, boolean)
  from public, anon, authenticated;
revoke all on function public.sweep_notifications() from public, anon, authenticated;

revoke all on function public.mark_notification_read(uuid) from public, anon;
revoke all on function public.mark_all_notifications_read() from public, anon;
revoke all on function public.unread_notification_count() from public, anon;

grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;
grant execute on function public.unread_notification_count() to authenticated;

/*
 * ⚠ `service_role` is granted explicitly rather than left to inherit.
 *
 *   Revoking from `public` removes the implicit grant every role holds, and
 *   whether `service_role` still has one depends on which default privileges
 *   this project was created with — the same coin-flip 24 hit with pg_net's
 *   schema. The edge function in the next migration queues notifications with
 *   the service key; if that grant is missing it fails at 3am with a 404 from
 *   PostgREST, which reads like the function was never deployed.
 *
 *   This grants nothing new in practice: `service_role` bypasses RLS and could
 *   already insert into the table directly. It only makes the intended door the
 *   open one.
 */
grant execute on function public.queue_notification(uuid, text, text, text, text, jsonb, boolean)
  to service_role;

-- ---------------------------------------------------------------- realtime --

/*
 * The notification centre subscribes to this table.
 *
 * ⚠ Guarded, because `alter publication ... add table` raises on a second run
 *   and this file is meant to be re-runnable.
 *
 * Realtime applies the select policy above per subscriber, so a driver's
 * channel only ever carries their own rows — the filter is the RLS policy, not
 * the client's `filter:` string, which is a convenience and not a boundary.
 */
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'notifications'
     )
  then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;

-- -------------------------------------------------------------- scheduling --

/*
 * Scheduled here rather than written down somewhere as a thing to set up —
 * 31's reasoning. 03:00 UTC: quiet in Lagos, and clear of the 07:00 document
 * sweep so two long-running deletes never overlap.
 *
 * Job name keeps the `loci-` prefix. The rebrand deliberately left pg_cron job
 * names alone, and a new job under a different prefix would make the list read
 * as two systems.
 */
do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule('loci-notification-retention')
      where exists (select 1 from cron.job where jobname = 'loci-notification-retention');

    perform cron.schedule(
      'loci-notification-retention', '0 3 * * *',
      'select public.sweep_notifications()'
    );
  else
    insert into public.app_events (level, area, message, context)
    values (
      'warning', 'notifications',
      'pg_cron is not installed, so notifications will never be purged',
      jsonb_build_object('function', 'sweep_notifications')
    );
  end if;
end
$$;

/*
  ⚠ Known and not solved here.

    - Nothing writes this table yet. Until the next migration the inbox is
      empty and the app shows a zero badge, which is correct and not a bug.
    - `message_received` is in the check list with no messaging table behind it.
      It is there so the enum does not have to change under a running app when
      in-app messages land; nothing can insert it today.
    - There is no per-user mute or quiet-hours setting. Every pushable kind
      pushes. That is a product decision, not an oversight, and the column to
      add when it changes is on `profiles`, not here.
    - Paystack does not exist in this schema. `payout_paid` fires from
      `settle_payout`, which is an admin recording a transfer they made by
      hand — the notification says the payout was marked paid, and must not
      claim a wallet was credited.
*/

notify pgrst, 'reload schema';
