-- ============================================================================
-- 20250101000062_welcome_email.sql — a welcome email when an account is confirmed
-- ============================================================================
--
-- Queues one `welcome` email per account, at the moment its email address is
-- confirmed. Delivery is the usual path: email_outbox -> notify-events -> Resend,
-- so the staging redirect, the per-environment sender and the retry sweep all
-- apply without anything new.
--
-- ⚠ This is a trigger on `auth.users`, and it must never raise.
--
--   Migration 50 chose a sweeper over exactly this trigger, for a good reason:
--   `auth.users` is the table Supabase signs people up and confirms them
--   through, and a trigger there that raises fails the signup or the
--   confirmation for everybody. Here the moment matters — the email is meant
--   to arrive as the account is confirmed — so it is a trigger, and every
--   statement that could fail is inside an exception block that records the
--   problem in app_events and lets the confirmation through. A missing welcome
--   email is a bug somebody reports; a broken signup is an outage.
--
-- ⚠ When it fires.
--
--   - On the update that moves `email_confirmed_at` from null to a value: the
--     person clicked the link in their confirmation email.
--   - On an insert that is already confirmed: a Google sign-in, whose address
--     the provider has already confirmed, or any project with "Confirm email"
--     turned off. Without this, those people would never be welcomed.
--   - Never twice. `subject_id` is the user id, and the outbox is unique on
--     (kind, subject_id), so a later email change or re-confirmation is a no-op.
--   - Not retroactively. Accounts confirmed before this migration get nothing.
--
-- ⚠ The payload carries the name and nothing else. The template uses the first
--   word of it; an account with no name is greeted "Hi there,".

alter table public.email_outbox
  drop constraint if exists email_outbox_kind_check;

alter table public.email_outbox
  add constraint email_outbox_kind_check
  check (kind in (
    'driver_application_approved',
    'driver_application_rejected',
    'guarantor_invitation',
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
    'welcome'
  ));

create or replace function public.email_on_signup_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if new.email_confirmed_at is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.email_confirmed_at is not null then
    return new;
  end if;

  begin
    /*
     * `name` is what the sign-up form writes (see `signUp` in
     * src/store/session.tsx); `full_name` is what Google sends.
     */
    v_name := coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      ''
    );

    perform public.queue_email(
      'welcome',
      new.id::text,
      new.email,
      jsonb_build_object('full_name', v_name)
    );
  exception when others then
    /* Recorded, never raised — see the header. */
    begin
      insert into public.app_events (level, area, message, context, actor_id)
      values (
        'warning', 'email', 'welcome email could not be queued',
        jsonb_build_object('user', new.id, 'error', sqlerrm), null
      );
    exception when others then
      null;
    end;
  end;

  return new;
end;
$$;

drop trigger if exists on_signup_confirmed on auth.users;
create trigger on_signup_confirmed
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.email_on_signup_confirmed();

/*
 * The deployment panel's probe (src/lib/schema-gap.ts). Answers from the live
 * catalog, so it turns false if somebody drops the trigger later.
 */
create or replace function public.welcome_email_installed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from pg_catalog.pg_trigger t
     where t.tgrelid = 'auth.users'::regclass
       and t.tgname = 'on_signup_confirmed'
       and not t.tgisinternal
  );
$$;

comment on function public.welcome_email_installed() is
  'True when the welcome-email trigger is on auth.users. Read by the deployment panel.';

revoke all on function public.welcome_email_installed() from public, anon;
grant execute on function public.welcome_email_installed() to authenticated;
