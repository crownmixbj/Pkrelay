-- LOCI — cancelling a parcel.
--
-- Run after 01–10. Re-runnable.
--
-- Two people can cancel, for different reasons, at different points:
--
--   the sender  changed their mind, or spotted a mistake. Allowed only while
--               nobody has committed to carrying it — once a driver has claimed
--               the job and possibly started travelling, the sender pulling it
--               out costs someone else money.
--
--   the driver  cannot make the pickup after all. Allowed only while the parcel
--               is still with the sender. After collection the driver is
--               holding someone else's property, and "cancel" is not a thing
--               you can do to a parcel in your bag — that is a failed delivery,
--               which is a different problem with a different resolution.

do $$
begin
  if to_regclass('public.app_events') is null then
    raise exception 'Run 20250101000007_admin.sql first — cancellations are audited.';
  end if;
end
$$;

-- ------------------------------------------------------------- columns -----

alter table public.bookings
  add column if not exists cancelled_at     timestamptz,
  /*
    Who ended it. Not just the id: a driver's cancellation and a sender's mean
    different things to everyone reading the row afterwards, and the id alone
    stops meaning anything once the account is erased.
  */
  add column if not exists cancelled_by     uuid references auth.users (id) on delete set null,
  add column if not exists cancelled_role   text check (cancelled_role in ('sender', 'driver')),
  add column if not exists cancellation_reason text;

/*
  'Cancelled' joins the status vocabulary.

  Deliberately *not* added to the ordered pipeline in `next_booking_status` —
  it is not a stage a parcel passes through, it is where a parcel stops. Adding
  it there would make it reachable by pressing "advance" one more time, which is
  the opposite of the intent.
*/
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check check (
  status in (
    'Booked', 'Assigned', 'Picked Up', 'In Transit', 'Out for Delivery',
    'Delivered', 'Cancelled'
  )
);

/*
  A cancelled row must carry its cancellation, and an uncancelled row must not.

  Without this a status could be flipped to 'Cancelled' by any path that misses
  the timestamp, leaving a parcel that is cancelled but cannot say when, by
  whom, or why.
*/
alter table public.bookings drop constraint if exists cancellation_consistent;
alter table public.bookings add constraint cancellation_consistent check (
  (status <> 'Cancelled' and cancelled_at is null and cancelled_role is null)
  or (status = 'Cancelled' and cancelled_at is not null and cancelled_role is not null)
);

-- ------------------------------------------------------------ the rules ----

/**
 * Who may cancel a booking in a given state.
 *
 * Split out from `cancel_booking` so the client can ask the same question the
 * server will answer, without duplicating the rule in TypeScript. `src/store/
 * cancellation.ts` mirrors these two windows and is tested against this file.
 */
create or replace function public.cancellation_allowed(
  booking_status text,
  actor_role text
)
returns boolean language sql immutable set search_path = '' as $$
  select case actor_role
    /*
      Sender: only before a driver has committed.

      'Booked' is the whole window. The moment a driver claims it the parcel
      becomes 'Assigned' and somebody may already be riding towards the pickup.
    */
    when 'sender' then booking_status = 'Booked'

    /*
      Driver: only before the parcel has left the sender.

      'Assigned' is the whole window, for the same reason in reverse. Once it is
      'Picked Up' the driver physically has it, and handing it back is not a
      cancellation — there is no flow in this app for returning a parcel to a
      sender, and pretending otherwise would leave the parcel marked Cancelled
      while sitting in someone's bag.
    */
    when 'driver' then booking_status = 'Assigned'
    else false
  end;
$$;

/**
 * Cancels a booking.
 *
 * `security definer` because a driver cancelling has to clear `driver_id` —
 * a column the claim policy does not let them write — and because the whole
 * rule belongs in one readable place rather than split across two policies.
 */
create or replace function public.cancel_booking(
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
  row_status text;
  row_sender uuid;
  row_driver uuid;
  actor_role text;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select status, sender_id, driver_id
    into row_status, row_sender, row_driver
  from public.bookings where id = booking_id;

  if row_status is null then
    raise exception 'No such booking';
  end if;

  /*
    The actor's role is derived from the row, never taken as an argument.

    Passing it in would let a sender claim to be the driver and cancel inside
    the wrong window.
  */
  if row_sender = actor then
    actor_role := 'sender';
  elsif row_driver is not distinct from actor then
    actor_role := 'driver';
  else
    raise exception 'This parcel is not yours to cancel';
  end if;

  if row_status = 'Cancelled' then
    raise exception 'This parcel is already cancelled';
  end if;

  if not public.cancellation_allowed(row_status, actor_role) then
    if actor_role = 'sender' then
      raise exception 'A driver has already accepted this parcel, so it can no longer be cancelled here. Contact support.';
    else
      raise exception 'You are already carrying this parcel. Cancelling stops at pickup — contact support.';
    end if;
  end if;

  if actor_role = 'driver' then
    /*
      Back to the open board, in one statement.

      The parcel returns to 'Booked' with no driver, so any approved driver can
      claim it again. It is the sender's parcel and it has not moved — parking
      it for an admin would leave it invisible until someone woke up.

      Note this is *not* a cancellation of the parcel: the shipment survives,
      only the assignment ends. The audit line below records that distinction.
    */
    update public.bookings
       set status = 'Booked',
           driver = null,
           driver_id = null,
           accepted_at = null
     where id = booking_id;

    insert into public.app_events (level, area, message, context, actor_id)
    values (
      'warning',
      'delivery',
      'driver released an accepted job',
      jsonb_build_object(
        'booking', booking_id,
        'reason', left(coalesce(reason, ''), 200)
      ),
      actor
    );

    return 'Booked';
  end if;

  update public.bookings
     set status = 'Cancelled',
         cancelled_at = now(),
         cancelled_by = actor,
         cancelled_role = 'sender',
         cancellation_reason = nullif(trim(coalesce(reason, '')), '')
   where id = booking_id;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info',
    'delivery',
    'sender cancelled a parcel',
    -- Ids and a reason. No address, recipient name or phone: an admin reads
    -- this log and a parcel's contact details are not theirs by default.
    jsonb_build_object(
      'booking', booking_id,
      'reason', left(coalesce(reason, ''), 200)
    ),
    actor
  );

  return 'Cancelled';
end;
$$;

revoke all on function public.cancel_booking(uuid, text) from public, anon;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

-- ----------------------------------------------------- keep the rest honest --

/*
  Claiming already refuses a cancelled parcel, and this is worth stating rather
  than adding a guard for.

  The update policy in `20250101000001_bookings.sql` gates a claim on
  `driver_id is null and status = 'Booked'`. A cancelled parcel is at status
  'Cancelled', so it fails that check without any change here — and
  `isClaimable` in `src/store/bookings.tsx` asks the same question client-side.

  Reading it is still permitted: the select policy allows any signed-in user to
  see a row with no driver, which now includes cancelled ones. That is not a
  leak — those rows were already public to signed-in users while they were open
  — but it does mean the open jobs board must filter on status rather than on
  `driver_id`, which `availableBookings` does.
*/

/*
  ⚠ Not built, and worth deciding before real money moves:
    - No refund. Nothing in this app takes payment yet, so cancelling costs
      nobody anything. The moment payment exists, a sender cancelling a parcel
      they have paid for needs a refund path, and this function is where it
      would hang.
    - No limit on driver releases. A driver who claims and drops jobs all day
      is visible in `app_events` (level 'warning', area 'delivery') but nothing
      stops them. Watch the log before adding a rule — a threshold picked
      without data will be wrong.
*/
