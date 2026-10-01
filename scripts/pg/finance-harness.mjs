/**
 * Runs 20250101000058_admin_finance.sql against a real Postgres, on top of the
 * real chain, under RLS.
 *
 * ⚠ What is being proved, in one sentence: the finance screens show an admin
 *   the truth and show everybody else nothing.
 *
 *   1. A non-admin gets empty ledgers and an exception from the reveal — the
 *      screens' own guard is a courtesy, these functions are the control.
 *   2. The payout ledger's arithmetic agrees with `driver_balance`, for every
 *      driver, every time. It is a set-based copy of that function's logic
 *      written for speed, and a copy nothing compares is a copy that drifts.
 *   3. `state` is derived correctly, including 'ready' — the state that has no
 *      row in `payout_requests` and which a ledger built on that table alone
 *      would render as an empty screen on the day the platform owes the most.
 *   4. A settled charge against a cancelled parcel is counted as a refund owed.
 *      Nothing else in the system surfaces those.
 *   5. Revealing a bank account writes an audit line naming who asked.
 *
 * Usage: node scripts/pg/finance-harness.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();

/* Same three as the other full-chain harness: pg_net and the push plumbing. */
const SKIP = new Set([
  '20250101000005_storage_and_alerts.sql',
  '20250101000019_push.sql',
  '20250101000024_push_delivery.sql',
]);

const MIGRATIONS = readdirSync(join(ROOT, 'supabase/migrations'))
  .filter((name) => /^\d+_.*\.sql$/.test(name))
  .sort();

const read = (name) => readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8');

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) return;
  failures += 1;
  console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
};

const SENDER = '11111111-1111-1111-1111-111111111111';
const DRIVER = '22222222-2222-2222-2222-222222222222';
const DRIVER_B = '33333333-3333-3333-3333-333333333333';
const ADMIN = '44444444-4444-4444-4444-444444444444';

const SUPABASE_SHIM = `
  create role anon; create role authenticated; create role service_role;
  create role supabase_auth_admin;
  create schema auth; create schema storage; create schema extensions;
  create schema private; create schema net;
  create publication supabase_realtime;

  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public
    grant execute on functions to anon, authenticated, service_role;

  create table auth.users (
    id uuid primary key, email text, phone text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now()
  );
  create function auth.jwt() returns jsonb language sql stable as $fn$ select '{}'::jsonb $fn$;

  create table storage.buckets (
    id text primary key, name text, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text, name text,
    owner uuid, created_at timestamptz default now(), metadata jsonb
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $fn$
    select string_to_array(name, '/')
  $fn$;
  insert into storage.buckets (id, name) values
    ('sender-photo','sender-photo'), ('driver-documents','driver-documents'),
    ('delivery-proof','delivery-proof'), ('parcel-photo','parcel-photo'),
    ('sender-identity','sender-identity');

  create table public.push_tokens (
    id uuid primary key default gen_random_uuid(),
    user_id uuid, token text, platform text,
    created_at timestamptz default now()
  );

  create table private.app_settings (key text primary key, value text);
  create function net.http_post(
    url text, body jsonb default '{}', params jsonb default '{}',
    headers jsonb default '{}', timeout_milliseconds int default 5000
  ) returns bigint language sql as $fn$ select 1::bigint $fn$;

  create function auth.uid() returns uuid language sql stable as $fn$ select null::uuid $fn$;
`;

