-- LOCI — a parcel and the selfie that authorised it, in one transaction.

/*
  Run after 01–43. Re-runnable.

  ⚠ The record of who posted a parcel was made by a second call that was
    allowed to fail.

    The sender photographs themselves, the photo uploads into a capture
    session, the booking row is inserted, and *then* the client calls
    `consume_capture_session` to link the two. `book.tsx` catches a failure
    there and discards it, on the reasoning that the parcel is already posted
    and sending somebody back to a completed form would lose the parcel to save
    a link.

    That reasoning is right about the moment and wrong about the design. It
    produces exactly what the admin drawer is showing: a real parcel, a real
    selfie, and nothing joining them — "No selfie on this parcel" beside an
    account that took one. The comment even says the orphan is "visible in the
    admin log"; nothing writes that line.

    Any of these produce it silently: the network dropping between two
    statements, `14_liveness.sql` not being run so the function does not exist,
    the session already spent by a retry, or the tab being closed in the second
    between them.

  ⚠ So the link stops being a second step.

    The session id travels *on the insert*. A BEFORE INSERT trigger claims it
    and fills in the photo, and the policy then requires the result. There is
    no window in which a parcel exists without its evidence, because they are
    written by the same statement.

  ⚠ Which means a parcel with no selfie is now refused outright.

    That is the point — the photo is the record of who handed the driver a box.
    A booking without one is a parcel nobody can be held to. Every path in the
    app already captures one before it will submit; this makes that true of the
    database rather than of the form.
*/

-- ------------------------------------------------------------- the column --

/*
 * ⚠ Recorded, not merely passed through.
 *
 *   Keeping which session authorised a parcel is what makes an investigation
 *   possible later: the liveness verdict, the environment and the timestamp all
 *   live on that row. Accepting the id and throwing it away would leave the
 *   photo path with nothing behind it.
 */
alter table public.bookings
  add column if not exists capture_session_id uuid
    references public.photo_capture_sessions (id);

comment on column public.bookings.capture_session_id is
  'The capture session whose selfie authorised this parcel. Set by the insert '
  'trigger from the id the client supplies; never written directly.';

-- ------------------------------------------------------------ the trigger --

/*
 * Claims the session and fills in the photo, before the row is written.
 *
 * ⚠ Every guard `consume_capture_session` had, kept.
 *
 *   It is the same claim, moved earlier: the session must belong to the person
 *   posting, must have a photo, must not have been spent, and must not have
 *   failed a liveness check. Moving a check is the easiest way to lose one, so
 *   they are enumerated here rather than trusted to the old function — which
 *   stays, because `14_liveness.sql` grants it and something may still call it.
 */
create or replace function public.attach_capture_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_path text;
  claimed_status text;
  claimed_probability numeric;
  claimed_environment text;
  claimed_at timestamptz;
begin
  if new.capture_session_id is null then
    /*
      Left for the policy to refuse rather than raised here.

      A raise would produce "Not signed in"-style noise on any path that
      inserts without a session — including a future admin or service-role
      backfill, which has no business being stopped by a customer-facing rule.
      The policy applies to `authenticated` and says the same thing where it
      belongs.
    */
    return new;
  end if;

  /*
    ⚠ `owner_id = new.sender_id`, not `auth.uid()`.

      This is a definer function running inside an insert. Comparing against
      the caller would be right for a client insert and wrong for anything the
      service role does on somebody's behalf — and comparing against the *row*
      is the actual rule: this parcel's sender must own this photo. The policy
      separately pins `sender_id = auth.uid()` for clients.
  */
  update public.photo_capture_sessions
     set consumed_at = now()
   where id = new.capture_session_id
     and owner_id = new.sender_id
     and completed_at is not null
     and photo_path is not null
     and consumed_at is null
  returning photo_path, liveness_status, liveness_probability, liveness_environment,
            liveness_checked_at
    into claimed_path, claimed_status, claimed_probability, claimed_environment, claimed_at;

  if claimed_path is null then
    raise exception
      'That photo has already been used, was never completed, or is not yours'
      using errcode = 'check_violation';
  end if;

  /*
    ⚠ 'unavailable' passes; 'failed' does not.

      14_liveness.sql made this call and it still holds. A provider outage is
      not the sender's fault and blocking every parcel in the country over one
      would be a worse failure than recording an unchecked photo. A photo that
      was checked and *failed* is different: something was held up to the
      camera that was not a live face.
  */
  if claimed_status = 'failed' then
    raise exception 'That photo did not pass the liveness check. Take another.'
      using errcode = 'check_violation';
  end if;

  new.sender_photo_path := claimed_path;
  new.sender_photo_at := now();
  new.liveness_status := claimed_status;
  new.liveness_probability := claimed_probability;
  new.liveness_environment := claimed_environment;
  new.liveness_checked_at := claimed_at;

  return new;
end;
$$;

drop trigger if exists on_booking_attach_capture on public.bookings;
create trigger on_booking_attach_capture
  before insert on public.bookings
  for each row execute function public.attach_capture_on_insert();

-- --------------------------------------------------------------- the policy --

/*
  Replaces "sender creates own" from 42, which replaced 09's, which replaced 01's.

  ⚠ Every earlier guard repeated verbatim, for the fourth time.

    09 left the warning and it has held every time since: recreating this policy
    with only the new condition would quietly drop the others and let a client
    post a parcel pre-assigned to a driver.

  ⚠ The new line reads the *result* of the trigger, which is why this works.

    Postgres applies a policy's WITH CHECK to the row after BEFORE ROW triggers
    have had it — the same ordering that made 39 and 02 collide, learned the
    hard way in `40_review_controls.sql`. So by the time this is evaluated,
    `sender_photo_path` is either filled in by the trigger or it is null because
    no usable session was supplied. Requiring it here needs no second query.
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
    and public.is_verified_sender()
    and sender_photo_path is not null
  );

notify pgrst, 'reload schema';
