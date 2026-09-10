-- ============================================================================
-- 20250101000038_transactional_email.sql — the outbox, and the seven events that fill it
-- ============================================================================
--
-- ⚠ Every email goes through a table first, and that is the whole design.
--
--   The obvious implementation is a trigger that calls pg_net directly. It is
--   also the one that sends a driver two rejection emails, because:
--
--     * `after update` fires on *every* update, including one that rewrites
--       `status` to the value it already had, and including an unrelated column
--       changing on the same row;
--     * pg_net is fire-and-forget, so a failed request is indistinguishable
--       from a slow one and the natural fix — retry — doubles the send;
--     * an admin double-clicking Approve is one HTTP request in the browser and
--       two `update` statements often enough to matter.
--
--   `email_outbox` has a unique key on (kind, subject_id). A second attempt
--   conflicts and inserts nothing, so the dispatch trigger never fires. Exactly
--   once, enforced by the database rather than by everybody remembering.
--
--   It also leaves a record. "Did they get the email?" is currently answered by
--   asking Resend; after this it is a select.
--
-- ⚠ What is deliberately *not* here: a payment receipt.
--
--   LOCI has no payment provider, no charge record and no `paid` state on a
--   booking. `delivery_completed` carries the fare breakdown and is titled a
--   summary, not a receipt — a document headed "Receipt" for money this system
--   never witnessed is one somebody may hand to an accountant or a court.
--
-- Deploy:
--   supabase functions deploy notify-events
--   supabase secrets set RESEND_API_KEY="re_..."
--   supabase secrets set LOCI_FROM_EMAIL="LOCI <noreply@yourdomain.com>"
--   -- then set the two settings at the bottom of this file.

-- --------------------------------------------------------------- the outbox --

create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),

  /* Which email. Checked, so a typo in a trigger fails at write time. */
  kind text not null check (kind in (
    'driver_application_approved',
    'driver_application_rejected',
    'guarantor_invitation',
    'sender_verification_submitted',
    'sender_verified',
    'delivery_completed',
    'parcel_cancelled',
    'parcel_status_changed',
    'driver_offer',
    'driver_job_cancelled',
    'payout_paid'
  )),

  /*
   * The row this email is about: an application id, a booking id, a payout id.
   *
   * ⚠ Half of the uniqueness guarantee, and it has to be chosen carefully.
   *
   *   For a decision email the application id is right — one decision, one
   *   email, and a later re-approval should not re-send. For a parcel *status*
   *   email the booking id alone would send once ever and stay silent for every
   *   later stage, so those triggers append the status to the subject.
   */
  subject_id text not null,

  recipient text not null,

  /*
   * Everything the template needs, resolved at trigger time.
   *
   * ⚠ Snapshotted rather than re-read when the email is sent.
   *
   *   The function could look the booking up again, but the row may have moved
   *   on between the trigger and the send — a parcel cancelled seconds after
   *   delivery would produce a "delivered" email describing a cancelled parcel.
   *   The payload is what was true when the thing happened, which is what the
   *   email is about.
   */
  payload jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  sent_at timestamptz,
  /* Null while unsent and after a success; the provider's message otherwise. */
  error text,
  attempts integer not null default 0,

  /* The exactly-once guarantee. */
  unique (kind, subject_id)
);

create index if not exists email_outbox_unsent_idx
  on public.email_outbox (created_at)
  where sent_at is null;

alter table public.email_outbox enable row level security;

/*
 * ⚠ No policy for anyone but an admin, and none at all for writes.
 *
 *   Rows here carry a recipient address and a payload describing somebody's
 *   parcel. Everything that writes this table is `security definer` below, so
 *   there is no legitimate client insert to allow — and a client that could
 *   insert could email an arbitrary address from a LOCI-signed domain.
 */
drop policy if exists "admins read the outbox" on public.email_outbox;
create policy "admins read the outbox"
  on public.email_outbox for select
  using (public.is_admin());

-- ------------------------------------------------------------- the dispatch --

/*
 * Where the edge function lives, and the key that gets past its gate.
 *
 * Read from settings rather than hardcoded so a staging project does not email
 * production's customers. Both are set at the bottom of this file.
 */
