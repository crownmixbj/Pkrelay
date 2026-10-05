-- ============================================================================
-- driver-signup-repair.sql — unblock driver submissions on a database where
--                            migrations 40 and 52 only half-landed
-- ============================================================================
--
-- Paste into the SQL editor of the project that is refusing submissions. Safe to
-- run twice. It carries no secret, reads no personal data and touches no rows.
--
-- ⚠ Every statement here is copied from a migration. This is not a patch and not
--   drift — it is migration 40's policy and migration 52's column changes,
--   applied to a database that received the rest of those files but not these
--   parts. Pushing 40 and 52 properly would do exactly this and nothing more.
--
-- WHAT WENT WRONG
--
--   An applicant who names a guarantor gets:
--
--     new row violates row-level security policy for table "driver_applications" (42501)
--
--   because two halves of migration 40 disagree on this database:
--
--     1. The BEFORE INSERT trigger `on_application_status_default` IS here. It
--        rewrites `status` to 'pending_guarantor' whenever a guarantor email is
--        given — the client never sends a status at all.
--     2. The INSERT policy is still migration 2's, which admits `status = 'pending'`
--        and nothing else.
--
--   So the trigger writes a value that the policy then refuses, on every
--   submission, for every applicant with a guarantor. Leave the guarantor email
--   blank and it works, which is why this looks intermittent.
--
--   Behind it sits a second wall, which you meet the moment the first comes
--   down: `guarantor_relationship`, `guarantor_address` and `guarantor_nin` are
--   still NOT NULL here. The client stopped sending them when the guarantor
--   started supplying them through the portal, so the next error would be
--
--     null value in column "guarantor_relationship" ... violates not-null constraint (23502)
--
--   Both are fixed below. Fixing only the first just moves the error.

-- ------------------------------------------------- 1. migration 40's policy --

/*
  ⚠ The two statuses an application may be *born* at.

  Not "the two the trigger happens to write": stated here so that a third one
  added later fails loudly at insert time rather than silently widening what an
  applicant can claim about themselves.

  Nothing is relaxed. `user_id` must still be the caller, and `reviewed_by` /
  `reviewed_at` must still be null — an applicant cannot submit themselves
  pre-approved. The only change is that 'pending_guarantor', which the trigger
  on this very table produces, is now an admissible birth state.
*/
drop policy if exists "applicant submits own" on public.driver_applications;
create policy "applicant submits own"
  on public.driver_applications for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and status in ('pending', 'pending_guarantor')
    and reviewed_by is null
    and reviewed_at is null
  );

-- ------------------------------------------ 2. migration 52's column changes --

/*
  ⚠ Dropped, not defaulted.

  These three were collected from the *applicant* at signup until the guarantor
  form took over. The guarantor now supplies their own relationship, address and
  NIN through the portal, into `guarantor_verifications`, which is the copy the
  review screen reads. Giving the old columns a default would write an empty
  string that looks like an answer; letting them be null says what is true —
  nobody was asked.

  Existing rows keep whatever they already have.
*/
alter table public.driver_applications
  alter column guarantor_relationship drop not null,
  alter column guarantor_address      drop not null,
  alter column guarantor_nin          drop not null;

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

-- ------------------------------------------------------------- 3. the check --

/*
  Read this row before trying a submission. Every column must be true; the last
  one names the first thing still in the way.
*/
with probe as (
  select
    exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = 'driver_applications'
         and policyname = 'applicant submits own'
         and with_check like '%pending_guarantor%'
    )                                                              as policy_admits_guarantor,
    public.driver_application_guarantor_optional()                 as columns_optional,
    exists (
      select 1 from pg_trigger
       where tgrelid = 'public.driver_applications'::regclass
         and tgname = 'on_application_status_default'
    )                                                              as status_trigger,
    (select count(*) from pg_constraint
      where conrelid = 'public.driver_applications'::regclass
        and conname = 'driver_applications_status_check'
        and pg_get_constraintdef(oid) like '%pending_guarantor%')  as status_check_ok
)
select *,
  case
    when not status_trigger          then 'No status trigger — migration 40 never landed here at all. Push 39 and 40.'
    when status_check_ok = 0         then 'The status CHECK constraint does not allow pending_guarantor. Push migration 39.'
    when not policy_admits_guarantor then 'Step 1 did not take — re-read the error from the policy statement above.'
    when not columns_optional        then 'Step 2 did not take — re-read the error from the ALTER TABLE above.'
    else 'Clear — an applicant with a guarantor can submit.'
  end as next_step
from probe;
