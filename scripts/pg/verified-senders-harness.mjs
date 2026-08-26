/**
 * Runs the "only a verified sender may post" rule against a real Postgres,
 * under RLS.
 *
 * ⚠ This is the only place the rule is actually proved.
 *
 *   `postingGate` decides what the app *says*, and until 42 that was the whole
 *   enforcement — an app is a suggestion. Anyone with the anon key and curl
 *   could POST to `/rest/v1/bookings`. So the assertion that matters is not
 *   "the button is disabled", it is "the database refuses the row", and only a
 *   real Postgres running the real policy can show that.
 *
 * ⚠ Every earlier guard on this policy is re-proved here too.
 *
 *   42 drops and recreates "sender creates own". 09 left a warning about
 *   exactly that: recreating it with only the new condition would quietly
 *   remove the others and let a client post a parcel pre-assigned to a driver.
 *   A migration that adds one rule while silently dropping three would look
 *   like a success.
 *
 * Usage: node scripts/pg/verified-senders-harness.mjs
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
    console.error(`FAIL — ${label}`);
    console.error(`       ${error.message}`);
  }
}

const db = await PGlite.create();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

console.log('\nrunning the verified-sender rule against Postgres, under RLS…\n');

const SENDER = '11111111-1111-1111-1111-111111111111';
const DRIVER = '22222222-2222-2222-2222-222222222222';

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;

  create schema auth;
  create table public.who (id uuid);
  create function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1;
  $fn$;

  create table public.profiles (id uuid primary key, deleted_at timestamptz);

  create table public.sender_identity (
    user_id uuid primary key,
    status text not null default 'unverified'
  );

  create table public.photo_capture_sessions (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null,
    photo_path text,
    completed_at timestamptz,
    consumed_at timestamptz,
    liveness_status text,
    liveness_probability numeric,
    liveness_environment text,
    liveness_checked_at timestamptz,
    created_at timestamptz not null default now()
  );

  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    sender_id uuid not null,
    driver_id uuid,
    driver text,
    status text not null default 'Booked',
    sender_photo_path text,
    sender_photo_at timestamptz,
    liveness_status text,
    liveness_probability numeric,
    liveness_environment text,
    liveness_checked_at timestamptz,
    created_at timestamptz not null default now()
  );

  alter table public.bookings enable row level security;

  create policy "sender reads own"
    on public.bookings for select to authenticated
    using (sender_id = (select auth.uid()));

  /* 09's version of the function, which 42 does not replace. */
  create or replace function public.is_erased()
  returns boolean language sql stable security definer set search_path = '' as $fn$
    select coalesce(
      (select p.deleted_at is not null from public.profiles p where p.id = auth.uid()),
      false
    );
  $fn$;

  grant usage on schema public, auth to authenticated;
  grant select, insert on public.bookings to authenticated;
  grant select on public.photo_capture_sessions to authenticated;
  grant select on public.who, public.profiles, public.sender_identity to authenticated;

  insert into public.profiles (id) values ('${SENDER}'), ('${DRIVER}');
  insert into public.who values ('${SENDER}');
`);

/*
 * ⚠ 09's policy first, so the before/after is real.
 *
 *   Running only 42 would prove that *a* policy requires verification, not that
 *   42 is what introduced it. Asserting the gap exists before the migration is
 *   what stops this harness passing on a codebase where 42 was reverted.
 */
const policyFrom = (sql, label) => {
  const found = /drop policy if exists "sender creates own"[\s\S]*?with check \([\s\S]*?\);/.exec(
    sql,
  );
  if (!found) {
    console.error(`FAIL — could not find the insert policy in ${label}`);
    process.exit(1);
  }
  return found[0];
};

await db.exec(policyFrom(read('supabase/09_bans.sql'), '09_bans.sql'));

const asSender = () => db.exec(`set role authenticated;`);
const asOwner = () => db.exec('reset role;');

/*
 * ⚠ Every post carries a fresh session once 44 is applied.
 *
 *   Before 44 the column does not exist, so `session` stays out of the insert.
 *   After it, a parcel without one is refused — which is the whole point — so
 *   the helper mints one by default and the tests that care pass their own.
 */
let hasCaptureColumn = false;

const mintSession = async (owner = SENDER, over = {}) => {
  await asOwner();
  const [row] = await q(
    `insert into public.photo_capture_sessions
       (owner_id, photo_path, completed_at, consumed_at, liveness_status)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      owner,
      over.photo_path === undefined ? 'session/selfie.jpg' : over.photo_path,
      over.completed_at === undefined ? new Date().toISOString() : over.completed_at,
      over.consumed_at ?? null,
      over.liveness_status ?? 'passed',
    ],
  );
  await asSender();
  return row.id;
};