create or replace function public.email_setting(name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(current_setting(name, true), '');
$$;

/*
 * Posts one outbox row to the edge function.
 *
 * ⚠ Fires on insert only, and the insert is already deduplicated.
 *
 *   `on conflict do nothing` in the queue helpers below means a repeat attempt
 *   inserts no row, so this never runs a second time for the same email. That
 *   is the join between the two halves of the guarantee.
 */
create or replace function public.dispatch_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text := public.email_setting('app.settings.functions_url');
  service_key text := public.email_setting('app.settings.service_role_key');
begin
  /*
   * ⚠ Unconfigured is silent, and the row stays queued.
   *
   *   A project without these settings — a fresh clone, a PGlite test, a
   *   staging database — should not fail the *business* transaction that
   *   triggered the email. Approving a driver must not roll back because a mail
   *   setting is missing. The row sits with `sent_at is null`, which is both
   *   the retry queue and the evidence.
   */
  if endpoint is null or service_key is null then
    return new;
  end if;

  perform net.http_post(
    url := endpoint || '/notify-events',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object('outbox_id', new.id)
  );

  return new;
exception
  /*
   * pg_net missing, or the call failing, must not undo the delivery that was
   * just recorded. The row remains unsent and can be swept.
   */
  when others then
    return new;
end;
$$;

drop trigger if exists on_email_queued on public.email_outbox;
create trigger on_email_queued
  after insert on public.email_outbox
  for each row execute function public.dispatch_email();

-- ----------------------------------------------------------- queue helpers --

/*
 * Adds one email, or does nothing if it is already there.
 *
 * ⚠ `on conflict do nothing` is the point, not a convenience.
 *
 *   Read the comment on `email_outbox.subject_id`. Everything below relies on
 *   this being idempotent, because triggers on a status column cannot be.
 */
create or replace function public.queue_email(
  p_kind text,
  p_subject_id text,
  p_recipient text,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  /*
   * ⚠ No recipient means no row.
   *
   *   An outbox row with a null or empty address is one the function will pick
   *   up, fail on, and record an error against — noise that looks like a
   *   provider problem. Not queueing is the honest handling of "we have no way
   *   to reach this person".
   */
  if p_recipient is null or btrim(p_recipient) = '' then
    return;
  end if;

  insert into public.email_outbox (kind, subject_id, recipient, payload)
  values (p_kind, p_subject_id, btrim(p_recipient), coalesce(p_payload, '{}'::jsonb))
  on conflict (kind, subject_id) do nothing;
end;
$$;

/*
 * The address for an account.
 *
 * `auth.users` is not readable by anything but a definer function, which is why
 * this exists rather than a join in each trigger.
 */
create or replace function public.email_for_user(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email from auth.users u where u.id = p_user;
$$;

-- ============================================================================
-- 1. Account and verification lifecycle
-- ============================================================================

/*
 * A decision on a driver application.
 *
 * ⚠ Guarded on the *transition*, though the unique key is the real guarantee.
 *
 *   Written first as if this check were what prevents a duplicate. It is not:
 *   a no-op write reaches `queue_email`, conflicts on (kind, subject_id) and
 *   inserts nothing either way. Proved by removing this guard and watching the
 *   harness stay green.
 *
 *   It earns its place for two smaller reasons — it avoids an index probe on
 *   every status write, and it stops the `else` branch of the booking trigger
 *   treating a no-op save as a stage change. The exactly-once promise belongs
 *   to the constraint, and saying otherwise here would send somebody looking
 *   in the wrong place when a duplicate does appear.
 */
create or replace function public.email_on_application_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'approved' then
    perform public.queue_email(
      'driver_application_approved',
      new.id::text,
      new.email,
      jsonb_build_object(
        'full_name', new.full_name,
        'reference', new.reference,
        'base_city', new.base_city
      )
    );

  elsif new.status = 'rejected' then
    perform public.queue_email(
      'driver_application_rejected',
      new.id::text,
      new.email,
      jsonb_build_object(
        'full_name', new.full_name,
        'reference', new.reference,
        /*
         * ⚠ The reason, when there is one, and never invented when there is not.
         *
         *   A rejection with no explanation is the one people reply to, and
         *   support cannot answer because the reason was never recorded. The
         *   template says so plainly rather than inventing a cause.
         */
        'reason', new.review_note
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists on_application_decision on public.driver_applications;
create trigger on_application_decision
  after update of status on public.driver_applications
  for each row execute function public.email_on_application_decision();

/*
 * A sender's identity check has come back clean.
 *
 * ⚠ Not "approved by an admin", because nothing here is.
 *
 *   The brief described this as an admin approval. It is not: `verify-identity`
 *   moves the status automatically on the provider's answer, and an admin is
 *   involved only for a `flagged` result. The email fires on the transition
 *   that actually exists, and says what actually happened.
 *
 * ⚠ Nothing is sent for `flagged`.
 *
 *   That outcome means a check disagreed with itself and a person has to look.
 *   Telling somebody "your verification failed" before anyone has reviewed it
 *   is both premature and, often enough, wrong — a NIMC photo eight years old
 *   is the commonest cause.
 */
/*
 * A sender has just submitted their NIN and slip.
 *
 * ⚠ On the way *into* `pending`, which is what submission means.
 *
 *   `begin_identity_check` writes the NIN, the slip path and `status =
 *   'pending'` in one statement, so this transition is the submission. Firing
 *   on the insert instead would miss every sender who submits a second time
 *   after being flagged — the row already exists by then.
 *
 * ⚠ Separate from the verdict email, not a replacement for it.
 *
 *   The two answer different questions. This one says "we have it"; the other
 *   says "it passed". A sender who receives only the second learns nothing for
 *   however long the check takes, and a sender who receives only the first is
 *   left wondering forever.
 */
create or replace function public.email_on_identity_submitted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status or new.status <> 'pending' then
    return new;
  end if;

  perform public.queue_email(
    'sender_verification_submitted',
    /*
     * ⚠ Keyed with the submission time, not on the user alone.
     *
     *   A sender who is flagged and submits again is making a second, real
     *   submission and should be told it was received. Keyed on the user id
     *   only, the unique constraint would swallow every attempt after the
     *   first — and the person most in need of the reassurance is the one on
     *   their second try.
     */
    new.user_id::text || ':' || to_char(now(), 'YYYYMMDDHH24MISS'),
    public.email_for_user(new.user_id),
    jsonb_build_object('submitted_at', now())
  );

  return new;
end;
$$;

drop trigger if exists on_identity_submitted on public.sender_identity;
create trigger on_identity_submitted
  after update of status on public.sender_identity
  for each row execute function public.email_on_identity_submitted();

create or replace function public.email_on_sender_verified()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status or new.status <> 'verified' then
    return new;
  end if;

  perform public.queue_email(
    'sender_verified',
    new.user_id::text,
    public.email_for_user(new.user_id),
    /*
     * ⚠ No NIN in the payload, not even the last four.
     *
     *   The outbox is a table an admin can read and a payload that ends up at a
     *   mail provider. There is no sentence in this email that needs the
     *   number, so it does not travel.
     */
    jsonb_build_object('verified_at', now())
  );

  return new;
end;
$$;

drop trigger if exists on_sender_verified on public.sender_identity;
create trigger on_sender_verified
  after update of status on public.sender_identity
  for each row execute function public.email_on_sender_verified();

-- ============================================================================
-- 2. Parcel lifecycle, for senders
-- ============================================================================

/*
 * Delivered, cancelled, or moved to another stage.
 *
 * ⚠ Three emails from one trigger, and the subject key differs between them.
 *
 *   Delivery and cancellation happen once per parcel, so the booking id is the
 *   right key. An ordinary stage change happens five times, so its key carries
 *   the status — otherwise the first "picked up" email would be the only one a
 *   sender ever received.
 *
 * ⚠ The proof-of-delivery photo is linked to, never attached or signed.
 *
 *   It sits in a private bucket and shows a doorway, sometimes a person. A
 *   signed URL in an email is readable by anyone the email is forwarded to,
 *   for as long as it lives. The link goes to the parcel screen, which is
 *   behind the sign-in the sender already has.
 */
create or replace function public.email_on_booking_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sender_email text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  /*
   * ⚠ `sender_id`, not `user_id`.
   *
   *   Written as `user_id` first, from memory. plpgsql resolves record fields
   *   at run time rather than at CREATE, so that would have thrown on the first
   *   real delivery instead of when the migration was applied. Checked against
   *   the table rather than trusted. (`sender_identity.user_id` above is
   *   correct — the two tables genuinely differ.)
   */
  sender_email := public.email_for_user(new.sender_id);

  if new.status = 'Delivered' then
    perform public.queue_email(
      'delivery_completed',
      new.id::text,
      sender_email,
      jsonb_build_object(
        'tracking_id', new.tracking_id,
        'delivered_at', now(),
        'recipient_name', new.recipient_name,
        'driver_name', new.driver,
        /*
         * The fare, so the email doubles as the summary the brief asked for as
         * a "receipt". It is what was owed, and it is labelled that way.
         */
        'fare', new.estimated_fee,
        'has_proof', new.proof_path is not null
      )
    );

  elsif new.status = 'Cancelled' then
    perform public.queue_email(
      'parcel_cancelled',
      new.id::text,
      sender_email,
      jsonb_build_object(
        'tracking_id', new.tracking_id,
        'cancelled_at', now(),
        'reason', new.cancellation_reason,
        'cancelled_by', new.cancelled_role
      )
    );

    /*
     * ⚠ And the driver, if one was carrying it.
     *
     *   A driver who has accepted a job and set off needs to know it is off
     *   before they arrive. This is the "delivery cancelled" half of the
     *   brief's driver lifecycle, and it fires from the same transition rather
     *   than from a second trigger that could disagree about when a
     *   cancellation happened.
     */
    if new.driver_id is not null then
      perform public.queue_email(
        'driver_job_cancelled',
        new.id::text,
        public.email_for_user(new.driver_id),
        jsonb_build_object(
          'tracking_id', new.tracking_id,
          'cancelled_at', now(),
          'route', coalesce(new.origin_city, '') || ' to ' || coalesce(new.destination_city, '')
        )
      );
    end if;

  else
    perform public.queue_email(
      'parcel_status_changed',
      new.id::text || ':' || new.status,
      sender_email,
      jsonb_build_object(
        'tracking_id', new.tracking_id,
        'status', new.status,
        'changed_at', now()
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists on_booking_status_email on public.bookings;
create trigger on_booking_status_email
  after update of status on public.bookings
  for each row execute function public.email_on_booking_status();

-- ============================================================================
-- 3. Job lifecycle, for drivers
-- ============================================================================

/*
 * A parcel has been offered to this driver.
 *
 * ⚠ Email *and* push, independently.
 *
 *   `notify-offer` already sends a push notification, and that stays where it
 *   is. Both exist because an offer expires: a driver whose phone is on charge
 *   in another room misses the push and loses the job to the rotation. Nothing
 *   here touches that function, so a mail outage cannot cost a push.
 */
create or replace function public.email_on_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parcel record;
begin
  select b.tracking_id, b.origin_city, b.destination_city, b.estimated_fee
    into parcel
    from public.bookings b
   where b.id = new.booking_id;

  perform public.queue_email(
    'driver_offer',
    new.id::text,
    public.email_for_user(new.driver_id),
    jsonb_build_object(
      'tracking_id', parcel.tracking_id,
      'route', coalesce(parcel.origin_city, '') || ' to ' || coalesce(parcel.destination_city, ''),
      'fare', parcel.estimated_fee,
      'expires_at', new.expires_at
    )
  );

  return new;
end;
$$;

drop trigger if exists on_offer_email on public.dispatch_offers;
create trigger on_offer_email
  after insert on public.dispatch_offers
  for each row execute function public.email_on_offer();

-- ============================================================================
-- 4. Money, for drivers
-- ============================================================================

/*
 * A payout has actually left.
 *
 * ⚠ Only `paid`, and only on the transition into it.
 *
 *   'requested' is the driver pressing a button and needs no email — they are
 *   looking at the screen that says so. 'failed' and 'cancelled' are support
 *   conversations where a templated email would arrive before anyone knew what
 *   to tell them.
 */
create or replace function public.email_on_payout_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status or new.status <> 'paid' then
    return new;
  end if;

  perform public.queue_email(
    'payout_paid',
    new.id::text,
    public.email_for_user(new.driver_id),
    jsonb_build_object(
      'amount', new.amount,
      'paid_at', now(),
      /*
       * ⚠ Last four digits only, and the column already stores it masked.
       *
       *   Enough for a driver to tell which account it went to, and not enough
       *   for the email to be worth intercepting.
       */
      'account_hint', right(coalesce(new.account_number, ''), 4)
    )
  );

  return new;
end;
$$;

drop trigger if exists on_payout_paid on public.payout_requests;
create trigger on_payout_paid
  after update of status on public.payout_requests
  for each row execute function public.email_on_payout_paid();

-- --------------------------------------------------------------- settings ---

/*
 * Set these once per project. Without them nothing sends and every email
 * queues, which is the correct behaviour for a database that has not been told
 * where to send things.
 *
 *   alter database postgres
 *     set app.settings.functions_url = 'https://<ref>.supabase.co/functions/v1';
 *   alter database postgres
 *     set app.settings.service_role_key = '<service role key>';
 *
 * ⚠ The service key is in database settings, not in this file.
 *
 *   It is in the repository otherwise, and a repository is not a secret store.
 */

revoke all on function public.queue_email(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.email_for_user(uuid) from public, anon, authenticated;
revoke all on function public.email_setting(text) from public, anon, authenticated;
