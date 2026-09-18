/**
 * Runs 20250101000056_parcel_payments.sql against a real Postgres, on top of the
 * real chain, under RLS.
 *
 * ⚠ The full chain rather than a fixture, for 48's reason.
 *
 *   This migration does not invent a rule in isolation — it rewrites two
 *   policies that five earlier files have already rewritten, and adds a trigger
 *   whose whole job is to close a hole in a policy written in 25. A
 *   hand-written fixture would be me deciding what those policies say, and the
 *   entire risk here is that my idea of them and the chain's disagree.
 *
 * ⚠ What is actually being proved, in one sentence: a parcel nobody has paid
 *   for cannot reach a driver, and nothing the client can send changes that.
 *
 *   1. A posted parcel starts 'pending', and a client cannot post one 'paid'.
 *   2. A sender cannot UPDATE their own parcel to 'paid' — the hole that the
 *      sender-edit branch of "advance own parcel" would otherwise leave wide
 *      open, and the one that makes every other guard here decorative.
 *   3. An approved driver cannot even SELECT an unpaid parcel.
 *   4. Dispatch does not run on insert, and does run the moment a payment
 *      settles — exactly once, however many times the settlement is reported.
 *   5. Underpayment is refused, and the parcel stays unpaid.
 *   6. The parcels that existed before this migration are still paid, still
 *      visible and still dispatchable.
 *
 * Usage: node scripts/pg/payments-harness.mjs
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

const PAYMENTS = '20250101000056_parcel_payments.sql';


const MIGRATIONS = readdirSync(join(ROOT, 'supabase/migrations'))
  .filter((name) => /^\d+_.*\.sql$/.test(name))
  .sort();

const read = (name) => readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8');

/*
 * The payment files, found rather than listed.
 *
 * ⚠ Section 7 builds the chain *without* payments to prove the backfill, and a
 *   hand-written list of what to leave out has now been wrong twice — once when
 *   57 was added and again when 60 was. Both times the symptom was the whole
 *   harness dying on "Run 20250101000056_parcel_payments.sql first", which is
 *   the guard in the newer file doing its job against a chain that deliberately
 *   omitted its dependency.
 *
 *   Any migration that mentions `parcel_payments` depends on 56, by definition.
 *   Asking the files is one line and cannot fall behind them.
 */
const PAYMENT_MIGRATIONS = new Set(
  MIGRATIONS.filter((name) => read(name).includes('parcel_payments')),
);


let failures = 0;
const check = (name, condition, detail) => {
  if (condition) return;
  failures += 1;
  console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
};

const SENDER = '11111111-1111-1111-1111-111111111111';
const DRIVER = '22222222-2222-2222-2222-222222222222';

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
    ('${DRIVER}', 'driver@pkrelay.test', '08030000002');

  update public.profiles set full_name = 'Test Sender' where id = '${SENDER}';
  update public.profiles set full_name = 'Test Driver'  where id = '${DRIVER}';

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

  alter table public.driver_applications disable trigger user;
  update public.driver_applications
     set status = 'approved', reviewed_at = now()
   where user_id = '${DRIVER}';
  alter table public.driver_applications enable trigger user;
