/**
 * Runs dispatch against a real Postgres.
 *
 * Every SQL file in this project until now was reviewed by reading it. That
 * caught a lot and missed two things in one function on the same day: a column
 * reference Postgres calls ambiguous, and an `exists` that was always true
 * because it counted the row inserted four lines above it. Neither is subtle
 * once executed; neither is visible by inspection.
 *
 * PGlite is Postgres compiled to WebAssembly. It runs in-process with no server
 * and no root, which is why this is possible here at all.
 *
 * ⚠ What this harness is not.
 *
 *   It builds the smallest schema the dispatch functions need — the tables they
 *   touch and nothing else — and loads the real function text out of the
 *   migrations. It does not run RLS, `auth.uid()`, pg_cron, pg_net or storage,
 *   so it proves the *logic* is right and says nothing about whether the
 *   policies are. A pass here means the SQL executes and behaves; it does not
 *   mean the migration is safe to run on production.
 *
 * Usage: node scripts/pg/dispatch-harness.mjs
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

/**
 * Pulls one function definition out of a migration, verbatim.
 *
 * Verbatim is the point: a harness that retyped the function would be testing
 * the copy. This extracts the exact text that will be run on the database, so a
 * typo inside it fails here.
 */
function statementStart(sql, signatureStart) {
  /*
   * Anchored to the start of a line.
   *
   * These migrations quote their own SQL inside header comments — 22 explains
   * the volatility bug by reproducing the `create or replace function
   * public.journey_matches(` line it is fixing. A plain indexOf finds the
   * commentary first and extracts the prose, which is how the first run of this
   * harness tried to execute a paragraph of English.
   */
  const at = sql.search(
    new RegExp(`^${signatureStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'),
  );
  if (at === -1) throw new Error(`not found at line start: ${signatureStart}`);
  return at;
}

function extractFunction(sql, signatureStart) {
  const at = statementStart(sql, signatureStart);
  // Function bodies are dollar-quoted with $$; the definition ends at the first
  // `$$;` after the $$ that opens the body.
  const bodyOpen = sql.indexOf('$$', at);
  const end = sql.indexOf('$$;', bodyOpen + 2);
  if (end === -1) throw new Error(`unterminated body: ${signatureStart}`);
  return sql.slice(at, end + 3);
}

/** A plain statement, up to its terminating semicolon. */
function extractStatement(sql, signatureStart) {
  const at = statementStart(sql, signatureStart);
  const end = sql.indexOf(';', at);
  if (end === -1) throw new Error(`unterminated statement: ${signatureStart}`);
  return sql.slice(at, end + 1);
}

/*
 * A failing statement should read like a failing assertion.
 *
 * PGlite bundles its wire protocol, so an unhandled rejection prints the whole
 * minified module before the error — the first run of this file buried
 * `column reference "booking_id" is ambiguous` under 40kb of transpiled
 * JavaScript. The message and the SQL that caused it are the only parts anyone
 * needs.
 */
async function run(label, fn) {
  try {
    await fn();
  } catch (error) {
    failures += 1;
    console.error(`FAIL — ${label}`);
    console.error(`       ${error.message}`);
    if (error.hint) console.error(`       hint: ${error.hint}`);
    if (error.query) console.error(`       in: ${String(error.query).trim().split('\n')[0]}…`);
  }
}

const db = await PGlite.create();

// ------------------------------------------------------------- the schema --

/*
 * Only the columns dispatch reads. `bookings` has 48 columns in production and
 * dispatch touches six of them; carrying the rest would be noise that rots.
 */
await db.exec(`
  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    origin_city text not null,
    destination_city text not null,
    weight numeric,
    status text not null default 'Booked',
    driver_id uuid,
    created_at timestamptz not null default now()
  );

  create table public.driver_journeys (
    id uuid primary key default gen_random_uuid(),
    driver_id uuid not null,
    origin_city text not null,
    destination_city text not null,
    departs_after timestamptz not null,
    departs_before timestamptz not null,
    capacity_kg numeric not null,
    vehicle_type text not null default 'Motorcycle',
    mode text not null default 'scheduled',
    status text not null default 'open',
    created_at timestamptz not null default now(),
    constraint journey_window_ordered check (departs_before > departs_after)
  );

  create table public.dispatch_offers (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null references public.bookings(id),
    journey_id uuid not null references public.driver_journeys(id),
    driver_id uuid not null,
    status text not null default 'offered',
    offered_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '10 minutes'),
    responded_at timestamptz
  );

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
    area text, message text,
    context jsonb, actor_id uuid,
    created_at timestamptz not null default now()
  );