const post = async (overrides = {}) => {
  const row = { sender_id: SENDER, driver_id: null, driver: null, status: 'Booked', ...overrides };

  if (!hasCaptureColumn) {
    return q(
      `insert into public.bookings (sender_id, driver_id, driver, status)
       values ($1, $2, $3, $4) returning id`,
      [row.sender_id, row.driver_id, row.driver, row.status],
    );
  }

  const session =
    overrides.session === undefined ? await mintSession(row.sender_id) : overrides.session;

  return q(
    `insert into public.bookings (sender_id, driver_id, driver, status, capture_session_id)
     values ($1, $2, $3, $4, $5) returning id`,
    [row.sender_id, row.driver_id, row.driver, row.status, session],
  );
};

const setStatus = async (status) => {
  await asOwner();
  await db.exec(`delete from public.sender_identity;`);
  if (status !== null) {
    await db.exec(
      `insert into public.sender_identity (user_id, status) values ('${SENDER}', '${status}')`,
    );
  }
  await asSender();
};

/* ================= 1. the gap 42 closes is a real one =================== */

await run('before 42, an unverified account can post', async () => {
  await setStatus('unverified');
  const message = await refusal(() => post());

  check(
    'the insert succeeds',
    message === null,
    'if 09 already refused this, 42 is not the migration that introduced the rule',
  );
});

/* Now apply 42, in the order a deployment would. */
await asOwner();
await db.exec(read('supabase/42_verified_senders_only.sql').replace(/notify pgrst[^;]*;/g, ''));
await db.exec('grant execute on function public.is_verified_sender() to authenticated;');
await db.exec('delete from public.bookings;');

/* ===================== 2. only verified may post ======================== */

/*
 * ⚠ Every status, not just the interesting one.
 *
 *   The rule that would pass a spot check and fail in production is
 *   `status <> 'rejected'` — it reads almost identically to the intent and lets
 *   three of the four straight through. Enumerating them is the only way that
 *   shows up.
 */
for (const status of ['unverified', 'pending', 'flagged', 'rejected']) {
  await run(`a "${status}" sender cannot post`, async () => {
    await setStatus(status);
    const message = await refusal(() => post());

    check(
      'the insert is refused',
      message !== null && /row-level security/i.test(message ?? ''),
      message === null
        ? `a "${status}" account posted a parcel — the block is client-side only again`
        : message,
    );

    await asOwner();
    const [{ n }] = await q('select count(*)::int as n from public.bookings');
    check('and no row was written', n === 0, `${n} booking(s) exist`);
    await asSender();
  });
}

await run('a verified sender can post', async () => {
  await setStatus('verified');
  const message = await refusal(() => post());

  check(
    'the insert is allowed',
    message === null,
    message ?? 'the gate refuses everybody, which is an outage rather than a rule',
  );
});

/*
 * ⚠ No identity row at all is not a loophole.
 *
 *   `is_verified_sender` reads a row that may not exist, and a bare subquery
 *   returns null rather than false. `null` in a policy's WITH CHECK is not
 *   true, so this happens to be refused either way — but "happens to" is not a
 *   guarantee, and a future rewrite with `coalesce(..., true)` or an outer join
 *   would open it silently.
 */
await run('an account with no identity row cannot post', async () => {
  await setStatus(null);
  const message = await refusal(() => post());
  check('the insert is refused', message !== null, 'a brand-new account is exactly the risk here');
});

/* ============ 3. the guards 42 inherited are still standing ============= */

/*
 * ⚠ 09's warning, enforced.
 *
 *   42 drops and recreates this policy. Recreating it with only the new
 *   condition would look like a success and would let a client post a parcel
 *   pre-assigned to a driver, or already marked delivered.
 */
