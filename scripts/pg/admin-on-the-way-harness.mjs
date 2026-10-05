/**
 * Runs the admin "on the way" scope and counts against a real Postgres.
 *
 * The bug this closes produced no error: a card labelled "In transit" counted
 * every parcel with a driver, cancelled ones included, so an operator asking
 * what was on the road read a number answering a different question. Nothing
 * anywhere disagreed with it, which is why it survived.
 *
 * So every stage of the delivery chain is seeded here and each count is
 * asserted against a hand-checked expectation, rather than against whatever the
 * function happens to return.
 *
 * Usage: node scripts/pg/admin-on-the-way-harness.mjs
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

async function run(label, fn) {
  try {
    await fn();
  } catch (error) {
    failures += 1;
    console.error(`FAIL — ${label}\n       ${error.message}`);
  }
}

const db = await PGlite.create();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

// ------------------------------------------------------------- the schema --

/*
 * Stubs keep the constraints that can reject a write — `push-harness.mjs`
 * learned that with app_events.level. The status vocabulary below is copied
 * from 01, because a scope that filters on status is exactly what a loose stub
 * would fail to catch.
 */
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;

  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $fn$;

  create table public.profiles (
    id uuid primary key, full_name text not null default '',
    is_admin boolean not null default false
  );

  create table public.driver_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid, status text not null default 'pending'
  );

  create table public.app_events (
    id bigint generated always as identity primary key,
    level text not null check (level in ('info','warning','error')),
    area text, message text, created_at timestamptz not null default now()
  );

  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    tracking_id text not null,
    origin_city text not null, destination_city text not null,
    weight numeric not null default 5, estimated_fee numeric not null default 0,
    driver_id uuid, driver text,
    status text not null default 'Booked' check (status in
      ('Booked','Assigned','Picked Up','In Transit','Out for Delivery','Delivered','Cancelled')),
    created_at timestamptz not null default now()
  );

  create table public.dispatch_offers (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null references public.bookings(id) on delete cascade,
    status text not null default 'offered',
    expires_at timestamptz not null default (now() + interval '10 minutes')
  );

  create function public.is_admin() returns boolean language sql stable as $fn$
    select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
  $fn$;
`);

/* 07 and 17 are the versions 72 replaces; applying 72 alone would pass its own
   guard check against nothing. Minimal stand-ins for the two it requires. */
await db.exec(`
  create function public.admin_overview() returns jsonb language plpgsql as $fn$
    begin return '{}'::jsonb; end $fn$;
  create function public.admin_parcels(scope text default 'unassigned', city text default null,
    max_rows integer default 50)
  returns table (id uuid, tracking_id text, status text, origin_city text, destination_city text,
    weight numeric, estimated_fee numeric, created_at timestamptz, driver_name text,
    offer_outstanding boolean)
  language plpgsql as $fn$ begin return; end $fn$;
`);

await db.exec(read('supabase/migrations/20250101000072_admin_on_the_way.sql'));

// ---------------------------------------------------------------- seeding --

const ADMIN = '11111111-1111-1111-1111-111111111111';
const DRIVER = '22222222-2222-2222-2222-222222222222';

await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}','admin@test'), ('${DRIVER}','driver@test');
  insert into public.profiles (id, is_admin) values ('${ADMIN}', true), ('${DRIVER}', false);
`);

/* One parcel at every stage, plus the two terminal states and a cancelled one
   that still has a driver — the row the old counts got wrong. */
const STAGES = [
  ['PKR-001', 'Booked', null],
  ['PKR-002', 'Assigned', DRIVER],
  ['PKR-003', 'Picked Up', DRIVER],
  ['PKR-004', 'In Transit', DRIVER],
  ['PKR-005', 'Out for Delivery', DRIVER],
  ['PKR-006', 'Delivered', DRIVER],
  ['PKR-007', 'Cancelled', DRIVER],
  ['PKR-008', 'Cancelled', null],
];
for (const [tracking, status, driver] of STAGES) {
  await q(
    `insert into public.bookings (tracking_id, origin_city, destination_city, status, driver_id, driver)
     values ($1,'Lagos','Ibadan',$2,$3,$4)`,
    [tracking, status, driver, driver ? 'Test Driver' : null],
  );
}

const asAdmin = () => db.exec(`set request.jwt.claim.sub = '${ADMIN}';`);
const asDriver = () => db.exec(`set request.jwt.claim.sub = '${DRIVER}';`);

console.log('running the admin on-the-way scope against Postgres…\n');