`;

/*
 * ⚠ `dispatch_booking` is replaced by a spy, after the chain.
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

/** The chain, applied in order, optionally stopping before payments. */
async function build({ includePayments = true } = {}) {
  const db = await PGlite.create();
  await db.exec(SUPABASE_SHIM);

  for (const name of MIGRATIONS) {
    if (SKIP.has(name)) continue;
    if (!includePayments && PAYMENT_MIGRATIONS.has(name)) continue;
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

console.log('\nrunning 56_parcel_payments against the full migration chain, under RLS…\n');

const db = await build();

// ------------------------------------------- 1. a parcel is born unpaid ----

let parcel;
{
  parcel = await postParcel(db);

  check(
    'a newly posted parcel is pending payment',
    parcel.payment_status === 'pending',
    `got ${parcel.payment_status} — the column default was not changed after the backfill`,
  );

  check(
    'and nothing was dispatched',
    (await dispatches(db, parcel.id)) === 0,
    'dispatch_new_booking offered an unpaid parcel to drivers — the gate in 56 is not in force',
  );

  await asUser(db, SENDER);
  const prepaid = await refusal(() => postParcel(db, { paymentStatus: 'paid' }));
  check(
    'a client cannot post a parcel already marked paid',
    prepaid !== null,
    'the insert policy accepted payment_status = paid, so a parcel can be posted for nothing',
  );
  check(
    'and it is the policy refusing it',
    /row-level security|violates row-level/i.test(prepaid ?? ''),
    `refused, but for the wrong reason: ${prepaid}`,
  );
}

// -------------------------- 2. and the sender cannot talk it into being paid --

{
  await asUser(db, SENDER);

  const patched = await refusal(() =>
    db.query(`update public.bookings set payment_status = 'paid' where id = $1`, [parcel.id]),
  );

  check(
    'a sender cannot update their own parcel to paid',
    patched !== null,
    'this is the whole migration undone: "advance own parcel" lets a sender edit their own\n' +
      '       unassigned parcel, so without the trigger a PATCH through PostgREST dispatches a\n' +
      '       parcel nobody paid for and the gateway is never contacted',
  );

  const stillPending = await refusal(async () => {
    const { rows } = await db.query('select payment_status from public.bookings where id = $1', [
      parcel.id,
    ]);
    check('and the row is untouched', rows[0].payment_status === 'pending');
  });
  check('reading it back works', stillPending === null, stillPending ?? '');

  /* The honest sender edit still works — a guard that refuses everything is an outage. */
  await asUser(db, SENDER);
  const edited = await refusal(() =>
    db.query(`update public.bookings set notes = 'leave with the gateman' where id = $1`, [
      parcel.id,
    ]),
  );
  check('while an ordinary edit by the sender still works', edited === null, edited ?? '');
}

// ------------------------------------- 3. a driver cannot see an unpaid parcel --

{
  await asUser(db, DRIVER);
  const { rows: hidden } = await db.query('select id from public.bookings where id = $1', [
    parcel.id,
  ]);

  check(
    'an approved driver cannot see an unpaid unclaimed parcel',
    hidden.length === 0,
    'the board is showing parcels nobody has paid for — a driver can ride to a pickup for a\n' +
      '       parcel that was never charged',
  );

  await asUser(db, SENDER);
  const { rows: mine } = await db.query('select id from public.bookings where id = $1', [parcel.id]);
  check(
    'but its own sender still can',
    mine.length === 1,
    'hiding it from the sender too would hide the parcel they are being asked to pay for',
  );
}

// ------------------------------------------------ 4. settling, and dispatch --

{
  await asOwner(db);

  const { rows: opened } = await db.query(
    `select * from public.open_parcel_payment($1, 'pkr_test_one', 'paystack')`,
    [parcel.id],
  );
  const payment = opened[0];

  check(
    'the fare is read from the parcel, in kobo',
    Number(payment.amount_kobo) === 280000,
    `got ${payment.amount_kobo} for a ₦2,800 fare — a client-supplied amount or a lost ×100`,
  );

  const { rows: again } = await db.query(
    `select * from public.open_parcel_payment($1, 'pkr_test_two', 'paystack')`,
    [parcel.id],
  );
  check(
    'a second attempt reuses the live one rather than minting a reference',
    again[0].reference === 'pkr_test_one',
    'two references for one parcel is two charges for one parcel',
  );

  const { rows: settled } = await db.query(
    `select public.settle_parcel_payment(
       'pkr_test_one', '99999', 280000, 'card', now(), '{"status":"success"}'::jsonb
     ) as verdict`,
  );
  check('settlement reports ok', settled[0].verdict.ok === true, JSON.stringify(settled[0].verdict));

  const { rows: after } = await db.query(
    'select payment_status, paid_at from public.bookings where id = $1',
    [parcel.id],
  );
  check('the parcel is paid', after[0].payment_status === 'paid');
  check('and carries when', after[0].paid_at !== null);

  check(
    'and it dispatches exactly once',
    (await dispatches(db, parcel.id)) === 1,
    'the AFTER UPDATE trigger did not fire, or fired more than once',
  );

  /*
    ⚠ And the sender is told, by us.

      The first live test settled correctly and the only email the sender
      received came from Paystack — an amount and a merchant name, no parcel, no
      route, no tracking id. Everything below this line exists because that is
      indistinguishable, in the database, from working.
  */
  {
    const queued = await paymentEmails(db, parcel.id);

    check(
      'the sender is emailed a payment confirmation',
      queued.length === 1,
      `${queued.length} queued — the gateway's own email names no parcel, so with none of\n` +
        '       ours the sender cannot tell which shipment they just paid for',
    );

    const payload = queued[0]?.payload ?? {};

    check(
      'addressed to the sender',
      queued[0]?.recipient === 'sender@pkrelay.test',
      `got ${queued[0]?.recipient}`,
    );
    check(
      'and it names the parcel',
      typeof payload.tracking_id === 'string' && payload.tracking_id.startsWith('PKR-T-'),
      `tracking_id: ${JSON.stringify(payload.tracking_id)}`,
    );
    check(
      'carries the amount in naira, not kobo',
      Number(payload.amount) === 2800,
      `amount: ${JSON.stringify(payload.amount)} — 280000 here is the kobo leaking into the\n` +
        '       template, which would tell a sender they were charged ₦280,000',
    );
    check(
      'carries the reference support would search on',
      payload.reference === 'pkr_test_one',
      `reference: ${JSON.stringify(payload.reference)}`,
    );
    check(
      'and the route, so two parcels paid for in a morning are distinguishable',
      payload.origin_city === 'Lagos' && payload.destination_city === 'Lagos',
      JSON.stringify(payload),
    );
  }

  /* The second report of the same charge — webhook and browser both arrive. */
  const { rows: twice } = await db.query(
    `select public.settle_parcel_payment(
       'pkr_test_one', '99999', 280000, 'card', now(), '{"status":"success"}'::jsonb
     ) as verdict`,
  );
  check(
    'reporting the same charge again is a no-op',
    twice[0].verdict.ok === true && twice[0].verdict.already_settled === true,
    JSON.stringify(twice[0].verdict),
  );
  check(
    'and does not dispatch a second time',
    (await dispatches(db, parcel.id)) === 1,
    'the same parcel was offered to the matcher twice — one charge, two dispatches',
  );

  check(
    'and does not email a second time',
    (await paymentEmails(db, parcel.id)).length === 1,
    'the webhook and the returning browser both report the same charge; two confirmations\n' +
      '       for one payment is how a sender comes to believe they were charged twice',
  );

  await asUser(db, DRIVER);
  const { rows: visible } = await db.query('select id from public.bookings where id = $1', [
    parcel.id,
  ]);
  check('and the driver can now see it', visible.length === 1);
}