await run('a verified sender still cannot post pre-assigned', async () => {
  await setStatus('verified');

  check(
    'a driver id is refused',
    (await refusal(() => post({ driver_id: DRIVER }))) !== null,
    'claiming is a separate step; 01 has refused this since the first migration',
  );
  check(
    'a driver name is refused',
    (await refusal(() => post({ driver: 'Someone' }))) !== null,
    '',
  );
  check(
    'and a status other than Booked is refused',
    (await refusal(() => post({ status: 'Delivered' }))) !== null,
    'a parcel posted as Delivered skips the entire delivery flow',
  );
});

await run('nor on somebody else’s behalf', async () => {
  await setStatus('verified');
  const message = await refusal(() => post({ sender_id: DRIVER }));
  check(
    'the insert is refused',
    message !== null,
    'the sender_id check is what ties a parcel to an account',
  );
});

await run('and an erased account still cannot post', async () => {
  await setStatus('verified');
  await asOwner();
  await db.exec(`update public.profiles set deleted_at = now() where id = '${SENDER}'`);
  await asSender();

  const message = await refusal(() => post());
  check(
    'the insert is refused',
    message !== null,
    '09 added this guard; a migration that recreates the policy must carry it',
  );

  await asOwner();
  await db.exec(`update public.profiles set deleted_at = null where id = '${SENDER}'`);
});

/* ================== 4. the predicate is not a courtesy ================== */

/*
 * ⚠ A non-admin can read the predicate, and that is intentional.
 *
 *   The app asks the same question to explain itself before somebody fills a
 *   form. What it must not do is *answer differently* for the caller than the
 *   policy does — so it reads `auth.uid()` rather than taking a parameter.
 *   A `is_verified_sender(target uuid)` would let any account probe whether any
 *   other account is verified.
 */
await run('the predicate cannot be asked about somebody else', async () => {
  await asOwner();
  const [row] = await q(`
    select count(*)::int as n
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'is_verified_sender'
       and p.pronargs > 0
  `);
  check(
    'it takes no arguments',
    row.n === 0,
    'a target parameter turns the gate into an oracle for other people’s verification state',
  );
});

/* ============= 5. no parcel without the selfie that authorised it ======== */

/*
 * ⚠ The failure that prompted this: a real parcel, a real selfie, nothing
 *   joining them.
 *
 *   The link used to be a second client call after the insert, and the booking
 *   form caught its failure and discarded it on purpose — the parcel was
 *   already posted, and sending somebody back to a completed form would have
 *   lost it. So a dropped connection, an unrun migration or a closed tab
 *   between two statements produced a parcel nobody could be held to, and the
 *   admin drawer said "No selfie on this parcel" beside an account that had
 *   taken one.
 */
await asOwner();
await db.exec(read('supabase/44_selfie_with_the_parcel.sql').replace(/notify pgrst[^;]*;/g, ''));
await db.exec('delete from public.bookings;');
hasCaptureColumn = true;

await run('a parcel with no session is refused', async () => {
  await setStatus('verified');
  const message = await refusal(() => post({ session: null }));

  check(
    'the insert is refused',
    message !== null && /row-level security/i.test(message ?? ''),
    message === null
      ? 'a parcel with no record of who posted it is exactly what this migration exists to stop'
      : message,
  );
});

await run('and a good session attaches the photo', async () => {
  await setStatus('verified');
  const session = await mintSession();
  const [row] = await post({ session });

  await asOwner();
  const [booking] = await q('select * from public.bookings where id = $1', [row.id]);

  check('the parcel exists', booking !== undefined, '');
  check(
    'carrying the photo',
    booking?.sender_photo_path === 'session/selfie.jpg',
    `got ${booking?.sender_photo_path}`,
  );
  check('and when it was taken', booking?.sender_photo_at !== null, '');
  check(
    'and the liveness verdict travels with it',
    booking?.liveness_status === 'passed',
    'the verdict is the difference between a photo and evidence',
  );
  check(
    'and the session it came from is recorded',
    booking?.capture_session_id === session,
    'without it there is nothing behind the path to investigate',
  );

  const [spent] = await q('select consumed_at from public.photo_capture_sessions where id = $1', [
    session,
  ]);
  check(
    'the session is spent',
    spent?.consumed_at !== null,
    'a reusable session is a reusable alibi',
  );
  await asSender();
});

