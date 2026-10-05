-- ============================================================================
-- production-catchup-56-61.sql — payments, finance, support: none of it is here
-- ============================================================================
--
-- Paste the WHOLE file into the SQL editor and run it once. The editor runs it
-- as a single batch, so if any statement fails the whole thing rolls back.
--
-- ⚠ Every statement is migrations 56, 57, 58, 59, 60 and 61 from the repo,
--   concatenated in order and unmodified — with ONE exception, marked in full
--   where it occurs: migration 57's `email_outbox_kind_check` list is widened to
--   the vocabulary this database already has. 57 predates `welcome`,
--   `password_changed` and `guarantor_completed`, all of which are applied here
--   and all of which have sent rows, so replaying 57's narrower list fails on
--   the data:
--
--     ERROR: 23514: check constraint "email_outbox_kind_check" ... is violated
--            by some row
--
--   The replacement is the union, and is identical to what migration 66
--   installs. See the comment at that statement.
--
-- WHAT IS WRONG
--
--   "Could not open the checkout. Could not reach the payment service." — and it
--   is not the network. There is no payment service on this database to reach:
--
--     parcel_payments table ................ missing
--     bookings.payment_status column ....... missing
--     open_parcel_payment, settle_parcel_payment, parcel_fare_kobo ... missing
--     every admin finance function ......... missing
--     support_tickets ...................... missing
--     payments-initialize / -verify / -webhook edge functions ........ NOT DEPLOYED
--
--   62, 63 and 64 are applied here but 56 to 61 are not, so the web build that
--   production is serving calls `payments-initialize` against a project that has
--   never heard of it.
--
-- ⚠ READ THIS BEFORE YOU RUN IT: parcels have been moving unpaid.
--
--   Without migration 56 there is no `payment_status` on `bookings` and no guard
--   on dispatch, so every parcel posted on this database went straight to
--   Booked and straight onto the driver board without a fare ever being
--   collected. There are four of them right now. That is not a thing this script
--   can fix retrospectively, and you should decide what to do about those four
--   before or after running it — not neither.
--
-- WHY IT IS SAFE FOR THE PARCELS THAT ALREADY EXIST
--
--   56 was written for exactly this, and says so in its own comments. The column
--   arrives as:
--
--     add column if not exists payment_status text not null default 'paid';
--     alter column payment_status set default 'pending';
--
--   Existing rows are grandfathered as settled — "the truth as far as this
--   system can know it" — and only parcels posted AFTER this runs are required
--   to pay. Adding it as 'pending' would have emptied the driver board and
--   stopped every in-flight dispatch in one statement.
--
--   Nothing else in 56 to 61 deletes a row or drops a column. 59 creates its own
--   tables. 58 and 60 are read-only reporting functions.
--
-- ⚠ THE SQL IS HALF THE FIX. The three payments edge functions are not deployed:
--
--     supabase functions deploy payments-initialize payments-verify payments-webhook
--     supabase secrets set PAYSTACK_SECRET_KEY="sk_live_..."
--
--   Without those, checkout still cannot open — it will just fail for a second
--   reason. Do both.

-- ------------------------------------------------------------- pre-flight --

do $preflight$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'public.bookings is missing. This is not the database you think it is. Stopping.';
  end if;
  if to_regprocedure('public.is_verified_sender()') is null then
    raise exception 'is_verified_sender is missing — migration 42 has not been applied. Stopping.';
  end if;
  if to_regprocedure('public.is_erased()') is null then
    raise exception 'is_erased() is missing — migration 33 has not been applied. Stopping.';
  end if;
  if to_regclass('public.driver_earnings') is null or to_regclass('public.payout_requests') is null then
    raise exception 'driver_earnings or payout_requests is missing — migration 30 has not been applied. Stopping.';
  end if;
  if to_regclass('public.notifications') is null then
    raise exception 'notifications is missing — run production-catchup-49-66.sql first (59 needs it). Stopping.';
  end if;
  if to_regprocedure('public.queue_notification(uuid,text,text,text,text,jsonb,boolean)') is null then
    raise exception 'queue_notification is missing — run production-catchup-49-66.sql first. Stopping.';
  end if;
  if to_regclass('public.photo_capture_sessions') is null then
    raise exception 'photo_capture_sessions is missing — migration 13 has not been applied. Stopping.';
  end if;
end
$preflight$;



-- ############################################################################
-- migration 20250101000056_parcel_payments.sql
-- ############################################################################

-- Package Relay — the fare is paid before the parcel exists to a driver.
--
-- Run after 01–55. Re-runnable.
--
-- Until now a parcel was posted and dispatched in the same breath: the insert
-- fired `dispatch_new_booking`, an offer went out, and a driver could be on
-- their way to a pickup nobody had paid for. This file inserts one gate into
-- that sequence and nothing else.
--
-- The rules this encodes, in plain terms:
--
--   * A parcel is created unpaid. It belongs to its sender, it is visible to
--     its sender, and it is invisible to every driver.
--   * Nothing dispatches it until a payment has been verified against the
--     provider's own API by something holding the secret key.
--   * The client cannot say a parcel is paid. Not through PostgREST, not
--     through the sender's own update policy, not at all.
--   * Verification is idempotent, because a webhook and a returning browser
--     will both report the same successful charge and the second one must be
--     a no-op rather than a second dispatch.

do $$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'Run 20250101000001_bookings.sql first.';
  end if;
  if to_regprocedure('public.dispatch_booking(uuid)') is null then
    raise exception 'Run 20250101000015_dispatch.sql first.';
  end if;
end
$$;

-- ------------------------------------------------ 1. the column on bookings --

/*
  ⚠ The default is 'paid', and then it is changed to 'pending'.

    Read that twice, because getting it the obvious way round would have been
    an outage. Every parcel already in this table was posted under the old
    rules — no gateway existed, the fare was never collected through the app,
    and those parcels are live: some are in transit, some are sitting on the
    board waiting for a driver. Adding the column with `default 'pending'`
    would have marked all of them unpaid in one statement, and the policy two
    sections down would then have emptied the driver board and stopped every
    in-flight dispatch.

    So the column arrives claiming the existing rows are settled, which is the
    truth as far as this system can know it, and only then does the default
    change for everything inserted afterwards.
*/
alter table public.bookings
  add column if not exists payment_status text not null default 'paid';

alter table public.bookings
  alter column payment_status set default 'pending';

alter table public.bookings drop constraint if exists bookings_payment_status_check;
alter table public.bookings add constraint bookings_payment_status_check check (
  payment_status in ('pending', 'paid', 'waived', 'refunded')
);

/*
  'waived' exists for the parcel somebody at Package Relay decides not to charge
  for — a goodwill re-send after a failed delivery — and 'refunded' for one
  charged and given back. Neither has a path in this migration: they are in the
  vocabulary so the eventual admin action has a value to write that is not a
  lie, rather than reusing 'paid' and losing the distinction forever.
*/

alter table public.bookings
  add column if not exists paid_at timestamptz;

-- The board filters on this now, and an unpaid parcel must not cost the
-- scan. Partial, because 'pending' rows are the minority and the short-lived
-- ones.
create index if not exists bookings_awaiting_payment_idx
  on public.bookings (sender_id, created_at desc)
  where payment_status = 'pending';

comment on column public.bookings.payment_status is
  'pending until a charge is verified against the provider. Only server-side '
  'functions may change it — see bookings_guard_payment.';

-- ---------------------------------------------------------- 2. the payments --

create table if not exists public.parcel_payments (
  id uuid primary key default gen_random_uuid(),

  booking_id uuid not null references public.bookings (id) on delete cascade,
  /*
    Denormalised from the booking on purpose. The payment record has to outlive
    questions like "who was charged for this" independently of whatever happens
    to the parcel row, and `on delete cascade` above means an erased account
    takes both with it — which is the behaviour the NDPR erasure path already
    has for parcels and must keep having for payments.
  */
  sender_id uuid not null references auth.users (id) on delete cascade,

  provider text not null default 'paystack' check (provider in ('paystack', 'flutterwave')),

  /*
    Our reference, generated here and sent to the provider — not theirs.

    A provider-generated id cannot be known until their API answers, which
    leaves a window where a charge exists and nothing in this database points
    at it. Ours is written first, in the same statement that creates the row,
    so a timed-out initialize still leaves something to reconcile against.
  */
  reference text not null unique,
  /* Theirs, once they tell us. Kept for support tickets and reconciliation. */
  gateway_reference text,

  /*
    ⚠ Kobo, as an integer, never naira as a float.

      Paystack's API is denominated in the minor unit and so is this column.
      Holding a fare as 2800.00 naira and multiplying by 100 at three different
      call sites is how a rounding difference becomes a customer who was
      charged one kobo too little and a parcel that never dispatched.
  */
  amount_kobo bigint not null check (amount_kobo > 0),
  currency text not null default 'NGN',

  status text not null default 'pending' check (
    status in ('pending', 'success', 'failed', 'abandoned')
  ),

  authorization_url text,
  channel text,
  failure_reason text,

  /*
    The provider's own verification payload, verbatim.

    Not for the app to read — for the person reconciling a disputed charge six
    months from now, who needs what the gateway actually said rather than this
    schema's interpretation of it.
  */
  raw_verification jsonb,

  initialized_at timestamptz not null default now(),
  verified_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  /* A settled payment must carry when it settled, and an unsettled one must not. */
  constraint parcel_payment_settled_consistent check (
    (status <> 'success' and paid_at is null)
    or (status = 'success' and paid_at is not null)
  )
);

create index if not exists parcel_payments_booking_idx on public.parcel_payments (booking_id);
create index if not exists parcel_payments_sender_idx on public.parcel_payments (sender_id);

/*
  ⚠ One live attempt per parcel, enforced by the database rather than by the
    function that creates them.

    A sender who taps Pay, gets a slow modal, backgrounds the app and taps
    again produces two initializations. Without this they produce two
    references, two Paystack transactions, and a real chance of two charges.
    A partial unique index says: at most one row per booking that has not
    finished. Retrying after a failure is still allowed, because a failed row
    is not `pending`.
*/
create unique index if not exists parcel_payments_one_live_attempt
  on public.parcel_payments (booking_id)
  where status = 'pending';

alter table public.parcel_payments enable row level security;

/*
  Read-only to its owner, and writable by nobody.

  There is deliberately no insert, update or delete policy: with RLS on and no
  policy, PostgREST refuses all three for every client role. Every write in
  this file happens inside a `security definer` function called by an edge
  function holding the service key, which is the only place the provider's
  secret exists and therefore the only place that can honestly say a charge
  succeeded.
*/
drop policy if exists "sender reads own payments" on public.parcel_payments;
create policy "sender reads own payments"
  on public.parcel_payments for select
  to authenticated
  using (sender_id = (select auth.uid()));

-- ----------------------------------------- 3. the client cannot mark it paid --

/*
  ⚠ Without this trigger the whole file is decorative.

    `advance own parcel` (20250101000025_dispatch_only.sql) lets a sender update
    their own unassigned parcel — they edit an address, they cancel. RLS is
    row-level and column-blind, so that same policy would let a sender PATCH
    `payment_status = 'paid'` straight through PostgREST and dispatch a parcel
    they never paid for. The gateway would never be contacted.

  ⚠ How it tells a client apart from the functions that own these columns.

    Exactly as `guard_delivery_state` does in 20250101000048_rls_hardening.sql:
    `settle_parcel_payment` and `fail_parcel_payment` are SECURITY DEFINER and
    owned by the migration role, so inside them `current_user` is that role. A
    request arriving through PostgREST runs as `authenticated` (or `anon`).
    Checking `current_user` therefore needs no cooperation from any caller.

  ⚠ This function must NOT be SECURITY DEFINER, for the same reason 48's is
    not: `current_user` inside a definer function is always the owner, and the
    guard would never fire on anybody.
*/
create or replace function public.bookings_guard_payment()
returns trigger language plpgsql as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.payment_status is distinct from old.payment_status
     or new.paid_at is distinct from old.paid_at then
    raise exception 'payment_status and paid_at are written by payment verification, not by a client'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_guard_payment on public.bookings;
create trigger bookings_guard_payment
  before update on public.bookings
  for each row execute function public.bookings_guard_payment();

-- ------------------------------------------------------ 4. the insert policy --

/*
  Replaces "sender creates own" from 48, which replaced 44's, which replaced
  42's, which replaced 09's, which replaced 01's.

  ⚠ Every earlier guard is repeated verbatim, for the sixth time.

    09 left this warning and each of 42, 44 and 48 carried it forward
    unchanged: recreating this policy with only the new condition quietly drops
    the others and lets a client post a parcel pre-assigned to a driver, or
    unverified, or with no selfie. The list below is 48's, byte for byte, with
    one line added at the end. Read it against 48 before editing it.

  ⚠ The new line pins the *initial* value, it does not create the gate.

    A parcel may only be born unpaid. What stops it being *made* paid is the
    trigger above, not this policy — a WITH CHECK on INSERT has nothing to say
    about a later UPDATE. Both are needed and neither is sufficient.
*/
drop policy if exists "sender creates own" on public.bookings;
create policy "sender creates own"
  on public.bookings for insert
  to authenticated
  with check (
    sender_id = (select auth.uid())
    -- A parcel cannot be posted pre-assigned; claiming is a separate step.
    and driver_id is null
    and driver is null
    and status = 'Booked'
    and not public.is_erased()
    and public.is_verified_sender()
    and sender_photo_path is not null
    -- And it cannot be posted already paid for.
    and payment_status = 'pending'
  );

