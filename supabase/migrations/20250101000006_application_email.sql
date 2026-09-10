-- LOCI — delivery record for the applicant confirmation email.
--
-- Run after 01–05. Re-runnable.
--
-- The app tells an applicant "check your inbox for a confirmation email" the
-- second they submit. These two columns are how you find out whether that was
-- true: the Edge Function writes the outcome back here, so a provider outage
-- shows up in the review dashboard instead of as a silent broken promise.

do $$
begin
  if to_regclass('public.driver_applications') is null then
    raise exception 'Run 20250101000002_driver_applications.sql first.';
  end if;
end
$$;

alter table public.driver_applications
  add column if not exists confirmation_email_sent_at timestamptz,
  add column if not exists confirmation_email_error   text;

comment on column public.driver_applications.confirmation_email_sent_at is
  'Set by the notify-application Edge Function once the provider accepts the message. '
  'Null with a null error means never attempted — the provider is not configured yet.';

comment on column public.driver_applications.confirmation_email_error is
  'Why the confirmation email failed. Null on success.';

/*
  Finding the applications whose confirmation never arrived — the list you would
  work through after an outage. Partial, because the rows that matter are the
  rare ones; indexing the successful majority would be wasted space.
*/
create index if not exists driver_applications_email_failed_idx
  on public.driver_applications (submitted_at)
  where confirmation_email_error is not null;

/*
  These columns are written by the service role only.

  The existing "update own application" policy would otherwise let an applicant
  stamp their own row as emailed, which would hide exactly the failure this is
  meant to reveal. RLS controls rows, not columns, so the guard is a trigger —
  the same shape as `profiles_guard_admin` in 02.

  Deliberately NOT `security definer`: that would make `current_user` the
  owner for every caller and the check would never fire.
*/
create or replace function public.driver_applications_guard_email_columns()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon')
     and (new.confirmation_email_sent_at is distinct from old.confirmation_email_sent_at
          or new.confirmation_email_error is distinct from old.confirmation_email_error) then
    raise exception 'confirmation email columns are set by the system, not by clients';
  end if;
  return new;
end;
$$;

drop trigger if exists driver_applications_guard_email on public.driver_applications;
create trigger driver_applications_guard_email
  before update on public.driver_applications
  for each row execute function public.driver_applications_guard_email_columns();
