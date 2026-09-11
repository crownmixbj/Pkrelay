-- Fix: the is_admin guard locked out the SQL editor as well as the app.
--
-- The first version of `profiles_guard_admin` raised unconditionally, so
-- `update public.profiles set is_admin = true` failed with
--
--   ERROR: P0001: is_admin can only be changed by a database administrator
--
-- even when run as `postgres`. A BEFORE UPDATE trigger fires for every role —
-- there is no implicit exemption for the service role.
--
-- Run this whole file in the SQL Editor. It replaces the function and then
-- promotes your account. Change the email on the last statement first.
--
-- (`20250101000002_driver_applications.sql` already contains this corrected version, so if
-- you re-run that file you only need the final UPDATE from here.)

create or replace function public.profiles_guard_admin()
returns trigger language plpgsql set search_path = '' as $$
begin
  /*
    PostgREST sets the role to `authenticated` or `anon` per request, so
    `current_user` is one of those for anything from the app. The SQL editor
    runs as `postgres` and falls through.

    Not `security definer`: that would report the owner (postgres) as
    `current_user` for every caller, and the check would never fire.
  */
  if new.is_admin is distinct from old.is_admin
     and current_user in ('authenticated', 'anon') then
    raise exception 'is_admin can only be changed by a database administrator';
  end if;
  return new;
end;
$$;

-- ⬇ Change this to your own email before running.
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'adedapobolaji126@gmail.com');

-- Confirm it worked. Expect one row, is_admin = true.
select u.email, p.is_admin, p.created_at
from public.profiles p
join auth.users u on u.id = p.id
where p.is_admin;
