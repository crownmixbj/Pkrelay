/**
 * Runs document expiry and the dispatch mode switch against a real Postgres.
 *
 * Two features that share one function. `dispatch_booking` is the only door to
 * making an offer, and both of these close it — an expired licence closes it for
 * one driver, manual mode closes it for everybody. A test that exercises them
 * separately would miss the way they interact, and the interaction is where the
 * expensive failure lives: a parcel that no longer moves and no message saying
 * why.
 *
 * The failures worth catching here are all silent ones:
 *
 *   · a blocked driver *consuming* a dispatch, so the parcel waits behind them
 *   · the backfill locking out every existing driver on the day it runs
 *   · the reminder ladder re-sending the same rung every night
 *   · reminders going quiet at expiry, when they matter most
 *   · manual mode leaking through one of the five callers of dispatch_booking
 *   · returning to auto and the queue not moving
 *
 * ⚠ RLS is not exercised; the checks inside the functions are.
 *
 * Usage: node scripts/pg/documents-harness.mjs
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

const docs = read('supabase/migrations/20250101000031_document_expiry.sql');
const mode = read('supabase/migrations/20250101000032_dispatch_mode.sql');

console.log('\nrunning document expiry and dispatch mode against Postgres…\n');

// --------------------------------------------------------------- scaffold --

/*
 * Enough of Package Relay to make the two files run, and no more.
 *
 * `journey_matches` is a stub returning a column-driven answer rather than the
 * real matcher: this harness is about what happens *around* matching — the
 * document gate and the mode gate — and importing the real one would make every
 * failure here ambiguous between "the gate is wrong" and "the match is wrong".
 * `scripts/pg/dispatch-harness.mjs` owns the matcher.
 */
await db.exec(`
  create schema auth;
  create schema private;
  create table auth.users (id uuid primary key);
  create table private.app_settings (key text primary key, value text not null);
  create table public.who (id uuid, admin boolean default false);

  create function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1;
  $fn$;

  create function public.is_admin() returns boolean language sql stable as $fn$
    select coalesce((select admin from public.who limit 1), false);
  $fn$;

  create table public.app_events (
    id bigserial primary key,
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
    area text, message text,
    context jsonb, actor_id uuid,
    created_at timestamptz not null default now()
  );

  create table public.driver_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    full_name text default 'A Driver',
    phone text default '+2348000000000',
    state text default 'Oyo',
    base_city text,
    vehicle_type text default 'Motorcycle',
    status text default 'approved',
    documents jsonb default '{}'::jsonb
  );

  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    tracking_id text default 'LOCI-0001',
    sender_id uuid,
    driver_id uuid,
    status text default 'Booked',
    origin_city text default 'Ibadan',
    destination_city text default 'Ibadan',
    weight numeric default 2,
    delivery_type text default 'local',
    estimated_fee numeric default 3000,
    created_at timestamptz not null default now()
  );

  create table public.driver_journeys (
    id uuid primary key default gen_random_uuid(),
    driver_id uuid not null,
    status text default 'open',
    origin_city text default 'Ibadan',
    destination_city text default 'Ibadan',
    departs_after timestamptz default now(),
    departs_before timestamptz default now() + interval '6 hours',
    departure_time timestamptz default now() + interval '1 hour',
    capacity_kg numeric default 20,
    mode text default 'flash',
    created_at timestamptz not null default now()
  );

  create table public.dispatch_offers (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null,
    journey_id uuid,
    driver_id uuid not null,
    status text not null default 'offered',
    expires_at timestamptz not null,
    responded_at timestamptz,
    created_at timestamptz not null default now()
  );
  create unique index dispatch_offers_one_live
    on public.dispatch_offers (booking_id) where status = 'offered';

  -- Stubs. See the note above on why the matcher is not the real one.
  create function public.journey_matches(
    j_origin text, j_dest text, j_after timestamptz, j_before timestamptz,
    j_capacity numeric, p_origin text, p_dest text, p_weight numeric,
    j_mode text, j_departure timestamptz
  ) returns boolean language sql stable as $fn$
    select j_origin = p_origin and j_dest = p_dest and j_capacity >= p_weight;
  $fn$;

  create function public.offer_hold(is_local boolean) returns interval
    language sql stable as $fn$ select case when is_local then interval '5 minutes'
      else interval '10 minutes' end; $fn$;

  create function public.offer_cooldown() returns interval
    language sql stable as $fn$ select interval '15 minutes'; $fn$;
`);

