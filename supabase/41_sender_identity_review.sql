-- LOCI — a person decides the sender identity checks a machine could not.

/*
  Run after 01–40. Re-runnable.

  ⚠ Until now nothing but Dojah could move a sender's identity status.

    `record_identity_result` is service-role only and writes 'verified' or
    'flagged'. `admin_flagged_identities` returns a list an admin can read and
    nothing they can act on — status, confidence, last four digits, no verdict.
    So a flagged sender stayed flagged forever, and a sender whose check never
    ran at all stayed 'pending' forever.

    The second case is not hypothetical. Until `verify-identity` is deployed,
    *every* sender who completes onboarding lands at 'pending' and stops there.
    That is the state the profile screen is in today.

  ⚠ 'flagged' still means what it meant. 'rejected' is a new, human thing.

    28_sender_identity.sql chose 'flagged' over 'rejected' on purpose: an
    automated mismatch is weak evidence — an old NIMC photo, a dark room, a bad
    camera — and refusing a customer on it locks real people out with no
    recourse. That reasoning is untouched. A machine still only ever flags.

    'rejected' is reachable exclusively through `admin_review_identity` below,
    which is to say: only when a person has looked at the slip and the face and
    decided. Different evidence, different word, different consequence.

  ⚠ And a rejection is a door, not a wall.

    A rejected sender is blocked from posting — but the block exists to get a
    better photo, not to end the relationship. `begin_identity_check` clears the
    rejection on resubmission, the sender is told why in the app and by email,
    and the reason is a required field. A block with no route out is the failure
    this codebase keeps having to design against.
*/

-- ------------------------------------------------------- the review record --

alter table public.sender_identity
  add column if not exists review_note text,
  add column if not exists reviewed_by uuid references auth.users (id),
  add column if not exists reviewed_at timestamptz;

/*
 * ⚠ The selfie that was checked, kept whatever the verdict.
 *
 *   `reference_path` is deliberately only ever written on a *match*, so that no
 *   later comparison is made against a face nobody confirmed. That rule stands.
 *   But it left an admin reviewing a flagged account with no way to see the
 *   photo that caused the flag, and no photo to promote if they decide the
 *   machine was wrong.
 *
 *   `candidate_path` is that photo. Same bucket, same sensitivity as the
 *   reference — it is the same image — but explicitly *unconfirmed*, which is
 *   why it is a separate column rather than an early write to `reference_path`.
 */
alter table public.sender_identity
  add column if not exists candidate_path text;

comment on column public.sender_identity.candidate_path is
  'Sensitive personal data under NDPA 2023 s.65. The selfie a check was run '
  'against, confirmed or not. Promoted to reference_path only by a match or an '
  'administrator.';

alter table public.sender_identity
  drop constraint if exists sender_identity_status_check;

alter table public.sender_identity
  add constraint sender_identity_status_check
  check (status in ('unverified', 'pending', 'verified', 'flagged', 'rejected'));

/*
 * ⚠ A rejection must carry its reason, in the table.
 *
 *   The reason is shown to the sender in the app and sent to them by email. A
 *   status of 'rejected' beside a null note is a person told they were refused
 *   and not told why — the one outcome they cannot act on. Making it a
 *   constraint means no future call site, script or SQL-editor update can
 *   produce that row.
 */
alter table public.sender_identity
  drop constraint if exists sender_identity_rejection_has_reason;

alter table public.sender_identity
  add constraint sender_identity_rejection_has_reason
  check (status <> 'rejected' or coalesce(btrim(review_note), '') <> '');

-- --------------------------------------- the candidate, recorded either way --

