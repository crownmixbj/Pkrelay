-- LOCI — the admin decision, and the insert that 39 quietly made impossible.

/*
  ⚠ Every driver application with a guarantor was being refused at the door.

  02 wrote the insert policy when `pending` was the only status an applicant
  could start at:

      with check (user_id = auth.uid() and status = 'pending' and ...)

  39 then added a BEFORE INSERT trigger that rewrites the status to
  `pending_guarantor`. Postgres evaluates a policy's WITH CHECK against the row
  *after* BEFORE ROW triggers have had it — so the trigger sets a value the
  policy then rejects, and the insert fails with "new row violates row-level
  security policy for table driver_applications".

  Nothing in either file is wrong on its own. The trigger is right, the policy
  was right, and the combination refuses every driver who names a guarantor —
  which, since 39, is every driver. There is no partial failure and no bad row
  to find afterwards: the application simply never exists.

  The fix keeps the guarantee 02 was actually making — *an applicant cannot
  submit themselves pre-approved* — and stops it from also being a hard-coded
  list of one status that a later migration has to remember.
*/

-- ------------------------------------- the trigger decides, not the client --

/*
  ⚠ Both branches, unconditionally.

  39's version only wrote a status when there was a guarantor email, leaving the
  other case to whatever the client sent. That is the shape that let the two
  files disagree. Here the status of a *new* application is not something a
  caller can express an opinion about at all: name a guarantor and you are
  waiting on them, name nobody and you are in the queue. The policy below then
  has only two values to admit, and both are ones this function produced.
*/
create or replace function public.default_application_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.guarantor_email is not null and btrim(new.guarantor_email) <> '' then
    new.status := 'pending_guarantor';
  else
    new.status := 'pending';
  end if;

  /*
    Belt and braces with the policy. An insert made by the service role — a
    backfill, the SQL editor — skips RLS entirely, so this is the only thing
    standing between a script and a self-approved driver.
  */
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.review_note := null;

  return new;
end;
$$;

drop trigger if exists on_application_status_default on public.driver_applications;
create trigger on_application_status_default
  before insert on public.driver_applications
  for each row execute function public.default_application_status();

-- ------------------------------------------------------------- the policy --

/*
  ⚠ The two statuses an application may be *born* at.

  Not "the two the trigger happens to write": stated here so that a third one
  added later fails loudly at insert time rather than silently widening what an
  applicant can claim about themselves.
*/
drop policy if exists "applicant submits own" on public.driver_applications;
create policy "applicant submits own"
  on public.driver_applications for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and status in ('pending', 'pending_guarantor')
    and reviewed_by is null
    and reviewed_at is null
  );

-- ------------------------------------------ an admin cannot jump the queue --

/*
  ⚠ Approving a `pending_guarantor` application is approving an unvetted driver.

  The whole point of 39 is that somebody who is not the applicant vouches for
  them before LOCI does. An admin who approves while the invitation is still
  unopened has skipped exactly that, and the row afterwards is indistinguishable
  from one that went through properly — `approved`, with a guarantor row that
  does not exist.

  The screen hides the buttons in that state, but a screen is a courtesy. This
  is the rule.

  Rejecting is deliberately still allowed: an application can be obviously bad
  on its face — a fake licence, a banned account — and making the reviewer wait
  on a guarantor email before they may act on that would be absurd.
*/
create or replace function public.guard_application_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'approved' and old.status = 'pending_guarantor' then
    raise exception
      'cannot approve while the guarantor has not confirmed (application %)', old.id
      using errcode = 'check_violation';
  end if;

  /*
    ⚠ A rejection has to say why.

    `review_note` is already shown to the driver on their timeline and is
    already the `reason` field in the rejection email. Both have been rendering
    an empty space since the day they were written, because no call site ever
    passed one. Requiring it here is what makes them true.
  */
  if new.status = 'rejected' and old.status <> 'rejected'
     and coalesce(btrim(new.review_note), '') = '' then
    raise exception 'a rejection must record a reason (application %)', old.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists on_application_decision_guard on public.driver_applications;
create trigger on_application_decision_guard
  before update of status on public.driver_applications
  for each row execute function public.guard_application_decision();
