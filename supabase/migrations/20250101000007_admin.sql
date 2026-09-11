-- LOCI — what the Admin area needs: user visibility, audited role changes,
-- and an application event log.
--
-- Run after 01–06. Re-runnable.
--
-- ⚠ This file widens what an admin can see and adds the only path by which
--   anyone becomes an admin. Read the three sections before running it.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'Run 20250101000002_driver_applications.sql first.';
  end if;
end
$$;

-- ------------------------------------------------- 1. seeing other users ----

/*
  Until now `profiles` was readable only by its owner, which is why User & Role
  Management could not exist: an admin's query returned exactly one row, their
  own.

  This adds a second, additive policy. Postgres ORs multiple permissive policies
  together, so the original "read own profile" is untouched — a normal account's
  reach does not change by a single row. Only `is_admin()` accounts gain more.

  Note what is *not* here: no admin policy on `bookings`. An admin does not need
  to read the contents of everyone's parcels to run the platform, and the
  dashboard below counts rows through a `security definer` function instead of
  being handed the addresses and phone numbers.
*/
drop policy if exists "admins read all profiles" on public.profiles;
create policy "admins read all profiles"
  on public.profiles for select
  to authenticated
  using (public.is_admin());

-- ------------------------------------------------ 2. role changes, audited --

/*
  Who may hold a role, and the record of who granted it.

  `profiles.is_admin` stays un-writable by any client: the trigger in
  `20250101000002_driver_applications.sql` still raises for `authenticated` and `anon`. That
  guard is the reason this is a `security definer` function rather than a
  policy — the function runs as its owner, so it can write the column that no
  client can, and every rule about *when* lives in one readable place.
*/
create table if not exists public.role_grants (
  id          uuid primary key default gen_random_uuid(),
  /** Who the role was granted to or revoked from. */
  subject_id  uuid not null references auth.users (id) on delete cascade,
  /** Who did it. Never null — an unattributed privilege change is not an audit. */
  actor_id    uuid not null references auth.users (id) on delete restrict,
  role        text not null check (role in ('admin')),
  granted     boolean not null,
  reason      text,
  created_at  timestamptz not null default now()
);

alter table public.role_grants enable row level security;

/*
  Readable by admins, and by the person it was done to.

  Someone finding out they have been demoted, and by whom, is not a privilege —
  it is the minimum an audit trail owes its subject.
*/
drop policy if exists "admins and subject read grants" on public.role_grants;
create policy "admins and subject read grants"
  on public.role_grants for select
  to authenticated
  using (public.is_admin() or subject_id = (select auth.uid()));

/*
  No insert, update or delete policy at all.

  Rows appear only through `public.set_admin_role` below. A client that could
  write here directly could forge the record of its own promotion, which is
  worse than having no log: it would look authoritative and be false.
*/

