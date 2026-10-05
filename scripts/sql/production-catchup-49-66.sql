-- ============================================================================
-- production-catchup-49-66.sql — bring a database that was built by hand back
--                                onto the migration chain
-- ============================================================================
--
-- Paste the WHOLE file into the SQL editor and run it once. It is one script on
-- purpose: the editor runs it as a single batch, so if any statement fails the
-- whole thing rolls back and the database is exactly as it was.
--
-- ⚠ Nothing in here is new. Every statement is migrations 49, 51, 52, 54, 55 and
--   66 from the repo, concatenated in order and unmodified. Running this is what
--   `supabase db push` would do if the migration ledger were intact.
--
-- WHY 49 IS IN A LIST THAT WAS MEANT TO BE 51–55
--
--   51's `invite_guarantor_on_submit` and `complete_guarantor_verification`
--   both call `public.queue_notification`, which migration 49 creates. plpgsql
--   resolves that at RUN time, not at CREATE time — so 51 would apply cleanly on
--   its own and then fail on the next driver submission with "function
--   public.queue_notification(...) does not exist". That is worse than today.
--   49 is a prerequisite, not scope creep.
--
--   50 is deliberately NOT here. It wires notifications into bookings, offers,
--   payouts and earnings, and it is a separate feature with its own dependency
--   surface. 51 does not need it. 49 alone installs an empty table and the one
--   function 51 calls — its own header says so: "a table that exists and is
--   empty is a deploy you can roll forward from".
--
-- WHY THIS IS SAFE AGAINST THE LIVE ROWS (checked on this database, 4 Oct 2026)
--
--   guarantor_verifications ..... 0 rows  → 51 adds 14 columns, every one
--                                           nullable, so there is nothing to
--                                           backfill and no NOT NULL to violate
--   guarantor_invitations ....... 1 row   → 54 extends it from 7 to 30 days;
--                                           lapsed invitations are left alone
--   driver_applications ......... 6 rows  → 52 only DROPS not-null constraints
--   email_outbox ................ 9 rows  → 55 rewrites the expiry inside UNSENT
--                                           guarantor_invitation payloads only;
--                                           there are none, so it is a no-op
--   notifications ............... new     → 49 creates it empty
--
--   Every CHECK 51 adds is written `x is null or x in (...)`, so it cannot
--   reject a row that already exists. No column is dropped. No data is deleted.
--   Nothing uses CREATE INDEX CONCURRENTLY, so the whole script is transactional.
--
-- WHAT CHANGES FOR PEOPLE USING THE APP
--
--   - A guarantor can upload their NIN slip and submit the form. Right now the
--     upload fails because `guarantor_document_slot`, the `guarantor_documents`
--     table and the `guarantor-identity` bucket do not exist here.
--   - `complete_guarantor_verification` moves from 39's 4-argument shape to 51's
--     (p_token, p_payload jsonb, p_ip, p_user_agent) — which is the shape the
--     web build already deployed on production calls through `guarantor-portal`.
--     This closes a gap, it does not open one.
--   - The driver's "Waiting on your guarantor" card starts showing when the
--     invitation was created and when the email actually left, instead of a dash.
--   - New invitation links last 30 days instead of 7.
--   - The APPLICANT is emailed when their guarantor finishes (66). Until now
--     they were told in the app only — and the person waiting on this step is
--     precisely the one with no reason to have the app open.
--
-- ⚠ AFTERWARDS the migration ledger still has a hole at 20–48. This script
--   records 49 and 51–55 so they cannot double-run, but `supabase db push` is
--   still not safe until 20–48 are reconciled. That is a separate job.

-- ------------------------------------------------------------- pre-flight --

/*
  Refuses to start on a database that is not the one this was audited against.
  Better to stop here than half-way through.
*/
do $preflight$
begin
  if to_regclass('public.push_tokens') is null then
    raise exception 'push_tokens is missing — migration 19 has not been applied. Stopping.';
  end if;
  if to_regclass('public.email_outbox') is null then
    raise exception 'email_outbox is missing — migration 38 has not been applied. Stopping.';
  end if;
  if to_regclass('public.guarantor_invitations') is null then
    raise exception 'guarantor_invitations is missing — migration 39 has not been applied. Stopping.';
  end if;
  if to_regprocedure('public.queue_email(text,text,text,jsonb)') is null then
    raise exception 'queue_email is missing or has an unexpected signature — migration 38 is incomplete. Stopping.';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'is_admin is missing — migration 3/7 has not been applied. Stopping.';
  end if;
end
$preflight$;


-- ############################################################################
-- migration 20250101000049_notifications.sql
-- ############################################################################

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


-- ############################################################################
-- migration 20250101000051_guarantor_full_form.sql
-- ############################################################################

-- ============================================================================
-- 20250101000051_guarantor_full_form.sql — the guarantor says who they are
-- ============================================================================
--
-- 39 built the hard part: a stranger with no account, holding a hashed,
-- single-use, expiring token, can tell us their NIN and consent to it being
-- checked. Read that file first — every token rule here is its rule, and none
-- of them are restated.
--
-- This migration widens what that person is asked for, and there are only two
-- reasons to widen it at all:
--
--   1. A NIN and a tick prove that *somebody* holds the link. They do not say
--      who is standing behind this driver, how the two know each other, or how
--      to reach them when a parcel goes missing. An admin reviewing an
--      application had a number and nothing to read.
--
--   2. A guarantee that carries no stated liability is a character reference
--      with a national identifier attached. If Package Relay is ever going to
--      recover the value of converted goods from a guarantor, the wording that
--      person agreed to has to exist, be specific, and be on file with the
--      time they agreed to it.
--
-- ⚠ GUARANTOR_SURETYSHIP_REVIEW_REQUIRED — the clause this migration stores is
--   a suretyship: it makes a third party jointly liable for somebody else's
--   conduct up to the value of the goods. Whether a click-through suretyship,
--   accepted by a person with no account and no separate consideration, is
--   enforceable in Nigeria is a question for a Nigerian lawyer and not for this
--   file. Nothing here asserts that it is. What this migration guarantees is
--   narrower and is the part that is actually achievable in software: the exact
--   wording shown, the name typed under it, and the moment it was submitted are
--   recorded and cannot drift apart afterwards. See `docs/GUARANTOR.md`.
--
-- ⚠ Two things the guarantor now hands over that are not text, and the whole
--   upload design follows from them.
--
--   A photograph of a government ID, and a photograph of the person taken at
--   that moment. Neither can go through the anonymous PostgREST surface, and
--   granting `anon` an insert policy on `storage.objects` to let a token holder
--   upload directly was the first design and is not the one below. It would
--   have made the token a storage credential: good for as many objects as the
--   holder cared to push, with the bucket's size limit as the only ceiling and
--   no server-side view of who was doing it.
--
--   So uploads go through the `guarantor-portal` edge function, which holds the
--   service role, and `anon` gains nothing here at all. That has a second
--   benefit 39 asked for in a comment and could not have: `submitted_ip` is
--   finally filled by something that knows the address rather than by a client
--   reporting its own.
--
-- ⚠ And `complete_guarantor_verification` is taken *away* from `anon`.
--
--   It is now reachable only by the service role, through that same function.
--   After this migration `anon` may call exactly one thing in this database —
--   `open_guarantor_invitation` — which is a smaller anonymous surface than the
--   feature had when it did less.

