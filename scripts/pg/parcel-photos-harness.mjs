/**
 * Runs the parcel photo rules against a real Postgres.
 *
 * Two functions, guarding two different things, and the difference between them
 * is the design:
 *
 *   `attach_parcel_photo`      the sender records their own parcel's photo, and
 *                              cannot name the path or somebody else's parcel
 *   `admin_reveal_sender_identity`  staff read a face and a NIN slip, and the
 *                              reading is recorded in the same transaction
 *
 * ⚠ Storage RLS is not exercised — PGlite has no `storage` schema — so the
 *   policies in the migration are asserted statically in `verify-admin-parcels`
 *   instead. What runs here is every check written inside the functions.
 *
 * Usage: node scripts/pg/parcel-photos-harness.mjs
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

const photos = read('supabase/migrations/20250101000036_parcel_photos.sql');
const identity = read('supabase/migrations/20250101000037_admin_sender_identity.sql');

console.log('\nrunning parcel photo rules against Postgres…\n');

await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key);
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
      ⚠ The real CHECK constraint, copied from 20250101000007_admin.sql.

        Every harness once stubbed this as a bare \`level text\`, so twelve
        inserts across nine migrations wrote 'warn' — which the real table
        refuses — and every suite passed. A stub looser than the thing it stands
        in for does not test the thing it stands in for.
    */
    level text not null check (level in ('info', 'warning', 'error')),
    area text, message text,
    context jsonb, actor_id uuid,
    created_at timestamptz not null default now()
  );

  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    tracking_id text default 'LOCI-0001',
    sender_id uuid,
    sender_photo_path text,
    item_photo_path text
  );

  create table public.sender_identity (
    user_id uuid primary key,
    nin text check (nin ~ '^[0-9]{11}$'),
    slip_path text,
    reference_path text,
    status text not null default 'unverified'
      check (status in ('unverified', 'pending', 'verified', 'flagged'))
  );
