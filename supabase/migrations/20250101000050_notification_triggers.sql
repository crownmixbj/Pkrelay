-- ============================================================================
-- 20250101000050_notification_triggers.sql — what fills the inbox, and what rings a phone
-- ============================================================================
--
-- Run after 49. Re-runnable.
--
-- 49 built the table and left it empty on purpose. This file is the other half:
-- eight triggers, two sweepers, and the pg_net call that turns a row into a
-- push.
--
-- ⚠ Read this before changing anything here: the offer path is NOT routed
--   through the new spine, and that is deliberate.
--
--   `notify_dispatch_offer` (19, fixed in 24) already pushes offers through
--   `notify-offer`, with a message tuned to the hold — `timeSensitive`, a ttl
--   that expires with the offer, a live countdown in the body. If this file
--   also queued a *pushable* notification for the same offer, every driver
--   would get two notifications for one job.
--
--   So `offer_received` is queued with `push_requested = false`. The inbox gets
--   the entry; `notify-offer` keeps sending the push it always sent. Nothing
--   about dispatch changes, which is the property that matters most in a file
--   that touches the `bookings` status path.
--
--   Folding `notify-offer` into this spine is a later migration, once
--   `notify-push` has demonstrably worked for a while. Doing both in one change
--   means a bug in the new sender is also a dispatch outage.
--
-- ⚠ The second rule this file follows: a notification must never abort the
--   transaction that produced it.
--
--   Every `after update` trigger below hangs off a business event — a parcel
--   being delivered, a payout being settled, an application being approved. If
--   any of them raises, that event does not happen. 24 is the file where this
--   went wrong before, and the shape of the fix is the same here: the pg_net
--   call is wrapped, and `queue_notification` is hardened below so a stale user
--   reference returns null instead of raising.
--
-- Deploy alongside:
--   supabase functions deploy notify-push
--   -- then set edge_url and service_key in private.app_settings (bottom of 24).

do $$
begin
  if to_regclass('public.notifications') is null then
    raise exception 'Run 20250101000049_notifications.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------- hardening ----

/*
 * Replaces 49's version. One behavioural change: a foreign key violation
 * returns null instead of raising.
 *
 * ⚠ Why this is not paranoia.
 *
 *   `bookings.sender_id` and `bookings.driver_id` are `on delete set null`, so
 *   an erased account normally leaves a null that the guard below already
 *   catches. But `erase_person` and a delivery completing are two transactions
 *   that can interleave, and `notifications.user_id` is `on delete cascade`
 *   against a row that may no longer be there by the time this insert lands.
 *
 *   Without this block that race aborts the AFTER UPDATE trigger, which aborts
 *   the status change, which means a parcel cannot be marked Delivered because
 *   somebody exercised their right to erasure a second earlier. Losing the
 *   notification is correct; losing the delivery is not.
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
  if p_user is null or p_kind is null or btrim(coalesce(p_title, '')) = '' then
    return null;
  end if;

  begin
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
  exception when foreign_key_violation then
    insert into public.app_events (level, area, message, context)
    values (
      'warning', 'notifications',
      'notification dropped: the recipient no longer exists',
      jsonb_build_object('kind', p_kind, 'subject', p_subject_id)
    );
    return null;
  end;

  return new_id;
end;
$$;

revoke all on function public.queue_notification(uuid, text, text, text, text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.queue_notification(uuid, text, text, text, text, jsonb, boolean)
  to service_role;

-- ------------------------------------------------------------- formatting ----

/*
 * ₦4,500, from 4500.00.
 *
 * In the database rather than the client because these strings are frozen into
 * `title` and `body` at trigger time and go out in a push — the app never gets
 * a chance to format them. `FM` strips the padding `to_char` adds by default,
 * which is otherwise a leading space nobody notices until it is on a lock
 * screen.
 */