-- -------------------------------------------------------- 5. the read policy --

/*
  Replaces "read own, carried, or unclaimed" from 20250101000017_admin_parcel_detail.sql.

  ⚠ 17's two earlier conditions are repeated verbatim, and the third is the
    only one that changes.

    17 narrowed the open board from "every signed-in account" to "approved
    drivers". This narrows it again, by one clause: an approved driver sees an
    unclaimed parcel once its fare has been verified.

    The first two branches are untouched on purpose. A sender must keep seeing
    their own parcel while it is waiting to be paid for — that is the row the
    checkout screen is about, and hiding it would mean the sender could not see
    what they are being asked to pay for, nor retry a failed attempt.
*/
drop policy if exists "read own, carried, or unclaimed" on public.bookings;
create policy "read own, carried, or unclaimed"
  on public.bookings for select
  to authenticated
  using (
    sender_id = (select auth.uid())
    or driver_id = (select auth.uid())
    or (driver_id is null and public.is_approved_driver() and payment_status <> 'pending')
  );

-- -------------------------------------------------------- 6. dispatch waits --

/*
  Replaces `dispatch_new_booking` from 20250101000015_dispatch.sql.

  15's comment said "every new parcel is offered as soon as it exists", and
  made it a trigger rather than a client call precisely so the client could not
  skip it. That reasoning is unchanged; what changes is when a parcel counts as
  existing. An unpaid one is a draft with a tracking id.

  The `payment_status` test rather than an unconditional return keeps the
  behaviour for the backfilled rows: they arrived 'paid' (section 1), so
  anything inserted by an admin tool or a restore still dispatches at once.
*/
create or replace function public.dispatch_new_booking()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.payment_status = 'pending' then
    return new;
  end if;

  perform public.dispatch_booking(new.id);
  return new;
end;
$$;

/*
  And the other half: the parcel that *becomes* paid.

  ⚠ AFTER UPDATE, not BEFORE, and guarded on the transition rather than on the
    value.

    `settle_parcel_payment` writes payment_status once. Firing on the value
    would re-dispatch on every later update of a paid parcel — every address
    edit, every status advance — handing the same parcel to the matcher again
    and again. Comparing old with new means this runs exactly once per parcel,
    at the moment the money is confirmed.

  ⚠ A cancelled parcel is not dispatched.

    A sender can cancel while the checkout modal is open, and the charge can
    land afterwards. That is a refund, which is a human job — see
    `settle_parcel_payment`, which logs it — and emphatically not an offer to a
    driver.
*/
create or replace function public.dispatch_paid_booking()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.payment_status = 'pending'
     and new.payment_status <> 'pending'
     and new.status = 'Booked'
     and new.driver_id is null then
    perform public.dispatch_booking(new.id);
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_dispatch_on_payment on public.bookings;
create trigger bookings_dispatch_on_payment
  after update of payment_status on public.bookings
  for each row execute function public.dispatch_paid_booking();

-- ------------------------------------------------------- 7. what is owed --

/**
 * The fare, in kobo, for a parcel.
 *
 * One function so the amount charged, the amount checked against the gateway's
 * answer, and the amount shown on a receipt are the same arithmetic. The edge
 * function does not compute it and the client is never asked: `estimated_fee`
 * is immutable from the moment of insert (`bookings_guard_immutable`, 01), so
 * this is the only number anybody can be charged.
 */
