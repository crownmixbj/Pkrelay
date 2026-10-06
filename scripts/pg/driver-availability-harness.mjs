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

// ----------------------------- 8. attempts, drivers, and the retry loop --

/*
 * ⚠ The rule everybody assumed was missing.
 *
 *   `dispatch_offers_once_per_driver` (15) was dropped by 20, and its successor
 *   `dispatch_offers_no_repeat_decline` by 23. What is left is a rolling
 *   per-pair cooldown inside the matcher: a driver who let an offer lapse is
 *   eligible for that same parcel again `offer_cooldown()` later. Production had
 *   seven offers on one parcel to one driver in a day, which is this working.
 *
 *   It is pinned here because the natural reading of 15's comment is that a pair
 *   is blocked for ever, and somebody acting on that reading would "fix" a thing
 *   that is not broken — by widening the window, which makes retries rarer.
 */
{
  await asUser(ADMIN);
  await db.query('select public.set_dispatch_mode($1)', ['auto']);

  await asOwner();
  /* A clean driver and a parcel only they can take. */
  await db.query(`update public.driver_journeys set status = 'completed'`);
  /*
    Their licence has been renewed. Section 5 expired it to prove the document
    gate keeps a driver off the waiting list; the matcher reads the same gate, so
    leaving it expired here would test nothing but that.
  */
  await db.query('delete from public.driver_documents where driver_id = $1', [FREE]);
  const journeyId = await journey(FREE, { origin: 'Kano', destination: 'Jos', ageMinutes: 5 });
  const retry = await parcel({ origin: 'Kano', destination: 'Jos' });

  await asOwner();
  await db.query('select public.dispatch_booking($1)', [retry.id]);

  const first = await db.query(
    'select id, status, expires_at from public.dispatch_offers where booking_id = $1',
    [retry.id],
  );
  check(
    'the matcher offers the parcel to the only matching driver',
    first.rows.length === 1,
    `got ${first.rows.length} offers`,
  );

  /* Let it lapse: wind the hold into the past and run the matcher again. */
  await db.query(
    `update public.dispatch_offers set expires_at = now() - interval '1 minute'
      where booking_id = $1 and status = 'offered'`,
    [retry.id],
  );
  await db.query('select public.dispatch_booking($1)', [retry.id]);

  const afterLapse = await db.query(
    `select status from public.dispatch_offers where booking_id = $1 order by offered_at`,
    [retry.id],
  );
  check(
    'a lapsed offer is settled rather than left hanging',
    afterLapse.rows[0].status === 'expired',
  );
  check(
    'and the same driver is not offered it again inside the cooldown',
    afterLapse.rows.length === 1,
    'the 15-minute window is the whole point — re-offering instantly would be a loop',
  );

  /* Now push the lapse back beyond the cooldown. */
  await db.query(
    `update public.dispatch_offers
        set expires_at = now() - public.offer_cooldown() - interval '5 minutes',
            responded_at = now() - public.offer_cooldown() - interval '5 minutes'
      where booking_id = $1`,
    [retry.id],
  );
  await db.query('select public.dispatch_booking($1)', [retry.id]);

  const afterCooldown = await db.query(
    `select driver_id, status from public.dispatch_offers where booking_id = $1 order by offered_at`,
    [retry.id],
  );
  check(
    'once the cooldown has passed the same pair is offered again',
    afterCooldown.rows.length === 2 && afterCooldown.rows[1].driver_id === FREE,
    'there is no permanent once-per-driver block, and nothing should reintroduce one',
  );

  /* And the counts tell the two numbers apart. */
  await asUser(ADMIN);
  const counted = await db.query('select * from public.offer_attempts($1)', [retry.id]);
  const row = counted.rows[0];

  check('two attempts are counted', Number(row.attempts) === 2, JSON.stringify(row));
  check(
    'at one driver',
    Number(row.drivers_tried) === 1,
    'this is the number the screens were missing: 7 attempts at 1 driver read as "5 drivers"',
  );
  check('one of them timed out', Number(row.expired) === 1);
  check('none were declined', Number(row.declined) === 0);
  check('and one is live', Number(row.live) === 1);

  const queue = await db.query('select * from public.unassigned_parcels()');
  const queued = queue.rows.find((candidate) => candidate.id === retry.id);
  check(
    'the queue carries both numbers',
    Number(queued?.offers_made) === 2 && Number(queued?.drivers_tried) === 1,
    JSON.stringify(queued),
  );
  check(
    'and splits declines from timeouts',
    Number(queued?.offers_declined) === 0 && Number(queued?.offers_expired) === 1,
  );

  const forDriver = await db.query('select * from public.admin_parcels_for_driver($1)', [FREE]);
  const mine = forDriver.rows.find((candidate) => candidate.id === retry.id);
  check(
    'and so does the driver-first list',
    Number(mine?.drivers_tried) === 1 && Number(mine?.offers_live) === 1,
    JSON.stringify(mine),
  );

  await asUser(SENDER);
  const refused = await refusal(() => db.query('select * from public.offer_attempts($1)', [retry.id]));
  const leaked = refused === null
    ? (await db.query('select * from public.offer_attempts($1)', [retry.id])).rows[0]
    : null;
  check(
    'a non-admin is told nothing by the counter',
    leaked === null || Number(leaked.attempts) === 0,
    'it reads the offer table, which has no select policy for anybody else',
  );
}

