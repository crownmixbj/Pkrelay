/**
 * Runs account erasure against a real Postgres.
 *
 * Erasure is the one operation whose failure mode is invisible from the outside:
 * the screen says "erased", and a NIN, a face photograph and a bank account
 * number are still sitting in tables nobody thought about. So this harness is
 * built the opposite way round from the others — instead of asserting that the
 * function does what it says, it seeds every table with something identifying
 * and then asserts that none of it survives.
 *
 * Two failures it exists to catch, both of which were live:
 *
 *   · the phone-lock trigger refusing the scrub, so erasure never ran at all
 *   · erasure running happily while eight tables added since 20250101000009_bans.sql kept
 *     everything they held
 *
 * ⚠ RLS is not exercised; the admin check inside the function is.
 *
 * Usage: node scripts/pg/erase-harness.mjs
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

async function run(label, fn) {
  try {
    await fn();
  } catch (error) {
    failures += 1;
    console.error(`FAIL — ${label}`);
    console.error(`       ${error.message}`);
  }
}

const db = await PGlite.create();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

const repair = read('supabase/migrations/20250101000033_erase_repair.sql');
const identity = read('supabase/migrations/20250101000016_driver_identity.sql');

console.log('\nrunning account erasure against Postgres…\n');

const SUBJECT = '11111111-1111-1111-1111-111111111111';
const ADMIN = '22222222-2222-2222-2222-222222222222';
const OTHER = '33333333-3333-3333-3333-333333333333';

/*
 * The real tables, trimmed to the columns erasure touches — plus every
 * constraint that can reject a write. See the note in the other harnesses:
 * a stub looser than production does not test production.
 */
await db.exec(`
  create schema auth;
  create schema storage;
  create table auth.users (id uuid primary key, phone text, raw_user_meta_data jsonb default '{}');
  create table public.who (id uuid, admin boolean default false);

  create function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1;
  $fn$;
  create function public.is_admin() returns boolean language sql stable as $fn$
    select coalesce((select admin from public.who limit 1), false);
  $fn$;

  create function public.normalize_ng_phone(raw text) returns text
    language sql immutable as $fn$
      select case when raw is null then null
        else nullif(regexp_replace(raw, '[^0-9]', '', 'g'), '') end;
  $fn$;

  create table public.app_events (
    id bigserial primary key,
    level text not null check (level in ('info', 'warning', 'error')),
    area text, message text, context jsonb, actor_id uuid,
    created_at timestamptz not null default now()
  );

  create table public.profiles (
    id uuid primary key, full_name text, phone text, is_admin boolean default false,
    deleted_at timestamptz, driving_banned_at timestamptz, driving_ban_reason text
  );

  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    sender_id uuid, driver_id uuid, driver text,
    pickup_contact_name text, sender_phone text, recipient_name text,
    recipient_phone text, pickup_address text, dropoff_address text, notes text
  );

  create table public.driver_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null, full_name text, phone text, email text, nin text,
    address text, guarantor_name text, guarantor_phone text,
    guarantor_relationship text, guarantor_address text, guarantor_nin text,
    bank_name text, account_number text, account_name text,
    kin_name text, kin_phone text, kin_relationship text,
    plate_number text, license_id text, documents jsonb default '{}'
  );

  create table public.sender_identity (
    user_id uuid primary key, nin text, slip_path text, reference_path text
  );
  create table public.photo_capture_sessions (id uuid primary key default gen_random_uuid(), owner_id uuid);

  /*
    ⚠ The pointer 44 added to bookings, with the clause 61 gave it.

      This harness builds its own minimal schema, so the foreign key here is
      this file's choice rather than the real one — what it proves is that
      erase_person copes with a parcel that still points at a capture session it
      is about to delete. Between 44 and 61 it did not: the delete below raised
      and the entire scrub aborted, so an erasure request for any sender who had
      posted a parcel silently did nothing.

      That the *real* key carries on-delete-set-null is asserted against the full
      migration chain in support-tickets-harness.mjs, which applies every
      migration for real. Both are needed: this one catches a future table that
      forgets to say what happens to its pointer, that one catches somebody
      re-adding this constraint without the clause.
  */
  alter table public.bookings
    add column capture_session_id uuid
      references public.photo_capture_sessions (id) on delete set null;
  create table public.driver_documents (id uuid primary key default gen_random_uuid(), driver_id uuid, path text);
  create table public.push_tokens (token text primary key, user_id uuid);
  create table public.payout_change_requests (
    id uuid primary key default gen_random_uuid(), driver_id uuid,
    bank_name text, account_number text, account_name text,
    previous_account_number text
  );
  create table public.payout_requests (
    id uuid primary key default gen_random_uuid(), driver_id uuid,
    amount numeric, bank_name text, account_number text, account_name text
  );
  create table public.driver_earnings (
    id uuid primary key default gen_random_uuid(), driver_id uuid, net numeric
  );
  create table public.driver_edit_history (
    id uuid primary key default gen_random_uuid(), driver_id uuid,
    field text, old_value text, new_value text
  );

  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create function storage.foldername(name text) returns text[]
    language sql immutable as $fn$ select string_to_array(name, '/'); $fn$;
`);

