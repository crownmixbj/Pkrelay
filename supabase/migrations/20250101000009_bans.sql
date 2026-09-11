-- LOCI — banning a driver, and erasing a person's data.
--
-- Run after 01–08. Re-runnable.
--
-- Two different powers, deliberately separated:
--
--   BAN     reversible. Revokes driving. The account keeps working as a
--           customer, and nothing is destroyed.
--   ERASE   irreversible. Scrubs the personal data and blocks the account,
--           while leaving every parcel intact.
--
-- ⚠ Neither deletes from `auth.users`, and that is not an oversight. Two
--   foreign keys make a hard delete actively harmful today:
--
--     bookings.sender_id ... on delete cascade
--         Deleting the account deletes every parcel that person ever SENT.
--         Their counterparties lose their own delivery history.
--
--     bookings.driver_id ... on delete set null
--         Nulling it violates `driver_pair_consistent`, which requires
--         `driver` and `driver_id` to move together — so the delete raises
--         instead of completing, for anyone who has ever carried a parcel.
--
--   Removing the login as well means an Edge Function holding the service_role
--   key, and fixing both foreign keys first. Until then `erase_person` below is
--   the honest maximum: the person is gone from the data, the deliveries remain.

do $$
begin
  if to_regclass('public.app_events') is null then
    raise exception 'Run 20250101000007_admin.sql first — bans are audited into app_events.';
  end if;
end
$$;

-- ------------------------------------------------------------- columns -----

alter table public.profiles
  add column if not exists driving_banned_at timestamptz,
  add column if not exists driving_ban_reason text,
  add column if not exists deleted_at timestamptz;

comment on column public.profiles.driving_banned_at is
  'Set while a driver is barred from accepting jobs. Null means not banned. '
  'Reversible — the account still works as a customer.';

comment on column public.profiles.deleted_at is
  'Set once the person has been erased. Their auth login still exists but every '
  'policy below refuses it, and the profile holds no personal data.';

/*
  These three are set by the functions below and by nothing else.

  Without this guard, "update own profile" would let a banned driver simply
  clear their own ban — the policy grants update on the row, and RLS controls
  rows rather than columns. Same shape as `profiles_guard_admin` in 02.
*/
create or replace function public.profiles_guard_moderation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon')
     and (new.driving_banned_at is distinct from old.driving_banned_at
          or new.driving_ban_reason is distinct from old.driving_ban_reason
          or new.deleted_at is distinct from old.deleted_at) then
    raise exception 'Moderation fields are set by an administrator, not by clients';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_moderation on public.profiles;
create trigger profiles_guard_moderation
  before update on public.profiles
  for each row execute function public.profiles_guard_moderation();

-- ------------------------------------------------- the driving gate --------

/*
  Approved AND not banned AND not erased.

  This is the function the `claim or advance` policy on `bookings` already
  calls, so tightening it here bans the driver everywhere at once — the job
  feed, the claim, and anything added later that asks the same question. A ban
  implemented in the UI would be a suggestion; this is the rule.
*/
create or replace function public.is_approved_driver()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.driver_applications a
    join public.profiles p on p.id = a.user_id
    where a.user_id = auth.uid()
      and a.status = 'approved'
      and p.driving_banned_at is null
      and p.deleted_at is null
  );
$$;

/*
  An erased account cannot post a parcel either.

  Replaces the insert policy from 01. Banning does not appear here on purpose —
  a banned driver is still a customer, and stopping them sending parcels would
  be a different punishment from the one that was chosen.
*/
create or replace function public.is_erased()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.deleted_at is not null from public.profiles p where p.id = auth.uid()), false);
$$;

/*
  Replaces "sender creates own" from 20250101000001_bookings.sql.

  The three original guards are repeated verbatim — dropping a policy and
  recreating it with only the new condition would have quietly removed them,
  letting a client post a parcel pre-assigned to a driver. The only addition is
  the last line.
*/
drop policy if exists "sender creates own" on public.bookings;
create policy "sender creates own"
  on public.bookings for insert
  to authenticated
  with check (
    sender_id = (select auth.uid())
    -- A parcel cannot be posted pre-assigned; claiming is a separate step.
    and driver_id is null
    and driver is null
    and status = 'Booked'
    and not public.is_erased()
  );

-- --------------------------------------------------------------- ban -------

