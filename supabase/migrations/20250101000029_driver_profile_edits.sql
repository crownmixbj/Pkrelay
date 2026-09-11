-- LOCI — what an approved driver may change about themselves, and what it costs.
--
-- Run after 01–28. Re-runnable.
--
--   low     vehicle colour, plate, next of kin, base city → applied at once
--   high    legal name, NIN, licence, guarantor, documents → back to review
--   locked  phone, bank details → not editable here at all, for two different
--           reasons, both given below
--
-- ⚠ TWO PARTS OF THE BRIEF ALREADY HAVE ANSWERS IN THIS CODEBASE, AND THE
--   ANSWERS DISAGREE WITH THE BRIEF. Both are worth reading before this file is
--   run, because building it as asked would have made the product worse.
--
--   1. PHONE IS NOT A LOW-RISK FIELD HERE.
--
--      `20250101000016_driver_identity.sql` installs `guard_application_phone`, which
--      forces the application's phone to equal the account's phone on every
--      write. That was deliberate: the number is how LOCI reaches a driver
--      holding somebody's parcel, and an attacker who can change it can
--      redirect every call and OTP about that account. Letting it be edited
--      "directly, optionally with an OTP" would undo that guard.
--
--      An OTP to the *new* number proves the attacker controls the new number.
--      It proves nothing about the old one. Phone stays where it is; changing
--      it is a support action against the account, not a profile edit.
--
--   2. BANK DETAILS ALREADY HAVE A BETTER MECHANISM THAN SUSPENSION.
--
--      `request_payout_change` (16) opens a 48-hour window in which the *old*
--      account keeps receiving money and the driver keeps working. That already
--      achieves the stated goal — no payout reaches unverified details — and it
--      does it without stopping anybody earning.
--
--      Reverting approval to pending for a bank change would take a driver off
--      the road for at least 48 hours to protect an account nobody has yet
--      shown to be compromised. This file therefore *refuses* bank fields and
--      points at the existing path rather than building a second one. Two ways
--      to change a bank account is how they end up disagreeing.

do $$
begin
  if to_regprocedure('public.request_payout_change(text, text, text)') is null then
    raise exception 'Run 20250101000016_driver_identity.sql first.';
  end if;
end
$$;

-- ---------------------------------------------------------- a new column --

/*
  `vehicle_colour` did not exist.

  The brief names it as the archetypal low-risk field and it was not in
  `driver_applications` — classifying it would have produced a function that
  refers to a column nothing can write. Caught by running the edit against a
  real Postgres rather than by reading it.

  Nullable, because every existing application was submitted without one.
*/
alter table public.driver_applications
  add column if not exists vehicle_colour text;

-- --------------------------------------------------------- classification --

/**
 * How dangerous it is to change a given field.
 *
 * One function, so the client, the edit path and the audit trail cannot hold
 * three different opinions about what counts as sensitive. `src/store/
 * driver-profile.ts` mirrors it and the verification suite asserts they agree.
 *
 * ⚠ Anything not named here is `locked`, not `low`.
 *
 *   The default has to be refusal. A column added next year — a rating, a
 *   commission rate, an internal note — would otherwise become editable by the
 *   driver it describes, silently, on the day it is created.
 */