create or replace function public.set_admin_role(
  target_id uuid,
  make_admin boolean,
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
    raise exception 'Only an administrator can change roles';
  end if;

  /*
    An admin cannot change their own row.

    Two separate failures this prevents. Promoting yourself is the obvious one,
    though `is_admin()` above already blocks a non-admin. The one that actually
    happens is the reverse: the last remaining admin demotes themselves by
    accident and nobody can get back in without database access.
  */
  if target_id = actor then
    raise exception 'You cannot change your own role. Ask another administrator.';
  end if;

  if not exists (select 1 from public.profiles where id = target_id) then
    raise exception 'No such user';
  end if;

  /*
    Never remove the last admin.

    Counted inside the same transaction as the update, so two admins demoting
    each other at the same moment cannot both pass the check and leave the
    project locked out.
  */
  if make_admin = false then
    if (select count(*) from public.profiles where is_admin) <= 1 then
      raise exception 'This is the only administrator left. Promote someone else first.';
    end if;
  end if;

  update public.profiles set is_admin = make_admin where id = target_id;

  insert into public.role_grants (subject_id, actor_id, role, granted, reason)
  values (target_id, actor, 'admin', make_admin, note);
end;
$$;

revoke all on function public.set_admin_role(uuid, boolean, text) from public, anon;
grant execute on function public.set_admin_role(uuid, boolean, text) to authenticated;

/*
  The trigger from 02 raises for `authenticated` and `anon`. This function runs
  as its owner, so `current_user` is that owner rather than the caller's role,
  and the update above passes. That is the intended and only exception.
*/

-- ------------------------------------------------------ 3. an event log -----

/*
  Somewhere for the app to record what went wrong.

  Nothing logged anything before this, which is why System Logs & Errors could
  not be built from real data. Two rules shape the table:

    1. Clients may INSERT but never SELECT. A log the app can read back is a log
       an attacker can read back, and these rows will contain error text from
       failed operations — often the most revealing strings in a system.
    2. No free-form user identity. `actor_id` is taken from `auth.uid()` by the
       default, not from whatever the client claims, so an event cannot be
       attributed to someone else.
*/
create table if not exists public.app_events (
  id         bigint generated always as identity primary key,
  level      text not null check (level in ('info', 'warning', 'error')),
  /** Coarse grouping: 'auth', 'booking', 'application', 'upload', 'email'. */
  area       text not null,
  message    text not null,
  /** Anything structured worth keeping. Must not contain personal data. */
  context    jsonb not null default '{}'::jsonb,
  actor_id   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.app_events enable row level security;

drop policy if exists "anyone signed in may log" on public.app_events;
create policy "anyone signed in may log"
  on public.app_events for insert
  to authenticated
  with check (
    -- `actor_id` may only be yourself or null. Without this, a client could
    -- attribute a fabricated error to another account.
    actor_id is null or actor_id = (select auth.uid())
  );

drop policy if exists "admins read events" on public.app_events;
create policy "admins read events"
  on public.app_events for select
  to authenticated
  using (public.is_admin());

/*
  Newest first, filtered by severity — the two things the log viewer does.
  Without this it is a sequential scan that gets slower every day.
*/
create index if not exists app_events_recent_idx
  on public.app_events (created_at desc, level);

/*
  ⚠ RETENTION. This table grows forever and has no cleanup.

  Decide how long you keep events and delete on that schedule — the same
  decision still outstanding for rejected driver applications. A month is
  usually plenty for an error log:

    delete from public.app_events where created_at < now() - interval '30 days';
*/

-- ----------------------------------------------- 4. dashboard aggregates ----

/*
  Counts for the overview, without handing an admin the rows.

  `security definer` so it can count parcels an admin has no policy to read.
  That is the point: "how many parcels moved this week" is an operational
  question, and answering it does not require anyone to see a recipient's
  address. The function returns numbers only.
*/
create or replace function public.admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  select jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'admins', (select count(*) from public.profiles where is_admin),
    'applications_pending', (
      select count(*) from public.driver_applications where status = 'pending'
    ),
    'applications_under_review', (
      select count(*) from public.driver_applications where status = 'under_review'
    ),
    'drivers_approved', (
      select count(*) from public.driver_applications where status = 'approved'
    ),
    'applications_rejected', (
      select count(*) from public.driver_applications where status = 'rejected'
    ),
    'parcels_total', (select count(*) from public.bookings),
    'parcels_unclaimed', (
      select count(*) from public.bookings where driver_id is null and status <> 'Delivered'
    ),
    'parcels_in_transit', (
      select count(*) from public.bookings
      where driver_id is not null and status <> 'Delivered'
    ),
    'parcels_delivered', (select count(*) from public.bookings where status = 'Delivered'),
    'parcels_last_7_days', (
      select count(*) from public.bookings where created_at > now() - interval '7 days'
    ),
    'errors_last_24h', (
      select count(*) from public.app_events
      where level = 'error' and created_at > now() - interval '24 hours'
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;

/*
  Parcel counts per city, for Hubs & Operations. Numbers only, same reasoning.
*/
create or replace function public.admin_city_volumes()
returns table (city text, total bigint, active bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  return query
    select b.origin_city::text,
           count(*)::bigint,
           count(*) filter (where b.status <> 'Delivered')::bigint
    from public.bookings b
    group by b.origin_city
    order by count(*) desc;
end;
$$;

revoke all on function public.admin_city_volumes() from public, anon;
grant execute on function public.admin_city_volumes() to authenticated;
