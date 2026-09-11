-- LOCI — the ledger. What a driver earned, what LOCI kept, what has been paid.
--
-- Run after 01–29. Re-runnable.
--
-- ⚠ BEFORE THIS FILE, NOTHING IN LOCI RECORDED THAT MONEY EXISTED.
--
--   `earnings.ts` has carried a note to that effect since it was written: the
--   figures on the driver dashboard are *quoted fares* on parcels, labelled
--   "Expected" precisely because no payout ledger existed. A wallet screen
--   showing a "Current Balance" without one would be a number a driver reads as
--   money in an account, next to a button that sends nothing anywhere.
--
--   This file is what makes that screen honest. Three tables:
--
--     driver_earnings   one immutable row per delivered parcel
--     payout_requests   a driver asking to be paid, and its outcome
--     (balance)         derived from the two, never stored
--
-- ⚠ THE BALANCE IS NEVER A COLUMN.
--
--   A stored balance is a number that can disagree with the rows beneath it,
--   and when it does there is no way to tell which is right. Every balance here
--   is `sum(earnings) - sum(payouts not cancelled)`, computed on read. It is
--   slower and it cannot drift.
--
-- ⚠ AND NOTHING HERE MOVES MONEY.
--
--   `payout_requests` records that a driver asked and that somebody marked it
--   paid. There is no bank integration: no Paystack, no Flutterwave, no NIBSS.
--   Marking a request `paid` is a human saying they made a transfer. Until a
--   disbursement provider is wired in, that is what "paid" means, and the
--   screen says so.

do $$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'Run 20250101000001_bookings.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------- the numbers --

/**
 * LOCI's cut, as a fraction.
 *
 * ⚠ SET THIS BEFORE ANYBODY IS PAID.
 *
 *     insert into private.app_settings (key, value) values ('commission_rate', '0.15')
 *     on conflict (key) do update set value = excluded.value;
 *
 *   The default below is 0 — the driver keeps the whole fare — because a made-up
 *   rate is worse than an obviously unset one. Zero is visibly wrong on the
 *   first payout run; 0.2 looks plausible and quietly underpays somebody.
 */
create or replace function public.commission_rate()
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select value::numeric from private.app_settings where key = 'commission_rate'),
    0
  );
$$;

/**
 * How long after delivery an earning becomes withdrawable.
 *
 * The security hold. A parcel disputed the same evening is disputed before the
 * money leaves, which is the only cheap moment to stop it. Twenty-four hours by
 * default; override with the `payout_hold_hours` setting.
 */
create or replace function public.payout_hold_hours()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select value::integer from private.app_settings where key = 'payout_hold_hours'),
    24
  );
$$;

/** The smallest payout worth making, in naira. */
create or replace function public.minimum_payout()
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select value::numeric from private.app_settings where key = 'minimum_payout'),
    1000
  );
$$;

revoke all on function public.commission_rate() from public, anon;
revoke all on function public.payout_hold_hours() from public, anon;
revoke all on function public.minimum_payout() from public, anon;
grant execute on function public.commission_rate() to authenticated;
grant execute on function public.payout_hold_hours() to authenticated;
grant execute on function public.minimum_payout() to authenticated;

-- ------------------------------------------------------------- earnings ----

create table if not exists public.driver_earnings (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users (id) on delete cascade,

  /*
    One earning per parcel, ever.

    A unique constraint rather than a convention: the trigger below fires on
    update, and a booking edited twice after delivery would otherwise pay for
    the same trip twice.
  */
  booking_id uuid not null references public.bookings (id) on delete cascade unique,

  /** The fare the sender was quoted. */
  gross numeric not null check (gross >= 0),

  /*
    ⚠ The rate is stored on the row, not looked up when read.

      A rate change next quarter must not rewrite what somebody earned last
      quarter. Recomputing historic rows from a live setting is how a driver's
      past payslips silently change, which is both wrong and unexplainable.
  */
  commission_rate numeric not null check (commission_rate >= 0 and commission_rate < 1),
  commission numeric not null check (commission >= 0),
  net numeric not null check (net >= 0),

  earned_at timestamptz not null default now(),

  constraint earnings_add_up check (abs(gross - commission - net) < 0.005)
);

