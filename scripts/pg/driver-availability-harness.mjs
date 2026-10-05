/**
 * Runs 69 and 70 against a real Postgres, on top of the real chain, under RLS.
 *
 * ⚠ What is being proved, in one sentence: the waiting list contains drivers who
 *   can take a parcel right now, and nobody else.
 *
 *   1. `admin_assign_parcel` places a parcel at all. It never could against the
 *      real schema — the parameter named `driver` is ambiguous with the column
 *      of the same name, so it raised before writing. `documents-harness.mjs`
 *      missed it for eight migrations because it builds its own `bookings`
 *      table with no such column. This harness uses the real one.
 *   2. The assignment fills the denormalised carrier name and moves the status
 *      to 'Assigned' — the two things 50's notifier needs before it will tell
 *      the driver and the sender anything.
 *   3. Each of the five exclusions actually excludes: a live offer, a parcel in
 *      hand, a ban, an expired blocking document, a lapsed shift. Every one of
 *      them is a row that would otherwise get a second parcel assigned to it.
 *   4. `matching_parcels` agrees with the matcher rather than approximating it.
 *   5. A non-admin gets an empty list and an exception from the counts.
 *
 * Usage: node scripts/pg/driver-availability-harness.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();

/* Same three as every other full-chain harness: pg_net and the push plumbing. */
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
const FREE = '22222222-2222-2222-2222-222222222222';
const BUSY = '33333333-3333-3333-3333-333333333333';
const OFFERED = '44444444-4444-4444-4444-444444444444';
const BANNED = '55555555-5555-5555-5555-555555555555';
const LAPSED = '66666666-6666-6666-6666-666666666666';
const ADMIN = '77777777-7777-7777-7777-777777777777';

/*
 * Each driver with the phone their account carries.
 *
 * `guard_application_phone` (29) refuses an application whose phone differs
 * from the account's — "Applications must match the account they are made
 * from" — so the seed cannot invent one per row.
 */
const DRIVERS = [
  { label: 'Free', id: FREE, phone: '08030000002' },
  { label: 'Busy', id: BUSY, phone: '08030000003' },
  { label: 'Offered', id: OFFERED, phone: '08030000004' },
  { label: 'Banned', id: BANNED, phone: '08030000005' },
  { label: 'Lapsed', id: LAPSED, phone: '08030000006' },
];

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
    email_confirmed_at timestamptz,
    encrypted_password text,
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

const db = await PGlite.create();
await db.exec(SUPABASE_SHIM);
for (const name of MIGRATIONS) {
  if (SKIP.has(name)) continue;
  await db.exec(read(name));
}

await db.exec(`
  create table public.who (id uuid);
  create or replace function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1 $fn$;
  grant select on public.who to authenticated;

  insert into auth.users (id, email, phone) values
    ('${SENDER}',  'sender@pkrelay.test',  '08030000001'),
    ('${FREE}',    'free@pkrelay.test',    '08030000002'),
    ('${BUSY}',    'busy@pkrelay.test',    '08030000003'),
    ('${OFFERED}', 'offered@pkrelay.test', '08030000004'),
    ('${BANNED}',  'banned@pkrelay.test',  '08030000005'),
    ('${LAPSED}',  'lapsed@pkrelay.test',  '08030000006'),
    ('${ADMIN}',   'admin@pkrelay.test',   '08030000007');

  update public.profiles set full_name = 'Test Sender' where id = '${SENDER}';
  update public.profiles set full_name = 'Free Driver',    phone = '08030000002' where id = '${FREE}';
  update public.profiles set full_name = 'Busy Driver',    phone = '08030000003' where id = '${BUSY}';
  update public.profiles set full_name = 'Offered Driver', phone = '08030000004' where id = '${OFFERED}';
  update public.profiles set full_name = 'Banned Driver',  phone = '08030000005' where id = '${BANNED}';
  update public.profiles set full_name = 'Lapsed Driver',  phone = '08030000006' where id = '${LAPSED}';
  update public.profiles set full_name = 'Test Admin', is_admin = true where id = '${ADMIN}';

  insert into public.sender_identity (user_id, status, verified_at)
  values ('${SENDER}', 'verified', now())
  on conflict (user_id) do update set status = 'verified', verified_at = now();
`);