await run('the phone guard and erase_person load', async () => {
  await db.exec(
    extractFunction(repair, 'create or replace function public.guard_application_phone'),
  );
  await db.exec(`
    create trigger driver_applications_lock_phone
      before insert or update on public.driver_applications
      for each row execute function public.guard_application_phone();
  `);
  await db.exec(extractFunction(repair, 'create or replace function public.erase_person'));
});

const be = async (id, admin = false) => {
  await q('delete from public.who');
  await q('insert into public.who (id, admin) values ($1, $2)', [id, admin]);
};

await run('seed a person with something identifying in every table', async () => {
  await q("insert into auth.users (id, phone) values ($1, '+2348030000001')", [SUBJECT]);
  await q('insert into auth.users (id) values ($1), ($2)', [ADMIN, OTHER]);

  await q(
    `insert into public.profiles (id, full_name, phone, is_admin) values
      ($1, 'Omolola Adedapo', '+2348030000001', false),
      ($2, 'An Admin', '+2348030000002', true)`,
    [SUBJECT, ADMIN],
  );

  await q(
    `insert into public.driver_applications
       (user_id, full_name, phone, email, nin, address, bank_name, account_number,
        account_name, guarantor_nin, license_id, documents)
     values ($1, 'Omolola Adedapo', '+2348030000001', 'o@example.com', '12345678901',
             '8 Lebanon Street', 'GTBank', '0123456789', 'Omolola Adedapo',
             '10987654321', 'LIC-9', '{"license":"u1/license.jpg"}'::jsonb)`,
    [SUBJECT],
  );

  await q(
    `insert into public.bookings (sender_id, pickup_contact_name, sender_phone,
       recipient_name, recipient_phone, pickup_address, dropoff_address, notes)
     values ($1, 'Omolola', '+2348030000001', 'Ade', '+2348030000009',
             '8 Lebanon Street', '12 Awolowo Road', 'gate code 4411')`,
    [SUBJECT],
  );
  await q("insert into public.bookings (driver_id, driver) values ($1, 'Omolola Adedapo')", [
    SUBJECT,
  ]);

  await q(
    "insert into public.sender_identity (user_id, nin, slip_path, reference_path) values ($1, '12345678901', 'u1/slip.jpg', 'u1/face.jpg')",
    [SUBJECT],
  );
  const [session] = await q(
    'insert into public.photo_capture_sessions (owner_id) values ($1) returning id',
    [SUBJECT],
  );
  /* A parcel that points at it — the row that used to make erasure impossible. */
  await q('update public.bookings set capture_session_id = $1 where sender_id = $2', [
    session.id,
    SUBJECT,
  ]);
  await q("insert into public.driver_documents (driver_id, path) values ($1, 'u1/license.jpg')", [
    SUBJECT,
  ]);
  await q("insert into public.push_tokens (token, user_id) values ('ExponentPushToken[x]', $1)", [
    SUBJECT,
  ]);
  await q(
    "insert into public.payout_change_requests (driver_id, bank_name, account_number, account_name, previous_account_number) values ($1, 'Access', '9988776655', 'Omolola Adedapo', '0123456789')",
    [SUBJECT],
  );
  await q(
    "insert into public.payout_requests (driver_id, amount, bank_name, account_number, account_name) values ($1, 5000, 'GTBank', '0123456789', 'Omolola Adedapo')",
    [SUBJECT],
  );
  await q('insert into public.driver_earnings (driver_id, net) values ($1, 5000)', [SUBJECT]);
  await q(
    "insert into public.driver_edit_history (driver_id, field, old_value, new_value) values ($1, 'nin', '12345678901', '99999999999')",
    [SUBJECT],
  );

  await q(
    `insert into storage.objects (bucket_id, name) values
      ('driver-documents', $1 || '/license.jpg'),
      ('sender-identity',  $1 || '/face.jpg'),
      ('sender-photo',     $1 || '/selfie.jpg'),
      ('delivery-proof',   $1 || '/proof.jpg')`,
    [SUBJECT],
  );
});

