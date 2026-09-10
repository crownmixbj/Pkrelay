-- LOCI — profiles, admin roles, and driver applications.
--
-- ⚠ RUN `20250101000001_bookings.sql` FIRST. The last section of this file replaces a
--   policy on the `bookings` table, so running it against an empty database
--   fails with `relation "public.bookings" does not exist`. The guard below
--   turns that cryptic error into a readable one.
--
-- Run in the Supabase SQL Editor. Re-runnable.

do $$
begin
  if to_regclass('public.bookings') is null then
    raise exception
      'Run 20250101000001_bookings.sql first — this file extends the bookings table created there.';
  end if;
end
$$;
--
-- ⚠ This table holds sensitive personal data: National Identification Numbers,
--   bank account numbers, home addresses, and the same for a guarantor. Under
--   the NDPR that makes you a data controller with real obligations. Two things
--   follow, and neither is optional before real applicants use this:
--
--     1. Access is restricted below to the applicant and to admins. Nobody else,
--        including other drivers, can read a row.
--     2. You should decide how long you keep rejected applications, and delete
--        them on that schedule. There is no retention policy here because that
--        is a business decision, not a technical one.

-- ---------------------------------------------------------------- profiles --

/*
  One row per account, created automatically on sign-up.

  `is_admin` is the whole access-control story for the dashboard, so it is
  deliberately NOT settable by any client: no policy below grants update on it,
  which means only the service role — the Supabase dashboard, or a server you
  control — can promote someone. If a user could set this column, the admin
  dashboard would be self-service.
*/
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null default '',
  phone      text not null default '',
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  -- `is_admin` is excluded by the trigger below, not by this policy: RLS
  -- controls rows, not columns.
  with check (id = (select auth.uid()));

/*
  Nobody escalates themselves — but a database administrator must still be able
  to promote someone.

  The role check is the whole point. A BEFORE UPDATE trigger fires for *every*
  role, so an unconditional `raise` would lock out the SQL editor as well as the
  app, leaving no way to create the first admin.

  PostgREST connects as `authenticator` and then does `SET LOCAL ROLE` to
  `authenticated` or `anon` for each request, so `current_user` is one of those
  for anything coming from the app. The SQL editor runs as `postgres`, which
  falls through and is allowed.

  Deliberately NOT `security definer`: that would make `current_user` the
  function's owner (postgres) for every caller, and the check would never fire.
*/
create or replace function public.profiles_guard_admin()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.is_admin is distinct from old.is_admin
     and current_user in ('authenticated', 'anon') then
    raise exception 'is_admin can only be changed by a database administrator';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_admin on public.profiles;
create trigger profiles_guard_admin
  before update on public.profiles
  for each row execute function public.profiles_guard_admin();

/* A profile row for every new account, so the app never has to create one. */
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who signed up before this ran.
insert into public.profiles (id, full_name, phone)
select u.id,
       coalesce(u.raw_user_meta_data ->> 'name', ''),
       coalesce(u.raw_user_meta_data ->> 'phone', '')
from auth.users u
on conflict (id) do nothing;

/*
  Used by the policies below. `security definer` so it can read `profiles`
  without recursing through that table's own RLS — a policy that queried
  profiles directly would deadlock against itself.
*/
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- ------------------------------------------------------ driver applications --

create table if not exists public.driver_applications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  reference  text not null unique,

  -- Applicant
  full_name text not null,
  phone     text not null,
  email     text not null,
  nin       text not null,
  address   text not null,
  state     text not null,
  base_city text,

  -- Vehicle
  vehicle_type text not null,
  plate_number text not null,
  license_id   text not null,

  -- Guarantor
  guarantor_name         text not null,
  guarantor_phone        text not null,
  guarantor_relationship text not null,
  guarantor_address      text not null,
  guarantor_nin          text not null,

  -- Payout
  bank_name      text not null,
  account_number text not null,
  account_name   text not null,

  -- Next of kin
  kin_name         text not null,
  kin_phone        text not null,
  kin_relationship text not null,

  /*
    Document filenames only. The files themselves are not uploaded yet — see
    the README. A reviewer can see what was attached but cannot open it, which
    is worth knowing before anyone is approved on the strength of this.
  */
  documents jsonb not null default '{}'::jsonb,

  status text not null default 'pending'
    check (status in ('pending', 'under_review', 'approved', 'rejected')),
  review_note text,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,

  submitted_at timestamptz not null default now(),

  -- One live application per account. A rejected applicant can re-apply only
  -- after the old row is cleared, which is deliberate: it forces a decision
  -- about the previous rejection rather than letting duplicates pile up.
  constraint one_open_application_per_user unique (user_id)
);

create index if not exists driver_applications_status_idx
  on public.driver_applications (status, submitted_at desc);

alter table public.driver_applications enable row level security;

drop policy if exists "applicant or admin reads" on public.driver_applications;
create policy "applicant or admin reads"
  on public.driver_applications for select
  to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

drop policy if exists "applicant submits own" on public.driver_applications;
create policy "applicant submits own"
  on public.driver_applications for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    -- An applicant cannot submit themselves pre-approved.
    and status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
  );

/* Only admins decide. An applicant cannot edit a submitted application. */
drop policy if exists "admin reviews" on public.driver_applications;
create policy "admin reviews"
  on public.driver_applications for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------- approved drivers only ----

/*
  True when this account has an approved application. Used by the bookings
  policy so the review process actually gates something: an unvetted account
  can browse the job feed but cannot take a parcel.
*/
create or replace function public.is_approved_driver()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.driver_applications a
    where a.user_id = auth.uid() and a.status = 'approved'
  );
$$;

/*
  Replaces the update policy from schema.sql. The only change is the claim
  branch: claiming now additionally requires an approved application.
*/
drop policy if exists "claim or advance" on public.bookings;
create policy "claim or advance"
  on public.bookings for update
  to authenticated
  using (
    (driver_id is null and status = 'Booked' and public.is_approved_driver())
    or driver_id = (select auth.uid())
    or sender_id = (select auth.uid())
  )
  with check (
    driver_id = (select auth.uid())
    or (sender_id = (select auth.uid()) and driver_id is null)
  );

-- ------------------------------------------------------------ make an admin --
--
-- Run this once, with your own email, to give yourself the dashboard:
--
--   update public.profiles set is_admin = true
--   where id = (select id from auth.users where email = 'you@example.com');
--
-- The trigger above refuses this when the caller is `authenticated` or `anon`
-- — every request from the app — and allows it from the SQL editor, which runs
-- as `postgres`. That asymmetry is the point: admin is granted out-of-band.
--
-- Check it landed:
--
--   select u.email, p.is_admin
--   from public.profiles p join auth.users u on u.id = p.id;
--
-- If the row is missing entirely, the account was created before the profile
-- trigger existed. The backfill above fixes that — re-run this file.
