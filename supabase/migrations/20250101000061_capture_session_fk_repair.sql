-- ============================================================================
-- 20250101000061_capture_session_fk_repair.sql — erasure can delete a capture
--                                                 session again
-- ============================================================================
--
-- Run after 01–60. Re-runnable.
--
-- ⚠ What was broken: erasing anybody who has posted a parcel since 44.
--
--   `erase_person` (09, repaired in 33) deletes the subject's capture sessions —
--   they are the most sensitive rows in the schema, a national identifier beside
--   a photograph of a face, so 33 deletes them rather than overwriting them.
--
--   44 then added `bookings.capture_session_id` referencing that table, with no
--   `on delete` action, which in Postgres means `no action`. From that migration
--   onwards the delete in 33 hits a parcel that still points at the session and
--   raises:
--
--     update or delete on table "photo_capture_sessions" violates foreign key
--     constraint "bookings_capture_session_id_fkey" on table "bookings"
--
--   The exception aborts the whole function, so an NDPR erasure request for an
--   ordinary sender failed outright and nothing was scrubbed. The Admin screen
--   showed the database's message verbatim, which is the only reason it was
--   visible at all.
--
--   Neither file is wrong on its own. 33 is right to delete the sessions; 44 is
--   right to keep which session authorised a parcel. What was missing is what
--   should happen to the pointer when the session goes, and nobody wrote it
--   down — so Postgres chose the strictest answer.
--
-- ⚠ `set null`, not `cascade`, and the difference is somebody else's data.
--
--   `cascade` would delete the *parcel* when its capture session is deleted.
--   33 already argues this case about the sender's own bookings: a recipient's
--   delivery history is theirs, and destroying it to satisfy somebody else's
--   erasure request is the wrong trade. Cascading here would do exactly that,
--   and quietly — an erasure would take a stranger's completed delivery with it.
--
--   `set null` keeps the parcel, the route and the fare, and loses the pointer
--   to a row that no longer exists. Nothing is lost that survives the erasure
--   anyway: the session it pointed at is deleted in the same statement.
--
-- ⚠ Not a rewrite of `erase_person`.
--
--   The other available fix is to null `bookings.capture_session_id` inside that
--   function before the delete. It would work, and it would mean retyping 160
--   lines of a pushed function whose every statement exists because something
--   leaked — which is the failure CLAUDE.md names as this codebase's most
--   repeated. A foreign key's own missing clause belongs on the foreign key.
--
-- ⚠ The insert trigger is untouched.
--
--   `guard_parcel_selfie` in 44 still requires a completed, passed session on
--   *insert*. This changes nothing about posting a parcel: a null
--   `capture_session_id` can only arrive here by way of an erasure, never from
--   a client.
--
-- Applies cleanly whether or not 44 has been applied, and whatever the
-- constraint ended up being called.

do $$
declare
  existing text;
begin
  if to_regclass('public.bookings') is null then
    raise exception 'Run 20250101000001_bookings.sql first.';
  end if;

  /*
   * Nothing to repair on a project that never applied 44. The column arrives
   * with the constraint already correct, because this file will have run by the
   * time anybody adds it — so say so and stop rather than raising.
   */
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'bookings'
       and column_name = 'capture_session_id'
  ) then
    raise notice 'bookings.capture_session_id does not exist yet — nothing to repair.';
    return;
  end if;

  /*
   * Found by catalog, not by name.
   *
   * ⚠ `bookings_capture_session_id_fkey` is what Postgres generated for 44, and
   *   naming it in a `drop constraint` would be right on every project that ran
   *   these files in order — and wrong on one where somebody added the column by
   *   hand in the SQL editor, which is exactly how the staging project has been
   *   fixed before. So this asks the catalog which constraint sits on that
   *   column and drops whatever it is called.
   */
  select con.conname
    into existing
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = any (con.conkey)
   where con.conrelid = 'public.bookings'::regclass
     and con.contype = 'f'
     and att.attname = 'capture_session_id'
   limit 1;

  if existing is not null then
    /*
      Already correct? Leave it alone. `confdeltype` is 'n' for set null and 'a'
      for no action — re-running this file should not churn a constraint that is
      already what it should be, because dropping and re-adding one takes a lock
      on `bookings` and this table is the busiest in the schema.
    */
    if (select confdeltype from pg_constraint where conname = existing
         and conrelid = 'public.bookings'::regclass) = 'n' then
      raise notice 'capture_session_id already has on delete set null — nothing to do.';
      return;
    end if;

    execute format('alter table public.bookings drop constraint %I', existing);
  end if;

  alter table public.bookings
    add constraint bookings_capture_session_id_fkey
    foreign key (capture_session_id)
    references public.photo_capture_sessions (id)
    on delete set null;
end
$$;

comment on column public.bookings.capture_session_id is
  'The capture session whose selfie authorised this parcel. Set by the insert '
  'trigger from the id the client supplies; never written directly. Null only '
  'after the sender was erased — 61 made this on delete set null so that '
  'erasing the session does not take the parcel, or the erasure, with it.';

/*
 * A note for whoever reads this next, because the interesting part is the class
 * of bug rather than this instance of it.
 *
 * Two safe changes, eleven migrations apart, combined into a broken one. Every
 * later table that references a row an erasure deletes has the same trap, and
 * the question to ask of each is: what should happen to this pointer when the
 * thing it points at is erased? `notifications` (49) and `support_tickets` (59)
 * both answer it explicitly — cascade from `auth.users`, because an inbox or a
 * thread left behind is a leak with no owner. 44 simply never asked.
 *
 * `scripts/pg/erase-harness.mjs` now builds `bookings.capture_session_id` with
 * the real foreign key and seeds a parcel that uses it, so the next one of these
 * fails a test instead of an NDPR request.
 */

-- ------------------------------------------------ something to ask for ------

/*
 * A function whose only job is to be askable, and which answers from the live
 * catalog rather than by existing.
 *
 * ⚠ 55 set this precedent and the reason is the same one.
 *
 *   The deployment panel (`src/lib/schema-gap.ts` → `src/store/deployment.ts`)
 *   asks PostgREST which functions are exposed, and translates a missing one
 *   into the filename to run. A migration that adds no function is invisible to
 *   it — and `verify-identity-review.ts` fails the build when the newest
 *   migration is not on that panel, precisely because the list once stopped at
 *   37 while the app shipped 41.
 *
 *   So this repair carries a probe. Unlike a constant it keeps telling the
 *   truth after the migration has run: drop the constraint and re-add it without
 *   the clause — which is how it went missing the first time — and this starts
 *   answering false while still existing.
 *
 * ⚠ Definer, and readable by any signed-in account, which is safe here.
 *
 *   It returns one boolean about the shape of the schema. There is no row, no
 *   id and nothing about a person in the answer; the alternative is a probe only
 *   an admin can call, which would report the repair as missing to everybody
 *   else and make the panel lie on the screen most people see.
 */
create or replace function public.capture_session_fk_repaired()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_attribute att
        on att.attrelid = con.conrelid
       and att.attnum = any (con.conkey)
     where con.conrelid = 'public.bookings'::regclass
       and con.contype = 'f'
       and att.attname = 'capture_session_id'
       /* 'n' is set null. 'a' is the no-action default that broke erasure. */
       and con.confdeltype = 'n'
  );
$$;

comment on function public.capture_session_fk_repaired() is
  'True when bookings.capture_session_id has on delete set null, so erasing a '
  'sender who has posted a parcel succeeds. Read by the deployment panel.';

revoke all on function public.capture_session_fk_repaired() from public, anon;
grant execute on function public.capture_session_fk_repaired() to authenticated;
