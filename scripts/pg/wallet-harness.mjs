/**
 * Runs the driver wallet ledger against a real Postgres.
 *
 * This is the first thing in Package Relay that counts money, and every failure mode is
 * a number somebody believes. Paying twice for one delivery, letting a balance
 * be withdrawn twice, or rewriting historic earnings when the commission rate
 * changes are all silent — the app keeps working and the arithmetic is wrong.
 *
 * ⚠ RLS is not exercised; the checks inside the functions are.
 *
 * Usage: node scripts/pg/wallet-harness.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) return;
  failures += 1;
  console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
};

function statementStart(sql, signatureStart) {
  const at = sql.search(
    new RegExp(`^${signatureStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'),
  );
  if (at === -1) throw new Error(`not found at line start: ${signatureStart}`);
  return at;
}

function extractFunction(sql, signatureStart) {
  const at = statementStart(sql, signatureStart);
  const bodyOpen = sql.indexOf('$$', at);
  const end = sql.indexOf('$$;', bodyOpen + 2);
  if (end === -1) throw new Error(`unterminated body: ${signatureStart}`);
  return sql.slice(at, end + 3);
}

function extractTable(sql, name) {
  const at = statementStart(sql, `create table if not exists ${name} (`);
  const end = sql.indexOf('\n);', at);
  if (end === -1) throw new Error(`unterminated table: ${name}`);
  return sql.slice(at, end + 3);
}

function extractStatement(sql, signatureStart) {
  const at = statementStart(sql, signatureStart);
  const end = sql.indexOf(';', at);
  return sql.slice(at, end + 1);
}

async function run(label, fn) {
  try {
    await fn();
  } catch (error) {
    failures += 1;
    console.error(`FAIL — ${label}`);
    console.error(`       ${error.message}`);
    if (error.query) console.error(`       in: ${String(error.query).trim().split('\n')[0]}…`);
  }
}

const db = await PGlite.create();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

const wallet = read('supabase/migrations/20250101000030_driver_wallet.sql');

await db.exec(`
  create schema auth;
  create schema private;
  create table auth.users (id uuid primary key);
  create table private.app_settings (key text primary key, value text not null);
  create table public.who (id uuid);
  create function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1;
  $fn$;
  create function public.is_admin() returns boolean language sql stable as $fn$
    select coalesce((select value = 'yes' from private.app_settings where key = 'admin'), false);
  $fn$;
  create table public.app_events (
    id uuid primary key default gen_random_uuid(),
    /*
      ⚠ The real CHECK constraint, copied from 20250101000007_admin.sql, and it belongs here.

        This stub used to say 'level text' with nothing else. Every harness did.
        So twelve inserts across nine migrations wrote 'warn' — which the real
        table refuses, because its vocabulary is 'info' | 'warning' | 'error' —
        and all six harnesses passed. The failure only appeared when an admin
        pressed a button in production.

        A stub looser than the thing it stands in for does not test the thing it
        stands in for. Anything a harness fakes has to keep the constraints that
        can actually reject a write.
    */
    level text not null check (level in ('info', 'warning', 'error')),
    area text, message text, context jsonb, actor_id uuid,
    created_at timestamptz not null default now()
  );
  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    tracking_id text,
    driver_id uuid,
    estimated_fee numeric not null default 0,
    status text not null default 'Booked',
    delivered_at timestamptz,
    created_at timestamptz not null default now()
  );
  create function public.active_payout_account(driver uuid)
  returns table (bank_name text, account_number text, account_name text)
  language sql stable as $fn$
    select 'GTBank', '0123456789', 'Omolola Adedapo';
  $fn$;
`);

for (const fn of [
  'create or replace function public.commission_rate(',
  'create or replace function public.payout_hold_hours(',
  'create or replace function public.minimum_payout(',
]) {
  await db.exec(extractFunction(wallet, fn));
}

await db.exec(extractTable(wallet, 'public.driver_earnings'));
await db.exec(extractTable(wallet, 'public.payout_requests'));
await db.exec(
  extractStatement(wallet, 'create unique index if not exists payout_requests_one_open'),
);

for (const fn of [
  'create or replace function public.record_delivery_earning(',
  'create or replace function public.driver_balance(',
  'create or replace function public.request_payout(',
  'create or replace function public.cancel_payout_request(',
  'create or replace function public.settle_payout(',
  'create or replace function public.my_wallet_activity(',
]) {
  await db.exec(extractFunction(wallet, fn));
}

await db.exec(`
  create trigger bookings_record_earning
    after update on public.bookings
    for each row execute function public.record_delivery_earning();
