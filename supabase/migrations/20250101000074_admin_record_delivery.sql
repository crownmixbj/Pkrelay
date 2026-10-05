-- ============================================================================
-- 20250101000074_admin_record_delivery.sql — closing a delivery the driver never did
-- ============================================================================
--
-- Run after 01–73. Re-runnable.
--
-- ⚠ The gap 10 named and left open.
--
--   `advance_booking` refuses anybody but the carrying driver, and says why:
--   "An admin correcting a stuck delivery is a real need, but it is a different
--   action with a different audit trail — letting it in here would make every
--   row in the log ambiguous about who actually handled the parcel." That was
--   right. This is the different action.
--
--   PKG-483203 on production is the case: accepted 13:57, collected 14:05, In
--   Transit 14:06, Out for Delivery 14:33, and then nothing. The parcel reached
--   its recipient; the driver never tapped the last step. Until this file there
--   was no way to close it — the sender's delivery email could never send, the
--   driver's fare could never be credited, and the parcel sat on the in-transit
--   board for ever.
--
-- ⚠ The row says who closed it, and that is the whole point of doing it this way.
--
--   `delivery_recorded_by` is null for every delivery a driver recorded and set
--   for every one an admin did. Without it the two are indistinguishable six
--   months later, and "was this parcel actually delivered, or did somebody tidy
--   the board" has no answer. 10's warning, honoured rather than worked around.
--
-- ⚠ Everything downstream fires exactly as it does for a driver's own delivery,
--   deliberately:
--
--     38  queues the `delivery_completed` email to the sender
--     50  notifies the sender in the app, where it is installed
--     30  credits the driver's earnings, less commission
--
--   The driver did the work. Suppressing the fare because an operator typed the
--   last step would be a punishment for a flat phone battery, and a second
--   manual process to forget about. The admin screen names all three before the
--   button does anything.

do $$
begin
  if to_regprocedure('public.advance_booking(uuid,text,text,text)') is null then
    raise exception 'Run 20250101000010_delivery.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------- the attribution --

alter table public.bookings
  add column if not exists delivery_recorded_by uuid references auth.users (id) on delete set null;

comment on column public.bookings.delivery_recorded_by is
  'The admin who closed this delivery because the carrying driver never did. '
  'Null for every delivery recorded by the driver themselves — which is what '
  'makes the two tellable apart.';

-- ------------------------------------------------------------ the action --

/**
 * Records a delivery the driver did not.
 *
 * ⚠ Refuses a parcel that was never collected.
 *
 *   A parcel still at Assigned has no collection behind it, and closing it
 *   would assert two things at once — that it was picked up and that it arrived
 *   — on the word of somebody who watched neither. If a driver collected a
 *   parcel and recorded nothing at all, that is a conversation, not a button.
 *
 * ⚠ Both the name and the reason are required, for different reasons.
 *
 *   The name is 10's rule, unchanged: a nameless Delivered is the gap that file
 *   exists to close, and it does not stop being one because an admin typed it.
 *   The reason is this file's: the admin is asserting something they did not
 *   witness, and in six months the only defensible version of that is one that
 *   says how they knew.
 */
create or replace function public.admin_record_delivery(
  parcel uuid,
  received_by_name text,
  reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  row_status text;
  row_driver uuid;
  row_picked timestamptz;
  clean_name text := btrim(coalesce(received_by_name, ''));
  clean_reason text := btrim(coalesce(reason, ''));
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  select status, driver_id, picked_up_at
    into row_status, row_driver, row_picked
  from public.bookings where id = parcel;

  if row_status is null then
    raise exception 'No such parcel';
  end if;

  if row_status = 'Delivered' then
    raise exception 'That parcel is already delivered';
  end if;

  if row_status = 'Cancelled' then
    raise exception 'That parcel was cancelled and cannot be delivered';
  end if;

  if row_driver is null then
    raise exception 'That parcel has no driver — nobody carried it';
  end if;

  if row_picked is null then
    raise exception
      'That parcel has not been collected yet. Closing it would assert a collection nobody recorded.';
  end if;

  if length(clean_name) < 2 then
    raise exception 'Say who received the parcel before marking it delivered.';
  end if;

  if length(clean_reason) < 4 then
    raise exception 'Say how you know it arrived — this is recorded against your account.';
  end if;

  update public.bookings
     set status = 'Delivered',
         delivered_at = now(),
         received_by = clean_name,
         delivery_recorded_by = actor
   where id = parcel;

  /*
   * ⚠ A warning, not an info line.
   *
   *   One of these is a driver whose phone died. A run of them is the delivery
   *   flow failing to work on real phones in real conditions, and the log is
   *   where that shows up before anybody thinks to ask. 32 ties its level to
   *   the dispatch mode for the same reason — the level is the signal.
   */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'delivery',
    'admin recorded a delivery the driver did not',
    jsonb_build_object(
      'booking', parcel,
      'driver', row_driver,
      'from_status', row_status,
      /*
        The reason, truncated. It is an operator's sentence about how they know,
        and `app_events.context` is read by every admin — long enough to be
        useful, short enough that nobody pastes a conversation into it.
      */
      'reason', left(clean_reason, 300)
    ),
    actor
  );
end;
$$;

revoke all on function public.admin_record_delivery(uuid, text, text) from public, anon;
grant execute on function public.admin_record_delivery(uuid, text, text) to authenticated;

-- ------------------------------------------------- who closed it, on screen --

/**
 * Whether a delivery was recorded by the carrier or by an operator.
 *
 * A small function rather than three more columns on `admin_parcel_detail`,
 * which returns thirty and was last rewritten by 36 — the same call 71 made,
 * for the same reason. The drawer asks for this beside the offer counts.
 */
create or replace function public.admin_delivery_attribution(parcel uuid)
returns table (
  delivered_at timestamptz,
  recorded_by_admin boolean,
  admin_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.delivered_at,
    (b.delivery_recorded_by is not null),
    nullif(btrim(coalesce(p.full_name, '')), '')::text
  from public.bookings b
  left join public.profiles p on p.id = b.delivery_recorded_by
  where b.id = parcel
    and public.is_admin();
$$;

revoke all on function public.admin_delivery_attribution(uuid) from public, anon;
grant execute on function public.admin_delivery_attribution(uuid) to authenticated;
