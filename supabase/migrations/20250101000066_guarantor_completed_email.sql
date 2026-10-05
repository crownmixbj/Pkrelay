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
