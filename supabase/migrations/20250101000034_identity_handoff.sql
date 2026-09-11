-- LOCI — carrying the NIN match from the session onto the application.
--
-- Run after 01–33. Re-runnable.
--
-- ⚠ This fixes a verdict that was being thrown away.
--
--   `verify-identity` recorded its answer with:
--
--     PATCH driver_applications?user_id=eq.<caller>&status=eq.pending
--
--   and the driver form called it *before* inserting the application. For a
--   first-time applicant — which is every applicant, once — there was no
--   pending row, so the PATCH matched nothing and the four identity columns
--   stayed null. A reviewer opening that application could not tell the
--   difference between "the check said nothing" and "the check never ran", and
--   the honest reading of a null was the second one.
--
--   Moving the capture onto page three of the wizard widened that gap from
--   milliseconds to however long somebody takes to read a summary and tick a
--   box, so it had to be closed rather than lived with.
--
-- The fix follows 20250101000014_liveness.sql exactly: the verdict is written on the
-- session, where the photo already is and where it can exist before there is an
-- application, and copied across once the application has been created.

do $$
begin
  if to_regclass('public.photo_capture_sessions') is null then
    raise exception 'Run 20250101000013_capture_sessions.sql first.';
  end if;
  if to_regclass('public.driver_applications') is null then
    raise exception 'Run 20250101000002_driver_applications.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------- columns -----

/*
  The same four columns `driver_applications` already carries, on the session.

  Identical names on purpose: one guard function covers both tables, the way
  `guard_liveness_columns` covers bookings and sessions together.
*/
alter table public.photo_capture_sessions
  add column if not exists identity_status text
    check (identity_status in ('matched', 'mismatch', 'unavailable')),
  /** 0–100 as the provider reported it. Null when there was no number. */
  add column if not exists identity_confidence numeric,
  /*
    Sandbox or production, for the same reason liveness records it: a 'matched'
    from sandbox is a mock service agreeing with a photo it never compared, and
    nobody reading this row later can be expected to remember how the
    deployment was configured that week.
  */
  add column if not exists identity_environment text
    check (identity_environment in ('sandbox', 'production')),
  add column if not exists identity_checked_at timestamptz;

-- --------------------------------------------------------------- guards ----

/**
 * No client writes an identity verdict about itself.
 *
 * Recreated from 20250101000016_driver_identity.sql with one addition: the transaction-local
 * exemption `attach_identity_result` sets. Everything else is unchanged — the
 * edge function holds the service role and `auth.uid()` is null there, so it
 * passes; every other caller has a session and is refused.
 *
 * ⚠ The exemption is a GUC, not a role check, and it is `is_local => true`.
 *
 *   It exists only inside the transaction the function below runs in, and no
 *   client can set it: PostgREST executes named functions, not arbitrary SQL,
 *   and nothing in this schema is a `set_config` passthrough. Same mechanism as
 *   `loci.erasing` in 20250101000033_erase_repair.sql.
 */
create or replace function public.guard_identity_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if current_setting('loci.attaching_identity', true) = 'on' then
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

drop trigger if exists photo_capture_sessions_guard_identity on public.photo_capture_sessions;
create trigger photo_capture_sessions_guard_identity
  before update on public.photo_capture_sessions
  for each row execute function public.guard_identity_columns();

-- ------------------------------------------- carry it onto the application ---

/**
 * Copies the session's verdict onto a newly created application.
 *
 * Called by the applicant, right after their application row exists. This is
 * the only client-reachable path to those columns, and it can only ever copy a
 * value the verification service put on a session — the exemption above is set
 * around one UPDATE and released with the transaction.
 *
 * ⚠ Both sides are scoped to the caller.
 *
 *   Definer means RLS is not doing this for us. Without the two ownership
 *   checks an applicant could name somebody else's session, or stamp a verdict
 *   on somebody else's application.
 */
create or replace function public.attach_identity_result(
  application_id uuid,
  session_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  /*
    ⚠ Not called `found`. That is a plpgsql special variable, and shadowing it
      turns every `if not found` below into a type error at runtime.
  */
  verdict record;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select identity_status, identity_confidence, identity_environment, identity_checked_at
    into verdict
    from public.photo_capture_sessions
   where id = session_id
     and owner_id = actor;

  if not found then
    raise exception 'That photo session is not yours';
  end if;

  /*
    Nothing to copy is not an error.

    The check may not have run — no Dojah credentials on this deployment, or a
    provider timeout. The application is meant to go through either way, and
    raising here would turn "we could not check you" into "you cannot apply".
  */
  if verdict.identity_status is null then
    return;
  end if;

  perform set_config('loci.attaching_identity', 'on', true);

  update public.driver_applications
     set identity_status = verdict.identity_status,
         identity_confidence = verdict.identity_confidence,
         identity_environment = verdict.identity_environment,
         identity_checked_at = verdict.identity_checked_at
   where id = application_id
     and user_id = actor;

  if not found then
    raise exception 'That application is not yours';
  end if;
end;
$$;

revoke all on function public.attach_identity_result(uuid, uuid) from public, anon;
grant execute on function public.attach_identity_result(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
