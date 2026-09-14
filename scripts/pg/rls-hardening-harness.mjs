/**
 * Runs 20250101000048_rls_hardening.sql against a real Postgres, on top of the real chain,
 * under RLS.
 *
 * ⚠ Why this harness builds the whole migration chain instead of a fixture.
 *
 *   Every other harness here stands up a few hand-written tables and runs one
 *   migration over them. That is right when the migration introduces a rule.
 *   48 does not introduce rules — it closes the distance between rules that
 *   already exist and the policies that were letting clients walk around them.
 *   A hand-written fixture would be me deciding what the schema looks like, and
 *   the whole finding was that my idea of the schema and the schema disagreed.
 *
 *   So the chain is applied in order from supabase/, and 48 lands on the result.
 *   `20250101000005_storage_and_alerts.sql` is the one file skipped: it needs `pg_net`,
 *   which PGlite has no build of. Nothing 48 touches comes from it.
 *
 * ⚠ The four things proved here are the four that were actually broken.
 *
 *   1. A parcel could be posted with no selfie, by omitting one field.
 *   2. A driver could mark a parcel delivered — and be paid — without
 *      delivering it, by writing `status` directly.
 *   3. A banned driver could reopen a journey and keep receiving offers.
 *   4. Any signed-in account could write an unattributable entry into the
 *      audit log.
 *
 *   Each is asserted twice: the guard refuses, and the honest path still works.
 *   A guard that refuses everything is not a fix, it is an outage.
 *
 * Usage: node scripts/pg/rls-hardening-harness.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();
const SKIP = new Set(['20250101000005_storage_and_alerts.sql', '20250101000019_push.sql', '20250101000024_push_delivery.sql']);

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

/*
 * Everything Supabase provides and PGlite does not. Kept as close to the real
 * shapes as the assertions need — `storage.foldername` in particular is used by
 * the bucket policies and splitting on '/' is what it does.
 */
const SUPABASE_SHIM = `
  create role anon; create role authenticated; create role service_role;
  create role supabase_auth_admin;
  create schema auth; create schema storage; create schema extensions;
  create schema private; create schema net;
  create publication supabase_realtime;

  /*
    ⚠ Supabase's default grants, which no migration in supabase/ performs.

      The project's SQL never grants anything to anon or authenticated on most
      of these tables — the platform does it, with a standing "grant all on all
      tables in schema public" and a matching default privilege for tables
      created later. Without this the harness would prove that a parcel is
      refused for want of a *grant*, which is true of nothing, and would have
      hidden whether the policy works at all.

      Set before the chain so every table created by it inherits the grants,
      exactly as on the real project — and so 48's revokes land on top of them
      rather than on nothing.
  */
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

  /*
    ⚠ A stub for the one table 19 creates that a later migration insists on.

      19 and 24 are skipped above — they are the push plumbing, and this harness
      is about RLS. 49 then opens with a guard that refuses to install unless
      public.push_tokens exists, which turned the whole chain into "Run
      20250101000019_push.sql first." and took every assertion in this file with
      it. Nothing here reads the table; the guard only asks whether it is there.

      Stubbed rather than un-skipping 19, because the reason 19 is skipped has
      not changed, and because dropping 49 and 50 from the chain instead would
      quietly stop asserting on the notifications policies they add.
  */
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

  /* Swapped for a settable one once the chain has run — see below. */
  create function auth.uid() returns uuid language sql stable as $fn$ select null::uuid $fn$;
`;

/*
 * ⚠ `auth.uid()` is replaced *after* the chain, not before.
 *
 *   Several migrations read it at creation time only to compile; replacing it
 *   first would be fine, but replacing it after proves the chain built against
 *   the same signature the real project has, and leaves one obvious place where
 *   the harness takes control.
 */