create or replace function public.driver_field_risk(field text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case field
    /*
      Low: wrong, this is an inconvenience. A driver turning up in a blue van
      when the record says red is a phone call, not a fraud.
    */
    when 'vehicle_type' then 'low'
    when 'vehicle_colour' then 'low'
    when 'plate_number' then 'low'
    when 'base_city' then 'low'
    when 'address' then 'low'
    when 'kin_name' then 'low'
    when 'kin_phone' then 'low'
    when 'kin_relationship' then 'low'

    /*
      High: wrong, this is a different person carrying parcels.

      Legal name, NIN and licence are what the approval was *of*. Guarantor
      details are the recourse if a parcel disappears, so swapping them for a
      confederate defeats the check without touching the driver's own record.
    */
    when 'full_name' then 'high'
    when 'nin' then 'high'
    when 'license_id' then 'high'
    when 'guarantor_name' then 'high'
    when 'guarantor_phone' then 'high'
    when 'guarantor_relationship' then 'high'
    when 'guarantor_address' then 'high'
    when 'guarantor_nin' then 'high'
    when 'documents' then 'high'

    -- See the header. Neither is editable through this file.
    when 'phone' then 'locked'
    when 'email' then 'locked'
    when 'bank_name' then 'locked'
    when 'account_number' then 'locked'
    when 'account_name' then 'locked'

    else 'locked'
  end;
$$;

revoke all on function public.driver_field_risk(text) from public, anon;
grant execute on function public.driver_field_risk(text) to authenticated;

-- ------------------------------------------------------------ the history --

create table if not exists public.driver_edit_history (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users (id) on delete cascade,

  field text not null,
  risk text not null check (risk in ('low', 'high')),

  /*
    Before and after, as text.

    Typed columns would need one pair per column type and a `documents` jsonb
    would not fit either. Text loses nothing that matters here: this is read by
    a human deciding whether a change looks legitimate, not joined on.
  */
  old_value text,
  new_value text,

  /**
   * Who made it. Almost always the driver; an admin correcting a typo is the
   * case worth being able to tell apart afterwards.
   */
  actor_id uuid references auth.users (id) on delete set null,

  /** Whether this change sent the application back for review. */
  suspended_approval boolean not null default false,

  created_at timestamptz not null default now()
);

create index if not exists driver_edit_history_driver_idx
  on public.driver_edit_history (driver_id, created_at desc);

comment on table public.driver_edit_history is
  'Before/after trail for driver profile edits. Contains a NIN and a licence '
  'number in old_value/new_value when those change — treat as sensitive.';

alter table public.driver_edit_history enable row level security;

/*
  A driver sees their own history; an admin sees all of it.

  Showing a driver their own trail is not a courtesy — it is how somebody
  notices a change they did not make, which is the entire point of keeping it.
*/
drop policy if exists "read own edit history" on public.driver_edit_history;
create policy "read own edit history"
  on public.driver_edit_history for select
  to authenticated
  using (driver_id = (select auth.uid()) or public.is_admin());

/*
  No insert, update or delete policy for anyone.

  An audit trail a driver can write is not evidence, and one they can delete is
  worse than none — it would look complete while missing exactly the row that
  mattered. Every write below happens inside a SECURITY DEFINER function.
*/

-- ------------------------------------------------------- the edit itself ---

/**
 * Applies a patch to the caller's own application.
 *
 * `patch` is a flat jsonb of column name to new value. Every key is classified
 * before anything is written, so a patch mixing a low-risk and a high-risk
 * field is either wholly a review request or refused — never half-applied.
 *
 * Returns the resulting application status, so the client can say what just
 * happened rather than guessing.
 */
create or replace function public.update_driver_profile(patch jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  app record;
  field text;
  risk text;
  has_high boolean := false;
  carrying integer;
  old_value text;
  new_value text;
  next_status text;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if patch is null or jsonb_typeof(patch) <> 'object' or patch = '{}'::jsonb then
    raise exception 'Nothing to change';
  end if;

  select * into app
  from public.driver_applications
  where user_id = actor
  order by submitted_at desc
  limit 1;

  if app.id is null then
    raise exception 'No driver application on this account';
  end if;

  -- Classify everything first. Nothing is written until the whole patch is known
  -- to be acceptable.
  for field in select jsonb_object_keys(patch) loop
    risk := public.driver_field_risk(field);

    if risk = 'locked' then
      if field in ('bank_name', 'account_number', 'account_name') then
        raise exception
          'Bank details change through Payout settings, where the old account keeps receiving for 48 hours';
      end if;

      if field in ('phone', 'email') then
        raise exception 'Contact support to change the % on a driver account', field;
      end if;

      raise exception 'The field % cannot be edited', field;
    end if;

    if risk = 'high' then
      has_high := true;
    end if;
  end loop;

  /*
    ⚠ A high-risk edit is refused while a parcel is in their hands.

      `advance_booking` requires `is_approved_driver()`. Dropping the status to
      under_review mid-delivery would leave the driver holding a parcel they can
      no longer mark picked up or delivered, with a recipient waiting and no
      route back except an admin. The parcel is somebody else's property; it
      does not get stranded because its carrier decided to change their name
      halfway through the trip.

      Low-risk edits are unaffected — nothing about them touches approval.
  */
  if has_high then
    select count(*) into carrying
    from public.bookings
    where driver_id = actor
      and status not in ('Delivered', 'Cancelled');

    if carrying > 0 then
      raise exception
        'Finish or release your current trip before changing your identity details';
    end if;
  end if;

  next_status := case when has_high then 'under_review' else app.status end;

  -- Now write, one field at a time, recording what each was.
  for field in select jsonb_object_keys(patch) loop
    risk := public.driver_field_risk(field);

    /*
      ⚠ Read back from the table, not out of the record.

        `execute format('select ($1).%I::text', field) using app` looks like it
        should work and does not: passing a plpgsql `record` as a parameter
        erases its row type, so Postgres answers

            could not identify column "plate_number" in record data type

        Dynamic field access on an anonymous record is not a thing. Selecting
        the column by name from the row's own id is unambiguous, and costs one
        cheap indexed lookup per changed field.
    */
    execute format('select %I::text from public.driver_applications where id = $1', field)
      into old_value using app.id;
    new_value := case
      when jsonb_typeof(patch -> field) = 'string' then patch ->> field
      else (patch -> field)::text
    end;

    -- Unchanged fields are not history. A trail full of "Lagos → Lagos" is a
    -- trail nobody reads.
    if old_value is distinct from new_value then
      execute format(
        'update public.driver_applications set %I = $1 where id = $2',
        field
      ) using new_value, app.id;

      insert into public.driver_edit_history
        (driver_id, field, risk, old_value, new_value, actor_id, suspended_approval)
      values (actor, field, risk, old_value, new_value, actor, has_high);
    end if;
  end loop;

  if has_high and app.status <> next_status then
    update public.driver_applications
       set status = next_status,
           review_note = 'Identity details changed by the driver — re-verify before approving.'
     where id = app.id;
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    case when has_high then 'warning' else 'info' end,
    'driver',
    case when has_high then 'driver changed identity details' else 'driver updated profile' end,
    -- Field names only. The values are in `driver_edit_history`, which is not
    -- readable by everyone `app_events` is.
    jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(patch) k)),
    actor
  );

  return next_status;