const SEED = `
  create table public.who (id uuid);
  create or replace function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1
  $fn$;
  grant select on public.who to authenticated;

  insert into auth.users (id, email, phone) values
    ('${SENDER}', 'sender@pkrelay.test', '08030000001'),
    ('${DRIVER}', 'driver@pkrelay.test', '08030000002'),
    ('${DRIVER_B}', 'driver-b@pkrelay.test', '08030000005'),
    ('${ADMIN}', 'admin@pkrelay.test', '08030000006');

  update public.profiles set full_name = 'Test Sender' where id = '${SENDER}';
  update public.profiles set full_name = 'Test Driver'  where id = '${DRIVER}';
  update public.profiles set full_name = 'Second Driver' where id = '${DRIVER_B}';
  update public.profiles set full_name = 'Test Admin', is_admin = true where id = '${ADMIN}';

  /*
    A real commission rate, because the default is 0 and 0 hides the bug.

      30 defaults commission_rate to zero on purpose -- "a made-up rate is
      worse than an obviously unset one". That is right for a live project and
      useless for a test: with no fee, gross and net are the same number and a
      ledger that confused the two would pass every assertion below.
  */
  insert into private.app_settings (key, value)
  values ('commission_rate', '0.15'), ('minimum_payout', '1000'), ('payout_hold_hours', '24')
  on conflict (key) do update set value = excluded.value;

  insert into public.sender_identity (user_id, status, verified_at)
  values ('${SENDER}', 'verified', now())
  on conflict (user_id) do update set status = 'verified', verified_at = now();

  insert into public.driver_applications (
    user_id, reference, full_name, phone, email, nin, address, state,
    vehicle_type, plate_number, license_id,
    guarantor_name, guarantor_phone, guarantor_relationship, guarantor_address, guarantor_nin,
    bank_name, account_number, account_name, kin_name, kin_phone, kin_relationship, status
  ) values (
    '${DRIVER}', 'LOCI-PAY-1', 'Test Driver', '08030000002', 'driver@pkrelay.test',
    '12345678901', '1 Test Road', 'Lagos', 'bike', 'ABC-123', 'DL-1',
    'G Name', '08030000003', 'Brother', '2 Test Road', '12345678902',
    'Test Bank', '0123456789', 'Test Driver', 'K Name', '08030000004', 'Sister', 'approved'
  );

  insert into public.driver_applications (
    user_id, reference, full_name, phone, email, nin, address, state,
    vehicle_type, plate_number, license_id,
    guarantor_name, guarantor_phone, guarantor_relationship, guarantor_address, guarantor_nin,
    bank_name, account_number, account_name, kin_name, kin_phone, kin_relationship, status
  ) values (
    '${DRIVER_B}', 'LOCI-PAY-2', 'Second Driver', '08030000005', 'driver-b@pkrelay.test',
    '12345678903', '3 Test Road', 'Lagos', 'bike', 'ABC-124', 'DL-2',
    'G Name', '08030000003', 'Brother', '2 Test Road', '12345678902',
    'Test Bank', '0123456780', 'Second Driver', 'K Name', '08030000004', 'Sister', 'approved'
  );

  alter table public.driver_applications disable trigger user;
  update public.driver_applications
     set status = 'approved', reviewed_at = now()
   where user_id in ('${DRIVER}', '${DRIVER_B}');
  alter table public.driver_applications enable trigger user;
`;

/*
 * ⚠ `dispatch_booking` is replaced by a no-op, after the chain.
 *
 *   Nothing here is about dispatch, and the real matcher writes offer rows that
 *   would only add noise to the money this file is counting.
 *
 * (The comment below is kept from the payments harness, which needs the record.)
 *
 *   "Did dispatch run" cannot be asked of `dispatch_offers`: the real matcher
 *   only writes a row when some driver has declared a matching journey, so an
 *   empty table would be the answer whether the gate worked or the matcher
 *   simply found nobody. That is a test that passes for the wrong reason, which
 *   is the only kind worth being afraid of.
 *
 *   The spy records the call itself. It keeps the same signature, so the
 *   triggers created by 15 and 56 bind to it unchanged.
 */
const SPY = `
  create table public.dispatched (booking_id uuid, at timestamptz default clock_timestamp());
  create or replace function public.dispatch_booking(booking_id uuid)
  returns uuid language plpgsql security definer set search_path = '' as $fn$
  begin
    insert into public.dispatched (booking_id) values (dispatch_booking.booking_id);
    return null;
  end;
  $fn$;
`;