/*
  Replaces 28's version. The only change is `candidate_path`: written on every
  verdict, where `reference_path` continues to be written on a match alone.
*/
create or replace function public.record_identity_result(
  target uuid,
  verdict text,
  reference text default null,
  score numeric default null,
  env text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if verdict not in ('verified', 'flagged', 'unavailable') then
    raise exception 'Unknown verdict %', verdict;
  end if;

  if verdict = 'unavailable' then
    update public.sender_identity
       set checked_at = now(),
           environment = coalesce(env, environment),
           candidate_path = coalesce(reference, candidate_path)
     where user_id = target;

    insert into public.app_events (level, area, message, context, actor_id)
    values (
      'warning', 'identity', 'identity check could not be completed',
      jsonb_build_object('user', target), null
    );
    return;
  end if;

  update public.sender_identity
     set status = verdict,
         confidence = score,
         environment = coalesce(env, environment),
         checked_at = now(),
         verified_at = case when verdict = 'verified' then now() else verified_at end,
         candidate_path = coalesce(reference, candidate_path),
         reference_path = case
           when verdict = 'verified' then coalesce(reference, reference_path)
           else reference_path
         end
   where user_id = target;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    case when verdict = 'verified' then 'info' else 'warning' end,
    'identity',
    'identity check completed',
    jsonb_build_object('user', target, 'verdict', verdict, 'confidence', score),
    null
  );
end;
$$;

revoke all on function public.record_identity_result(uuid, text, text, numeric, text)
  from public, anon, authenticated;

-- ------------------------------------------- resubmission clears the verdict --

/*
  Replaces 28's version. The only change is that a previous review is cleared.

  ⚠ Without this, a rejected sender who submits a better photo keeps the
    rejection note and the rejected status, and the check constraint above
    keeps the row consistent while the *sender* stays blocked. They would have
    done everything asked and be no better off — which is the exact shape of
    failure the header warns about.
*/
create or replace function public.begin_identity_check(
  sender_nin text,
  sender_slip_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  digits text := regexp_replace(coalesce(sender_nin, ''), '\D', '', 'g');
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if digits !~ '^[0-9]{11}$' then
    raise exception 'A NIN is 11 digits';
  end if;

  if sender_slip_path is null or split_part(sender_slip_path, '/', 1) <> actor::text then
    raise exception 'That file does not belong to this account';
  end if;

  insert into public.sender_identity (user_id, nin, slip_path, status)
  values (actor, digits, sender_slip_path, 'pending')
  on conflict (user_id) do update
    set nin = excluded.nin,
        slip_path = excluded.slip_path,
        status = 'pending',
        confidence = null,
        verified_at = null,
        checked_at = null,
        -- The review this submission supersedes.
        review_note = null,
        reviewed_by = null,
        reviewed_at = null;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'identity', 'sender started identity onboarding',
    jsonb_build_object('nin_last4', right(digits, 4)),
    actor
  );
end;
$$;

revoke all on function public.begin_identity_check(text, text) from public, anon;
grant execute on function public.begin_identity_check(text, text) to authenticated;

-- ---------------------------------------------------------------- the queue --

/*
 * What is waiting for a person.
 *
 * ⚠ 'pending' belongs here as much as 'flagged', and leaving it out was the
 *   whole problem.
 *
 *   'flagged' is waiting on a person because a machine disagreed. 'pending' is
 *   waiting on a person because no machine ever answered — the check was never
 *   run, or Dojah was unreachable. To the sender both are identical: they did
 *   what was asked and nothing happened. A queue that shows only the first
 *   reports a small, calm number while the second grows without bound.
 *
 * ⚠ Still no NIN and still no photo paths.
 *
 *   Same shape as `admin_flagged_identities`, for the same reason: working the
 *   queue and looking at somebody's face are different acts, and only the
 *   second one should be audited. The paths come from the reveal below.
 */
