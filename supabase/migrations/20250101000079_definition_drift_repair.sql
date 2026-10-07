-- ============================================================================
-- 20250101000079_definition_drift_repair.sql — the newer definition, put back
-- ============================================================================
--
-- Run after 78. Re-runnable. Apply to BOTH staging and production.
--
-- Symptom (production, 2026-10-07): assigning a parcel by hand fails with
--
--     column reference "driver" is ambiguous
--
-- which is the exact fault 69 was written to repair, on a database whose
-- migration history records 69 as applied.
--
-- ⚠ Cause: an early range of migrations was replayed over a database that
--   already had the later ones.
--
--   `create or replace function` does not care that it is going backwards. When
--   32 runs after 69, the database ends up with 32's `admin_assign_parcel` —
--   the broken one — and a history that says otherwise. 78 found the same thing
--   from the other end: `dispatch_offers_no_repeat_decline` was present on a
--   database recording 23, which drops it, because 20 had been re-run since. 76
--   is a third sighting of the same shape. So this is treated as a class of
--   failure rather than three accidents, and the second half of this file is
--   about seeing it next time.
--
-- ⚠ What was actually stale, found by checking every object this repo defines
--   in more than one migration — forty-two of them — against production on
--   2026-10-07, rather than by reasoning about which ones looked likely:
--
--     admin_assign_parcel          32 over 69   hand assignment raises
--     dispatch_email               38 over 53   every email waits for the sweep
--     email_on_booking_status      38 over 64   no driver first name in emails
--     begin_identity_check         28 over 41   identity review columns unset
--     record_identity_result       28 over 41   same, from the verifier's side
--     handle_new_user              02 over 45   Google sign-ups get no name
--     pg_net_calls_are_resolvable  67 over 68   the probe matches itself
--
--   Thirty-five other objects were current, including the two `bookings`
--   policies 56 rewrites and the index 78 dropped.
--
--   ⚠ Reading the list by eye got two of these wrong in both directions. An
--     earlier pass "found" `guarantor_invitation_window` stale (it is not — 54
--     only changes a number, and the marker used to test it was wrong) and
--     missed four of the seven above. The manifest below exists because the
--     eye is not a reliable instrument for this.
--
-- ⚠ Two of the seven cost something every day, and neither was reported.
--
--   53 exists because 38's `dispatch_email` reads `app.settings.functions_url`
--   and `app.settings.service_role_key`, which this project does not set — it
--   moved to `private.app_settings` in 24. 38's version therefore finds no
--   endpoint, returns silently, and the row sits unsent until
--   `loci-unsent-emails` picks it up. Every email on production is being sent
--   301 to 302 seconds after it is queued, measured across a day of them. That
--   is the five-minute sweep doing the work the trigger was meant to do, and it
--   is why a delivery confirmation reaches the sender up to five minutes after
--   the driver taps the button rather than at once.
--
--   45 exists because a Google sign-up puts the person's name in
--   `raw_user_meta_data ->> 'full_name'` and a password sign-up puts it in
--   `'name'`. 02's version reads only the second, so every account created
--   through Google since the replay has a blank `profiles.full_name` — which is
--   what renders as "Unnamed driver" on the waiting list and as nothing at all
--   beside a parcel.
--
-- ⚠ The bodies below are their owning migrations', generated from those files
--   rather than retyped, and `verify:availability` asserts they stay identical.
--   Read 41, 45, 53, 64, 68 and 69 for why each is written as it is; this file
--   only puts them back.
--
-- ⚠ Everything here is idempotent. Six `create or replace`, two `drop trigger
--   if exists` before their `create trigger`, and the grants each file carries.
--   No data is touched.

do $$
begin
  if to_regprocedure('public.admin_assign_parcel(uuid,uuid)') is null then
    raise exception 'Run 20250101000032_dispatch_mode.sql first.';
  end if;

  if to_regprocedure('public.email_dispatch_config()') is null then
    raise exception 'Run 20250101000053_email_dispatch_repair.sql first.';
  end if;

  if to_regclass('public.sender_identity') is null then
    raise exception 'Run 20250101000028_sender_identity.sql first.';
  end if;
end
$$;

-- ------------------------------------------- 32 over 69: hand assignment --