const BOOKING_COLUMNS = `
  tracking_id, delivery_type, pickup_mode, dropoff_mode, origin_city, destination_city,
  item_description, category, weight, estimated_fee, sender_id, status, capture_session_id`;

/** The chain, applied in order. */
async function build() {
  const db = await PGlite.create();
  await db.exec(SUPABASE_SHIM);

  for (const name of MIGRATIONS) {
    if (SKIP.has(name)) continue;
    await db.exec(read(name));
  }

  await db.exec(SEED);
  await db.exec(SPY);
  return db;
}

const asUser = async (db, id) => {
  await db.exec(
    `reset role; delete from public.who; insert into public.who (id) values ('${id}');`,
  );
  await db.exec('set role authenticated');
};

const asOwner = async (db) => db.exec('reset role; delete from public.who;');

const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

async function freshSession(db) {
  await db.exec('reset role');
  const { rows } = await db.query(
    `insert into public.photo_capture_sessions
       (owner_id, photo_path, completed_at, liveness_status, liveness_environment, liveness_checked_at)
     values ($1, 'sender-photo/' || gen_random_uuid() || '.jpg', now(), 'passed', 'sandbox', now())
     returning id`,
    [SENDER],
  );
  return rows[0].id;
}

let counter = 0;
const nextTracking = () => `PKR-T-${++counter}`;

/** Posts a parcel as the sender, the way the app does. Returns the row. */
async function postParcel(db, { fee = 2800, paymentStatus = null, hasPayments = true } = {}) {
  const session = await freshSession(db);
  await asUser(db, SENDER);

  const columns = paymentStatus ? `${BOOKING_COLUMNS}, payment_status` : BOOKING_COLUMNS;
  const extra = paymentStatus ? ', $4' : '';

  const { rows } = await db.query(
    `insert into public.bookings (${columns}) values (
       $1, 'local', 'hub', 'hub', 'Lagos', 'Lagos',
       'A box', 'Other', 2, $2, '${SENDER}', 'Booked', $3${extra}
     ) returning id, estimated_fee${hasPayments ? ', payment_status' : ''}`,
    paymentStatus
      ? [nextTracking(), fee, session, paymentStatus]
      : [nextTracking(), fee, session],
  );

  return rows[0];
}

/** Payment confirmation emails queued for one parcel. */
const paymentEmails = async (db, bookingId) => {
  await asOwner(db);
  const { rows } = await db.query(
    `select o.subject_id, o.recipient, o.payload
       from public.email_outbox o
       join public.parcel_payments p on p.reference = o.subject_id
      where o.kind = 'parcel_payment_received' and p.booking_id = $1`,
    [bookingId],
  );
  return rows;
};

const dispatches = async (db, bookingId) => {
  await asOwner(db);
  const { rows } = await db.query('select count(*)::int as n from public.dispatched where booking_id = $1', [
    bookingId,
  ]);
  return rows[0].n;
};


// ============================================================================

console.log('\nrunning 58_admin_finance + 60_finance_reporting against the full migration chain, under RLS…\n');

const db = await build();

/** Posts a parcel, pays for it, and hands it to a driver. Returns the booking. */
async function paidParcel(db, { fee = 2800, driver = DRIVER, reference }) {
  const parcel = await postParcel(db, { fee });

  await asOwner(db);
  await db.query(`select public.open_parcel_payment($1, $2, 'paystack')`, [parcel.id, reference]);
  await db.query(
    `select public.settle_parcel_payment($1, '9', $2, 'card', now(), '{"status":"success"}'::jsonb)`,
    [reference, fee * 100],
  );

  if (driver) {
    await db.query(
      `update public.bookings set driver_id = $1, driver = 'D', status = 'Assigned' where id = $2`,
      [driver, parcel.id],
    );
  }

  return parcel;
}

