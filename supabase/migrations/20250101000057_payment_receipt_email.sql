-- Package Relay — the sender hears from us, not only from Paystack.
--
-- Run after 56. Re-runnable.
--
-- ⚠ The gap this closes had no symptom in the database.
--
--   56 collects the fare, flips `payment_status` to 'paid' and dispatches the
--   parcel. All of that worked on the first live test. What the sender received
--   was Paystack's own confirmation — an email from a payment processor about a
--   charge, naming no parcel, no route and no tracking id — and nothing from
--   Package Relay at all. The money moved and the only party that wrote to the
--   customer was the gateway.
--
--   38's opening comment says why no receipt existed then: "LOCI has no payment
--   provider, no charge record and no `paid` state on a booking". 56 supplied
--   all three, and this is the email that was waiting on them.
--
-- ⚠ It is a confirmation, not a tax receipt, and the template says so.
--
--   38 made the same distinction for `delivery_completed` and it still holds:
--   Paystack issues the document with legal standing. This one tells a sender
--   which parcel their money was for and that it is now on the board — the two
--   things the gateway's email cannot say.

do $$
begin
  if to_regclass('public.parcel_payments') is null then
    raise exception 'Run 20250101000056_parcel_payments.sql first.';
  end if;
  if to_regprocedure('public.queue_email(text, text, text, jsonb)') is null then
    raise exception 'Run 20250101000038_transactional_email.sql first.';
  end if;
end
$$;

-- ---------------------------------------------- 1. the outbox admits it --

/*
  ⚠ The full list repeated verbatim, exactly as 41 did, and for the reason 41
    gives at length.

    A trigger that queues a kind the constraint does not admit raises *inside*
    `queue_email`, in the same transaction as the thing it is reporting. Here
    that transaction is `settle_parcel_payment`. So a missing entry in this list
    would not produce a missing email — it would roll back the settlement, leave
    a verified charge unrecorded and a paid parcel showing as unpaid. The list
    below is 41's, unchanged, with one line added.

    `verify-emails.ts` compares the last constraint in the chain against the
    template map in `notify-events/templates.ts`, which is what makes the two
    hand-written lists stay in step.
*/
alter table public.email_outbox
  drop constraint if exists email_outbox_kind_check;

alter table public.email_outbox
  add constraint email_outbox_kind_check
  check (kind in (
    'driver_application_approved',
    'driver_application_rejected',
    'guarantor_invitation',
    'sender_verification_submitted',
    'sender_verified',
    'sender_verification_rejected',
    'delivery_completed',
    'parcel_cancelled',
    'parcel_status_changed',
    'driver_offer',
    'driver_job_cancelled',
    'payout_paid',
    'parcel_payment_received'
  ));

-- ------------------------------------------------- 2. the trigger --------

/**
 * Queues the payment confirmation the moment a parcel becomes paid.
 *
 * ⚠ On `bookings`, not on `parcel_payments`, and that is deliberate.
 *
 *   `parcel_payments.status` reaching 'success' is the charge clearing. It is
 *   not the same event as the parcel becoming live: a charge that lands on a
 *   parcel cancelled mid-checkout is settled and recorded, and `settle_parcel_payment`
 *   pointedly does *not* flip that parcel to paid — it logs a refund owed
 *   instead. Firing on the payment row would email that sender "your parcel is
 *   on its way" about a parcel that has stopped, with no refund behind it.
 *
 *   The transition into `payment_status = 'paid'` is the event worth writing
 *   about, so it is the one this watches — the same transition
 *   `dispatch_paid_booking` watches, so the email and the dispatch can never
 *   disagree about whether a parcel went live.
 *
 * ⚠ 'paid' specifically, not "no longer pending".
 *
 *   'waived' is in the vocabulary for a parcel Package Relay decides not to
 *   charge for. Nobody paid, so "we have received your payment" would be a
 *   sentence about a thing that did not happen. Only a real charge emails.
 *
 * ⚠ The transaction details come from the payment row, not from the booking.
 *
 *   A parcel knows its fare; only `parcel_payments` knows what was actually
 *   charged, through which channel, under which reference and at what moment.
 *   By the time this fires, `settle_parcel_payment` has already written that
 *   row — it updates the payment before the booking, in the same transaction —
 *   so the snapshot below is the settled one rather than the attempt.
 */