// --------------------------------------------------------- the real files --

/**
 * Every function in a file, in the order the file declares them.
 *
 * ⚠ FILE ORDER, and this is not a tidiness preference — it is the fix for a bug
 *   this harness let through to production.
 *
 *   `20250101000031_document_expiry.sql` shipped with `document_state` defined *above*
 *   `document_warning_days`, which it calls. Postgres validates the body of a
 *   `language sql` function at creation time, so that fails outright with
 *   `42883: function public.document_warning_days() does not exist`.
 *
 *   The harness did not catch it because it loaded functions from a
 *   hand-written list, and I happened to write that list in dependency order.
 *   So the harness was proving that *some* ordering works, while the file
 *   contained one that does not — the exact class of bug an execution test is
 *   supposed to make impossible.
 *
 *   Deriving the order from the file means the sequence under test is the
 *   sequence Supabase will run.
 */
function functionsInFileOrder(sql) {
  return [...sql.matchAll(/^create or replace function (public\.\w+)/gm)].map(
    (match) => `create or replace function ${match[1]}`,
  );
}

await run('20250101000031_document_expiry.sql loads', async () => {
  await db.exec(extractTable(docs, 'public.document_kinds'));
  await db.exec(extractStatement(docs, 'insert into public.document_kinds'));
  await db.exec(extractTable(docs, 'public.driver_documents'));

  for (const fn of functionsInFileOrder(docs)) {
    // `dispatch_booking` is redefined at the end of this file and again in 32.
    // 32 is the definition that survives, and it is loaded below.
    if (fn.endsWith('public.dispatch_booking')) continue;
    await db.exec(extractFunction(docs, fn));
  }
});

await run('20250101000032_dispatch_mode.sql loads', async () => {
  for (const fn of functionsInFileOrder(mode)) {
    await db.exec(extractFunction(mode, fn));
  }
});

// ------------------------------------------------------------------ people --

const DRIVER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const SENDER = '33333333-3333-3333-3333-333333333333';
const ADMIN = '44444444-4444-4444-4444-444444444444';

const be = async (id, admin = false) => {
  await q('delete from public.who');
  await q('insert into public.who (id, admin) values ($1, $2)', [id, admin]);
};

const newParcel = async (over = {}) => {
  const rows = await q(
    `insert into public.bookings (sender_id, origin_city, destination_city, weight)
     values ($1, $2, $3, $4) returning id`,
    [SENDER, over.origin ?? 'Ibadan', over.destination ?? 'Ibadan', over.weight ?? 2],
  );
  return rows[0].id;
};

await run('seed', async () => {
  for (const id of [DRIVER, OTHER, SENDER, ADMIN]) {
    await q('insert into auth.users (id) values ($1)', [id]);
  }
  await q(
    `insert into public.driver_applications (user_id, full_name, status)
     values ($1, 'Esther Adedapo', 'approved'), ($2, 'Noah Adedapo', 'approved')`,
    [DRIVER, OTHER],
  );
  await q('insert into public.driver_journeys (driver_id) values ($1), ($2)', [DRIVER, OTHER]);
});

// ------------------------------------------------------ 1. the policy table --

await run('1. only the documents that genuinely expire are blocking', async () => {
  const rows = await q(
    `select key, expiry_required, expiry_allowed, blocks_dispatch
     from public.document_kinds order by sort_order`,
  );
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));

  check(
    'licence and insurance require a date and block dispatch',
    by.license.expiry_required &&
      by.license.blocks_dispatch &&
      by.insurance.expiry_required &&
      by.insurance.blocks_dispatch,
  );
  /*
   * The government ID slots used to allow an optional date. They no longer do.
   *
   * They accept a NIN slip, a National ID card or a Voter's Card — none of
   * which expires — and a NIN is what almost everybody uploads. An optional
   * field on a document with no date printed on it does not stay empty; it gets
   * an invented date, and the reminder ladder then chases a driver about a
   * document that cannot lapse.
   */
  check(
    'the government ID slots carry no expiry date at all',
    !by.id.expiry_allowed &&
      !by.id.expiry_required &&
      !by.id.blocks_dispatch &&
      !by.guarantorId.expiry_allowed &&
      !by.guarantorId.blocks_dispatch,
  );
  check(
    'a vehicle photograph has no expiry field either',
    !by.vehicle.expiry_allowed && !by.vehicle.blocks_dispatch,
    'a date on a photo of a bike is a date somebody invented, and reminders would then fire on fiction',
  );
  check(
    'so only the licence and insurance ask for one',
    rows
      .filter((r) => r.expiry_allowed)
      .map((r) => r.key)
      .sort()
      .join(',') === 'insurance,license',
    rows
      .filter((r) => r.expiry_allowed)
      .map((r) => r.key)
      .join(','),
  );
});