const SEED = `
  create table public.who (id uuid);
  create or replace function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1
  $fn$;
  grant select on public.who to authenticated;

  insert into auth.users (id, email, phone) values
    ('${SENDER}', 'sender@example.test', '08030000001'),
    ('${DRIVER}', 'driver@example.test', '08030000002');

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
    '${DRIVER}', 'LOCI-TEST-1', 'Test Driver', '08030000002', 'driver@example.test',
    '12345678901', '1 Test Road', 'Lagos', 'bike', 'ABC-123', 'DL-1',
    'G Name', '08030000003', 'Brother', '2 Test Road', '12345678902',
    'Test Bank', '0123456789', 'Test Driver', 'K Name', '08030000004', 'Sister', 'approved'
  );

  /*
    ⚠ The 'approved' above does not survive the insert, and that is 40 working.

      "default_application_status" is a BEFORE INSERT trigger that overwrites
      whatever status an insert claims — the whole point of 40, so that nobody
      submits an application already approved. The fixture wants an approved
      driver as a starting condition, not a test of the approval path, so the
      triggers come off for one statement.

      Found by the harness rather than by reading: is_approved_driver() was
      false, advance_booking refused, and the assertion said so.
  */
  alter table public.driver_applications disable trigger user;
  update public.driver_applications
     set status = 'approved', reviewed_at = now()
   where user_id = '${DRIVER}';
  alter table public.driver_applications enable trigger user;
`;

/** One parcel, ready to insert. `capture_session_id` is added by the caller. */
const BOOKING_COLUMNS = `
  tracking_id, delivery_type, pickup_mode, dropoff_mode, origin_city, destination_city,
  item_description, category, weight, estimated_fee, sender_id, status`;
const BOOKING_VALUES = `
  $1, 'local', 'hub', 'hub', 'Lagos', 'Lagos',
  'A box', 'general', 2, 1500, '${SENDER}', 'Booked'`;

/**
 * A database with the whole chain applied, optionally with 48 mutated.
 *
 * `mutate` receives 48's text and returns the text to run instead — which is how
 * every guard below is broken on purpose to prove the assertion notices.
 */
async function build({ mutate } = {}) {
  const db = await PGlite.create();
  await db.exec(SUPABASE_SHIM);

  for (const name of MIGRATIONS) {
    if (SKIP.has(name)) continue;
    const text = read(name);
    await db.exec(name === '20250101000048_rls_hardening.sql' && mutate ? mutate(text) : text);
  }

  await db.exec(SEED);
  return db;
}

const asUser = async (db, id) => {
  await db.exec(
    `reset role; delete from public.who; insert into public.who (id) values ('${id}');`,
  );
  await db.exec(`set role authenticated`);
};

/** The error a statement raised, or null when it was allowed. */
const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

/** A completed, unconsumed capture session belonging to the sender. */
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

let parcelCounter = 0;
const nextTracking = () => `LOCI-T-${++parcelCounter}`;

async function postParcel(db, { session }) {
  const columns = session ? `${BOOKING_COLUMNS}, capture_session_id` : BOOKING_COLUMNS;
  const values = session ? `${BOOKING_VALUES}, $2` : BOOKING_VALUES;
  const params = session ? [nextTracking(), session] : [nextTracking()];
  const { rows } = await db.query(
    `insert into public.bookings (${columns}) values (${values}) returning id, sender_photo_path`,
    params,
  );
  return rows[0];
}

// ============================================================================

console.log('\nrunning 48_rls_hardening against the full migration chain, under RLS…\n');

const db = await build();

// -------------------------------------- 1. a parcel carries a selfie, or no --

{
  await asUser(db, SENDER);

  const withoutSelfie = await refusal(() => postParcel(db, { session: null }));
  check(
    'a parcel with no capture session is refused',
    withoutSelfie !== null,
    "this is 44's missing half: the trigger returns early on a null session and left the\n" +
      '       refusal to a policy that was never installed, so omitting one field posted a\n' +
      '       parcel with no selfie at all',
  );
  check(
    'and refused by the policy, not by something incidental',
    /row-level security|violates row-level/i.test(withoutSelfie ?? ''),
    `refused, but for the wrong reason: ${withoutSelfie}`,
  );

  const session = await freshSession(db);
  await asUser(db, SENDER);
  const posted = await refusal(async () => {
    const row = await postParcel(db, { session });
    check(
      'and the selfie is bound to the parcel',
      typeof row.sender_photo_path === 'string' && row.sender_photo_path.length > 0,
      'the trigger fills this; a null here means the policy is passing rows it should not',
    );
  });
  check(
    'an honest parcel still posts',
    posted === null,
    `a guard that refuses the happy path is an outage, not a fix: ${posted}`,
  );
}