create or replace function public.admin_identity_queue()
returns table (
  user_id uuid,
  full_name text,
  email text,
  status text,
  confidence numeric,
  nin_last4 text,
  has_slip boolean,
  has_selfie boolean,
  submitted_at timestamptz,
  checked_at timestamptz,
  review_note text,
  reviewed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    i.user_id,
    p.full_name,
    u.email,
    i.status,
    i.confidence,
    right(i.nin, 4),
    i.slip_path is not null,
    coalesce(i.candidate_path, i.reference_path) is not null,
    i.created_at,
    i.checked_at,
    i.review_note,
    i.reviewed_at
  from public.sender_identity i
  left join public.profiles p on p.id = i.user_id
  left join auth.users u on u.id = i.user_id
  where public.is_admin()
    and i.status in ('pending', 'flagged', 'rejected', 'verified')
  order by
    -- What nobody has decided, oldest first. Decided rows sort after.
    case when i.status in ('pending', 'flagged') then 0 else 1 end,
    i.created_at;
$$;

revoke all on function public.admin_identity_queue() from public, anon;
grant execute on function public.admin_identity_queue() to authenticated;

-- --------------------------------------------------------------- the reveal --

/*
 * The slip and the selfie for one sender, by account rather than by parcel.
 *
 * ⚠ 37's reveal is keyed on a booking, and a sender in this queue may have none.
 *
 *   That is not an edge case: the sender most likely to be sitting here is one
 *   who has just verified from their profile and has never posted anything.
 *   `admin_reveal_sender_identity(booking_id)` returns no rows for them, so
 *   the only way to review the account would be to not look at it.
 *
 * ⚠ It writes the same audit line, into the same table, at the same level.
 *
 *   37's argument against a second reveal was that two doors mean two log lines
 *   for one act of looking, and a reason box that becomes a formality. This is
 *   the same door with a different key: one row in `app_events`, marked
 *   'privacy', naming the actor and carrying their reason.
 */
create or replace function public.admin_reveal_identity_for_user(
  target uuid,
  reason text default null
)
returns table (
  selfie_path text,
  slip_path text,
  nin_last4 text,
  identity_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'privacy',
    'admin revealed sender identity',
    jsonb_build_object(
      'subject', target,
      'reason', left(coalesce(reason, ''), 200)
    ),
    actor
  );

  return query
    select
      /*
       * The candidate first: it is the photo the verdict was reached about.
       * Falling back to the reference means an already-verified account still
       * shows a face, which is the point of being able to look one up.
       */
      coalesce(i.candidate_path, i.reference_path),
      i.slip_path,
      right(i.nin, 4),
      i.status
    from public.sender_identity i
    where i.user_id = target;
end;
$$;

revoke all on function public.admin_reveal_identity_for_user(uuid, text) from public, anon;
grant execute on function public.admin_reveal_identity_for_user(uuid, text) to authenticated;

-- ------------------------------------------------------------- the decision --

/*
 * A person's verdict on a sender's identity.
 *
 * ⚠ The only path to 'verified' or 'rejected' that is not a machine's.
 */
create or replace function public.admin_review_identity(
  target uuid,
  verdict text,
  note text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  current_status text;
  candidate text;
  clean_note text := nullif(btrim(coalesce(note, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can review an identity';
  end if;

  if verdict not in ('verified', 'rejected') then
    raise exception 'Unknown verdict %', verdict;
  end if;

  /*
    ⚠ Required on a rejection, optional on an approval, and that asymmetry is
      not laziness.

      A refusal is the outcome the sender has to act on, so it has to say what
      to do. An approval has nothing to explain and nobody to explain it to —
      and a mandatory box with nothing to put in it gets filled with "ok",
      which teaches everyone that the rejection box can be filled with "ok"
      too.
  */
  if verdict = 'rejected' and clean_note is null then
    raise exception 'A rejection must record a reason'
      using errcode = 'check_violation';
  end if;

  select i.status, coalesce(i.candidate_path, i.reference_path)
    into current_status, candidate
    from public.sender_identity i
   where i.user_id = target
   for update;

  if current_status is null then
    raise exception 'That account has not submitted an identity';
  end if;

  /*
    ⚠ Only what is actually waiting.

      'unverified' has submitted nothing — approving it would verify an account
      on no evidence at all. 'verified' and 'rejected' have been decided; a
      second decision would overwrite `reviewed_by` and lose who made the first
      one. A sender who needs a decision reversed resubmits, which is a path
      that leaves both records intact.
  */
  if current_status not in ('pending', 'flagged') then
    raise exception 'That identity is not awaiting review (it is %)', current_status
      using errcode = 'check_violation';
  end if;

  update public.sender_identity
     set status = verdict,
         review_note = clean_note,
         reviewed_by = actor,
         reviewed_at = now(),
         verified_at = case when verdict = 'verified' then now() else verified_at end,
         /*
           ⚠ Promoted here, and only here, by a person.

             `record_identity_result` refuses to promote an unmatched selfie,
             correctly: no automated comparison should be made against a face a
             machine did not confirm. An administrator approving *is* the
             confirmation — they have just looked at this photo beside the slip.
             Without this the sender is verified but has no reference, so every
             future shipment falls back to a selfie that is recorded and never
             compared, permanently.
         */
         reference_path = case
           when verdict = 'verified' then coalesce(reference_path, candidate)
           else reference_path
         end
   where user_id = target;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    case when verdict = 'verified' then 'info' else 'warning' end,
    'identity',
    'admin reviewed sender identity',
    /* The reason, never the NIN. */
    jsonb_build_object(
      'subject', target,
      'verdict', verdict,
      'was', current_status,
      'reason', left(coalesce(clean_note, ''), 200)
    ),
    actor
  );

  return verdict;
end;
$$;

revoke all on function public.admin_review_identity(uuid, text, text) from public, anon;
grant execute on function public.admin_review_identity(uuid, text, text) to authenticated;

-- ----------------------------------------------------- what the sender hears --

/*
 * ⚠ The kind has to be admitted by the outbox before anything can queue it.
 *
 *   `email_outbox.kind` carries a `check (kind in (...))` listing every email
 *   this system sends. Writing the trigger without widening it produces a
 *   constraint violation *inside* `queue_email` — which runs in the same
 *   transaction as the rejection, so the reviewer's click fails with a message
 *   about a check constraint and the decision is rolled back.
 *
 *   The list is closed on purpose: a typo'd kind would otherwise queue a row
 *   no template can render, and the failure would surface at the mail sender,
 *   hours later, with nobody watching. `verify-emails.ts` compares this list
 *   against the template map for the same reason, and is what caught this.
 */
alter table public.email_outbox
  drop constraint if exists email_outbox_kind_check;

alter table public.email_outbox
  add constraint email_outbox_kind_check
  check (kind in (
    'driver_application_approved',
    'driver_application_rejected',
    'guarantor_invitation',
    'sender_verification_submitted',
    'sender_verified',
    'sender_verification_rejected',
    'delivery_completed',
    'parcel_cancelled',
    'parcel_status_changed',
    'driver_offer',
    'driver_job_cancelled',
    'payout_paid'
  ));

/*
 * ⚠ Approval already emails; rejection sent nothing.
 *
 *   38's `on_sender_verified` fires on the way into 'verified' — which now
 *   includes an administrator's approval, at no extra cost. There was no
 *   counterpart for a refusal, so a rejected sender would learn about it only
 *   by reopening the app, which is exactly the population least likely to.
 *
 * ⚠ The reason travels. The NIN does not, and neither does any photo path.
 *
 *   Same rule as every other LOCI email: the outbox is a table an admin can
 *   read and a payload that ends up at a mail provider, so nothing goes in it
 *   that cannot survive being there.
 */
create or replace function public.email_on_sender_rejected()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status or new.status <> 'rejected' then
    return new;
  end if;

  perform public.queue_email(
    'sender_verification_rejected',
    /*
      ⚠ The subject id is the *decision*, not the person.

        `email_outbox` is unique on (kind, subject_id) with `on conflict do
        nothing` — that is what makes it exactly-once. Keyed on the user alone,
        a sender rejected, resubmitting, and rejected again for a different
        reason is told once, and the reason that goes missing is the one about
        the photo they just replaced.

      ⚠ Full precision, because seconds are not enough.

        The first version truncated to whole seconds, and the harness caught it
        immediately: a reject-resubmit-reject cycle completes inside one second
        comfortably, and the second email was silently swallowed by the
        conflict clause. `timestamptz::text` carries microseconds.

        Two rejections *inside one transaction* would still collide, because
        `now()` is transaction-start time. That cannot happen through
        `admin_review_identity`, which locks the row and refuses a second
        decision on it — but it is the assumption this key rests on.
    */
    new.user_id::text || ':' || new.reviewed_at::text,
    public.email_for_user(new.user_id),
    jsonb_build_object('reason', coalesce(new.review_note, ''))
  );

  return new;
end;
$$;

drop trigger if exists on_sender_rejected on public.sender_identity;
create trigger on_sender_rejected
  after update of status on public.sender_identity
  for each row execute function public.email_on_sender_rejected();

notify pgrst, 'reload schema';