create index if not exists driver_earnings_driver_idx
  on public.driver_earnings (driver_id, earned_at desc);

alter table public.driver_earnings enable row level security;

drop policy if exists "read own earnings" on public.driver_earnings;
create policy "read own earnings"
  on public.driver_earnings for select
  to authenticated
  using (driver_id = (select auth.uid()) or public.is_admin());

/*
  No write policy at all. Earnings come from the trigger below and nowhere else.
*/

/**
 * Records the earning when a parcel is delivered.
 *
 * On the booking rather than in `advance_booking` because a parcel can reach
 * Delivered by more than one path — the driver's own advance today, an admin
 * correction tomorrow. Hanging it off the row means none of them can forget.
 */
create or replace function public.record_delivery_earning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rate numeric;
  cut numeric;
begin
  if new.status <> 'Delivered' or old.status = 'Delivered' then
    return new;
  end if;

  if new.driver_id is null then
    return new;
  end if;

  rate := public.commission_rate();
  cut := round(new.estimated_fee * rate, 2);

  insert into public.driver_earnings
    (driver_id, booking_id, gross, commission_rate, commission, net, earned_at)
  values (
    new.driver_id,
    new.id,
    new.estimated_fee,
    rate,
    cut,
    new.estimated_fee - cut,
    coalesce(new.delivered_at, now())
  )
  -- A second delivery event for the same parcel is not a second payday.
  on conflict (booking_id) do nothing;

  return new;
end;
$$;

drop trigger if exists bookings_record_earning on public.bookings;
create trigger bookings_record_earning
  after update on public.bookings
  for each row execute function public.record_delivery_earning();

-- ------------------------------------------------------------- payouts -----

create table if not exists public.payout_requests (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users (id) on delete cascade,

  amount numeric not null check (amount > 0),

  /*
    Where it was going, captured at request time.

    The bank account can change afterwards — `request_payout_change` exists for
    exactly that — and a payout record that follows the current account would
    rewrite where last month's money went.
  */
  bank_name text not null,
  account_number text not null,
  account_name text not null,

  status text not null default 'requested'
    check (status in ('requested', 'paid', 'failed', 'cancelled')),

  /** Whatever the person who made the transfer wants to record. */
  reference text,
  failure_reason text,

  requested_at timestamptz not null default now(),
  settled_at timestamptz,

  constraint payout_settled_consistent check (
    (status = 'requested' and settled_at is null)
    or (status <> 'requested' and settled_at is not null)
  )
);

create index if not exists payout_requests_driver_idx
  on public.payout_requests (driver_id, requested_at desc);

/*
  One open request at a time.

  Without it a driver could submit their whole balance twice before either was
  settled and be owed double. A partial unique index rather than a check,
  because the rule is about the set of rows and not about any single one.
*/
create unique index if not exists payout_requests_one_open
  on public.payout_requests (driver_id)
  where status = 'requested';

alter table public.payout_requests enable row level security;

drop policy if exists "read own payouts" on public.payout_requests;
create policy "read own payouts"
  on public.payout_requests for select
  to authenticated
  using (driver_id = (select auth.uid()) or public.is_admin());

/* No client write policy. `request_payout` below is the only door. */

-- ------------------------------------------------------------- the balance --

/**
 * What a driver has, split by what they can act on.
 *
 *   earned      every net earning, ever
 *   paid_out    everything requested and not cancelled or failed — money that
 *               has left or is about to
 *   on_hold     earned too recently to withdraw
 *   available   what a payout may be requested against
 *
 * ⚠ `paid_out` counts `requested` as well as `paid`, deliberately.
 *
 *   A request that has not been settled is still a claim on the same money.
 *   Excluding it would let a driver request their balance, see it unchanged,
 *   and request it again — which the unique index above would refuse, but only
 *   after the screen had already told them they could.
 */