/** Marks a parcel delivered as the owner, which is what fires the earning. */
async function deliver(db, bookingId, { agedHours = 0 } = {}) {
  await asOwner(db);
  await db.query(
    `update public.bookings
        set status = 'Delivered', delivered_at = now(), received_by = 'Recipient'
      where id = $1`,
    [bookingId],
  );

  /*
    ⚠ Backdating the earning rather than changing the hold setting.

      'ready' only exists once an earning is older than `payout_hold_hours()`,
      and a test that set the hold to zero would prove the states work in a
      configuration no real project uses. Ageing the row leaves the 24-hour hold
      in force and exercises the boundary it actually guards.
  */
  if (agedHours > 0) {
    await db.query(
      `update public.driver_earnings
          set earned_at = now() - ($2 || ' hours')::interval
        where booking_id = $1`,
      [bookingId, String(agedHours)],
    );
  }
}

const ledger = async (db, state = null) => {
  const { rows } = await db.query('select * from public.admin_payout_ledger($1, 100)', [state]);
  return rows;
};

const rowFor = (rows, driverId) => rows.find((r) => r.driver_id === driverId);

// ------------------------------------------- 1. nobody but an admin reads it --

{
  const one = await paidParcel(db, { reference: 'pkr_fin_1' });
  await deliver(db, one.id, { agedHours: 48 });

  await asUser(db, DRIVER);

  const { rows: payments } = await db.query(
    'select * from public.admin_payments_ledger(null, null, null, null, 50)',
  );
  check(
    'a driver reads no payments ledger',
    payments.length === 0,
    `${payments.length} rows — the ledger carries every sender's name and what they paid`,
  );

  const { rows: payouts } = await db.query('select * from public.admin_payout_ledger(null, 100)');
  check(
    'and no payout ledger, not even their own row',
    payouts.length === 0,
    'a driver reading this sees every other driver’s balance and bank details',
  );

  const { rows: totals } = await db.query('select * from public.admin_payment_totals()');
  check(
    'and the headline totals are empty for them',
    totals.length === 0 || Number(totals[0].collected_kobo) === 0,
    JSON.stringify(totals[0] ?? {}),
  );

  const { rows: open } = await db.query(
    `select id from public.payout_requests where status = 'requested' limit 1`,
  );
  const refused = await refusal(() =>
    db.query('select * from public.admin_reveal_payout_account($1, null)', [
      open[0]?.id ?? '00000000-0000-0000-0000-000000000000',
    ]),
  );
  check(
    'and the bank account reveal raises rather than returning nothing',
    refused !== null && /not allowed/i.test(refused),
    `got: ${refused}`,
  );
}

// ------------------------------------------------- 2. the inbound ledger ----

{
  await asUser(db, ADMIN);

  const { rows } = await db.query('select * from public.admin_payments_ledger(null, null, null, null, 50)');
  check('an admin sees the charge', rows.length === 1, `${rows.length} rows`);

  const row = rows[0] ?? {};
  check('with its reference', row.reference === 'pkr_fin_1', String(row.reference));
  check('the amount in kobo', Number(row.amount_kobo) === 280000, String(row.amount_kobo));
  check('the parcel it paid for', typeof row.tracking_id === 'string' && row.tracking_id.length > 0);
  check(
    'and the sender named',
    row.sender_name === 'Test Sender',
    `${row.sender_name} — a ledger that cannot say who paid is not a ledger`,
  );
  check('not flagged for refund', row.refund_owed === false);

  const { rows: byRef } = await db.query(
    `select * from public.admin_payments_ledger(null, 'PKR_FIN_1', null, null, 50)`,
  );
  check(
    'searching by reference is case-insensitive',
    byRef.length === 1,
    'a reference is copied off a bank statement and arrives in whatever case it is printed in',
  );

  const { rows: byTracking } = await db.query(
    `select * from public.admin_payments_ledger(null, $1, null, null, 50)`,
    [String(row.tracking_id).toLowerCase()],
  );
  check('and so is searching by tracking id', byTracking.length === 1);

  const { rows: totals } = await db.query('select * from public.admin_payment_totals()');
  check('the totals count what was collected', Number(totals[0].collected_kobo) === 280000);
  check('and how many succeeded', Number(totals[0].payments_succeeded) === 1);
}