create or replace function public.admin_assign_parcel(parcel uuid, driver uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  parcel_status text;
  parcel_driver uuid;
  driver_approved boolean;
  driver_name text;
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  select status, driver_id into parcel_status, parcel_driver
  from public.bookings where id = parcel;

  if parcel_status is null then
    raise exception 'No such parcel';
  end if;

  if parcel_driver is not null then
    raise exception 'That parcel already has a driver';
  end if;

  if parcel_status <> 'Booked' then
    raise exception 'That parcel is % and cannot be assigned', parcel_status;
  end if;

  select exists (
    select 1 from public.driver_applications
    where user_id = admin_assign_parcel.driver and status = 'approved'
  ) into driver_approved;

  if not driver_approved then
    raise exception 'That driver is not approved';
  end if;

  if not public.documents_permit_dispatch(admin_assign_parcel.driver) then
    raise exception
      'That driver has an expired document and cannot carry parcels until it is renewed';
  end if;

  /*
   * The carrier's name, resolved here rather than left to the client.
   *
   * ⚠ `coalesce(..., 'Driver')` matches `respond_to_offer` in 15 exactly. A
   *   profile with an empty name is not a reason to refuse an assignment, and
   *   the constraint will not take null — so both paths put the same placeholder
   *   in the same column rather than one of them inventing its own.
   */
  select coalesce(nullif(btrim(p.full_name), ''), 'Driver')
    into driver_name
  from public.profiles p
  where p.id = admin_assign_parcel.driver;

  update public.bookings
     set driver_id = admin_assign_parcel.driver,
         driver = coalesce(driver_name, 'Driver'),
         /*
          * 'Assigned', not 'Booked'.
          *
          * ⚠ This is what makes anybody hear about it. 50's notifier fires on
          *   `update of status` and keys both messages on the move to
          *   'Assigned' — the driver's push ("Head to the pickup") and the
          *   sender's ("<name> is handling your parcel"). Writing the status it
          *   already had meant the trigger fired on a no-op transition and sent
          *   nothing.
          *
          * It is also what the sender's tracking screen reads. A parcel with a
          * driver that still says Booked reads, to the person who sent it, as
          * nobody having picked it up yet.
          */
         status = 'Assigned'
   where id = parcel;

  /*
   * ⚠ `accepted_at` is deliberately left null.
   *
   *   Nobody accepted this. The column means "a driver took this job", and a
   *   hand assignment is the opposite — the record of a decision made for them.
   *   `admin_parcel_detail` renders it as a dash, which is accurate.
   */

  /*
    Any live offer on this parcel is settled, not left hanging.

    Otherwise a driver who was mid-countdown taps Accept on a parcel that now
    belongs to somebody else, and `respond_to_offer` refuses them with a message
    about a parcel they were legitimately offered thirty seconds earlier.
  */
  update public.dispatch_offers
     set status = 'expired', responded_at = now()
   where booking_id = parcel and status = 'offered';

  /*
    The level depends on the mode, and that is the honest reading.

    In manual mode a hand assignment is the *expected* thing — every parcel is
    placed this way, and logging each one as a warning would bury the ones that
    matter under the ones that do not. In auto mode it is an override: a run of
    them means the matcher is failing to place parcels, which is a dispatch bug
    somebody should see rather than an admin habit.
  */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    case when public.dispatch_mode() = 'manual' then 'info' else 'warning' end,
    'dispatch', 'admin assigned a parcel by hand',
    jsonb_build_object(
      'booking', parcel,
      'driver', admin_assign_parcel.driver,
      'mode', public.dispatch_mode()
    ),
    actor
  );
end;
$$;

revoke all on function public.admin_assign_parcel(uuid, uuid) from public, anon;
grant execute on function public.admin_assign_parcel(uuid, uuid) to authenticated;

-- ----------------------------------------- 38 over 53: the email trigger --

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

-- -------------------------------------- 38 over 64: the status email body --

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
        'changed_at', now(),
        /*
         * ⚠ First name only — new in 64.
         *
         *   `bookings.driver` holds the name the driver signed up with, set by
         *   the same update that moves the parcel to 'Assigned'. A first name
         *   is enough for "Tunde has accepted your parcel" and is all an email
         *   that can be forwarded should carry. Null until a driver is on it.
         */
        'driver_first_name', nullif(split_part(btrim(coalesce(new.driver, '')), ' ', 1), '')
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

/*
 * Deployment panel probe (src/lib/schema-gap.ts). Reads the live function
 * body, so it turns false if 38 is ever re-run over this.
 */
create or replace function public.status_email_has_driver_name()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.prosrc like '%driver_first_name%'
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'email_on_booking_status'),
    false
  );
$$;

comment on function public.status_email_has_driver_name() is
  'True when parcel status emails carry the driver''s first name. Read by the deployment panel.';

revoke all on function public.status_email_has_driver_name() from public, anon;
grant execute on function public.status_email_has_driver_name() to authenticated;

