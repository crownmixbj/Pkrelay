-- LOCI — keeping the photograph of the parcel, and showing both photos to staff.
--
-- Run after 01–35. Re-runnable.
--
-- ⚠ The parcel photo has been required and discarded since the form shipped.
--
--   `book.tsx` refuses to post without one — "A photo of the parcel is required
--   to confirm handover condition" — and `bookings-remote.ts` then sends
--   `item_photo_uri: null`, with a note saying why: the picker returns a local
--   `file://` URI that means nothing on another device, and storing it would
--   put a dead path in the database that looks like a working photo.
--
--   That was the right call while there was nowhere to put the bytes. What it
--   left is a promise the product does not keep: senders are asked for evidence
--   of condition at handover, and the evidence is thrown away at the door. The
--   first time it would have mattered is the first damage dispute.
--
-- Two photos end up attached to a parcel, and they are not alike:
--
--   the parcel   a box on a table. Operational. Free to look at.
--   the sender   a human face. Sensitive personal data under the NDPA, and
--                behind the same audited reveal the contact details use.
--
-- That split is the whole design here. `admin_parcel_detail` gains the parcel
-- photo's path directly; the face stays behind an audited reveal.
--
-- ⚠ `admin_reveal_parcel_photo` below is superseded by 20250101000037_admin_sender_identity.sql,
--   which drops it and replaces it with one reveal covering the selfie and the
--   NIN slip together. It is left here so this file still runs standalone and in
--   order; nothing calls it after 37.

do $$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'Run 20250101000001_bookings.sql first.';
  end if;
end
$$;

-- --------------------------------------------------------------- column ----

alter table public.bookings
  add column if not exists item_photo_path text;

comment on column public.bookings.item_photo_path is
  'Object path in the parcel-photo bucket, as <booking id>/<file>. Set by '
  'attach_parcel_photo after the row exists. The older item_photo_uri column '
  'was never populated — see 20250101000036_parcel_photos.sql.';

-- --------------------------------------------------------------- bucket ----

/*
  Same size cap and the same five image types as every other photo bucket, and
  no `application/pdf`: this is a photograph of a physical object, and a PDF in
  the slot would be somebody attaching the wrong thing.
*/
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'parcel-photo',
  'parcel-photo',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/*
  Written by the sender of that parcel, into a folder named for the parcel.

  The booking exists before the upload — see `attach_parcel_photo` — so the
  folder can be checked against a real row rather than trusted.
*/
drop policy if exists "sender uploads parcel photo" on storage.objects;
create policy "sender uploads parcel photo"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'parcel-photo'
    and exists (
      select 1 from public.bookings b
      where b.id::text = (storage.foldername(name))[1]
        and b.sender_id = (select auth.uid())
    )
  );

/*
  Read by the sender and by an admin.

  ⚠ Not the driver, and this one is worth stating because the argument cuts the
    other way from the face photo.

    A condition photograph is exactly the evidence a driver would want in a
    dispute about damage — so there is a real case for showing it to the person
    carrying the parcel. It is left out for now because a driver seeing the
    contents of every parcel they are offered is a different exposure from
    seeing the address, and because a photo taken before pickup proves nothing
    about who damaged what without a matching one at handover. If a handover
    photo appears, revisit this together with it.
*/
drop policy if exists "sender and admin read parcel photo" on storage.objects;
create policy "sender and admin read parcel photo"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'parcel-photo'
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
  ⚠ And a repair to the sender-photo policy next door, which has never worked.

    20250101000012_sender_photo.sql lets the sender read their own face photo by matching
    the object's first folder against a booking id. But those objects are
    written by the capture flow under a *session* id — `complete_capture_session`
    stores `photo_path = session_id || '/' || file` — so the folder is never a
    booking id and that branch has always matched nothing. Admins were
    unaffected, which is why nobody noticed: `is_admin()` short-circuits it.

    Matched on the recorded path instead, which is the value the booking
    actually holds.
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
        where b.sender_photo_path = name
          and b.sender_id = (select auth.uid())
      )
    )
  );

-- ------------------------------------------------------------- attaching ---

/**
 * Records the uploaded parcel photo against the booking.
 *
 * Called by the sender straight after posting, once the row exists and the
 * bytes are in the bucket. Definer, so the path can be derived here rather than
 * accepted from the client.
 *
 * ⚠ The file name is sanitised and the folder is imposed, exactly as
 *   `complete_capture_session` does it. A caller that could name the full path
 *   could point a booking at an object belonging to another parcel.
 */
