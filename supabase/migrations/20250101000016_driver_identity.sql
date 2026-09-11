-- LOCI — locking the applicant's phone, cooling off payout changes, and
-- recording what the identity check said.
--
-- Run after 01–15. Re-runnable.

do $$
begin
  if to_regclass('public.driver_applications') is null then
    raise exception 'Run 20250101000002_driver_applications.sql first.';
  end if;
  if to_regclass('public.app_events') is null then
    raise exception 'Run 20250101000007_admin.sql first.';
  end if;
end
$$;

-- ------------------------------------------------- 1. the phone is locked ---

/**
 * Nigerian numbers, reduced to one comparable shape.
 *
 * `08031234567`, `+2348031234567` and `234 803 123 4567` are the same number
 * written three ways, and a driver who signed up with one and typed another
 * would otherwise be told their own phone is not their phone.
 *
 * Mirrors `normalizePhone` in `src/lib/handoff.ts`; both are tested against the
 * same cases.
 */
create or replace function public.normalize_ng_phone(raw text)
returns text language sql immutable set search_path = '' as $$
  select case
    when digits is null or length(digits) < 7 then null
    when left(digits, 3) = '234' then '+' || digits
    when left(digits, 1) = '0' and length(digits) = 11 then '+234' || right(digits, 10)
    else digits
  end
  from (select regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g') as digits) t;
$$;

/**
 * The application's phone must be the account's phone.
 *
 * The form disables the field, but a disabled input is a suggestion — the value
 * still travels in the request and can be changed by anything speaking to
 * PostgREST. This is where the rule actually holds.
 *
 * The account's number lives in `auth.users.phone` when set, and otherwise in
 * the `phone` key of `raw_user_meta_data`, which is where this app's sign-up
 * puts it. Both are checked because a project that later enables phone auth
 * would start populating the first.
 */
create or replace function public.guard_application_phone()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  account_phone text;
  claimed text;
begin
  select public.normalize_ng_phone(
           coalesce(nullif(u.phone, ''), u.raw_user_meta_data ->> 'phone')
         )
    into account_phone
  from auth.users u
  where u.id = new.user_id;

  claimed := public.normalize_ng_phone(new.phone);

  /*
    No number on the account: let it through.

    Accounts created before sign-up captured a phone have nothing to compare
    against, and refusing them would lock existing users out of applying for a
    field they were never asked for. The application's own validation still
    requires a valid Nigerian number.
  */
  if account_phone is null then
    return new;
  end if;

  if claimed is distinct from account_phone then
    raise exception
      'Use the phone number you signed up with. Applications must match the account they are made from.'
      using errcode = 'check_violation';
  end if;

  -- Store the normalised form, so two records of the same person agree.
  new.phone := account_phone;
  return new;
end;
$$;

drop trigger if exists driver_applications_lock_phone on public.driver_applications;
create trigger driver_applications_lock_phone
  before insert or update on public.driver_applications
  for each row execute function public.guard_application_phone();

-- --------------------------------------- 2. payout changes cool for 48 hours --

/*
  Why a delay at all: an attacker who gets into a driver's account and swaps the
  payout account takes the next payout with nothing to stop them. A window means
  the real driver has two days to notice, and — crucially — the *old* account
  stays live for transfers throughout, so the theft window never opens.
*/
create table if not exists public.payout_change_requests (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users (id) on delete cascade,

  -- What it would become.
  bank_name text not null,
  account_number text not null,
  account_name text not null,

  -- What it was, captured at request time so the audit trail is self-contained
  -- even after the application row moves on.
  previous_bank_name text,
  previous_account_number text,
  previous_account_name text,

  status text not null default 'pending'
    check (status in ('pending', 'applied', 'cancelled')),

  requested_at timestamptz not null default now(),
  effective_at timestamptz not null default (now() + interval '48 hours'),
  settled_at timestamptz,
  /** Set when an admin or the driver cancelled it, for the audit trail. */
  cancelled_by uuid references auth.users (id) on delete set null,

  constraint payout_settled_consistent check (
    (status = 'pending' and settled_at is null)
    or (status <> 'pending' and settled_at is not null)
  )
);

/*
  One pending change at a time.

  Without this, a driver could stack requests and an attacker could queue a
  second change to land after the first was noticed and cancelled.
*/
create unique index if not exists payout_change_one_pending_per_driver
  on public.payout_change_requests (driver_id)
  where status = 'pending';

create index if not exists payout_change_due_idx
  on public.payout_change_requests (effective_at)
  where status = 'pending';

alter table public.payout_change_requests enable row level security;

drop policy if exists "driver reads own payout changes" on public.payout_change_requests;
create policy "driver reads own payout changes"
  on public.payout_change_requests for select
  to authenticated
  using (driver_id = (select auth.uid()) or public.is_admin());

/*
  No insert, update or delete policy. Requests are made through
  `request_payout_change` and settled through `cancel_payout_change` or the
  scheduled sweep — a driver who could write this table directly could set
  `effective_at` to now and defeat the whole mechanism.
*/

/**
 * Asks for a new payout account.
 *
 * The old account keeps receiving transfers until `effective_at` passes. That
 * is the point: a cooling window that stopped payouts would punish the driver
 * for the attack rather than the attacker.
 */
create or replace function public.request_payout_change(
  new_bank_name text,
  new_account_number text,
  new_account_name text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  application record;
  effective timestamptz;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if coalesce(trim(new_bank_name), '') = ''
     or coalesce(trim(new_account_number), '') = ''
     or coalesce(trim(new_account_name), '') = '' then
    raise exception 'Bank, account number and account name are all required';
  end if;

  select bank_name, account_number, account_name
    into application
  from public.driver_applications
  where user_id = actor and status = 'approved'
  order by submitted_at desc
  limit 1;

  if application.account_number is null then
    raise exception 'Only an approved driver can change a payout account';
  end if;

  /*
    Same account, same bank: nothing to cool off.

    Both are compared, because moving the same number to a different bank is a
    real change — and one worth the window, since it redirects the money just
    as effectively.
  */
  if trim(new_account_number) = application.account_number
     and trim(new_bank_name) = application.bank_name then
    raise exception 'That is already your payout account';
  end if;

  if exists (
    select 1 from public.payout_change_requests
    where driver_id = actor and status = 'pending'
  ) then
    raise exception 'You already have a payout change waiting. Cancel it first.';
  end if;

  insert into public.payout_change_requests (
    driver_id, bank_name, account_number, account_name,
    previous_bank_name, previous_account_number, previous_account_name
  )
  values (
    actor, trim(new_bank_name), trim(new_account_number), trim(new_account_name),
    application.bank_name, application.account_number, application.account_name
  )
  returning effective_at into effective;

  /*
    Logged at 'warning'.

    Not because it is wrong, but because it is the event an operator most wants
    to see in a list of things worth glancing at — a payout account change is
    the highest-value target in this application.
  */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning', 'payout', 'payout account change requested',
    -- No account numbers in the log. The request row holds them, behind RLS;
    -- app_events is read by every admin and does not need them.
    jsonb_build_object('effective_at', effective),
    actor
  );

  return effective;
end;
$$;

/** Either the driver or an admin can stop a pending change. */
create or replace function public.cancel_payout_change(request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  owner uuid;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select driver_id into owner
  from public.payout_change_requests
  where id = request_id and status = 'pending';

  if owner is null then
    raise exception 'No pending change with that id';
  end if;

  if owner <> actor and not public.is_admin() then
    raise exception 'That request is not yours';
  end if;

  update public.payout_change_requests
     set status = 'cancelled', settled_at = now(), cancelled_by = actor
   where id = request_id;

  insert into public.app_events (level, area, message, context, actor_id)
  values ('warning', 'payout', 'payout account change cancelled',
          jsonb_build_object('request', request_id), actor);
end;
$$;

/**
 * Applies every change whose window has passed.
 *
 * Scheduled, like the dispatch sweeper — `select public.apply_due_payout_changes();`
 * hourly. Applying on read instead would mean a driver who never opens the app
 * never gets their change, which is a support ticket rather than a feature.
 */
create or replace function public.apply_due_payout_changes()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  due record;
  applied integer := 0;
begin
  for due in
    select * from public.payout_change_requests
    where status = 'pending' and effective_at <= now()
  loop
    update public.driver_applications
       set bank_name = due.bank_name,
           account_number = due.account_number,
           account_name = due.account_name
     where user_id = due.driver_id and status = 'approved';

    update public.payout_change_requests
       set status = 'applied', settled_at = now()
     where id = due.id;

    insert into public.app_events (level, area, message, context, actor_id)
    values ('info', 'payout', 'payout account change applied',
            jsonb_build_object('request', due.id), due.driver_id);

    applied := applied + 1;
  end loop;

  return applied;
end;
$$;

/**
 * The account money should go to right now.
 *
 * The single source of truth for a payout run. It deliberately reads the
 * *current* application row, not any pending request — which is what keeps the
 * old account live during the window. A payout system that looked at the
 * request table would defeat the entire mechanism.
 */
create or replace function public.active_payout_account(driver uuid)
returns table (bank_name text, account_number text, account_name text)
language sql
security definer
set search_path = ''
as $$
  select a.bank_name, a.account_number, a.account_name
  from public.driver_applications a
  where a.user_id = driver
    and a.status = 'approved'
    and (driver = auth.uid() or public.is_admin())
  order by a.submitted_at desc
  limit 1;
$$;

revoke all on function public.apply_due_payout_changes() from public, anon, authenticated;
revoke all on function public.request_payout_change(text, text, text) from public, anon;
revoke all on function public.cancel_payout_change(uuid) from public, anon;
revoke all on function public.active_payout_account(uuid) from public, anon;
grant execute on function public.request_payout_change(text, text, text) to authenticated;
grant execute on function public.cancel_payout_change(uuid) to authenticated;
grant execute on function public.active_payout_account(uuid) to authenticated;

-- ------------------------------------------- 3. the identity check result ---

/*
  ⚠ This is a different legal proposition from the sender selfie.
    Matching a face against a government record to establish *who someone is* is
    processing biometric data for the purpose of uniquely identifying a person —
    the NDPA's definition of sensitive personal data, with explicit-consent and
    impact-assessment obligations attached. See docs/PRIVACY-NOTES.md.
    LEGAL_REVIEW_REQUIRED.
*/
alter table public.driver_applications
  add column if not exists identity_status text
    check (identity_status in ('matched', 'mismatch', 'unavailable', 'skipped')),
  /** Dojah's `confidence_value`, 0–100. Null when there was no number. */
  add column if not exists identity_confidence numeric,
  add column if not exists identity_environment text
    check (identity_environment in ('sandbox', 'production')),
  add column if not exists identity_checked_at timestamptz;

comment on column public.driver_applications.identity_status is
  'Selfie matched against the NIMC photo for the applicant NIN. "mismatch" is a '
  'flag for human review, not a rejection — NIMC photos can be years old.';

/**
 * Written by the verification service, never by an applicant.
 *
 * Same shape as `guard_liveness_columns` in 20250101000014_liveness.sql: the edge function
 * runs as the service role and has no `auth.uid()`, so it passes; anything with
 * a session is refused.
 */
create or replace function public.guard_identity_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.identity_status is distinct from old.identity_status
     or new.identity_confidence is distinct from old.identity_confidence
     or new.identity_environment is distinct from old.identity_environment
     or new.identity_checked_at is distinct from old.identity_checked_at then
    raise exception 'Identity results are written by the verification service, not by the client';
  end if;

  return new;
end;
$$;

drop trigger if exists driver_applications_guard_identity on public.driver_applications;
create trigger driver_applications_guard_identity
  before update on public.driver_applications
  for each row execute function public.guard_identity_columns();

-- --------------------------------- 4. where the unassigned parcels are going --

/**
 * Unassigned parcels, grouped by where they are trying to get to.
 *
 * "Unclaimed: 14" tells an operator there is a problem. This tells them it is
 * fourteen parcels for Kano and none anywhere else, which is a different
 * problem with a different fix — recruit on that route, or move a driver.
 *
 * Deliberately destination, not origin. `admin_city_volumes` already groups by
 * origin; a backlog is a shortage of drivers *going somewhere*.
 */
create or replace function public.admin_unassigned_by_destination()
returns table (city text, parcels bigint, oldest_hours numeric, offered bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  return query
    select
      b.destination_city::text,
      count(*)::bigint,
      -- How long the oldest has been waiting. A count alone cannot tell an
      -- operator whether this is a queue or a graveyard.
      round(max(extract(epoch from (now() - b.created_at)) / 3600)::numeric, 1),
      -- How many of those are currently out with a driver on a dispatch offer,
      -- so a spike that is actually being worked reads differently from one
      -- that nobody has looked at.
      count(*) filter (
        where exists (
          select 1 from public.dispatch_offers o
          where o.booking_id = b.id and o.status = 'offered' and o.expires_at > now()
        )
      )::bigint
    from public.bookings b
    where b.driver_id is null
      and b.status = 'Booked'
    group by b.destination_city
    order by 2 desc, 3 desc;
end;
$$;

revoke all on function public.admin_unassigned_by_destination() from public, anon;
grant execute on function public.admin_unassigned_by_destination() to authenticated;

/*
  ⚠ Both sweeps need scheduling, and neither runs on its own:

      select public.apply_due_payout_changes();   -- hourly
      select public.expire_dispatch_offers();     -- every minute

    Without the first, a payout change waits forever and the driver is paid into
    their old account indefinitely — which looks exactly like the feature
    working, right up until someone complains.
*/