create or replace function public.email_on_parcel_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  charge public.parcel_payments;
  sender_email text;
begin
  if new.payment_status <> 'paid' or old.payment_status is not distinct from new.payment_status then
    return new;
  end if;

  select * into charge
    from public.parcel_payments
   where booking_id = new.id
     and status = 'success'
   order by paid_at desc nulls last
   limit 1;

  /*
    ⚠ No charge row, no email — rather than an email with blanks in it.

      A parcel can reach 'paid' without one: an operator settling something by
      hand, a restore, the 'waived' path if it is ever wired to 'paid' by
      mistake. An email headed "Payment received" listing an empty reference and
      ₦0 is worse than silence, and it is the kind of thing a customer forwards
      to support asking what they were charged.
  */
  if charge.id is null then
    return new;
  end if;

  sender_email := public.email_for_user(new.sender_id);

  perform public.queue_email(
    'parcel_payment_received',
    /*
      ⚠ Keyed on the charge, not on the parcel.

        One parcel, one payment, today — so the two are interchangeable and the
        booking id would work. The reference is used anyway because this email
        is about a transaction: if a refunded parcel is ever paid for a second
        time, that is a second charge and deserves its own confirmation, which a
        booking-id key would silently swallow through `on conflict do nothing`.
    */
    charge.reference,
    sender_email,
    jsonb_build_object(
      'tracking_id', new.tracking_id,
      'reference', charge.reference,
      /*
        Naira, converted here so the template is handed the same kind of number
        every other money field in this system carries. `amount_kobo` is the
        stored truth; dividing once, at the edge, beats three templates each
        remembering to.
      */
      'amount', round(charge.amount_kobo::numeric / 100, 2),
      'channel', charge.channel,
      'paid_at', coalesce(charge.paid_at, now()),
      'item_description', new.item_description,
      'recipient_name', new.recipient_name,
      'delivery_type', new.delivery_type,
      /*
        The route as a person reads it: the neighbourhood matters more than the
        city on a local delivery, and the city matters more on an inter-state
        one. Both are sent and the template decides.
      */
      'origin_city', new.origin_city,
      'destination_city', new.destination_city,
      'pickup_area', new.pickup_area,
      'dropoff_area', new.dropoff_area
    )
  );

  return new;
end;
$$;

/*
  ⚠ A second trigger on the same transition rather than a branch inside
    `dispatch_paid_booking`.

    They are the same event and it is tempting to fold them together. They have
    different failure modes: `dispatch_booking` reaching into the matcher is
    load-bearing for the marketplace, and queueing an email is not. Separate
    triggers keep an email problem from being able to take dispatch down with
    it, which is the arrangement 38 chose for exactly this reason — the outbox
    exists so that mail is never in the path of the thing it reports on.

  ⚠ Named to sort after `bookings_dispatch_on_payment`.

    Postgres fires per-row triggers in name order. `dispatch` before `email`
    alphabetically means the parcel is on the board before the email saying so
    is queued — which matters only if the two ever disagree, and costs nothing
    to get right.
*/
drop trigger if exists bookings_email_on_payment on public.bookings;
create trigger bookings_email_on_payment
  after update of payment_status on public.bookings
  for each row execute function public.email_on_parcel_paid();

-- ------------------------------------------------------------- grants ----

/*
  Trigger functions are called by the database, never by a client. `queue_email`
  itself is already closed the same way — an account that could call it could
  send mail from a Package Relay-signed domain to any address it liked.
*/
revoke all on function public.email_on_parcel_paid() from public, anon, authenticated;

notify pgrst, 'reload schema';
