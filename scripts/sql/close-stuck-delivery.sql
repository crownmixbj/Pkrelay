-- Closing a stuck delivery from the SQL editor.
--
-- ⚠ Prefer the button. Admin → Dashboard → In transit → Record delivery does
--   everything below, and does it as *you* rather than as the database owner —
--   `auth.uid()` is null in the SQL editor, so `admin_record_delivery` refuses
--   to run here and the attribution has to be written by hand.
--
--   This file exists for the case where the web build has not been redeployed
--   yet and a parcel needs closing now. It reproduces the function's writes
--   exactly, including the audit line, so the record ends up identical.
--
-- Fill in the three values at the top. The transaction either does all of it or
-- none of it: a delivery recorded with no audit line is the thing this is meant
-- to avoid.

begin;

with input as (
  select
    'PKG-483203'::text                                           as tracking_id,
    'NAME OF WHOEVER TOOK IT'::text                              as received_by,
    'HOW YOU KNOW IT ARRIVED'::text                              as reason,
    /* The admin this is recorded against. Bolaji Noah. */
    '37443829-e678-46f7-9956-c1c5a1b3c848'::uuid                 as actor
),
target as (
  select b.id, b.driver_id, b.status
  from public.bookings b, input i
  where b.tracking_id = i.tracking_id
    and b.status not in ('Delivered', 'Cancelled')
    and b.driver_id is not null
    /* Never collected means there is no delivery to record. */
    and b.picked_up_at is not null
),
closed as (
  update public.bookings b
     set status = 'Delivered',
         delivered_at = now(),
         received_by = (select received_by from input),
         delivery_recorded_by = (select actor from input)
    from target t
   where b.id = t.id
  returning b.id, t.status as from_status, b.driver_id
)
insert into public.app_events (level, area, message, context, actor_id)
select
  'warning',
  'delivery',
  'admin recorded a delivery the driver did not',
  jsonb_build_object(
    'booking', c.id,
    'driver', c.driver_id,
    'from_status', c.from_status,
    'reason', left((select reason from input), 300),
    'via', 'sql editor'
  ),
  (select actor from input)
from closed c;

-- Check before committing: one row, Delivered, with a name and the attribution.
select tracking_id, status, delivered_at, received_by, delivery_recorded_by
from public.bookings where tracking_id = 'PKG-483203';

-- commit;    -- uncomment once the row above reads correctly
-- rollback;  -- if it does not