/** An approved application per driver, so `driver_journeys` will take them. */
let appCounter = 0;
for (const driver of DRIVERS) {
  appCounter += 1;
  await db.query(
    `insert into public.driver_applications (
       user_id, reference, full_name, phone, email, nin, address, state,
       vehicle_type, plate_number, license_id,
       guarantor_name, guarantor_phone, guarantor_relationship, guarantor_address, guarantor_nin,
       bank_name, account_number, account_name, kin_name, kin_phone, kin_relationship, status
     ) values (
       $1, $2, $3, $4, $5, '1234567890' || $6, '1 Test Road', 'Lagos',
       'bike', 'ABC-' || $6, 'DL-' || $6,
       'G Name', '08039999999', 'Brother', '2 Test Road', '12345678902',
       'Test Bank', '012345678' || $6, $3, 'K Name', '08038888888', 'Sister', 'approved'
     )`,
    [
      driver.id,
      `PKR-D-${appCounter}`,
      `${driver.label} Driver`,
      driver.phone,
      `${driver.label.toLowerCase()}@pkrelay.test`,
      String(appCounter),
    ],
  );
}

await db.exec(`
  alter table public.driver_applications disable trigger user;
  update public.driver_applications set status = 'approved', reviewed_at = now();
  alter table public.driver_applications enable trigger user;
`);

const asUser = async (id) => {
  await db.exec(
    `reset role; delete from public.who; insert into public.who (id) values ('${id}');`,
  );
  await db.exec('set role authenticated');
};

const asOwner = async () => db.exec('reset role; delete from public.who;');

const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

/*
 * Journeys are inserted as the owner rather than as each driver.
 *
 * The insert policy requires `is_approved_driver()`, which reads `auth.uid()` —
 * fine for a driver declaring their own, and this harness needs five of them
 * seeded in states a driver could not create (a window already lapsed). The
 * policies themselves are exercised by `dispatch-harness.mjs`.
 */
async function journey(driver, { origin = 'Ibadan', destination = 'Lagos', mode = 'scheduled', hours = 6, capacity = 20, ageMinutes = 90 } = {}) {
  await asOwner();
  const { rows } = await db.query(
    `insert into public.driver_journeys
       (driver_id, origin_city, destination_city, departs_after, departs_before,
        capacity_kg, vehicle_type, mode, status, created_at)
     values ($1, $2, $3, now() - interval '30 minutes',
             now() + ($4 || ' hours')::interval, $5, 'bike', $6, 'open',
             now() - ($7 || ' minutes')::interval)
     returning id`,
    [driver, origin, destination, String(hours), capacity, mode, String(ageMinutes)],
  );
  return rows[0].id;
}

let tracking = 0;

/** Posts a parcel as the sender, the way the app does. */
async function parcel({ origin = 'Ibadan', destination = 'Lagos', weight = 2, fee = 2800 } = {}) {
  await asOwner();
  const session = await db.query(
    `insert into public.photo_capture_sessions
       (owner_id, photo_path, completed_at, liveness_status, liveness_environment, liveness_checked_at)
     values ($1, 'sender-photo/' || gen_random_uuid() || '.jpg', now(), 'passed', 'sandbox', now())
     returning id`,
    [SENDER],
  );

  await asUser(SENDER);
  tracking += 1;
  const { rows } = await db.query(
    `insert into public.bookings
       (tracking_id, delivery_type, pickup_mode, dropoff_mode, origin_city, destination_city,
        item_description, category, weight, estimated_fee, sender_id, status, capture_session_id)
     values ($1, $2, 'hub', 'hub', $3, $4, 'A box', 'documents', $5, $6, $7, 'Booked', $8)
     returning id, tracking_id`,
    [
      `PKR-W-${tracking}`,
      origin === destination ? 'local' : 'interstate',
      origin,
      destination,
      weight,
      fee,
      SENDER,
      session.rows[0].id,
    ],
  );
  await asOwner();
  return rows[0];
}

