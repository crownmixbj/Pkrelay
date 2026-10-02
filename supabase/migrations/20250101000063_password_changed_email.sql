-- ============================================================================
-- 20250101000063_password_changed_email.sql — tell people their password changed
-- ============================================================================
--
-- Queues a `password_changed` email whenever an account's password changes:
-- at the end of the reset flow (the update-password screen calls
-- `supabase.auth.updateUser({ password })`) and on any other change through
-- Supabase Auth. Delivery is the usual path: email_outbox -> notify-events ->
-- Resend, with the staging redirect and retry sweep.
--
-- ⚠ Why the column, not an Auth hook or the client.
--
--   Supabase Auth writes the new hash to `auth.users.encrypted_password` and
--   that write is the only thing every route to a new password has in common.
--   A client-side call after `updateUser` would be skipped by an attacker
--   changing the password — the one case this email exists for.
--
-- ⚠ A trigger on `auth.users` must never raise. Same rule and shape as 62:
--   every statement that could fail is caught and logged to app_events, so a
--   problem here costs one email, never a password reset.
--
-- ⚠ Every change is its own email. `subject_id` is the user id plus the change
--   time to the microsecond, so two changes are two emails, while a retried
--   dispatch of the same row is still exactly-once.
--
-- ⚠ Not on sign-up. The hash is set by the INSERT that creates the account;
--   this fires on UPDATE only, and only when a previous hash existed.
--
-- ⚠ The payload is the name and the time. No IP, device or hash — nothing an
--   admin reading the outbox should see.

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
    'welcome',
    'password_changed'
  ));

create or replace function public.email_on_password_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.encrypted_password is null
     or new.encrypted_password is null
     or new.encrypted_password is not distinct from old.encrypted_password then
    return new;
  end if;

  begin
    perform public.queue_email(
      'password_changed',
      new.id::text || ':' || clock_timestamp()::text,
      new.email,
      jsonb_build_object(
        'full_name', coalesce(
          nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
          nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
          ''
        ),
        'changed_at', now()
      )
    );
  exception when others then
    begin
      insert into public.app_events (level, area, message, context, actor_id)
      values (
        'warning', 'email', 'password-changed email could not be queued',
        jsonb_build_object('user', new.id, 'error', sqlerrm), null
      );
    exception when others then
      null;
    end;
  end;

  return new;
end;
$$;

drop trigger if exists on_password_changed on auth.users;
create trigger on_password_changed
  after update of encrypted_password on auth.users
  for each row execute function public.email_on_password_changed();

/* Deployment panel probe (src/lib/schema-gap.ts). */
create or replace function public.password_changed_email_installed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'auth.users'::regclass
       and t.tgname = 'on_password_changed'
       and not t.tgisinternal
  );
$$;

comment on function public.password_changed_email_installed() is
  'True when the password-changed email trigger is on auth.users. Read by the deployment panel.';

revoke all on function public.password_changed_email_installed() from public, anon;
grant execute on function public.password_changed_email_installed() to authenticated;
