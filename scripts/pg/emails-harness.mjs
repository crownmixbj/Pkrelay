/**
 * Runs the email triggers against a real Postgres.
 *
 * ⚠ The thing under test is not "does an email get queued". It is "does exactly
 *   one get queued, and only when something actually happened".
 *
 *   `after update` fires on every update. An admin saving a row twice, a
 *   profile edit touching an approved application, a status rewritten to the
 *   value it already held — each is a second email to somebody who has already
 *   read the first, and each is invisible in development because nobody updates
 *   a row twice by hand.
 *
 *   None of that can be asserted by reading the SQL. It needs the real trigger
 *   semantics, which is what this harness runs.
 *
 * ⚠ pg_net is stubbed, and that is the point of the stub.
 *
 *   PGlite has no `net` schema. The real `dispatch_email` swallows the failure
 *   so that a missing extension cannot roll back a delivery — so the stub here
 *   *records* calls instead, which lets the dispatch count be asserted rather
 *   than assumed.
 *
 * Usage: node scripts/pg/emails-harness.mjs
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

console.log('\nrunning the email triggers against Postgres…\n');

/* ------------------------------------------------- the tables they need -- */

await db.exec(`
  /*
    ⚠ The Supabase roles, created because the migration revokes from them.

      A bare PGlite has no \`anon\` or \`authenticated\`, so the REVOKE at the
      bottom of the migration aborts the whole file — and a harness that
      dropped those statements to get past it would stop testing the grants
      that keep this table away from clients.
  */
  create role anon;
  create role authenticated;
  create role service_role;

  create schema auth;
  create table auth.users (id uuid primary key, email text);

  create function public.is_admin() returns boolean language sql stable as $fn$
    select false;
  $fn$;

  create table public.driver_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    reference text,
    full_name text,
    email text,
    base_city text,
    status text not null default 'pending'
      check (status in ('pending', 'under_review', 'approved', 'rejected')),
    review_note text
  );

  create table public.sender_identity (
    user_id uuid primary key,
    status text not null default 'unverified'
      check (status in ('unverified', 'pending', 'verified', 'flagged')),
    nin text
  );

  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    tracking_id text,
    sender_id uuid,
    driver_id uuid,
    driver text,
    recipient_name text,
    origin_city text,
    destination_city text,
    estimated_fee numeric,
    proof_path text,
    cancellation_reason text,
    cancelled_role text check (cancelled_role in ('sender', 'driver')),
    status text not null default 'Booked'
  );

  create table public.dispatch_offers (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid,
    driver_id uuid,
    status text not null default 'offered',
    expires_at timestamptz
  );

  create table public.payout_requests (
    id uuid primary key default gen_random_uuid(),
    driver_id uuid,
    amount numeric,
    account_number text,
    status text not null default 'requested'
      check (status in ('requested', 'paid', 'failed', 'cancelled'))
  );

  /*
    ⚠ private.app_settings and app_events, which 53 needs and 38 never did.

      38 read its configuration from GUCs alone. 53 reads the settings table
      first — the one every other notifier in the project uses — and writes to
      app_events on every path that does not send, which is the half that turned
      a silent no-op into something somebody can find.
  */
  create schema private;
  create table private.app_settings (key text primary key, value text);

  create table public.app_events (
    id bigserial primary key,
    level text not null check (level in ('info', 'warning', 'error')),
    area text not null,
    message text not null,
    context jsonb not null default '{}'::jsonb,
    actor_id uuid,
    created_at timestamptz not null default now()
  );

  /*
    The pg_net stub. Records rather than sends, so "how many times did this
    dispatch" is answerable.
  */
  create schema net;
  create table public.net_calls (id bigserial primary key, url text, body jsonb);
  create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}')
  returns bigint language plpgsql as $fn$
  begin
    insert into public.net_calls (url, body) values (url, body);
    return 1;
  end;
  $fn$;
`);

await db.exec(read('supabase/migrations/20250101000038_transactional_email.sql'));

/*
 * ⚠ 24's resolver, cut out of the shipped migration rather than retyped.
 *
 *   53 calls `private.pg_net_post_fn()` instead of hardcoding `net.http_post`,
 *   which is the bug 19 had, 24 fixed, and 38 reintroduced. A paraphrase here
 *   would be a second copy of the thing that keeps drifting.
 */