const waiting = async () => {
  await asUser(ADMIN);
  const { rows } = await db.query('select * from public.admin_waiting_drivers()');
  return rows;
};

const counts = async () => {
  await asUser(ADMIN);
  const { rows } = await db.query('select public.admin_driver_availability() as c');
  return rows[0].c;
};

const idsOf = (rows) => rows.map((row) => row.driver_id);

/*
 * ⚠ Manual dispatch mode, and the reason is the whole shape of this screen.
 *
 *   In auto mode, declaring a shift sweeps the unassigned queue immediately (20
 *   added that), so a driver who comes online while a matching parcel waits has
 *   an offer in their hand within the same transaction — and is therefore not
 *   waiting for anybody to assign them anything. The waiting list in auto mode
 *   is drivers the matcher could NOT place; in manual mode it is everybody,
 *   which is the mode where hand assignment is the whole workflow.
 *
 *   Both are worth testing. The OFFERED driver below covers the auto-mode shape
 *   with an offer inserted by hand; everything else runs in manual so that a
 *   shift declared next to a waiting parcel stays a shift waiting for a parcel.
 */
await (async () => {
  await asUser(ADMIN);
  await db.query('select public.set_dispatch_mode($1)', ['manual']);
  await asOwner();
})();

// ------------------------------------------------------- 1. the happy row --

const ibadanLagos = await parcel();

{
  await journey(FREE);

  const rows = await waiting();
  check('a driver on an open shift with nothing in hand is waiting', idsOf(rows).includes(FREE));

  const row = rows.find((candidate) => candidate.driver_id === FREE);
  check('their name comes through', row?.full_name === 'Free Driver', row?.full_name);
  /*
   * The application's phone, in the +234 form the signup guard normalises it to
   * — not the local form on the profile. It is the number somebody dials after
   * reading "waiting two hours", so the dialable one wins.
   */
  check(
    'their phone comes through, dialable',
    row?.phone === '+2348030000002',
    `got ${row?.phone}`,
  );
  check(
    'the shift is described',
    row?.mode === 'scheduled' && row?.origin_city === 'Ibadan' && row?.destination_city === 'Lagos',
  );
  check(
    'the wait is counted from when they declared it',
    Number(row?.waiting_minutes) >= 89 && Number(row?.waiting_minutes) <= 91,
    `got ${row?.waiting_minutes}`,
  );
  check(
    'and the time left on the shift',
    Number(row?.leaves_in_minutes) > 300,
    `got ${row?.leaves_in_minutes}`,
  );
  check(
    'the matching parcel is counted',
    Number(row?.matching_parcels) === 1,
    'this is the number that makes the row worth acting on',
  );
  check('nothing has been offered to them yet', Number(row?.offers_passed) === 0);
  check('and they are not in cooldown', row?.in_cooldown === false);
}

// ------------------------------------- 2. the matcher's own idea of a match --

{
  /* A parcel on a route this shift does not serve, and one too heavy for it. */
  await parcel({ origin: 'Kano', destination: 'Jos' });
  await parcel({ weight: 40 });

  const row = (await waiting()).find((candidate) => candidate.driver_id === FREE);
  check(
    'an off-route parcel is not counted as matching',
    Number(row?.matching_parcels) === 1,
    `got ${row?.matching_parcels} — the count must agree with journey_matches, not approximate it`,
  );

  await asUser(ADMIN);
  const { rows } = await db.query('select * from public.admin_parcels_for_driver($1)', [FREE]);

  check('every unassigned parcel is listed', rows.length === 3, `got ${rows.length}`);
  check('the matching one is first', rows[0].route_matches === true);
  check('and says so', rows[0].note === 'Matches their shift', rows[0].note);

  const heavy = rows.find((candidate) => Number(candidate.weight) === 40);
  check(
    'the over-capacity parcel names the capacity, not the route',
    heavy?.note === 'Over the capacity left on their shift',
    `got: ${heavy?.note} — "not going this way" would send an operator to look at the map`,
  );

  const offRoute = rows.find((candidate) => candidate.origin_city === 'Kano');
  check('the off-route parcel says that instead', offRoute?.note === 'Not on their declared route');
}