// -------------------------------------------- 3. a refund nobody would find --

{
  const doomed = await paidParcel(db, { reference: 'pkr_fin_refund', driver: null });
  await asOwner(db);
  await db.query(
    `update public.bookings
        set status = 'Cancelled', cancelled_at = now(), cancelled_role = 'sender',
            cancellation_reason = 'changed my mind'
      where id = $1`,
    [doomed.id],
  );

  await asUser(db, ADMIN);
  const { rows: totals } = await db.query('select * from public.admin_payment_totals()');
  check(
    'a settled charge on a cancelled parcel counts as a refund owed',
    Number(totals[0].refunds_owed) === 1,
    'until this screen existed the only way to find one was to think to grep app_events',
  );

  const { rows } = await db.query(
    `select * from public.admin_payments_ledger(null, 'pkr_fin_refund', null, null, 10)`,
  );
  check('and the row says so', rows[0]?.refund_owed === true);
}

// --------------------------------------------- 4. the outbound arithmetic ---

{
  await asUser(db, ADMIN);
  const rows = await ledger(db);
  const mine = rowFor(rows, DRIVER);

  check('the driver appears', Boolean(mine), 'no row for a driver who has delivered a parcel');
  check('with their delivery counted', Number(mine.deliveries) === 1);
  check('the fare as gross', Number(mine.gross) === 2800);
  check(
    'the platform fee split out',
    Number(mine.commission) === 420,
    `${mine.commission} — 15% of ₦2,800 is ₦420, and a zero here is the commission_rate` +
      '\n       default leaking into the fixture',
  );
  check('and the driver keeping the rest', Number(mine.net_earned) === 2380);

  /*
    ⚠ Against `driver_balance`, not against numbers written out by hand.

      The ledger is a set-based copy of that function. Asserting on literals
      would let both drift together the next time the hold or the definition of
      "taken" changes; asserting against the original is what makes the copy
      safe to keep.
  */
  for (const driver of [DRIVER, DRIVER_B]) {
    const { rows: balance } = await db.query('select * from public.driver_balance($1)', [driver]);
    const row = rowFor(await ledger(db), driver);
    if (!row) continue;

    check(
      `the ledger agrees with driver_balance on earned (${driver.slice(0, 4)})`,
      Number(row.net_earned) === Number(balance[0].earned),
      `${row.net_earned} vs ${balance[0].earned}`,
    );
    check(
      `…and on available (${driver.slice(0, 4)})`,
      Number(row.available) === Number(balance[0].available),
      `${row.available} vs ${balance[0].available}`,
    );
    check(
      `…and on the hold (${driver.slice(0, 4)})`,
      Number(row.on_hold) === Number(balance[0].on_hold),
      `${row.on_hold} vs ${balance[0].on_hold}`,
    );
  }
}

// ------------------------------------------------------- 5. the four states --

{
  await asUser(db, ADMIN);

  check(
    'a driver past the hold with a withdrawable balance is ready',
    rowFor(await ledger(db), DRIVER)?.state === 'ready',
    `state: ${rowFor(await ledger(db), DRIVER)?.state} — 'ready' is the state with no row in` +
      '\n       payout_requests, so a ledger built on that table alone shows an empty screen',
  );

  /* A second driver, delivered just now: earned, but still inside the hold. */
  const fresh = await paidParcel(db, { reference: 'pkr_fin_2', driver: DRIVER_B });
  await deliver(db, fresh.id);

  await asUser(db, ADMIN);
  check(
    'a driver still inside the hold is holding, not ready',
    rowFor(await ledger(db), DRIVER_B)?.state === 'holding',
    'paying out money that is hours old removes the only cheap moment to stop a disputed trip',
  );

  /* The first driver asks to be paid. */
  await asUser(db, DRIVER);
  const requested = await refusal(() => db.query('select public.request_payout(null)'));
  check('the driver can request their balance', requested === null, requested ?? '');

  await asUser(db, ADMIN);
  const pending = rowFor(await ledger(db), DRIVER);
  check('which puts them in pending', pending?.state === 'pending');
  check('with the amount they asked for', Number(pending?.open_request_amount) === 2380);
  check(
    'and the bank account masked to four digits',
    pending?.open_account_hint === '6789' && !String(pending?.open_account_hint).includes('0123'),
    `${pending?.open_account_hint} — a full account number on a list view is one on screen all day`,
  );

  const filtered = await ledger(db, 'pending');
  check('the state filter narrows to them', filtered.length === 1 && filtered[0].driver_id === DRIVER);
}