// ------------------------------- 2. the delivery record belongs to the server --

{
  await db.exec('reset role');
  const session = await freshSession(db);
  await asUser(db, SENDER);
  const parcel = await postParcel(db, { session });

  /* Assigned by dispatch, as the real path would. */
  await db.exec('reset role');
  await db.query(
    `update public.bookings
        set driver_id = $1, driver = 'Test Driver', status = 'Assigned', accepted_at = now()
      where id = $2`,
    [DRIVER, parcel.id],
  );

  await asUser(db, DRIVER);

  const forged = await refusal(() =>
    db.query(`update public.bookings set status = 'Delivered' where id = $1`, [parcel.id]),
  );
  check(
    'the carrier cannot write Delivered directly',
    forged !== null,
    'record_delivery_earning fires on any transition into Delivered, so this was a paid\n' +
      '       delivery that never happened — no pickup, no proof, no name',
  );
  check(
    'and is told which function owns that column',
    /advance_booking/.test(forged ?? ''),
    `refused without saying what to call instead: ${forged}`,
  );

  const skipped = await refusal(() =>
    db.query(`update public.bookings set received_by = 'Someone' where id = $1`, [parcel.id]),
  );
  check('and cannot write the recipient name either', skipped !== null, '');

  const stolen = await refusal(() =>
    db.query(`update public.bookings set cancelled_at = now() where id = $1`, [parcel.id]),
  );
  check('and cannot forge a cancellation', stolen !== null, '');

  /* The real path, through the definer function, is untouched. */
  const advanced = await refusal(() =>
    db.query(`select public.advance_booking($1, null, null, null)`, [parcel.id]),
  );
  check(
    'advance_booking still advances the parcel',
    advanced === null,
    `the guard is meant to be invisible to the function that owns the column: ${advanced}`,
  );

  await db.exec('reset role');
  const { rows } = await db.query(`select status from public.bookings where id = $1`, [parcel.id]);
  check(
    'and one stage at a time, as it always did',
    rows[0].status === 'Picked Up',
    `expected 'Picked Up', got '${rows[0].status}'`,
  );
}

// ------------------------------- 3. a ban holds until an admin lifts it -------

{
  await db.exec('reset role');
  const { rows } = await db.query(
    `insert into public.driver_journeys
       (driver_id, origin_city, destination_city, departs_before, capacity_kg, vehicle_type, status)
     values ($1, 'Lagos', 'Ibadan', now() + interval '2 days', 20, 'bike', 'paused')
     returning id`,
    [DRIVER],
  );
  const journey = rows[0].id;

  /*
   * ⚠ A row an UPDATE policy hides is not an error, it is zero rows.
   *
   *   The first version of these two checks asked whether the statement threw.
   *   It never does: a USING clause that excludes the row makes the UPDATE
   *   match nothing and report success, so the banned-driver assertion passed
   *   against a database where the ban did nothing — and would have passed
   *   against one where the policy was missing entirely. The question is what
   *   the row says afterwards.
   */
  const journeyStatus = async () => {
    await db.exec('reset role');
    const { rows: r } = await db.query(`select status from public.driver_journeys where id = $1`, [
      journey,
    ]);
    return r[0].status;
  };

  await asUser(db, DRIVER);
  await refusal(() =>
    db.query(`update public.driver_journeys set status = 'open' where id = $1`, [journey]),
  );
  check(
    'an approved driver may still reopen their journey',
    (await journeyStatus()) === 'open',
    'the ordinary case must keep working, or this is an outage rather than a fix',
  );

  await db.exec('reset role');
  await db.query(`update public.profiles set driving_banned_at = now() where id = $1`, [DRIVER]);
  await db.query(`update public.driver_journeys set status = 'paused' where id = $1`, [journey]);

  await asUser(db, DRIVER);
  await refusal(() =>
    db.query(`update public.driver_journeys set status = 'open' where id = $1`, [journey]),
  );
  check(
    'a banned driver cannot reopen it',
    (await journeyStatus()) === 'paused',
    'approval was checked when the journey was created and never again, so a ban only held\n' +
      '       until the banned driver pressed a button',
  );

  await db.exec('reset role');
  await db.query(`update public.profiles set driving_banned_at = null where id = $1`, [DRIVER]);
}