-- ------------------------------------ 28 over 41: the identity review path --

create or replace function public.record_identity_result(
  target uuid,
  verdict text,
  reference text default null,
  score numeric default null,
  env text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if verdict not in ('verified', 'flagged', 'unavailable') then
    raise exception 'Unknown verdict %', verdict;
  end if;

  if verdict = 'unavailable' then
    update public.sender_identity
       set checked_at = now(),
           environment = coalesce(env, environment),
           candidate_path = coalesce(reference, candidate_path)
     where user_id = target;

    insert into public.app_events (level, area, message, context, actor_id)
    values (
      'warning', 'identity', 'identity check could not be completed',
      jsonb_build_object('user', target), null
    );
    return;
  end if;

  update public.sender_identity
     set status = verdict,
         confidence = score,
         environment = coalesce(env, environment),
         checked_at = now(),
         verified_at = case when verdict = 'verified' then now() else verified_at end,
         candidate_path = coalesce(reference, candidate_path),
         reference_path = case
           when verdict = 'verified' then coalesce(reference, reference_path)
           else reference_path
         end
   where user_id = target;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    case when verdict = 'verified' then 'info' else 'warning' end,
    'identity',
    'identity check completed',
    jsonb_build_object('user', target, 'verdict', verdict, 'confidence', score),
    null
  );
end;
$$;

revoke all on function public.record_identity_result(uuid, text, text, numeric, text)
  from public, anon, authenticated;

-- ------------------------------------------- resubmission clears the verdict --

/*
  Replaces 28's version. The only change is that a previous review is cleared.

  ⚠ Without this, a rejected sender who submits a better photo keeps the
    rejection note and the rejected status, and the check constraint above
    keeps the row consistent while the *sender* stays blocked. They would have
    done everything asked and be no better off — which is the exact shape of
    failure the header warns about.
*/
create or replace function public.begin_identity_check(
  sender_nin text,
  sender_slip_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  digits text := regexp_replace(coalesce(sender_nin, ''), '\D', '', 'g');
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if digits !~ '^[0-9]{11}$' then
    raise exception 'A NIN is 11 digits';
  end if;

  if sender_slip_path is null or split_part(sender_slip_path, '/', 1) <> actor::text then
    raise exception 'That file does not belong to this account';
  end if;

  insert into public.sender_identity (user_id, nin, slip_path, status)
  values (actor, digits, sender_slip_path, 'pending')
  on conflict (user_id) do update
    set nin = excluded.nin,
        slip_path = excluded.slip_path,
        status = 'pending',
        confidence = null,
        verified_at = null,
        checked_at = null,
        -- The review this submission supersedes.
        review_note = null,
        reviewed_by = null,
        reviewed_at = null;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'identity', 'sender started identity onboarding',
    jsonb_build_object('nin_last4', right(digits, 4)),
    actor
  );
end;
$$;

revoke all on function public.begin_identity_check(text, text) from public, anon;
grant execute on function public.begin_identity_check(text, text) to authenticated;

-- ------------------------------------------ 02 over 45: the Google name --

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    /*
      ⚠ `full_name` first: it is the one Google documents.

        `name` is what this app's own sign-up writes, and what Google also
        happens to send today. Preferring the documented key means an OAuth
        account is read correctly on purpose rather than by accident, and an
        email signup still lands on the second branch.
    */
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      ''
    ),
    /*
      No phone from any provider. Left empty rather than guessed — the app
      refuses to go further until a real one is given.
    */
    coalesce(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ----------------------------------------- 67 over 68: the pg_net probe --

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
       /*
         ⚠ This function's own body carries the pattern it searches for.
           Without this line it finds itself and never reports healthy.
       */
       and p.proname <> 'pg_net_calls_are_resolvable'
       and pg_catalog.pg_get_functiondef(p.oid) like '%extensions.net.http_post%'
  );
$$;

revoke all on function public.pg_net_calls_are_resolvable() from public, anon;
grant execute on function public.pg_net_calls_are_resolvable() to authenticated, service_role;

-- ------------------------------------------------------ seeing it next time --

/**
 * Every object this repo defines in more than one migration, and whether the
 * live database still has the newest definition.
 *
 * ⚠ Why a marker string rather than comparing the whole body.
 *
 *   `pg_get_functiondef` reformats what it is given — keywords uppercased,
 *   comments kept but whitespace normalised — so a byte comparison against the
 *   .sql file fails on functions that are perfectly current. A short string
 *   that only the newest definition contains is a weaker test and a reliable
 *   one, and it is the same shape as the probes on the deployment panel.
 *
 * ⚠ The manifest is checked against the migration chain by the test suite.
 *
 *   `verify:availability` parses every migration, finds each object created in
 *   two or more of them, and fails if one is missing from the list below. That
 *   is what stops this from being a snapshot of October 2026 — a future
 *   migration that replaces an old function has to be added here or the build
 *   goes red.
 *
 * `state` is 'current', 'STALE' (an older definition has overwritten it) or
 * 'MISSING' (the object is not there at all).
 */