`);

await db.exec(extractFunction(photos, 'create or replace function public.attach_parcel_photo('));

/*
 * The reveal comes from 37, which drops 36's face-only version and replaces it
 * with one covering the selfie and the NIN slip together. Loading both would
 * leave whichever ran last in place by accident rather than on purpose.
 */
await db.exec(
  extractFunction(identity, 'create or replace function public.admin_reveal_sender_identity('),
);

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOLA = '22222222-2222-2222-2222-222222222222';
/* Never onboards, so scenario 5 has somebody with genuinely nothing on file. */
const CHIDI = '33333333-3333-3333-3333-333333333333';
await q('insert into auth.users values ($1), ($2), ($3)', [ALICE, BOLA, CHIDI]);

const signIn = async (who, admin = false) => {
  await db.exec('delete from public.who');
  await q('insert into public.who values ($1, $2)', [who, admin]);
};

const signOut = () => db.exec('delete from public.who');

const parcel = async (owner) =>
  (await q('insert into public.bookings (sender_id) values ($1) returning id', [owner]))[0].id;

const pathOf = async (id) =>
  (await q('select item_photo_path from public.bookings where id = $1', [id]))[0].item_photo_path;

const refused = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

// ------------------------------------------------------------- attaching ---

await run('scenario 1 — the sender records their own parcel photo', async () => {
  await signIn(ALICE);
  const id = await parcel(ALICE);

  await q('select public.attach_parcel_photo($1, $2)', [id, 'shot.jpg']);

  check(
    'the path is the parcel id and the file, joined server-side',
    (await pathOf(id)) === `${id}/shot.jpg`,
    await pathOf(id),
  );
});

await run('scenario 2 — nobody attaches to a parcel that is not theirs', async () => {
  await signIn(ALICE);
  const mine = await parcel(ALICE);

  await signIn(BOLA);
  check(
    'a stranger is refused',
    await refused(() => q('select public.attach_parcel_photo($1, $2)', [mine, 'theirs.jpg'])),
    'the folder is checked by storage RLS too, but a client that could set the column could point a parcel at any object',
  );
  check('and the column is untouched', (await pathOf(mine)) === null);

  await signOut();
  check(
    'and a signed-out caller is refused',
    await refused(() => q('select public.attach_parcel_photo($1, $2)', [mine, 'anon.jpg'])),
  );
});

await run('scenario 3 — the file name cannot climb out of the folder', async () => {
  await signIn(ALICE);
  const id = await parcel(ALICE);

  for (const name of ['../other/photo.jpg', '.hidden', '', '///']) {
    check(
      `"${name}" is refused`,
      await refused(() => q('select public.attach_parcel_photo($1, $2)', [id, name])),
      "a caller naming the whole path could claim another parcel's object",
    );
  }

  /*
    And a name that is merely untidy is cleaned rather than refused: somebody
    photographing a parcel should not be stopped by their camera\'s naming.
  */
  await q('select public.attach_parcel_photo($1, $2)', [id, 'photo (1).jpg']);
  check(
    'a name with spaces and brackets is sanitised, not rejected',
    (await pathOf(id)) === `${id}/photo1.jpg`,
    await pathOf(id),
  );
});

// -------------------------------------------------------------- revealing --

await run('scenario 4 — only an admin sees a sender, and it is written down', async () => {
  await signIn(ALICE);
  const id = await parcel(ALICE);
  await q('update public.bookings set sender_photo_path = $1 where id = $2', [
    'session-abc/face.jpg',
    id,
  ]);
  await q(
    `insert into public.sender_identity (user_id, nin, slip_path, status)
     values ($1, $2, $3, 'verified')`,
    [ALICE, '12345678901', `${ALICE}/slip-1.jpg`],
  );

  check(
    'the sender cannot reveal it themselves',
    await refused(() => q('select * from public.admin_reveal_sender_identity($1, $2)', [id, 'x'])),
    'this is the admin door; a sender reads their own files through storage RLS',
  );
  check(
    'and nothing was logged for a refused attempt',
    (await q("select count(*)::int as n from public.app_events where area = 'privacy'"))[0].n === 0,
    'a log entry for a read that did not happen is noise in the one place noise is expensive',
  );

  await signIn(BOLA, true);
  const [row] = await q('select * from public.admin_reveal_sender_identity($1, $2)', [
    id,
    'driver reported the wrong person at pickup',
  ]);

  check('the selfie comes back', row.selfie_path === 'session-abc/face.jpg', row.selfie_path);
  check('and the slip', row.slip_path === `${ALICE}/slip-1.jpg`, row.slip_path);
  check('and the check result', row.identity_status === 'verified', row.identity_status);

  /*
   * ⚠ Four digits, not eleven.
   *
   *   An operator comparing a slip to a face does not need the number, and a
   *   full government identifier on a support screen is one screenshot away
   *   from somewhere it can never be recalled from.
   */
  check('the NIN is reduced to its last four digits', row.nin_last4 === '8901', row.nin_last4);
  check(
    'and the whole number is nowhere in the answer',
    !JSON.stringify(row).includes('12345678901'),
    JSON.stringify(row),
  );

  const logged = await q(
    "select * from public.app_events where message = 'admin revealed sender identity'",
  );
  check('the view is logged once', logged.length === 1, `${logged.length} entries`);
  check('against the admin who looked', logged[0]?.actor_id === BOLA);
  check('at warning level, like the contact reveal', logged[0]?.level === 'warning');
  check(
    'naming the parcel and the reason',
    logged[0]?.context?.booking === id &&
      logged[0]?.context?.reason === 'driver reported the wrong person at pickup',
    JSON.stringify(logged[0]?.context),
  );
  check(
    'and never the NIN itself',
    !JSON.stringify(logged).includes('12345678901'),
    'the audit trail is the last place a government identifier should end up',
  );
});

await run('scenario 5 — a sender who never onboarded is an answer, not an error', async () => {
  /*
    ⚠ Chidi, not Alice.

      My first version reused Alice, who onboards in scenario 4 — so the join
      found her slip and the assertion failed for the right reason: the premise
      was wrong, not the code. A test for "nothing on file" needs somebody with
      nothing on file.
  */
  const id = await parcel(CHIDI);

  await signIn(BOLA, true);
  const [row] = await q('select * from public.admin_reveal_sender_identity($1, $2)', [id, '']);

  check('a row comes back', row !== undefined);
  check('with nothing in it', row?.selfie_path === null && row?.slip_path === null);
  check(
    'and no identity status',
    row?.identity_status === null,
    'the left join is what makes this an answer rather than an empty result',
  );

  const logged = await q(
    "select * from public.app_events where message = 'admin revealed sender identity' and context->>'booking' = $1",
    [id],
  );
  check(
    'and the attempt is on the record anyway',
    logged.length === 1,
    'somebody asking to identify a sender who turns out to have uploaded nothing still asked',
  );
});

await run('scenario 6 — the reason is bounded', async () => {
  await signIn(ALICE);
  const id = await parcel(ALICE);
  await signIn(BOLA, true);

  await q('select * from public.admin_reveal_sender_identity($1, $2)', [id, 'x'.repeat(500)]);

  const logged = await q(
    "select context->>'reason' as reason from public.app_events where context->>'booking' = $1",
    [id],
  );
  check(
    'a long reason is truncated rather than stored whole',
    logged[0].reason.length === 200,
    `${logged[0].reason.length} characters`,
  );
});

await run('scenario 7 — no audit line, no read', async () => {
  await signIn(ALICE);
  const id = await parcel(ALICE);
  await q('update public.bookings set sender_photo_path = $1 where id = $2', ['s/face.jpg', id]);

  /*
    ⚠ This does *not* prove the audit is written before the read, and I first
      wrote it claiming it did.

      Moving the insert below the select changes nothing observable: the
      function is one transaction, so a failing insert aborts the whole call
      either way. I checked by moving it, and this scenario stayed green. The
      ordering in the migration is worth keeping for the reader, but it is not
      load-bearing and no test can pin it.

      What this *does* pin is stronger and is the thing that matters: the audit
      and the read live or die together. If somebody later wraps the insert in
      an exception handler, or moves it to a background job so a busy queue
      never blocks an operator, the face starts being handed over with no record
      that it was — and this fails. A trigger that refuses every insert stands
      in for a full disk, a permissions change, or a constraint added later.
  */
  await db.exec(`
    create or replace function public.refuse_audit() returns trigger
      language plpgsql as $fn$ begin raise exception 'audit unavailable'; end; $fn$;
    create trigger app_events_refuse before insert on public.app_events
      for each row execute function public.refuse_audit();
  `);

  await signIn(BOLA, true);
  check(
    'the reveal fails when it cannot be logged',
    await refused(() =>
      q('select * from public.admin_reveal_sender_identity($1, $2)', [id, 'why']),
    ),
    'if the log can fail quietly, a face is handed over with no record that it was',
  );

  await db.exec('drop trigger app_events_refuse on public.app_events;');
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed against Postgres.`);
  process.exit(1);
}

console.log(
  'PASS — a sender attaches a photo only to their own parcel and never names its path,\n' +
    '       a traversal attempt is refused while an untidy file name is cleaned, only an\n' +
    '       admin reads a face or a NIN slip, the number itself is reduced to four digits\n' +
    '       and never logged, and every reading is recorded — with its reason, bounded —\n' +
    '       in the same transaction that returns the paths.',
);