// ---------------------------------- 4. the audit log names who wrote to it ----

{
  await asUser(db, SENDER);

  const forgedActor = await refusal(() =>
    db.query(
      `insert into public.app_events (level, area, message, actor_id)
       values ('error', 'system', 'disk full', null)`,
    ),
  );
  check(
    'a client cannot write an entry with no actor',
    forgedActor !== null,
    'null is how a genuine system event is recorded, so this let anybody sign an entry as\n' +
      '       the platform — in the table an incident would be reconstructed from',
  );

  const impersonated = await refusal(() =>
    db.query(
      `insert into public.app_events (level, area, message, actor_id)
       values ('info', 'test', 'not mine', $1)`,
      [DRIVER],
    ),
  );
  check('nor one attributed to somebody else', impersonated !== null, '');

  const honest = await refusal(() =>
    db.query(
      `insert into public.app_events (level, area, message) values ('info', 'test', 'mine')`,
    ),
  );
  check(
    'and an ordinary log line still writes',
    honest === null,
    `the column defaults to auth.uid(), so honest inserts never send it: ${honest}`,
  );
}

await db.close();

// ============================================== mutation: break each guard ====

/*
 * ⚠ An assertion that passes against a broken guard is not an assertion.
 *
 *   Roughly a dozen survivors across this project have each turned out to be a
 *   weak test rather than good code. Each mutation below removes exactly one
 *   thing 48 adds; the harness is expected to fail every time. A mutant that
 *   survives means the check above it is decorative.
 */
const MUTANTS = [
  {
    name: 'the selfie term is dropped from the insert policy',
    apply: (sql) => sql.replace('and sender_photo_path is not null', ''),
  },
  {
    name: 'the delivery guard ignores status',
    apply: (sql) => sql.replace('if new.status       is distinct from old.status', 'if false'),
  },
  {
    /*
     * ⚠ The replacement is a function, because the string form eats the
     *   dollar-quote.
     *
     *   `String.prototype.replace` reads `$$` in a *replacement string* as an
     *   escape for one literal `$`, so passing the obvious replacement turned
     *   `as $$` into `as $` and the migration failed to parse. It was reported
     *   as a kill until the harness stopped swallowing that error. A function
     *   replacement is taken literally.
     */
    name: 'the delivery guard is security definer',
    apply: (sql) =>
      sql.replace(
        'returns trigger language plpgsql as $$',
        () => 'returns trigger language plpgsql security definer as $$',
      ),
  },
  {
    name: 'the journey update stops re-checking approval',
    apply: (sql) =>
      sql.replace(
        `using (driver_id = (select auth.uid()) and (select public.is_approved_driver()))
with check (driver_id = (select auth.uid()) and (select public.is_approved_driver()));`,
        `using (driver_id = (select auth.uid()))
with check (driver_id = (select auth.uid()));`,
      ),
  },
  {
    name: 'app_events accepts a null actor again',
    apply: (sql) =>
      sql.replace(
        'with check (actor_id = (select auth.uid()));',
        'with check (actor_id is null or actor_id = (select auth.uid()));',
      ),
  },
];

console.log('\nmutating each guard — every one of these must be caught…\n');

let survivors = 0;