// ------------------------------------------------- 2. the dateless backfill --

await run('2. an existing driver with no dates is not locked out', async () => {
  await be(DRIVER);
  await q(
    `insert into public.driver_documents (driver_id, kind, path, status)
     values ($1, 'license', 'u1/license.jpg', 'verified')`,
    [DRIVER],
  );

  const [{ ok }] = await q('select public.documents_permit_dispatch($1) as ok', [DRIVER]);
  check(
    'a blocking document with no expiry date permits dispatch',
    ok === true,
    'the backfill cannot invent dates, so "no valid document" would have taken every working driver off the road the day this migration ran',
  );

  const blockers = await q('select * from public.dispatch_blockers($1)', [DRIVER]);
  check('and nothing is reported as blocking them', blockers.length === 0);
});

// -------------------------------------------------- 3. expiry stops dispatch --

await run('3. an expired licence stops offers reaching that driver', async () => {
  await be(DRIVER);
  await q(
    `update public.driver_documents set expires_at = current_date - 1
     where driver_id = $1 and kind = 'license'`,
    [DRIVER],
  );

  const [{ ok }] = await q('select public.documents_permit_dispatch($1) as ok', [DRIVER]);
  check('the gate closes', ok === false);

  const blockers = await q('select * from public.dispatch_blockers($1)', [DRIVER]);
  check(
    'and the reason is retrievable, with the document and the date',
    blockers.length === 1 && blockers[0].kind === 'license' && blockers[0].days_left === -1,
    JSON.stringify(blockers),
  );

  /*
   * The load-bearing assertion of the whole file.
   *
   * The blocked driver must not *consume* the dispatch. If the gate were
   * checked after choosing rather than inside the candidate query, this parcel
   * would come back unoffered and wait for the next sweep — with a perfectly
   * available driver sitting behind the blocked one.
   */
  const parcel = await newParcel();
  const [{ dispatch_booking: offerId }] = await q('select public.dispatch_booking($1)', [parcel]);
  const offers = await q('select driver_id from public.dispatch_offers where booking_id = $1', [
    parcel,
  ]);

  check(
    'the parcel goes to the other driver in the same pass, not nowhere',
    offerId !== null && offers.length === 1 && offers[0].driver_id === OTHER,
    `offer=${offerId} went to ${offers[0]?.driver_id}`,
  );
});

await run('4. renewing it puts the driver back in the pool', async () => {
  await be(DRIVER);
  await q('select public.set_document_expiry($1, $2)', [
    'license',
    new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10),
  ]);

  /*
   * The date is now read-only, and the server says so — not just the form.
   *
   * The app hides the field on an in-date document, which stops the honest
   * mistake and nothing else: this is an rpc call and anybody can send it. If
   * the rule only lived in the client, "you cannot push the date out on a valid
   * licence" would be a statement about a form rather than about the system.
   */
  let locked = '';
  try {
    await q('select public.set_document_expiry($1, $2)', [
      'license',
      new Date(Date.now() + 900 * 864e5).toISOString().slice(0, 10),
    ]);
  } catch (error) {
    locked = error.message;
  }
  check(
    'and the date locks again while it is comfortably in date',
    /valid until/i.test(locked) && /renewal is due/i.test(locked),
    locked || 'a driver pushed the date out on a licence that had not expired',
  );

  const [{ ok }] = await q('select public.documents_permit_dispatch($1) as ok', [DRIVER]);
  check('the gate reopens', ok === true);

  // Take the other driver out of the running so the choice is unambiguous.
  await q("update public.driver_journeys set status = 'closed' where driver_id = $1", [OTHER]);
  const parcel = await newParcel();
  await q('select public.dispatch_booking($1)', [parcel]);
  const offers = await q('select driver_id from public.dispatch_offers where booking_id = $1', [
    parcel,
  ]);
  check('and they are offered work again', offers[0]?.driver_id === DRIVER);
  await q("update public.driver_journeys set status = 'open' where driver_id = $1", [OTHER]);
});