// ------------------------------------------ 3. assignment, end to end (69) --

{
  await asUser(ADMIN);
  const failed = await refusal(() =>
    db.query('select public.admin_assign_parcel($1, $2)', [ibadanLagos.id, FREE]),
  );
  check(
    'an admin can assign a parcel by hand',
    failed === null,
    `69 repairs this; without it: ${failed}`,
  );

  await asOwner();
  const { rows } = await db.query(
    'select driver_id, driver, status, accepted_at from public.bookings where id = $1',
    [ibadanLagos.id],
  );

  check('the parcel has the driver', rows[0].driver_id === FREE);
  check(
    'and the carrier name the constraint requires',
    rows[0].driver === 'Free Driver',
    'driver_pair_consistent refuses an id with no name — and every screen renders the name',
  );
  check(
    "and the status says so",
    rows[0].status === 'Assigned',
    'writing the status it already had meant 50’s notifier fired on a no-op and told nobody',
  );
  check(
    'nobody accepted it, and the record says that',
    rows[0].accepted_at === null,
    'accepted_at means a driver took the job; a hand assignment is the opposite',
  );

  const told = await db.query(
    `select kind from public.notifications where user_id = $1 and subject_id = $2`,
    [FREE, ibadanLagos.id],
  );
  check(
    'the driver is told they have a job',
    told.rows.some((row) => row.kind === 'job_assigned'),
    'the whole point of the status move — otherwise they find out by opening the app',
  );

  const sender = await db.query(
    `select count(*)::int as n from public.notifications
      where user_id = $1 and kind = 'parcel_status_changed'`,
    [SENDER],
  );
  check('and the sender is told too', sender.rows[0].n >= 1);

  const logged = await db.query(
    `select level from public.app_events where area = 'dispatch'
      and message = 'admin assigned a parcel by hand'`,
  );
  check('the override is logged', logged.rows.length === 1);
  check(
    'at info, because in manual mode placing by hand is the expected thing',
    logged.rows[0].level === 'info',
    'logging every one as a warning in the mode where all of them happen buries the ones\n' +
      '       that matter — 32 ties the level to the mode for exactly this reason',
  );

  check(
    'and the driver drops off the waiting list, now that they are carrying',
    !idsOf(await waiting()).includes(FREE),
    'listing them would assign a second parcel to somebody already holding one',
  );
}

// ------------------------------------------------ 4. the four exclusions --