`);

// The real functions, lifted out of the real migrations.
const windows = read('supabase/migrations/20250101000021_offer_windows.sql');
const volatility = read('supabase/migrations/20250101000022_matcher_volatility.sql');
const cooldownSql = read('supabase/migrations/20250101000023_offer_cooldown.sql');
const departureSql = read('supabase/migrations/20250101000026_departure_time.sql');
const editSql = read('supabase/migrations/20250101000027_journey_edit.sql');

await db.exec(extractFunction(windows, 'create or replace function public.offer_hold('));
await db.exec(extractFunction(volatility, 'create or replace function public.journey_matches('));
await db.exec(extractFunction(cooldownSql, 'create or replace function public.offer_cooldown('));
await db.exec(
  extractStatement(
    cooldownSql,
    'create unique index if not exists dispatch_offers_one_live_per_booking',
  ),
);
await db.exec(extractFunction(cooldownSql, 'create or replace function public.dispatch_booking('));

/*
 * 26 on top, in the order the migration applies it: the column, the sync
 * trigger, the new matcher signature, then the rebuilt caller. Running it in
 * this order is itself a test — the drop has to come before the create, and the
 * caller after both.
 */
await db.exec(
  'alter table public.driver_journeys add column if not exists departure_time timestamptz;',
);
await db.exec('alter table public.driver_journeys alter column departs_after set default now();');
await db.exec(
  extractFunction(departureSql, 'create or replace function public.journey_departure_sync('),
);
await db.exec(`
  drop trigger if exists driver_journeys_departure_sync on public.driver_journeys;
  create trigger driver_journeys_departure_sync
    before insert or update on public.driver_journeys
    for each row execute function public.journey_departure_sync();
`);
await db.exec(extractStatement(departureSql, 'drop function if exists public.journey_matches('));
await db.exec(extractFunction(departureSql, 'create or replace function public.journey_matches('));
await db.exec(extractFunction(departureSql, 'create or replace function public.dispatch_booking('));

/*
 * 27 needs `auth.uid()`, which PGlite has no notion of. A stub in an `auth`
 * schema lets the real function text run unchanged — the ownership checks are
 * a large part of what is worth testing, and rewriting the functions to remove
 * them would test a different function.
 */
await db.exec(`
  create schema auth;
  create table public.who (id uuid);
  create function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1;
  $fn$;