// ------------------------- 9. the in-flight board, and the delivery email --

/*
 * ⚠ Both halves of this run against the real chain on purpose.
 *
 *   `emails-harness.mjs` proves the delivery email over a schema it builds
 *   itself, which is exactly the arrangement that hid `admin_assign_parcel`
 *   being broken for eight migrations. The sender's email on a real delivery is
 *   worth one more assertion against the real tables.
 */
{
  await asOwner();

  /* BUSY is carrying a parcel from section 4, claimed and not yet collected. */
  await asUser(ADMIN);
  const board = await db.query('select * from public.admin_parcels_in_flight()');

  const claimed = board.rows.find((row) => row.driver_id === BUSY);
  check('a claimed parcel is on the board', !!claimed, `${board.rows.length} rows`);
  check(
    'and it is not counted as collected',
    claimed?.collected === false,
    'collected is the pickup timestamp — the sender has not handed it over yet',
  );
  check('the carrier is named', claimed?.driver_name === 'Busy Driver', claimed?.driver_name);
  check(
    'the totals ride on the row rather than being counted from the page',
    Number(claimed?.total_awaiting_collection) >= 1,
    JSON.stringify({
      in_flight: claimed?.total_in_flight,
      awaiting: claimed?.total_awaiting_collection,
      collected: claimed?.total_collected,
      stalled: claimed?.total_stalled,
    }),
  );

  /* Now collect it, as the driver — the only role 10 allows to advance a parcel. */
  await asUser(BUSY);
  const notTheDriver = await refusal(() =>
    db.query('select public.advance_booking($1)', [claimed.id]),
  );
  check('the carrying driver can advance it', notTheDriver === null, `${notTheDriver}`);

  await asOwner();
  const afterPickup = await db.query(
    'select status, picked_up_at, status_changed_at from public.bookings where id = $1',
    [claimed.id],
  );
  check("the parcel is 'Picked Up'", afterPickup.rows[0].status === 'Picked Up');
  check(
    'the collection is timestamped',
    afterPickup.rows[0].picked_up_at !== null,
    'this is the moment the admin board calls "collected from the sender"',
  );
  check(
    'and the stage clock moved with it',
    afterPickup.rows[0].status_changed_at !== null,
    '73 adds this because In Transit and Out for Delivery have no timestamp of their own',
  );

  await asUser(ADMIN);
  const moving = (await db.query('select * from public.admin_parcels_in_flight()')).rows.find(
    (row) => row.id === claimed.id,
  );
  check('it moves to the collected half of the board', moving?.collected === true);
  check(
    'with a fresh stage clock',
    Number(moving?.minutes_since_move) <= 1,
    `got ${moving?.minutes_since_move}`,
  );
  check('and nothing is stalled', Number(moving?.total_stalled) === 0);

  /* A day without a move is what the red flag counts. */
  await asOwner();
  await db.query(
    `update public.bookings set status_changed_at = now() - interval '30 hours' where id = $1`,
    [claimed.id],
  );
  await asUser(ADMIN);
  const stalled = (await db.query('select * from public.admin_parcels_in_flight()')).rows.find(
    (row) => row.id === claimed.id,
  );
  check(
    'a parcel that has not moved in a day is counted as stalled',
    Number(stalled?.total_stalled) === 1 && Number(stalled?.minutes_since_move) > 24 * 60,
    JSON.stringify({ stalled: stalled?.total_stalled, minutes: stalled?.minutes_since_move }),
  );

  /* ---------------------------- the sender hears about the delivery ------- */

  await asUser(BUSY);
  await db.query('select public.advance_booking($1)', [claimed.id]); // In Transit
  await db.query('select public.advance_booking($1)', [claimed.id]); // Out for Delivery

  const nameless = await refusal(() =>
    db.query('select public.advance_booking($1)', [claimed.id]),
  );
  check(
    'a delivery cannot be recorded without saying who took it',
    nameless !== null && /who received/i.test(nameless),
    '10 exists to close exactly that gap',
  );

  await db.query('select public.advance_booking($1, $2)', [claimed.id, 'Ngozi at reception']);

  await asOwner();
  const delivered = await db.query(
    'select status, delivered_at, received_by from public.bookings where id = $1',
    [claimed.id],
  );
  check('the parcel is delivered', delivered.rows[0].status === 'Delivered');
  check('and who took it is on the record', delivered.rows[0].received_by === 'Ngozi at reception');

  const email = await db.query(
    `select o.recipient, o.payload, o.sent_at
       from public.email_outbox o
      where o.kind = 'delivery_completed' and o.subject_id = $1`,
    [claimed.id],
  );
  check(
    'a delivery email is queued',
    email.rows.length === 1,
    `${email.rows.length} rows — 38 queues this on the move to Delivered`,
  );
  check(
    'addressed to the sender',
    email.rows[0]?.recipient === 'sender@pkrelay.test',
    `got ${email.rows[0]?.recipient}`,
  );
  check(
    'carrying the tracking id and the fare',
    email.rows[0]?.payload?.tracking_id === claimed.tracking_id &&
      Number(email.rows[0]?.payload?.fare) > 0,
    JSON.stringify(email.rows[0]?.payload),
  );
  check(
    'and left unsent, which is the retry queue and the evidence both',
    email.rows[0]?.sent_at === null,
  );

  /* Delivered parcels leave the board — it is what is in flight, not what moved. */
  await asUser(ADMIN);
  const afterDelivery = await db.query('select * from public.admin_parcels_in_flight()');
  check(
    'a delivered parcel drops off the in-flight board',
    !afterDelivery.rows.some((row) => row.id === claimed.id),
  );

  await asUser(SENDER);
  const refused = await db.query('select * from public.admin_parcels_in_flight()');
  check(
    'and a non-admin sees nothing on it',
    refused.rows.length === 0,
    'every driver name and route, otherwise',
  );
}

