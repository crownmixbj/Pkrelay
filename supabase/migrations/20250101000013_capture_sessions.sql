-- LOCI — handing the camera from a browser to a phone.
--
-- Run after 01–12. Re-runnable.
--
-- The problem this solves: the sender photo is taken *before* the parcel is
-- posted, so there is no booking row to attach it to yet. On a phone that does
-- not matter — the photo sits in memory until the booking exists. On the web
-- dashboard the photo is taken on a *different device*, so it needs somewhere
-- to land in between.
--
-- A capture session is that somewhere. The browser creates one, shows its id in
-- a QR code, and waits. The phone opens the deep link, takes the photo, and
-- writes the path back. The browser sees the row change and unlocks the post
-- button.
--
-- The session id is the only thing in the QR code, so it is the only secret.
-- Everything below exists to make sure holding that id is not enough on its
-- own: the session is bound to one account, expires quickly, and can be used
-- once.

do $$
begin
  if to_regclass('public.app_events') is null then
    raise exception 'Run 20250101000007_admin.sql first.';
  end if;
end
$$;

-- -------------------------------------------------------------- the table ---

create table if not exists public.photo_capture_sessions (
  id uuid primary key default gen_random_uuid(),

  /*
    The account that opened the session in the browser.

    The phone must be signed in as the same person. Without this, a QR code
    photographed over someone's shoulder could be completed by a stranger, and
    the sender would post a parcel carrying a photo of somebody else — which is
    worse than carrying no photo, because it looks like evidence.
  */
  owner_id uuid not null references auth.users (id) on delete cascade,

  created_at timestamptz not null default now(),

  /*
    Short. A QR code on a screen is readable by anyone who walks past, and the
    only thing limiting that exposure is how long the code stays useful.

    Ten minutes is long enough to find your phone, unlock it, and open the app;
    short enough that a code left on an abandoned screen is dead before anyone
    sits down at it.
  */
  expires_at timestamptz not null default (now() + interval '10 minutes'),

  /** Path in the `sender-photo` bucket. Null until the phone has uploaded. */
  photo_path text,
  completed_at timestamptz,

  /*
    Set when a booking has actually used this photo. A session is good for one
    parcel: without this, a single photo could be replayed across any number of
    postings from a script.
  */
  consumed_at timestamptz,

  constraint completion_consistent check (
    (photo_path is null and completed_at is null)
    or (photo_path is not null and completed_at is not null)
  )
);

create index if not exists photo_capture_sessions_owner_idx
  on public.photo_capture_sessions (owner_id, created_at desc);

alter table public.photo_capture_sessions enable row level security;

-- ------------------------------------------------------------- policies ----

/*
  A session is visible only to the account that owns it.

  This is what makes the QR id safe to display: someone who photographs the
  code learns a uuid, but reading or writing that row still requires being
  signed in as its owner.
*/
drop policy if exists "owner reads own sessions" on public.photo_capture_sessions;
create policy "owner reads own sessions"
  on public.photo_capture_sessions for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists "owner creates own sessions" on public.photo_capture_sessions;
create policy "owner creates own sessions"
  on public.photo_capture_sessions for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

/*
  No update policy, and no delete policy.

  Completing a session goes through `complete_capture_session` below, so the
  client cannot set `photo_path` to an arbitrary string — including a path
  pointing at a *different* session's object.
*/

-- ------------------------------------------------------------ functions ----

/**
 * Opens a session. Returns the id that goes into the QR code.
 */
create or replace function public.start_capture_session()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  session_id uuid;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  /*
    Expire anything this account left open.

    A sender who reloads the booking page three times should not leave three
    live codes behind, each of which is a photo somebody could complete.
  */
  update public.photo_capture_sessions
     set expires_at = now()
   where owner_id = actor
     and completed_at is null
     and expires_at > now();

  insert into public.photo_capture_sessions (owner_id)
  values (actor)
  returning id into session_id;

  return session_id;
end;
$$;

/**
 * Records the photo the phone just uploaded.
 *
 * The path is *derived* here, not accepted from the caller — the client passes
 * only the file name it used, and this builds the rest. A client that could
 * pass a full path could point a session at any object in the bucket.
 */