// ------------------------------------------------------- 5. entry validation --

await run('4b. but it unlocks inside the renewal window', async () => {
  await be(DRIVER);
  // Ten days out — inside the 30-day default warning window.
  await q(
    `update public.driver_documents set expires_at = current_date + 10
     where driver_id = $1 and kind = 'license'`,
    [DRIVER],
  );

  let message = '';
  try {
    await q('select public.set_document_expiry($1, $2)', [
      'license',
      new Date(Date.now() + 700 * 864e5).toISOString().slice(0, 10),
    ]);
  } catch (error) {
    message = error.message;
  }
  check(
    'a driver who renews early can record the new date',
    message === '',
    `${message} — refusing here means an organised driver loses a day's work for renewing on time`,
  );
});

await run('5. a date already in the past is refused at upload', async () => {
  await be(DRIVER);
  let message = '';
  try {
    await q('select public.record_document($1, $2, $3)', [
      'insurance',
      'u1/insurance.pdf',
      new Date(Date.now() - 864e5).toISOString().slice(0, 10),
    ]);
  } catch (error) {
    message = error.message;
  }
  check(
    'and the refusal names the document and the date',
    /expired on/i.test(message) && /insurance/i.test(message),
    message || 'accepted a document that was already out of date',
  );
});

await run('6. a required expiry cannot be skipped, and a forbidden one cannot be set', async () => {
  await be(DRIVER);

  let missing = '';
  try {
    await q('select public.record_document($1, $2)', ['insurance', 'u1/insurance.pdf']);
  } catch (error) {
    missing = error.message;
  }
  check('insurance without a date is refused', /expiry date/i.test(missing), missing);

  let forbidden = '';
  try {
    await q('select public.record_document($1, $2, $3)', [
      'vehicle',
      'u1/vehicle.jpg',
      '2030-01-01',
    ]);
  } catch (error) {
    forbidden = error.message;
  }
  check(
    'a vehicle photograph with a date is refused',
    /does not have an expiry/i.test(forbidden),
    forbidden,
  );

  const ok = await q('select public.record_document($1, $2) as id', ['vehicle', 'u1/vehicle.jpg']);
  check('but without one it is accepted', ok[0].id !== null);
});

// ------------------------------------------------------- 7. replacement resets --

await run('7. a replacement is unreviewed and starts a fresh reminder ladder', async () => {
  await be(ADMIN, true);
  const [{ id }] = await q(
    "select id from public.driver_documents where driver_id = $1 and kind = 'license'",
    [DRIVER],
  );
  await q('select public.review_document($1, $2)', [id, 'verified']);
  await q(
    `update public.driver_documents set reminder_stage = 3, reminded_at = now()
     where id = $1`,
    [id],
  );

  await be(DRIVER);
  await q('select public.record_document($1, $2, $3)', [
    'license',
    'u1/license.jpg',
    new Date(Date.now() + 500 * 864e5).toISOString().slice(0, 10),
  ]);

  const [row] = await q(
    "select status, reminder_stage from public.driver_documents where driver_id = $1 and kind = 'license'",
    [DRIVER],
  );
  check(
    'the verified badge does not survive a new file',
    row.status === 'pending',
    'otherwise a driver swaps an approved licence for anything at all and keeps the badge',
  );
  check(
    'and the ladder resets',
    row.reminder_stage === null,
    'otherwise a renewal three years out still sits at "expires in 7 days" and sends nothing until it nearly is',
  );
});

// ------------------------------------------------------------- 8. the ladder --