-- --------------------------------------------------- what the guarantor says --

/*
 * ⚠ Every column is nullable, and that is not laziness.
 *
 *   Rows written between 39 and this migration have a NIN and a consent string
 *   and nothing else. A `not null` on `full_name` would either refuse this
 *   migration or require inventing a value for a real person's record, and an
 *   invented value in a file meant for a dispute is worse than a null.
 *
 *   The requirement lives in `complete_guarantor_verification` below, which is
 *   the only writer. New rows are complete; old rows stay honest about what was
 *   never asked.
 */
alter table public.guarantor_verifications
  /* Who they are, in their own words rather than the driver's. */
  add column if not exists full_name text,
  /*
   * ⚠ WhatsApp, specifically, and asked for as such.
   *
   *   Recovery conversations in Nigeria happen on WhatsApp. A landline or a
   *   number that is not on it is a number nobody will reach, so the label on
   *   the field says WhatsApp and this column records what was given for it.
   */
  add column if not exists whatsapp_phone text,
  /*
   * Their own address for correspondence, which may differ from the one the
   * invitation was sent to — a driver mistypes it, or names a work address for
   * a person who would rather use a personal one. Both are kept: this column
   * and `guarantor_invitations.guarantor_email`. A mismatch is a thing an admin
   * should see, not a thing this table should silently resolve.
   */
  add column if not exists email text,
  add column if not exists residential_address text,
  add column if not exists relationship text,
  add column if not exists known_duration text,

  /* Professional background: what an admin weighs the guarantee against. */
  add column if not exists employment_status text,
  add column if not exists company_name text,
  add column if not exists job_title text,

  /*
   * ⚠ The suretyship wording, stored beside the consent wording rather than
   *   replacing it.
   *
   *   They are two different agreements to two different things — "you may
   *   check my identity" and "I am liable for the value of the goods" — and a
   *   person can reasonably be shown to have agreed to one and not the other.
   *   Collapsing them into one string would destroy that distinction at exactly
   *   the moment somebody needs it.
   */
  add column if not exists declaration_text text,
  add column if not exists declared_at timestamptz,

  /*
   * The signature: a typed full name, and the time it was typed.
   *
   * ⚠ Not a drawn signature, and not presented as more than it is.
   *
   *   A typed name is an electronic signature under the Nigeria Data
   *   Protection Act's neighbouring evidence rules only to the extent that the
   *   surrounding record supports it. What makes this worth anything is the
   *   company it keeps in this row — the wording, the timestamp, the IP, the
   *   live photograph and the ID — not the characters themselves.
   */
  add column if not exists signature_name text,
  add column if not exists signed_at timestamptz,

  /* Alongside `submitted_ip`, for a dispute about who filled this in. */
  add column if not exists user_agent text;

/*
 * ⚠ Checked as vocabularies, because these two are closed sets and short.
 *
 *   `relationship` and `known_duration` are offered from
 *   `src/constants/driver-validation.ts`, and `employment_status` from
 *   `src/constants/guarantor.ts`. Pinning all three here would guarantee the
 *   drift this codebase has been bitten by before: the list grows in TypeScript,
 *   the constraint does not, and a real guarantor picking a newly added option
 *   gets an error nobody can reproduce.
 *
 *   So only the two whose values the *review* reads as data are constrained,
 *   and `relationship` — the one certain to grow — is length-checked instead.
 */
alter table public.guarantor_verifications
  drop constraint if exists guarantor_verifications_employment_check;
alter table public.guarantor_verifications
  add constraint guarantor_verifications_employment_check
  check (
    employment_status is null
    or employment_status in (
      'Employed', 'Self-employed', 'Business owner', 'Civil servant',
      'Retired', 'Unemployed', 'Student'
    )
  );

alter table public.guarantor_verifications
  drop constraint if exists guarantor_verifications_duration_check;
alter table public.guarantor_verifications
  add constraint guarantor_verifications_duration_check
  check (
    known_duration is null
    or known_duration in (
      'Under 1 year', '1-2 years', '3-5 years', '6-10 years', 'Over 10 years'
    )
  );

-- ------------------------------------------------------------ the two photos --

/*
 * Where an uploaded file is recorded. The bytes are in Storage; this is the
 * index, and the only thing that says an upload belongs to an invitation.
 *
 * ⚠ Keyed on (invitation, kind), so a retake replaces rather than accumulates.
 *
 *   A guarantor whose first photograph was dark will take another. Two rows for
 *   one live photo means an admin choosing which of two faces to believe, and
 *   `complete_guarantor_verification` counting an attachment twice.
 */
create table if not exists public.guarantor_documents (
  invitation_id uuid not null
    references public.guarantor_invitations (id) on delete cascade,

  kind text not null check (kind in ('government_id', 'live_photo')),

  /*
   * ⚠ Derived by `guarantor_document_slot`, never accepted from a caller.
   *
   *   The same rule as `complete_capture_session` in 13, for the same reason: a
   *   caller that can name the path can point an invitation at an object
   *   belonging to a different one.
   *
   *   It deliberately carries no file extension. `<invitation>/live_photo` is
   *   one address for one thing, so a JPEG retaken as a PNG overwrites the
   *   first rather than orphaning it in a bucket nothing can garbage-collect.
   *   The type travels in `content_type` and in Storage's own metadata.
   */
  path text not null unique,
  content_type text not null,
  bytes integer not null check (bytes > 0),

  uploaded_at timestamptz not null default now(),

  primary key (invitation_id, kind)
);

alter table public.guarantor_documents enable row level security;
/* No policies, for anybody. Definer functions and the service role only. */

/*
 * A private bucket of its own.
 *
 * ⚠ Not `sender-identity`, and not `driver-documents`.
 *
 *   Those hold files belonging to account holders who can be shown a retention
 *   notice and can exercise a deletion right through the app. These belong to
 *   people with no account, collected once, whose only relationship with
 *   Package Relay is a link they were emailed. When a retention decision is
 *   finally made it will not be the same decision, and a shared bucket would
 *   force it to be.
 */
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'guarantor-identity',
  'guarantor-identity',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/*
 * ⚠ One policy, and it is a read for admins. Nothing else, for anyone.
 *
 *   No insert policy exists because nothing signed in is meant to write here —
 *   the edge function holds the service role and bypasses RLS. No policy for
 *   `anon` exists because the token must not become a storage credential. And
 *   no policy for the driver: a driver who could read this bucket could read
 *   their own guarantor's ID, which is the disclosure 39 exists to prevent.
 */
drop policy if exists "admins read guarantor identity files" on storage.objects;
create policy "admins read guarantor identity files"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'guarantor-identity' and (select public.is_admin()));

-- ------------------------------------------------- where an upload may land --