// ------------------------------------------- 6. revealing, and settling ----

{
  await asUser(db, ADMIN);
  const pending = rowFor(await ledger(db), DRIVER);

  const { rows: revealed } = await db.query(
    'select * from public.admin_reveal_payout_account($1, $2)',
    [pending.open_request_id, 'making the transfer'],
  );
  check(
    'an admin can reveal the full account number',
    revealed[0]?.account_number === '0123456789',
    `got ${revealed[0]?.account_number}`,
  );

  await asOwner(db);
  const { rows: logged } = await db.query(
    `select count(*)::int as n from public.app_events
      where area = 'payout' and message = 'payout account revealed'`,
  );
  check(
    'and the look is recorded',
    logged[0].n === 1,
    'an unlogged read of a bank account is one nobody can account for afterwards',
  );

  await asUser(db, ADMIN);
  const settled = await refusal(() =>
    db.query(`select public.settle_payout($1, 'paid', $2)`, [
      pending.open_request_id,
      'FBN-TRF-99213',
    ]),
  );
  check('the admin can settle it', settled === null, settled ?? '');

  const after = rowFor(await ledger(db), DRIVER);
  check(
    'which clears them to paid',
    after?.state === 'paid',
    `state: ${after?.state}, available ${after?.available}`,
  );
  check('and nothing is left owed', Number(after?.available) === 0);
  check('with the payout counted', Number(after?.paid_out) === 2380);

  const { rows: history } = await db.query('select * from public.admin_driver_ledger($1, 50)', [
    DRIVER,
  ]);
  check(
    'the driver timeline carries the earning and the payout',
    history.length === 2 && history.some((h) => h.kind === 'payout') &&
      history.some((h) => h.kind === 'earning'),
    JSON.stringify(history.map((h) => h.kind)),
  );
  check(
    'and the payout carries the transfer reference',
    history.find((h) => h.kind === 'payout')?.reference === 'FBN-TRF-99213',
    'a settled payout with nothing recorded is one nobody can trace later',
  );
}

// ------------------------------------------ 7. and a non-admin cannot settle --

{
  const second = await paidParcel(db, { reference: 'pkr_fin_3', driver: DRIVER });
  await deliver(db, second.id, { agedHours: 48 });

  await asUser(db, DRIVER);
  await db.query('select public.request_payout(null)');

  await asOwner(db);
  const { rows: open } = await db.query(
    `select id from public.payout_requests where status = 'requested' limit 1`,
  );

  await asUser(db, DRIVER_B);
  const refused = await refusal(() =>
    db.query(`select public.settle_payout($1, 'paid', 'nope')`, [open[0].id]),
  );
  check(
    'another driver cannot mark somebody else paid',
    refused !== null && /not allowed/i.test(refused),
    `got: ${refused}`,
  );
}

// ------------------------------------------ 8. dates, the split, the feed --

