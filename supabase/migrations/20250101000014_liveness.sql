-- LOCI — recording what the liveness provider said.
--
-- Run after 01–13. Re-runnable.
--
-- ⚠ The check itself is passive. Dojah's `/api/v1/ml/liveness` is handed one
--   still image and reports how likely it is to be a live person. That rejects
--   a printed photo held to the lens — which the previous bare-selfie flow
--   accepted — but nothing asks the person to blink or turn, so a video
--   replayed on a second screen is not closed off. Active liveness lives in
--   Dojah's EasyOnboard widget, which would replace LOCI's own capture screen.
--
-- ⚠ Sandbox results are mock. Dojah's documentation is explicit: "Never use
--   mock data to make a live trust decision." Every row here records which
--   environment produced it, and the UI says so, so a sandbox pass can never be
--   mistaken for a real one.

do $$
begin
  if to_regclass('public.photo_capture_sessions') is null then
    raise exception 'Run 20250101000013_capture_sessions.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------- columns -----

/*
  The verdict lives on the session, because that is where the photo lives and
  the check runs before there is a parcel.
*/
alter table public.photo_capture_sessions
  add column if not exists liveness_status text
    check (liveness_status in ('passed', 'failed', 'unavailable')),
  /** 0–100 as the provider reported it. Null when there was no number. */
  add column if not exists liveness_probability numeric,
  add column if not exists liveness_provider text,
  /*
    Which environment produced the verdict.

    Not decoration. A 'passed' from sandbox means a mock service said yes to a
    picture it never really looked at, and anyone reading this row later — an
    admin, an auditor, a court — needs to be able to tell the two apart without
    knowing what the deployment was configured with that week.
  */
  add column if not exists liveness_environment text
    check (liveness_environment in ('sandbox', 'production')),
  add column if not exists liveness_checked_at timestamptz;

/*
  And copied onto the booking when the session is spent, so the verdict survives
  the session being cleaned up.
*/
alter table public.bookings
  add column if not exists liveness_status text
    check (liveness_status in ('passed', 'failed', 'unavailable')),
  add column if not exists liveness_probability numeric,
  add column if not exists liveness_environment text
    check (liveness_environment in ('sandbox', 'production')),
  add column if not exists liveness_checked_at timestamptz;

comment on column public.bookings.liveness_status is
  'Passive liveness verdict from the provider. A sandbox "passed" is mock data '
  'and is not a real verification — read liveness_environment alongside it.';

-- --------------------------------------------------------------- guards ----

/**
 * No client writes a verdict about itself.
 *
 * The edge function uses the service role, which bypasses RLS and this trigger
 * both — `auth.uid()` is null there. Any other caller has a session, and this
 * refuses. Without it, the whole check is advisory: a modified client could
 * simply set its own status to 'passed'.
 */
create or replace function public.guard_liveness_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.liveness_status is distinct from old.liveness_status
     or new.liveness_probability is distinct from old.liveness_probability
     or new.liveness_environment is distinct from old.liveness_environment
     or new.liveness_checked_at is distinct from old.liveness_checked_at then
    raise exception 'Liveness results are written by the verification service, not by the client';
  end if;

  return new;
end;
$$;

drop trigger if exists photo_capture_sessions_guard_liveness on public.photo_capture_sessions;
create trigger photo_capture_sessions_guard_liveness
  before update on public.photo_capture_sessions
  for each row execute function public.guard_liveness_columns();

drop trigger if exists bookings_guard_liveness on public.bookings;
create trigger bookings_guard_liveness
  before update on public.bookings
  for each row execute function public.guard_liveness_columns();

-- ----------------------------------------------- carry it onto the parcel ---

/*
  `consume_capture_session` copies the verdict across.

  Recreated rather than edited in place because it is `create or replace` in
  20250101000013_capture_sessions.sql and this file has to run after it. The only change is
  the three extra columns on the booking update — everything else, including the
  single-use guarantee, is unchanged.
*/
create or replace function public.consume_capture_session(
  session_id uuid,
  booking_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  claimed_path text;
  claimed_status text;
  claimed_probability numeric;
  claimed_environment text;
  claimed_at timestamptz;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if not exists (
    select 1 from public.bookings
    where id = booking_id and sender_id = actor
  ) then
    raise exception 'That parcel is not yours';
  end if;

  update public.photo_capture_sessions
     set consumed_at = now()
   where id = session_id
     and owner_id = actor
     and completed_at is not null
     and consumed_at is null
  returning photo_path, liveness_status, liveness_probability, liveness_environment,
            liveness_checked_at
    into claimed_path, claimed_status, claimed_probability, claimed_environment, claimed_at;

  if claimed_path is null then
    raise exception 'That photo has already been used, or was never completed';
  end if;

  /*
    A failed check does not reach here.

    The client refuses to post on a failure, but the client is not the rule —
    this is. 'unavailable' *is* allowed through: the provider being down is not
    the sender's fault, and blocking every parcel in the country because a
    third party is having an outage is a worse failure than recording an
    unchecked photo and moving on.
  */
  if claimed_status = 'failed' then
    raise exception 'That photo did not pass the liveness check. Take another.';
  end if;

  update public.bookings
     set sender_photo_path = claimed_path,
         sender_photo_at = now(),
         liveness_status = claimed_status,
         liveness_probability = claimed_probability,
         liveness_environment = claimed_environment,
         liveness_checked_at = claimed_at
   where id = booking_id;
end;
$$;

revoke all on function public.consume_capture_session(uuid, uuid) from public, anon;
grant execute on function public.consume_capture_session(uuid, uuid) to authenticated;

-- ------------------------------------------------------------- reporting ---

/*
  How many parcels carry an unchecked photo, split by why.

  Worth watching from day one: a rising 'unavailable' count means the provider
  or the wallet is failing quietly, and the symptom otherwise is nothing at all
  — parcels keep posting, just without the check anyone believes is running.
*/
create or replace function public.admin_liveness_summary()
returns table (status text, environment text, parcels bigint)
language sql
security definer
set search_path = ''
as $$
  select
    coalesce(b.liveness_status, 'not checked') as status,
    coalesce(b.liveness_environment, '—') as environment,
    count(*) as parcels
  from public.bookings b
  where public.is_admin()
  group by 1, 2
  order by 3 desc;
$$;

revoke all on function public.admin_liveness_summary() from public, anon;
grant execute on function public.admin_liveness_summary() to authenticated;