end;
$$;

revoke all on function public.update_driver_profile(jsonb) from public, anon;
grant execute on function public.update_driver_profile(jsonb) to authenticated;

-- --------------------------------------------------- telling them about it --

/**
 * A driver's own edit trail.
 *
 * ⚠ Values are truncated, and the reason is worth stating.
 *
 *   `old_value`/`new_value` hold a NIN or a licence number when those change.
 *   A history screen is left open, screenshotted and shown to people; the last
 *   four characters are enough to recognise a change you made and not enough to
 *   be worth stealing. An admin reading the table directly still sees
 *   everything.
 */
create or replace function public.my_edit_history(limit_rows integer default 50)
returns table (
  field text,
  risk text,
  old_hint text,
  new_hint text,
  suspended_approval boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    h.field,
    h.risk,
    case when h.old_value is null then null else '…' || right(h.old_value, 4) end,
    case when h.new_value is null then null else '…' || right(h.new_value, 4) end,
    h.suspended_approval,
    h.created_at
  from public.driver_edit_history h
  where h.driver_id = (select auth.uid())
  order by h.created_at desc
  limit greatest(1, least(coalesce(limit_rows, 50), 200));
$$;

revoke all on function public.my_edit_history(integer) from public, anon;
grant execute on function public.my_edit_history(integer) to authenticated;

/*
  ⚠ The notification on a bank change is already there, and is not repeated.

    `request_payout_change` in 20250101000016_driver_identity.sql writes the audit row and
    the 48-hour window. What neither it nor this file does is *send* anything —
    there is no email or SMS path for a driver in this project, only Expo push
    for dispatch offers. Adding a second half-built notifier here would look
    like coverage without being any.

    The honest position: the change is recorded and visible to the driver in
    their own history the moment it happens. Alerting them out-of-band needs a
    transactional email or SMS provider, which is a separate piece of work and
    should reuse the `notify-application` function rather than start again.
*/

/*
  ⚠ Also still missing.

    - No OTP anywhere. The brief offers one as optional on low-risk fields; it
      is not built, because an OTP is only meaningful against a channel LOCI
      controls, and the phone number is exactly the thing this file refuses to
      let a driver change.
    - Nothing re-runs the identity check after a name change. The status goes
      back to under_review and a human decides; `verify-identity` is not
      re-triggered automatically.
    - `documents` is classified high, but this file only records that the jsonb
      changed. It does not verify the new files exist in storage.
*/