// ------------------------------------------------------------ the refusals --

await run('1. only an admin, and never yourself', async () => {
  await be(OTHER);
  let message = '';
  try {
    await q('select public.erase_person($1)', [SUBJECT]);
  } catch (error) {
    message = error.message;
  }
  check('a non-admin is refused', /only an administrator/i.test(message), message);

  await be(ADMIN, true);
  let own = '';
  try {
    await q('select public.erase_person($1)', [ADMIN]);
  } catch (error) {
    own = error.message;
  }
  check('and an admin cannot erase themselves', /your own account/i.test(own), own);
});

// -------------------------------------------------- the trigger that blocked --

await run('2. the phone lock no longer refuses the scrub', async () => {
  await be(ADMIN, true);
  await q('select public.erase_person($1, $2)', [SUBJECT, 'test']);
  check('erasure completed', true);
});

await run('3. and the lock is still armed for everybody else', async () => {
  /*
   * The exemption is transaction-local, so it must be gone the moment the
   * erasure statement ended. If it leaked, an applicant could put any number
   * on an application — which is the control 20250101000016_driver_identity.sql exists for.
   */
  await q("insert into auth.users (id, phone) values ($1, '+2348030000077')", [
    '44444444-4444-4444-4444-444444444444',
  ]);

  let message = '';
  try {
    await q(
      "insert into public.driver_applications (user_id, phone) values ($1, '+2348030009999')",
      ['44444444-4444-4444-4444-444444444444'],
    );
  } catch (error) {
    message = error.message;
  }
  check(
    'a mismatched phone is still refused',
    /phone number you signed up with/i.test(message),
    message || 'the erasure exemption leaked out of its transaction',
  );
});

// ------------------------------------------- nothing identifying is left --

await run('4. the application keeps no identity, bank or guarantor detail', async () => {
  const [row] = await q('select * from public.driver_applications where user_id = $1', [SUBJECT]);
  const leaked = Object.entries(row).filter(
    ([, value]) =>
      typeof value === 'string' &&
      /Omolola|12345678901|0123456789|GTBank|Lebanon|example\.com|LIC-9|2348030000001/.test(value),
  );
  check('nothing recognisable survives', leaked.length === 0, JSON.stringify(leaked));
});

