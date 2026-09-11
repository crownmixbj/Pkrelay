-- LOCI — a photo of the person posting the parcel.
--
-- Run after 01–11. Re-runnable.
--
-- ⚠ READ THIS BEFORE CALLING IT VERIFICATION.
--
-- This stores a selfie. It does not verify anything. Nothing here compares the
-- face to an ID document, to a previous photo, or to a liveness signal — a
-- printed photograph held up to the lens passes. What it buys is deterrence and
-- evidence: a person who knows their face is attached to a parcel is less
-- likely to post something they should not, and if one is posted there is a
-- record.
--
-- Calling it "identity verification" anywhere in the UI would be a false claim
-- to senders and a worse one to anyone relying on it later. Real verification
-- means a vendor (Smile ID, Dojah and Prembly all cover Nigeria), a contract,
-- a per-check cost and a liveness SDK.
--
-- ⚠ NDPA 2023 — corrected, and narrower than an earlier note in this file said.
--
--    The Act treats biometric data as sensitive personal data only where it is
--    processed *for the purpose of uniquely identifying* a person. LOCI runs no
--    face matching at all, so a stored selfie is ordinary personal data, not
--    sensitive biometric data. That distinction is worth keeping true: it stops
--    being true the day anyone wires a matching vendor into this column.
--
--    What did change: the photo is now required to post a parcel. The Act says
--    consent is not "freely given" where provision of a service is conditional
--    on it, so consent is no longer the basis this rests on. The app states a
--    legitimate interest instead — driver safety and deterring prohibited items.
--    That is a defensible position and it is not a decision a SQL file can make.
--
--    LEGAL_REVIEW_REQUIRED. See docs/PRIVACY-NOTES.md.

do $$
begin
  if to_regclass('public.app_events') is null then
    raise exception 'Run 20250101000007_admin.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------- columns -----

alter table public.bookings
  /** Path in the private `sender-photo` bucket. Null when none was captured. */
  add column if not exists sender_photo_path text,
  add column if not exists sender_photo_at   timestamptz;

comment on column public.bookings.sender_photo_path is
  'Selfie taken at posting. NOT a verified identity — nothing matches this '
  'face against anything. See 20250101000012_sender_photo.sql.';

-- --------------------------------------------------------------- storage ---

/*
  Private, like `driver-documents` and `delivery-proof`.

  A photograph of someone's face, tied in the same row to their phone number
  and a pickup address, is about as identifying as this app gets. A public
  bucket would hand out a permanent unauthenticated URL for every one.

  Path convention: `<owner>/<timestamp>.<ext>` where owner is a booking id or,
  in practice, a capture session id — see 20250101000013_capture_sessions.sql. The policies
  join on that first path segment either way.
*/
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sender-photo',
  'sender-photo',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/heic', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/*
  Uploaded by the sender, for their own parcel, and by nobody else.

  ⚠ No client path currently uses this policy. Since 20250101000013_capture_sessions.sql,
    every photo — phone or browser — is uploaded against a capture session and
    written under `<session_id>/`, because the photo is taken before the booking
    row exists and there is nothing to key on yet. This policy is kept for a
    future flow that attaches a photo to a parcel that already exists (a
    re-request from an admin, say). If no such flow appears, delete it: a policy
    nobody exercises is a policy nobody notices going wrong.
*/
drop policy if exists "sender uploads own photo" on storage.objects;
create policy "sender uploads own photo"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'sender-photo'
    and exists (
      select 1 from public.bookings b
      where b.id::text = (storage.foldername(name))[1]
        and b.sender_id = (select auth.uid())
    )
  );

/*
  Read by the sender and by an admin. Deliberately NOT the driver.

  The driver needs to find an address and call a phone number; a photograph of
  the sender's face adds nothing to either task, and handing every driver on the
  platform a face-and-address pair for every parcel they consider is a real
  safety problem for senders — particularly women posting from home.
*/
drop policy if exists "sender and admin read photo" on storage.objects;
create policy "sender and admin read photo"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'sender-photo'
    and (
      public.is_admin()
      or exists (
        select 1 from public.bookings b
        where b.id::text = (storage.foldername(name))[1]
          and b.sender_id = (select auth.uid())
      )
    )
  );

/*
  No update and no delete policy — the same reasoning as delivery proof. A
  photo that can be swapped afterwards is not a record of anything.

  Note this cuts against the NDPA erasure right: a sender asking to be forgotten
  cannot currently have these deleted, because nothing is allowed to delete
  them. `erase_person` in 20250101000009_bans.sql has the same gap. Resolving it means a
  service-role path that deletes on a verified request, which is not built.
*/

-- ------------------------------------------------------------- retention ---

/*
  ⚠ These photographs are kept forever by default, which is almost certainly
    the wrong answer under the NDPA and definitely the wrong answer morally.
    It matters more now that they are mandatory: every parcel produces one, and
    nobody chose to give it.
    Decide a period — the parcel's dispute window plus a margin, so a few
    months rather than a few years — and delete on that schedule. This is now
    the fourth thing in this schema waiting on a retention decision, alongside
    rejected applications, app_events and delivery proof.
*/