`);
await db.exec(extractFunction(editSql, 'create or replace function public.cancel_journey('));
await db.exec(extractFunction(editSql, 'create or replace function public.update_journey('));

// ------------------------------------------------------------- the actors --

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

const newParcel = async (origin = 'Ibadan', destination = 'Ibadan', weight = 5) =>
  (
    await q(
      `insert into public.bookings (origin_city, destination_city, weight)
       values ($1, $2, $3) returning id`,
      [origin, destination, weight],
    )
  )[0].id;

const goOnline = async (driver, city = 'Ibadan') =>
  (
    await q(
      `insert into public.driver_journeys
         (driver_id, origin_city, destination_city, departs_after, departs_before, capacity_kg, mode)
       values ($1, $2, $2, now(), now() + interval '2 hours', 20, 'flash') returning id`,
      [driver, city],
    )
  )[0].id;

/**
 * Declares an interstate route — the Schedule My Journey path.
 *
 * Sends only `departure_time`; `departs_before` is the trigger's job, and
 * letting the harness set it would be testing the harness.
 */
const declareRoute = async (driver, origin = 'Ibadan', destination = 'Lagos', hoursAway = 6) =>
  (
    await q(
      `insert into public.driver_journeys
         (driver_id, origin_city, destination_city, departs_before, capacity_kg, mode, departure_time)
       values ($1, $2, $3, now() + interval '1 minute', 40, 'scheduled',
               now() + ($4 || ' hours')::interval) returning id`,
      [driver, origin, destination, String(hoursAway)],
    )
  )[0].id;

const dispatch = async (booking) =>
  (await q('select public.dispatch_booking($1) as id', [booking]))[0].id;

const liveOffer = async (booking) =>
  (
    await q(
      `select driver_id, offered_at, expires_at from public.dispatch_offers
        where booking_id = $1 and status = 'offered' and expires_at > now()`,
      [booking],
    )
  )[0] ?? null;

/** Answers an offer the way `respond_to_offer` does, without needing auth.uid(). */
const decline = async (booking) =>
  q(
    `update public.dispatch_offers set status = 'declined', responded_at = now()
      where booking_id = $1 and status = 'offered'`,
    [booking],
  );

/** Lets the countdown run out, and ages the row as the sweeper would find it. */
const lapse = async (booking, minutesAgo) =>
  q(
    `update public.dispatch_offers
        set status = 'expired',
            offered_at = now() - ($2 || ' minutes')::interval - interval '5 minutes',
            expires_at = now() - ($2 || ' minutes')::interval,
            responded_at = now()
      where booking_id = $1 and status = 'offered'`,
    [booking, String(minutesAgo)],
  );

// ================================================================ scenarios ==

console.log('running dispatch against Postgres…\n');

// --- 1. it runs at all -------------------------------------------------------

await run('scenario 1 — a first offer', async () => {
  const parcel = await newParcel();
  await goOnline(A);
  const offerId = await dispatch(parcel);

  check(
    'a local parcel is offered to a flash driver in that city',
    offerId !== null,
    'this is the call that raised 42702 on the real database — an ambiguous column reference inside the audit insert',
  );

  const events = await q(
    "select context from public.app_events where message = 'parcel offered to a driver'",
  );
  check('and the offer is logged', events.length === 1);
  check(
    'the log records the hold and the cooldown',
    Number(events[0]?.context?.hold_minutes) === 5 &&
      Number(events[0]?.context?.cooldown_minutes) === 15,
  );
  check(
    'the first offer to a driver is not marked a repeat',
    events[0]?.context?.repeat === false,
    'the exists counted the row inserted four lines above it, so this was true every time — a flag that is always set is not a flag',
  );
});

// --- 2. a decline holds that driver off for 15 minutes -----------------------

await run('scenario 2 \u2014 a decline cools down for fifteen minutes', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  const parcel = await newParcel();
  await goOnline(A);

  await dispatch(parcel);
  await decline(parcel);
  const again = await dispatch(parcel);

  check(
    'a declined parcel does not come straight back to the same driver',
    again === null && (await liveOffer(parcel)) === null,
  );

  // Age the decline past the cooldown.
  await q(
    "update public.dispatch_offers set responded_at = now() - interval '16 minutes' where booking_id = $1",
    [parcel],
  );
  const back = await dispatch(parcel);
  check(
    'but it does after fifteen minutes',
    back !== null,
    'this is the change that was asked for — a decline used to be permanent',
  );

  const events = await q(
    "select context from public.app_events where message = 'parcel offered to a driver' order by created_at desc limit 1",
  );
  check('and the second offer is marked a repeat', events[0]?.context?.repeat === true);
});

// --- 3. the parcel keeps rotating while one driver cools off -----------------

await run('scenario 3 \u2014 the parcel rotates onward immediately', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  const parcel = await newParcel();
  await goOnline(A);
  await goOnline(B);

  await dispatch(parcel);
  const first = (await liveOffer(parcel)).driver_id;
  await decline(parcel);
  await dispatch(parcel);
  const second = await liveOffer(parcel);

  check(
    'a decline moves the parcel to the other driver immediately',
    second !== null && second.driver_id !== first,
    'queue continuity — the cooldown must exclude a driver, not park the parcel',
  );
});

// --- 4. the cooling driver still gets other parcels --------------------------

await run('scenario 4 \u2014 the cooling driver keeps other work', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  const first = await newParcel();
  await goOnline(A);

  await dispatch(first);
  await decline(first);

  const second = await newParcel();
  await dispatch(second);
  const offer = await liveOffer(second);

  check(
    'a driver cooling off on one parcel is offered a different one straight away',
    offer !== null && offer.driver_id === A,
    'the cooldown is scoped by booking_id; without that scope it would bench the driver entirely',
  );
});

// --- 5. a lapse counts from when it lapsed, not when it was swept ------------

await run('scenario 5 \u2014 a late sweep does not extend the cooldown', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  const parcel = await newParcel();
  await goOnline(A);

  await dispatch(parcel);
  // Expired 20 minutes ago, but the sweeper only settled it just now — exactly
  // the 11:35/12:49 row on the real database.
  await lapse(parcel, 20);

  const back = await dispatch(parcel);
  check(
    'a lapse that the sweeper noticed late still counts from when it expired',
    back !== null,
    'measuring from responded_at would hold the driver out long after their fifteen minutes were up, for a parcel they were never shown',
  );
});

// --- 6. a fresh lapse does cool down ----------------------------------------

await run('scenario 6 \u2014 a fresh lapse does cool down', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  const parcel = await newParcel();
  await goOnline(A);

  await dispatch(parcel);
  await lapse(parcel, 1);

  check(
    'a lapse a minute old is still cooling',
    (await dispatch(parcel)) === null,
    'without this the parcel would re-offer to the same driver in a loop every time anything called dispatch',
  );
});

// --- 7. the invariant that must never break ---------------------------------

await run('scenario 7 \u2014 never two live offers', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  const parcel = await newParcel();
  await goOnline(A);
  await goOnline(B);

  await dispatch(parcel);
  await dispatch(parcel);
  await dispatch(parcel);

  const live = await q(
    "select count(*)::int as n from public.dispatch_offers where booking_id = $1 and status = 'offered'",
    [parcel],
  );
  check(
    'calling dispatch repeatedly never produces two live offers',
    live[0].n === 1,
    'two drivers each told the same parcel is theirs is the failure this whole design exists to prevent',
  );
});

// --- 8. interstate parcels are not handed to flash shifts -------------------

await run('scenario 8 \u2014 flash shifts take no interstate parcel', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  const parcel = await newParcel('Ibadan', 'Lagos');
  await goOnline(A, 'Ibadan');

  check(
    'a flash shift is not offered an interstate parcel',
    (await dispatch(parcel)) === null,
    'a driver with two free hours in Ibadan has not offered to drive to Lagos',
  );
});

// --- 9. the two modes never cross ------------------------------------------

await run('scenario 9 — a scheduled route is never given a local parcel', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');

  const local = await newParcel('Ibadan', 'Ibadan');
  await declareRoute(A, 'Ibadan', 'Lagos');

  check(
    'an interstate driver is not handed a parcel that never leaves the city',
    (await dispatch(local)) === null,
    'a driver who said they are going to Lagos has not offered to ride around Ibadan',
  );
});

await run('scenario 10 — no journey at all means no offer', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');

  const interstate = await newParcel('Ibadan', 'Lagos');
  check(
    'an approved driver who has declared nothing receives nothing',
    (await dispatch(interstate)) === null,
    'interstate work goes only to drivers who submitted an active route',
  );

  await declareRoute(A, 'Ibadan', 'Lagos');
  check('and receives it the moment they declare the route', (await dispatch(interstate)) !== null);
});

await run('scenario 11 — the window follows the parcel, not the driver', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');

  const local = await newParcel('Ibadan', 'Ibadan');
  await goOnline(A);
  await dispatch(local);
  const flashOffer = await liveOffer(local);

  const interstate = await newParcel('Ibadan', 'Lagos');
  await declareRoute(B, 'Ibadan', 'Lagos');
  await dispatch(interstate);
  const routeOffer = await liveOffer(interstate);

  const minutes = (row) =>
    Math.round((Date.parse(row.expires_at) - Date.parse(row.offered_at)) / 60_000);

  check('a flash offer holds for five minutes', minutes(flashOffer) === 5);
  check('a scheduled offer holds for ten', minutes(routeOffer) === 10);
});

await run('scenario 12 — a paused route stops receiving', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');

  const interstate = await newParcel('Ibadan', 'Lagos');
  const journey = await declareRoute(A, 'Ibadan', 'Lagos');
  await q("update public.driver_journeys set status = 'paused' where id = $1", [journey]);

  check(
    'a route that is not open is not an active schedule',
    (await dispatch(interstate)) === null,
    'pausing is how a driver says "not right now" without deleting the route',
  );
});

await run('scenario 13 — a route whose window has passed stops receiving', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');

  const interstate = await newParcel('Ibadan', 'Lagos');
  const journey = await declareRoute(A, 'Ibadan', 'Lagos');

  /*
   * Aged by moving the departure, not the window.
   *
   * This scenario used to push `departs_before` into the past directly. The
   * sync trigger now rewrites that from `departure_time`, so the old edit was
   * silently undone and the route stayed live — which is exactly the drift the
   * trigger exists to prevent, demonstrated by a test that tried to cause it.
   */
  await q(
    `update public.driver_journeys
        set departs_after = now() - interval '8 hours',
            departure_time = now() - interval '2 hours'
      where id = $1`,
    [journey],
  );

  check(
    'a journey whose departure has passed matches nothing',
    (await dispatch(interstate)) === null,
    'a route stays status=open after it departs, so this is the only thing stopping a parcel being offered to somebody who left hours ago',
  );
  check(
    'and the window was squared with the departure rather than left behind',
    (
      await q('select departs_before, departure_time from public.driver_journeys where id = $1', [
        journey,
      ])
    )[0].departs_before.getTime() ===
      (
        await q('select departure_time from public.driver_journeys where id = $1', [journey])
      )[0].departure_time.getTime(),
    'two columns for one fact drift the moment somebody writes one of them',
  );
});

await run('scenario 14 — the departure is the only thing that ends listening', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');

  const parcel = await newParcel('Ibadan', 'Lagos');
  const journey = await declareRoute(A, 'Ibadan', 'Lagos', 6);

  const row = (
    await q('select departs_before, departure_time from public.driver_journeys where id = $1', [
      journey,
    ])
  )[0];

  check(
    'the client sends a departure and the database derives the window',
    row.departure_time !== null && row.departs_before.getTime() === row.departure_time.getTime(),
    'the insert deliberately set departs_before to a minute from now; the trigger replaced it',
  );
  check('a route departing later today is live', (await dispatch(parcel)) !== null);
});

await run('scenario 15 — a flash shift keeps its own clock', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');

  const local = await newParcel('Ibadan', 'Ibadan');
  const shift = await goOnline(A);

  check(
    'a shift has no departure',
    (await q('select departure_time from public.driver_journeys where id = $1', [shift]))[0]
      .departure_time === null,
    'a flash driver is available until a time; nothing departs, and giving the column a value here would make it mean two things',
  );
  check('and still receives local work', (await dispatch(local)) !== null);

  await db.exec('delete from public.dispatch_offers');
  // `departs_after` moves too, or `journey_window_ordered` refuses the update —
  // the constraint holds for shifts as well as routes.
  await q(
    `update public.driver_journeys
        set departs_after = now() - interval '3 hours',
            departs_before = now() - interval '1 minute'
      where id = $1`,
    [shift],
  );
  check(
    'an ended shift stops receiving, on departs_before rather than departure_time',
    (await dispatch(local)) === null,
    'the coalesce in journey_matches is what lets one function serve both kinds of row',
  );
});

await run('scenario 16 — soonest departure wins the parcel', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');

  const parcel = await newParcel('Ibadan', 'Lagos');
  await declareRoute(B, 'Ibadan', 'Lagos', 20);
  await declareRoute(A, 'Ibadan', 'Lagos', 1);

  await dispatch(parcel);
  check(
    'the driver leaving in an hour is offered it before the one leaving tomorrow',
    (await liveOffer(parcel))?.driver_id === A,
    'under the window model this ordered on departs_after, which was the earliest a driver might leave rather than when they actually do',
  );
});

await run('scenario 17 — a departure in the past is refused by the database', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');

  let refused = false;
  try {
    await q(
      `insert into public.driver_journeys
         (driver_id, origin_city, destination_city, departs_before, capacity_kg, mode, departure_time)
       values ($1, 'Ibadan', 'Lagos', now() + interval '1 hour', 40, 'scheduled',
               now() - interval '1 hour')`,
      [A],
    );
  } catch {
    refused = true;
  }

  check(
    'journey_window_ordered catches a departure that has already passed',
    refused,
    'with departs_after defaulting to now(), the existing constraint becomes the guarantee that a declared departure is in the future — whatever the client sends',
  );
});

// ------------------------------------------------- changing your mind ------

const signIn = async (who) => {
  await db.exec('delete from public.who');
  await q('insert into public.who values ($1)', [who]);
};

await run('scenario 18 — cancelling frees the parcel immediately', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  await signIn(A);

  const parcel = await newParcel('Ibadan', 'Lagos');
  const mine = await declareRoute(A, 'Ibadan', 'Lagos', 6);
  await declareRoute(B, 'Ibadan', 'Lagos', 8);

  await dispatch(parcel);
  check('the parcel is out with the first driver', (await liveOffer(parcel))?.driver_id === A);

  await q('select public.cancel_journey($1)', [mine]);

  check(
    'the route is withdrawn',
    (await q('select status from public.driver_journeys where id = $1', [mine]))[0].status ===
      'cancelled',
  );
  check(
    'and the parcel is already with somebody else',
    (await liveOffer(parcel))?.driver_id === B,
    'leaving it held for the rest of the hold by a driver who walked away is the stranding this whole design exists to prevent',
  );
});

await run("scenario 19 — cancelling somebody else's route is refused", async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  await signIn(A);
  const theirs = await declareRoute(B, 'Ibadan', 'Lagos');

  let refused = false;
  try {
    await q('select public.cancel_journey($1)', [theirs]);
  } catch {
    refused = true;
  }
  check('ownership is checked on the server', refused);
});

await run('scenario 20 — cancelling twice is not an error', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  await signIn(A);
  const mine = await declareRoute(A, 'Ibadan', 'Lagos');

  await q('select public.cancel_journey($1)', [mine]);
  let raised = false;
  try {
    await q('select public.cancel_journey($1)', [mine]);
  } catch {
    raised = true;
  }
  check(
    'a second tap on a slow connection is a no-op',
    !raised,
    'a red banner for something already in the state you asked for teaches drivers to distrust the button',
  );
});

await run('scenario 21 — editing changes the terms', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  await signIn(A);
  const mine = await declareRoute(A, 'Ibadan', 'Lagos', 6);

  await q("select public.update_journey($1, null, 'Abuja', 55, now() + interval '9 hours')", [
    mine,
  ]);

  const row = (
    await q(
      'select destination_city, capacity_kg, departure_time, departs_before from public.driver_journeys where id = $1',
      [mine],
    )
  )[0];

  check('the destination changes', row.destination_city === 'Abuja');
  check('the capacity changes', Number(row.capacity_kg) === 55);
  check(
    'and the window follows the new departure',
    row.departs_before.getTime() === row.departure_time.getTime(),
    'the sync trigger has to fire on update as well as insert, or an edited departure leaves the old window listening',
  );
});

await run('scenario 22 — editing is refused while an offer is live', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  await signIn(A);

  const parcel = await newParcel('Ibadan', 'Lagos');
  const mine = await declareRoute(A, 'Ibadan', 'Lagos', 6);
  await dispatch(parcel);

  let message = '';
  try {
    await q("select public.update_journey($1, null, 'Abuja')", [mine]);
  } catch (error) {
    message = error.message;
  }

  check(
    'the edit is refused',
    /Answer the trip offered/.test(message),
    'a driver offered a Lagos parcel could otherwise change the route to Abuja and accept, arriving in the wrong city with it',
  );
  check(
    'and the route is untouched',
    (await q('select destination_city from public.driver_journeys where id = $1', [mine]))[0]
      .destination_city === 'Lagos',
  );
});

await run('scenario 23 — a flash shift is not editable here', async () => {
  await db.exec('delete from public.dispatch_offers; delete from public.bookings;');
  await db.exec('delete from public.driver_journeys');
  await signIn(A);
  const shift = await goOnline(A);

  let message = '';
  try {
    await q('select public.update_journey($1, null, null, 30)', [shift]);
  } catch (error) {
    message = error.message;
  }
  check(
    'it points at going offline instead',
    /offline and back online/.test(message),
    'a shift has no departure, so editing one would have to invent a meaning for the column it does not use',
  );
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed against Postgres.`);
  process.exit(1);
}

console.log(
  'PASS — dispatch executes on a real Postgres: flash and scheduled never cross, an\n' +
    '       interstate parcel reaches only a driver with an active route, the window follows\n' +
    '       the parcel at 5 and 10 minutes, a no of either kind holds that parcel off that\n' +
    '       driver for fifteen while it rotates onward, and no sequence of calls produces\n' +
    '       two live offers.',
);