const resolver = read('supabase/migrations/20250101000024_push_delivery.sql').match(
  /create or replace function private\.pg_net_post_fn\(\)[\s\S]*?\$\$;\n/,
);
if (!resolver) {
  console.error('FAIL — could not find private.pg_net_post_fn in 24');
  process.exit(1);
}
await db.exec(resolver[0]);

await db.exec(read('supabase/migrations/20250101000053_email_dispatch_repair.sql'));

/*
 * The settings the dispatcher reads. Set here so the pg_net path is actually
 * exercised — without them `dispatch_email` returns early and the call count
 * would be zero for reasons that have nothing to do with the triggers.
 */
await db.exec(`
  set app.settings.functions_url = 'https://test.functions';
  set app.settings.service_role_key = 'service-key';
`);

const ALICE = '11111111-1111-1111-1111-111111111111';
const DELE = '22222222-2222-2222-2222-222222222222';

await db.exec(`
  insert into auth.users (id, email) values
    ('${ALICE}', 'alice@example.test'),
    ('${DELE}', 'dele@example.test');
`);

const outbox = (kind) =>
  q('select * from public.email_outbox where kind = $1 order by created_at', [kind]);

/*
 * ⚠ Scoped to one subject, because a global count is a shared counter.
 *
 *   Several assertions read "one email of this kind" as `outbox(kind).length
 *   === 1`, which was true only while each kind appeared in exactly one
 *   scenario. Adding a second scenario for the same kind broke four assertions
 *   that were testing nothing about the code — the right question was always
 *   "one email about *this row*".
 */
const outboxFor = (kind, subject) =>
  q('select * from public.email_outbox where kind = $1 and subject_id = $2', [kind, subject]);

/* ============================ 1. account lifecycle ======================== */

await run('a driver approval queues exactly one email', async () => {
  const [app] = await q(
    `insert into public.driver_applications (user_id, reference, full_name, email, base_city)
     values ($1, 'LOCI-1', 'Dele Okon', 'dele@example.test', 'Lagos') returning id`,
    [DELE],
  );

  await q(`update public.driver_applications set status = 'approved' where id = $1`, [app.id]);

  const rows = await outbox('driver_application_approved');
  check('one approval email', rows.length === 1, `${rows.length} rows`);
  check('addressed to the applicant', rows[0]?.recipient === 'dele@example.test');
  check('carrying the reference', rows[0]?.payload?.reference === 'LOCI-1');

  /*
   * ⚠ The assertion this whole design exists for.
   *
   *   An admin pressing Approve twice, or any later write to an approved
   *   application — `20250101000029_driver_profile_edits.sql` writes to this table whenever
   *   a driver edits their profile — must not produce a second email.
   */
  await q(`update public.driver_applications set status = 'approved' where id = $1`, [app.id]);
  await q(`update public.driver_applications set full_name = 'Dele O.' where id = $1`, [app.id]);

  const after = await outbox('driver_application_approved');
  check(
    'and still one after a repeat approval and an unrelated edit',
    after.length === 1,
    `${after.length} rows — a driver has been told twice`,
  );
});

/*
 * ⚠ The case that separates the two idempotency guards.
 *
 *   My first harness proved nothing about `on conflict do nothing`: every
 *   repeat it tried was a status rewritten to the value it already held, which
 *   the transition guard catches first. Removing the conflict clause left the
 *   suite green.
 *
 *   A *genuine* second transition into the same state is what reaches it — an
 *   admin who rejects by mistake and then approves. Without the clause that is
 *   not a duplicate email, it is a unique violation thrown inside the trigger,
 *   which fails the UPDATE: the admin cannot approve the driver at all.
 */
await run('re-entering a state does not re-send, and does not break the update', async () => {
  const [app] = await q(
    `insert into public.driver_applications (user_id, reference, full_name, email)
     values ($1, 'LOCI-RE', 'Tunde A', 'tunde@example.test') returning id`,
    [DELE],
  );

  await q(`update public.driver_applications set status = 'approved' where id = $1`, [app.id]);
  await q(`update public.driver_applications set status = 'rejected' where id = $1`, [app.id]);
  /* Back again — a real transition, into a state already emailed about. */
  await q(`update public.driver_applications set status = 'approved' where id = $1`, [app.id]);

  const [row] = await q('select status from public.driver_applications where id = $1', [app.id]);
  check(
    'the approval goes through',
    row?.status === 'approved',
    'a unique violation inside the trigger would abort the admin\'s update entirely',
  );

  const rows = await q(
    `select * from public.email_outbox
      where kind = 'driver_application_approved' and subject_id = $1`,
    [app.id],
  );
  check('and only the first email exists', rows.length === 1, `${rows.length} rows`);
});