create or replace function public.attach_parcel_photo(
  booking_id uuid,
  file_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  owner uuid;
  safe_name text;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select sender_id into owner from public.bookings where id = booking_id;

  if owner is null then
    raise exception 'No such parcel';
  end if;

  if owner <> actor then
    raise exception 'That parcel is not yours';
  end if;

  safe_name := regexp_replace(coalesce(file_name, ''), '[^A-Za-z0-9._-]', '', 'g');
  if safe_name = '' or safe_name like '%..%' or safe_name like '.%' then
    raise exception 'Bad file name';
  end if;

  update public.bookings
     set item_photo_path = booking_id::text || '/' || safe_name
   where id = booking_id;
end;
$$;

revoke all on function public.attach_parcel_photo(uuid, text) from public, anon;
grant execute on function public.attach_parcel_photo(uuid, text) to authenticated;

-- --------------------------------------------------- the face, on request ---

/**
 * Hands an admin the path to the sender's photograph, and records that it did.
 *
 * Deliberately separate from `admin_parcel_detail`, which returns only
 * `has_sender_photo`. The rule this codebase already follows for contact
 * details applies at least as strongly to a face: operational data is free,
 * personal data costs a deliberate action and leaves a trace.
 *
 * The parcel photo is *not* here. It is a box, it answers an operational
 * question, and putting it behind a reason box would train staff to type
 * something meaningless into one several times a day — which is how an audit
 * trail stops being evidence of anything.
 */
create or replace function public.admin_reveal_parcel_photo(
  booking_id uuid,
  reason text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  path text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  /*
    Logged before the value is returned, and copied from
    `admin_reveal_parcel_contacts` for the same reason it is written that way
    there: if the insert fails the read does not happen. An audit line written
    afterwards is one an error can skip.
  */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'privacy',
    'admin revealed sender photo',
    jsonb_build_object(
      'booking', booking_id,
      'reason', left(coalesce(reason, ''), 200)
    ),
    actor
  );

  select sender_photo_path into path from public.bookings where id = booking_id;
  return path;
end;
$$;

revoke all on function public.admin_reveal_parcel_photo(uuid, text) from public, anon;
grant execute on function public.admin_reveal_parcel_photo(uuid, text) to authenticated;

-- --------------------------------------- the detail row, with the box photo ---

/*
  Recreated rather than altered: Postgres cannot change the return type of an
  existing function in place, and this gains one column.

  ⚠ Only `item_photo_path` is added. `sender_photo_path` stays out — the detail
    row still answers "is there a photo of the sender" with a boolean, and the
    path itself costs a trip through the audited reveal — see 37. Returning it
    here would make that reveal decorative.
*/
drop function if exists public.admin_parcel_detail(uuid);

create or replace function public.admin_parcel_detail(booking_id uuid)
returns table (
  id uuid,
  tracking_id text,
  status text,
  delivery_type text,
  origin_city text,
  destination_city text,
  pickup_area text,
  dropoff_area text,
  pickup_mode text,
  dropoff_mode text,
  weight numeric,
  declared_value numeric,
  estimated_fee numeric,
  category text,
  fragile boolean,
  created_at timestamptz,
  accepted_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  driver_name text,
  driver_id uuid,
  has_sender_photo boolean,
  item_photo_path text,
  liveness_status text,
  -- How dispatch has gone: how many drivers have been offered it, and whether
  -- one is holding it now. A stuck parcel is usually a dispatch story.
  offers_made bigint,
  offer_outstanding boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  return query
    select
      b.id,
      b.tracking_id,
      b.status,
      b.delivery_type,
      b.origin_city::text,
      b.destination_city::text,
      b.pickup_area,
      b.dropoff_area,
      b.pickup_mode,
      b.dropoff_mode,
      b.weight,
      b.declared_value,
      b.estimated_fee,
      b.category,
      b.fragile,
      b.created_at,
      b.accepted_at,
      b.picked_up_at,
      b.delivered_at,
      b.cancelled_at,
      b.cancellation_reason,
      /*
        The driver's name is included and the sender's is not, deliberately.

        A driver is a counterparty LOCI has contracted with and vetted; an
        operator resolving a delivery needs to know who is carrying it. A sender
        is a customer whose name is not required to answer "where is this
        parcel".
      */
      b.driver,
      b.driver_id,
      (b.sender_photo_path is not null),
      b.item_photo_path,
      b.liveness_status,
      (select count(*) from public.dispatch_offers o where o.booking_id = b.id),
      exists (
        select 1 from public.dispatch_offers o
        where o.booking_id = b.id and o.status = 'offered' and o.expires_at > now()
      )
    from public.bookings b
    where b.id = booking_id;
end;
$$;

revoke all on function public.admin_parcel_detail(uuid) from public, anon;
grant execute on function public.admin_parcel_detail(uuid) to authenticated;

notify pgrst, 'reload schema';
