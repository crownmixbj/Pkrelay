-- ============================================================================
-- 20250101000084_driver_sees_parcel_photo.sql — the driver sees the parcel
-- ============================================================================
--
-- Run after 83. Re-runnable. Apply to BOTH staging and production.
--
-- Drivers can now see the photo the sender took of the parcel, so they can
-- judge its size and whether it fits their vehicle before collecting it.
--
-- 36 deliberately kept drivers out: "a driver seeing the contents of every
-- parcel they are offered is a different exposure from seeing the address."
-- This opens it narrowly rather than to every driver:
--
--   * the driver CARRYING the parcel (bookings.driver_id), and
--   * a driver holding a LIVE OFFER for it — status 'offered' and not yet
--     expired — because "will this fit in my car" is a question to answer
--     before accepting, not after.
--
-- Not included: approved drivers browsing generally, drivers whose offer
-- expired or was declined, and a driver who released the job. Sender and admin
-- access is unchanged. Only the parcel photo — the sender's face photo
-- (`sender-photo` bucket) stays sender-and-admin only.
-- ============================================================================

drop policy if exists "sender and admin read parcel photo" on storage.objects;
drop policy if exists "sender, admin and driver read parcel photo" on storage.objects;

create policy "sender, admin and driver read parcel photo"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'parcel-photo'
    and (
      public.is_admin()
      or exists (
        select 1 from public.bookings b
        where b.id::text = (storage.foldername(name))[1]
          and (
            b.sender_id = (select auth.uid())
            or b.driver_id = (select auth.uid())
          )
      )
      or exists (
        select 1 from public.dispatch_offers o
        where o.booking_id::text = (storage.foldername(name))[1]
          and o.driver_id = (select auth.uid())
          and o.status = 'offered'
          and o.expires_at > now()
      )
    )
  );