await run('8. the reminder ladder climbs once per rung', async () => {
  const ladder = [30, 14, 7, 1];
  const stage = async (daysLeft) => {
    const [{ reminder_stage_for: s }] = await q('select public.reminder_stage_for($1, $2)', [
      daysLeft,
      ladder,
    ]);
    return s;
  };

  check('nothing due at 45 days', (await stage(45)) === null);
  check('rung 1 at 30 days', (await stage(30)) === 1);
  check('still rung 1 at 20 days', (await stage(20)) === 1);
  check('rung 2 at 14 days', (await stage(14)) === 2);
  check('rung 4 on the last day', (await stage(1)) === 4);
  check('rung 4 on the day itself', (await stage(0)) === 4);
  check(
    'and a rung past the end once expired',
    (await stage(-1)) === 5 && (await stage(-90)) === 5,
    'past expiry every day is the same rung, which is what lets the sweep repeat it daily',
  );
  check('no expiry, no rung', (await stage(null)) === null);
});

await run('9. the sweep sends each rung once, and repeats only after expiry', async () => {
  await be(DRIVER);
  await q("delete from public.driver_documents where kind = 'insurance'");
  await q(
    `insert into public.driver_documents (driver_id, kind, path, expires_at)
     values ($1, 'insurance', 'u1/insurance.pdf', current_date + 10)`,
    [DRIVER],
  );
  await q("delete from public.app_events where area = 'documents'");

  const sweep = async () => {
    const [{ sweep_document_expiry: n }] = await q('select public.sweep_document_expiry()');
    return n;
  };

  check('the first sweep sends a notice', (await sweep()) >= 1);
  check(
    'a second sweep the same day sends nothing',
    (await sweep()) === 0,
    'a daily job that re-sends the same rung is a daily job drivers mute',
  );

  // Move it to expired and sweep again.
  await q(
    `update public.driver_documents set expires_at = current_date - 3
     where driver_id = $1 and kind = 'insurance'`,
    [DRIVER],
  );
  check('crossing the expiry sends the block notice', (await sweep()) >= 1);

  const [warn] = await q(
    `select level, message, context from public.app_events
     where area = 'documents' order by id desc limit 1`,
  );
  check(
    'and it says the driver has stopped receiving parcels',
    warn.level === 'warning' && /no longer being offered/i.test(warn.message),
    `${warn.level}: ${warn.message}`,
  );

  check('it does not repeat within the same day', (await sweep()) === 0);

  await q("update public.driver_documents set reminded_at = now() - interval '1 day'");
  check(
    'but it does repeat the next day',
    (await sweep()) >= 1,
    'the one notice a driver cannot afford to miss is the one saying why the offers stopped',
  );
});

// --------------------------------------------------------- 10. dispatch mode --

await run('10. auto is the default, including when the setting is missing', async () => {
  await q("delete from private.app_settings where key = 'dispatch_mode'");
  const [{ dispatch_mode: m }] = await q('select public.dispatch_mode()');
  check(
    'a missing setting means auto',
    m === 'auto',
    'the inverse default would let one absent row silently halt dispatch platform-wide',
  );

  await q("insert into private.app_settings (key, value) values ('dispatch_mode', 'nonsense')");
  const [{ dispatch_mode: junk }] = await q('select public.dispatch_mode()');
  check('and so does an unreadable one', junk === 'auto');
  await q("delete from private.app_settings where key = 'dispatch_mode'");
});

await run('11. only an admin may flip the switch', async () => {
  await be(DRIVER);
  let message = '';
  try {
    await q('select public.set_dispatch_mode($1)', ['manual']);
  } catch (error) {
    message = error.message;
  }
  check('a driver cannot', /not allowed/i.test(message), message);

  await be(ADMIN, true);
  const [{ set_dispatch_mode: m }] = await q('select public.set_dispatch_mode($1)', ['manual']);
  check('an admin can, and is told what it settled on', m === 'manual');

  const [event] = await q(
    `select level, context from public.app_events
     where area = 'dispatch' and message like 'dispatch mode set to%' order by id desc limit 1`,
  );
  check(
    'the switch into manual is logged as a warning, with the queue depth',
    event.level === 'warning' && 'unassigned_parcels' in event.context,
    JSON.stringify(event),
  );
});