// ------------------------------------------------------ 5. underpayment --

{
  const cheap = await postParcel(db, { fee: 5000 });
  await asOwner(db);

  await db.query(`select public.open_parcel_payment($1, 'pkr_test_short', 'paystack')`, [cheap.id]);

  const { rows: verdict } = await db.query(
    `select public.settle_parcel_payment(
       'pkr_test_short', '88888', 100, 'card', now(), '{"status":"success"}'::jsonb
     ) as verdict`,
  );

  check(
    'a payment smaller than the fare is refused',
    verdict[0].verdict.ok === false && verdict[0].verdict.reason === 'amount_mismatch',
    `${JSON.stringify(verdict[0].verdict)} — without this, a reference from a cheaper parcel\n` +
      '       settles an expensive one',
  );

  const { rows: still } = await db.query(
    'select payment_status from public.bookings where id = $1',
    [cheap.id],
  );
  check('and the parcel stays unpaid', still[0].payment_status === 'pending');
  check('and undispatched', (await dispatches(db, cheap.id)) === 0);
  check(
    'and nobody is emailed a confirmation for it',
    (await paymentEmails(db, cheap.id)).length === 0,
    'a "payment received" email for a charge that was refused is the worst of both',
  );

  /* The failed row must not block a retry. */
  const retry = await refusal(() =>
    db.query(`select public.open_parcel_payment($1, 'pkr_test_retry', 'paystack')`, [cheap.id]),
  );
  check(
    'and the sender can start a fresh attempt',
    retry === null,
    'a dead attempt holding the one-live-attempt index locks somebody out of paying for their\n' +
      `       own parcel: ${retry}`,
  );
}

// -------------------------------------------- 6. a charge against a cancelled --

{
  const doomed = await postParcel(db);
  await asOwner(db);
  await db.query(`select public.open_parcel_payment($1, 'pkr_test_gone', 'paystack')`, [doomed.id]);

  await db.query(
    `update public.bookings
        set status = 'Cancelled', cancelled_at = now(), cancelled_role = 'sender',
            cancellation_reason = 'changed my mind'
      where id = $1`,
    [doomed.id],
  );

  const { rows: verdict } = await db.query(
    `select public.settle_parcel_payment(
       'pkr_test_gone', '77777', 280000, 'card', now(), '{"status":"success"}'::jsonb
     ) as verdict`,
  );

  check(
    'a charge landing on a cancelled parcel is flagged for refund',
    verdict[0].verdict.refund_owed === true,
    JSON.stringify(verdict[0].verdict),
  );
  check(
    'and the cancelled parcel is not put back on the board',
    (await dispatches(db, doomed.id)) === 0,
    'a cancelled parcel was dispatched because its charge arrived late',
  );

  const { rows: logged } = await db.query(
    `select count(*)::int as n from public.app_events where area = 'payment' and level = 'warning'`,
  );
  check('and an operator is told', logged[0].n >= 1);

  check(
    'and the sender is not emailed that their parcel is on its way',
    (await paymentEmails(db, doomed.id)).length === 0,
    'the charge settled and the parcel did not: this is the case the email trigger watches the\n' +
      '       booking for rather than the payment row, because a refund owed is not a shipment',
  );
}

// --------------------------------------- 7. the parcels that came before --

{
  const before = await build({ includePayments: false });
  const legacy = await postParcel(before, { hasPayments: false });

  await before.exec('reset role');
  await before.exec(read(PAYMENTS));

  const { rows } = await before.query(
    'select payment_status from public.bookings where id = $1',
    [legacy.id],
  );

  check(
    'a parcel posted before this migration is still paid for',
    rows[0].payment_status === 'paid',
    'adding the column with default \'pending\' marks every live parcel unpaid, empties the\n' +
      '       driver board and stops every dispatch in flight — which is why the default is\n' +
      "       changed to 'pending' only after the column exists",
  );

  await before.close();
}

await db.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('payment gate holds.\n');
