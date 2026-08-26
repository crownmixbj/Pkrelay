/**
 * Runs the sender identity review rules against a real Postgres.
 *
 * ⚠ The whole feature is "a person may overrule a machine", and every guard on
 *   it is behaviour rather than shape.
 *
 *   Who may decide, what may be decided, what a decision does to the account,
 *   and whether the person on the other end is ever told — none of that can be
 *   asserted by reading the SQL. It is asserted here by doing it.
 *
 * ⚠ The half that matters most is the way back in.
 *
 *   A rejection blocks a sender from posting, which is the sharpest thing this
 *   codebase does to a customer. The rules that make it survivable — a reason
 *   is mandatory, resubmitting clears it, the email carries the reason and
 *   nothing else — are tested at least as carefully as the refusal itself.
 *
 * Usage: node scripts/pg/identity-review-harness.mjs
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

console.log('\nrunning the sender identity review against Postgres…\n');
const KIND_CHECK = (() => {
  const found = /kind text not null (check \(kind in \([\s\S]*?\)\))/.exec(
    read('supabase/38_transactional_email.sql'),
  );
  if (!found) {
    console.error('FAIL — could not lift the kind constraint out of 38');
    process.exit(1);
  }
  return found[1];
})();



const SENDER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const ADMIN = '33333333-3333-3333-3333-333333333333';

/*
 * ⚠ `is_admin()` and `auth.uid()` are switchable, not stubbed to true.
 *
 *   A harness that hardcodes `is_admin() -> true` proves the happy path and
 *   nothing else — and "only an administrator can do this" is the first
 *   sentence of every function here. Deleting that check has to fail.
 */
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;

  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create table public.who (id uuid);
  create table public.admins (id uuid primary key);

  create function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1;
  $fn$;

  create function public.is_admin() returns boolean language sql stable as $fn$
    select exists (select 1 from public.admins where id = auth.uid());
  $fn$;

  create table public.profiles (id uuid primary key, full_name text);

  create table public.app_events (
    id uuid primary key default gen_random_uuid(),
    level text, area text, message text,
    context jsonb, actor_id uuid,
    created_at timestamptz not null default now()
  );

  create table public.sender_identity (
    user_id uuid primary key references auth.users (id) on delete cascade,
    nin text check (nin ~ '^[0-9]{11}$'),
    slip_path text,
    reference_path text,
    status text not null default 'unverified'
      check (status in ('unverified', 'pending', 'verified', 'flagged')),
    confidence numeric,
    environment text check (environment in ('sandbox', 'production')),
    verified_at timestamptz,
    checked_at timestamptz,
    created_at timestamptz not null default now()
  );

  /*
   * ⚠ The kind constraint is real, and lifted out of 38 rather than retyped.
   *
   *   Without it this harness happily queued a kind the production outbox would
   *   refuse. verify-emails.ts caught that, not this file, and only because it
   *   compares the migration against the template map. A rejected kind raises
   *   inside queue_email, in the reviewer's transaction, so the whole decision
   *   rolls back with a message about a check constraint.
   */
  create table public.email_outbox (
    id uuid primary key default gen_random_uuid(),
    kind text not null ${KIND_CHECK},
    subject_id text not null,
    recipient text not null,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (kind, subject_id)
  );

  create function public.queue_email(p_kind text, p_subject_id text, p_recipient text, p_payload jsonb)
  returns void language plpgsql as $fn$
  begin
    if p_recipient is null or btrim(p_recipient) = '' then return; end if;
    insert into public.email_outbox (kind, subject_id, recipient, payload)
    values (p_kind, p_subject_id, btrim(p_recipient), coalesce(p_payload, '{}'::jsonb))
    on conflict (kind, subject_id) do nothing;
  end;
  $fn$;

  create function public.email_for_user(target uuid) returns text language sql stable as $fn$
    select email from auth.users where id = target;
  $fn$;

  insert into auth.users (id, email) values
    ('${SENDER}', 'bolaji@example.test'),
    ('${OTHER}', 'ada@example.test'),
    ('${ADMIN}', 'ops@example.test');
  insert into public.profiles (id, full_name) values
    ('${SENDER}', 'Bolaji Noah'), ('${OTHER}', 'Ada K');
  insert into public.admins (id) values ('${ADMIN}');