{
  /* Carrying: assigned above, re-checked here through the counts. */
  await journey(BUSY);
  const carrying = await parcel();
  await asUser(ADMIN);
  await db.query('select public.admin_assign_parcel($1, $2)', [carrying.id, BUSY]);
  check('a driver with a parcel in hand is not waiting', !idsOf(await waiting()).includes(BUSY));

  /* A live offer out. */
  const journeyId = await journey(OFFERED);
  const offered = await parcel();
  await asOwner();
  await db.query(
    `insert into public.dispatch_offers (booking_id, journey_id, driver_id, status, expires_at)
     values ($1, $2, $3, 'offered', now() + interval '4 minutes')`,
    [offered.id, journeyId, OFFERED],
  );
  check(
    'a driver deciding on an offer is not waiting',
    !idsOf(await waiting()).includes(OFFERED),
    'they are about to have an answer; a second parcel now is two going opposite ways',
  );

  /* Banned. */
  await journey(BANNED);
  await asOwner();
  await db.query(
    `update public.profiles set driving_banned_at = now(), driving_ban_reason = 'test'
      where id = $1`,
    [BANNED],
  );
  check(
    'a banned driver with an open shift is not waiting',
    !idsOf(await waiting()).includes(BANNED),
    'is_approved_driver cannot be asked about somebody else, so 70 repeats its three conditions —\n' +
      '       and the next button on this screen assigns them a parcel',
  );

  /* A shift whose window has passed. */
  await asOwner();
  await db.query(
    `insert into public.driver_journeys
       (driver_id, origin_city, destination_city, departs_after, departs_before,
        capacity_kg, vehicle_type, mode, status)
     values ($1, 'Ibadan', 'Lagos', now() - interval '6 hours', now() - interval '1 hour',
             20, 'bike', 'scheduled', 'open')`,
    [LAPSED],
  );
  check(
    'a shift whose window has passed is not waiting',
    !idsOf(await waiting()).includes(LAPSED),
    'journey_matches gates on the same expression — a screen that disagreed with it would read\n' +
      '       as dispatch being broken',
  );
}

// --------------------------------------------- 5. the document gate --

{
  const blocked = await journey(FREE, { ageMinutes: 10 });
  await asOwner();
  await db.query(`update public.driver_journeys set status = 'completed' where driver_id = $1 and id <> $2`, [FREE, blocked]);
  await db.query(
    `update public.bookings set status = 'Delivered', delivered_at = now()
      where driver_id = $1`,
    [FREE],
  );

  check(
    'that driver is waiting again once the parcel is delivered',
    idsOf(await waiting()).includes(FREE),
    'the exclusion is "holding something", not "has ever held something"',
  );

  /* Now expire a blocking document on them. */
  await asOwner();
  const kind = await db.query(
    `select key from public.document_kinds where blocks_dispatch limit 1`,
  );
  await db.query(
    `insert into public.driver_documents (driver_id, kind, path, expires_at)
     values ($1, $2, $3, current_date - 1)`,
    [FREE, kind.rows[0].key, `driver-documents/${FREE}/licence.jpg`],
  );

  check(
    'a driver with an expired blocking document is not waiting',
    !idsOf(await waiting()).includes(FREE),
    'admin_assign_parcel refuses them as well — a legal limit, not a matching preference',
  );

  const tiles = await counts();
  check('and the counts call that out separately', Number(tiles.blocked) === 1, JSON.stringify(tiles));
}

// ------------------------------------------------------- 6. the counts --

{
  const tiles = await counts();

  check('the counts see every approved driver', Number(tiles.approved) === 4, JSON.stringify(tiles));
  check('one is carrying', Number(tiles.carrying) === 1);
  check('one has an offer out', Number(tiles.with_offer) === 1);
  check(
    'and the unassigned backlog is there for comparison',
    Number(tiles.unassigned_parcels) >= 1,
    'the two numbers next to each other are the whole point: idle drivers, waiting parcels',
  );
  check(
    'a banned driver is in none of the buckets',
    Number(tiles.approved) === 4,
    'the ban is not a state of availability — they are not a driver for this purpose at all',
  );
}

// ---------------------------------------------------- 7. who may look --

{
  await asUser(SENDER);

  const rows = await db.query('select * from public.admin_waiting_drivers()');
  check(
    'a non-admin gets an empty waiting list',
    rows.rows.length === 0,
    'every driver’s name, phone and whereabouts, otherwise',
  );

  const parcels = await db.query('select * from public.admin_parcels_for_driver($1)', [FREE]);
  check('and no parcels for a driver', parcels.rows.length === 0);

  const tiles = await refusal(() => db.query('select public.admin_driver_availability()'));
  check(
    'and an exception from the counts',
    tiles !== null && /administrator/i.test(tiles),
    `got: ${tiles}`,
  );
}

await db.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('the waiting list holds.\n');
