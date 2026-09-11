/**
 * Runs the sender identity rules against a real Postgres.
 *
 * The branch this file guards decides how much a customer is asked for, and the
 * expensive failure is silent in both directions: onboarding somebody twice is
 * friction they will abandon over, and skipping it means a shipment goes out
 * with nobody checked.
 *
 * ⚠ RLS is not exercised here. PGlite has no `auth.uid()` beyond the stub below,
 *   so the ownership checks *inside functions* are tested and the row-level
 *   policies are not. A pass says the logic is right, not that the policies are.
 *
 * Usage: node scripts/pg/identity-harness.mjs
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

/** One statement, from a line start to its terminating semicolon. */
function extractStatement(sql, signatureStart) {
  const at = statementStart(sql, signatureStart);
  const end = sql.indexOf(';', at);
  if (end === -1) throw new Error(`unterminated statement: ${signatureStart}`);
  return sql.slice(at, end + 1);
}

/** The `create table` and everything up to its closing paren. */
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

const identity = read('supabase/migrations/20250101000028_sender_identity.sql');
const handoff = read('supabase/migrations/20250101000034_identity_handoff.sql');

await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key);
  create table public.who (id uuid);
  create function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1;
  $fn$;
  create function public.is_admin() returns boolean language sql stable as $fn$
    select true;
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
`);

await db.exec(extractTable(identity, 'public.sender_identity'));
for (const fn of [
  'create or replace function public.sender_needs_onboarding(',
  'create or replace function public.sender_has_reference(',
  'create or replace function public.begin_identity_check(',
  'create or replace function public.record_identity_result(',
  'create or replace function public.admin_flagged_identities(',
]) {
  await db.exec(extractFunction(identity, fn));
}

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOLA = '22222222-2222-2222-2222-222222222222';
await q('insert into auth.users values ($1), ($2)', [ALICE, BOLA]);

const signIn = async (who) => {
  await db.exec('delete from public.who');
  await q('insert into public.who values ($1)', [who]);
};

const needsOnboarding = async (who) =>
  (await q('select public.sender_needs_onboarding($1) as v', [who]))[0].v;

const hasReference = async (who) =>
  (await q('select public.sender_has_reference($1) as v', [who]))[0].v;

const row = async (who) =>
  (await q('select * from public.sender_identity where user_id = $1', [who]))[0] ?? null;

console.log('running sender identity against Postgres…\n');

await run('scenario 1 — a new sender does the full onboarding', async () => {
  await signIn(ALICE);
  check('a brand new account needs onboarding', (await needsOnboarding(ALICE)) === true);

  await q('select public.begin_identity_check($1, $2)', ['123-4567-8901', `${ALICE}/slip.jpg`]);

  const saved = await row(ALICE);
  check('the NIN is stored as digits only', saved.nin === '12345678901');
  check('and the account is pending, not verified', saved.status === 'pending');
  check(
    'a pending account still needs onboarding',
    (await needsOnboarding(ALICE)) === true,
    'starting the check is not passing it; treating pending as done would skip the selfie for everyone who abandoned halfway',
  );
});

await run('scenario 2 — the NIN is never written to the log', async () => {
  const logged = await q(
    "select context from public.app_events where message = 'sender started identity onboarding'",
  );
  check('the event carries only the last four digits', logged[0]?.context?.nin_last4 === '8901');
  check(
    'and never the whole number',
    !JSON.stringify(logged).includes('12345678901'),
    'a log line is the easiest place in the system for a government identifier to end up somewhere it should not be',
  );
});

await run('scenario 3 — a slip has to belong to the account claiming it', async () => {
  await signIn(ALICE);
  let refused = false;
  try {
    await q('select public.begin_identity_check($1, $2)', ['12345678901', `${BOLA}/slip.jpg`]);
  } catch {
    refused = true;
  }
  check(
    'a path in somebody else folder is rejected',
    refused,
    'this function is SECURITY DEFINER and writes whatever path it is handed, so storage RLS does not cover it',
  );
});

await run('scenario 4 — a bad NIN never reaches the provider', async () => {
  await signIn(ALICE);
  const bad = ['1234567890', '123456789012', 'abcdefghijk'];
  let refusedAll = true;
  for (const value of bad) {
    try {
      await q('select public.begin_identity_check($1, $2)', [value, `${ALICE}/slip.jpg`]);
      refusedAll = false;
    } catch {
      /* expected */
    }
  }
  check('eleven digits, or nothing', refusedAll);
});

await run('scenario 5 — a match promotes the selfie to master reference', async () => {
  await q('select public.record_identity_result($1, $2, $3, $4, $5)', [
    ALICE,
    'verified',
    `${ALICE}/reference.jpg`,
    92,
    'sandbox',
  ]);

  const saved = await row(ALICE);
  check('the account is verified', saved.status === 'verified');
  check('the reference photo is stored', saved.reference_path === `${ALICE}/reference.jpg`);
  check(
    'with the confidence and the environment',
    Number(saved.confidence) === 92 && saved.environment === 'sandbox',
  );
  check(
    'and onboarding is done',
    (await needsOnboarding(ALICE)) === false,
    'this is the whole point — the next shipment asks for a selfie and nothing else',
  );
  check('with a reference to compare against', (await hasReference(ALICE)) === true);
});

await run('scenario 6 — a mismatch flags but does not block or enrol', async () => {
  await signIn(BOLA);
  await q('select public.begin_identity_check($1, $2)', ['22222222222', `${BOLA}/slip.jpg`]);
  await q('select public.record_identity_result($1, $2, $3, $4, $5)', [
    BOLA,
    'flagged',
    `${BOLA}/reference.jpg`,
    12,
    'sandbox',
  ]);

  const saved = await row(BOLA);
  check('the account is flagged', saved.status === 'flagged');
  check(
    'and the unmatched selfie is NOT promoted to reference',
    saved.reference_path === null,
    'enrolling a face nobody confirmed would make every later comparison agree with the wrong person',
  );
  check(
    'a flagged account is not sent round onboarding again',
    (await needsOnboarding(BOLA)) === false,
    'they gave a NIN, a slip and a photo; a human decides next, and asking again punishes them for a decision nobody has made',
  );
  check(
    'but it has no reference to compare against',
    (await hasReference(BOLA)) === false,
    'these are different questions, and asking them as one predicate sent flagged accounts round onboarding forever',
  );
});

await run('scenario 7 — a provider outage decides nothing', async () => {
  const before = await row(ALICE);
  await q('select public.record_identity_result($1, $2, $3, $4, $5)', [
    ALICE,
    'unavailable',
    null,
    null,
    'sandbox',
  ]);
  const after = await row(ALICE);

  check('the verdict is untouched', after.status === before.status);
  check('the reference photo is untouched', after.reference_path === before.reference_path);
  check('but the attempt is recorded', after.checked_at !== null);
  check(
    'and it is logged as a warning',
    (
      await q(
        "select 1 from public.app_events where message = 'identity check could not be completed'",
      )
    ).length === 1,
    'Dojah being down is not evidence about the sender, in either direction',
  );
});

await run('scenario 8 — re-running onboarding clears the old verdict', async () => {
  await signIn(ALICE);
  await q('select public.begin_identity_check($1, $2)', ['99999999999', `${ALICE}/slip2.jpg`]);

  const saved = await row(ALICE);
  check('the status drops back to pending', saved.status === 'pending');
  check('the confidence is cleared', saved.confidence === null);
  check(
    'and the account needs onboarding again',
    (await needsOnboarding(ALICE)) === true,
    'a stale verified beside a new NIN would let somebody swap the identity behind an already-trusted account',
  );
});

await run('scenario 9 — an unknown verdict is refused', async () => {
  let refused = false;
  try {
    await q('select public.record_identity_result($1, $2)', [ALICE, 'approved']);
  } catch {
    refused = true;
  }
  check('only the three known outcomes are writable', refused);
});

await run('scenario 10 — the admin queue carries no identifiers', async () => {
  const queue = await q('select * from public.admin_flagged_identities()');
  check(
    'the flagged account is listed',
    queue.some((r) => r.user_id === BOLA),
  );
  check(
    'with only the last four digits of the NIN',
    queue.every((r) => r.nin_last4 === null || r.nin_last4.length === 4),
  );
  check(
    'and no photo path anywhere in the result',
    !JSON.stringify(queue).includes('reference.jpg') && !JSON.stringify(queue).includes('slip'),
    'a review queue is a screen somebody leaves open; it should not be a gallery of customers faces',
  );
});

// ------------------------------------- the driver verdict, and its handoff ---

/*
 * Scenario 11 covers the bug 20250101000034_identity_handoff.sql exists to fix.
 *
 * `verify-identity` used to write the verdict *only* onto
 * `driver_applications ... status = pending`, and the form called it before
 * inserting the application. Zero rows matched, and every first-time
 * applicant's identity columns stayed null while the code, the comments and an
 * assertion all said the check had run.
 *
 * ⚠ The stubs below carry the real guard trigger from 20250101000016_driver_identity.sql.
 *
 *   Without it this would prove nothing: the whole question is whether the copy
 *   gets *past* a trigger that refuses client writes to those columns, and a
 *   table with no trigger lets anything through. A stub looser than the thing
 *   it stands in for does not test the thing it stands in for.
 */
await db.exec(`
  create table public.photo_capture_sessions (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null,
    photo_path text,
    completed_at timestamptz
  );

  create table public.driver_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    status text not null default 'pending',
    identity_status text
      check (identity_status in ('matched', 'mismatch', 'unavailable', 'skipped')),
    identity_confidence numeric,
    identity_environment text
      check (identity_environment in ('sandbox', 'production')),
    identity_checked_at timestamptz
  );