await run('12. manual mode stops new offers without touching live ones', async () => {
  // A live offer from before the switch.
  await be(ADMIN, true);
  const held = await newParcel();
  await q('select public.set_dispatch_mode($1)', ['auto']);
  await q('select public.dispatch_booking($1)', [held]);
  const before = await q(
    "select id from public.dispatch_offers where booking_id = $1 and status = 'offered'",
    [held],
  );
  check('an offer exists while auto is on', before.length === 1);

  await q('select public.set_dispatch_mode($1)', ['manual']);

  const after = await q(
    "select id from public.dispatch_offers where booking_id = $1 and status = 'offered'",
    [held],
  );
  check(
    'switching to manual leaves it alone',
    after.length === 1,
    'manual is about what the matcher does next, not a freeze on work already offered',
  );

  const fresh = await newParcel();
  const [{ dispatch_booking: made }] = await q('select public.dispatch_booking($1)', [fresh]);
  check('but no new offer is made', made === null);

  const none = await q(
    'select count(*)::int as n from public.dispatch_offers where booking_id = $1',
    [fresh],
  );
  check('and nothing was written', none[0].n === 0);
});

await run('13. returning to auto sweeps the backlog immediately', async () => {
  await be(ADMIN, true);

  /*
   * Only parcels that have NO offer yet.
   *
   * My first version took every unassigned parcel, and one of them already
   * carried a live offer from scenario 12 — so the assertion counted that and
   * passed even with the sweep deleted. Mutation testing caught it. What is
   * under test is whether flipping back to auto *creates* an offer, so the
   * starting set has to be parcels for which creating one is the only way the
   * count can move.
   */
  const waiting = await q(
    `select b.id from public.bookings b
     where b.status = 'Booked' and b.driver_id is null
       and not exists (
         select 1 from public.dispatch_offers o
         where o.booking_id = b.id and o.status = 'offered'
       )`,
  );
  check('there is an unoffered backlog to clear', waiting.length >= 1, `${waiting.length} waiting`);

  await q('select public.set_dispatch_mode($1)', ['auto']);

  const offered = await q(
    `select count(*)::int as n from public.dispatch_offers o
     where o.status = 'offered' and o.booking_id = any($1)`,
    [waiting.map((r) => r.id)],
  );
  check(
    'flipping back places them without waiting for the next sweep',
    offered[0].n >= 1,
    'an operator watching an unchanged queue concludes the toggle is broken and assigns by hand anyway',
  );
});

// ------------------------------------------------------ 14. manual assignment --

await run('14. an admin can assign by hand, in either mode', async () => {
  await be(ADMIN, true);
  const parcel = await newParcel();

  await q('select public.set_dispatch_mode($1)', ['manual']);
  await q('select public.admin_assign_parcel($1, $2)', [parcel, OTHER]);

  const [row] = await q('select driver_id from public.bookings where id = $1', [parcel]);
  check('the parcel is placed', row.driver_id === OTHER);

  const auto = await newParcel();
  await q('select public.set_dispatch_mode($1)', ['auto']);
  await q('select public.admin_assign_parcel($1, $2)', [auto, OTHER]);
  const [row2] = await q('select driver_id from public.bookings where id = $1', [auto]);
  check(
    'and it works in auto too',
    row2.driver_id === OTHER,
    'forcing an operator to halt the platform to place one difficult parcel makes the toggle something people flip far too readily',
  );
});

await run('15. hand-assigning settles any live offer on that parcel', async () => {
  /*
   * Scenario 9 left this driver's insurance three days past its date, which is
   * exactly right for the scenario that set it and wrong for this one — the
   * assertion below is about offers being settled, and a driver refused for an
   * unrelated document turns it into a test of scenario 16. Renewed here so
   * both drivers are eligible; 16 blocks one again on its own terms.
   */
  await q(
    `update public.driver_documents set expires_at = current_date + 200
     where driver_id = $1 and kind = 'insurance'`,
    [DRIVER],
  );

  await be(ADMIN, true);
  await q('select public.set_dispatch_mode($1)', ['auto']);
  const parcel = await newParcel();
  await q('select public.dispatch_booking($1)', [parcel]);

  const live = await q(
    "select driver_id from public.dispatch_offers where booking_id = $1 and status = 'offered'",
    [parcel],
  );
  check('an offer is live', live.length === 1);

  const takenBy = live[0].driver_id === OTHER ? DRIVER : OTHER;
  await q('select public.admin_assign_parcel($1, $2)', [parcel, takenBy]);

  const stillLive = await q(
    "select 1 from public.dispatch_offers where booking_id = $1 and status = 'offered'",
    [parcel],
  );
  check(
    'the other driver is not left counting down on a parcel that is gone',
    stillLive.length === 0,
    'they would tap Accept and be refused for a parcel they were legitimately offered a minute earlier',
  );
});