/*
 * ⚠ Every guard the old `consume_capture_session` had, still standing.
 *
 *   Moving a check is the easiest way to lose one, and losing any of these is
 *   silent: the parcel posts, the photo attaches, and the thing it proves is
 *   not what anybody thinks.
 */
await run('somebody else’s selfie cannot authorise your parcel', async () => {
  await setStatus('verified');
  const theirs = await mintSession(DRIVER);
  const message = await refusal(() => post({ session: theirs }));

  check(
    'the insert is refused',
    message !== null && /not yours|already been used/i.test(message ?? ''),
    message ?? 'a parcel could then carry a photograph of somebody who has never used LOCI',
  );
});

await run('a spent session cannot be spent again', async () => {
  await setStatus('verified');
  const session = await mintSession();
  await post({ session });

  const message = await refusal(() => post({ session }));
  check(
    'the second parcel is refused',
    message !== null && /already been used/i.test(message ?? ''),
    'one photograph proving two handovers is one of them unproven',
  );
});

await run('an unfinished capture cannot authorise anything', async () => {
  await setStatus('verified');
  const empty = await mintSession(SENDER, { photo_path: null, completed_at: null });

  check(
    'a session with no photo is refused',
    (await refusal(() => post({ session: empty }))) !== null,
    'there is nothing on it to attach',
  );

  /*
   * ⚠ The case that makes `completed_at is not null` do any work.
   *
   *   With a null photo the claim already fails on the returned path, so
   *   deleting the completion guard changed nothing and the mutant survived.
   *   The state it uniquely stops is a row with bytes uploaded and the session
   *   never finalised — which has not been through `complete_capture_session`,
   *   so nothing has checked that the object is where the path says or that the
   *   uploader owns it.
   */
  const halfDone = await mintSession(SENDER, { completed_at: null });
  check(
    'and neither can one that was never finalised',
    (await refusal(() => post({ session: halfDone }))) !== null,
    'an upload that never completed its session has had none of the checks completion performs',
  );
});

/*
 * ⚠ A failed liveness check stops the parcel; an unavailable one does not.
 *
 *   14_liveness.sql made this call and it still holds. A provider outage is not
 *   the sender's fault, and blocking every parcel in the country over one would
 *   be a worse failure than recording an unchecked photo. A photo that was
 *   checked and *failed* is a different thing — something was held up to the
 *   camera that was not a live face.
 */
await run('a failed liveness check refuses the parcel', async () => {
  await setStatus('verified');
  const failed = await mintSession(SENDER, { liveness_status: 'failed' });
  const message = await refusal(() => post({ session: failed }));

  check(
    'the insert is refused',
    message !== null && /liveness/i.test(message ?? ''),
    message ?? 'a photo that failed the check is not evidence of anybody',
  );
});

await run('but an unavailable one does not', async () => {
  await setStatus('verified');
  const unavailable = await mintSession(SENDER, { liveness_status: 'unavailable' });
  const message = await refusal(() => post({ session: unavailable }));

  check(
    'the insert is allowed',
    message === null,
    message ?? 'a third-party outage must not stop every parcel in the country',
  );
});

/*
 * ⚠ And the rules 42 and 09 added are still there.
 *
 *   44 drops and recreates this policy for the fourth time. Each rewrite is a
 *   chance to lose the others silently.
 */
await run('an unverified sender still cannot post, session or not', async () => {
  await setStatus('pending');
  const message = await refusal(() => post());
  check(
    'the insert is refused',
    message !== null,
    'a valid selfie is not a substitute for approval',
  );
});

await run('and a verified one still cannot post pre-assigned', async () => {
  await setStatus('verified');
  const message = await refusal(() => post({ driver_id: DRIVER }));
  check('the insert is refused', message !== null, 'claiming is a separate step');
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — no parcel exists without the selfie that authorised it: the session is claimed\n' +
    '       inside the insert, cannot be reused, borrowed, unfinished or liveness-failed,\n' +
    '       and carries its verdict onto the row. Under RLS the database also refuses a\n' +
    '       parcel from an unverified, pending, flagged or\n' +
    '       rejected sender and from an account with no identity row at all, allows a\n' +
    '       verified one, and still carries every guard the policy had before 42 rewrote\n' +
    '       it — no pre-assigned driver, no invented status, no posting for somebody else,\n' +
    '       and nothing from an erased account.',
);