create or replace function public.parcel_fare_kobo(p_booking uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select round(b.estimated_fee * 100)::bigint
    from public.bookings b
   where b.id = p_booking;
$$;

-- ------------------------------------------------- 8. opening an attempt --

/**
 * Records that a charge is about to be attempted, and says what it must be for.
 *
 * Called by `payments-initialize` before it talks to Paystack, so that a
 * reference exists in this database before it exists at the provider. The
 * reverse order loses the reference when the API call times out, and an
 * untracked reference is a charge nobody can reconcile.
 *
 * Returns the row. Raises rather than returning null on every refusal, because
 * each one is a different thing to tell the sender.
 */
create or replace function public.open_parcel_payment(
  p_booking uuid,
  p_reference text,
  p_provider text default 'paystack'
)
returns public.parcel_payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  parcel public.bookings;
  owed bigint;
  existing public.parcel_payments;
  created public.parcel_payments;
begin
  select * into parcel from public.bookings where id = p_booking;

  if parcel.id is null then
    raise exception 'No such parcel' using errcode = 'no_data_found';
  end if;

  if parcel.payment_status <> 'pending' then
    raise exception 'That parcel has already been paid for' using errcode = 'check_violation';
  end if;

  if parcel.status = 'Cancelled' then
    raise exception 'That parcel was cancelled' using errcode = 'check_violation';
  end if;

  owed := public.parcel_fare_kobo(p_booking);

  if owed is null or owed <= 0 then
    raise exception 'That parcel has no fare to charge' using errcode = 'check_violation';
  end if;

  /*
    ⚠ An existing live attempt is reused, not replaced.

      The partial unique index would refuse a second 'pending' row anyway; this
      turns that refusal into the sensible behaviour. A sender who taps Pay
      twice gets the same reference both times and therefore, at most, one
      charge. `payments-initialize` re-initializes that reference with the
      provider, which Paystack allows and which returns the same transaction.
  */
  select * into existing
    from public.parcel_payments
   where booking_id = p_booking and status = 'pending'
   limit 1;

  if existing.id is not null then
    return existing;
  end if;

  insert into public.parcel_payments (
    booking_id, sender_id, provider, reference, amount_kobo
  ) values (
    p_booking, parcel.sender_id, p_provider, p_reference, owed
  )
  returning * into created;

  return created;
end;
$$;

-- --------------------------------------------------- 9. settling an attempt --

/**
 * Marks a charge verified and turns the parcel loose.
 *
 * ⚠ Called only after the provider's own API has been asked, with the secret
 *   key, and has answered `success`. Nothing in this function verifies
 *   anything — it records a verdict reached elsewhere. Calling it on the
 *   strength of a client's say-so would make every guard in this file
 *   pointless.
 *
 * ⚠ Idempotent, because it has two callers that will both fire.
 *
 *   The webhook and the returning browser both report the same charge, in
 *   either order, sometimes within the same second. The second call must find
 *   the payment already settled and do nothing — not raise, because a webhook
 *   that receives an error retries, and not dispatch again, because the parcel
 *   is already on the board.
 *
 * Returns a small json verdict rather than a row: the caller is an edge
 * function that needs to know what happened, not what the table looks like.
 */
create or replace function public.settle_parcel_payment(
  p_reference text,
  p_gateway_reference text,
  p_amount_kobo bigint,
  p_channel text,
  p_paid_at timestamptz,
  p_raw jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment public.parcel_payments;
  parcel public.bookings;
begin
  /*
    ⚠ Locked for the duration.

      Two callers, arriving together, would otherwise both read 'pending' and
      both proceed — and while the booking update is harmless twice, the
      dispatch trigger firing twice is a parcel offered to two drivers. The
      lock makes the second caller wait and then see 'success'.
  */
  select * into payment
    from public.parcel_payments
   where reference = p_reference
   for update;

  if payment.id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_reference');
  end if;

  if payment.status = 'success' then
    return jsonb_build_object(
      'ok', true, 'already_settled', true, 'booking_id', payment.booking_id
    );
  end if;

  /*
    ⚠ Underpayment is a failure, not a discount.

      Paystack's initialize call is given an amount, but the amount that
      arrives is whatever the transaction actually carried. Trusting the
      verified payload without comparing it with what was owed is the hole that
      lets somebody re-use a reference from a cheaper parcel.

      Overpayment settles. It should not happen, and refusing a parcel whose
      sender has been charged too much would be the worse of the two failures.
  */
  if p_amount_kobo < payment.amount_kobo then
    update public.parcel_payments
       set status = 'failed',
           failure_reason = format(
             'Paid %s kobo against a fare of %s kobo', p_amount_kobo, payment.amount_kobo
           ),
           gateway_reference = coalesce(p_gateway_reference, gateway_reference),
           raw_verification = p_raw,
           verified_at = now(),
           updated_at = now()
     where id = payment.id;

    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch');
  end if;

  update public.parcel_payments
     set status = 'success',
         gateway_reference = coalesce(p_gateway_reference, gateway_reference),
         channel = coalesce(p_channel, channel),
         raw_verification = p_raw,
         verified_at = now(),
         paid_at = coalesce(p_paid_at, now()),
         updated_at = now()
   where id = payment.id;

  select * into parcel from public.bookings where id = payment.booking_id for update;

  /*
    The parcel may have been cancelled while the sender was in the checkout.

    The money is real and this function is not the place to give it back, so it
    is recorded as a payment that succeeded against a parcel that stopped, and
    an operator is told. Flipping a cancelled parcel to paid would put it back
    on the board, which is worse than an unrefunded charge and harder to notice.
  */
  if parcel.status = 'Cancelled' then
    insert into public.app_events (level, area, message, context, actor_id)
    values (
      'warning',
      'payment',
      'Charge settled against a cancelled parcel — refund owed',
      jsonb_build_object(
        'booking_id', parcel.id,
        'reference', p_reference,
        'amount_kobo', p_amount_kobo
      ),
      null
    );

    return jsonb_build_object(
      'ok', true, 'booking_id', parcel.id, 'cancelled', true, 'refund_owed', true
    );
  end if;

  update public.bookings
     set payment_status = 'paid',
         paid_at = coalesce(p_paid_at, now())
   where id = payment.booking_id
     and payment_status = 'pending';

  return jsonb_build_object('ok', true, 'booking_id', payment.booking_id);
end;
$$;

/**
 * Marks an attempt dead, so the sender can start another one.
 *
 * Without this a declined card leaves a 'pending' row, the partial unique index
 * refuses a second attempt, and the sender is locked out of paying for their
 * own parcel by a piece of bookkeeping.
 */
create or replace function public.fail_parcel_payment(
  p_reference text,
  p_reason text,
  p_abandoned boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment public.parcel_payments;
begin
  select * into payment
    from public.parcel_payments
   where reference = p_reference
   for update;

  if payment.id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_reference');
  end if;

  /* A charge that has already succeeded is never talked back down. */
  if payment.status = 'success' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled');
  end if;

  update public.parcel_payments
     set status = case when p_abandoned then 'abandoned' else 'failed' end,
         failure_reason = p_reason,
         verified_at = now(),
         updated_at = now()
   where id = payment.id;

  return jsonb_build_object('ok', true, 'booking_id', payment.booking_id);
end;
$$;

/**
 * Sweeps attempts nobody ever finished.
 *
 * A sender who closes the checkout and never comes back leaves a 'pending' row
 * forever, and the partial unique index turns that into "you cannot pay for
 * this parcel any more". Paystack transactions themselves go stale within the
 * hour, so an attempt older than that is abandoned by any reading.
 *
 * Not scheduled here. `docs/PAYMENTS.md` has the `cron.schedule` call — it
 * belongs with the other `loci-*` jobs, which are set up per project rather
 * than by a migration.
 */
create or replace function public.expire_parcel_payments()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  swept integer;
begin
  with stale as (
    update public.parcel_payments
       set status = 'abandoned',
           failure_reason = 'Checkout was never completed',
           updated_at = now()
     where status = 'pending'
       and initialized_at < now() - interval '1 hour'
    returning 1
  )
  select count(*) into swept from stale;

  return swept;
end;
$$;

-- ------------------------------------------------------------- 10. grants --

/*
  ⚠ None of these are granted to `authenticated`.

    Every one of them decides whether money was received. A client that could
    call `settle_parcel_payment` could post parcels for nothing, and a client
    that could call `open_parcel_payment` could mint references at will. They
    are reachable only through the edge functions, which hold the service key
    and the provider secret.

    `parcel_fare_kobo` is the one that looks harmless — it only reads a number
    the sender can already see. It is still closed, because a definer function
    over `bookings` bypasses RLS and would answer for *any* parcel id.
*/
revoke all on function public.parcel_fare_kobo(uuid) from public, anon, authenticated;
revoke all on function public.open_parcel_payment(uuid, text, text) from public, anon, authenticated;
revoke all on function public.settle_parcel_payment(text, text, bigint, text, timestamptz, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_parcel_payment(text, text, boolean) from public, anon, authenticated;
revoke all on function public.expire_parcel_payments() from public, anon, authenticated;

notify pgrst, 'reload schema';


-- ############################################################################
-- migration 20250101000057_payment_receipt_email.sql
-- ############################################################################

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
  /*
    ⚠ THE ONE PLACE THIS SCRIPT DEPARTS FROM THE MIGRATION, AND WHY.
    ⚠ ---------------------------------------------------------------

      57 ships the email vocabulary as it stood on the day it was written. This
      database is AHEAD of that: 62, 63 and 66 have already been applied here and
      added `welcome`, `password_changed` and `guarantor_completed`, and
      `email_outbox` already holds sent rows of all three.

      Applying 57's list verbatim therefore fails, and fails on the data rather
      than the schema:

        ERROR: 23514: check constraint "email_outbox_kind_check" of relation
               "email_outbox" is violated by some row

      That is not a mistake in 57. It is what applying an older migration to a
      newer database means — the constraint is a snapshot of a vocabulary, and
      replaying an old snapshot over newer rows narrows it below what is already
      there.

      So the list below is the UNION: 57's addition (`parcel_payment_received`)
      on top of the vocabulary this database already has. It is identical to the
      list migration 66 installs, which is the end state the chain reaches
      anyway once everything is applied in order. Nothing is removed, and no row
      in this table is outside it.

      If you ever replay this script on a database that does NOT have 62, 63 and
      66, this list is still correct: it is a superset, and a kind nothing writes
      is harmless.
  */
  add constraint email_outbox_kind_check
  check (kind in (
    'driver_application_approved',
    'driver_application_rejected',
    'guarantor_invitation',
    'guarantor_completed',
    'sender_verification_submitted',
    'sender_verified',
    'sender_verification_rejected',
    'delivery_completed',
    'parcel_cancelled',
    'parcel_status_changed',
    'driver_offer',
    'driver_job_cancelled',
    'payout_paid',
    'parcel_payment_received',
    'welcome',
    'password_changed'
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


-- ############################################################################
-- migration 20250101000058_admin_finance.sql
-- ############################################################################

-- Package Relay — the two sides of the money, for an operator.
--
-- Run after 57. Re-runnable.
--
-- Inbound is what senders paid us through Paystack (56). Outbound is what
-- drivers are owed and what has been sent to them (30). They have been two
-- disconnected halves of the schema with no screen over either: `parcel_payments`
-- was readable only by the sender who paid, and `payout_requests` was readable
-- by an admin but nothing asked.
--
-- ⚠ Definer functions with a fixed shape, not an `is_admin()` branch on the
--   policies, and 20250101000017_admin_parcel_detail.sql already argued why.
--
--   A policy would let an admin — or anything holding an admin's token — select
--   every column of every payment row, for ever, unlogged, with whatever query
--   they happened to write. A function returns the columns decided here. On a
--   table whose rows are money and whose neighbours are bank account numbers,
--   that difference is the whole control.
--
-- ⚠ What an operator can see, and what stays behind a second, audited call.
--
--   The ledger shows the payer's *name*, the parcel and the gateway reference —
--   enough to answer "I paid and nothing happened" and to find the same
--   transaction in Paystack's dashboard, which is keyed on that reference.
--
--   It does not show the sender's email, phone or addresses: those already have
--   a home behind `admin_reveal_parcel_contacts`, which logs who looked. And it
--   does not show a driver's bank account number — that is
--   `admin_reveal_payout_account` below, for the same reason. An account number
--   on a list view is an account number on everybody's screen all day.
--
-- ⚠ Reads are not logged, and that is deliberate rather than an omission.
--
--   17 logs the *reveal* and not the list, on the reasoning that an audit trail
--   full of entries nobody can act on is one nobody reads. Opening a ledger is
--   the ordinary work of running the platform. Asking for a bank account, or
--   settling a payout, is an act with a consequence — those are logged.

do $$
begin
  if to_regclass('public.parcel_payments') is null then
    raise exception 'Run 20250101000056_parcel_payments.sql first.';
  end if;
  if to_regclass('public.payout_requests') is null then
    raise exception 'Run 20250101000030_driver_wallet.sql first.';
  end if;
end
$$;

-- ============================================================================
-- 1. Inbound — what senders paid
-- ============================================================================

/**
 * The headline numbers for the Inbound tab.
 *
 * ⚠ Kobo throughout, converted once at the screen.
 *
 *   `parcel_payments.amount_kobo` is the stored truth and every total here is a
 *   sum of it. Dividing in five places is five chances to divide once too few —
 *   the payment confirmation email had exactly that bug caught by its harness.
 *
 * ⚠ `refunds_owed` is the number this file exists to surface.
 *
 *   `settle_parcel_payment` settles a charge that lands on a parcel cancelled
 *   mid-checkout, logs a warning to `app_events`, and stops. There is no refund
 *   path and no screen — so until now the only way to find one was to think to
 *   grep the log. It is a count of money taken for a parcel that never moved,
 *   and somebody has to look at it.
 */
create or replace function public.admin_payment_totals()
returns table (
  collected_kobo bigint,
  collected_7d_kobo bigint,
  payments_succeeded integer,
  payments_pending integer,
  payments_failed integer,
  parcels_awaiting_payment integer,
  refunds_owed integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum(p.amount_kobo) filter (where p.status = 'success'), 0)::bigint,
    coalesce(sum(p.amount_kobo) filter (
      where p.status = 'success' and p.paid_at > now() - interval '7 days'
    ), 0)::bigint,
    count(*) filter (where p.status = 'success')::integer,
    count(*) filter (where p.status = 'pending')::integer,
    count(*) filter (where p.status in ('failed', 'abandoned'))::integer,
    (select count(*) from public.bookings b where b.payment_status = 'pending')::integer,
    /*
      A settled charge whose parcel is cancelled. Counted from the rows rather
      than from the warning in `app_events`, so a purged log does not make the
      money disappear with it.
    */
    (
      select count(*)
        from public.parcel_payments pp
        join public.bookings bb on bb.id = pp.booking_id
       where pp.status = 'success' and bb.status = 'Cancelled'
    )::integer
  from public.parcel_payments p
  where public.is_admin();
$$;

/**
 * One row per charge, newest first.
 *
 * `p_status` filters on the payment's own status; null is everything. `p_query`
 * matches a reference or a tracking id, which are the two things somebody
 * arrives holding — a line on a bank statement, or a customer quoting the code
 * from their email.
 */
create or replace function public.admin_payments_ledger(
  p_status text default null,
  p_query text default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  reference text,
  gateway_reference text,
  provider text,
  amount_kobo bigint,
  currency text,
  status text,
  channel text,
  initialized_at timestamptz,
  paid_at timestamptz,
  failure_reason text,
  booking_id uuid,
  tracking_id text,
  parcel_status text,
  parcel_payment_status text,
  origin_city text,
  destination_city text,
  sender_id uuid,
  sender_name text,
  /* A settled charge against a stopped parcel. The row that needs a person. */
  refund_owed boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.reference,
    p.gateway_reference,
    p.provider,
    p.amount_kobo,
    p.currency,
    p.status,
    p.channel,
    p.initialized_at,
    p.paid_at,
    p.failure_reason,
    b.id,
    b.tracking_id,
    b.status,
    b.payment_status,
    b.origin_city,
    b.destination_city,
    p.sender_id,
    /*
      The name from `profiles`, which an admin can already read directly — 07
      adds an admin select policy on it. Repeated here so the screen is one
      round trip rather than a list plus a lookup per row.
    */
    coalesce(pr.full_name, ''),
    p.status = 'success' and b.status = 'Cancelled'
  from public.parcel_payments p
  join public.bookings b on b.id = p.booking_id
  left join public.profiles pr on pr.id = p.sender_id
  where public.is_admin()
    and (p_status is null or p.status = p_status)
    and (
      p_query is null
      or btrim(p_query) = ''
      /*
        Case-insensitive on both, because a reference is copied out of a bank
        statement and a tracking id is read aloud down a phone line. Neither
        arrives in the case it was stored in.
      */
      or p.reference ilike '%' || btrim(p_query) || '%'
      or b.tracking_id ilike '%' || btrim(p_query) || '%'
    )
  order by p.initialized_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

-- ============================================================================
-- 2. Outbound — what drivers are owed
-- ============================================================================

/**
 * One row per driver who has earned anything or asked to be paid.
 *
 * ⚠ The arithmetic is `driver_balance`'s, done set-based.
 *
 *   30's `driver_balance(target)` answers this for one driver and is the
 *   definition of record: earned is the sum of `net`, the hold subtracts
 *   anything younger than `payout_hold_hours()`, and both 'requested' and
 *   'paid' payouts count as taken — an open request is money already claimed.
 *   Calling it once per driver would be a query per row, so it is repeated
 *   here; `scripts/pg/finance-harness.mjs` asserts the two agree for every
 *   driver in the fixture, which is the only thing that keeps a copy honest.
 *
 * ⚠ `state` is derived, not stored, and 'ready' has no row anywhere.
 *
 *   `payout_requests` has rows for money a driver has *asked* for. A driver
 *   sitting on a withdrawable balance who has not asked has no row at all — so
 *   a ledger built on that table alone would show an empty screen on the day
 *   the platform owes the most. The four states:
 *
 *     pending  an open request, waiting for somebody to make the transfer
 *     ready    no request, and `available` has passed `minimum_payout()`
 *     holding  owed something, but still inside the hold or under the minimum
 *     paid     everything earned has been paid out; nothing is owed
 */
create or replace function public.admin_payout_ledger(
  p_state text default null,
  p_limit integer default 100
)
returns table (
  driver_id uuid,
  driver_name text,
  deliveries integer,
  gross numeric,
  commission numeric,
  net_earned numeric,
  paid_out numeric,
  on_hold numeric,
  available numeric,
  state text,
  open_request_id uuid,
  open_request_amount numeric,
  open_requested_at timestamptz,
  open_bank_name text,
  /* Last four digits only. The full number is an audited reveal — see below. */
  open_account_hint text,
  open_account_name text,
  last_paid_at timestamptz,
  driving_banned boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with guard as (
    select public.is_admin() as ok
  ),
  settings as (
    select
      public.payout_hold_hours() as hold_hours,
      public.minimum_payout() as minimum
  ),
  earned as (
    select
      e.driver_id,
      count(*)::integer as deliveries,
      sum(e.gross) as gross,
      sum(e.commission) as commission,
      sum(e.net) as net_earned,
      sum(e.net) filter (
        where e.earned_at > now() - ((select hold_hours from settings) || ' hours')::interval
      ) as on_hold
    from public.driver_earnings e
    group by e.driver_id
  ),
  taken as (
    select
      r.driver_id,
      /* 'requested' and 'paid' both count: an open request is already claimed. */
      coalesce(sum(r.amount) filter (where r.status in ('requested', 'paid')), 0) as paid_out,
      max(r.settled_at) filter (where r.status = 'paid') as last_paid_at
    from public.payout_requests r
    group by r.driver_id
  ),
  open_request as (
    select distinct on (r.driver_id)
      r.driver_id, r.id, r.amount, r.requested_at,
      r.bank_name, r.account_number, r.account_name
    from public.payout_requests r
    where r.status = 'requested'
    order by r.driver_id, r.requested_at desc
  ),
  rows as (
    select
      d.driver_id,
      coalesce(pr.full_name, '') as driver_name,
      coalesce(e.deliveries, 0) as deliveries,
      coalesce(e.gross, 0) as gross,
      coalesce(e.commission, 0) as commission,
      coalesce(e.net_earned, 0) as net_earned,
      coalesce(t.paid_out, 0) as paid_out,
      coalesce(e.on_hold, 0) as on_hold,
      /* Never negative, for `driver_balance`'s reason: a hold larger than the
         unpaid remainder is normal, and a negative "available" reads as debt. */
      greatest(coalesce(e.net_earned, 0) - coalesce(t.paid_out, 0) - coalesce(e.on_hold, 0), 0)
        as available,
      o.id as open_request_id,
      o.amount as open_request_amount,
      o.requested_at as open_requested_at,
      o.bank_name as open_bank_name,
      case
        when o.account_number is null then null
        else right(o.account_number, 4)
      end as open_account_hint,
      o.account_name as open_account_name,
      t.last_paid_at,
      pr.driving_banned_at is not null as driving_banned
    from (
      select driver_id from earned
      union
      select driver_id from taken
    ) d
    left join earned e on e.driver_id = d.driver_id
    left join taken t on t.driver_id = d.driver_id
    left join open_request o on o.driver_id = d.driver_id
    left join public.profiles pr on pr.id = d.driver_id
  ),
  stated as (
    select
      rows.*,
      case
        when rows.open_request_id is not null then 'pending'
        when rows.available >= (select minimum from settings) then 'ready'
        when rows.net_earned > rows.paid_out then 'holding'
        else 'paid'
      end as state
    from rows
  )
  select
    stated.driver_id, stated.driver_name, stated.deliveries,
    stated.gross, stated.commission, stated.net_earned,
    stated.paid_out, stated.on_hold, stated.available,
    stated.state,
    stated.open_request_id, stated.open_request_amount, stated.open_requested_at,
    stated.open_bank_name, stated.open_account_hint, stated.open_account_name,
    stated.last_paid_at, stated.driving_banned
  from stated, guard
  where guard.ok
    and (p_state is null or stated.state = p_state)
  /*
    Money owed first, and inside that the oldest request first.

    An operator's question is "who is waiting", not "who earned most". Sorting
    by amount would bury a small payout somebody has been waiting a week for
    under a large one raised this morning.
  */
  order by
    case stated.state
      when 'pending' then 0 when 'ready' then 1 when 'holding' then 2 else 3
    end,
    coalesce(stated.open_requested_at, now()) asc,
    stated.available desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

/**
 * One driver's earnings and payouts on a single timeline.
 *
 * The admin counterpart of 30's `my_wallet_activity`, which answers the same
 * question for the driver themselves. Two functions rather than one with a
 * target parameter, because that one is granted to every authenticated account
 * and widening it is how a driver ends up reading somebody else's payslip.
 */
create or replace function public.admin_driver_ledger(
  p_driver uuid,
  p_limit integer default 50
)
returns table (
  kind text,
  happened_at timestamptz,
  amount numeric,
  label text,
  status text,
  reference text
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from (
    select
      'earning' as kind,
      e.earned_at as happened_at,
      e.net as amount,
      'Delivered ' || coalesce(b.tracking_id, '—')
        || ' · fare ' || to_char(e.gross, 'FM999999990.00')
        || ' · fee ' || to_char(e.commission, 'FM999999990.00') as label,
      'earned' as status,
      coalesce(b.tracking_id, '') as reference
    from public.driver_earnings e
    left join public.bookings b on b.id = e.booking_id
    where e.driver_id = p_driver and public.is_admin()

    union all

    select
      'payout',
      coalesce(r.settled_at, r.requested_at),
      r.amount,
      case r.status
        when 'requested' then 'Payout requested'
        when 'paid' then 'Payout sent'
        when 'failed' then 'Payout failed'
        else 'Payout cancelled'
      end,
      r.status,
      coalesce(r.reference, r.failure_reason, '')
    from public.payout_requests r
    where r.driver_id = p_driver and public.is_admin()
  ) feed
  order by happened_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

/**
 * The bank account to send money to, and a line in the audit log naming who
 * asked.
 *
 * ⚠ A second call, exactly as `admin_reveal_parcel_contacts` is.
 *
 *   The ledger shows the last four digits, which is enough to recognise an
 *   account and useless for moving money. The full number is needed once, by
 *   the person actually making the transfer, and that moment is worth a record.
 *   Folding it into the list would put every driver's account number on screen
 *   every time somebody opened the payouts tab.
 */
create or replace function public.admin_reveal_payout_account(
  request_id uuid,
  reason text default null
)
returns table (
  bank_name text,
  account_number text,
  account_name text,
  amount numeric
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'payout', 'payout account revealed',
    jsonb_build_object('request', request_id, 'reason', nullif(btrim(coalesce(reason, '')), '')),
    auth.uid()
  );

  return query
    select r.bank_name, r.account_number, r.account_name, r.amount
      from public.payout_requests r
     where r.id = request_id;
end;
$$;

-- ------------------------------------------------------------- grants -----

/*
  Granted to `authenticated` and gated on `is_admin()` inside, which is the
  pattern every other admin function here uses. The grant lets the call through
  the API; the check decides whether it answers. A non-admin gets an empty
  result from the ledgers and an exception from the reveal.
*/
revoke all on function public.admin_payment_totals() from public, anon;
revoke all on function public.admin_payments_ledger(text, text, integer) from public, anon;
revoke all on function public.admin_payout_ledger(text, integer) from public, anon;
revoke all on function public.admin_driver_ledger(uuid, integer) from public, anon;
revoke all on function public.admin_reveal_payout_account(uuid, text) from public, anon;

grant execute on function public.admin_payment_totals() to authenticated;
grant execute on function public.admin_payments_ledger(text, text, integer) to authenticated;
grant execute on function public.admin_payout_ledger(text, integer) to authenticated;
grant execute on function public.admin_driver_ledger(uuid, integer) to authenticated;
grant execute on function public.admin_reveal_payout_account(uuid, text) to authenticated;

notify pgrst, 'reload schema';


-- ############################################################################
-- migration 20250101000059_support_tickets.sql
-- ############################################################################

-- ============================================================================
-- 20250101000059_support_tickets.sql — the support queue, and the thread under it
-- ============================================================================
--
-- Run after 01–58. Re-runnable.
--
-- Support arrives today as an email to support@pkrelay.ng and a phone call, and
-- both of those are somebody's inbox and somebody's memory. This migration is
-- the record: one row per inquiry, one thread per row, and a status an operator
-- moves through Open → In Progress → Waiting on customer → Resolved.
--
-- ⚠ Four statuses, not three, and the fourth is the one that earns its keep.
--
--   "Waiting on customer" is where a ticket sits when the next move is not
--   ours. Without it those tickets live in In Progress, and the two numbers an
--   operator actually needs — how many are waiting on *us*, and how long the
--   oldest has waited — become meaningless the first busy week. Adding it later
--   means a new migration to widen a check constraint on a live table, so it is
--   here from the start.
--
-- ⚠ No admin select policy on either table. Same call as 49.
--
--   The thread carries internal notes ("the driver says the recipient's number
--   is dead, do not refund yet") and free text a customer typed, which is the
--   one place in this schema where a phone number or an address can arrive
--   without a column to put it in. A blanket admin read policy would expose all
--   of it through PostgREST to any phished admin session. Everything an
--   operator sees comes from a `security definer` function that checks
--   `is_admin()` and returns a fixed shape.
--
-- ⚠ Internal notes are a `visibility` column, not a second table.
--
--   Two tables means two inserts to order correctly, two policies to keep in
--   step, and a merge in the client to get one chronological thread — and the
--   thread *is* the product here. One table with a check constraint that
--   forbids a customer authoring an internal note keeps the ordering free and
--   the mistake impossible.
--
-- ⚠ The notification kind is the existing `message_received`.
--
--   49's `kind` check constraint is in a pushed migration and already carries
--   exactly the right value. Widening it for `support_reply` would mean
--   altering a constraint on the busiest table in the schema to say a second
--   word for one concept — 49 argued that case for `kind` vs `type` and the
--   answer has not changed.
--
-- Applies cleanly on a project that has never had support tickets. Nothing here
-- alters an existing table; the one trigger it adds is on `profiles`, and it
-- only fires on erasure.

do $$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'Run 20250101000001_bookings.sql first.';
  end if;

  if to_regclass('public.notifications') is null then
    raise exception 'Run 20250101000049_notifications.sql first.';
  end if;

  if to_regprocedure('public.is_admin()') is null then
    raise exception 'Run 20250101000002_driver_applications.sql first.';
  end if;
end
$$;

-- --------------------------------------------------------------- reference --

/*
 * The human-readable handle: PKR-S-00001.
 *
 * A sequence rather than a random string, because this number is read down a
 * phone line. "Your reference is PKR-S-00412" survives a bad connection;
 * "pkr_t8v2qh" does not. It leaks the ticket count, which is not a secret worth
 * paying for a worse support call.
 */
create sequence if not exists public.support_ticket_reference_seq;

-- ------------------------------------------------------------- the tickets --

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),

  reference text not null unique
    default ('PKR-S-' || lpad(nextval('public.support_ticket_reference_seq')::text, 5, '0')),

  /*
   * Whose problem this is — always the customer or driver, never the admin who
   * typed it in.
   *
   * ⚠ This is the column the whole screen hangs off, so it does not shift
   *   meaning for a phone call. An admin logging an inquiry picks the account
   *   it belongs to and lands here; who did the typing is `opened_by_admin_id`.
   *   The tempting shortcut — requester is "whoever created the row" — puts the
   *   admin's own id on a quarter of the queue, and then "every ticket this
   *   person has ever raised" silently answers a different question.
   *
   * `on delete cascade` for 49's reason: this thread is free text about a
   * person, and an inbox left behind after the login is gone is a leak with no
   * owner.
   */
  requester_id uuid not null references auth.users (id) on delete cascade,

  /** Set when an admin logged this on someone's behalf. Null for self-serve. */
  opened_by_admin_id uuid references auth.users (id) on delete set null,

  /*
   * How it arrived. Checked, because "app" and "in-app" and "mobile" would
   * otherwise all appear in the same column within a month and the only
   * question this column answers — is the in-app form actually being used —
   * would need a `group by` nobody trusts.
   */
  channel text not null default 'app' check (channel in ('app', 'phone', 'email')),

  category text not null default 'other' check (category in (
    'parcel',
    'payment',
    'driver_application',
    'account',
    'other'
  )),

  subject text not null check (btrim(subject) <> ''),

  /*
   * The parcel this is about, when it is about a parcel.
   *
   * ⚠ Both columns, and they are not redundant.
   *
   *   `booking_id` is the live link an operator follows into the parcel drawer;
   *   it goes null if the parcel is ever removed. `booking_tracking_id` is the
   *   string the customer quoted, snapshotted at intake — so a resolved ticket
   *   still says which parcel it was about, which is the whole value of the
   *   record six months later. 49 snapshots its metadata for the same reason.
   */
  booking_id uuid references public.bookings (id) on delete set null,
  booking_tracking_id text,

  status text not null default 'open' check (status in (
    'open',
    'in_progress',
    'waiting_on_customer',
    'resolved'
  )),
  status_changed_at timestamptz not null default now(),

  /** Who owns it. Null is unassigned, which is a state and not a mistake. */
  assigned_admin_id uuid references auth.users (id) on delete set null,

  /*
   * When somebody first answered, and the timestamp is the metric.
   *
   * Set once, by the first *public* admin reply. An internal note is not an
   * answer, and counting one as a first response is how a support team ends up
   * reporting a median response time of four minutes while nobody outside the
   * building has heard anything.
   */
  first_response_at timestamptz,

  /*
   * The last thing said, and which side said it.
   *
   * Maintained by the reply functions rather than derived with a lateral join
   * on every queue load: this is the column the list sorts on and the one that
   * answers "is the ball in our court", and a queue that scans the whole
   * message table to sort itself gets slower every week it works.
   */
  last_message_at timestamptz not null default now(),
  last_message_from text not null default 'customer'
    check (last_message_from in ('customer', 'admin')),

  /** What we told them we did. Required to resolve; cleared if it reopens. */
  resolution text,
  resolved_at timestamptz,

  created_at timestamptz not null default now(),

  /*
   * Resolved and `resolved_at` move together, in both directions.
   *
   * The half that matters is the reverse one: reopening a ticket without
   * clearing `resolved_at` leaves a row that is open and also closed, and every
   * count built on either column disagrees with the other from then on.
   */
  constraint support_resolution_consistent check (
    (status = 'resolved') = (resolved_at is not null)
  )
);

comment on table public.support_tickets is
  'One customer or driver support inquiry. Written only by security-definer functions; a requester reads their own rows, an admin reads through admin_support_* RPCs.';

-- ------------------------------------------------------------ the messages --

create table if not exists public.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),

  ticket_id uuid not null references public.support_tickets (id) on delete cascade,

  /*
   * `on delete set null`, unlike the ticket's cascade.
   *
   * A reply is part of the thread's meaning — "we told them to collect from the
   * hub on Tuesday" has to survive the admin who wrote it leaving. The name is
   * resolved at read time from `profiles`, so a null author reads as "Package
   * Relay" rather than as a gap.
   */
  author_id uuid references auth.users (id) on delete set null,

  author_role text not null check (author_role in ('customer', 'admin')),

  visibility text not null check (visibility in ('public', 'internal')),

  body text not null check (btrim(body) <> ''),

  created_at timestamptz not null default now(),

  /*
   * ⚠ A customer cannot author an internal note.
   *
   *   Not a hypothetical: the reply functions both take a body and a
   *   visibility, and one transposed argument would file a customer's own
   *   message where they can never see it again — a thread that silently loses
   *   half of itself, with no error anywhere. The constraint makes that a write
   *   failure instead of a support mystery.
   */
  constraint support_internal_is_staff_only check (
    author_role = 'admin' or visibility = 'public'
  )
);

comment on table public.support_ticket_messages is
  'One entry in a support thread. visibility = internal is staff-only; a customer may only author public messages.';

-- ---------------------------------------------------------------- indexes --

/* The queue: one status, oldest movement first. */
create index if not exists support_tickets_queue_idx
  on public.support_tickets (status, last_message_at asc);

/* A person's own list, and the rate limit's count. */
create index if not exists support_tickets_requester_idx
  on public.support_tickets (requester_id, created_at desc);

/* "Is there a ticket open on this parcel", asked from the parcel drawer. */
create index if not exists support_tickets_booking_idx
  on public.support_tickets (booking_id)
  where booking_id is not null;

/* One admin's workload. Partial: most tickets are unassigned. */
create index if not exists support_tickets_assigned_idx
  on public.support_tickets (assigned_admin_id, last_message_at asc)
  where assigned_admin_id is not null;

/* The thread, in order. The only query the message table ever serves. */
create index if not exists support_ticket_messages_thread_idx
  on public.support_ticket_messages (ticket_id, created_at asc);

-- -------------------------------------------------------------------- RLS --

alter table public.support_tickets enable row level security;
alter table public.support_ticket_messages enable row level security;

/*
 * Own tickets only. `(select auth.uid())` is 48's initplan wrap — evaluated
 * once per statement rather than once per row.
 */
drop policy if exists "own support tickets" on public.support_tickets;
create policy "own support tickets"
  on public.support_tickets for select
  to authenticated
  using (requester_id = (select auth.uid()));

/*
 * Own thread, public entries only.
 *
 * ⚠ The `visibility` test is first for a reason beyond taste: it is the
 *   cheapest condition and the one that must never be reachable around. An
 *   internal note is written on the assumption that the customer cannot read
 *   it, and a policy that leaked them would turn every honest operational note
 *   into a disclosure.
 */
drop policy if exists "own support messages" on public.support_ticket_messages;
create policy "own support messages"
  on public.support_ticket_messages for select
  to authenticated
  using (
    visibility = 'public'
    and exists (
      select 1
        from public.support_tickets t
       where t.id = support_ticket_messages.ticket_id
         and t.requester_id = (select auth.uid())
    )
  );

/*
 * ⚠ No insert, update or delete policy on either table, deliberately.
 *
 *   A client that could insert into `support_tickets` could set its own
 *   `status`, `first_response_at` and `reference` — which turns the queue's
 *   response-time numbers into whatever the client says they are. A client that
 *   could insert a message could set `author_role = 'admin'` and write a reply
 *   from Package Relay into their own thread. Both go through the functions
 *   below, which decide those columns themselves.
 */

-- ======================================================================== --
--                       telling the other side                             --
-- ======================================================================== --

/*
 * Notifies every admin about a ticket.
 *
 * ⚠ Every admin, not the assignee.
 *
 *   A new ticket has no assignee by definition, and the state this exists to
 *   prevent is a ticket nobody looks at because it arrived while the one person
 *   watching the queue was asleep. 49's unique key means one row per admin per
 *   subject, so a re-run cannot spam anybody.
 *
 * Internal. Callers are the functions below; nothing grants this to a client.
 */
create or replace function public.notify_support_admins(
  p_subject_id text,
  p_title text,
  p_body text,
  p_metadata jsonb default '{}'::jsonb,
  p_exclude uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_row record;
  queued integer := 0;
begin
  for admin_row in
    select p.id
      from public.profiles p
     where p.is_admin
       and p.deleted_at is null
       /*
        * Never notify the person who just acted. An operator who resolves a
        * ticket does not need a push telling them it was resolved, and a badge
        * that lights up for your own actions is a badge people stop reading.
        */
       and (p_exclude is null or p.id <> p_exclude)
  loop
    if public.queue_notification(
         admin_row.id, 'message_received', p_subject_id,
         p_title, p_body, coalesce(p_metadata, '{}'::jsonb), true
       ) is not null
    then
      queued := queued + 1;
    end if;
  end loop;

  return queued;
end;
$$;

-- ======================================================================== --
--                         the customer's side                              --
-- ======================================================================== --

/*
 * Opens a ticket, with its first message.
 *
 * ⚠ One call, one transaction, both rows. A ticket with no message is a subject
 *   line and nothing to act on, and the two-call version leaves one behind
 *   every time the network drops between them.
 */
create or replace function public.create_support_ticket(
  p_subject text,
  p_body text,
  p_category text default 'other',
  p_booking_id uuid default null
)
returns table (id uuid, reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  tracking text;
  ticket public.support_tickets;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  /*
   * An erased account cannot open a ticket.
   *
   * Its login still works — erasure blocks the policies, not the sign-in — and
   * a thread started from one would be free text attached to a person whose
   * data has already been destroyed on request.
   */
  if public.is_erased() then
    raise exception 'This account is closed. Email support instead.';
  end if;

  if btrim(coalesce(p_subject, '')) = '' then
    raise exception 'Give the ticket a subject so it can be found again.';
  end if;

  /*
   * Ten characters. Not arbitrary: "help" and "?" are the two most common
   * things typed into a support box, and both cost an operator a full
   * round trip to learn nothing.
   */
  if length(btrim(coalesce(p_body, ''))) < 10 then
    raise exception 'Tell us what happened — a few more words, so somebody can act on it.';
  end if;

  /*
   * The parcel link, verified against the caller.
   *
   * ⚠ This is an access check, not a convenience. `booking_id` is a uuid the
   *   client sends; without this, a ticket could be attached to a stranger's
   *   parcel, and the admin screen would then show that stranger's tracking id
   *   and route beside somebody else's name. A driver carrying it counts as
   *   theirs — a driver's support question is almost always about a job.
   */
  if p_booking_id is not null then
    select b.tracking_id into tracking
      from public.bookings b
     where b.id = p_booking_id
       and (b.sender_id = actor or b.driver_id = actor);

    if tracking is null then
      raise exception 'That parcel is not on your account.';
    end if;
  end if;

  /*
   * Five an hour.
   *
   * High enough that nobody legitimately hits it — a person with three
   * problems opens three tickets — and low enough that a retry loop in a
   * client cannot bury the queue before anybody notices.
   */
  if (
    select count(*)
      from public.support_tickets t
     where t.requester_id = actor
       and t.created_at > now() - interval '1 hour'
  ) >= 5 then
    raise exception 'You have opened several tickets in the last hour. Add to one of those instead.';
  end if;

  insert into public.support_tickets
    (requester_id, channel, category, subject, booking_id, booking_tracking_id,
     last_message_at, last_message_from)
  values (
    actor,
    'app',
    coalesce(nullif(btrim(p_category), ''), 'other'),
    btrim(p_subject),
    p_booking_id,
    tracking,
    now(),
    'customer'
  )
  returning * into ticket;

  insert into public.support_ticket_messages
    (ticket_id, author_id, author_role, visibility, body)
  values (ticket.id, actor, 'customer', 'public', btrim(p_body));

  /*
   * Logged as info, with no message body.
   *
   * `app_events` is readable by every admin and 07 says in so many words that
   * `context` must not carry personal data. What the customer wrote is
   * personal data; that a ticket exists is not.
   */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info',
    'support',
    'support ticket opened',
    jsonb_build_object('ticket', ticket.id, 'reference', ticket.reference,
                       'category', ticket.category, 'channel', 'app'),
    actor
  );

  perform public.notify_support_admins(
    ticket.id::text,
    'New support ticket: ' || ticket.reference,
    left(btrim(p_subject), 140),
    jsonb_build_object('ticket_id', ticket.id, 'reference', ticket.reference,
                       'category', ticket.category),
    actor
  );

  return query select ticket.id, ticket.reference;
end;
$$;

/*
 * The customer's reply.
 *
 * ⚠ A reply to a resolved ticket reopens it, and that is the point.
 *
 *   "That did not fix it" is the single most important thing a support system
 *   can hear, and the alternative is the customer opening a second ticket that
 *   nobody connects to the first. Reopening clears the resolution as well as
 *   the timestamp: a stale "we refunded you" sitting on an open ticket is worse
 *   than no note at all.
 */
create or replace function public.reply_support_ticket(p_ticket uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  ticket public.support_tickets;
  message_id uuid;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'Nothing to send.';
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket
     and t.requester_id = actor;

  if ticket.id is null then
    raise exception 'No such ticket';
  end if;

  insert into public.support_ticket_messages
    (ticket_id, author_id, author_role, visibility, body)
  values (p_ticket, actor, 'customer', 'public', btrim(p_body))
  returning id into message_id;

  update public.support_tickets
     set last_message_at = now(),
         last_message_from = 'customer',
         /*
          * Back into our court, from either of the two states where it was not.
          * `in_progress` is left alone — somebody is already on it, and moving
          * it backwards would take it off their screen.
          */
         status = case status
                    when 'waiting_on_customer' then 'open'
                    when 'resolved' then 'open'
                    else status
                  end,
         status_changed_at = case
                               when status in ('waiting_on_customer', 'resolved')
                               then now() else status_changed_at
                             end,
         resolved_at = null,
         resolution = case when status = 'resolved' then null else resolution end
   where id = p_ticket;

  /*
   * The assignee if there is one, everybody otherwise.
   *
   * An assigned ticket is somebody's job and telling the other three admins
   * about every reply on it is how a team learns to ignore the badge.
   */
  if ticket.assigned_admin_id is not null then
    perform public.queue_notification(
      ticket.assigned_admin_id, 'message_received', message_id::text,
      'Reply on ' || ticket.reference,
      left(btrim(p_body), 140),
      jsonb_build_object('ticket_id', p_ticket, 'reference', ticket.reference),
      true
    );
  else
    perform public.notify_support_admins(
      message_id::text,
      'Reply on ' || ticket.reference,
      left(btrim(p_body), 140),
      jsonb_build_object('ticket_id', p_ticket, 'reference', ticket.reference),
      actor
    );
  end if;

  return message_id;
end;
$$;

-- ======================================================================== --
--                           the admin's side                               --
-- ======================================================================== --

/*
 * The tiles at the top of the queue.
 *
 * ⚠ `awaiting_us` is not `open`.
 *
 *   A ticket can be In Progress and still be waiting on an answer from us, and
 *   an Open one whose last message was ours is not. The number an operator
 *   needs before lunch is "how many people are waiting to hear back", which is
 *   the last message's direction — not the status somebody last clicked.
 *
 * Aggregates only, 07's habit: counting tickets does not require handing
 * anybody the text inside them.
 */
create or replace function public.admin_support_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  select jsonb_build_object(
    'open', count(*) filter (where status = 'open'),
    'in_progress', count(*) filter (where status = 'in_progress'),
    'waiting_on_customer', count(*) filter (where status = 'waiting_on_customer'),
    'resolved', count(*) filter (where status = 'resolved'),
    'resolved_last_7_days', count(*) filter (
      where status = 'resolved' and resolved_at > now() - interval '7 days'
    ),
    'awaiting_us', count(*) filter (
      where status <> 'resolved' and last_message_from = 'customer'
    ),
    /*
      Never answered at all, which is a different failure from slow.

      A ticket with no first response is one nobody has spoken to; it is the
      only count on this screen that should be zero every evening.
    */
    'unanswered', count(*) filter (
      where status <> 'resolved' and first_response_at is null
    ),
    'oldest_waiting_hours', coalesce(
      round(
        extract(epoch from (
          now() - min(last_message_at) filter (
            where status <> 'resolved' and last_message_from = 'customer'
          )
        )) / 3600.0
      , 1),
      0
    ),
    'unassigned', count(*) filter (
      where status <> 'resolved' and assigned_admin_id is null
    )
  )
  into result
  from public.support_tickets;

  return result;
end;
$$;

/*
 * The queue itself.
 *
 * ⚠ No phone number and no address in the returned shape, even though this is
 *   a support screen and the operator is about to ring somebody.
 *
 *   17 made that call for parcels and the reason holds here: contact details
 *   come from `admin_reveal_parcel_contacts`, which writes an audit line naming
 *   who looked. A queue that printed a phone number on every row would put a
 *   hundred customers' numbers on screen to answer one of them, and would fill
 *   the audit log with entries nobody could act on.
 *
 *   The search *does* match a phone number, which is not a contradiction: the
 *   operator typing it already has it — somebody is on the line — and matching
 *   it is the difference between finding their ticket and asking them to spell
 *   a reference.
 */
create or replace function public.admin_support_queue(
  p_status text default 'all',
  p_search text default null,
  p_max_rows integer default 50
)
returns table (
  id uuid,
  reference text,
  status text,
  category text,
  channel text,
  subject text,
  requester_id uuid,
  requester_name text,
  requester_is_driver boolean,
  booking_id uuid,
  booking_tracking_id text,
  assigned_admin_id uuid,
  assigned_admin_name text,
  first_response_at timestamptz,
  last_message_at timestamptz,
  last_message_from text,
  message_count integer,
  created_at timestamptz,
  resolved_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  needle text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  return query
    select
      t.id,
      t.reference,
      t.status,
      t.category,
      t.channel,
      t.subject,
      t.requester_id,
      coalesce(nullif(btrim(requester.full_name), ''), 'Unnamed account')::text,
      /*
        Whether this person drives, so the queue can say which side of the
        marketplace is asking. A driver's "where is my money" and a sender's
        are different tickets with the same words in them.
      */
      exists (
        select 1
          from public.driver_applications a
         where a.user_id = t.requester_id
           and a.status = 'approved'
      ),
      t.booking_id,
      t.booking_tracking_id,
      t.assigned_admin_id,
      nullif(btrim(coalesce(assignee.full_name, '')), '')::text,
      t.first_response_at,
      t.last_message_at,
      t.last_message_from,
      (select count(*)::integer
         from public.support_ticket_messages m
        where m.ticket_id = t.id),
      t.created_at,
      t.resolved_at
    from public.support_tickets t
    left join public.profiles requester on requester.id = t.requester_id
    left join public.profiles assignee on assignee.id = t.assigned_admin_id
    where
      (
        p_status is null
        or p_status = 'all'
        /*
          'awaiting_us' is a filter, not a status.

          It is the queue's default view in the client — everything where the
          customer spoke last and nobody has answered — and it crosses three
          statuses. Expressing it as a status would have meant a fifth value in
          the check constraint that no operator ever sets by hand.
        */
        or (p_status = 'awaiting_us'
            and t.status <> 'resolved'
            and t.last_message_from = 'customer')
        or (p_status = 'unresolved' and t.status <> 'resolved')
        or t.status = p_status
      )
      and (
        needle is null
        or t.reference ilike '%' || needle || '%'
        or t.subject ilike '%' || needle || '%'
        or coalesce(t.booking_tracking_id, '') ilike '%' || needle || '%'
        or coalesce(requester.full_name, '') ilike '%' || needle || '%'
        or coalesce(requester.phone, '') ilike '%' || needle || '%'
      )
    /*
      Oldest movement first, and resolved ones last however recent.

      An operator opening this screen is looking for the person who has waited
      longest, the same argument 17 makes for the parcel list. Sorting by
      `created_at` instead would bury a two-week-old ticket that has been
      argued over twenty times under a fresh one nobody has read.
    */
    order by
      (t.status = 'resolved'),
      t.last_message_at asc
    limit greatest(1, least(coalesce(p_max_rows, 50), 200));
end;
$$;

/*
 * One ticket, in full. Same shape as a queue row plus the resolution text.
 *
 * A second call rather than widening the list, because `resolution` is prose
 * that only means anything next to the thread it belongs to.
 */
create or replace function public.admin_support_ticket(p_ticket uuid)
returns table (
  id uuid,
  reference text,
  status text,
  category text,
  channel text,
  subject text,
  requester_id uuid,
  requester_name text,
  requester_is_driver boolean,
  booking_id uuid,
  booking_tracking_id text,
  assigned_admin_id uuid,
  assigned_admin_name text,
  opened_by_admin_name text,
  first_response_at timestamptz,
  last_message_at timestamptz,
  last_message_from text,
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz,
  status_changed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  return query
    select
      t.id, t.reference, t.status, t.category, t.channel, t.subject,
      t.requester_id,
      coalesce(nullif(btrim(requester.full_name), ''), 'Unnamed account')::text,
      exists (
        select 1 from public.driver_applications a
         where a.user_id = t.requester_id and a.status = 'approved'
      ),
      t.booking_id, t.booking_tracking_id,
      t.assigned_admin_id,
      nullif(btrim(coalesce(assignee.full_name, '')), '')::text,
      nullif(btrim(coalesce(opener.full_name, '')), '')::text,
      t.first_response_at, t.last_message_at, t.last_message_from,
      t.resolution, t.resolved_at, t.created_at, t.status_changed_at
    from public.support_tickets t
    left join public.profiles requester on requester.id = t.requester_id
    left join public.profiles assignee on assignee.id = t.assigned_admin_id
    left join public.profiles opener on opener.id = t.opened_by_admin_id
    where t.id = p_ticket;
end;
$$;

/*
 * The thread, internal notes included.
 *
 * ⚠ The one function in this file whose output a customer must never see, which
 *   is why it is a definer function with an `is_admin()` gate rather than a
 *   widened RLS policy. The policy above cannot return an internal note; this
 *   is the only thing that can, and it is reachable exactly one way.
 */
create or replace function public.admin_support_messages(p_ticket uuid)
returns table (
  id uuid,
  author_id uuid,
  author_name text,
  author_role text,
  visibility text,
  body text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  return query
    select
      m.id,
      m.author_id,
      /*
        A departed admin reads as the company, not as a blank.

        `author_id` is `on delete set null`, so this is the ordinary state for
        any reply older than the person who wrote it.
      */
      coalesce(
        nullif(btrim(coalesce(author.full_name, '')), ''),
        case when m.author_role = 'admin' then 'Package Relay' else 'Unnamed account' end
      )::text,
      m.author_role,
      m.visibility,
      m.body,
      m.created_at
    from public.support_ticket_messages m
    left join public.profiles author on author.id = m.author_id
    where m.ticket_id = p_ticket
    order by m.created_at asc;
end;
$$;

/*
 * An admin's reply, public or internal.
 *
 * ⚠ A public reply moves an Open ticket to In Progress, and nothing else moves
 *   on its own.
 *
 *   That one transition is safe — answering something is starting work on it —
 *   and it saves the operator a click they would otherwise forget, which is how
 *   a queue fills up with Open tickets that have all been answered. Resolving
 *   stays manual, because only a person knows whether the answer worked.
 */
create or replace function public.admin_reply_support_ticket(
  p_ticket uuid,
  p_body text,
  p_internal boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  ticket public.support_tickets;
  message_id uuid;
  internal boolean := coalesce(p_internal, false);
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can reply to a support ticket';
  end if;

  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'Nothing to send.';
  end if;

  select * into ticket from public.support_tickets t where t.id = p_ticket;

  if ticket.id is null then
    raise exception 'No such ticket';
  end if;

  insert into public.support_ticket_messages
    (ticket_id, author_id, author_role, visibility, body)
  values (
    p_ticket, actor, 'admin',
    case when internal then 'internal' else 'public' end,
    btrim(p_body)
  )
  returning id into message_id;

  /*
   * An internal note leaves every dated column alone.
   *
   * `last_message_at` drives the queue's sort and `first_response_at` is the
   * response-time metric; letting a note nobody outside the building can read
   * touch either one would make a ticket look answered and drop it down the
   * queue, which is precisely the ticket that then goes cold.
   */
  if not internal then
    update public.support_tickets
       set last_message_at = now(),
           last_message_from = 'admin',
           first_response_at = coalesce(first_response_at, now()),
           status = case when status = 'open' then 'in_progress' else status end,
           status_changed_at = case when status = 'open' then now() else status_changed_at end
     where id = p_ticket;

    perform public.queue_notification(
      ticket.requester_id, 'message_received', message_id::text,
      'Package Relay replied to ' || ticket.reference,
      left(btrim(p_body), 140),
      jsonb_build_object('ticket_id', p_ticket, 'reference', ticket.reference),
      true
    );
  end if;

  return message_id;
end;
$$;

/*
 * Moves a ticket.
 *
 * ⚠ Resolving requires a note, and the note goes to the customer.
 *
 *   A ticket closed with no explanation is indistinguishable, from the outside,
 *   from one that was ignored — and from the inside, six months later, from one
 *   nobody can remember the outcome of. So the note is written into the thread
 *   as a public reply and pushed, rather than filed where only staff can read
 *   it. Every other transition is internal bookkeeping and stays silent.
 */
create or replace function public.admin_set_support_status(
  p_ticket uuid,
  p_status text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  ticket public.support_tickets;
  note text := btrim(coalesce(p_note, ''));
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change a support ticket';
  end if;

  if p_status not in ('open', 'in_progress', 'waiting_on_customer', 'resolved') then
    raise exception 'Unknown status: %', p_status;
  end if;

  select * into ticket from public.support_tickets t where t.id = p_ticket;

  if ticket.id is null then
    raise exception 'No such ticket';
  end if;

  if p_status = 'resolved' and length(note) < 4 then
    raise exception 'Say what resolved it — the customer is sent this note.';
  end if;

  if p_status = 'resolved' then
    update public.support_tickets
       set status = 'resolved',
           status_changed_at = now(),
           resolved_at = now(),
           resolution = note,
           last_message_at = now(),
           last_message_from = 'admin',
           first_response_at = coalesce(first_response_at, now())
     where id = p_ticket;

    insert into public.support_ticket_messages
      (ticket_id, author_id, author_role, visibility, body)
    values (p_ticket, actor, 'admin', 'public', note);

    perform public.queue_notification(
      ticket.requester_id, 'message_received', p_ticket::text || ':resolved',
      'Your support ticket ' || ticket.reference || ' is resolved',
      left(note, 140),
      jsonb_build_object('ticket_id', p_ticket, 'reference', ticket.reference),
      true
    );
  else
    update public.support_tickets
       set status = p_status,
           status_changed_at = now(),
           /* Reopening: the constraint and the stale note both have to go. */
           resolved_at = null,
           resolution = case when ticket.status = 'resolved' then null else resolution end
     where id = p_ticket;

    /* An internal note, when one was given. Optional outside resolving. */
    if length(note) > 0 then
      insert into public.support_ticket_messages
        (ticket_id, author_id, author_role, visibility, body)
      values (p_ticket, actor, 'admin', 'internal', note);
    end if;
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info',
    'support',
    'support ticket status changed',
    jsonb_build_object('ticket', p_ticket, 'reference', ticket.reference,
                       'from', ticket.status, 'to', p_status),
    actor
  );
end;
$$;

/*
 * Assign, reassign, or hand it back to the pile.
 *
 * `p_admin` null unassigns. Assigning to somebody who is not an admin is
 * refused rather than silently ignored: an assignee who cannot open the queue
 * is a ticket that has been quietly taken off everybody's screen.
 */
create or replace function public.admin_assign_support_ticket(
  p_ticket uuid,
  p_admin uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can assign a support ticket';
  end if;

  if p_admin is not null
     and not coalesce((select p.is_admin from public.profiles p where p.id = p_admin), false)
  then
    raise exception 'That person is not an administrator.';
  end if;

  update public.support_tickets
     set assigned_admin_id = p_admin
   where id = p_ticket;

  if not found then
    raise exception 'No such ticket';
  end if;
end;
$$;

/*
 * Logs an inquiry that arrived by phone or email.
 *
 * ⚠ The first message is filed as an internal note authored by the admin, not
 *   as the customer's own words.
 *
 *   Because it is not their words — it is an operator's summary of a phone
 *   call, and attributing it to the customer would put a sentence in their
 *   mouth inside the record we would rely on in a dispute. The customer sees
 *   the ticket and every public reply on it; what they do not see is somebody
 *   else's paraphrase of what they said.
 */
/*
 * ⚠ Dropped first, because an earlier cut of this file had one fewer argument.
 *
 *   `create or replace` with a changed signature makes an *overload*, not a
 *   replacement, and two overloads that differ by one defaulted argument make
 *   every call ambiguous — PostgREST included. Re-running this file on a project
 *   that applied the earlier version has to remove that one.
 */
drop function if exists public.admin_create_support_ticket(uuid, text, text, text, text, uuid);

create or replace function public.admin_create_support_ticket(
  p_requester uuid,
  p_subject text,
  p_body text,
  p_category text default 'other',
  p_channel text default 'phone',
  p_booking_id uuid default null,
  /*
   * The tracking id, because that is what an operator has.
   *
   * ⚠ A person on the phone reads out "PKR-4F2K9", never a uuid. Taking only
   *   `booking_id` here would mean the parcel link — the thing that makes this
   *   ticket findable from the parcel and the parcel readable from the ticket —
   *   could only ever be set by the in-app form, and every phoned-in ticket
   *   would arrive unlinked. Resolved against the requester below, so a mistyped
   *   id that happens to exist cannot attach a stranger's parcel.
   */
  p_tracking_id text default null
)
returns table (id uuid, reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  tracking text;
  booking_uuid uuid := p_booking_id;
  ticket public.support_tickets;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can log a support ticket';
  end if;

  if p_requester is null
     or not exists (select 1 from public.profiles p where p.id = p_requester)
  then
    raise exception 'Pick the account this is about.';
  end if;

  if btrim(coalesce(p_subject, '')) = '' then
    raise exception 'Give the ticket a subject so it can be found again.';
  end if;

  if coalesce(p_channel, '') not in ('phone', 'email', 'app') then
    raise exception 'Unknown channel: %', p_channel;
  end if;

  /*
   * The parcel has to belong to the person the ticket is about — the same check
   * the self-serve path makes, against the requester rather than the caller.
   * An operator typing a tracking id from a phone call gets the digits wrong
   * sometimes, and a mistyped one that happens to exist would attach a
   * stranger's parcel to this thread.
   */
  if p_booking_id is not null then
    select b.tracking_id into tracking
      from public.bookings b
     where b.id = p_booking_id
       and (b.sender_id = p_requester or b.driver_id = p_requester);

    if tracking is null then
      raise exception 'That parcel is not on that account.';
    end if;

  elsif nullif(btrim(coalesce(p_tracking_id, '')), '') is not null then
    /*
      Case-insensitively, because a tracking id is read down a phone line and
      typed back by hand. `tracking_id` is unique, so this matches one row or
      none.
    */
    select b.id, b.tracking_id into booking_uuid, tracking
      from public.bookings b
     where upper(b.tracking_id) = upper(btrim(p_tracking_id))
       and (b.sender_id = p_requester or b.driver_id = p_requester);

    if tracking is null then
      raise exception 'No parcel on that account has the tracking ID %.', btrim(p_tracking_id);
    end if;
  end if;

  insert into public.support_tickets
    (requester_id, opened_by_admin_id, channel, category, subject,
     booking_id, booking_tracking_id, last_message_at, last_message_from)
  values (
    p_requester, actor, coalesce(p_channel, 'phone'),
    coalesce(nullif(btrim(p_category), ''), 'other'),
    btrim(p_subject), booking_uuid, tracking, now(),
    /*
      'customer', because they are the ones waiting.

      The queue's "awaiting us" count is the last message's direction, and a
      phoned-in ticket is by definition something a customer is waiting on an
      answer for. Recording the intake note as ours would hide it from the one
      view an operator works from.
    */
    'customer'
  )
  returning * into ticket;

  if length(btrim(coalesce(p_body, ''))) > 0 then
    insert into public.support_ticket_messages
      (ticket_id, author_id, author_role, visibility, body)
    values (ticket.id, actor, 'admin', 'internal', btrim(p_body));
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info',
    'support',
    'support ticket logged by an admin',
    jsonb_build_object('ticket', ticket.id, 'reference', ticket.reference,
                       'subject_account', p_requester, 'channel', p_channel),
    actor
  );

  return query select ticket.id, ticket.reference;
end;
$$;

-- ======================================================================== --
--                             erasure                                      --
-- ======================================================================== --

/*
 * Scrubs the threads of an erased account.
 *
 * ⚠ A trigger on `profiles.deleted_at`, not an edit to `erase_person`.
 *
 *   `erase_person` lives in 33, a pushed migration, and it is 160 lines of
 *   statements each of which exists because something leaked. Recreating it
 *   here to append two deletes would mean retyping all of it — and this
 *   codebase's most repeated failure, called out in CLAUDE.md, is recreating
 *   something verbatim and quietly dropping one of its conditions.
 *
 *   Setting `profiles.deleted_at` is the last thing an erasure does and the
 *   only thing that does it (09 forbids a client from touching that column), so
 *   the transition null → not null is exactly the hook, and it cannot drift
 *   out of step with a function this file never edits.
 *
 * ⚠ The shell stays, the content goes.
 *
 *   That an account raised four tickets and had them resolved is operational
 *   history — the same argument 33 makes for keeping `driver_earnings` and the
 *   payout rows. What they typed is not: a support thread is the one place in
 *   this schema where an address or a phone number arrives as prose, and no
 *   column constraint can stop it.
 */
create or replace function public.scrub_support_tickets_on_erase()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.support_ticket_messages m
   where m.ticket_id in (
     select t.id from public.support_tickets t where t.requester_id = new.id
   );

  update public.support_tickets
     set subject = 'Removed',
         /* Staff prose about a person is still about that person. */
         resolution = case when resolution is null then null else 'Removed' end
   where requester_id = new.id;

  return new;
end;
$$;

drop trigger if exists scrub_support_on_erase on public.profiles;
create trigger scrub_support_on_erase
  after update of deleted_at on public.profiles
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.scrub_support_tickets_on_erase();

-- ======================================================================== --
--                              grants                                      --
-- ======================================================================== --

/*
 * ⚠ `anon` is revoked from every one of these.
 *
 *   The anon key ships inside the app bundle and inside the web build. A
 *   definer function granted to anon is a public HTTP endpoint with the
 *   database's owner rights behind it, and `admin_support_messages` is the
 *   worst possible one to leave open — it is the only path to an internal note.
 */
revoke all on function public.notify_support_admins(text, text, text, jsonb, uuid)
  from public, anon, authenticated;

revoke all on function public.create_support_ticket(text, text, text, uuid) from public, anon;
revoke all on function public.reply_support_ticket(uuid, text) from public, anon;
revoke all on function public.admin_support_counts() from public, anon;
revoke all on function public.admin_support_queue(text, text, integer) from public, anon;
revoke all on function public.admin_support_ticket(uuid) from public, anon;
revoke all on function public.admin_support_messages(uuid) from public, anon;
revoke all on function public.admin_reply_support_ticket(uuid, text, boolean) from public, anon;
revoke all on function public.admin_set_support_status(uuid, text, text) from public, anon;
revoke all on function public.admin_assign_support_ticket(uuid, uuid) from public, anon;
revoke all on function public.admin_create_support_ticket(uuid, text, text, text, text, uuid, text)
  from public, anon;

grant execute on function public.create_support_ticket(text, text, text, uuid) to authenticated;
grant execute on function public.reply_support_ticket(uuid, text) to authenticated;
grant execute on function public.admin_support_counts() to authenticated;
grant execute on function public.admin_support_queue(text, text, integer) to authenticated;
grant execute on function public.admin_support_ticket(uuid) to authenticated;
grant execute on function public.admin_support_messages(uuid) to authenticated;
grant execute on function public.admin_reply_support_ticket(uuid, text, boolean) to authenticated;
grant execute on function public.admin_set_support_status(uuid, text, text) to authenticated;
grant execute on function public.admin_assign_support_ticket(uuid, uuid) to authenticated;
grant execute on function public.admin_create_support_ticket(uuid, text, text, text, text, uuid, text)
  to authenticated;

/*
 * ⚠ The admin_* functions are granted to `authenticated`, not to some admin
 *   role, and that is not a gap.
 *
 *   Postgres has no way to grant execute to "rows of profiles where is_admin",
 *   and Supabase issues one JWT role for every signed-in person. So the gate is
 *   the `is_admin()` check at the top of each function — the same arrangement
 *   07 uses for `admin_overview` and 58 for the money. Any non-admin who calls
 *   one gets an exception, not an empty list, which is also what the screens
 *   above them expect.
 */

-- ======================================================================== --
--                      what this file does NOT do                          --
-- ======================================================================== --

/*
 * 1. No email. A public reply lights up the in-app inbox and sends a push (49's
 *    spine), and it does not put anything in `email_outbox`. It should: the
 *    person who emailed support@ is the person least likely to open the app.
 *    That needs a new `kind` in 38's check constraint and a template in
 *    `notify-events`, which is a migration and an Edge Function deploy — a
 *    separate change, deployed in step, rather than a half-wired one here.
 *
 * 2. No priority column. Urgency here is derivable — a parcel in transit with
 *    nobody answering is `awaiting_us` plus `oldest_waiting_hours` — and a
 *    priority field with no rule behind it becomes three operators' private
 *    conventions in the same column.
 *
 * 3. No SLA clock and no auto-close sweep. Both want `pg_cron` and a policy
 *    somebody has actually agreed to; inventing "closes after 7 days idle"
 *    would silently resolve tickets nobody answered, which is the failure this
 *    whole table exists to make visible.
 *
 * 4. No retention sweep, unlike 49. A notification is a nudge; a support thread
 *    is the record of what a customer was told, and the NDPR request that ends
 *    it is erasure, which is handled above.
 */


-- ############################################################################
-- migration 20250101000060_finance_reporting.sql
-- ############################################################################

-- Package Relay — reporting over the finance ledgers: dates, the fee split, and
-- one timeline an accountant can export.
--
-- Run after 59. Re-runnable.
--
-- ⚠ Numbered 60, not 59, and the gap is not a mistake.
--
--   This was written as 59 and `20250101000059_support_tickets.sql` landed in
--   the same working tree within the hour. Two files sharing a number sort
--   arbitrarily, and `db push` applies them in whatever order the sort lands
--   on — which for a file that drops and recreates two functions is a coin
--   toss between working and a missing ledger. Renumbering the newer one is the
--   cheap half of that problem.
--
-- ⚠ Two signatures are dropped and recreated, which is the one thing here worth
--   reading twice.
--
--   `create or replace function` cannot change a function's argument list, so
--   adding a date range to the two ledgers means dropping them first. That is
--   safe only because the replacement is created in the same transaction, in
--   the same file, three lines later — and because the app is deployed with the
--   migration. A bundle compiled against 58's signatures calling 59's database
--   gets PGRST202 naming the function, which `schema-gap.ts` already turns into
--   the filename to run.
--
-- ⚠ The fee split on an inbound row is not always a fact, and the column says
--   which it is.
--
--   A parcel's commission is computed at *delivery* by `record_delivery_earning`,
--   from the rate in force at that moment, and stored on the earning row so a
--   later rate change cannot rewrite history. At payment time there is no
--   driver, no earning and no split — only a fare and today's rate.
--
--   So the ledger returns the real numbers when the parcel has been delivered
--   and a projection at the current rate when it has not, with
--   `split_is_actual` saying which. A single unlabelled number in that column
--   would be a forecast that reads as a liability, and it would change next
--   quarter for rows that were settled last quarter.

do $$
begin
  if to_regprocedure('public.admin_payments_ledger(text, text, integer)') is null then
    raise exception 'Run 20250101000058_admin_finance.sql first.';
  end if;
end
$$;

-- ============================================================================
-- 1. Inbound, over a date range, with the split
-- ============================================================================

/*
  ⚠ Ranged on `coalesce(paid_at, initialized_at)`, not on `paid_at`.

    `paid_at` is the date accounting cares about — when the money moved. It is
    also null on every pending, failed and abandoned charge, so a range built on
    it alone silently drops exactly the rows somebody opens this screen to find.
    Falling back to when the attempt was opened keeps a failed charge in the day
    it was attempted, which is where anybody looking for it would expect it.

  ⚠ `p_to` is exclusive.

    The screen sends midnight-to-midnight. An inclusive upper bound would
    include a charge made at 00:00:00.000 on the day after the range and, worse,
    put it in two adjacent monthly exports.
*/
drop function if exists public.admin_payment_totals();

create or replace function public.admin_payment_totals(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  collected_kobo bigint,
  collected_7d_kobo bigint,
  payments_succeeded integer,
  payments_pending integer,
  payments_failed integer,
  parcels_awaiting_payment integer,
  refunds_owed integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with ranged as (
    select p.*
      from public.parcel_payments p
     where (p_from is null or coalesce(p.paid_at, p.initialized_at) >= p_from)
       and (p_to is null or coalesce(p.paid_at, p.initialized_at) < p_to)
  )
  select
    coalesce(sum(r.amount_kobo) filter (where r.status = 'success'), 0)::bigint,
    /*
      ⚠ Deliberately not ranged.

        "Last 7 days" is a fixed comparison the tile promises regardless of what
        range is selected — it is there so somebody looking at a custom range
        still has today's trend beside it. Ranging it would make the tile
        duplicate the one next to it whenever the range was seven days, and
        contradict its own label otherwise.
    */
    (
      select coalesce(sum(p.amount_kobo) filter (
        where p.status = 'success' and p.paid_at > now() - interval '7 days'
      ), 0)
      from public.parcel_payments p
    )::bigint,
    count(*) filter (where r.status = 'success')::integer,
    count(*) filter (where r.status = 'pending')::integer,
    count(*) filter (where r.status in ('failed', 'abandoned'))::integer,
    /*
      Also not ranged, and for a sharper reason: a parcel posted last month and
      still unpaid is a problem *today*. Hiding it because the range starts on
      Monday would be hiding the oldest and worst instance of it.
    */
    (select count(*) from public.bookings b where b.payment_status = 'pending')::integer,
    (
      select count(*)
        from public.parcel_payments pp
        join public.bookings bb on bb.id = pp.booking_id
       where pp.status = 'success' and bb.status = 'Cancelled'
    )::integer
  from ranged r
  where public.is_admin();
$$;

drop function if exists public.admin_payments_ledger(text, text, integer);

create or replace function public.admin_payments_ledger(
  p_status text default null,
  p_query text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  reference text,
  gateway_reference text,
  provider text,
  amount_kobo bigint,
  currency text,
  status text,
  channel text,
  initialized_at timestamptz,
  paid_at timestamptz,
  failure_reason text,
  booking_id uuid,
  tracking_id text,
  parcel_status text,
  parcel_payment_status text,
  origin_city text,
  destination_city text,
  sender_id uuid,
  sender_name text,
  refund_owed boolean,
  /*
    The fare as it divides, in naira.

    ⚠ `fare` is `estimated_fee`, not the amount charged, and the two can differ.

      `settle_parcel_payment` refuses an underpayment and accepts an
      overpayment — refusing a sender who has been charged too much would be the
      worse failure. The driver's share is computed from the fare, so that is
      what these three describe. `amount_kobo` above is what the card was
      actually debited. They agree on every ordinary row; where they do not,
      the difference is the thing worth seeing.
  */
  fare numeric,
  commission numeric,
  driver_share numeric,
  commission_rate numeric,
  /* True when the parcel has been delivered and these are the recorded split. */
  split_is_actual boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with live_rate as (
    select public.commission_rate() as rate
  )
  select
    p.id,
    p.reference,
    p.gateway_reference,
    p.provider,
    p.amount_kobo,
    p.currency,
    p.status,
    p.channel,
    p.initialized_at,
    p.paid_at,
    p.failure_reason,
    b.id,
    b.tracking_id,
    b.status,
    b.payment_status,
    b.origin_city,
    b.destination_city,
    p.sender_id,
    coalesce(pr.full_name, ''),
    p.status = 'success' and b.status = 'Cancelled',
    b.estimated_fee,
    coalesce(e.commission, round(b.estimated_fee * (select rate from live_rate), 2)),
    coalesce(e.net, b.estimated_fee - round(b.estimated_fee * (select rate from live_rate), 2)),
    coalesce(e.commission_rate, (select rate from live_rate)),
    e.id is not null
  from public.parcel_payments p
  join public.bookings b on b.id = p.booking_id
  left join public.profiles pr on pr.id = p.sender_id
  /*
    One earning per parcel, ever — 30 puts a unique constraint on `booking_id`
    for exactly this reason — so this join cannot multiply the ledger.
  */
  left join public.driver_earnings e on e.booking_id = b.id
  where public.is_admin()
    and (p_status is null or p.status = p_status)
    and (p_from is null or coalesce(p.paid_at, p.initialized_at) >= p_from)
    and (p_to is null or coalesce(p.paid_at, p.initialized_at) < p_to)
    and (
      p_query is null
      or btrim(p_query) = ''
      or p.reference ilike '%' || btrim(p_query) || '%'
      or b.tracking_id ilike '%' || btrim(p_query) || '%'
    )
  order by coalesce(p.paid_at, p.initialized_at) desc
  limit greatest(1, least(coalesce(p_limit, 50), 1000));
$$;

-- ============================================================================
-- 2. Outbound, as a timeline rather than as balances
-- ============================================================================

/**
 * Every earning and every payout in a window, across all drivers.
 *
 * ⚠ This exists because a date range cannot be applied to a balance.
 *
 *   "Available in March" is not a quantity. A balance is an as-of-now figure —
 *   what a driver could withdraw today — and recomputing it over a window
 *   produces a number that looks authoritative, means nothing, and is the one
 *   somebody would pay against. So `admin_payout_ledger` stays unranged and
 *   this answers the question a date range is actually asked for: what moved,
 *   and when.
 *
 * It is also what the Outbound CSV exports, because a month of transactions is
 * what reconciliation needs and a snapshot of balances is not.
 *
 * ⚠ `amount` is signed by direction, and the sign is the point.
 *
 *   An earning is money owed to a driver, a payout is money sent to them.
 *   Exporting both as positive numbers gives a spreadsheet whose total is
 *   double the truth, and the first person to sum that column would not notice.
 */
create or replace function public.admin_finance_transactions(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 500
)
returns table (
  kind text,
  happened_at timestamptz,
  driver_id uuid,
  driver_name text,
  /** Signed: positive for an earning, negative for a payout. */
  amount numeric,
  gross numeric,
  commission numeric,
  status text,
  reference text,
  tracking_id text
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from (
    select
      'earning' as kind,
      e.earned_at as happened_at,
      e.driver_id,
      coalesce(pr.full_name, '') as driver_name,
      e.net as amount,
      e.gross,
      e.commission,
      'earned' as status,
      '' as reference,
      coalesce(b.tracking_id, '') as tracking_id
    from public.driver_earnings e
    left join public.bookings b on b.id = e.booking_id
    left join public.profiles pr on pr.id = e.driver_id
    where public.is_admin()
      and (p_from is null or e.earned_at >= p_from)
      and (p_to is null or e.earned_at < p_to)

    union all

    select
      'payout',
      coalesce(r.settled_at, r.requested_at),
      r.driver_id,
      coalesce(pr.full_name, ''),
      -r.amount,
      /*
        A payout has no fare and no commission behind it — it is a transfer of
        money already earned. Zeroes rather than nulls so a spreadsheet's SUM
        over the column does not stop at the first blank cell.
      */
      0,
      0,
      r.status,
      coalesce(r.reference, r.failure_reason, ''),
      ''
    from public.payout_requests r
    left join public.profiles pr on pr.id = r.driver_id
    where public.is_admin()
      /*
        ⚠ Dated by when it settled, falling back to when it was asked for.

          An open request has not moved any money yet and belongs in the window
          it was raised in; a settled one belongs in the window the transfer
          happened. Using `requested_at` for both would put a payout requested
          in March and paid in April into March's reconciliation, where April's
          bank statement cannot match it.
      */
      and (p_from is null or coalesce(r.settled_at, r.requested_at) >= p_from)
      and (p_to is null or coalesce(r.settled_at, r.requested_at) < p_to)
  ) feed
  order by happened_at desc
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
$$;

-- ------------------------------------------------------------- grants -----

revoke all on function public.admin_payment_totals(timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_payments_ledger(text, text, timestamptz, timestamptz, integer)
  from public, anon;
revoke all on function public.admin_finance_transactions(timestamptz, timestamptz, integer)
  from public, anon;

grant execute on function public.admin_payment_totals(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_payments_ledger(text, text, timestamptz, timestamptz, integer)
  to authenticated;
grant execute on function public.admin_finance_transactions(timestamptz, timestamptz, integer)
  to authenticated;

notify pgrst, 'reload schema';


-- ############################################################################
-- migration 20250101000061_capture_session_fk_repair.sql
-- ############################################################################

-- ============================================================================
-- 20250101000061_capture_session_fk_repair.sql — erasure can delete a capture
--                                                 session again
-- ============================================================================
--
-- Run after 01–60. Re-runnable.
--
-- ⚠ What was broken: erasing anybody who has posted a parcel since 44.
--
--   `erase_person` (09, repaired in 33) deletes the subject's capture sessions —
--   they are the most sensitive rows in the schema, a national identifier beside
--   a photograph of a face, so 33 deletes them rather than overwriting them.
--
--   44 then added `bookings.capture_session_id` referencing that table, with no
--   `on delete` action, which in Postgres means `no action`. From that migration
--   onwards the delete in 33 hits a parcel that still points at the session and
--   raises:
--
--     update or delete on table "photo_capture_sessions" violates foreign key
--     constraint "bookings_capture_session_id_fkey" on table "bookings"
--
--   The exception aborts the whole function, so an NDPR erasure request for an
--   ordinary sender failed outright and nothing was scrubbed. The Admin screen
--   showed the database's message verbatim, which is the only reason it was
--   visible at all.
--
--   Neither file is wrong on its own. 33 is right to delete the sessions; 44 is
--   right to keep which session authorised a parcel. What was missing is what
--   should happen to the pointer when the session goes, and nobody wrote it
--   down — so Postgres chose the strictest answer.
--
-- ⚠ `set null`, not `cascade`, and the difference is somebody else's data.
--
--   `cascade` would delete the *parcel* when its capture session is deleted.
--   33 already argues this case about the sender's own bookings: a recipient's
--   delivery history is theirs, and destroying it to satisfy somebody else's
--   erasure request is the wrong trade. Cascading here would do exactly that,
--   and quietly — an erasure would take a stranger's completed delivery with it.
--
--   `set null` keeps the parcel, the route and the fare, and loses the pointer
--   to a row that no longer exists. Nothing is lost that survives the erasure
--   anyway: the session it pointed at is deleted in the same statement.
--
-- ⚠ Not a rewrite of `erase_person`.
--
--   The other available fix is to null `bookings.capture_session_id` inside that
--   function before the delete. It would work, and it would mean retyping 160
--   lines of a pushed function whose every statement exists because something
--   leaked — which is the failure CLAUDE.md names as this codebase's most
--   repeated. A foreign key's own missing clause belongs on the foreign key.
--
-- ⚠ The insert trigger is untouched.
--
--   `guard_parcel_selfie` in 44 still requires a completed, passed session on
--   *insert*. This changes nothing about posting a parcel: a null
--   `capture_session_id` can only arrive here by way of an erasure, never from
--   a client.
--
-- Applies cleanly whether or not 44 has been applied, and whatever the
-- constraint ended up being called.

do $$
declare
  existing text;
begin
  if to_regclass('public.bookings') is null then
    raise exception 'Run 20250101000001_bookings.sql first.';
  end if;

  /*
   * Nothing to repair on a project that never applied 44. The column arrives
   * with the constraint already correct, because this file will have run by the
   * time anybody adds it — so say so and stop rather than raising.
   */
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'bookings'
       and column_name = 'capture_session_id'
  ) then
    raise notice 'bookings.capture_session_id does not exist yet — nothing to repair.';
    return;
  end if;

  /*
   * Found by catalog, not by name.
   *
   * ⚠ `bookings_capture_session_id_fkey` is what Postgres generated for 44, and
   *   naming it in a `drop constraint` would be right on every project that ran
   *   these files in order — and wrong on one where somebody added the column by
   *   hand in the SQL editor, which is exactly how the staging project has been
   *   fixed before. So this asks the catalog which constraint sits on that
   *   column and drops whatever it is called.
   */
  select con.conname
    into existing
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = any (con.conkey)
   where con.conrelid = 'public.bookings'::regclass
     and con.contype = 'f'
     and att.attname = 'capture_session_id'
   limit 1;

  if existing is not null then
    /*
      Already correct? Leave it alone. `confdeltype` is 'n' for set null and 'a'
      for no action — re-running this file should not churn a constraint that is
      already what it should be, because dropping and re-adding one takes a lock
      on `bookings` and this table is the busiest in the schema.
    */
    if (select confdeltype from pg_constraint where conname = existing
         and conrelid = 'public.bookings'::regclass) = 'n' then
      raise notice 'capture_session_id already has on delete set null — nothing to do.';
      return;
    end if;

    execute format('alter table public.bookings drop constraint %I', existing);
  end if;

  alter table public.bookings
    add constraint bookings_capture_session_id_fkey
    foreign key (capture_session_id)
    references public.photo_capture_sessions (id)
    on delete set null;
end
$$;

comment on column public.bookings.capture_session_id is
  'The capture session whose selfie authorised this parcel. Set by the insert '
  'trigger from the id the client supplies; never written directly. Null only '
  'after the sender was erased — 61 made this on delete set null so that '
  'erasing the session does not take the parcel, or the erasure, with it.';

/*
 * A note for whoever reads this next, because the interesting part is the class
 * of bug rather than this instance of it.
 *
 * Two safe changes, eleven migrations apart, combined into a broken one. Every
 * later table that references a row an erasure deletes has the same trap, and
 * the question to ask of each is: what should happen to this pointer when the
 * thing it points at is erased? `notifications` (49) and `support_tickets` (59)
 * both answer it explicitly — cascade from `auth.users`, because an inbox or a
 * thread left behind is a leak with no owner. 44 simply never asked.
 *
 * `scripts/pg/erase-harness.mjs` now builds `bookings.capture_session_id` with
 * the real foreign key and seeds a parcel that uses it, so the next one of these
 * fails a test instead of an NDPR request.
 */

-- ------------------------------------------------ something to ask for ------

/*
 * A function whose only job is to be askable, and which answers from the live
 * catalog rather than by existing.
 *
 * ⚠ 55 set this precedent and the reason is the same one.
 *
 *   The deployment panel (`src/lib/schema-gap.ts` → `src/store/deployment.ts`)
 *   asks PostgREST which functions are exposed, and translates a missing one
 *   into the filename to run. A migration that adds no function is invisible to
 *   it — and `verify-identity-review.ts` fails the build when the newest
 *   migration is not on that panel, precisely because the list once stopped at
 *   37 while the app shipped 41.
 *
 *   So this repair carries a probe. Unlike a constant it keeps telling the
 *   truth after the migration has run: drop the constraint and re-add it without
 *   the clause — which is how it went missing the first time — and this starts
 *   answering false while still existing.
 *
 * ⚠ Definer, and readable by any signed-in account, which is safe here.
 *
 *   It returns one boolean about the shape of the schema. There is no row, no
 *   id and nothing about a person in the answer; the alternative is a probe only
 *   an admin can call, which would report the repair as missing to everybody
 *   else and make the panel lie on the screen most people see.
 */
create or replace function public.capture_session_fk_repaired()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_attribute att
        on att.attrelid = con.conrelid
       and att.attnum = any (con.conkey)
     where con.conrelid = 'public.bookings'::regclass
       and con.contype = 'f'
       and att.attname = 'capture_session_id'
       /* 'n' is set null. 'a' is the no-action default that broke erasure. */
       and con.confdeltype = 'n'
  );
$$;

comment on function public.capture_session_fk_repaired() is
  'True when bookings.capture_session_id has on delete set null, so erasing a '
  'sender who has posted a parcel succeeds. Read by the deployment panel.';

revoke all on function public.capture_session_fk_repaired() from public, anon;
grant execute on function public.capture_session_fk_repaired() to authenticated;


-- ############################################################################
-- the ledger
-- ############################################################################

insert into supabase_migrations.schema_migrations (version, name) values
  ('20250101000056', 'parcel_payments'),
  ('20250101000057', 'payment_receipt_email'),
  ('20250101000058', 'admin_finance'),
  ('20250101000059', 'support_tickets'),
  ('20250101000060', 'finance_reporting'),
  ('20250101000061', 'capture_session_fk_repair'),
  ('20250101000062', 'welcome_email'),
  ('20250101000063', 'password_changed_email'),
  ('20250101000064', 'status_email_driver_name')
on conflict (version) do nothing;

-- ############################################################################
-- the check
-- ############################################################################

with probe as (
  select
    to_regclass('public.parcel_payments')                   is not null as m56_table,
    to_regprocedure('public.open_parcel_payment(uuid)')      is not null as m56_open,
    to_regprocedure('public.settle_parcel_payment(text,numeric,text,jsonb)')
                                                             is not null as m56_settle,
    exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='bookings'
               and column_name='payment_status')                        as m56_column,
    (select column_default from information_schema.columns
      where table_schema='public' and table_name='bookings'
        and column_name='payment_status')                               as new_parcels_default,
    (select count(*) from public.bookings where payment_status = 'paid') as grandfathered,
    to_regprocedure('public.email_on_parcel_paid()')         is not null as m57_receipt,
    to_regprocedure('public.admin_payment_totals()')         is not null as m58_60_totals,
    to_regprocedure('public.admin_finance_transactions(date,date)')
                                                             is not null as m60_transactions,
    to_regclass('public.support_tickets')                   is not null as m59_tickets,
    to_regprocedure('public.capture_session_fk_repaired()')  is not null as m61_probe
)
select *,
  case
    when not m56_column   then 'bookings.payment_status was not added — nothing below it will work.'
    when not m56_table    then 'parcel_payments is missing — checkout has nowhere to record a charge.'
    when not m56_open
      or not m56_settle   then 'The payment functions are missing — checkout cannot open.'
    when new_parcels_default is distinct from '''pending''::text'
                          then 'New parcels do not default to pending, so they would dispatch unpaid. Read migration 56 before going further.'
    when not m57_receipt  then 'No receipt email on payment.'
    when not m58_60_totals or not m60_transactions
                          then 'The admin finance screens have no functions to call.'
    when not m59_tickets  then 'Support tickets are missing.'
    when not m61_probe    then 'Migration 61 did not land.'
    else 'Clear on the database side. NOW DEPLOY: supabase functions deploy payments-initialize payments-verify payments-webhook — and set PAYSTACK_SECRET_KEY. Checkout still cannot open without them.'
  end as next_step
from probe;