await run('16. an admin cannot hand a parcel to a blocked driver', async () => {
  await be(DRIVER);
  await q(
    `update public.driver_documents set expires_at = current_date - 1
     where driver_id = $1 and kind = 'license'`,
    [DRIVER],
  );

  await be(ADMIN, true);
  const parcel = await newParcel();
  let message = '';
  try {
    await q('select public.admin_assign_parcel($1, $2)', [parcel, DRIVER]);
  } catch (error) {
    message = error.message;
  }
  check(
    'the document block is a legal limit, not a matching preference',
    /expired document/i.test(message),
    message || 'an admin clicked past an expired licence',
  );

  const [row] = await q('select driver_id from public.bookings where id = $1', [parcel]);
  check('and the parcel is untouched', row.driver_id === null);
});

// -------------------------------------------------- 17. what the human sees --

await run('17. the candidate list shows refusals, not just matches', async () => {
  await be(ADMIN, true);
  const parcel = await newParcel();
  const rows = await q('select * from public.assignable_drivers($1)', [parcel]);

  check('both approved drivers appear', rows.length === 2, `${rows.length} rows`);

  const blocked = rows.find((r) => r.driver_id === DRIVER);
  check(
    'the blocked one is listed, marked ineligible, with a reason',
    blocked && blocked.eligible === false && /expired/i.test(blocked.note),
    JSON.stringify(blocked),
  );
  check(
    'and the eligible one sorts first',
    rows[0].driver_id === OTHER,
    'a list that hides refusals is a slower copy of the automation; the human is here because they know something it does not',
  );
});

await run('18. the queue is visible in both modes', async () => {
  await be(ADMIN, true);
  for (const m of ['auto', 'manual']) {
    await q('select public.set_dispatch_mode($1)', [m]);
    const [health] = await q('select * from public.dispatch_health()');
    check(`${m}: the mode is reported`, health.mode === m);
    check(
      `${m}: the waiting queue is counted`,
      typeof health.unassigned === 'number' && health.unassigned >= 0,
      JSON.stringify(health),
    );
    check(
      `${m}: blocked drivers are counted`,
      health.blocked_drivers >= 1,
      'manual mode with no visible backlog is a foot-gun with a hair trigger',
    );
  }
});

await run('19. a driver sees every slot, filled or not', async () => {
  await be(DRIVER);
  const rows = await q('select * from public.my_documents()');

  /*
   * Six now, not five: the licence became two slots, front and back.
   *
   * Asserted against the policy table rather than a literal, so adding a
   * document kind does not fail a test that has nothing to say about it — what
   * matters is that `my_documents` returns a row for *every* slot, including
   * ones the driver never filled.
   */
  const [{ n: kinds }] = await q('select count(*)::int as n from public.document_kinds');
  check('every slot comes back', rows.length === kinds, `${rows.length} rows vs ${kinds} kinds`);

  const missing = rows.find((r) => r.kind === 'guarantorId');
  check(
    'one never uploaded is a row, not an absence',
    missing && missing.state === 'missing' && missing.path === null,
    'otherwise every client has to compute the difference against the policy table, differently',
  );

  const licence = rows.find((r) => r.kind === 'license');
  check('an expired one says so', licence.state === 'expired', JSON.stringify(licence));
});

// ---------------------------------------------------------------------------

await db.close();

if (failures > 0) {
  console.error(`\n${failures} failing assertion${failures === 1 ? '' : 's'}.`);
  process.exit(1);
}

console.log(
  'PASS — an expired licence is skipped inside the candidate query so the parcel still moves,\n' +
    '       a driver with no recorded date is never locked out by the backfill, each reminder\n' +
    '       rung is sent once but the expiry notice repeats daily, manual mode stops new offers\n' +
    '       without disturbing live ones, returning to auto clears the backlog at once, and no\n' +
    '       admin can hand a parcel to a driver whose documents have lapsed.',
);