await run('5. the tables added after 20250101000009_bans.sql are covered too', async () => {
  const empty = async (table, column) =>
    (await q(`select count(*)::int as n from public.${table} where ${column} = $1`, [SUBJECT]))[0]
      .n;

  check(
    'the identity row is gone',
    (await empty('sender_identity', 'user_id')) === 0,
    'a NIN and the path to a stored face photograph',
  );
  check('capture sessions are gone', (await empty('photo_capture_sessions', 'owner_id')) === 0);

  {
    /*
      And the parcel that pointed at one is still here, pointing at nothing.

      `set null` rather than `cascade`: 33 argues that a recipient's delivery
      history is theirs and must not be destroyed to satisfy somebody else's
      erasure. Cascading from the capture session would have done precisely
      that, one table removed.
    */
    const rows = await q('select capture_session_id from public.bookings where sender_id = $1', [
      SUBJECT,
    ]);
    check(
      'the erased sender’s parcel survives',
      rows.length === 1,
      'erasure scrubs a parcel, it does not delete it',
    );
    check('with its capture session pointer cleared', rows[0]?.capture_session_id === null);
  }
  check('document records are gone', (await empty('driver_documents', 'driver_id')) === 0);
  check(
    'push tokens are gone',
    (await empty('push_tokens', 'user_id')) === 0,
    'a device the erased person can still be reached on',
  );
  check(
    'payout change requests are gone',
    (await empty('payout_change_requests', 'driver_id')) === 0,
    'they hold the new bank account and the previous one',
  );

  const [payout] = await q('select * from public.payout_requests where driver_id = $1', [SUBJECT]);
  check(
    'payout rows keep the amount and lose the account',
    payout && Number(payout.amount) === 5000 && payout.account_number === 'Erased',
    JSON.stringify(payout),
  );

  const [earning] = await q('select * from public.driver_earnings where driver_id = $1', [SUBJECT]);
  check(
    'and the ledger itself is untouched',
    earning && Number(earning.net) === 5000,
    'deleting it would leave Package Relay unable to reconcile its own bank statement',
  );

  const [history] = await q('select * from public.driver_edit_history where driver_id = $1', [
    SUBJECT,
  ]);
  check(
    'the edit trail keeps the fact and loses the values',
    history && history.field === 'nin' && history.old_value === null && history.new_value === null,
    JSON.stringify(history),
  );
});

await run('6. the stored files go, except the recipient’s proof of delivery', async () => {
  const buckets = (
    await q('select bucket_id from storage.objects where name like $1', [`${SUBJECT}/%`])
  ).map((r) => r.bucket_id);

  check(
    'licence scans, NIN slips and selfies are deleted',
    !buckets.includes('driver-documents') &&
      !buckets.includes('sender-identity') &&
      !buckets.includes('sender-photo'),
    buckets.join(', '),
  );
  check(
    'proof of delivery is kept',
    buckets.includes('delivery-proof'),
    'it belongs to the person at the other end of the delivery, who did not ask to be erased',
  );
});

await run('7. deliveries stay in place, with the people removed', async () => {
  const [sent] = await q('select * from public.bookings where sender_id = $1', [SUBJECT]);
  check(
    'a sent parcel loses its addresses and phone numbers',
    sent.recipient_phone === 'Removed' && sent.pickup_address === 'Removed' && sent.notes === '',
    JSON.stringify(sent),
  );

  const [carried] = await q('select * from public.bookings where driver_id = $1', [SUBJECT]);
  check('a carried parcel shows a placeholder carrier', carried.driver === 'Former driver');
});

await run('8. the erasure is audited without naming the person', async () => {
  const [event] = await q(
    "select * from public.app_events where message = 'account erased' order by id desc limit 1",
  );
  check('it is logged as a warning', event && event.level === 'warning', JSON.stringify(event));
  check(
    'with the subject id and the reason',
    event.context.subject === SUBJECT && event.context.reason === 'test',
  );
  check(
    'and nothing identifying in the context',
    !/Omolola|12345678901/.test(JSON.stringify(event.context)),
    'an audit row naming the person erased would keep exactly what the erasure removed',
  );
});

// ---------------------------------------------------------------------------

await db.close();

if (failures > 0) {
  console.error(`\n${failures} failing assertion${failures === 1 ? '' : 's'}.`);
  process.exit(1);
}

console.log(
  'PASS — the phone lock no longer refuses an erasure and is still armed the moment it ends,\n' +
    '       nothing recognisable survives in the application, the eight tables added since\n' +
    '       20250101000009_bans.sql are all covered, the payout ledger keeps its amounts and loses its\n' +
    '       account numbers, the recipient keeps their proof of delivery, and the audit row\n' +
    '       records the erasure without recording the person.',
);