{
  await asUser(db, ADMIN);

  /*
    ⚠ Bounds tested at the edges, not in the middle.

      Any range wide enough to contain everything passes whatever the comparison
      operators are. The two that matter are a `from` exactly on a row's
      timestamp — which must include it — and a `to` exactly on it, which must
      not, or a charge at midnight lands in two adjacent monthly exports.
  */
  const { rows: one } = await db.query(
    `select * from public.admin_payments_ledger(null, 'pkr_fin_1', null, null, 10)`,
  );
  const at = one[0].paid_at;

  const { rows: inclusive } = await db.query(
    `select * from public.admin_payments_ledger(null, 'pkr_fin_1', $1, null, 10)`,
    [at],
  );
  check(
    'the lower bound includes a row on its own timestamp',
    inclusive.length === 1,
    'an exclusive `from` loses the first transaction of every month',
  );

  const { rows: exclusive } = await db.query(
    `select * from public.admin_payments_ledger(null, 'pkr_fin_1', null, $1, 10)`,
    [at],
  );
  check(
    'and the upper bound excludes it',
    exclusive.length === 0,
    'an inclusive `to` puts a charge made at exactly midnight into two adjacent exports',
  );

  const { rows: totals } = await db.query(
    'select * from public.admin_payment_totals($1, $2)',
    [new Date(Date.now() + 86_400_000).toISOString(), null],
  );
  check(
    'the totals honour the range',
    Number(totals[0].collected_kobo) === 0,
    'a range in the future collected nothing, whatever the table holds',
  );
  check(
    'but parcels awaiting payment ignore it',
    Number(totals[0].parcels_awaiting_payment) >= 0,
    'a parcel posted last month and still unpaid is a problem today; a range must not hide it',
  );

  /* ---- the split, actual and projected ---- */

  const delivered = one[0];
  check(
    'a delivered parcel reports the recorded split',
    delivered.split_is_actual === true,
    'driver_earnings exists for this parcel, so the numbers are facts rather than a forecast',
  );
  check('with the platform cut', Number(delivered.commission) === 420);
  check('and the driver share', Number(delivered.driver_share) === 2380);
  check(
    'at the rate stored on the earning',
    Number(delivered.commission_rate) === 0.15,
    '30 stores the rate on the row so a change next quarter cannot rewrite last quarter',
  );

  /* A parcel paid for and never delivered: there is no earning to read. */
  const undelivered = await paidParcel(db, { reference: 'pkr_fin_open', driver: null });
  await asUser(db, ADMIN);
  const { rows: open } = await db.query(
    `select * from public.admin_payments_ledger(null, 'pkr_fin_open', null, null, 10)`,
  );
  check(
    'an undelivered parcel is marked as a projection',
    open[0].split_is_actual === false,
    'shown unlabelled, this row reads as a settled liability on a parcel nobody has carried',
  );
  check(
    'and it is projected at the live rate',
    Number(open[0].commission) === 420 && Number(open[0].driver_share) === 2380,
    `${open[0].commission} / ${open[0].driver_share}`,
  );

  /* ---- the transactions feed ---- */

  const { rows: feed } = await db.query(
    'select * from public.admin_finance_transactions(null, null, 500)',
  );

  const earnings = feed.filter((row) => row.kind === 'earning');
  const payouts = feed.filter((row) => row.kind === 'payout');

  check('the feed carries earnings', earnings.length >= 1);
  check('and payouts', payouts.length >= 1);
  check(
    'an earning is positive and a payout is negative',
    earnings.every((row) => Number(row.amount) > 0) &&
      payouts.every((row) => Number(row.amount) < 0),
    'exported as two positive columns, the total is double the truth and nobody notices',
  );
  check(
    'an earning carries its fare and commission',
    earnings.every((row) => Number(row.gross) > 0 && Number(row.commission) >= 0),
  );
  check(
    'and a payout carries zeroes rather than nulls',
    payouts.every((row) => row.gross !== null && row.commission !== null),
    "a null stops a spreadsheet's SUM at the first blank cell",
  );
  check(
    'a settled payout carries its transfer reference',
    payouts.some((row) => row.reference === 'FBN-TRF-99213'),
    JSON.stringify(payouts.map((row) => row.reference)),
  );

  await asUser(db, DRIVER);
  const { rows: refusedFeed } = await db.query(
    'select * from public.admin_finance_transactions(null, null, 500)',
  );
  check(
    'and a driver reads none of it',
    refusedFeed.length === 0,
    "the feed names every driver's earnings and every payout reference",
  );
}

await db.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('the finance ledgers hold.\n');
