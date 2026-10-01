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