await run('a delivery re-entered does not re-send either', async () => {
  const [parcel] = await q(
    `insert into public.bookings (tracking_id, sender_id) values ('LC-RE', $1) returning id`,
    [ALICE],
  );

  await q(`update public.bookings set status = 'Delivered' where id = $1`, [parcel.id]);
  /* A driver correcting a mis-tap, then completing again. */
  await q(`update public.bookings set status = 'In Transit' where id = $1`, [parcel.id]);
  await q(`update public.bookings set status = 'Delivered' where id = $1`, [parcel.id]);

  const [row] = await q('select status from public.bookings where id = $1', [parcel.id]);
  check('the delivery stands', row?.status === 'Delivered');

  const rows = await q(
    `select * from public.email_outbox where kind = 'delivery_completed' and subject_id = $1`,
    [parcel.id],
  );
  check('one delivery email', rows.length === 1, `${rows.length} rows`);
});

await run('a rejection carries the note, and copes without one', async () => {
  const [withNote] = await q(
    `insert into public.driver_applications (user_id, reference, full_name, email, review_note)
     values ($1, 'LOCI-2', 'Ada Eze', 'ada@example.test', 'Licence expired') returning id`,
    [ALICE],
  );
  const [without] = await q(
    `insert into public.driver_applications (user_id, reference, full_name, email)
     values ($1, 'LOCI-3', 'Chidi N', 'chidi@example.test') returning id`,
    [ALICE],
  );

  await q(`update public.driver_applications set status = 'rejected' where id = $1`, [withNote.id]);
  await q(`update public.driver_applications set status = 'rejected' where id = $1`, [without.id]);

  const rows = await outbox('driver_application_rejected');
  const noted = rows.find((row) => row.payload?.reference === 'LOCI-2');
  const silent = rows.find((row) => row.payload?.reference === 'LOCI-3');
  check('both rejections queued', Boolean(noted) && Boolean(silent));
  check('the recorded reason travels', noted?.payload?.reason === 'Licence expired');
  check(
    'and a missing one is null rather than invented',
    silent !== undefined && silent.payload?.reason === null,
    'the template says so plainly; a fabricated reason is one support cannot stand behind',
  );
});

/*
 * ⚠ An account with no address on file.
 *
 *   `email` is nullable on an application, and `email_for_user` returns null
 *   for a deleted account. Without the guard in `queue_email` that is a
 *   NOT NULL violation raised inside the trigger — so approving the driver
 *   fails outright. The email is the least important thing lost.
 *
 *   The first version of this harness never reached that path: the only null
 *   recipient it produced was on the cancellation branch, which is already
 *   behind `if new.driver_id is not null`.
 */
await run('an approval with no address on file does not break the approval', async () => {
  const [app] = await q(
    `insert into public.driver_applications (user_id, reference, full_name, email)
     values ($1, 'LOCI-NOMAIL', 'No Address', null) returning id`,
    [DELE],
  );

  await q(`update public.driver_applications set status = 'approved' where id = $1`, [app.id]);

  const [row] = await q('select status from public.driver_applications where id = $1', [app.id]);
  check(
    'the approval still lands',
    row?.status === 'approved',
    'a NOT NULL violation inside the trigger aborts the admin\'s update',
  );
  check(
    'and nothing unsendable was queued',
    (await outboxFor('driver_application_approved', app.id)).length === 0,
    'a row with no recipient is one the function picks up, fails on, and records as a provider error',
  );
});

/*
 * ⚠ Submission and verdict are two emails, and a re-submission is a third.
 *
 *   Somebody flagged and trying again is the person most in need of hearing
 *   that their documents arrived. Keyed on the user id alone the unique
 *   constraint would swallow it.
 */