`);

for (const statement of [
  extractStatement(handoff, 'alter table public.photo_capture_sessions'),
  extractFunction(handoff, 'create or replace function public.guard_identity_columns()'),
  extractFunction(handoff, 'create or replace function public.attach_identity_result('),
]) {
  await db.exec(statement);
}

await db.exec(`
  create trigger driver_applications_guard_identity
    before update on public.driver_applications
    for each row execute function public.guard_identity_columns();
  create trigger photo_capture_sessions_guard_identity
    before update on public.photo_capture_sessions
    for each row execute function public.guard_identity_columns();
`);

const SESSION = '33333333-3333-3333-3333-333333333333';
const APPLICATION = '44444444-4444-4444-4444-444444444444';

await run(
  'scenario 11 — the verdict survives being recorded before the application exists',
  async () => {
    await q(
      'insert into public.photo_capture_sessions (id, owner_id, photo_path) values ($1, $2, $3)',
      [SESSION, ALICE, `${ALICE}/selfie.jpg`],
    );

    /*
     * The service role writing the verdict. `auth.uid()` is null for it, which is
     * the branch the guard lets through.
     */
    await db.exec('delete from public.who');
    await q(
      `update public.photo_capture_sessions
        set identity_status = 'matched', identity_confidence = 97.4,
            identity_environment = 'production', identity_checked_at = now()
      where id = $1`,
      [SESSION],
    );

    await signIn(ALICE);
    await q('insert into public.driver_applications (id, user_id) values ($1, $2)', [
      APPLICATION,
      ALICE,
    ]);

    await q('select public.attach_identity_result($1, $2)', [APPLICATION, SESSION]);

    const app = (
      await q('select * from public.driver_applications where id = $1', [APPLICATION])
    )[0];
    check(
      'the verdict lands on the application',
      app.identity_status === 'matched' && Number(app.identity_confidence) === 97.4,
      JSON.stringify({ status: app.identity_status, confidence: app.identity_confidence }),
    );
    check(
      'with the environment that produced it',
      app.identity_environment === 'production',
      'a sandbox match is a mock service agreeing with a photo it never compared',
    );
  },
);

await run('scenario 12 — an applicant cannot write their own verdict', async () => {
  await signIn(ALICE);
  let refused = false;
  try {
    /*
      ⚠ 'mismatch', not 'matched'.

        My first version wrote 'matched' — which is what scenario 11 already
        left there. The guard compares old to new and correctly says nothing
        about a write that changes nothing, so the test passed the update
        through and reported the guard broken. The mutation has to actually
        mutate.
    */
    await q(`update public.driver_applications set identity_status = 'mismatch' where id = $1`, [
      APPLICATION,
    ]);
  } catch {
    refused = true;
  }
  check(
    'a direct update is refused',
    refused,
    'the exemption is transaction-local and set inside the function; a client update never has it',
  );

  refused = false;
  try {
    await q(`update public.photo_capture_sessions set identity_status = 'mismatch' where id = $1`, [
      SESSION,
    ]);
  } catch {
    refused = true;
  }
  check('and so is one against the session', refused);
});

await run('scenario 13 — the copy is scoped to the caller on both sides', async () => {
  const OTHER_APP = '55555555-5555-5555-5555-555555555555';
  await signIn(BOLA);
  await q('insert into public.driver_applications (id, user_id) values ($1, $2)', [
    OTHER_APP,
    BOLA,
  ]);

  let refused = false;
  try {
    await q('select public.attach_identity_result($1, $2)', [OTHER_APP, SESSION]);
  } catch {
    refused = true;
  }
  check(
    'somebody else session cannot be claimed',
    refused,
    'definer means RLS is not doing this for us',
  );

  await signIn(ALICE);
  refused = false;
  try {
    await q('select public.attach_identity_result($1, $2)', [OTHER_APP, SESSION]);
  } catch {
    refused = true;
  }
  check('and a verdict cannot be stamped on somebody else application', refused);

  const other = (await q('select * from public.driver_applications where id = $1', [OTHER_APP]))[0];
  check('which is left untouched', other.identity_status === null);
});

await run('scenario 14 — nothing to copy is not an error', async () => {
  const BLANK = '66666666-6666-6666-6666-666666666666';
  const APP = '77777777-7777-7777-7777-777777777777';
  await signIn(ALICE);
  await q('insert into public.photo_capture_sessions (id, owner_id) values ($1, $2)', [
    BLANK,
    ALICE,
  ]);
  await q('insert into public.driver_applications (id, user_id) values ($1, $2)', [APP, ALICE]);

  await q('select public.attach_identity_result($1, $2)', [APP, BLANK]);

  const app = (await q('select * from public.driver_applications where id = $1', [APP]))[0];
  check(
    'an unchecked session leaves the application alone rather than raising',
    app.identity_status === null,
    'no Dojah credentials on a deployment must not mean nobody can apply',
  );
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed against Postgres.`);
  process.exit(1);
}

console.log(
  'PASS — a sender onboards once and is asked for a selfie thereafter, a mismatch flags\n' +
    '       without blocking and without enrolling the unmatched face, a provider outage\n' +
    '       decides nothing, re-running onboarding clears the old verdict, neither the NIN\n' +
    '       nor a photo path reaches a log or an admin queue, and a driver verdict recorded\n' +
    '       before the application existed still reaches the reviewer without letting the\n' +
    '       applicant write it themselves.',
);