`);

await db.exec(read('supabase/41_sender_identity_review.sql'));

const beAdmin = () =>
  db.exec(`delete from public.who; insert into public.who values ('${ADMIN}');`);
const beSender = (who = SENDER) =>
  db.exec(`delete from public.who; insert into public.who values ('${who}');`);

const submit = async (who = SENDER, nin = '12345678901') => {
  await beSender(who);
  await q(`select public.begin_identity_check($1, $2)`, [nin, `${who}/slip-1.jpg`]);
};

const statusOf = async (who = SENDER) =>
  (await q(`select * from public.sender_identity where user_id = $1`, [who]))[0];

/* ======================= 1. only an administrator decides ================ */

await run('a sender cannot verify themselves', async () => {
  await submit();
  await beSender();

  const message = await refusal(() =>
    q(`select public.admin_review_identity($1, 'verified', null)`, [SENDER]),
  );
  check(
    'the call is refused',
    message !== null && /administrator/i.test(message ?? ''),
    'an account that can call this is an account that can mark itself verified',
  );

  const row = await statusOf();
  check('and the status has not moved', row?.status === 'pending', `status was ${row?.status}`);
});

await run('nor can another signed-in sender decide for them', async () => {
  await beSender(OTHER);
  const message = await refusal(() =>
    q(`select public.admin_review_identity($1, 'rejected', 'Not you')`, [SENDER]),
  );
  check('the call is refused', message !== null && /administrator/i.test(message ?? ''), '');
});

await run('and a non-admin sees nothing in the queue', async () => {
  await beSender();
  const rows = await q(`select * from public.admin_identity_queue()`);
  /*
   * ⚠ Empty rather than an error, because that is what `is_admin()` in a
   *   `where` clause produces — and an empty list is the failure that looks
   *   like success. Worth pinning so nobody "fixes" the queue by dropping the
   *   predicate after seeing zero rows in testing.
   */
  check('it is empty', rows.length === 0, 'a non-admin reading this list reads other people’s IDs');
});

await run('nor may they look at the documents', async () => {
  await beSender();
  const message = await refusal(() =>
    q(`select * from public.admin_reveal_identity_for_user($1, 'curious')`, [SENDER]),
  );
  check('the reveal is refused', message !== null && /administrator/i.test(message ?? ''), '');
});

/* ==================== 2. what is actually waiting for a person =========== */

await run('a check that never ran is in the queue', async () => {
  await beAdmin();
  const rows = await q(`select * from public.admin_identity_queue()`);
  const mine = rows.find((r) => r.user_id === SENDER);

  check(
    'the pending sender is listed',
    Boolean(mine),
    'until verify-identity is deployed, this is every sender there is',
  );
  check('with their name', mine?.full_name === 'Bolaji Noah', '');
  check('and their email', mine?.email === 'bolaji@example.test', '');
  check(
    'and the slip is known to exist',
    mine?.has_slip === true,
    'a reviewer needs to know whether there is anything to look at before they open it',
  );
});

/*
 * ⚠ The list carries no NIN and no paths, and that is the point of it being a
 *   separate call from the reveal.
 *
 *   Working a queue is not looking at somebody's face. If the list carried the
 *   photo paths, every page load would be an unlogged reveal — and the audit
 *   line the reveal writes would mean nothing, because the data was already on
 *   screen without one.
 */
await run('the queue leaks neither the NIN nor a path', async () => {
  await beAdmin();
  const [row] = await q(`select * from public.admin_identity_queue()`);
  const values = JSON.stringify(row);

  check(
    'the full NIN is absent',
    !values.includes('12345678901'),
    'a government identifier on a list screen is one screenshot from somewhere it cannot be recalled from',
  );
  check('only the last four are returned', row?.nin_last4 === '8901', `got ${row?.nin_last4}`);
  check(
    'no storage path is returned',
    !values.includes('slip-1.jpg'),
    'a path in the list is a reveal nobody logged',
  );
});

/* ========================= 3. looking is on the record =================== */

await run('opening the documents writes an audit line', async () => {
  await beAdmin();
  const before = (
    await q(`select count(*)::int as n from public.app_events where area = 'privacy'`)
  )[0].n;

  const [revealed] = await q(
    `select * from public.admin_reveal_identity_for_user($1, 'Reviewing the ID queue')`,
    [SENDER],
  );

  const events = await q(
    `select * from public.app_events where area = 'privacy' order by created_at desc limit 1`,
  );

  check('one line was written', events.length === 1 && before === 0, '');
  check(
    'naming who looked',
    events[0]?.actor_id === ADMIN,
    'an audit that cannot name the reader is not an audit',
  );
  check('and why', /Reviewing the ID queue/.test(JSON.stringify(events[0]?.context)), '');
  check(
    'the reason is capped rather than stored whole',
    /left\(coalesce\(reason, ''\), 200\)/.test(read('supabase/41_sender_identity_review.sql')),
    'an unbounded free-text field written by an operator into an audit table is a place to hide things',
  );

  check('the slip path comes back', revealed?.slip_path === `${SENDER}/slip-1.jpg`, '');
  check(
    'and still only four digits of the NIN',
    revealed?.nin_last4 === '8901' && !JSON.stringify(revealed).includes('12345678901'),
    'the reviewer is comparing a face to a document; the number is not the question',
  );
});

/* ====================== 4. a rejection must say why ====================== */

await run('a rejection with no reason is refused', async () => {
  await beAdmin();

  for (const note of [null, '', '   ']) {
    const message = await refusal(() =>
      q(`select public.admin_review_identity($1, 'rejected', $2)`, [SENDER, note]),
    );
    /*
     * ⚠ The exact sentence, not merely the word "reason".
     *
     *   Two guards cover this — the function below and the check constraint on
     *   the table — and the constraint is named
     *   `sender_identity_rejection_has_reason`, so a loose `/reason/i` match
     *   passed with the function's guard deleted. The two masked each other and
     *   the suite stayed green.
     *
     *   They are not redundant: the constraint is the guarantee, and the
     *   function is what makes the failure *readable*. An operator who gets
     *   "new row violates check constraint" has been told nothing about what to
     *   type. So the message is what is pinned here, and the constraint is
     *   pinned separately below, by writing to the table directly.
     */
    check(
      `a note of ${JSON.stringify(note)} is not a reason`,
      message !== null && /A rejection must record a reason/.test(message ?? ''),
      `got: ${message ?? 'no error at all'} — the operator sees this string, so it has to be one`,
    );
  }

  const row = await statusOf();
  check('and nothing was written', row?.status === 'pending', `status was ${row?.status}`);
});

/*
 * ⚠ The constraint, not only the function.
 *
 *   `admin_review_identity` is the intended path, and it is not the only one:
 *   the SQL editor, a migration and a future function all write this table
 *   directly. A rejected row with no note would be a person blocked and never
 *   told why, produced by a route the function never saw.
 */
await run('and the table itself refuses one', async () => {
  const message = await refusal(() =>
    db.exec(`update public.sender_identity set status = 'rejected', review_note = null
              where user_id = '${SENDER}'`),
  );
  check(
    'the constraint bites',
    message !== null && /rejection_has_reason/i.test(message ?? ''),
    'the function is the door people use, not the only door there is',
  );
});

/* ======================= 5. the verdict, and what it does ================ */

await run('an approval verifies and promotes the selfie', async () => {
  await beAdmin();
  await db.exec(
    `update public.sender_identity set candidate_path = '${SENDER}/selfie-1.jpg', status = 'flagged',
            confidence = 0.41 where user_id = '${SENDER}'`,
  );

  await q(`select public.admin_review_identity($1, 'verified', null)`, [SENDER]);
  const row = await statusOf();

  check('the account is verified', row?.status === 'verified', `status was ${row?.status}`);
  check('the reviewer is recorded', row?.reviewed_by === ADMIN, '');
  check('and when', row?.reviewed_at !== null, '');
  /*
   * ⚠ The promotion is the difference between "verified" and "verified and
   *   usable".
   *
   *   `record_identity_result` refuses to promote an unmatched selfie, and is
   *   right to: no automated comparison should be made against a face a machine
   *   did not confirm. An administrator approving *is* that confirmation. Skip
   *   it and the sender is verified with no reference photo, so every future
   *   shipment falls back to a selfie that is recorded and never compared —
   *   permanently, and invisibly.
   */
  check(
    'the selfie a person confirmed becomes the reference',
    row?.reference_path === `${SENDER}/selfie-1.jpg`,
    'without it they are verified but every later parcel still asks for an unmatched photo',
  );
});

await run('an approval is not a second decision waiting to happen', async () => {
  await beAdmin();
  const message = await refusal(() =>
    q(`select public.admin_review_identity($1, 'rejected', 'Changed my mind about this')`, [
      SENDER,
    ]),
  );
  check(
    'a decided account cannot be decided again',
    message !== null && /not awaiting review/i.test(message ?? ''),
    'overwriting reviewed_by loses who made the first call, which is the thing an audit is for',
  );
});

await run('and an account that submitted nothing cannot be approved', async () => {
  await beAdmin();
  await db.exec(
    `insert into public.sender_identity (user_id, status) values ('${OTHER}', 'unverified')`,
  );

  const message = await refusal(() =>
    q(`select public.admin_review_identity($1, 'verified', null)`, [OTHER]),
  );
  check(
    'the call is refused',
    message !== null && /not awaiting review/i.test(message ?? ''),
    'verifying an account with no NIN and no photo is verifying nothing at all',
  );
});

await run('an unknown verdict is refused', async () => {
  await beAdmin();
  const message = await refusal(() =>
    q(`select public.admin_review_identity($1, 'maybe', 'hmm')`, [OTHER]),
  );
  check('only two verdicts exist', message !== null && /unknown verdict/i.test(message ?? ''), '');
});

/* ==================== 6. the rejection, and the way out ================== */

let firstRejectionAt;

await run('a rejection blocks and explains', async () => {
  await submit(OTHER);
  await beAdmin();

  await q(`select public.admin_review_identity($1, 'rejected', $2)`, [
    OTHER,
    'The slip photo is too blurry to read the number.',
  ]);

  const row = await statusOf(OTHER);
  firstRejectionAt = row?.reviewed_at;

  check('the account is rejected', row?.status === 'rejected', `status was ${row?.status}`);
  check(
    'and carries the reason',
    row?.review_note === 'The slip photo is too blurry to read the number.',
    '',
  );

  const [mail] = await q(
    `select * from public.email_outbox where kind = 'sender_verification_rejected'`,
  );
  check('an email is queued', Boolean(mail), 'otherwise they find out only by reopening the app');
  check('to them', mail?.recipient === 'ada@example.test', '');
  check(
    'carrying the reason',
    mail?.payload?.reason === 'The slip photo is too blurry to read the number.',
    'a refusal email with no reason is the one people reply to and support cannot answer',
  );
  /*
   * ⚠ Nothing else travels.
   *
   *   The outbox is a table an admin can read and a payload that ends up at a
   *   mail provider. No sentence in this email needs the NIN or a link to a
   *   photo, so neither is in it.
   */
  const body = JSON.stringify(mail?.payload);
  check(
    'and no NIN or path',
    !body.includes('12345678901') && !body.includes('slip-') && !body.includes('selfie-'),
    body,
  );
});

await run('an approval email is not sent to a rejected sender', async () => {
  const rows = await q(
    `select * from public.email_outbox where kind = 'sender_verified' and recipient = 'ada@example.test'`,
  );
  check('none queued', rows.length === 0, 'two contradictory emails is worse than either one');
});

/*
 * ⚠ The single most important test in this file.
 *
 *   The block exists to get a better photo, not to end the relationship. If
 *   resubmitting did not clear the review, the sender would do everything asked
 *   and be exactly as blocked as before — with a stale rejection note still on
 *   their profile explaining a photo they have already replaced.
 */
await run('resubmitting reopens it', async () => {
  await submit(OTHER, '99988877766');
  const row = await statusOf(OTHER);

  check('the account is waiting again', row?.status === 'pending', `status was ${row?.status}`);
  check(
    'the old reason is gone',
    row?.review_note === null,
    'a stale note explains a photo that no longer exists',
  );
  check('and so is the reviewer', row?.reviewed_by === null && row?.reviewed_at === null, '');

  await beAdmin();
  const queue = await q(`select * from public.admin_identity_queue()`);
  check(
    'and it is back in front of a reviewer',
    queue.some((r) => r.user_id === OTHER && r.status === 'pending'),
    'clearing the block without re-queueing it leaves them waiting on nobody',
  );
});

/*
 * ⚠ A second rejection has to reach them too.
 *
 *   `email_outbox` is unique on (kind, subject_id) with `on conflict do
 *   nothing` — that is what makes it exactly-once. Keyed on the user alone, a
 *   sender rejected twice for two different reasons is told once, and the
 *   second reason — the one about the photo they just took — is the one that
 *   goes missing.
 */
await run('a second rejection sends a second email', async () => {
  await beAdmin();
  await q(`select public.admin_review_identity($1, 'rejected', $2)`, [
    OTHER,
    'The selfie does not show your whole face.',
  ]);

  const rows = await q(
    `select payload ->> 'reason' as reason from public.email_outbox
      where kind = 'sender_verification_rejected' order by created_at`,
  );

  check('both were queued', rows.length === 2, `${rows.length} email(s) for two rejections`);
  check(
    'and the second carries the new reason',
    rows[1]?.reason === 'The selfie does not show your whole face.',
    'the reason they need is the one about the photo they just replaced',
  );

  const row = await statusOf(OTHER);
  check('with a different timestamp', row?.reviewed_at > firstRejectionAt, '');
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — only an administrator can see the queue, open the documents or decide; the list\n' +
    '       carries no NIN and no paths while the reveal writes one audited line naming who\n' +
    '       looked and why; a rejection cannot be saved without a reason, by the function or\n' +
    '       by the table; approval verifies and promotes the confirmed selfie; nothing\n' +
    '       already decided or never submitted can be decided; and a rejected sender is\n' +
    '       emailed the reason, resubmits, and lands back in front of a reviewer.',
);