create or replace function public.set_driving_ban(
  target_id uuid,
  banned boolean,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if not public.is_admin() then
    raise exception 'Only an administrator can ban a driver';
  end if;

  if target_id = actor then
    raise exception 'You cannot ban yourself.';
  end if;

  if not exists (select 1 from public.profiles where id = target_id) then
    raise exception 'No such user';
  end if;

  if banned and note is null then
    /*
      A ban with no reason is unreviewable. Six months later nobody can tell
      whether it was fraud or a missed pickup, and the driver cannot be given
      an answer if they ask.
    */
    raise exception 'Give a reason for the ban.';
  end if;

  update public.profiles
     set driving_banned_at = case when banned then now() else null end,
         driving_ban_reason = case when banned then note else null end
   where id = target_id;

  /*
    Jobs already claimed are deliberately left alone.

    Releasing them automatically would drop a parcel that is mid-journey back
    into the open feed with no warning to the sender, and possibly while it is
    physically in the banned driver's vehicle. Reassignment is a human decision.
  */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'moderation',
    case when banned then 'driver banned' else 'driver ban lifted' end,
    jsonb_build_object('subject', target_id, 'reason', note),
    actor
  );
end;
$$;

revoke all on function public.set_driving_ban(uuid, boolean, text) from public, anon;
grant execute on function public.set_driving_ban(uuid, boolean, text) to authenticated;

-- ------------------------------------------------------------- erase -------

/*
  Removes the person, keeps the deliveries.

  Every field that identifies a human is overwritten rather than deleted, so
  the rows that reference them still resolve. What survives is a parcel with a
  route, a weight, a fare and a carrier called "Former driver" — enough for the
  sender's own history, and nothing about who carried it.

  Storage objects are deleted outright: the licence and ID scans are the most
  sensitive thing LOCI holds, and there is no reason to keep them once a person
  has been erased.
*/
create or replace function public.erase_person(target_id uuid, note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if not public.is_admin() then
    raise exception 'Only an administrator can erase an account';
  end if;

  if target_id = actor then
    raise exception 'You cannot erase your own account from here.';
  end if;

  if not exists (select 1 from public.profiles where id = target_id) then
    raise exception 'No such user';
  end if;

  if (select is_admin from public.profiles where id = target_id) then
    -- An admin's row is referenced by the audit trail as an actor. Demote
    -- first, so the decision to remove their powers is its own logged act.
    raise exception 'Remove this person''s admin role first.';
  end if;

  /*
    The carrier name on any parcel they delivered.

    Set before the profile is scrubbed, and set to a non-null placeholder
    rather than null — `driver_pair_consistent` requires `driver` and
    `driver_id` to move together, so nulling one alone raises.
  */
  update public.bookings
     set driver = 'Former driver'
   where driver_id = target_id;

  -- Their own sent parcels keep the route and the fare, lose the people.
  update public.bookings
     set pickup_contact_name = 'Removed',
         sender_phone = 'Removed',
         recipient_name = 'Removed',
         recipient_phone = 'Removed',
         pickup_address = 'Removed',
         dropoff_address = 'Removed',
         notes = ''
   where sender_id = target_id;

  -- The application: identity, bank, guarantor, next of kin.
  update public.driver_applications
     set full_name = 'Erased',
         phone = 'Erased',
         email = 'Erased',
         nin = 'Erased',
         address = 'Erased',
         guarantor_name = 'Erased',
         guarantor_phone = 'Erased',
         guarantor_relationship = 'Erased',
         guarantor_address = 'Erased',
         guarantor_nin = 'Erased',
         bank_name = 'Erased',
         account_number = 'Erased',
         account_name = 'Erased',
         kin_name = 'Erased',
         kin_phone = 'Erased',
         kin_relationship = 'Erased',
         plate_number = 'Erased',
         license_id = 'Erased',
         documents = '{}'::jsonb
   where user_id = target_id;

  -- The uploaded licence, ID and insurance scans.
  delete from storage.objects
   where bucket_id = 'driver-documents'
     and (storage.foldername(name))[1] = target_id::text;

  update public.profiles
     set full_name = 'Removed account',
         phone = '',
         deleted_at = now(),
         driving_banned_at = now(),
         driving_ban_reason = 'Account erased'
   where id = target_id;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'moderation',
    'account erased',
    /*
      The subject id, and nothing about them. An audit row naming the person
      erased would keep exactly the data the erasure was meant to remove.
    */
    jsonb_build_object('subject', target_id, 'reason', note),
    actor
  );
end;
$$;

revoke all on function public.erase_person(uuid, text) from public, anon;
grant execute on function public.erase_person(uuid, text) to authenticated;

/*
  ⚠ STILL OUTSTANDING after running this file:

    1. The auth login survives. The person can still sign in; every policy
       refuses them and the profile is empty, but the row in `auth.users` and
       their email address remain. Removing it needs an Edge Function with the
       service_role key — and the two foreign keys at the top of this file
       fixed first.

    2. Retention. Erasure is manual. There is still no schedule that clears
       rejected applications or old events, which is the NDPR obligation this
       does not discharge.
*/