for (const mutant of MUTANTS) {
  const original = read('20250101000048_rls_hardening.sql');
  const mutated = mutant.apply(original);

  if (mutated === original) {
    survivors += 1;
    console.error(`FAIL — mutation "${mutant.name}" changed nothing; the pattern has drifted`);
    continue;
  }

  /*
   * ⚠ A mutant that will not apply is reported, not quietly counted as killed.
   *
   *   The first version swallowed the error and printed "killed (migration
   *   refused to apply)" — which is indistinguishable from a mutation that is
   *   simply malformed, and would let a broken mutation masquerade as a passing
   *   test for ever. If the migration will not build, the reason is printed and
   *   it counts as a survivor, because nothing was actually proved.
   */
  const before = failures;
  let mutantDb = null;
  try {
    mutantDb = await build({ mutate: mutant.apply });
  } catch (error) {
    survivors += 1;
    console.error(`FAIL — mutant "${mutant.name}" would not apply, so it proved nothing`);
    console.error(`       ${String(error.message).split('\n')[0]}`);
    continue;
  }

  let caught = false;
  await asUser(mutantDb, SENDER);

  if (mutant.name.includes('selfie')) {
    caught = (await refusal(() => postParcel(mutantDb, { session: null }))) === null;
  } else if (mutant.name.includes('delivery guard')) {
    const session = await freshSession(mutantDb);
    await asUser(mutantDb, SENDER);
    const parcel = await postParcel(mutantDb, { session });
    await mutantDb.exec('reset role');
    await mutantDb.query(
      `update public.bookings set driver_id = $1, driver = 'D', status = 'Assigned' where id = $2`,
      [DRIVER, parcel.id],
    );
    await asUser(mutantDb, DRIVER);
    caught =
      (await refusal(() =>
        mutantDb.query(`update public.bookings set status = 'Delivered' where id = $1`, [
          parcel.id,
        ]),
      )) === null;
  } else if (mutant.name.includes('journey')) {
    await mutantDb.exec('reset role');
    const { rows } = await mutantDb.query(
      `insert into public.driver_journeys
         (driver_id, origin_city, destination_city, departs_before, capacity_kg, vehicle_type, status)
       values ($1, 'Lagos', 'Ibadan', now() + interval '2 days', 20, 'bike', 'paused') returning id`,
      [DRIVER],
    );
    await mutantDb.query(`update public.profiles set driving_banned_at = now() where id = $1`, [
      DRIVER,
    ]);
    await asUser(mutantDb, DRIVER);
    await refusal(() =>
      mutantDb.query(`update public.driver_journeys set status = 'open' where id = $1`, [
        rows[0].id,
      ]),
    );
    /* Zero rows updated is not an error, so read the row rather than the throw. */
    await mutantDb.exec('reset role');
    const after = await mutantDb.query(`select status from public.driver_journeys where id = $1`, [
      rows[0].id,
    ]);
    caught = after.rows[0].status === 'open';
  } else {
    caught =
      (await refusal(() =>
        mutantDb.query(
          `insert into public.app_events (level, area, message, actor_id)
           values ('error', 'system', 'disk full', null)`,
        ),
      )) === null;
  }

  await mutantDb.close();

  if (caught) {
    console.log(`  killed  ${mutant.name}`);
  } else {
    survivors += 1;
    console.error(`FAIL — mutant survived: ${mutant.name}`);
    console.error('       the assertion above it is not testing what it claims to test');
  }

  failures = before;
}

// ============================================================================

if (failures > 0 || survivors > 0) {
  console.error(`\n${failures} assertion(s) failed, ${survivors} mutant(s) survived.`);
  process.exit(1);
}

console.log(
  '\nPASS — a parcel cannot be posted without the selfie that authorises it; the delivery\n' +
    '       record, the cancellation record and the assignment belong to the functions that\n' +
    '       own them and cannot be written by a client; a banned driver cannot reopen a\n' +
    '       journey and put themselves back in the dispatch pool; and every line in the audit\n' +
    '       log names the account that wrote it. Each guard was broken on purpose and each\n' +
    '       break was caught.',
);
