-- LOCI — the reviewer sees the photo the sender actually took.

/*
  Run after 01–42. Re-runnable.

  ⚠ The review queue could not see the one thing it exists to look at.

    41 built a queue so a person can decide an identity when no machine has.
    Its evidence comes from `sender_identity.candidate_path`, falling back to
    `reference_path` — and *both of those columns are written only by
    `record_identity_result`*, which is called only by the `verify-identity`
    edge function.

    So on a database where that function is not deployed — which is the exact
    situation the queue was built for, and the situation every LOCI database is
    in today — the sender takes a selfie, it uploads, and the reviewer is told
    "No selfie on file. There may be nothing to compare."

    The message was true about the table it read and false about the world. The
    photo is in `photo_capture_sessions.photo_path`, where the capture flow put
    it, and nothing joined the two.

  ⚠ This is a hole in 41 rather than a change of mind.

    I built the human fallback for "no automated check ran" and then made its
    evidence depend on a column only the automated check writes. The fix is to
    read the capture session directly, so the queue works whether or not Dojah
    is in the picture.

  ⚠ Reading the session does not lower the bar on what is promoted.

    28 is emphatic that `reference_path` may only ever be set from a confirmed
    match, because every later shipment is compared against it. That still
    holds: the session photo is promoted *only* by `admin_review_identity`,
    where a named administrator has ticked a box saying they compared it to the
    slip. A machine still cannot promote an unmatched face.
*/

-- --------------------------------------------------- the selfie, wherever it is --

/*
 * ⚠ One definition, used by all three functions below.
 *
 *   The queue asks "is there one", the reveal asks "where", and the approval
 *   asks "which one do I keep". Three copies of the same coalesce would drift,
 *   and the way it would drift is a queue that says a photo exists and a reveal
 *   that returns nothing — which is worse than either being wrong alone.
 *
 * ⚠ The most recent *completed* session, not the most recent session.
 *
 *   A session is a row from the moment the camera opens; `photo_path` is null
 *   until the phone has uploaded. Taking the newest row regardless would
 *   return null for anybody who opened the camera and thought better of it,
 *   hiding a perfectly good photo taken ten minutes earlier.
 */
create or replace function public.sender_selfie_path(target uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select coalesce(i.candidate_path, i.reference_path)
       from public.sender_identity i
      where i.user_id = target),
    (select s.photo_path
       from public.photo_capture_sessions s
      where s.owner_id = target
        and s.photo_path is not null
        and s.completed_at is not null
      order by s.completed_at desc
      limit 1)
  );
$$;

/*
 * ⚠ No grant to anyone.
 *
 *   This returns a storage path to somebody's face. It is a helper for the
 *   three `security definer` functions below, each of which checks
 *   `is_admin()` first — it is not an endpoint. Left callable, it would be an
 *   unaudited way to ask where any account's selfie lives.
 */
revoke all on function public.sender_selfie_path(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ the queue --

/*
  Replaces 41's version. The only change is `has_selfie`.
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
    /*
     * ⚠ Still a boolean, still no path.
     *
     *   41's rule stands: working the list and looking at somebody's face are
     *   different acts, and only the second writes a privacy line. This says
     *   whether there is something to open, not where it is.
     */
    public.sender_selfie_path(i.user_id) is not null,
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
    case when i.status in ('pending', 'flagged') then 0 else 1 end,
    i.created_at;
$$;

revoke all on function public.admin_identity_queue() from public, anon;
grant execute on function public.admin_identity_queue() to authenticated;

-- ----------------------------------------------------------------- the reveal --

/*
  Replaces 41's version. The only change is where the selfie comes from.
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
      public.sender_selfie_path(target),
      i.slip_path,
      right(i.nin, 4),
      i.status
    from public.sender_identity i
    where i.user_id = target;
end;
$$;

revoke all on function public.admin_reveal_identity_for_user(uuid, text) from public, anon;
grant execute on function public.admin_reveal_identity_for_user(uuid, text) to authenticated;

-- --------------------------------------------------------------- the decision --

/*
  Replaces 41's version. The only change is which photo an approval promotes.
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

  if verdict = 'rejected' and clean_note is null then
    raise exception 'A rejection must record a reason'
      using errcode = 'check_violation';
  end if;

  select i.status into current_status
    from public.sender_identity i
   where i.user_id = target
   for update;

  if current_status is null then
    raise exception 'That account has not submitted an identity';
  end if;

  if current_status not in ('pending', 'flagged') then
    raise exception 'That identity is not awaiting review (it is %)', current_status
      using errcode = 'check_violation';
  end if;

  /*
    ⚠ Read after the lock, and through the same helper the reviewer saw.

      If this promoted something other than what `admin_reveal_identity_for_user`
      showed, the administrator would be attesting to one photo and enrolling
      another — which is the whole guarantee of this screen, quietly inverted.
  */
  candidate := public.sender_selfie_path(target);

  update public.sender_identity
     set status = verdict,
         review_note = clean_note,
         reviewed_by = actor,
         reviewed_at = now(),
         verified_at = case when verdict = 'verified' then now() else verified_at end,
         /*
           ⚠ A person confirming is what makes this promotion legitimate.

             28 refuses to let a machine enrol an unmatched face, and that is
             untouched. This is the other path: an administrator has compared
             the slip to the face and ticked a box saying so.
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
    jsonb_build_object(
      'subject', target,
      'verdict', verdict,
      'was', current_status,
      /*
       * ⚠ Whether a face was enrolled, not which one.
       *
       *   A path in the audit log would be a way to read somebody's selfie
       *   location out of a table that is not the reveal. The fact that an
       *   approval had nothing to promote is worth recording, because it means
       *   that account still has no reference photo.
       */
      'enrolled_reference', candidate is not null,
      'reason', left(coalesce(clean_note, ''), 200)
    ),
    actor
  );

  return verdict;
end;
$$;

revoke all on function public.admin_review_identity(uuid, text, text) from public, anon;
grant execute on function public.admin_review_identity(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
