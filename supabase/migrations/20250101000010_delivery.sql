-- LOCI — advancing a delivery, and proving it happened.
--
-- Run after 01–09. Re-runnable.
--
-- Two gaps this closes, both flagged earlier as real:
--
--   1. A driver could claim a job and then never move it. Nothing in the app
--      advanced a booking past 'Assigned', so every parcel sat at the stage it
--      was claimed at and the sender's tracking timeline never moved.
--
--   2. There was no proof of delivery at all. A parcel marked Delivered was a
--      claim with nothing behind it, which is worth nothing the moment it is
--      disputed.

do $$
begin
  if to_regclass('public.app_events') is null then
    raise exception 'Run 20250101000007_admin.sql first — delivery events are audited.';
  end if;
end
$$;

-- ------------------------------------------------------------- columns -----

alter table public.bookings
  add column if not exists picked_up_at  timestamptz,
  add column if not exists delivered_at  timestamptz,
  /*
    Who physically took it.

    Often not the named recipient — a receptionist, a spouse, a neighbour the
    recipient nominated. Recording the actual name is the difference between
    evidence and a tick.
  */
  add column if not exists received_by   text,
  /** Path in the `delivery-proof` bucket. Null until a photo is taken. */
  add column if not exists proof_path    text,
  add column if not exists proof_note    text;

comment on column public.bookings.received_by is
  'Name given at handover. Not necessarily recipient_name — a parcel is often '
  'taken by whoever is at the door.';

-- ------------------------------------------------------- the state machine --

/*
  The one legal path.

  Booked -> Assigned happens by claiming (that is the existing update policy).
  Everything after it happens here, one step at a time, forwards only.

  Forwards-only matters more than it looks: a driver who can set any status can
  mark a parcel Delivered without ever collecting it, and the sender's timeline
  is the only thing they have to go on.
*/
create or replace function public.next_booking_status(current text)
returns text language sql immutable set search_path = '' as $$
  select case current
    when 'Assigned'         then 'Picked Up'
    when 'Picked Up'        then 'In Transit'
    when 'In Transit'       then 'Out for Delivery'
    when 'Out for Delivery' then 'Delivered'
    else null
  end;
$$;

/**
 * Moves a booking one stage forward.
 *
 * `security definer` so it can write columns the claim policy does not grant,
 * and so the whole rule — who, from what, to what, with what evidence — lives
 * in one readable place rather than spread across a policy and a client.
 */
create or replace function public.advance_booking(
  booking_id uuid,
  received_by_name text default null,
  proof text default null,
  note text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  row_status text;
  row_driver uuid;
  next_status text;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select status, driver_id into row_status, row_driver
  from public.bookings where id = booking_id;

  if row_status is null then
    raise exception 'No such booking';
  end if;

  /*
    Only the carrier. Not the sender, not an admin, not another driver.

    An admin correcting a stuck delivery is a real need, but it is a different
    action with a different audit trail — letting it in here would make every
    row in the log ambiguous about who actually handled the parcel.
  */
  if row_driver is distinct from actor then
    raise exception 'Only the driver carrying this parcel can update it';
  end if;

  if not public.is_approved_driver() then
    -- Covers the case where approval was revoked or the driver was banned
    -- while holding a job.
    raise exception 'Your driver approval is not active';
  end if;

  next_status := public.next_booking_status(row_status);

  if next_status is null then
    raise exception 'This delivery is already complete';
  end if;

  /*
    A delivery cannot be recorded without saying who took it.

    This is the whole point of the feature. Allowing a nameless Delivered would
    reproduce exactly the gap this file exists to close.
  */
  if next_status = 'Delivered' and coalesce(trim(received_by_name), '') = '' then
    raise exception 'Say who received the parcel before marking it delivered.';
  end if;

  update public.bookings
     set status = next_status,
         picked_up_at = case when next_status = 'Picked Up' then now() else picked_up_at end,
         delivered_at = case when next_status = 'Delivered' then now() else delivered_at end,
         received_by  = case when next_status = 'Delivered' then trim(received_by_name) else received_by end,
         proof_path   = coalesce(proof, proof_path),
         proof_note   = coalesce(note, proof_note)
   where id = booking_id;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info',
    'delivery',
    format('%s -> %s', row_status, next_status),
    /*
      Ids and a stage. Deliberately no address, recipient name or phone: an
      admin reads this log, and a parcel's contact details are not theirs by
      default.
    */
    jsonb_build_object('booking', booking_id, 'to', next_status),
    actor
  );

  return next_status;
end;
$$;

revoke all on function public.advance_booking(uuid, text, text, text) from public, anon;
grant execute on function public.advance_booking(uuid, text, text, text) to authenticated;

-- --------------------------------------------------------- proof storage ---

/*
  A PRIVATE bucket, for the same reason `driver-documents` is.

  A proof photo shows someone's front door, sometimes their face, and is tied to
  an address in the same row. A public bucket would hand out a permanent
  unauthenticated URL for every one of them.

  Path convention: `<booking_id>/<timestamp>.<ext>`. The booking id is the first
  segment because that is what the policies below join on — the same trick as
  the driver documents bucket, where ownership is carried by the path.
*/
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'delivery-proof',
  'delivery-proof',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/heic', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/*
  Uploaded by the carrier only, while they hold the job.
*/
drop policy if exists "carrier uploads proof" on storage.objects;
create policy "carrier uploads proof"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'delivery-proof'
    and exists (
      select 1 from public.bookings b
      where b.id::text = (storage.foldername(name))[1]
        and b.driver_id = (select auth.uid())
    )
  );

/*
  Readable by the two people it concerns, and by an admin.

  The sender needs it — it is their evidence, and the reason the photo is taken
  at all. The driver needs it to confirm what they submitted. Nobody else has
  any business seeing the inside of someone's doorway.
*/
drop policy if exists "parties read proof" on storage.objects;
create policy "parties read proof"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'delivery-proof'
    and (
      public.is_admin()
      or exists (
        select 1 from public.bookings b
        where b.id::text = (storage.foldername(name))[1]
          and (b.sender_id = (select auth.uid()) or b.driver_id = (select auth.uid()))
      )
    )
  );

/*
  No update and no delete policy.

  Evidence a driver can replace after the fact is not evidence. Correcting a
  bad photo means taking another and letting both stand, which is why the path
  carries a timestamp rather than a fixed name.
*/

-- ------------------------------------------------------------- retention ---

/*
  ⚠ Proof photos inherit the retention problem that is still outstanding for
    rejected applications and app_events. They show private property and are
    kept forever by default. Decide a period — a year is typical for delivery
    evidence, long enough to cover a dispute — and delete on that schedule.
*/
