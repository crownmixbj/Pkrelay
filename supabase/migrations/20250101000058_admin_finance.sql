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