// ---------------------- 10. closing a delivery the driver never recorded ---

/*
 * ⚠ The case this exists for, reproduced: a driver who collects a parcel, moves
 *   it along, and stops one step short. On production PKG-483203 sat at Out for
 *   Delivery with no `delivered_at`, no recipient name and no error anywhere —
 *   the driver simply never tapped the last step, and 10 lets nobody else.
 */
{
  await asOwner();
  const stuck = await parcel({ origin: 'Kano', destination: 'Jos' });
  await db.query(
    `update public.bookings
        set driver_id = $1, driver = 'Free Driver', status = 'Out for Delivery',
            accepted_at = now() - interval '4 hours',
            picked_up_at = now() - interval '3 hours'
      where id = $2`,
    [FREE, stuck.id],
  );

  /* A non-admin cannot close anybody's delivery. */
  await asUser(SENDER);
  const notAdmin = await refusal(() =>
    db.query('select public.admin_record_delivery($1, $2, $3)', [
      stuck.id,
      'Someone',
      'because I said so',
    ]),
  );
  check('a non-admin cannot record a delivery', notAdmin !== null && /not allowed/i.test(notAdmin));

  await asUser(ADMIN);

  const nameless = await refusal(() =>
    db.query('select public.admin_record_delivery($1, $2, $3)', [stuck.id, ' ', 'rang the driver']),
  );
  check(
    'a nameless delivery is refused, exactly as it is for a driver',
    nameless !== null && /who received/i.test(nameless),
    'an admin typing it does not stop it being the gap 10 closed',
  );

  const reasonless = await refusal(() =>
    db.query('select public.admin_record_delivery($1, $2, $3)', [stuck.id, 'Ngozi', '']),
  );
  check(
    'and so is one with no account of how they know',
    reasonless !== null && /how you know/i.test(reasonless),
    'the operator did not witness this; in six months that sentence is the whole defence',
  );

  /* A parcel never collected cannot be closed. */
  const uncollected = await parcel({ origin: 'Kano', destination: 'Jos' });
  await asOwner();
  await db.query(
    `update public.bookings set driver_id = $1, driver = 'Free Driver', status = 'Assigned'
      where id = $2`,
    [FREE, uncollected.id],
  );
  await asUser(ADMIN);
  const tooEarly = await refusal(() =>
    db.query('select public.admin_record_delivery($1, $2, $3)', [
      uncollected.id,
      'Ngozi',
      'driver says it went',
    ]),
  );
  check(
    'a parcel that was never collected cannot be closed',
    tooEarly !== null && /not been collected/i.test(tooEarly),
    'closing it would assert a collection nobody recorded, on the word of somebody who saw neither',
  );

  /* The real thing. */
  const before = await db.query(
    `select count(*)::int as n from public.driver_earnings where booking_id = $1`,
    [stuck.id],
  );
  check('no earning yet', before.rows[0].n === 0);

  await db.query('select public.admin_record_delivery($1, $2, $3)', [
    stuck.id,
    'Ngozi at reception',
    'Driver confirmed by phone, recipient called to say it arrived.',
  ]);

  await asOwner();
  const closed = await db.query(
    `select status, delivered_at, received_by, delivery_recorded_by
       from public.bookings where id = $1`,
    [stuck.id],
  );
  check('the parcel is delivered', closed.rows[0].status === 'Delivered');
  check('with a timestamp', closed.rows[0].delivered_at !== null);
  check('and who took it', closed.rows[0].received_by === 'Ngozi at reception');
  check(
    'the row records that an admin closed it, not the driver',
    closed.rows[0].delivery_recorded_by === ADMIN,
    'without this the two are indistinguishable six months later',
  );

  const email = await db.query(
    `select recipient from public.email_outbox
      where kind = 'delivery_completed' and subject_id = $1`,
    [stuck.id],
  );
  check(
    'the sender is emailed, exactly as for a driver-recorded delivery',
    email.rows.length === 1 && email.rows[0].recipient === 'sender@pkrelay.test',
    `got ${JSON.stringify(email.rows)}`,
  );

  const earned = await db.query(
    `select net, gross from public.driver_earnings where booking_id = $1`,
    [stuck.id],
  );
  check(
    'and the driver is credited for the work they did',
    earned.rows.length === 1 && Number(earned.rows[0].gross) > 0,
    'suppressing the fare would be a punishment for a flat phone battery',
  );

  const logged = await db.query(
    `select level, actor_id, context from public.app_events
      where message = 'admin recorded a delivery the driver did not'`,
  );
  check('the override is logged', logged.rows.length === 1);
  check(
    'as a warning, because a run of these is the delivery flow failing',
    logged.rows[0].level === 'warning',
  );
  check('naming the admin', logged.rows[0].actor_id === ADMIN);
  check(
    'and carrying how they knew',
    String(logged.rows[0].context?.reason ?? '').includes('confirmed by phone'),
  );

  /* Twice is refused rather than paying twice. */
  await asUser(ADMIN);
  const again = await refusal(() =>
    db.query('select public.admin_record_delivery($1, $2, $3)', [
      stuck.id,
      'Ngozi',
      'closing it again',
    ]),
  );
  check(
    'a second close is refused',
    again !== null && /already delivered/i.test(again),
    'and `on conflict (booking_id) do nothing` means it would not have paid twice either',
  );

  const attribution = await db.query('select * from public.admin_delivery_attribution($1)', [
    stuck.id,
  ]);
  check(
    'the drawer can say who closed it',
    attribution.rows[0]?.recorded_by_admin === true &&
      attribution.rows[0]?.admin_name === 'Test Admin',
    JSON.stringify(attribution.rows[0]),
  );

  await asUser(SENDER);
  const hidden = await db.query('select * from public.admin_delivery_attribution($1)', [stuck.id]);
  check('and a non-admin is told nothing by it', hidden.rows.length === 0);
}