create or replace function public.stale_definitions()
returns table (object text, owner_migration text, state text)
language sql
stable
security definer
set search_path = ''
as $$
  with manifest(object, owner_migration, kind, obj_schema, obj_name, marker) as (values
    ('admin_assign_parcel'              , '069', 'fn',   'public', 'admin_assign_parcel'              , 'admin_assign_parcel.driver'),
    ('admin_guarantor_summary'          , '051', 'fn',   'public', 'admin_guarantor_summary'          , 'public.guarantor_invitations'),
    ('admin_identity_queue'             , '043', 'fn',   'public', 'admin_identity_queue'             , 'public.sender_selfie_path'),
    ('admin_overview'                   , '072', 'fn',   'public', 'admin_overview'                   , 'parcels_on_the_way'),
    ('admin_parcel_detail'              , '036', 'fn',   'public', 'admin_parcel_detail'              , 'b.item_photo_path'),
    ('admin_parcels'                    , '072', 'fn',   'public', 'admin_parcels'                    , 'on_the_way'),
    ('admin_parcels_for_driver'         , '071', 'fn',   'public', 'admin_parcels_for_driver'         , 'public.offer_attempts'),
    ('admin_payment_totals'             , '060', 'fn',   'public', 'admin_payment_totals'             , 'p.initialized_at'),
    ('admin_payments_ledger'            , '060', 'fn',   'public', 'admin_payments_ledger'            , 'public.commission_rate'),
    ('admin_reveal_identity_for_user'   , '043', 'fn',   'public', 'admin_reveal_identity_for_user'   , 'public.sender_selfie_path'),
    ('admin_review_identity'            , '043', 'fn',   'public', 'admin_review_identity'            , 'public.sender_selfie_path'),
    ('admin_waiting_drivers'            , '075', 'fn',   'public', 'admin_waiting_drivers'            , 'coalesce(j.departure_time, j.departs_before) asc'),
    ('assignable_drivers'               , '075', 'fn',   'public', 'assignable_drivers'               , 'c.next_departure'),
    ('begin_identity_check'             , '041', 'fn',   'public', 'begin_identity_check'             , 'review_note'),
    ('complete_guarantor_verification'  , '051', 'fn',   'public', 'complete_guarantor_verification'  , 'public.guarantor_documents'),
    ('consume_capture_session'          , '014', 'fn',   'public', 'consume_capture_session'          , 'liveness_environment'),
    ('default_application_status'       , '040', 'fn',   'public', 'default_application_status'       , 'new.review_note'),
    ('dispatch_booking'                 , '032', 'fn',   'public', 'dispatch_booking'                 , 'public.dispatch_mode'),
    ('dispatch_email'                   , '053', 'fn',   'public', 'dispatch_email'                   , 'public.email_dispatch_config'),
    ('dispatch_new_booking'             , '056', 'fn',   'public', 'dispatch_new_booking'             , 'new.payment_status'),
    ('email_on_booking_status'          , '064', 'fn',   'public', 'email_on_booking_status'          , 'driver_first_name'),
    ('erase_person'                     , '033', 'fn',   'public', 'erase_person'                     , 'public.payout_change_requests'),
    ('expire_dispatch_offers'           , '021', 'fn',   'public', 'expire_dispatch_offers'           , 'with lapsed as'),
    ('guarantor_invitation_window'      , '054', 'fn',   'public', 'guarantor_invitation_window'      , 'interval ''30 days'''),
    ('guard_application_phone'          , '033', 'fn',   'public', 'guard_application_phone'          , 'loci.erasing'),
    ('guard_identity_columns'           , '034', 'fn',   'public', 'guard_identity_columns'           , 'loci.attaching_identity'),
    ('handle_new_user'                  , '045', 'fn',   'public', 'handle_new_user'                  , 'nullif(new.raw_user_meta_data'),
    ('invite_guarantor_on_submit'       , '051', 'fn',   'public', 'invite_guarantor_on_submit'       , 'public.queue_notification'),
    ('is_approved_driver'               , '009', 'fn',   'public', 'is_approved_driver'               , 'p.driving_banned_at'),
    ('journey_matches'                  , '026', 'fn',   'public', 'journey_matches'                  , 'journey_departure'),
    ('my_guarantor_status'              , '051', 'fn',   'public', 'my_guarantor_status'              , 'm.guarantor_email'),
    ('notify_dispatch_offer'            , '024', 'fn',   'public', 'notify_dispatch_offer'            , 'private.pg_net_post_fn'),
    ('notify_new_driver_application'    , '067', 'fn',   'public', 'notify_new_driver_application'    , 'private.pg_net_post_fn'),
    ('open_guarantor_invitation'        , '051', 'fn',   'public', 'open_guarantor_invitation'        , 'invite.guarantor_email'),
    ('pg_net_calls_are_resolvable'      , '068', 'fn',   'public', 'pg_net_calls_are_resolvable'      , 'p.proname <> ''pg_net_calls_are_resolvable'''),
    ('queue_notification'               , '076', 'fn',   'public', 'queue_notification'               , 'foreign_key_violation'),
    ('record_identity_result'           , '041', 'fn',   'public', 'record_identity_result'           , 'candidate_path'),
    ('sweep_for_journey'                , '026', 'fn',   'public', 'sweep_for_journey'                , 'new.departure_time'),
    ('unassigned_parcels'               , '071', 'fn',   'public', 'unassigned_parcels'               , 'public.offer_attempts'),
    /*
      kind 'gone': the object must NOT exist. 23 dropped this index and 20 kept
      bringing it back with `create unique index if not exists`, so a replay of
      the early range resurrects it — which is how a driver came to be unable to
      decline the same parcel twice. 78 is the migration that found it; this row
      is what would have said so first.
    */
    ('dispatch_offers_no_repeat_decline', '078', 'gone', 'public', 'dispatch_offers_no_repeat_decline', ''),
    /*
      kind 'pol': the policy's expression must contain the marker. These two
      rows put the *table* in `obj_schema` — every policy here is on
      `public.bookings`, and giving the column a second meaning for three rows
      was cheaper than a sixth column that is null for the other forty.
    */
    ('bookings: sender creates own',             '056', 'pol', 'bookings', 'sender creates own',             'payment_status'),
    ('bookings: read own, carried, or unclaimed','056', 'pol', 'bookings', 'read own, carried, or unclaimed','payment_status')
  )
  select
    m.object::text,
    m.owner_migration::text,
    (case m.kind

      when 'gone' then
        case when to_regclass(m.obj_schema || '.' || m.obj_name) is null
             then 'current' else 'STALE' end

      when 'pol' then
        coalesce(
          (
            select case
              when coalesce(pg_get_expr(p.polqual, p.polrelid), '') ||
                   coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
                   like '%' || m.marker || '%'
              then 'current' else 'STALE' end
            from pg_policy p
            where p.polrelid = ('public.' || m.obj_schema)::regclass
              and p.polname = m.obj_name
          ),
          'MISSING'
        )

      /*
        ⚠ Looked up by name, not by signature, and `bool_or` across every
          overload.

          A signature would have to be written down here and would go wrong the
          first time a migration changed one — the probe would report MISSING on
          a function that is present and current, which is a worse lie than the
          one it exists to catch. `journey_matches` is the live example: 15
          declared it with eight arguments and 26 with ten, and both are in the
          database. A marker is absent from every older definition by
          construction, so "some overload contains it" is exactly "the newest
          definition is still there".
      */
      else
        coalesce(
          (
            select case
              when bool_or(pg_get_functiondef(p.oid) like '%' || m.marker || '%')
                then 'current'
              else 'STALE'
            end
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = m.obj_schema and p.proname = m.obj_name
          ),
          'MISSING'
        )
    end)::text
  from manifest m
  order by 3 desc, 1;
$$;

comment on function public.stale_definitions() is
  'Objects defined in more than one migration, and whether the live database still has the newest (79).';

revoke all on function public.stale_definitions() from public, anon;
grant execute on function public.stale_definitions() to authenticated;

/**
 * Deployment panel probe (src/lib/schema-gap.ts).
 *
 * ⚠ The one probe on that panel that is not about a feature.
 *
 *   Every other entry answers "has this migration been applied". This one
 *   answers "is the database still what the chain says it should be", which is
 *   the question three separate production defects turned out to be — on a
 *   history that looked perfect in all three cases.
 */
create or replace function public.definitions_current()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.stale_definitions() where state <> 'current'
  );
$$;

comment on function public.definitions_current() is
  'False when an older migration has overwritten a newer definition (79).';

revoke all on function public.definitions_current() from public, anon;
grant execute on function public.definitions_current() to authenticated;