create or replace function public.driver_balance(target uuid default null)
returns table (
  earned numeric,
  paid_out numeric,
  on_hold numeric,
  available numeric,
  currency text
)
language sql
stable
security definer
set search_path = ''
as $$
  with who as (
    select coalesce(target, (select auth.uid())) as id
  ),
  guard as (
    select id from who
    where id = (select auth.uid()) or public.is_admin()
  ),
  totals as (
    select
      coalesce(sum(e.net), 0) as earned,
      coalesce(sum(e.net) filter (
        where e.earned_at > now() - (public.payout_hold_hours() || ' hours')::interval
      ), 0) as on_hold
    from public.driver_earnings e
    join guard on guard.id = e.driver_id
  ),
  taken as (
    select coalesce(sum(p.amount), 0) as paid_out
    from public.payout_requests p
    join guard on guard.id = p.driver_id
    where p.status in ('requested', 'paid')
  )
  select
    totals.earned,
    taken.paid_out,
    totals.on_hold,
    -- Never negative. A hold larger than the unpaid remainder is normal on a
    -- driver who has just been paid, and a negative "available" reads as debt.
    greatest(totals.earned - taken.paid_out - totals.on_hold, 0),
    'NGN'
  from totals, taken;
$$;

revoke all on function public.driver_balance(uuid) from public, anon;
grant execute on function public.driver_balance(uuid) to authenticated;

/**
 * Asks to be paid.
 *
 * Amount is checked against `available`, not against `earned`: the hold and any
 * open request are already subtracted there, so this cannot pay out money that
 * is either too new or already claimed.
 */
create or replace function public.request_payout(amount numeric default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  bal record;
  account record;
  wanted numeric;
  minimum numeric := public.minimum_payout();
  new_id uuid;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select * into bal from public.driver_balance(actor);
  -- Null amount means "all of it", which is what the button does.
  wanted := coalesce(amount, bal.available);

  if wanted <= 0 then
    raise exception 'You have nothing available to withdraw yet';
  end if;

  if wanted > bal.available then
    raise exception 'You can withdraw up to %, not %', bal.available, wanted;
  end if;

  if wanted < minimum then
    raise exception 'The smallest payout is %', minimum;
  end if;

  select * into account from public.active_payout_account(actor);

  if account.account_number is null then
    raise exception 'Add a payout account before requesting money';
  end if;

  /*
    The unique index does the real work here.

    Two taps racing each other both pass the checks above; only one insert
    survives. Catching it turns a constraint violation into a sentence.
  */
  begin
    insert into public.payout_requests
      (driver_id, amount, bank_name, account_number, account_name)
    values (actor, wanted, account.bank_name, account.account_number, account.account_name)
    returning id into new_id;
  exception when unique_violation then
    raise exception 'You already have a payout waiting to be processed';
  end;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'payout', 'driver requested a payout',
    -- Amount only. The account number is on the request row, which is not
    -- readable by everyone `app_events` is.
    jsonb_build_object('amount', wanted), actor
  );

  return new_id;
end;
$$;

revoke all on function public.request_payout(numeric) from public, anon;
grant execute on function public.request_payout(numeric) to authenticated;

/**
 * Cancels an unsettled request.
 *
 * The driver's own, and only while nobody has acted on it. Once it is paid or
 * failed the money has moved or been refused, and a row saying otherwise would
 * be a lie about a transfer.
 */