// ------------------------------- 10. the soonest departure goes first (75) --

/*
 * ⚠ The discriminator here is that declaration order is the *reverse* of
 *   departure order.
 *
 *   `LATEST` declares first and leaves last; `SOON` declares last and leaves
 *   first. Under 70's ordering — matching count, then `created_at` — the list
 *   comes back LATEST, LATER, SOON, which is exactly backwards for the question
 *   an operator is asking. Under 75 it comes back SOON, LATER, LATEST. A test
 *   that seeded them in departure order would pass against either.
 */
const SOON = '88888888-8888-8888-8888-888888888888';
const LATER = '99999999-9999-9999-9999-999999999999';
const LATEST = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const CLOCK_DRIVERS = [
  { label: 'Soon', id: SOON, phone: '08030000011' },
  { label: 'Later', id: LATER, phone: '08030000012' },
  { label: 'Latest', id: LATEST, phone: '08030000013' },
];

{
  await asOwner();
  await db.exec(`
    insert into auth.users (id, email, phone) values
      ('${SOON}',   'soon@pkrelay.test',   '08030000011'),
      ('${LATER}',  'later@pkrelay.test',  '08030000012'),
      ('${LATEST}', 'latest@pkrelay.test', '08030000013');

    update public.profiles set full_name = 'Soon Driver',   phone = '08030000011' where id = '${SOON}';
    update public.profiles set full_name = 'Later Driver',  phone = '08030000012' where id = '${LATER}';
    update public.profiles set full_name = 'Latest Driver', phone = '08030000013' where id = '${LATEST}';
  `);

  let counter = 100;
  for (const driver of CLOCK_DRIVERS) {
    counter += 1;
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
         'Test Bank', '0123456' || $6, $3, 'K Name', '08038888888', 'Sister', 'approved'
       )`,
      [
        driver.id,
        `PKR-D-${counter}`,
        `${driver.label} Driver`,
        driver.phone,
        `${driver.label.toLowerCase()}@pkrelay.test`,
        String(counter),
      ],
    );
  }

  await db.exec(`
    alter table public.driver_applications disable trigger user;
    update public.driver_applications set status = 'approved', reviewed_at = now()
      where user_id in ('${SOON}', '${LATER}', '${LATEST}');
    alter table public.driver_applications enable trigger user;
  `);

  /* Manual, so posting the parcel below does not hand one of them an offer. */
  await asUser(ADMIN);
  await db.query('select public.set_dispatch_mode($1)', ['manual']);

  /* Declared in the reverse of the order they leave. See the note above. */
  await journey(LATEST, { hours: 9, ageMinutes: 90 });
  await journey(LATER, { hours: 4, ageMinutes: 60 });
  await journey(SOON, { hours: 1, ageMinutes: 5 });

  /* One parcel all three could take, so the actionable-first key ties. */
  const shared = await parcel({ origin: 'Ibadan', destination: 'Lagos', weight: 2 });

  const clock = (await waiting()).filter((row) =>
    [SOON, LATER, LATEST].includes(row.driver_id),
  );

  check(
    'all three are waiting',
    clock.length === 3,
    `got ${clock.length}: ${JSON.stringify(clock.map((row) => row.full_name))}`,
  );
  check(
    'each of them can see the parcel',
    clock.every((row) => Number(row.matching_parcels) >= 1),
    'the first sort key is a tie only if they all match it',
  );
  check(
    'the one leaving soonest is first and the one leaving last is last',
    clock.map((row) => row.driver_id).join() === [SOON, LATER, LATEST].join(),
    `got ${JSON.stringify(clock.map((row) => row.full_name))} — 70 ordered on created_at, which\n` +
      '       is the reverse of this seeding on purpose',
  );
  check(
    'and the screen is given the timestamps it needs to say so',
    clock.every((row) => row.departs_before instanceof Date || typeof row.departs_before === 'string'),
    'departureLine() reads departure_time first and falls back to departs_before',
  );

  /*
   * ⚠ `departure_time` wins over the window, because `coalesce` puts it first
   *   and because a driver who has named an exact time has said something more
   *   precise than "before six".
   */
  await asOwner();
  await db.query(
    `update public.driver_journeys set departure_time = now() + interval '20 minutes'
      where driver_id = $1 and status = 'open'`,
    [LATEST],
  );
  const reordered = (await waiting())
    .filter((row) => [SOON, LATER, LATEST].includes(row.driver_id))
    .map((row) => row.driver_id);
  check(
    'an exact departure overrides the window it sits inside',
    reordered.join() === [LATEST, SOON, LATER].join(),
    `got ${JSON.stringify(reordered)} — the sort key is coalesce(departure_time, departs_before)`,
  );

  /*
   * Put it back — as an exact time matching its own window rather than as null,
   * because 27's journey guard will not let a declared departure be unsaid.
   */
  await asOwner();
  await db.query(
    `update public.driver_journeys set departure_time = now() + interval '9 hours'
      where driver_id = $1 and status = 'open'`,
    [LATEST],
  );

  /*
   * ⚠ And the one thing departure does NOT outrank.
   *
   *   A driver leaving in ten minutes with nothing on their route is not a
   *   decision anybody can make. The top row has to be actionable, so "is there
   *   anything this driver could take" stays the leading key — reduced to a
   *   boolean in 75 so that a *count* can no longer push a distant departure to
   *   the top.
   */
  await asOwner();
  await db.query(
    `update public.driver_journeys set status = 'completed' where driver_id = $1`,
    [SOON],
  );
  /*
    ⚠ Enugu → Owerri, not Kano → Jos: section 9 left two unassigned Kano → Jos
      parcels behind, so that route is the opposite of a dead end.
  */
  await journey(SOON, { origin: 'Enugu', destination: 'Owerri', hours: 1, ageMinutes: 2 });

  const withDeadEnd = (await waiting()).filter((row) =>
    [SOON, LATER, LATEST].includes(row.driver_id),
  );
  check(
    'a driver with nothing to carry is not first just for leaving soonest',
    withDeadEnd[0]?.driver_id === LATER && Number(withDeadEnd[0]?.matching_parcels) >= 1,
    `got ${JSON.stringify(withDeadEnd.map((row) => [row.full_name, row.matching_parcels]))}`,
  );
  check(
    'they are still on the list, at the bottom',
    withDeadEnd[withDeadEnd.length - 1]?.driver_id === SOON &&
      Number(withDeadEnd[withDeadEnd.length - 1]?.matching_parcels) === 0,
    'an idle driver with no work on their route is information, not an action',
  );

  /* ---------------------- and the parcel-first list agrees with it -------- */

  await asUser(ADMIN);
  const candidates = (await db.query('select * from public.assignable_drivers($1)', [shared.id]))
    .rows;
  const byId = new Map(candidates.map((row) => [row.driver_id, row]));

  check(
    'a candidate carries the departure it is now sorted on',
    byId.get(LATER)?.next_departure !== null && byId.get(LATEST)?.next_departure !== null,
    'the column is new in 75; before it the sheet sorted by full_name',
  );
  check(
    'and the mode of that same journey, so the time can be worded correctly',
    byId.get(LATER)?.journey_mode === 'scheduled',
    `got ${byId.get(LATER)?.journey_mode}`,
  );

  const matching = candidates
    .filter((row) => row.route_matches && row.documents_ok)
    .map((row) => row.driver_id);
  check(
    'the matching candidates are offered soonest-departure first',
    matching.indexOf(LATER) < matching.indexOf(LATEST),
    `got ${JSON.stringify(matching)}`,
  );
  check(
    'a driver whose route does not match still sorts below one whose does',
    !matching.includes(SOON) && byId.has(SOON),
    'the list keeps showing the overrides; it just stops recommending them',
  );

  check(
    'and the deployment panel can tell whether any of this is deployed',
    (await db.query('select public.departure_priority_live() as ok')).rows[0].ok === true,
    'it reads both live function bodies — the functions existed before 75',
  );
}

// ------------------------- 11. the delivery reaches the sender's inbox (76) --

/*
 * ⚠ This is the production defect, pinned.
 *
 *   The production database carried a migration-history row for 50 while none
 *   of that file's objects existed — no `notify_on_booking_status`, no
 *   `on_booking_status_notify` trigger — so a delivery produced the sender's
 *   email and nothing in the app, silently, for weeks. 76 re-applies the spine.
 *   What is asserted below is not that the functions exist but that the wiring
 *   does, because a function nothing is attached to is the exact failure.
 */
{
  await asOwner();

  const wired = await db.query(
    `select
       exists (
         select 1 from pg_trigger t
         where t.tgrelid = 'public.bookings'::regclass
           and t.tgname = 'on_booking_status_notify' and not t.tgisinternal
       ) as booking,
       exists (
         select 1 from pg_trigger t
         where t.tgrelid = 'public.notifications'::regclass
           and t.tgname = 'notifications_dispatch_push' and not t.tgisinternal
       ) as push,
       public.notification_spine_live() as probe`,
  );
  check('the sender-facing status notifier is attached to bookings', wired.rows[0].booking === true);
  check('and the push dispatcher to notifications', wired.rows[0].push === true);
  check(
    'and the deployment panel probe says so',
    wired.rows[0].probe === true,
    'a history row is not evidence that a migration ran — this is what would have caught it',
  );

  const done = await db.query(
    `select id, tracking_id, sender_id, delivered_at from public.bookings
      where status = 'Delivered' and delivered_at is not null
      order by delivered_at desc limit 1`,
  );
  check('the harness delivered a parcel earlier to read this from', done.rows.length === 1);

  const inbox = await db.query(
    `select kind, title, body, push_requested, created_at, metadata
       from public.notifications
      where user_id = $1 and kind = 'delivery_completed' and subject_id = $2`,
    [done.rows[0].sender_id, done.rows[0].id],
  );
  check(
    'the sender has a delivery notification in their inbox',
    inbox.rows.length === 1,
    `${inbox.rows.length} rows — this is the one production never had`,
  );
  check(
    'naming the parcel, because an inbox entry that does not is unusable',
    String(inbox.rows[0]?.title ?? '').includes(done.rows[0].tracking_id),
    String(inbox.rows[0]?.title),
  );
  check(
    'and saying who took it',
    /Ngozi/.test(String(inbox.rows[0]?.body ?? '')),
    String(inbox.rows[0]?.body),
  );
  check(
    'it is marked for a push rather than inbox-only',
    inbox.rows[0]?.push_requested === true,
    'the sender is not looking at the app when their parcel arrives',
  );

  /*
   * ⚠ "Immediately" is the request this answers, so it is measured rather than
   *   asserted in prose: the row is written by the AFTER UPDATE trigger inside
   *   the same transaction as the status change, so its timestamp and
   *   `delivered_at` are the same `now()`. Nothing is waiting for a sweep.
   */
  const gap = Math.abs(
    new Date(inbox.rows[0]?.created_at).getTime() - new Date(done.rows[0].delivered_at).getTime(),
  );
  check(
    'written in the same transaction as the delivery, not by a later sweep',
    gap < 1000,
    `${gap}ms between delivered_at and the notification`,
  );

  /* The driver is told too, and once — two buzzes for one delivery is how a
     driver learns to ignore the first. */
  const driverSide = await db.query(
    `select count(*)::int as n from public.notifications
      where kind = 'delivery_completed' and subject_id = $1 and user_id <> $2`,
    [done.rows[0].id, done.rows[0].sender_id],
  );
  check('the driver gets exactly one as well', driverSide.rows[0].n === 1);
}

await db.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('the waiting list holds.\n');
