-- LOCI — everything the sender uploaded, on one audited door.
--
-- Run after 01–36. Re-runnable.
--
-- A sender uploads three things across a shipment, and until now an admin could
-- see one of them:
--
--   the parcel   a box on a table. Free to look at — 20250101000036_parcel_photos.sql.
--   the selfie   taken when the parcel was posted, in `sender-photo`.
--   the NIN slip taken once at onboarding, in `sender-identity`.
--
-- ⚠ The slip was unreachable, not merely unshown.
--
--   20250101000028_sender_identity.sql gives `sender-identity` an owner-only read policy —
--   `(storage.foldername(name))[1] = auth.uid()` — and no admin branch, unlike
--   every other private bucket in the system. So there was no query an
--   administrator could write that would return a NIN slip. `admin_flagged_
--   identities()` deliberately returns the last four digits and no path, which
--   is right for a queue and useless for the question "is the person in this
--   selfie the person on this slip".
--
-- ⚠ One door for all three sensitive items, replacing yesterday's face-only one.
--
--   36 added `admin_reveal_parcel_photo`, which returned the selfie alone.
--   Adding a second reveal for the slip would mean an operator answering one
--   question typed a reason into two boxes and produced two log lines for a
--   single act of looking. That is how a reason box becomes a formality — which
--   is the failure the audit exists to avoid. This supersedes it: one action,
--   one line, everything sensitive about that sender.
--
--   The master reference photo is *not* included, and that is deliberate. It is
--   the object every later verification is compared against, and it is the same
--   face as the selfie this already returns — so exposing it adds nothing an
--   operator needs and doubles the number of places the most sensitive image in
--   the system can be read from.

do $$
begin
  if to_regclass('public.sender_identity') is null then
    raise exception 'Run 20250101000028_sender_identity.sql first.';
  end if;
end
$$;

-- --------------------------------------------------------------- storage ---

/*
  An admin branch on the identity bucket, matching every other private bucket.

  Only slips live here: `submitOnboarding` writes `<user id>/slip-<time>.<ext>`,
  and `reference_path` points into `sender-photo` rather than this bucket. So
  this grants exactly the evidence document and nothing else.
*/
drop policy if exists "sender reads own identity file" on storage.objects;
create policy "sender reads own identity file"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'sender-identity'
    and (
      public.is_admin()
      or (storage.foldername(name))[1] = (select auth.uid())::text
    )
  );

-- ------------------------------------------------------------ the reveal ---

drop function if exists public.admin_reveal_parcel_photo(uuid, text);

/**
 * Everything the sender of this parcel uploaded that is about *them*.
 *
 * Returns paths rather than URLs: signing is the storage layer's job, and the
 * policy above is what decides whether the signature will work. A path that
 * cannot be signed is a policy problem, and keeping the two separate means it
 * shows up as one.
 *
 * ⚠ The NIN is returned as its last four digits only.
 *
 *   An operator comparing a slip to a face does not need the number, and a full
 *   government identifier on a support screen is one screenshot away from being
 *   somewhere it can never be recalled from. The last four are enough to check
 *   that the slip on screen is the one on file, which is the actual question.
 */
create or replace function public.admin_reveal_sender_identity(
  booking_id uuid,
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

  /*
    Logged in the same transaction as the read, which is the property that
    matters: if this insert fails, nothing is returned.

    ⚠ Written first for the reader's benefit, not for correctness. The function
      is one transaction, so moving it below the select changes nothing
      observable — `scripts/pg/parcel-photos-harness.mjs` says so, and says why
      it cannot be tested any other way. What *is* tested is that an audit which
      cannot be written stops the read.
  */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'privacy',
    'admin revealed sender identity',
    jsonb_build_object(
      'booking', booking_id,
      'reason', left(coalesce(reason, ''), 200)
    ),
    actor
  );

  return query
    select
      b.sender_photo_path,
      i.slip_path,
      right(i.nin, 4),
      i.status
    from public.bookings b
    left join public.sender_identity i on i.user_id = b.sender_id
    where b.id = booking_id;
end;
$$;

revoke all on function public.admin_reveal_sender_identity(uuid, text) from public, anon;
grant execute on function public.admin_reveal_sender_identity(uuid, text) to authenticated;

notify pgrst, 'reload schema';