create or replace function public.complete_capture_session(
  session_id uuid,
  file_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  row_owner uuid;
  row_expires timestamptz;
  row_completed timestamptz;
  safe_name text;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select owner_id, expires_at, completed_at
    into row_owner, row_expires, row_completed
  from public.photo_capture_sessions where id = session_id;

  if row_owner is null then
    raise exception 'That code is not valid';
  end if;

  /*
    Same account, on both devices.

    This is the check that makes a photographed QR code useless to a stranger.
  */
  if row_owner <> actor then
    raise exception 'That code belongs to a different account';
  end if;

  if row_expires <= now() then
    raise exception 'That code has expired. Refresh the page for a new one.';
  end if;

  if row_completed is not null then
    raise exception 'That code has already been used';
  end if;

  /*
    A bare file name, and nothing that could climb out of the folder.

    `..`, a slash, or a leading dot would let a caller name an object outside
    this session's prefix, which is exactly what deriving the path is meant to
    prevent.
  */
  safe_name := regexp_replace(coalesce(file_name, ''), '[^A-Za-z0-9._-]', '', 'g');
  if safe_name = '' or safe_name like '%..%' or safe_name like '.%' then
    raise exception 'Bad file name';
  end if;

  update public.photo_capture_sessions
     set photo_path = session_id::text || '/' || safe_name,
         completed_at = now()
   where id = session_id;
end;
$$;

/**
 * Hands the photo to a booking, once.
 *
 * Called after the parcel row exists. Marks the session consumed in the same
 * statement that reads it, so two simultaneous postings cannot both claim it.
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

  /*
    Read and mark in one statement.

    `consumed_at is null` inside the UPDATE is what makes this single-use under
    concurrency — a second caller updates zero rows and gets nothing back.
  */
  update public.photo_capture_sessions
     set consumed_at = now()
   where id = session_id
     and owner_id = actor
     and completed_at is not null
     and consumed_at is null
  returning photo_path into claimed_path;

  if claimed_path is null then
    raise exception 'That photo has already been used, or was never completed';
  end if;

  update public.bookings
     set sender_photo_path = claimed_path,
         sender_photo_at = now()
   where id = booking_id;
end;
$$;

revoke all on function public.start_capture_session() from public, anon;
revoke all on function public.complete_capture_session(uuid, text) from public, anon;
revoke all on function public.consume_capture_session(uuid, uuid) from public, anon;
grant execute on function public.start_capture_session() to authenticated;
grant execute on function public.complete_capture_session(uuid, text) to authenticated;
grant execute on function public.consume_capture_session(uuid, uuid) to authenticated;

-- --------------------------------------------------------------- storage ---

/*
  The phone uploads to `<session_id>/<file>`, not `<booking_id>/<file>`.

  The booking does not exist yet, so the policy added in 20250101000012_sender_photo.sql
  has nothing to join on. This one joins on the session instead, and both
  policies coexist: parcels photographed on a phone still write under a booking
  id, web ones write under a session id, and `sender_photo_path` records
  whichever was used.
*/
drop policy if exists "owner uploads capture session photo" on storage.objects;
create policy "owner uploads capture session photo"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'sender-photo'
    and exists (
      select 1 from public.photo_capture_sessions s
      where s.id::text = (storage.foldername(name))[1]
        and s.owner_id = (select auth.uid())
        and s.expires_at > now()
        and s.completed_at is null
    )
  );

drop policy if exists "owner reads capture session photo" on storage.objects;
create policy "owner reads capture session photo"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'sender-photo'
    and (
      public.is_admin()
      or exists (
        select 1 from public.photo_capture_sessions s
        where s.id::text = (storage.foldername(name))[1]
          and s.owner_id = (select auth.uid())
      )
    )
  );

/*
  ⚠ Abandoned sessions accumulate.

    A sender who opens the booking page and leaves creates a row and, if they
    got as far as the phone, an object. Nothing deletes either. Add a scheduled
    job that removes sessions past `expires_at` with `consumed_at is null`, and
    the objects underneath them — this is the fifth retention item outstanding
    in this schema.
*/