await run('submitting a NIN is acknowledged, every time', async () => {
  const CHIDI = '33333333-3333-3333-3333-333333333333';
  await q(`insert into auth.users (id, email) values ($1, 'chidi@example.test')`, [CHIDI]);
  await q(`insert into public.sender_identity (user_id, status) values ($1, 'unverified')`, [
    CHIDI,
  ]);

  await q(`update public.sender_identity set status = 'pending' where user_id = $1`, [CHIDI]);
  const first = await outbox('sender_verification_submitted');
  check('the first submission is acknowledged', first.length === 1, `${first.length} rows`);
  check('to the right address', first[0]?.recipient === 'chidi@example.test');

  /* Flagged, then they try again. */
  await q(`update public.sender_identity set status = 'flagged' where user_id = $1`, [CHIDI]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await q(`update public.sender_identity set status = 'pending' where user_id = $1`, [CHIDI]);

  const both = await outbox('sender_verification_submitted');
  check(
    'and so is the second',
    both.length === 2,
    `${both.length} rows — somebody re-submitting after a flag heard nothing`,
  );
});

await run('a sender is emailed on verification, and not on a flag', async () => {
  await q(`insert into public.sender_identity (user_id, status) values ($1, 'pending')`, [ALICE]);
  await q(`insert into public.sender_identity (user_id, status) values ($1, 'pending')`, [DELE]);

  await q(`update public.sender_identity set status = 'verified' where user_id = $1`, [ALICE]);
  await q(`update public.sender_identity set status = 'flagged' where user_id = $1`, [DELE]);

  const rows = await outbox('sender_verified');
  check('only the verified one', rows.length === 1, `${rows.length} rows`);
  check('to the right address', rows[0]?.recipient === 'alice@example.test');
  /*
   * ⚠ Flagged means a check disagreed with itself and a person has to look.
   *
   *   "Your verification failed" before anyone has reviewed it is premature and
   *   often wrong — an eight-year-old NIMC photo is the commonest cause.
   */
  check(
    'and nothing at all for the flagged one',
    rows.every((row) => row.recipient !== 'dele@example.test'),
    'telling somebody they failed before a human has looked is both premature and often wrong',
  );
});

/* ============================ 2. parcel lifecycle ======================== */

await run('delivery, cancellation and stages queue the right emails', async () => {
  const [parcel] = await q(
    `insert into public.bookings
       (tracking_id, sender_id, driver_id, driver, recipient_name,
        origin_city, destination_city, estimated_fee, proof_path)
     values ('LC-1', $1, $2, 'Dele Okon', 'Ngozi', 'Lagos', 'Ibadan', 5400, 'proofs/x.jpg')
     returning id`,
    [ALICE, DELE],
  );

  await q(`update public.bookings set status = 'In Transit' where id = $1`, [parcel.id]);
  await q(`update public.bookings set status = 'Delivered' where id = $1`, [parcel.id]);

  const stages = await outboxFor('parcel_status_changed', `${parcel.id}:In Transit`);
  check('an in-transit email', stages.length === 1, `${stages.length} rows`);
  /*
   * ⚠ The subject key carries the status for stage emails.
   *
   *   Keyed on the booking alone, the first stage change would be the only one
   *   a sender ever heard about.
   */
  check(
    'keyed on the stage, not just the parcel',
    String(stages[0]?.subject_id ?? '').endsWith(':In Transit'),
    'keyed on the booking alone, only the first stage change would ever send',
  );

  const delivered = await outboxFor('delivery_completed', parcel.id);
  check('a delivery email', delivered.length === 1, `${delivered.length} rows`);
  check('with the fare', Number(delivered[0]?.payload?.fare) === 5400);
  check('the recipient', delivered[0]?.payload?.recipient_name === 'Ngozi');
  check(
    'and a flag that proof exists rather than the path itself',
    delivered[0]?.payload?.has_proof === true &&
      !JSON.stringify(delivered[0]?.payload).includes('proofs/'),
    'a storage path in a payload is the first half of a link somebody will eventually build',
  );

  /* Delivered twice — a double-tap on the driver's Complete button. */
  await q(`update public.bookings set status = 'Delivered' where id = $1`, [parcel.id]);
  check(
    'a repeated delivery sends nothing more',
    (await outboxFor('delivery_completed', parcel.id)).length === 1,
  );
});

await run('a cancellation reaches the sender and the driver carrying it', async () => {
  const [parcel] = await q(
    `insert into public.bookings
       (tracking_id, sender_id, driver_id, origin_city, destination_city,
        cancellation_reason, cancelled_role)
     values ('LC-2', $1, $2, 'Lagos', 'Abuja', 'Changed my mind', 'sender')
     returning id`,
    [ALICE, DELE],
  );

  await q(`update public.bookings set status = 'Cancelled' where id = $1`, [parcel.id]);

  const sender = await outboxFor('parcel_cancelled', parcel.id);
  const driver = await outboxFor('driver_job_cancelled', parcel.id);

  check('the sender is told', sender.length === 1 && sender[0].recipient === 'alice@example.test');
  check('the reason travels', sender[0]?.payload?.reason === 'Changed my mind');
  /*
   * ⚠ A driver already on the road needs this before they arrive.
   *
   *   Fired from the same transition rather than a second trigger, so the two
   *   cannot disagree about when the cancellation happened.
   */
  check(
    'and so is the driver carrying it',
    driver.length === 1 && driver[0].recipient === 'dele@example.test',
    'somebody is driving to a pickup that is no longer happening',
  );
});

await run('an unassigned parcel cancels without emailing a driver', async () => {
  const [parcel] = await q(
    `insert into public.bookings (tracking_id, sender_id, origin_city, destination_city)
     values ('LC-3', $1, 'Lagos', 'Kano') returning id`,
    [ALICE],
  );

  const before = (await outbox('driver_job_cancelled')).length;
  await q(`update public.bookings set status = 'Cancelled' where id = $1`, [parcel.id]);

  check(
    'no driver email when nobody had it',
    (await outbox('driver_job_cancelled')).length === before,
    'email_for_user(null) is null, and queue_email must drop it rather than queue an unsendable row',
  );
});

/* ============================ 3. offers and money ======================== */

await run('an offer emails the driver it was made to', async () => {
  const [parcel] = await q(
    `insert into public.bookings (tracking_id, sender_id, origin_city, destination_city, estimated_fee)
     values ('LC-4', $1, 'Lagos', 'Ibadan', 4200) returning id`,
    [ALICE],
  );

  await q(
    `insert into public.dispatch_offers (booking_id, driver_id, expires_at)
     values ($1, $2, now() + interval '30 minutes')`,
    [parcel.id, DELE],
  );

  const rows = await outbox('driver_offer');
  check('one offer email', rows.length === 1, `${rows.length} rows`);
  check('to the driver', rows[0]?.recipient === 'dele@example.test');
  check('naming the route', rows[0]?.payload?.route === 'Lagos to Ibadan');
  check('and the fare', Number(rows[0]?.payload?.fare) === 4200);
});

await run('a payout emails only when it is actually paid', async () => {
  const [payout] = await q(
    `insert into public.payout_requests (driver_id, amount, account_number)
     values ($1, 12500, '0123456789') returning id`,
    [DELE],
  );

  await q(`update public.payout_requests set status = 'failed' where id = $1`, [payout.id]);
  check('nothing on a failure', (await outboxFor('payout_paid', payout.id)).length === 0);

  await q(`update public.payout_requests set status = 'paid' where id = $1`, [payout.id]);

  const rows = await outboxFor('payout_paid', payout.id);
  check('one on payment', rows.length === 1, `${rows.length} rows`);
  check('with the amount', Number(rows[0]?.payload?.amount) === 12500);
  /*
   * ⚠ Four digits, and the whole number nowhere in the row.
   *
   *   A full account number is enough to attempt a debit, and the outbox is a
   *   table plus a payload that reaches a third-party mail provider.
   */
  check(
    'and only the last four digits of the account',
    rows[0]?.payload?.account_hint === '6789' &&
      !JSON.stringify(rows[0]?.payload).includes('0123456789'),
    'a full account number in a mail provider is worth intercepting',
  );
});

/* ============================ the dispatch itself ======================= */

await run('every queued row was dispatched exactly once', async () => {
  const [{ count: queued }] = await q('select count(*)::int as count from public.email_outbox');
  const [{ count: posted }] = await q('select count(*)::int as count from public.net_calls');

  check(
    'one HTTP call per queued email',
    queued === posted,
    `${queued} queued, ${posted} dispatched — the two must match or something is sending twice`,
  );

  const [sample] = await q('select body from public.net_calls limit 1');
  /*
   * ⚠ The id, and nothing else.
   *
   *   A body carrying the rendered email would put a recipient address and
   *   somebody's parcel into pg_net's request log.
   */
  check(
    'the call carries an id rather than the email',
    Object.keys(sample?.body ?? {}).length === 1 && 'outbox_id' in (sample?.body ?? {}),
    'a recipient address in a pg_net body is a recipient address in a log',
  );
});

await run('an unconfigured project queues without failing the transaction', async () => {
  await db.exec(`reset app.settings.functions_url;`);

  const [parcel] = await q(
    `insert into public.bookings (tracking_id, sender_id) values ('LC-9', $1) returning id`,
    [ALICE],
  );

  /*
   * ⚠ The delivery must still be recorded.
   *
   *   A driver completing a job on a project with no mail settings — a fresh
   *   clone, a staging database — must not have the delivery rolled back
   *   because of it.
   */
  await q(`update public.bookings set status = 'Delivered' where id = $1`, [parcel.id]);

  const [row] = await q(`select status from public.bookings where id = $1`, [parcel.id]);
  check('the delivery stands', row?.status === 'Delivered');

  const queued = await q(
    `select * from public.email_outbox where subject_id = $1 and kind = 'delivery_completed'`,
    [parcel.id],
  );
  check(
    'and the email waits in the outbox',
    queued.length === 1 && queued[0].sent_at === null,
    'unsent is the retry queue and the evidence, both',
  );
});

/* ============== 5. the dispatch itself, repaired by 53 =================== */

/*
 * ⚠ This section exists because the dispatcher had two silent exits and nobody
 *   could tell it apart from a working one.
 *
 *   38's `dispatch_email` returned early when unconfigured and swallowed every
 *   exception, writing nothing anywhere. On production that produced two outbox
 *   rows from August with `attempts = 0`, `error` null, and no record that a
 *   delivery had ever been attempted — indistinguishable from an email that was
 *   sent and read.
 */

const reset = () =>
  db.exec(`
    delete from public.net_calls;
    delete from public.app_events;
    delete from private.app_settings;
    reset app.settings.functions_url;
    reset app.settings.service_role_key;
  `);

/** Queues one email directly, bypassing the business triggers. */
let queued = 0;
const queue = async (recipient = 'someone@example.test') => {
  queued += 1;
  await q(`select public.queue_email('parcel_status_changed', $1, $2, '{}'::jsonb)`, [
    `dispatch-${queued}`,
    recipient,
  ]);
  const [row] = await q(`select * from public.email_outbox where subject_id = $1`, [
    `dispatch-${queued}`,
  ]);
  return row;
};

await run('an unconfigured project says so, once', async () => {
  await reset();

  await queue();

  const posted = await q('select * from public.net_calls');
  check('nothing is posted', posted.length === 0);

  const logged = await q(`select * from public.app_events where area = 'email'`);
  check(
    'and the database says why',
    logged.length === 1 && /not configured/i.test(logged[0]?.message ?? ''),
    'the silent return is what made this cost an evening; the row is the whole fix',
  );
  check(
    'naming the fix rather than the symptom',
    /app_settings/.test(JSON.stringify(logged[0]?.context ?? {})),
  );

  /*
   * ⚠ Throttled, because an unconfigured project queues an email on every
   *   driver decision and every parcel status change. One row per email would
   *   bury the one worth reading under thousands of copies within a day.
   */
  await queue();
  await queue();
  const again = await q(`select * from public.app_events where area = 'email'`);
  check('and does not say it again for an hour', again.length === 1, `${again.length} rows`);
});

await run('the settings table is enough on its own', async () => {
  await reset();
  await db.exec(`
    insert into private.app_settings (key, value) values
      ('edge_url', 'https://table.functions'), ('service_key', 'table-key');
  `);

  const row = await queue();

  const posted = await q('select * from public.net_calls');
  check('it posts', posted.length === 1, `${posted.length} calls`);
  check(
    'to notify-events',
    posted[0]?.url === 'https://table.functions/notify-events',
    `posted to ${posted[0]?.url}`,
  );
  /*
   * ⚠ The id and nothing else — 38's rule, kept.
   *
   *   A rendered email here would put a recipient address into
   *   `net._http_response`, and make this an endpoint that mails whatever it is
   *   handed.
   */
  check(
    'carrying the id and nothing else',
    posted[0]?.body?.outbox_id === row.id && Object.keys(posted[0]?.body ?? {}).length === 1,
    JSON.stringify(posted[0]?.body),
  );

  const [after] = await q('select attempts from public.email_outbox where id = $1', [row.id]);
  check(
    'and the attempt is counted',
    after?.attempts === 1,
    'the column existed since 38 and nothing ever wrote it',
  );
});

/*
 * ⚠ 38's own mechanism still works, and that is deliberate.
 *
 *   A database where somebody followed 38's comment and ran the two `alter
 *   database` statements is a configured database. 53 must not un-configure it
 *   on the way past.
 */
await run('and 38ʼs GUCs still work where somebody set them', async () => {
  await reset();
  await db.exec(`
    set app.settings.functions_url = 'https://guc.functions';
    set app.settings.service_role_key = 'guc-key';
  `);

  await queue();

  const posted = await q('select * from public.net_calls');
  check('it posts', posted.length === 1, `${posted.length} calls`);
  check('to the GUC url', posted[0]?.url === 'https://guc.functions/notify-events');
});

await run('the settings table wins when both are set', async () => {
  await reset();
  await db.exec(`
    insert into private.app_settings (key, value) values
      ('edge_url', 'https://table.functions'), ('service_key', 'table-key');
    set app.settings.functions_url = 'https://guc.functions';
    set app.settings.service_role_key = 'guc-key';
  `);

  await queue();

  const posted = await q('select * from public.net_calls');
  check(
    'the table is the source of truth',
    posted[0]?.url === 'https://table.functions/notify-events',
    'every other notifier in the project reads the table; email must not disagree',
  );
});

/* ------------------------------------------------------------- the sweep -- */

await run('an email that missed its trigger is retried', async () => {
  await reset();
  await db.exec(`
    insert into private.app_settings (key, value) values
      ('edge_url', 'https://table.functions'), ('service_key', 'table-key');
  `);

  const row = await queue();
  await db.exec(`delete from public.net_calls;`);

  /*
   * A minute of grace in the sweep, so it never races the trigger's own
   * request — which means the row has to be backdated to be swept at all.
   */
  const backdate = (id) =>
    q(`update public.email_outbox set created_at = now() - interval '10 minutes' where id = $1`, [
      id,
    ]);
  await backdate(row.id);

  const [{ sweep_unsent_emails: first }] = await q('select public.sweep_unsent_emails()');
  check('it retries the unsent row', first === 1, `retried ${first}`);

  const posted = await q('select * from public.net_calls');
  check('posting it again', posted.length === 1 && posted[0]?.body?.outbox_id === row.id);

  /*
   * ⚠ Three attempts and it stops.
   *
   *   A row failing for a fourth time is failing for a reason a fourth request
   *   will not fix. It stays in the table as the evidence rather than as a job
   *   that runs for ever.
   */
  await q(`update public.email_outbox set attempts = 3 where id = $1`, [row.id]);
  const [{ sweep_unsent_emails: capped }] = await q('select public.sweep_unsent_emails()');
  check('and gives up after three', capped === 0, `retried ${capped}`);
});

await run('a sent email is never swept', async () => {
  await reset();
  await db.exec(`
    insert into private.app_settings (key, value) values
      ('edge_url', 'https://table.functions'), ('service_key', 'table-key');
  `);

  const row = await queue();
  await q(
    `update public.email_outbox
        set sent_at = now(), attempts = 1, created_at = now() - interval '10 minutes'
      where id = $1`,
    [row.id],
  );
  await db.exec(`delete from public.net_calls;`);

  const [{ sweep_unsent_emails: retried }] = await q('select public.sweep_unsent_emails()');
  check('nothing to do', retried === 0, `retried ${retried}`);

  const posted = await q('select * from public.net_calls');
  check('and nobody is emailed twice', posted.length === 0);
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — every trigger queues exactly one email and only on a real transition, a repeated\n' +
    '       approval or delivery sends nothing more, a flagged identity sends nothing at all,\n' +
    '       a cancelled parcel reaches both sides, no payload carries a full account number or\n' +
    '       a storage path, and an unconfigured project queues without losing the delivery —\n' +
    '       and the dispatcher now posts to notify-events from either configuration, counts\n' +
    '       the attempt, retries what missed, stops after three, never sends twice, and says\n' +
    '       in app_events exactly why when it cannot send at all.',
);