create or replace function private.naira(amount numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select '₦' || to_char(round(coalesce(amount, 0)), 'FM999,999,999');
$$;

revoke all on function private.naira(numeric) from public, anon, authenticated;

-- ============================================================================
-- 1. Onboarding and account verification
-- ============================================================================

/*
 * The decision on a driver application.
 *
 * Mirrors `email_on_application_decision` in 38 — same trigger point, same
 * `is not distinct from` guard — because the two should never disagree about
 * when a decision happened. Email and push are independent on purpose: a
 * Resend outage must not cost the notification, and vice versa.
 */
create or replace function public.notify_on_application_decision()
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
    perform public.queue_notification(
      new.user_id, 'application_approved', new.id::text,
      'You are approved to drive',
      'Your driver application has been approved. Open Package Relay to go online and start receiving jobs.',
      jsonb_build_object('application_id', new.id, 'base_city', new.base_city),
      true
    );

  elsif new.status = 'rejected' then
    perform public.queue_notification(
      new.user_id, 'application_rejected', new.id::text,
      'Your driver application was not approved',
      /*
       * ⚠ The reason when there is one, and nothing invented when there is not.
       *
       *   38 makes the same point about the email. A rejection with a
       *   fabricated cause is worse than one with none: support cannot retract
       *   a reason the system made up.
       */
      coalesce(nullif(btrim(new.review_note), ''), 'Open Package Relay for details, or contact support.'),
      jsonb_build_object('application_id', new.id),
      true
    );

  elsif new.status = 'under_review' then
    /*
     * Inbox only. "We are looking at it" is worth recording and not worth a
     * buzz — there is nothing the applicant can do in response to it.
     */
    perform public.queue_notification(
      new.user_id, 'application_under_review', new.id::text,
      'Your application is under review',
      'We have everything we need. You will hear from us once a reviewer has looked at it.',
      jsonb_build_object('application_id', new.id),
      false
    );
  end if;

  return new;
end;
$$;

drop trigger if exists on_application_decision_notify on public.driver_applications;
create trigger on_application_decision_notify
  after update of status on public.driver_applications
  for each row execute function public.notify_on_application_decision();

/*
 * The sender's identity check came back.
 */
create or replace function public.notify_on_sender_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'verified' then
    perform public.queue_notification(
      new.user_id, 'sender_verified', new.user_id::text,
      'You are verified',
      'Your identity has been confirmed. You can now book parcels.',
      '{}'::jsonb, true
    );

  elsif new.status = 'rejected' then
    perform public.queue_notification(
      new.user_id, 'sender_rejected', new.user_id::text,
      'We could not verify your identity',
      /* The check constraint guarantees a rejection carries a note. */
      coalesce(nullif(btrim(new.review_note), ''), 'Open Package Relay for details.'),
      '{}'::jsonb, true
    );
  end if;

  return new;
end;
$$;

drop trigger if exists on_sender_identity_notify on public.sender_identity;
create trigger on_sender_identity_notify
  after update of status on public.sender_identity
  for each row execute function public.notify_on_sender_identity();

/*
 * Someone signed up, never confirmed their email, and is stuck.
 *
 * ⚠ A sweeper, not a trigger on `auth.users`.
 *
 *   The obvious implementation watches `email_confirmed_at` flipping. It is
 *   also a trigger on the table Supabase signs people up through, and a trigger
 *   there that raises breaks signup for everybody — the single most expensive
 *   failure available in this schema, in exchange for telling someone something
 *   they are already looking at (the confirmation screen redirects them into
 *   the app two seconds later).
 *
 *   The state actually worth a notification is the opposite one: signed up,
 *   started an application, and never came back. That needs a clock, which a
 *   trigger does not have.
 *
 * Once per person, ever — `subject_id` is the user id.
 */
create or replace function public.sweep_unconfirmed_emails()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stuck record;
  queued integer := 0;
begin
  for stuck in
    select u.id
      from auth.users u
     where u.email_confirmed_at is null
       and u.created_at < now() - interval '24 hours'
       and u.created_at > now() - interval '30 days'
       and u.deleted_at is null
       /*
        * Only people who started something. A drive-by signup that never
        * touched an application is not owed a reminder, and chasing one reads
        * as spam.
        */
       and exists (select 1 from public.driver_applications a where a.user_id = u.id)
  loop
    if public.queue_notification(
         stuck.id, 'email_confirmation_pending', stuck.id::text,
         'Confirm your email to finish signing up',
         'Your driver application cannot be reviewed until your email address is confirmed. Check your inbox for the link.',
         '{}'::jsonb, true
       ) is not null
    then
      queued := queued + 1;
    end if;
  end loop;

  return queued;
end;
$$;

-- ============================================================================
-- 2. Job matching and dispatch
-- ============================================================================

/*
 * An offer was made to this driver.
 *
 * ⚠ `push_requested => false`. This is the double-push guard from the header.
 *
 *   `notify_dispatch_offer` on the same table already sends the push. This row
 *   exists so the offer appears in the notification centre alongside
 *   everything else, and so there is one record of it after it expires.
 */
create or replace function public.notify_on_dispatch_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parcel record;
  route text;
begin
  select b.tracking_id, b.origin_city, b.destination_city, b.weight, b.estimated_fee
    into parcel
    from public.bookings b
   where b.id = new.booking_id;

  route := case
    when parcel.origin_city is not distinct from parcel.destination_city
      then 'Local job in ' || coalesce(parcel.origin_city, 'your city')
    else coalesce(parcel.origin_city, '?') || ' → ' || coalesce(parcel.destination_city, '?')
  end;

  perform public.queue_notification(
    new.driver_id, 'offer_received', new.id::text,
    'Trip offered',
    route || ' · ' || coalesce(parcel.weight, 0) || ' kg · ' || private.naira(parcel.estimated_fee),
    jsonb_build_object(
      'offer_id', new.id,
      'booking_id', new.booking_id,
      'tracking_id', parcel.tracking_id,
      'expires_at', new.expires_at
    ),
    false
  );

  return new;
end;
$$;

drop trigger if exists on_offer_notify on public.dispatch_offers;
create trigger on_offer_notify
  after insert on public.dispatch_offers
  for each row execute function public.notify_on_dispatch_offer();

/*
 * The offer ran out.
 *
 * ⚠ Inbox only, and this one is a product decision rather than a technical one.
 *
 *   `expire_dispatch_offers` runs every minute. A push for every lapsed offer
 *   is a phone buzzing all night to report jobs the driver has already lost —
 *   the fastest way to have notifications turned off at the OS level, which
 *   then silently costs you the offers too.
 *
 * `accepted` and `declined` are not notified at all: the driver performed both,
 * and acceptance produces an `Assigned` status change that notifies properly.
 */
create or replace function public.notify_on_offer_expired()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status or new.status <> 'expired' then
    return new;
  end if;

  perform public.queue_notification(
    new.driver_id, 'offer_expired', new.id::text,
    'A trip offer expired',
    'The job was offered to another driver. Stay online to receive the next one.',
    jsonb_build_object('offer_id', new.id, 'booking_id', new.booking_id),
    false
  );

  return new;
end;
$$;

drop trigger if exists on_offer_expired_notify on public.dispatch_offers;
create trigger on_offer_expired_notify
  after update of status on public.dispatch_offers
  for each row execute function public.notify_on_offer_expired();

-- ============================================================================
-- 3. Pickup and transit milestones
-- ============================================================================

/*
 * A parcel moved. Both sides hear about it, for different reasons.
 *
 * Structured as if/elsif on the terminal states first, exactly like
 * `email_on_booking_status` — otherwise Delivered produces both a
 * `parcel_status_changed` and a `delivery_completed` for the same sender.
 *
 * ⚠ Which transitions push, and why the driver mostly does not get one.
 *
 *   Picked Up, In Transit and Out for Delivery are set by the driver tapping a
 *   button in `advance_booking`. Pushing those back to them is a notification
 *   that says "you just did that", arriving while the screen that did it is
 *   still open. The sender, who cannot see any of it, is the one who needs
 *   telling.
 */
create or replace function public.notify_on_booking_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  route text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  route := coalesce(new.origin_city, '?') || ' → ' || coalesce(new.destination_city, '?');

  -- ---------------------------------------------------------- terminal ----
  if new.status = 'Delivered' then
    perform public.queue_notification(
      new.sender_id, 'delivery_completed', new.id::text,
      'Parcel ' || new.tracking_id || ' was delivered',
      case
        when coalesce(btrim(new.received_by), '') <> ''
          then 'Received by ' || new.received_by || '.'
        else 'Your parcel has been delivered.'
      end,
      jsonb_build_object(
        'booking_id', new.id,
        'tracking_id', new.tracking_id,
        'has_proof', new.proof_path is not null
      ),
      true
    );

    perform public.queue_notification(
      new.driver_id, 'delivery_completed', new.id::text,
      'Delivery confirmed',
      'Parcel ' || new.tracking_id || ' is complete. ' ||
        private.naira(new.estimated_fee) || ' gross — your earning is on the way to your wallet.',
      jsonb_build_object('booking_id', new.id, 'tracking_id', new.tracking_id),
      true
    );

  elsif new.status = 'Cancelled' then
    perform public.queue_notification(
      new.sender_id, 'parcel_cancelled', new.id::text,
      'Parcel ' || new.tracking_id || ' was cancelled',
      coalesce(nullif(btrim(new.cancellation_reason), ''), 'The booking has been cancelled.'),
      jsonb_build_object('booking_id', new.id, 'tracking_id', new.tracking_id),
      true
    );

    /*
     * ⚠ The driver half, and it is the one that matters most in this function.
     *
     *   A driver who has accepted a job and set off needs to know it is off
     *   before they arrive. This is the one cancellation notification that is
     *   worth waking a phone for.
     */
    perform public.queue_notification(
      new.driver_id, 'job_cancelled', new.id::text,
      'Job cancelled',
      route || ' has been cancelled. Do not continue to the pickup.',
      jsonb_build_object('booking_id', new.id, 'tracking_id', new.tracking_id),
      true
    );

  -- ------------------------------------------------------- in progress ----
  else
    /*
     * The sender, for every stage. `subject_id` carries the status, so each
     * stage notifies once and a repeated write of the same status does not.
     */
    perform public.queue_notification(
      new.sender_id, 'parcel_status_changed', new.id::text || ':' || new.status,
      'Parcel ' || new.tracking_id || ' is ' || lower(new.status),
      case new.status
        when 'Assigned'         then coalesce(new.driver, 'A driver') || ' is handling your parcel.'
        when 'Picked Up'        then 'Your parcel has been collected.'
        when 'In Transit'       then 'Your parcel is on its way — ' || route || '.'
        when 'Out for Delivery' then 'Your parcel is out for delivery.'
        else 'Status updated to ' || new.status || '.'
      end,
      jsonb_build_object(
        'booking_id', new.id, 'tracking_id', new.tracking_id, 'status', new.status
      ),
      /*
       * Assigned and Out for Delivery are the two a sender acts on — one tells
       * them somebody is coming, the other tells them to be reachable. The
       * middle stages are for the tracking screen, not the lock screen.
       */
      new.status in ('Assigned', 'Out for Delivery')
    );

    /* The driver only hears about the transition they did not cause. */
    if new.status = 'Assigned' then
      perform public.queue_notification(
        new.driver_id, 'job_assigned', new.id::text,
        'Job assigned',
        route || ' · ' || private.naira(new.estimated_fee) ||
          '. Head to the pickup and mark it collected in the app.',
        jsonb_build_object('booking_id', new.id, 'tracking_id', new.tracking_id),
        true
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists on_booking_status_notify on public.bookings;
create trigger on_booking_status_notify
  after update of status on public.bookings
  for each row execute function public.notify_on_booking_status();

/*
 * A job that was accepted and then sat there.
 *
 * ⚠ Needs a clock, so it is a sweeper. A trigger fires when something happens;
 *   this fires because nothing did.
 *
 * Once per booking, ever — `subject_id` is the booking id, so a parcel that
 * stays Assigned for six hours produces one reminder rather than twenty-four.
 * The follow-up for a driver who never moves is an ops problem, not a louder
 * notification.
 */
create or replace function public.sweep_pickup_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  job record;
  queued integer := 0;
begin
  for job in
    select b.id, b.tracking_id, b.driver_id, b.pickup_area, b.origin_city
      from public.bookings b
     where b.status = 'Assigned'
       and b.driver_id is not null
       and b.accepted_at is not null
       and b.accepted_at < now() - interval '30 minutes'
       /* Not worth chasing a job from last week. */
       and b.accepted_at > now() - interval '2 days'
  loop
    if public.queue_notification(
         job.driver_id, 'pickup_reminder', job.id::text,
         'Pickup still outstanding',
         'Parcel ' || job.tracking_id || ' is waiting at ' ||
           coalesce(nullif(btrim(job.pickup_area), ''), coalesce(job.origin_city, 'the pickup point')) ||
           '. Mark it collected once you have it.',
         jsonb_build_object('booking_id', job.id, 'tracking_id', job.tracking_id),
         true
       ) is not null
    then
      queued := queued + 1;
    end if;
  end loop;

  return queued;
end;
$$;

-- ============================================================================
-- 4. Completion and payouts
-- ============================================================================

/*
 * The earning landed in the wallet.
 *
 * ⚠ Inbox only, and this is the one place two notifications would be indefensible.
 *
 *   `record_delivery_earning` fires from the same `Delivered` update that
 *   produced the driver's `delivery_completed` push seconds earlier. Two buzzes
 *   for one delivery is how a driver learns to ignore the first one. The money
 *   detail belongs in the inbox entry, where they look when they care about it.
 */
create or replace function public.notify_on_driver_earning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.queue_notification(
    new.driver_id, 'earning_recorded', new.booking_id::text,
    private.naira(new.net) || ' added to your wallet',
    private.naira(new.gross) || ' gross, less ' || private.naira(new.commission) ||
      ' commission. Request a payout once you are above the minimum.',
    jsonb_build_object(
      'booking_id', new.booking_id,
      'gross', new.gross, 'commission', new.commission, 'net', new.net
    ),
    false
  );

  return new;
end;
$$;

drop trigger if exists on_driver_earning_notify on public.driver_earnings;
create trigger on_driver_earning_notify
  after insert on public.driver_earnings
  for each row execute function public.notify_on_driver_earning();

/*
 * A payout was settled.
 *
 * ⚠ The wording here is load-bearing, and it is not the wording the brief asked
 *   for.
 *
 *   There is no payment provider in this schema. `settle_payout` is an admin
 *   recording a bank transfer they made by hand, and the database never
 *   witnesses the money moving. "Your wallet has been credited" is a statement
 *   this system cannot support, and a driver who reads it and finds no money is
 *   owed an explanation nobody can give. "Marked as paid, with a reference" is
 *   both true and more useful, because the reference is what a bank dispute
 *   needs.
 *
 *   38 makes the same argument about not titling an email "Receipt".
 */
create or replace function public.notify_on_payout_settled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'paid' then
    perform public.queue_notification(
      new.driver_id, 'payout_paid', new.id::text,
      private.naira(new.amount) || ' payout marked as paid',
      'Sent to ' || coalesce(new.bank_name, 'your bank') ||
        case
          when coalesce(btrim(new.reference), '') <> ''
            then ' · ref ' || new.reference
          else ''
        end ||
        '. Allow a little time for your bank to post it.',
      jsonb_build_object('payout_id', new.id, 'amount', new.amount, 'reference', new.reference),
      true
    );

  elsif new.status = 'failed' then
    perform public.queue_notification(
      new.driver_id, 'payout_failed', new.id::text,
      'Your payout could not be sent',
      coalesce(nullif(btrim(new.failure_reason), ''),
               'Check your payout account details and try again.') ||
        ' The ' || private.naira(new.amount) || ' is still in your wallet.',
      jsonb_build_object('payout_id', new.id, 'amount', new.amount),
      true
    );
  end if;

  return new;
end;
$$;

drop trigger if exists on_payout_settled_notify on public.payout_requests;
create trigger on_payout_settled_notify
  after update of status on public.payout_requests
  for each row execute function public.notify_on_payout_settled();

-- ============================================================================
-- The push dispatch
-- ============================================================================

/*
 * Posts one notification id to `notify-push`, the moment the row appears.
 *
 * ⚠ This is 24's shape, deliberately, and not 38's.
 *
 *   `dispatch_email` in 38 calls `net.http_post` with the schema hardcoded and
 *   reads its configuration from `current_setting('app.settings.*')`. 24 exists
 *   because the hardcoded schema is a coin flip across Supabase projects, and
 *   settled on `private.pg_net_post_fn()` plus `private.app_settings`. This
 *   file follows 24. (The divergence in 38 is real and worth reconciling —
 *   separately, in a file that is only about that.)
 *
 * ⚠ Ids only in the body. The title and body are already written down in the
 *   row; sending them here would copy a driver's job details into
 *   `net._http_response`, a table nobody thinks of as containing them.
 */
create or replace function public.dispatch_notification_push()
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
  /* Inbox-only rows never leave the database. */
  if not new.push_requested then
    return new;
  end if;

  select value into edge_url from private.app_settings where key = 'edge_url';
  select value into service_key from private.app_settings where key = 'service_key';

  /*
   * Unconfigured is silent, not an error — 19's rule. The notification still
   * exists and still shows in the app; only the push is missing, which is the
   * state every deployment is in until those two settings land.
   */
  if edge_url is null or service_key is null then
    return new;
  end if;

  post_fn := private.pg_net_post_fn();

  if post_fn is null then
    insert into public.app_events (level, area, message, context)
    values (
      'warning', 'push', 'pg_net is not enabled, so no push was sent',
      jsonb_build_object('notification', new.id, 'kind', new.kind)
    );
    return new;
  end if;

  /*
   * ⚠ The exception block is the point, same as 24.
   *
   *   This trigger hangs off an insert that happens inside an AFTER UPDATE
   *   trigger on `bookings`. Without this block, a bad header or a revoked
   *   grant aborts the push, which aborts the notification, which aborts the
   *   status change — and a driver cannot mark a parcel delivered because the
   *   notifier is misconfigured.
   */
  begin
    execute format('select %s(url := $1, headers := $2, body := $3)', post_fn)
    using
      edge_url || '/notify-push',
      jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      jsonb_build_object('notification_id', new.id);
  exception when others then
    insert into public.app_events (level, area, message, context)
    values (
      'error', 'push', 'could not queue a push notification',
      -- SQLERRM only. The service key is in scope and must never reach a log.
      jsonb_build_object('notification', new.id, 'error', sqlerrm, 'via', post_fn)
    );
  end;

  return new;
end;
$$;

drop trigger if exists notifications_dispatch_push on public.notifications;
create trigger notifications_dispatch_push
  after insert on public.notifications
  for each row execute function public.dispatch_notification_push();

/*
 * Retries what the trigger could not send.
 *
 * ⚠ pg_net is fire-and-forget: the trigger cannot know whether the request
 *   arrived. A function cold start, a redeploy mid-request or a 500 leaves a
 *   row with `pushed_at is null` and nothing coming back for it.
 *
 * Three attempts, then it stays unsent and stays visible — `push_attempts >= 3
 * and pushed_at is null` is the query for "notifications we failed to deliver",
 * which is a thing worth being able to ask.
 */
create or replace function public.sweep_unsent_pushes()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  pending record;
  edge_url text;
  service_key text;
  post_fn text;
  retried integer := 0;
begin
  select value into edge_url from private.app_settings where key = 'edge_url';
  select value into service_key from private.app_settings where key = 'service_key';
  if edge_url is null or service_key is null then
    return 0;
  end if;

  post_fn := private.pg_net_post_fn();
  if post_fn is null then
    return 0;
  end if;

  for pending in
    select id from public.notifications
     where push_requested
       and pushed_at is null
       and push_attempts < 3
       /* A minute of grace, so this never races the trigger's own request. */
       and created_at < now() - interval '1 minute'
       and created_at > now() - interval '1 day'
     order by created_at
     limit 200
  loop
    begin
      execute format('select %s(url := $1, headers := $2, body := $3)', post_fn)
      using
        edge_url || '/notify-push',
        jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || service_key
        ),
        jsonb_build_object('notification_id', pending.id);
      retried := retried + 1;
    exception when others then
      null;
    end;
  end loop;

  return retried;
end;
$$;

revoke all on function public.sweep_unsent_pushes() from public, anon, authenticated;
revoke all on function public.sweep_pickup_reminders() from public, anon, authenticated;
revoke all on function public.sweep_unconfirmed_emails() from public, anon, authenticated;

-- -------------------------------------------------------------- scheduling --

do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule('loci-pickup-reminders')
      where exists (select 1 from cron.job where jobname = 'loci-pickup-reminders');
    perform cron.schedule(
      'loci-pickup-reminders', '*/15 * * * *',
      'select public.sweep_pickup_reminders()'
    );

    perform cron.unschedule('loci-unsent-pushes')
      where exists (select 1 from cron.job where jobname = 'loci-unsent-pushes');
    perform cron.schedule(
      'loci-unsent-pushes', '*/5 * * * *',
      'select public.sweep_unsent_pushes()'
    );

    /* Daily at 09:00 UTC — 10:00 in Lagos. Chasing somebody at 3am is rude. */
    perform cron.unschedule('loci-unconfirmed-emails')
      where exists (select 1 from cron.job where jobname = 'loci-unconfirmed-emails');
    perform cron.schedule(
      'loci-unconfirmed-emails', '0 9 * * *',
      'select public.sweep_unconfirmed_emails()'
    );
  else
    insert into public.app_events (level, area, message, context)
    values (
      'warning', 'notifications',
      'pg_cron is not installed, so pickup reminders and push retries will not run',
      jsonb_build_object('functions', array['sweep_pickup_reminders', 'sweep_unsent_pushes', 'sweep_unconfirmed_emails'])
    );
  end if;
end
$$;

/*
  ⚠ Known and not solved here.

    - Offers still push through `notify-offer`, not this spine. See the header.
      Until that is folded in, `notifications.pushed_at` is null for every
      `offer_received` row and that is correct rather than a gap.
    - `message_received` still has nothing behind it. No messaging table exists.
    - Expo returns a ticket, not a delivery. `pushed_at` means Expo accepted the
      message, not that a phone showed it — the receipts endpoint is the only
      thing that knows, and nothing polls it yet.
    - `sweep_pickup_reminders` uses a flat 30 minutes for every job. A doorstep
      pickup across Lagos and a hub drop two streets away are not the same
      deadline, but nothing in `bookings` currently carries an expected pickup
      time to measure against.
    - No quiet hours and no per-user mute. Every pushable kind pushes.
*/

notify pgrst, 'reload schema';
