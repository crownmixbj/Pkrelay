/**
 * Runs the driver profile edit rules against a real Postgres.
 *
 * This file decides what a driver can change about themselves after being
 * approved, which is the surface an account takeover would go through. Both
 * failure directions are expensive and neither throws: too permissive and a
 * stolen account redirects payouts, too strict and a driver cannot fix a plate
 * number without an admin.
 *
 * ⚠ RLS is not exercised. The ownership checks inside the functions are.
 *
 * Usage: node scripts/pg/profile-harness.mjs
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

const edits = read('supabase/migrations/20250101000029_driver_profile_edits.sql');

await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key);
  create table public.who (id uuid);
  create function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1;
  $fn$;
  create function public.is_admin() returns boolean language sql stable as $fn$
    select false;
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
    area text, message text,
    context jsonb, actor_id uuid,
    created_at timestamptz not null default now()
  );

  -- Only the columns this file touches.
  create table public.driver_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    full_name text not null,
    phone text not null,
    nin text not null,
    address text not null,
    base_city text,
    vehicle_type text not null,
    plate_number text not null,
    license_id text not null,
    guarantor_name text not null,
    guarantor_phone text not null,
    guarantor_relationship text not null,
    guarantor_address text not null,
    guarantor_nin text not null,
    bank_name text not null,
    account_number text not null,
    account_name text not null,
    kin_name text not null,
    kin_phone text not null,
    kin_relationship text not null,
    vehicle_colour text,
    documents jsonb not null default '{}'::jsonb,
    status text not null default 'pending',
    review_note text,
    submitted_at timestamptz not null default now()
  );

  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    driver_id uuid,
    status text not null default 'Booked'
  );
`);

await db.exec(extractTable(edits, 'public.driver_edit_history'));
for (const fn of [
  'create or replace function public.driver_field_risk(',
  'create or replace function public.update_driver_profile(',
  'create or replace function public.my_edit_history(',
]) {
  await db.exec(extractFunction(edits, fn));
}

const DRIVER = '11111111-1111-1111-1111-111111111111';
await q('insert into auth.users values ($1)', [DRIVER]);
await q('insert into public.who values ($1)', [DRIVER]);

const seed = async () => {
  await db.exec('delete from public.driver_edit_history; delete from public.bookings;');
  await db.exec('delete from public.driver_applications');
  await q(
    `insert into public.driver_applications (
       user_id, full_name, phone, nin, address, base_city, vehicle_type, plate_number,
       license_id, guarantor_name, guarantor_phone, guarantor_relationship, guarantor_address,
       guarantor_nin, bank_name, account_number, account_name, kin_name, kin_phone,
       kin_relationship, vehicle_colour, status
     ) values ($1, 'Omolola Adedapo', '+2348011112222', '12345678901', '8 Lebanon', 'Ibadan',
       'Motorcycle', 'ABC123XY', 'LIC-9988', 'Tunde G', '+2348012223333', 'Uncle', '4 Bodija',
       '22222222222', 'GTBank', '0123456789', 'Omolola Adedapo', 'Ada K', '+2348013334444',
       'Sister', 'Red', 'approved')`,
    [DRIVER],
  );
};

const app = async () =>
  (await q('select * from public.driver_applications where user_id = $1', [DRIVER]))[0];

const patch = (obj) =>
  q('select public.update_driver_profile($1) as status', [JSON.stringify(obj)]);

const refusal = async (obj) => {
  try {
    await patch(obj);
    return null;
  } catch (error) {
    return error.message;
  }
};

console.log('running driver profile edits against Postgres…\n');

await run('scenario 1 — a low-risk edit applies at once', async () => {
  await seed();
  const result = await patch({ vehicle_colour: 'Blue', plate_number: 'XYZ789AB' });

  const row = await app();
  check('the value changes', row.vehicle_colour === 'Blue' && row.plate_number === 'XYZ789AB');
  check(
    'and approval is untouched',
    row.status === 'approved' && result[0].status === 'approved',
    'a driver repainting a van should not be taken off the road for it',
  );

  const history = await q('select * from public.driver_edit_history order by field');
  check('both changes are in the history', history.length === 2);
  check(
    'with the value before and after',
    history.some(
      (h) => h.field === 'vehicle_colour' && h.old_value === 'Red' && h.new_value === 'Blue',
    ),
  );
  check(
    'marked low risk and not suspending',
    history.every((h) => h.risk === 'low' && h.suspended_approval === false),
  );
});

await run('scenario 2 — a high-risk edit sends them back for review', async () => {
  await seed();
  const result = await patch({ full_name: 'Omolola A. Adedapo' });

  const row = await app();
  check('the status drops to under_review', row.status === 'under_review');
  check('and the function says so', result[0].status === 'under_review');
  check('the reviewer is told why', /re-verify/i.test(row.review_note ?? ''));
  check(
    'the history marks it as having suspended approval',
    (await q('select * from public.driver_edit_history'))[0].suspended_approval === true,
  );
});

await run('scenario 3 — a parcel in their hands blocks a high-risk edit', async () => {
  await seed();
  await q("insert into public.bookings (driver_id, status) values ($1, 'Picked Up')", [DRIVER]);

  const message = await refusal({ full_name: 'Someone Else' });
  check(
    'the edit is refused',
    message !== null && /Finish or release your current trip/.test(message),
    'advance_booking requires is_approved_driver, so suspending mid-delivery strands a parcel the driver cannot mark delivered and a recipient is waiting for',
  );
  check('and nothing changed', (await app()).full_name === 'Omolola Adedapo');
  check(
    'not even a history row',
    (await q('select 1 from public.driver_edit_history')).length === 0,
  );

  // A delivered parcel is not in their hands.
  await db.exec("update public.bookings set status = 'Delivered'");
  check('a finished trip does not block it', (await refusal({ full_name: 'Omolola A.' })) === null);
});

await run('scenario 4 — a low-risk edit is fine mid-delivery', async () => {
  await seed();
  await q("insert into public.bookings (driver_id, status) values ($1, 'In Transit')", [DRIVER]);

  check(
    'a plate correction still goes through while carrying',
    (await refusal({ plate_number: 'NEW111AA' })) === null,
    'nothing about a plate touches approval, so there is nothing to strand',
  );
});

await run('scenario 5 — bank details are sent to the cooling window', async () => {
  await seed();
  const message = await refusal({ account_number: '9999999999' });

  check(
    'the edit is refused here',
    message !== null && /Payout settings/.test(message),
    'request_payout_change already keeps the old account receiving for 48 hours while the driver keeps working — a second mechanism would disagree with it',
  );
  check('and the account number is unchanged', (await app()).account_number === '0123456789');
});

await run('scenario 6 — phone and email are not editable at all', async () => {
  await seed();
  for (const field of ['phone', 'email']) {
    const message = await refusal({ [field]: 'x' });
    check(
      `${field} is refused`,
      message !== null && /Contact support/.test(message),
      'guard_application_phone forces the application phone to equal the account phone; an OTP to a new number proves control of the new number, not the old one',
    );
  }
});

await run('scenario 7 — an unknown field is refused, not silently allowed', async () => {
  await seed();
  const message = await refusal({ commission_rate: '0' });
  check(
    'anything unclassified defaults to locked',
    message !== null && /cannot be edited/.test(message),
    'a column added next year would otherwise become editable by the driver it describes, on the day it is created',
  );
});

await run('scenario 8 — a mixed patch is not half-applied', async () => {
  await seed();
  const message = await refusal({ vehicle_colour: 'Green', account_number: '5555555555' });

  check('the whole patch is refused', message !== null);
  check(
    'and the low-risk half did not sneak through',
    (await app()).vehicle_colour === 'Red',
    'classifying every key before writing any is what makes this true',
  );
});

await run('scenario 9 — an unchanged value is not history', async () => {
  await seed();
  await patch({ vehicle_colour: 'Red', base_city: 'Lagos' });

  const history = await q('select field from public.driver_edit_history');
  check(
    'only the field that actually changed is recorded',
    history.length === 1 && history[0].field === 'base_city',
    'a trail full of "Lagos → Lagos" is a trail nobody reads',
  );
});

await run('scenario 10 — the driver-facing history hides most of the value', async () => {
  await seed();
  await patch({ full_name: 'Omolola Bola Adedapo' });

  const mine = await q('select * from public.my_edit_history()');
  check('the change is listed', mine.length === 1 && mine[0].field === 'full_name');
  check(
    'but only the last four characters are shown',
    mine[0].new_hint === '…dapo' || mine[0].new_hint?.length === 5,
    'old_value holds a NIN or a licence number when those change, and a history screen gets screenshotted',
  );
  check(
    'the full value is not in the driver-facing result',
    !JSON.stringify(mine).includes('Omolola Bola Adedapo'),
  );
});

await run('scenario 11 — the audit log names fields, never values', async () => {
  await seed();
  await patch({ nin: '99999999999' });

  const events = await q("select context from public.app_events where area = 'driver'");
  check('the event lists which field changed', JSON.stringify(events).includes('nin'));
  check(
    'and never what it changed to',
    !JSON.stringify(events).includes('99999999999'),
    'app_events is readable by more people than driver_edit_history is',
  );
});

await run('scenario 12 — an account with no application cannot patch one', async () => {
  await db.exec('delete from public.driver_applications');
  const message = await refusal({ vehicle_colour: 'Blue' });
  check(
    'it is refused rather than creating one',
    message !== null && /No driver application/.test(message),
  );
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed against Postgres.`);
  process.exit(1);
}

console.log(
  'PASS — low-risk edits apply without touching approval, identity edits send the driver\n' +
    '       back for review but never while a parcel is in their hands, bank and phone are\n' +
    '       refused here and pointed at the mechanisms that already handle them, an unknown\n' +
    '       field defaults to locked, and every change records what it was before.',
);