// --- 1. the counts ----------------------------------------------------------

await run('scenario 1 — the overview counts', async () => {
  await asAdmin();
  const overview = (await q('select public.admin_overview() as o'))[0].o;

  check(
    'on the way counts In Transit and Out for Delivery, and only those',
    overview.parcels_on_the_way === 2,
    `got ${overview.parcels_on_the_way} (expected PKR-004 and PKR-005)`,
  );
  check(
    'with a driver counts the four live ones and excludes the cancelled',
    overview.parcels_in_transit === 4,
    `got ${overview.parcels_in_transit} (expected Assigned, Picked Up, In Transit, Out for Delivery)`,
  );
  check(
    'a cancelled parcel with a driver is no longer counted as carried',
    overview.parcels_in_transit !== 5,
    'this is the old behaviour: only Delivered was excluded, so Cancelled counted for ever',
  );
  check(
    'unclaimed excludes the cancelled parcel that never had a driver',
    overview.parcels_unclaimed === 1,
    `got ${overview.parcels_unclaimed} (expected PKR-001 alone, not PKR-008)`,
  );
  check('delivered is unchanged', overview.parcels_delivered === 1);
  check('the total is every row', overview.parcels_total === 8);
});

// --- 2. the list ------------------------------------------------------------

await run('scenario 2 — the on_the_way scope', async () => {
  await asAdmin();
  const rows = await q("select tracking_id, status from public.admin_parcels('on_the_way', null, 50)");

  check('it returns exactly the moving parcels', rows.length === 2, `got ${rows.length}`);
  check(
    'including Out for Delivery',
    rows.some((r) => r.tracking_id === 'PKR-005'),
    'a driver on the last leg has not stopped travelling, and that is when they get asked about it',
  );
  check(
    'and nothing that has not left yet',
    !rows.some((r) => ['Assigned', 'Picked Up'].includes(r.status)),
  );
  check(
    'nor anything finished or called off',
    !rows.some((r) => ['Delivered', 'Cancelled'].includes(r.status)),
  );
  check(
    'the count and the list agree',
    rows.length ===
      (await q('select public.admin_overview() as o'))[0].o.parcels_on_the_way,
    'a card whose number disagrees with the list behind it is the bug this replaces',
  );
});

// --- 3. the scope the card used to open -------------------------------------

await run('scenario 3 — assigned still means what it meant', async () => {
  await asAdmin();
  const rows = await q("select status from public.admin_parcels('assigned', null, 50)");
  check('four parcels have a live driver', rows.length === 4, `got ${rows.length}`);
  check(
    'and the two scopes are genuinely different lists',
    rows.length !== (await q("select 1 from public.admin_parcels('on_the_way', null, 50)")).length,
    'if these matched, the new scope would be adding a second name for one answer',
  );
});

// --- 4. a parcel appears the moment the journey starts -----------------------

await run('scenario 4 — it tracks the driver tapping through', async () => {
  await asAdmin();
  const before = (await q('select public.admin_overview() as o'))[0].o.parcels_on_the_way;

  await q("update public.bookings set status='In Transit' where tracking_id='PKR-003'");
  const after = (await q('select public.admin_overview() as o'))[0].o.parcels_on_the_way;
  check('starting the journey adds it', after === before + 1, `${before} -> ${after}`);

  await q("update public.bookings set status='Delivered' where tracking_id='PKR-003'");
  const done = (await q('select public.admin_overview() as o'))[0].o.parcels_on_the_way;
  check('delivering it removes it', done === before, `${after} -> ${done}`);
});

// --- 5. it is still admin-only ----------------------------------------------

await run('scenario 5 — not readable by a driver', async () => {
  await asDriver();
  let refusedList = false;
  let refusedCounts = false;
  try {
    await q("select * from public.admin_parcels('on_the_way', null, 50)");
  } catch {
    refusedList = true;
  }
  try {
    await q('select public.admin_overview()');
  } catch {
    refusedCounts = true;
  }
  check('the list refuses a non-admin', refusedList);
  check('and so do the counts', refusedCounts, 'the new scope must not be a way around is_admin()');
});

// --- 6. re-runnable ---------------------------------------------------------

await run('scenario 6 — the migration applies twice', async () => {
  await db.exec(read('supabase/migrations/20250101000072_admin_on_the_way.sql'));
  await asAdmin();
  const rows = await q("select 1 from public.admin_parcels('on_the_way', null, 50)");
  check('and still answers afterwards', rows.length === 2);
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('verify:pg-admin-on-the-way — all checks passed');