create or replace function public.cancel_payout_request(request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  owner uuid;
  current_status text;
begin
  select driver_id, status into owner, current_status
  from public.payout_requests where id = request_id;

  if owner is null then
    raise exception 'No such request';
  end if;
  if owner <> actor then
    raise exception 'Not your request';
  end if;
  if current_status <> 'requested' then
    raise exception 'That payout is already %', current_status;
  end if;

  update public.payout_requests
     set status = 'cancelled', settled_at = now()
   where id = request_id;
end;
$$;

revoke all on function public.cancel_payout_request(uuid) from public, anon;
grant execute on function public.cancel_payout_request(uuid) to authenticated;

/**
 * Marks a request paid or failed. Service role and admins only.
 *
 * ⚠ This does not transfer anything. It records that a human did.
 */
create or replace function public.settle_payout(
  request_id uuid,
  outcome text,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  if outcome not in ('paid', 'failed') then
    raise exception 'Outcome must be paid or failed';
  end if;

  update public.payout_requests
     set status = outcome,
         settled_at = now(),
         reference = case when outcome = 'paid' then note else reference end,
         failure_reason = case when outcome = 'failed' then note else failure_reason end
   where id = request_id and status = 'requested';

  if not found then
    raise exception 'That request is not waiting to be settled';
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    case when outcome = 'paid' then 'info' else 'warning' end,
    'payout', 'payout ' || outcome,
    jsonb_build_object('request', request_id), auth.uid()
  );
end;
$$;

revoke all on function public.settle_payout(uuid, text, text) from public, anon;
grant execute on function public.settle_payout(uuid, text, text) to authenticated;

-- ------------------------------------------------------- one combined feed --

/**
 * Earnings and payouts on one timeline.
 *
 * A driver checking their money does not think in two tables. Merging them
 * server-side also means the screen cannot interleave them wrongly.
 */
create or replace function public.my_wallet_activity(limit_rows integer default 40)
returns table (
  kind text,
  amount numeric,
  label text,
  status text,
  happened_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from (
    select
      'earning' as kind,
      e.net as amount,
      coalesce(b.tracking_id, 'Delivery') as label,
      'earned' as status,
      e.earned_at as happened_at
    from public.driver_earnings e
    left join public.bookings b on b.id = e.booking_id
    where e.driver_id = (select auth.uid())

    union all

    select
      'payout',
      -p.amount,
      'Payout to ' || p.bank_name || ' ••••' || right(p.account_number, 4),
      p.status,
      coalesce(p.settled_at, p.requested_at)
    from public.payout_requests p
    where p.driver_id = (select auth.uid())
      and p.status <> 'cancelled'
  ) feed
  order by happened_at desc
  limit greatest(1, least(coalesce(limit_rows, 40), 200));
$$;

revoke all on function public.my_wallet_activity(integer) from public, anon;
grant execute on function public.my_wallet_activity(integer) to authenticated;

-- --------------------------------------------------------- what came before --

/*
  Parcels delivered before this file existed have no earning row.

  Backfilled at the *current* rate, because there is no other rate to use — the
  one they were delivered under was never recorded. If that matters, set
  `commission_rate` before running this file rather than after.
*/
insert into public.driver_earnings
  (driver_id, booking_id, gross, commission_rate, commission, net, earned_at)
select
  b.driver_id,
  b.id,
  b.estimated_fee,
  public.commission_rate(),
  round(b.estimated_fee * public.commission_rate(), 2),
  b.estimated_fee - round(b.estimated_fee * public.commission_rate(), 2),
  coalesce(b.delivered_at, b.created_at)
from public.bookings b
where b.status = 'Delivered'
  and b.driver_id is not null
on conflict (booking_id) do nothing;

/*
  ⚠ Still missing, and worth stating before this screen implies otherwise.

    - No bank integration. `settle_payout` records that somebody made a
      transfer; nothing makes one. Paystack Transfers or Flutterwave payouts
      would slot in behind `settle_payout` without changing anything above it.
    - No commission rate is set. `commission_rate()` returns 0 until somebody
      inserts one, so today every driver is credited the full fare.
    - No tax or withholding of any kind.
    - Nothing reverses an earning when a delivery is disputed after the hold has
      passed. The hold is the only protection, and 24 hours is a guess.
*/
