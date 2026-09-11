-- LOCI — a sender proves who they are once, then just shows their face.
--
-- Run after 01–27. Re-runnable.
--
--   First shipment    NIN + NIN slip + live selfie. The selfie is matched
--                     against the photo NIMC holds for that NIN. On a match the
--                     selfie becomes the account's master reference photo.
--   Every shipment    a live selfie, compared against that master photo.
--     after that
--
-- ⚠ THIS IS BIOMETRIC PROCESSING, AND IT IS A BIGGER STEP THAN IT LOOKS.
--
--   `20250101000016_driver_identity.sql` already carries a LEGAL_REVIEW_REQUIRED note for
--   matching a driver's face against a government record. Everything in that
--   note applies here and one thing more: this extends the same processing from
--   a few dozen vetted drivers to *every customer who ever posts a parcel*.
--
--   Under the NDPA 2023 a facial image becomes sensitive personal data when it
--   is processed "for the purpose of uniquely identifying a natural person" —
--   which is precisely what comparing a selfie to a stored reference is for.
--   That brings explicit consent, a lawful basis that cannot be bundled into
--   terms of service, and a data protection impact assessment.
--
--   Storing a master reference photo indefinitely is the part most likely to be
--   challenged. There is no retention rule in this file because the right
--   period is a decision for LOCI and its counsel, not for me. Until one exists
--   these rows accumulate forever.
--
--   LEGAL_REVIEW_REQUIRED. See docs/PRIVACY-NOTES.md.
--
-- ⚠ AND ON WHAT THE CHECK IS WORTH.
--
--   Matching against the NIMC record is a real check: the reference comes from
--   the government, not from the person being checked. Matching against the
--   uploaded NIN slip would not be — a slip is an image the sender supplies, so
--   a forged one matches a forged face perfectly. The slip is stored for a
--   human to look at if something is disputed; it is deliberately *not* the
--   thing the selfie is compared to.

do $$
begin
  if to_regclass('public.photo_capture_sessions') is null then
    raise exception 'Run 20250101000013_capture_sessions.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------- the record --

