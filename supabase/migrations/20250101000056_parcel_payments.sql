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