`);

const DRIVER = '11111111-1111-1111-1111-111111111111';
await q('insert into auth.users values ($1)', [DRIVER]);
await q('insert into public.who values ($1)', [DRIVER]);

const setSetting = (key, value) =>
  q(
    'insert into private.app_settings values ($1, $2) on conflict (key) do update set value = excluded.value',
    [key, value],
  );

const reset = async () => {
  await db.exec('delete from public.payout_requests; delete from public.driver_earnings;');
  await db.exec('delete from public.bookings; delete from public.app_events;');
  await db.exec("delete from private.app_settings where key <> 'admin'");
};

/** Delivers a parcel `agoHours` ago and returns its id. */
const deliver = async (fee, agoHours = 48) => {
  const id = (
    await q(
      "insert into public.bookings (tracking_id, driver_id, estimated_fee, status) values ('PKG-1', $1, $2, 'Booked') returning id",
      [DRIVER, fee],
    )
  )[0].id;

  await q(
    `update public.bookings
        set status = 'Delivered', delivered_at = now() - ($2 || ' hours')::interval
      where id = $1`,
    [id, String(agoHours)],
  );
  return id;
};

const balance = async () => (await q('select * from public.driver_balance()'))[0];
const money = (v) => Number(v);

console.log('running the driver wallet against Postgres…\n');

await run('scenario 1 — a delivery becomes an earning', async () => {
  await reset();
  await setSetting('commission_rate', '0.15');
  await deliver(10000);

  const earning = (await q('select * from public.driver_earnings'))[0];
  check(
    'one row per delivered parcel',
    (await q('select * from public.driver_earnings')).length === 1,
  );
  check('the gross is the quoted fare', money(earning.gross) === 10000);
  check('commission is taken at the configured rate', money(earning.commission) === 1500);
  check('and the driver nets the rest', money(earning.net) === 8500);
  check(
    'the rate is stored on the row',
    money(earning.commission_rate) === 0.15,
    'recomputing historic rows from a live setting is how past payslips silently change',
  );
});

await run('scenario 2 — changing the rate does not rewrite history', async () => {
  await setSetting('commission_rate', '0.40');
  const earning = (await q('select * from public.driver_earnings'))[0];

  check(
    'the old earning is untouched',
    money(earning.net) === 8500 && money(earning.commission_rate) === 0.15,
  );

  await deliver(10000);
  const rows = await q('select * from public.driver_earnings order by earned_at');
  check('and the new one uses the new rate', money(rows[1].net) === 6000);
});

await run('scenario 3 — one delivery is not two paydays', async () => {
  await reset();
  await setSetting('commission_rate', '0');
  const id = await deliver(5000);

  // A second delivery event on the same parcel: an admin correction, a retry.
  await q("update public.bookings set status = 'In Transit' where id = $1", [id]);
  await q("update public.bookings set status = 'Delivered' where id = $1", [id]);

  check(
    'still one earning',
    (await q('select * from public.driver_earnings')).length === 1,
    'the unique constraint on booking_id is what makes the trigger safe to fire more than once',
  );
});

await run('scenario 4 — an unassigned or undelivered parcel earns nothing', async () => {
  await reset();
  await q(
    "insert into public.bookings (driver_id, estimated_fee, status) values ($1, 3000, 'In Transit')",
    [DRIVER],
  );
  await q("insert into public.bookings (estimated_fee, status) values (3000, 'Booked')");
  await q("update public.bookings set status = 'Cancelled' where driver_id is null");

  check('nothing is credited', (await q('select * from public.driver_earnings')).length === 0);
});

await run('scenario 5 — the security hold keeps new money out of reach', async () => {
  await reset();
  await setSetting('commission_rate', '0');
  await setSetting('payout_hold_hours', '24');

  await deliver(4000, 1); // an hour ago
  await deliver(6000, 48); // two days ago

  const bal = await balance();
  check('everything is counted as earned', money(bal.earned) === 10000);
  check('the recent one is held', money(bal.on_hold) === 4000);
  check(
    'and only the settled one is available',
    money(bal.available) === 6000,
    'a parcel disputed the same evening is disputed before the money leaves, which is the only cheap moment to stop it',
  );
});

await run('scenario 6 — a request cannot exceed what is available', async () => {
  await setSetting('minimum_payout', '1000');

  let refused = '';
  try {
    await q('select public.request_payout($1)', [9000]);
  } catch (error) {
    refused = error.message;
  }
  check('over the available balance is refused', /You can withdraw up to/.test(refused));

  let tooSmall = '';
  try {
    await q('select public.request_payout($1)', [50]);
  } catch (error) {
    tooSmall = error.message;
  }
  check('and so is under the minimum', /smallest payout/.test(tooSmall));
});

await run('scenario 7 — an open request is subtracted immediately', async () => {
  /*
   * A *partial* request, on purpose.
   *
   * Taking the whole balance leaves `available` at zero, so a second attempt is
   * refused by the amount check and never reaches the one-open-request index —
   * my first version of this asserted the index message and was really testing
   * the balance guard. Leaving money on the table is what exercises it.
   */
  await q('select public.request_payout($1)', [3000]);

  const bal = await balance();
  check(
    'available drops the moment it is requested',
    money(bal.available) === 3000 && money(bal.paid_out) === 3000,
    'counting only settled payouts would let a driver request the same money twice and be told they could',
  );

  let second = '';
  try {
    await q('select public.request_payout($1)', [1000]);
  } catch (error) {
    second = error.message;
  }
  check(
    'a second open request is refused even with money left',
    /already have a payout waiting/.test(second),
    'without the partial unique index two taps racing each other both pass every check above it',
  );
});

await run('scenario 8 — the account is captured at request time', async () => {
  const request = (await q('select * from public.payout_requests'))[0];
  check(
    'the destination is stored on the row',
    request.account_number === '0123456789' && request.bank_name === 'GTBank',
    'following the current account would rewrite where last month money went, the first time somebody changes bank',
  );
});

await run('scenario 9 — cancelling returns the money to available', async () => {
  const request = (await q('select id from public.payout_requests'))[0];
  await q('select public.cancel_payout_request($1)', [request.id]);

  check('it is available again', money((await balance()).available) === 6000);
  check(
    'and a new request is possible',
    (await q('select public.request_payout($1) as id', [6000]))[0].id !== null,
  );
});

await run('scenario 10 — only an admin settles, and only once', async () => {
  const request = (await q("select id from public.payout_requests where status = 'requested'"))[0];

  let asDriver = '';
  try {
    await q('select public.settle_payout($1, $2)', [request.id, 'paid']);
  } catch (error) {
    asDriver = error.message;
  }
  check('a driver cannot mark their own payout paid', /Not allowed/.test(asDriver));

  await setSetting('admin', 'yes');
  await q('select public.settle_payout($1, $2, $3)', [request.id, 'paid', 'NIBSS-123']);

  const settled = (await q('select * from public.payout_requests where id = $1', [request.id]))[0];
  check(
    'it is paid with a reference',
    settled.status === 'paid' && settled.reference === 'NIBSS-123',
  );
  check('and settled_at is set', settled.settled_at !== null);

  let again = '';
  try {
    await q('select public.settle_payout($1, $2)', [request.id, 'failed']);
  } catch (error) {
    again = error.message;
  }
  check('settling twice is refused', /not waiting to be settled/.test(again));
  await setSetting('admin', 'no');
});

await run('scenario 11 — a failed payout returns the money', async () => {
  await reset();
  await setSetting('commission_rate', '0');
  await setSetting('minimum_payout', '1000');
  await deliver(5000, 48);

  await q('select public.request_payout($1)', [5000]);
  const request = (await q('select id from public.payout_requests'))[0];

  await setSetting('admin', 'yes');
  await q('select public.settle_payout($1, $2, $3)', [request.id, 'failed', 'wrong account']);
  await setSetting('admin', 'no');

  check(
    'a failed transfer is not money the driver lost',
    money((await balance()).available) === 5000,
    'only requested and paid count against the balance; failed has to give it back or a bank error costs the driver their week',
  );
});

await run('scenario 12 — the balance is never negative', async () => {
  await reset();
  await setSetting('commission_rate', '0');
  await deliver(2000, 1); // entirely on hold

  const bal = await balance();
  check('available floors at zero', money(bal.available) === 0);
  check('rather than showing a debt', money(bal.available) >= 0);
});

await run('scenario 13 — the feed merges both sides', async () => {
  await reset();
  await setSetting('commission_rate', '0');
  await setSetting('minimum_payout', '1000');
  await deliver(7000, 48);
  await q('select public.request_payout($1)', [7000]);

  const feed = await q('select * from public.my_wallet_activity()');
  check('both rows appear', feed.length === 2);
  check(
    'the earning is positive',
    feed.some((r) => r.kind === 'earning' && money(r.amount) === 7000),
  );
  check(
    'and the payout is negative',
    feed.some((r) => r.kind === 'payout' && money(r.amount) === -7000),
    'a wallet where money out looks like money in is a wallet nobody can read',
  );
  check(
    'the account number is masked in the label',
    feed.some((r) => r.kind === 'payout' && /••••6789/.test(r.label)),
  );
});

await run('scenario 14 — an unset commission rate credits the whole fare', async () => {
  await reset();
  await deliver(8000, 48);

  const earning = (await q('select * from public.driver_earnings'))[0];
  check(
    'the default rate is zero, not a guess',
    money(earning.commission) === 0 && money(earning.net) === 8000,
    'a made-up rate looks plausible and quietly underpays somebody; zero is visibly wrong on the first payout run',
  );
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed against Postgres.`);
  process.exit(1);
}

console.log(
  'PASS — a delivery credits exactly once at the rate recorded on the row, a later rate\n' +
    '       change never rewrites it, new money sits under a hold, an open request is\n' +
    '       subtracted the moment it is made, a failed transfer gives the money back, and\n' +
    '       no driver can settle their own payout.',
);