create table if not exists public.sender_identity (
  user_id uuid primary key references auth.users (id) on delete cascade,

  /*
    The NIN, digits only.

    Not unique. Two accounts presenting the same NIN is a real signal worth
    investigating, but a unique constraint would turn it into an error at
    signup for the *second* person — including the legitimate case of somebody
    re-registering after losing an account. `sender_identity_nin_idx` below
    makes it findable instead.
  */
  nin text check (nin ~ '^[0-9]{11}$'),

  /** Storage path of the uploaded NIN slip. Evidence, never the match source. */
  slip_path text,

  /**
   * Storage path of the master reference photo.
   *
   * The selfie taken during onboarding, kept because every later shipment is
   * compared against it. This is the most sensitive object in the system.
   */
  reference_path text,

  status text not null default 'unverified'
    check (status in ('unverified', 'pending', 'verified', 'flagged')),

  /*
    `flagged` rather than `rejected`, deliberately.

    A mismatch does not stop a sender posting — it marks the account for a human
    to look at. An older NIMC photo, a dark room or a bad camera all produce a
    mismatch, and refusing on that basis locks a real customer out of the
    product with nothing they can do about it. The rate has to be observed
    before it can be enforced on.
  */
  confidence numeric,
  environment text check (environment in ('sandbox', 'production')),
  verified_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists sender_identity_nin_idx
  on public.sender_identity (nin)
  where nin is not null;

comment on table public.sender_identity is
  'Sensitive personal data under NDPA 2023 s.65 — facial images processed to '
  'uniquely identify a person. No retention rule is set; see the header of '
  '20250101000028_sender_identity.sql. LEGAL_REVIEW_REQUIRED.';

alter table public.sender_identity enable row level security;

/*
  The owner reads their own row and nobody else's.

  Deliberately no admin read policy on the table. An admin who needs to look at
  a flagged account goes through `admin_flagged_identities` below, which returns
  the status and the confidence but neither the NIN nor a photo path — the same
  shape as `admin_parcel_detail`, for the same reason.
*/
drop policy if exists "sender reads own identity" on public.sender_identity;
create policy "sender reads own identity"
  on public.sender_identity for select
  to authenticated
  using (user_id = (select auth.uid()));

/*
  No client insert, update or delete policy at all.

  Every write goes through the functions below, which are the only place the
  status can move. A sender who could write this table could set their own
  status to 'verified'.
*/

-- ---------------------------------------------------------- the slip bucket --

/*
  A second private bucket, separate from `sender-photo`.

  The per-parcel selfies in `sender-photo` are transient evidence attached to a
  shipment. A NIN slip and a master reference photo belong to the *person* and
  outlive every parcel they ever send. Different lifetime, different retention
  decision when one is finally made, so a different bucket.
*/
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sender-identity',
  'sender-identity',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/*
  Ownership is carried by the path: `<user_id>/...`.

  The same arrangement as driver documents and delivery proof. Storage has no
  join to work with, so the first path segment has to be the owner's id and the
  policy compares it to `auth.uid()`.
*/
drop policy if exists "sender uploads own identity file" on storage.objects;
create policy "sender uploads own identity file"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'sender-identity'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "sender reads own identity file" on storage.objects;
create policy "sender reads own identity file"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'sender-identity'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

/*
  No update and no delete policy.

  A reference photo that can be replaced after the fact is not a reference. The
  verifier reads these with the service role, which bypasses RLS.
*/

-- ------------------------------------------------------- what a sender needs --

/**
 * Whether this account still has to do the full onboarding.
 *
 * The client mirrors this in `verificationPath` (`src/store/identity.ts`) so the
 * booking form knows which fields to show before it asks the server anything.
 * The server is the one that decides, though: a client that lied and skipped
 * onboarding would fail `begin_identity_check` below.
 */
create or replace function public.sender_needs_onboarding(target uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.sender_identity
    where user_id = coalesce(target, (select auth.uid()))
      and status in ('verified', 'flagged')
  );
$$;

/**
 * Whether there is a master photo to compare a new selfie against.
 *
 * ⚠ This is a *different question* from `sender_needs_onboarding`, and running
 *   them together is a bug I wrote and the harness caught.
 *
 *   The first version asked for both `status in ('verified','flagged')` and
 *   `reference_path is not null` in one predicate. That quietly contradicted
 *   two decisions made twenty lines apart in this same file: a flagged account
 *   must not be sent round onboarding again, and an *unmatched* selfie must
 *   never be promoted to reference. A flagged account satisfies the first and
 *   fails the second, so it was told to do the whole thing again — every
 *   shipment, forever.
 *
 *   They are separate because there are three states, not two:
 *
 *     no row / pending      → full onboarding
 *     flagged, no reference → selfie captured, nothing to compare it to
 *     verified + reference  → selfie compared against the master photo
 */
create or replace function public.sender_has_reference(target uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sender_identity
    where user_id = coalesce(target, (select auth.uid()))
      and reference_path is not null
  );
$$;

revoke all on function public.sender_needs_onboarding(uuid) from public, anon;
grant execute on function public.sender_needs_onboarding(uuid) to authenticated;
revoke all on function public.sender_has_reference(uuid) from public, anon;
grant execute on function public.sender_has_reference(uuid) to authenticated;

/*
  ⚠ `flagged` counts as onboarded, which is not an oversight.

    A flagged account has already given a NIN, a slip and a selfie, and a human
    is going to look at it. Sending them round the full form again on every
    shipment would punish them for a decision nobody has made yet — and if the
    review clears them, they will have re-uploaded a NIN slip for nothing.

    They still take a selfie on every parcel like everybody else. What they do
    not have is a confirmed face to compare it against, so the comparison
    records 'unavailable' until a human resolves the flag.
*/

-- ------------------------------------------------------------ onboarding ----

/**
 * Records the NIN and slip at the start of onboarding.
 *
 * Separate from the verification result so the row exists before the provider
 * is called. If Dojah is slow, unreachable or out of credit, what the sender
 * gave us is already saved and the check can be retried without asking them for
 * any of it again.
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

  /*
    The path has to be inside the caller's own folder.

    Storage RLS already enforces this on upload, but this function runs as
    definer and writes whatever path it is handed. Without this check a sender
    could record somebody else's object as their slip.
  */
  if sender_slip_path is null or split_part(sender_slip_path, '/', 1) <> actor::text then
    raise exception 'That file does not belong to this account';
  end if;

  insert into public.sender_identity (user_id, nin, slip_path, status)
  values (actor, digits, sender_slip_path, 'pending')
  on conflict (user_id) do update
    set nin = excluded.nin,
        slip_path = excluded.slip_path,
        -- Re-running onboarding clears an old verdict rather than keeping a
        -- stale 'verified' beside a new NIN.
        status = 'pending',
        confidence = null,
        verified_at = null,
        checked_at = null;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'identity', 'sender started identity onboarding',
    -- The NIN itself is never logged. A log line is the easiest place in the
    -- system for a government identifier to end up somewhere it should not be.
    jsonb_build_object('nin_last4', right(digits, 4)),
    actor
  );