/**
 * Reserves the path for one document and returns it.
 *
 * ⚠ Service role only, called by `guarantor-portal` after it has been handed a
 *   token. The token is re-checked here rather than trusted: the function is
 *   the only caller today, and "the only caller today" is not a rule the
 *   database can rely on.
 *
 * The row is written before the bytes exist, with `bytes = 0` meaning reserved
 * — no, it cannot: the check refuses it. So nothing is written here at all, and
 * `guarantor_document_recorded` below is what commits. This function's whole
 * job is to answer "where", having first answered "may you".
 */
create or replace function public.guarantor_document_slot(
  p_token text,
  p_kind text
)
returns table (ok boolean, reason text, path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
begin
  if p_kind not in ('government_id', 'live_photo') then
    return query select false, 'bad-kind'::text, null::text;
    return;
  end if;

  select * into invite
    from public.guarantor_invitations
   where token_hash = public.guarantor_token_hash(coalesce(p_token, ''));

  /* The same three refusals, in the same order, as everything else here. */
  if invite.id is null then
    return query select false, 'invalid'::text, null::text;
    return;
  end if;

  if invite.completed_at is not null then
    return query select false, 'completed'::text, null::text;
    return;
  end if;

  if invite.expires_at <= now() then
    return query select false, 'expired'::text, null::text;
    return;
  end if;

  return query select true, null::text, invite.id::text || '/' || p_kind;
end;
$$;

/**
 * Records an upload that has landed.
 *
 * ⚠ The path is checked against the one this invitation is entitled to, not
 *   merely stored. Otherwise the caller could report a path under a different
 *   invitation and attach somebody else's ID to this application.
 */
create or replace function public.guarantor_document_recorded(
  p_token text,
  p_kind text,
  p_path text,
  p_content_type text,
  p_bytes integer
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
  expected text;
begin
  select * into invite
    from public.guarantor_invitations
   where token_hash = public.guarantor_token_hash(coalesce(p_token, ''));

  if invite.id is null then
    return query select false, 'invalid'::text;
    return;
  end if;

  if invite.completed_at is not null then
    return query select false, 'completed'::text;
    return;
  end if;

  if invite.expires_at <= now() then
    return query select false, 'expired'::text;
    return;
  end if;

  expected := invite.id::text || '/' || p_kind;

  if p_path is distinct from expected then
    return query select false, 'bad-path'::text;
    return;
  end if;

  if coalesce(p_bytes, 0) <= 0 then
    return query select false, 'empty-file'::text;
    return;
  end if;

  insert into public.guarantor_documents
    (invitation_id, kind, path, content_type, bytes)
  values (invite.id, p_kind, expected, coalesce(p_content_type, 'image/jpeg'), p_bytes)
  on conflict (invitation_id, kind) do update
    set path = excluded.path,
        content_type = excluded.content_type,
        bytes = excluded.bytes,
        uploaded_at = now();

  return query select true, null::text;
end;
$$;

-- ------------------------------------ telling the driver it has gone out --

/*
 * Replaces 39's version to add one line: the driver is told that the
 * invitation was sent, and to whom.
 *
 * ⚠ `guarantor_pending` has been a permitted notification kind since 49 and
 *   nothing has ever emitted it.
 *
 *   A driver pressed Submit and landed on a dashboard saying "Waiting on
 *   guarantor" with no record of anything having happened. The commonest reason
 *   a guarantor never answers is a mistyped address, and the moment to catch
 *   that is now — while the driver still remembers what they typed — not in a
 *   week when the link expires. The notification names the address for exactly
 *   that reason.
 *
 * Everything else about this function is 39's, unchanged.
 */
create or replace function public.invite_guarantor_on_submit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_token text;
begin
  raw_token := public.mint_guarantor_invitation(new.id);

  if raw_token is null then
    return new;
  end if;

  perform public.queue_email(
    'guarantor_invitation',
    new.id::text,
    new.guarantor_email,
    jsonb_build_object(
      'guarantor_name', new.guarantor_name,
      'driver_name', new.full_name,
      'reference', new.reference,
      /* The token travels in the payload, and this is the one place it may — see 39. */
      'token', raw_token,
      'expires_at', now() + public.guarantor_invitation_window()
    )
  );

  perform public.queue_notification(
    new.user_id,
    'guarantor_pending',
    new.id::text,
    'We have emailed your guarantor',
    'We sent ' || coalesce(new.guarantor_name, 'your guarantor') || ' a link at '
      || new.guarantor_email || '. Check the address is right — you can correct it and '
      || 'send again from your driver portal.',
    jsonb_build_object(
      'guarantor_email', new.guarantor_email,
      'application_reference', new.reference
    )
  );

  return new;
end;
$$;

-- ------------------------------------------------- what the portal may read --

/*
 * ⚠ Two fields added to what a link holder is told, and no more than two.
 *
 *   39 returned the driver's name and the guarantor's own first name and argued
 *   at length for the minimum. That argument still holds, and these two do not
 *   weaken it:
 *
 *     `reference`      — the application's own reference, so a guarantor
 *                        telephoning about this can quote something. It
 *                        identifies an application, not a person.
 *     `guarantor_email` — the address this invitation was sent to. Whoever is
 *                        reading the page opened it from that inbox, so it
 *                        discloses nothing they do not already have, and it
 *                        lets the form show the address read-only instead of
 *                        asking a second time.
 *
 *   Still not returned: the driver's phone, address, NIN, vehicle or city.
 */
drop function if exists public.open_guarantor_invitation(text);

create or replace function public.open_guarantor_invitation(p_token text)
returns table (
  valid boolean,
  reason text,
  driver_name text,
  guarantor_name text,
  guarantor_email text,
  reference text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
  app record;
begin
  select * into invite
    from public.guarantor_invitations
   where token_hash = public.guarantor_token_hash(coalesce(p_token, ''));

  /* One shape of answer for "no such token" — see 39. */
  if invite.id is null then
    return query select false, 'invalid'::text,
      null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  update public.guarantor_invitations
     set attempts = attempts + 1
   where id = invite.id;

  if invite.attempts >= public.guarantor_attempt_ceiling() then
    return query select false, 'invalid'::text,
      null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if invite.completed_at is not null then
    return query select false, 'completed'::text,
      null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if invite.expires_at <= now() then
    return query select false, 'expired'::text,
      null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  /*
   * ⚠ Aliased, because `reference` is also an OUT parameter of this function.
   *
   *   Unqualified, `reference` in this query is ambiguous between the column and
   *   the output column of the same name — an error at call time, not at create
   *   time, so it passes `db push` and fails on the first guarantor who opens a
   *   link. The alias is what disambiguates it.
   */
  select a.full_name, a.reference into app
    from public.driver_applications a
   where a.id = invite.application_id;

  return query select
    true, null::text,
    app.full_name, invite.guarantor_name, invite.guarantor_email, app.reference,
    invite.expires_at;
end;
$$;

-- -------------------------------------------------- completing the check --

/*
 * ⚠ The four-argument version of this function is dropped, not kept beside the
 *   new one.
 *
 *   Postgres would happily hold both — different argument lists, different
 *   functions — and `anon` had execute on the old one. Leaving it in place
 *   would leave a live anonymous endpoint that completes a guarantor check with
 *   a NIN and a tick, skipping the declaration, the signature and both
 *   photographs. A gate with a second door is not a gate.
 */
drop function if exists public.complete_guarantor_verification(text, text, text, text);

/*
 * ⚠ One `jsonb` payload rather than eighteen parameters.
 *
 *   Fourteen fields arrived in this migration and more will. Each new one as a
 *   parameter is a new function signature, a new set of grants, and an older
 *   client calling the older signature — which is precisely the second-door
 *   problem above. A payload changes shape without changing identity.
 *
 * ⚠ `p_ip` and `p_user_agent` are separate arguments on purpose.
 *
 *   They are not things the guarantor said; they are things the server
 *   observed. Mixing them into the payload would put a client-supplied value
 *   in the same shape as an observed one, and a record that cannot distinguish
 *   the two is not evidence of anything. Only the edge function may call this,
 *   so only the edge function can fill them.
 */
create or replace function public.complete_guarantor_verification(
  p_token text,
  p_payload jsonb,
  p_ip text default null,
  p_user_agent text default null
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
  driver uuid;
  app_reference text;
  digits text;
  phone text;
  employment text;
  signature text;
  name text;
  attachments integer;
  declaration text;
begin
  select * into invite
    from public.guarantor_invitations
   where token_hash = public.guarantor_token_hash(coalesce(p_token, ''));

  if invite.id is null then
    return query select false, 'invalid'::text;
    return;
  end if;

  if invite.completed_at is not null then
    return query select false, 'completed'::text;
    return;
  end if;

  if invite.expires_at <= now() then
    return query select false, 'expired'::text;
    return;
  end if;

  /* ----------------------------------------------------------- identity -- */

  digits := regexp_replace(coalesce(p_payload->>'nin', ''), '[^0-9]', '', 'g');
  if digits !~ '^[0-9]{11}$' then
    return query select false, 'bad-nin'::text;
    return;
  end if;

  name := btrim(coalesce(p_payload->>'full_name', ''));
  /*
   * Two words, which is the same floor the driver application applies to a
   * guarantor's name. It rejects "Bisi" and accepts everything real.
   */
  if array_length(regexp_split_to_array(name, '\s+'), 1) < 2 then
    return query select false, 'bad-name'::text;
    return;
  end if;

  /*
   * ⚠ Digits, not a format.
   *
   *   The client enforces +234 and a Nigerian network prefix, because it can
   *   say so helpfully while somebody is typing. Repeating that regex here
   *   would put the definition of a valid Nigerian mobile number in two places
   *   and guarantee they disagree the week a new prefix is allocated. This
   *   floor catches what actually reaches a database — a blank, a name typed
   *   into the wrong box, seven digits — and nothing else.
   */
  phone := regexp_replace(coalesce(p_payload->>'whatsapp_phone', ''), '[^0-9]', '', 'g');
  if length(phone) < 10 or length(phone) > 15 then
    return query select false, 'bad-phone'::text;
    return;
  end if;

  if coalesce(p_payload->>'email', '') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    return query select false, 'bad-email'::text;
    return;
  end if;

  /*
   * Ten characters, the same floor the driver application uses for an address.
   * It rejects "Lagos" and accepts a real line of one.
   */
  if length(btrim(coalesce(p_payload->>'residential_address', ''))) < 10 then
    return query select false, 'bad-address'::text;
    return;
  end if;

  if btrim(coalesce(p_payload->>'relationship', '')) = ''
     or length(btrim(p_payload->>'relationship')) > 80 then
    return query select false, 'bad-relationship'::text;
    return;
  end if;

  if btrim(coalesce(p_payload->>'known_duration', '')) = '' then
    return query select false, 'bad-duration'::text;
    return;
  end if;

  /* ------------------------------------------------------- professional -- */

  employment := btrim(coalesce(p_payload->>'employment_status', ''));
  if employment = '' then
    return query select false, 'bad-employment'::text;
    return;
  end if;

  /*
   * ⚠ An employer is required of people who have one, and not of people who do
   *   not.
   *
   *   Requiring a company name of everybody would make a retired guarantor
   *   type something untrue into a form that is about to ask them to sign it.
   */
  if employment not in ('Retired', 'Unemployed', 'Student') then
    if btrim(coalesce(p_payload->>'company_name', '')) = ''
       or btrim(coalesce(p_payload->>'job_title', '')) = '' then
      return query select false, 'bad-employer'::text;
      return;
    end if;
  end if;

  /* ------------------------------------------------ consent and liability -- */

  /*
   * Both wordings are required, and for the reason 39 gave about the first:
   * "they agreed" is not a record of anything. What they agreed to is the part
   * that has to survive.
   */
  if btrim(coalesce(p_payload->>'consent_text', '')) = '' then
    return query select false, 'no-consent'::text;
    return;
  end if;

  declaration := btrim(coalesce(p_payload->>'declaration_text', ''));
  if declaration = '' then
    return query select false, 'no-declaration'::text;
    return;
  end if;

  /*
   * ⚠ A floor on the length of the clause itself.
   *
   *   This column is the only evidence of what a person accepted liability
   *   under. A client bug that posted 'true', or an empty template, would store
   *   a row that looks complete and proves nothing — and it would look
   *   complete a year later, to somebody who no longer has the page.
   */
  if length(declaration) < 200 then
    return query select false, 'no-declaration'::text;
    return;
  end if;

  /*
   * ⚠ The signature has to be the name they just gave.
   *
   *   A typed name is worth something only as an act of adoption: this person,
   *   having read that, wrote their own name under it. Accepting any string
   *   would make the field decorative, and accepting "yes" would make it
   *   misleading. Compared case- and space-insensitively, because people type
   *   their own names with inconsistent spacing and capitals and being pedantic
   *   about it would fail honest submissions.
   */
  signature := lower(regexp_replace(coalesce(p_payload->>'signature_name', ''), '\s+', ' ', 'g'));
  if btrim(signature) is distinct from lower(regexp_replace(name, '\s+', ' ', 'g')) then
    return query select false, 'signature-mismatch'::text;
    return;
  end if;

  /* ----------------------------------------------------------- the files -- */

  /*
   * ⚠ Counted from the table, not taken from the payload.
   *
   *   The client cannot be the authority on whether an upload happened. This
   *   asks the only thing that knows.
   */
  select count(*) into attachments
    from public.guarantor_documents
   where invitation_id = invite.id
     and kind in ('government_id', 'live_photo');

  if attachments < 2 then
    return query select false, 'missing-documents'::text;
    return;
  end if;

  /* ------------------------------------------------------------- the row -- */

  insert into public.guarantor_verifications (
    invitation_id, application_id, nin,
    consent_text, submitted_ip,
    full_name, whatsapp_phone, email, residential_address,
    relationship, known_duration,
    employment_status, company_name, job_title,
    declaration_text, declared_at,
    signature_name, signed_at,
    user_agent
  ) values (
    invite.id, invite.application_id, digits,
    btrim(p_payload->>'consent_text'), p_ip,
    name,
    btrim(p_payload->>'whatsapp_phone'),
    lower(btrim(p_payload->>'email')),
    btrim(p_payload->>'residential_address'),
    btrim(p_payload->>'relationship'),
    btrim(p_payload->>'known_duration'),
    employment,
    nullif(btrim(coalesce(p_payload->>'company_name', '')), ''),
    nullif(btrim(coalesce(p_payload->>'job_title', '')), ''),
    declaration,
    now(),
    btrim(p_payload->>'signature_name'),
    now(),
    /* Truncated: a user agent string is unbounded and this is a footnote. */
    left(coalesce(p_user_agent, ''), 400)
  );

  /* Spent. A forwarded email is now worthless. */
  update public.guarantor_invitations
     set completed_at = now()
   where id = invite.id;

  /* Only out of `pending_guarantor` — see 39. */
  update public.driver_applications
     set status = 'ready_for_review'
   where id = invite.application_id
     and status = 'pending_guarantor';

  /*
   * ⚠ The driver is told, which nothing did before.
   *
   *   `guarantor_completed` has been a permitted notification kind since 49 and
   *   nothing has ever emitted it. The driver was left refreshing a card. This
   *   is the event they are actually waiting on.
   */
  /*
   * ⚠ Selected into `app_reference`, not into a variable called `reference`.
   *
   *   `reference` is also the column's name, and a plpgsql variable that shadows
   *   a column in its own query is an "ambiguous column" error at call time —
   *   the kind that passes `create function` and fails on the first real
   *   guarantor.
   */
  select a.user_id, a.reference into driver, app_reference
    from public.driver_applications a
   where a.id = invite.application_id;

  perform public.queue_notification(
    driver,
    'guarantor_completed',
    invite.id::text,
    'Your guarantor has completed their check',
    invite.guarantor_name || ' has verified themselves. Your application is now with our review team.',
    jsonb_build_object('application_reference', app_reference)
  );

  return query select true, null::text;
end;
$$;

-- --------------------------------------------------------- for the driver --

/*
 * ⚠ Replaced to add two timestamps, and the reason is that a driver watching
 *   this card could not tell a typo from a slow guarantor.
 *
 *   The old answer was a state, an address and an expiry. What it left out was
 *   *when anything happened*, which is the only way somebody can reason about
 *   silence. Three days of nothing means one thing if the invitation went out
 *   three days ago and another if the email is still sitting unsent in the
 *   outbox.
 *
 *     invited_at     when the invitation was minted — the link's birthday.
 *     email_sent_at  when the provider actually accepted it, or null while it
 *                    is still queued. These are different facts and the card
 *                    says so rather than presenting the first as the second.
 *     invitations    how many have been sent, so a driver on their third
 *                    attempt sees that rather than a card that looks unchanged.
 *
 * Still never returned: the token, the NIN, or anything the guarantor typed.
 */
drop function if exists public.my_guarantor_status();

create or replace function public.my_guarantor_status()
returns table (
  state text,
  guarantor_name text,
  guarantor_email text,
  invited_at timestamptz,
  email_sent_at timestamptz,
  expires_at timestamptz,
  completed_at timestamptz,
  invitations integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select i.*, a.id as app_id
      from public.guarantor_invitations i
      join public.driver_applications a on a.id = i.application_id
     where a.user_id = (select auth.uid())
     order by i.created_at desc
     limit 1
  )
  select
    case
      when m.completed_at is not null then 'completed'
      when m.expires_at <= now() then 'expired'
      else 'waiting'
    end,
    m.guarantor_name,
    m.guarantor_email,
    m.created_at,
    /*
     * ⚠ Matched on the address and the subject prefix, because a re-invitation
     *   does not key the outbox on the application id alone.
     *
     *   `reinvite_guarantor` appends a timestamp to `subject_id` so the outbox's
     *   unique constraint does not swallow the second invitation. A join on
     *   equality would therefore find the first email and never any later one —
     *   and a driver who corrected a typo would be shown the send time of the
     *   message that went to the wrong address.
     */
    (
      select o.sent_at
        from public.email_outbox o
       where o.kind = 'guarantor_invitation'
         and o.recipient = m.guarantor_email
         and o.subject_id like m.app_id::text || '%'
       order by o.created_at desc
       limit 1
    ),
    m.expires_at,
    m.completed_at,
    (select count(*)::integer from public.guarantor_invitations g where g.application_id = m.app_id)
  from mine m;
$$;

-- ------------------------------------------------------------ for an admin --

/*
 * The whole guarantor record, for the person deciding on the application.
 *
 * ⚠ Still last four of the NIN, and the paths rather than the files.
 *
 *   The reveal rule from 39 is unchanged: a review queue is a screen somebody
 *   leaves open, and it should not be a list of national identifiers. The
 *   document paths are returned because an admin client needs something to ask
 *   for a signed URL with; the objects themselves are only readable by an admin
 *   or the service role.
 *
 * ⚠ `email_matches_invite` is computed here rather than left to the client.
 *
 *   A guarantor who gives a different address from the one the driver typed is
 *   the single most useful signal on this screen — it is what a driver using a
 *   friend's inbox looks like. Computing it in the client would mean each
 *   caller deciding how to compare two strings.
 */
drop function if exists public.admin_guarantor_summary(uuid);

create or replace function public.admin_guarantor_summary(p_application uuid)
returns table (
  verified boolean,
  nin_last4 text,
  consented_at timestamptz,
  full_name text,
  whatsapp_phone text,
  email text,
  invited_email text,
  email_matches_invite boolean,
  residential_address text,
  relationship text,
  known_duration text,
  employment_status text,
  company_name text,
  job_title text,
  declaration_text text,
  signature_name text,
  signed_at timestamptz,
  submitted_ip text,
  government_id_path text,
  live_photo_path text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    true,
    right(v.nin, 4),
    v.consented_at,
    v.full_name,
    v.whatsapp_phone,
    v.email,
    i.guarantor_email,
    lower(btrim(coalesce(v.email, ''))) = lower(btrim(coalesce(i.guarantor_email, ''))),
    v.residential_address,
    v.relationship,
    v.known_duration,
    v.employment_status,
    v.company_name,
    v.job_title,
    v.declaration_text,
    v.signature_name,
    v.signed_at,
    v.submitted_ip,
    (select d.path from public.guarantor_documents d
      where d.invitation_id = v.invitation_id and d.kind = 'government_id'),
    (select d.path from public.guarantor_documents d
      where d.invitation_id = v.invitation_id and d.kind = 'live_photo')
  from public.guarantor_verifications v
  join public.guarantor_invitations i on i.id = v.invitation_id
  where v.application_id = p_application
    and (select public.is_admin());
$$;

-- ----------------------------------------------------------------- grants --

/*
 * ⚠ `anon` is left with exactly one function, and it is read-only.
 *
 *   Before this migration `anon` could open an invitation *and* complete it.
 *   Completion now goes through `guarantor-portal`, which holds the service
 *   role, sees the real client address, and is the only thing that can write
 *   into this feature. The anonymous surface has got smaller while the feature
 *   got bigger, which is the only direction it should ever move.
 */
grant execute on function public.open_guarantor_invitation(text) to anon, authenticated;

revoke all on function public.complete_guarantor_verification(text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_guarantor_verification(text, jsonb, text, text)
  to service_role;

revoke all on function public.guarantor_document_slot(text, text) from public, anon, authenticated;
grant execute on function public.guarantor_document_slot(text, text) to service_role;

revoke all on function public.guarantor_document_recorded(text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.guarantor_document_recorded(text, text, text, text, integer)
  to service_role;

revoke all on function public.my_guarantor_status() from public, anon;
grant execute on function public.my_guarantor_status() to authenticated;

revoke all on function public.admin_guarantor_summary(uuid) from public, anon;
grant execute on function public.admin_guarantor_summary(uuid) to authenticated;


-- ############################################################################
-- migration 20250101000052_guarantor_columns_nullable.sql
-- ############################################################################

-- ============================================================================
-- 20250101000052_guarantor_columns_nullable.sql — the three columns 39 orphaned
-- ============================================================================
--
-- ⚠ This is a one-line fix for a bug that has blocked every driver application
--   since 39 was applied, and the reason it was not caught is worth recording.
--
--   02 created `guarantor_relationship`, `guarantor_address` and `guarantor_nin`
--   as `not null`, because the driver typed all three into their own form.
--
--   39 stopped collecting them — a driver has no business entering somebody
--   else's national identifier — and says so in a comment: "`guarantor_nin`,
--   `guarantor_address` and `guarantor_relationship` are left in place, and
--   nothing writes them any more." Both halves of that sentence are true. What
--   it missed is that a column nothing writes is a column that must be allowed
--   to be null, and 39 left all three `not null` with no default.
--
--   So on any database where 39 has run, `submitApplication` — which correctly
--   stopped sending them — fails at the first one:
--
--     null value in column "guarantor_relationship" of relation
--     "driver_applications" violates not-null constraint (23502)
--
--   The applicant sees that string after filling in thirty fields, attaching
--   five documents and photographing their own face.
--
-- ⚠ The columns stay. Only the constraints go.
--
--   39's argument for keeping them is unchanged and still right: dropping them
--   would take the guarantor details off every application approved before 39 —
--   the records somebody would want if a driver has to be investigated a year
--   from now — and would break `erase_person` in `20250101000009_bans.sql` and
--   `20250101000033_erase_repair.sql`, both of which overwrite all three.
--
-- ⚠ No backfill, and no default.
--
--   A default would be worse than a null: `'Erased'` is already meaningful in
--   these columns, `''` reads as "asked and left blank", and anything else is a
--   value nobody supplied sitting in a compliance record. Null is the honest
--   answer to "what relationship did the driver state" when the driver was
--   never asked. Rows written before 39 keep what they hold.

alter table public.driver_applications
  alter column guarantor_relationship drop not null,
  alter column guarantor_address      drop not null,
  alter column guarantor_nin          drop not null;

/*
 * ⚠ `guarantor_email` is deliberately NOT given a `not null` in exchange.
 *
 *   It is the one guarantor field the driver still supplies, so the temptation
 *   is to require it here. 39 refuses that on purpose: an application with no
 *   guarantor address is allowed to exist and stays in the ordinary review
 *   queue rather than in `pending_guarantor`, because an application waiting on
 *   an invitation that was never sendable is one that can never move. The
 *   client requires the field; the schema does not have to.
 */

-- ------------------------------------------------- so the panel can tell ----

/**
 * Whether this database still refuses an application with no guarantor
 * relationship on it.
 *
 * ⚠ A function whose only job is to be askable.
 *
 *   Everything else on the deployment panel is probed by calling a function a
 *   migration created: absent, PostgREST answers PGRST202 and
 *   `src/lib/schema-gap.ts` names the file to run. A migration that only drops
 *   constraints creates nothing, so it is invisible to that mechanism — and
 *   this one is the difference between a working signup form and one that
 *   refuses every applicant with raw SQL at the last step. Worth being able to
 *   ask about.
 *
 * ⚠ And it reports the live state rather than returning `true`.
 *
 *   A constant would prove only that this file ran. This reads the catalogue,
 *   so it also answers correctly on a database where somebody restored an old
 *   dump over the top, or re-added a constraint by hand. The panel asks "is this
 *   database behind the code"; this is an answer rather than a receipt.
 */
create or replace function public.driver_application_guarantor_optional()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'driver_applications'
       and column_name in ('guarantor_relationship', 'guarantor_address', 'guarantor_nin')
       and is_nullable = 'NO'
  );
$$;

/* Nothing sensitive: it answers a question about the shape of a table. */
revoke all on function public.driver_application_guarantor_optional() from public, anon;
grant execute on function public.driver_application_guarantor_optional() to authenticated;


-- ############################################################################
-- migration 20250101000054_guarantor_link_window.sql
-- ############################################################################

-- ============================================================================
-- 20250101000054_guarantor_link_window.sql — thirty days to answer, not seven
-- ============================================================================
--
-- 39 set the window at seven days and argued it: "Long enough for somebody who
-- checks email weekly, short enough that a link in an old inbox is not a
-- standing key." The first half turned out to be optimistic.
--
-- A guarantor is not a customer. They are somebody's landlord or employer, they
-- did not ask for the email, and the thing it asks of them — find your ID,
-- photograph it, take a photo of your face, read a liability clause — is not a
-- two-minute job at a desk. Seven days expires a meaningful share of them
-- before they get to it, and an expired link costs the *driver* their
-- application while the guarantor never learns anything went wrong.
--
-- ⚠ The second half of 39's sentence is still true, and this does make it worse.
--
--   A live link in an inbox reaches a form that collects a national identifier,
--   a photograph of a government ID and a live photograph. Thirty days is four
--   times as long for that to sit in a forwarded thread or a shared mailbox.
--
--   What keeps it defensible is unchanged and is not the window: the token is
--   244 bits, stored only as a digest, single-use, refused past an attempt
--   ceiling, and retired the moment the driver re-invites. The window is the
--   weakest of those five controls, which is why it is the one that can move.
--
-- ⚠ Nothing else changes. `mint_guarantor_invitation` reads this function, so
--   this file is the whole change for every invitation minted from now on.

create or replace function public.guarantor_invitation_window()
returns interval language sql immutable as $$ select interval '30 days' $$;

/*
 * ⚠ Invitations already outstanding are extended. Lapsed ones are not.
 *
 *   `expires_at` is stamped at mint time, so without this the change applies
 *   only to invitations sent after the deploy — and the guarantor who is sitting
 *   on a seven-day link right now, the one who prompted this, would still lose
 *   it. Extending a live invitation gives that person the window the product now
 *   intends.
 *
 *   An invitation that has *already* lapsed stays lapsed. Resurrecting a dead
 *   link is a different act: somebody was told it had expired, the driver may
 *   have re-invited since, and a link coming back to life is precisely the
 *   behaviour a single-use token exists to prevent. Those are replaced by
 *   `reinvite_guarantor`, which mints a fresh one and retires the old.
 */
update public.guarantor_invitations
   set expires_at = created_at + public.guarantor_invitation_window()
 where completed_at is null
   and expires_at > now();


-- ############################################################################
-- migration 20250101000055_guarantor_invite_payload_refresh.sql
-- ############################################################################

-- ============================================================================
-- 20250101000055_guarantor_invite_payload_refresh.sql — the date in the email
-- ============================================================================
--
-- ⚠ 54 widened the window and extended live invitations, and the emails still
--   said seven days. Both facts are correct; they are about different rows.
--
--   `queue_email` snapshots everything the template needs into
--   `email_outbox.payload` at the moment the thing happened, and 38 argues that
--   at length — a parcel cancelled seconds after delivery must not produce a
--   "delivered" email describing a cancelled parcel. So the invitation email
--   carries the `expires_at` that was true when it was minted, and 54 changing
--   the row underneath it does not reach the snapshot.
--
--   For an email that has already gone out, that is exactly right and nothing
--   here touches it. For one still sitting unsent in the outbox, it is a
--   snapshot of something that is no longer true, about to be sent to somebody
--   who will plan around the date it states.
--
-- ⚠ Unsent rows only, and the date is taken from the invitation rather than
--   recomputed.
--
--   The invitation row is the authority — it is what `open_guarantor_invitation`
--   checks the link against. Recomputing `created_at + window` here would agree
--   today and drift the next time somebody changes the window by hand.

/*
 * ⚠ `to_jsonb(timestamptz)`, not `to_char`.
 *
 *   The first draft formatted with `OF`, which renders `+00` — and the template
 *   parses this field with `new Date(...)`, which does not reliably accept a
 *   two-character offset. The email would have rendered an empty expiry line:
 *   the same bug as a wrong date, wearing a better disguise. `to_jsonb` produces
 *   the same ISO 8601 with `+00:00` that `queue_email` stored in the first
 *   place, which is the only format this payload has ever had.
 */
update public.email_outbox o
   set payload = jsonb_set(o.payload, '{expires_at}', to_jsonb(i.expires_at))
  from public.guarantor_invitations i
  join public.driver_applications a on a.id = i.application_id
 where o.kind = 'guarantor_invitation'
   and o.sent_at is null
   /*
    * The outbox is keyed on the application id, and on `<id>:<timestamp>` for a
    * re-invitation — both start with the application id, which is how
    * `my_guarantor_status` matches them too.
    */
   and o.subject_id like a.id::text || '%'
   and i.completed_at is null
   and i.expires_at > now()
   /*
    * Only where it actually disagrees, so this is a no-op on a healthy project.
    * Compared as jsonb rather than cast to timestamptz: a payload holding
    * something uncastable would make the cast throw and take the whole migration
    * with it.
    */
   and o.payload->'expires_at' is distinct from to_jsonb(i.expires_at);

-- ------------------------------------------------- so the panel can tell ----

/**
 * Whether every unsent invitation email states the date its link actually dies.
 *
 * ⚠ A function whose job is to be askable, for the same reason 52 carries one.
 *
 *   The UPDATE above creates nothing, so the deployment panel — which probes by
 *   calling a function and reading PostgREST's "no such function" — is blind to
 *   it. And this particular absence is invisible by construction: the emails
 *   send, the links work, and the only symptom is a date in somebody else's
 *   inbox that is not the date the link expires.
 *
 * ⚠ It reads the live state rather than returning true.
 *
 *   A constant would prove only that this file ran once. This keeps answering
 *   afterwards — so if the window is changed again by hand and the snapshots are
 *   left behind, the panel says so instead of reporting a migration as applied
 *   and a system as healthy.
 */
create or replace function public.guarantor_invite_dates_current()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from public.email_outbox o
      join public.driver_applications a on o.subject_id like a.id::text || '%'
      join public.guarantor_invitations i on i.application_id = a.id
     where o.kind = 'guarantor_invitation'
       and o.sent_at is null
       and i.completed_at is null
       and i.expires_at > now()
       and o.payload->'expires_at' is distinct from to_jsonb(i.expires_at)
  );
$$;

revoke all on function public.guarantor_invite_dates_current() from public, anon;
grant execute on function public.guarantor_invite_dates_current() to authenticated;


-- ############################################################################
-- migration 20250101000066_guarantor_completed_email.sql
-- ############################################################################

-- ============================================================================
-- 66 — the applicant is emailed when their guarantor finishes
-- ============================================================================
--
-- Run after 51. Re-runnable.
--
-- ⚠ The driver was told in the app and nowhere else.
--
--   51 queues a `guarantor_completed` *notification*, which lights the bell icon
--   for somebody who has the app open. The person waiting on this is an
--   applicant who submitted days ago and is not sitting in the app — they are
--   waiting precisely because there is nothing for them to do. Every other
--   decision point in an application already emails them: submitted, approved,
--   rejected. This one did not, so the single step that moves their application
--   from "waiting on somebody else" to "with our team" was the quietest.
--
-- ⚠ A trigger on `guarantor_verifications`, not an edit to
--   `complete_guarantor_verification`.
--
--   The alternative is a `create or replace` of 51's function with two lines
--   added, which copies two hundred lines of logic into this file so that the
--   next person has to diff them to find out whether they still agree. A trigger
--   says exactly what is new, and it fires for any writer of that table — today
--   the edge function, tomorrow a backfill or an admin correction.
--
-- ⚠ It must never be able to abort the guarantor's submission.
--
--   The trigger runs inside the same transaction as the insert, so anything it
--   raises rolls back the whole verification — the guarantor would see "could
--   not submit" after uploading an ID and a live photo, because of an email.
--   So: the kind is added to the check constraint IN THIS FILE and before the
--   trigger exists, every lookup tolerates a missing row, and no branch raises.
--   `queue_email` already returns without inserting when the recipient is null.

-- ------------------------------------------------------- the permitted kind --

/*
  ⚠ First, and in the same migration as the trigger.

    `email_outbox.kind` is a closed list. Queueing a kind that is not on it
    raises inside `queue_email`, in the guarantor's transaction — which is the
    failure described above, arriving as a check-constraint error on a form
    submission. 41 learned this the same way and left the warning.

    The list is reproduced whole rather than appended to, because that is how
    41, 57, 62 and 63 each did it: one statement you can read, instead of a
    history you have to replay.
*/
alter table public.email_outbox
  drop constraint if exists email_outbox_kind_check;

alter table public.email_outbox
  add constraint email_outbox_kind_check
  check (kind in (
    'driver_application_approved',
    'driver_application_rejected',
    'guarantor_invitation',
    'guarantor_completed',
    'sender_verification_submitted',
    'sender_verified',
    'sender_verification_rejected',
    'delivery_completed',
    'parcel_cancelled',
    'parcel_status_changed',
    'driver_offer',
    'driver_job_cancelled',
    'payout_paid',
    'parcel_payment_received',
    'welcome',
    'password_changed'
  ));

-- ------------------------------------------------------------- the trigger --

/**
 * Emails the applicant that their guarantor has completed the check.
 *
 * ⚠ Keyed on the application, not the verification.
 *
 *   `email_outbox` is unique on (kind, subject_id), so the application id makes
 *   this exactly-once per application. A guarantor who is re-invited and
 *   completes a second time does not email the driver twice about the same
 *   application — which is right: the news is "your guarantor is done", and it
 *   is only news the first time.
 *
 * ⚠ The guarantor's own details do not travel.
 *
 *   Their name does, because the driver chose them and it is how the driver
 *   knows which guarantor answered. Their NIN, address, phone, email and
 *   documents do not: this email goes to the applicant, and the whole point of
 *   the separate portal is that the applicant never sees what their guarantor
 *   filed.
 */
create or replace function public.email_on_guarantor_completed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  app record;
begin
  select a.id, a.email, a.full_name, a.reference, a.status
    into app
    from public.driver_applications a
   where a.id = new.application_id;

  /*
    No application, or one with no address on it, means nothing to send and
    nothing worth raising about. `found` is checked rather than assumed: this
    trigger must be survivable on a database mid-repair.
  */
  if not found or btrim(coalesce(app.email, '')) = '' then
    return new;
  end if;

  perform public.queue_email(
    'guarantor_completed',
    app.id::text,
    app.email,
    jsonb_build_object(
      'full_name', app.full_name,
      'reference', app.reference,
      /*
        Whatever the guarantor called themselves on their own form, falling back
        to the name the driver typed at signup. One of the two is always present.
      */
      'guarantor_name', coalesce(nullif(btrim(coalesce(new.full_name, '')), ''), 'Your guarantor')
    )
  );

  return new;
end;
$$;

/*
  AFTER INSERT, so the row exists before anything is queued, and `for each row`
  because one verification is one application.
*/
drop trigger if exists on_guarantor_completed_email on public.guarantor_verifications;
create trigger on_guarantor_completed_email
  after insert on public.guarantor_verifications
  for each row execute function public.email_on_guarantor_completed();

-- -------------------------------------------------------------- the probe --

/**
 * Whether this database will email the applicant when their guarantor finishes.
 *
 * ⚠ Checks the kind AND the trigger, because either alone is silent.
 *
 *   A trigger without the permitted kind aborts the guarantor's submission; a
 *   permitted kind without the trigger simply never sends. Neither has a symptom
 *   anybody would attribute to this migration, which is what the deployment
 *   panel is for.
 */
create or replace function public.guarantor_completed_email_installed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from pg_catalog.pg_trigger t
       where t.tgrelid = 'public.guarantor_verifications'::regclass
         and t.tgname = 'on_guarantor_completed_email'
         and not t.tgisinternal
    )
    and exists (
      select 1 from pg_catalog.pg_constraint c
       where c.conrelid = 'public.email_outbox'::regclass
         and c.conname = 'email_outbox_kind_check'
         and pg_catalog.pg_get_constraintdef(c.oid) like '%guarantor_completed%'
    );
$$;

revoke all on function public.guarantor_completed_email_installed() from public, anon;
grant execute on function public.guarantor_completed_email_installed() to authenticated, service_role;

notify pgrst, 'reload schema';


-- ############################################################################
-- the ledger
-- ############################################################################

/*
  ⚠ Recorded so these six cannot run twice, not as a claim that the ledger is now
    correct.

    53 is in the list because it is already applied on this database — its
    functions are all present — but was never recorded, which is exactly the
    state that makes `db push` dangerous. 20–48 are still unrecorded and some of
    them are only partly applied; reconciling those is a separate job, and until
    it is done `supabase db push` must not be run against this project.

  `on conflict do nothing` so re-running this whole file is harmless.
*/
insert into supabase_migrations.schema_migrations (version, name) values
  ('20250101000049', 'notifications'),
  ('20250101000051', 'guarantor_full_form'),
  ('20250101000052', 'guarantor_columns_nullable'),
  ('20250101000053', 'email_dispatch_repair'),
  ('20250101000054', 'guarantor_link_window'),
  ('20250101000055', 'guarantor_invite_payload_refresh'),
  ('20250101000066', 'guarantor_completed_email')
on conflict (version) do nothing;

-- ############################################################################
-- the check
-- ############################################################################

/*
  Read this row. Every boolean must be true and `next_step` must say "Clear".
  If it does not, nothing below it was wrong — the script is transactional, so a
  failure anywhere means none of it applied and this never printed at all.
*/
with probe as (
  select
    to_regclass('public.notifications')                                is not null as m49_table,
    to_regprocedure('public.queue_notification(uuid,text,text,text,text,jsonb,boolean)')
                                                                       is not null as m49_queue,
    to_regclass('public.guarantor_documents')                          is not null as m51_documents,
    to_regprocedure('public.guarantor_document_slot(text,text)')       is not null as m51_slot,
    to_regprocedure('public.guarantor_document_recorded(text,text,text,text,integer)')
                                                                       is not null as m51_recorded,
    to_regprocedure('public.complete_guarantor_verification(text,jsonb,text,text)')
                                                                       is not null as m51_complete_new,
    to_regprocedure('public.complete_guarantor_verification(text,text,text,text)')
                                                                           is null as m51_complete_old_gone,
    exists (select 1 from storage.buckets where id = 'guarantor-identity')          as m51_bucket,
    coalesce((select not public from storage.buckets where id = 'guarantor-identity'), false)
                                                                                   as m51_bucket_private,
    exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
              and policyname='admins read guarantor identity files')                as m51_policy,
    (select count(*) from information_schema.columns
      where table_schema='public' and table_name='guarantor_verifications'
        and column_name in ('full_name','whatsapp_phone','email','residential_address',
                            'relationship','known_duration','employment_status',
                            'company_name','job_title','declaration_text','signature_name'))
                                                                                   as m51_new_columns,
    coalesce(public.driver_application_guarantor_optional(), false)                 as m52_nullable,
    (select public.guarantor_invitation_window() = interval '30 days')              as m54_window,
    to_regprocedure('public.guarantor_invite_dates_current()')          is not null as m55_probe,
    coalesce(public.guarantor_completed_email_installed(), false)                   as m66_driver_email,
    (select count(*) from public.guarantor_verifications)                          as verifications,
    (select count(*) from public.guarantor_invitations)                            as invitations,
    (select count(*) from public.driver_applications)                             as applications
)
select *,
  case
    when not m49_table or not m49_queue        then 'Migration 49 did not land — guarantor submits would fail at runtime.'
    when not m51_documents or not m51_slot
      or not m51_recorded                      then 'Migration 51 is incomplete — uploads will still fail.'
    when not m51_complete_new                  then 'The new complete_guarantor_verification is missing — nobody can submit the form.'
    when not m51_complete_old_gone             then 'The old 4-argument complete_guarantor_verification is still here — two functions, one name.'
    when not m51_bucket                        then 'The guarantor-identity bucket was not created — uploads have nowhere to go.'
    when not m51_bucket_private                then 'The guarantor-identity bucket is PUBLIC. Make it private before anyone uploads an ID.'
    when not m51_policy                        then 'No storage read policy — a reviewer gets a signed URL that 404s.'
    when m51_new_columns < 11                  then 'guarantor_verifications is missing columns 51 adds — the review card will show blanks.'
    when not m52_nullable                      then 'The three guarantor columns are still NOT NULL — submissions will fail with 23502.'
    when not m54_window                        then 'The invitation window is not 30 days.'
    when not m55_probe                         then 'Migration 55 did not land.'
    when not m66_driver_email                  then 'The applicant will not be emailed when their guarantor finishes.'
    else 'Clear — guarantor upload, submission, review, the 30-day link and the applicant''s email all have what they need.'
  end as next_step
from probe;