end;
$$;

/**
 * Records the outcome and, on a match, promotes the selfie to master reference.
 *
 * Service role only. The verdict comes from the edge function that called
 * Dojah; a sender who could call this could mark themselves verified.
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

  /*
    'unavailable' leaves the account exactly where it was.

    Dojah being down is not evidence about the sender. Writing a status here
    would either lock somebody out for an outage or mark them verified without
    a check having happened; the honest record is that nothing was learned.
  */
  if verdict = 'unavailable' then
    update public.sender_identity
       set checked_at = now(), environment = coalesce(env, environment)
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
         -- The reference photo is only ever set from a *matched* onboarding.
         -- Promoting a flagged selfie would make every later comparison agree
         -- with a face nobody has confirmed.
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

revoke all on function public.begin_identity_check(text, text) from public, anon;
grant execute on function public.begin_identity_check(text, text) to authenticated;
revoke all on function public.record_identity_result(uuid, text, text, numeric, text)
  from public, anon, authenticated;

-- ------------------------------------------------------------- for admins ---

/**
 * Flagged accounts, without the identifiers.
 *
 * Status, confidence and when — enough to work a review queue and see whether
 * the mismatch rate is a fraud signal or a camera problem. Neither the NIN nor
 * any photo path is returned; an admin who needs to see the slip asks for it
 * through a path that logs the request, which does not exist yet.
 */
create or replace function public.admin_flagged_identities()
returns table (
  user_id uuid,
  status text,
  confidence numeric,
  checked_at timestamptz,
  nin_last4 text
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.user_id, i.status, i.confidence, i.checked_at, right(i.nin, 4)
  from public.sender_identity i
  where public.is_admin()
    and i.status = 'flagged'
  order by i.checked_at desc nulls last;
$$;

revoke all on function public.admin_flagged_identities() from public, anon;
grant execute on function public.admin_flagged_identities() to authenticated;

/*
  ⚠ What this does not do.

    - No retention. Nothing deletes a reference photo, a slip or a NIN, ever.
      That is the single biggest gap in this file and it is a decision rather
      than an oversight.
    - No erasure path. A sender asking to be forgotten cannot be, today.
    - Nothing re-checks. A reference photo taken at 19 is compared to a face at
      29 with no re-enrolment, and the match rate will fall over years.
    - `sender_needs_onboarding` says nothing about whether the *reference photo*
      still exists in storage. If an object were deleted out from under it, the
      row would still claim the account is onboarded.
*/
