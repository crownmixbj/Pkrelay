/**
 * Runs the notification triggers against a real Postgres.
 *
 * The questions this answers are the ones no amount of reading the SQL settles:
 *
 *   - does an offer produce an inbox entry that does NOT push, so a driver gets
 *     one notification per job rather than two (see the header of 50)
 *   - does a parcel reaching Delivered tell both sides exactly once
 *   - does the payout wording stay inside what this system actually witnessed
 *   - and the one that matters most: does a broken notifier cost a push, or
 *     does it cost the delivery
 *
 * pg_net cannot run here, so `net.http_post` is replaced by a function that
 * records its arguments — the same substitution `push-harness.mjs` makes, for
 * the same reason.
 *
 * Usage: node scripts/pg/notifications-harness.mjs
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

// ------------------------------------------------------------- the schema --

/*
 * ⚠ Stubs keep the constraints that can actually reject a write.
 *
 *   `push-harness.mjs` learned this the expensive way with `app_events.level`:
 *   a stub looser than the real table does not test the real table. So the
 *   status vocabularies below are copied from the migrations that own them, and
 *   the foreign keys to auth.users are real — the FK is the thing 50's
 *   hardening block exists to survive.
 */
await db.exec(`
  /*
    The Supabase roles, because the migrations grant and revoke against them by
    name. PGlite starts with none, and a missing role is a hard error rather
    than a no-op — which is the right behaviour: a grant to a role that does not
    exist is a grant that silently protects nothing.
  */
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;

  create schema private;
  create schema auth;

  create function auth.uid() returns uuid language sql stable as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $fn$;

  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    email_confirmed_at timestamptz,
    deleted_at timestamptz,
    created_at timestamptz not null default now()
  );

  create table private.app_settings (key text primary key, value text not null);

  create table public.app_events (
    id bigint generated always as identity primary key,
    level text not null check (level in ('info', 'warning', 'error')),
    area text not null, message text not null,
    context jsonb not null default '{}'::jsonb,
    actor_id uuid, created_at timestamptz not null default now()
  );

  create table public.push_tokens (token text primary key, user_id uuid not null);
  create table public.email_outbox (
    id uuid primary key default gen_random_uuid(),
    kind text not null, subject_id text not null, unique (kind, subject_id)
  );

  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    tracking_id text not null,
    origin_city text not null, destination_city text not null,
    pickup_area text not null default '',
    received_by text, weight numeric not null default 5,
    estimated_fee numeric not null default 0,
    sender_id uuid references auth.users (id) on delete set null,
    driver_id uuid references auth.users (id) on delete set null,
    driver text,
    status text not null default 'Booked' check (status in
      ('Booked','Assigned','Picked Up','In Transit','Out for Delivery','Delivered','Cancelled')),
    accepted_at timestamptz, delivered_at timestamptz,
    cancellation_reason text, proof_path text,
    created_at timestamptz not null default now()
  );

  create table public.dispatch_offers (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null references public.bookings (id) on delete cascade,
    driver_id uuid not null references auth.users (id) on delete cascade,
    status text not null default 'offered'
      check (status in ('offered','accepted','declined','expired')),
    expires_at timestamptz not null default (now() + interval '10 minutes')
  );

  create table public.driver_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    full_name text not null default '', base_city text, review_note text,
    status text not null default 'pending' check (status in
      ('pending_guarantor','ready_for_review','pending','under_review','approved','rejected'))
  );

  create table public.driver_earnings (
    id uuid primary key default gen_random_uuid(),
    driver_id uuid not null references auth.users (id) on delete cascade,
    booking_id uuid not null unique references public.bookings (id) on delete cascade,
    gross numeric not null, commission_rate numeric not null,
    commission numeric not null, net numeric not null,
    earned_at timestamptz not null default now()
  );

  create table public.payout_requests (
    id uuid primary key default gen_random_uuid(),
    driver_id uuid not null references auth.users (id) on delete cascade,
    amount numeric not null check (amount > 0), bank_name text,
    status text not null default 'requested'
      check (status in ('requested','paid','failed','cancelled')),
    reference text, failure_reason text
  );

  create table public.sender_identity (
    user_id uuid primary key references auth.users (id) on delete cascade,
    status text not null default 'unverified' check (status in
      ('unverified','pending','verified','flagged','rejected')),
    review_note text
  );

  create or replace function private.pg_net_post_fn() returns text
  language sql stable set search_path = '' as $fn$
    select n.nspname || '.' || p.proname
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'http_post' and n.nspname in ('net','extensions','public')
    order by array_position(array['net','extensions','public'], n.nspname) limit 1;
  $fn$;

  -- Stands in for pg_net. Records rather than sends.
  create schema net;
  create table public.sent (url text, headers jsonb, body jsonb);
  create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}')
  returns bigint language sql as $fn$
    insert into public.sent values (url, headers, body);
    select 1::bigint;
  $fn$;

  -- Stands in for pg_cron, so the scheduling block is exercised rather than skipped.
  create schema cron;
  create table cron.job (jobid bigint generated always as identity, jobname text, schedule text, command text);
  create function cron.schedule(job_name text, sched text, cmd text) returns bigint
    language sql as $fn$ insert into cron.job(jobname,schedule,command) values(job_name,sched,cmd) returning jobid $fn$;
  create function cron.unschedule(job_name text) returns boolean
    language sql as $fn$ delete from cron.job where jobname = job_name returning true $fn$;
`);

/*
 * The migrations, whole, rather than functions picked out of them.
 *
 * `push-harness.mjs` extracts single functions because the file around them
 * needs a schema this harness does not have. These two are self-contained, so
 * running them entire also tests the guards, the grants and the cron block —
 * and proves the file applies, which extraction never does.
 */
await db.exec(read('supabase/migrations/20250101000049_notifications.sql'));
await db.exec(read('supabase/migrations/20250101000050_notification_triggers.sql'));

const DRIVER = '11111111-1111-1111-1111-111111111111';
const SENDER = '22222222-2222-2222-2222-222222222222';

await db.exec(`
  insert into auth.users (id, email, email_confirmed_at)
  values ('${DRIVER}', 'driver@test', now()), ('${SENDER}', 'sender@test', now());
  insert into private.app_settings (key, value)
  values ('edge_url', 'https://demo.functions.supabase.co'), ('service_key', 'svc-key-abc');
`);

const inbox = (kind) =>
  q('select * from public.notifications where kind = $1 order by created_at', [kind]);

const newBooking = async (tracking) =>
  (
    await q(
      `insert into public.bookings (tracking_id, origin_city, destination_city, weight, estimated_fee, sender_id)
       values ($1, 'Lagos', 'Ibadan', 12, 4500, $2) returning id`,
      [tracking, SENDER],
    )
  )[0].id;

console.log('running the notification triggers against Postgres…\n');

// --- 1. the file applies twice ----------------------------------------------

await run('scenario 1 — re-runnable', async () => {
  await db.exec(read('supabase/migrations/20250101000050_notification_triggers.sql'));
  /*
    Four jobs: retention from 49, plus pickup reminders, push retries and the
    unconfirmed-email chase from 50. The count is the assertion — `cron.schedule`
    appends, so a missing `unschedule` shows up here as duplicates rather than as
    an error, and duplicate jobs mean a driver chased twice.
  */
  const jobs = await q("select jobname from cron.job where jobname like 'loci-%' order by jobname");
  check(
    'applying 50 a second time schedules nothing twice',
    jobs.length === 4,
    `after two runs: ${jobs.map((j) => j.jobname).join(', ')}`,
  );
});

// --- 2. an offer does not push ----------------------------------------------

await run('scenario 2 — one offer, one notification', async () => {
  const booking = await newBooking('PKR-001');
  await q('insert into public.dispatch_offers (booking_id, driver_id) values ($1, $2)', [
    booking,
    DRIVER,
  ]);

  const rows = await inbox('offer_received');
  check('the offer reaches the inbox', rows.length === 1);
  check(
    'and is explicitly NOT pushed',
    rows[0]?.push_requested === false,
    'notify-offer already pushes offers — a pushable row here means every driver gets two notifications per job',
  );
  check(
    'so nothing is posted for it',
    (await q("select count(*)::int as n from public.sent where body->>'notification_id' = $1", [
      rows[0].id,
    ]))[0].n === 0,
  );
  check(
    'the body carries route, weight and fee in naira',
    /Lagos → Ibadan · 12 kg · ₦4,500/.test(rows[0]?.body ?? ''),
    rows[0]?.body,
  );
});

// --- 3. a delivery tells both sides, once -----------------------------------

await run('scenario 3 — delivered', async () => {
  const booking = await newBooking('PKR-002');
  await q(
    `update public.bookings set status='Assigned', driver_id=$2, driver='Test Driver', accepted_at=now() where id=$1`,
    [booking, DRIVER],
  );
  await q(`update public.bookings set status='Picked Up' where id=$1`, [booking]);
  await q(
    `update public.bookings set status='Delivered', delivered_at=now(), received_by='Ade' where id=$1`,
    [booking],
  );

  const done = await q(
    'select * from public.notifications where kind=$1 and subject_id=$2',
    ['delivery_completed', booking],
  );
  check('both sides are told', done.length === 2);
  check(
    'the sender is told who received it',
    done.some((r) => r.user_id === SENDER && /Received by Ade/.test(r.body)),
  );
  check(
    'Delivered does not also leak a status-change entry',
    (await q('select count(*)::int as n from public.notifications where subject_id = $1', [
      `${booking}:Delivered`,
    ]))[0].n === 0,
    'if/elsif ordering — the same mistake email_on_booking_status avoids in 38',
  );
  check(
    'the driver is not pushed about their own Picked Up tap',
    (await q(
      `select count(*)::int as n from public.notifications
        where user_id=$1 and subject_id=$2`,
      [DRIVER, `${booking}:Picked Up`],
    ))[0].n === 0,
  );
  check(
    'the sender sees Picked Up in the inbox without a buzz',
    (await q('select push_requested from public.notifications where subject_id=$1', [
      `${booking}:Picked Up`,
    ]))[0]?.push_requested === false,
  );
});

// --- 4. money, described honestly -------------------------------------------

await run('scenario 4 — payouts claim only what happened', async () => {
  const payout = (
    await q(
      `insert into public.payout_requests (driver_id, amount, bank_name) values ($1, 3600, 'GTBank') returning id`,
      [DRIVER],
    )
  )[0].id;
  await q(`update public.payout_requests set status='paid', reference='TRF-99' where id=$1`, [
    payout,
  ]);

  const [row] = await inbox('payout_paid');
  check('the title says marked as paid', /marked as paid/.test(row?.title ?? ''), row?.title);
  check(
    'and nothing claims a wallet was credited',
    !/credited|paystack/i.test(`${row?.title} ${row?.body}`),
    'settle_payout is an admin recording a manual transfer; this system never witnesses the money move',
  );
  check('the bank reference is carried', /TRF-99/.test(row?.body ?? ''), row?.body);
});

// --- 5. a broken notifier must not cost the delivery ------------------------

await run('scenario 5 — the notifier fails, the business does not', async () => {
  await db.exec(`
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}')
    returns bigint language plpgsql as $fn$ begin raise exception 'simulated pg_net outage'; end $fn$;
  `);

  const booking = await newBooking('PKR-003');
  await q(
    `update public.bookings set status='Assigned', driver_id=$2, driver='X', accepted_at=now() where id=$1`,
    [booking, DRIVER],
  );

  check(
    'the status change still committed',
    (await q('select status from public.bookings where id=$1', [booking]))[0].status === 'Assigned',
    'this is the failure 24 was written about: an AFTER trigger that raises aborts the transaction that fired it',
  );
  check(
    'and the failure was recorded rather than swallowed',
    (await q("select count(*)::int as n from public.app_events where area='push' and level='error'"))[0]
      .n > 0,
    'silence is how the last three of these went unnoticed for weeks',
  );
  check(
    'the service key never reaches the log',
    (await q("select count(*)::int as n from public.app_events where context::text like '%svc-key-abc%'"))[0]
      .n === 0,
  );

  await db.exec(`
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}')
    returns bigint language sql as $fn$
      insert into public.sent values (url, headers, body); select 1::bigint;
    $fn$;
  `);
});

// --- 6. what actually goes over the wire ------------------------------------

await run('scenario 6 — ids only', async () => {
  const [post] = await q(
    "select * from public.sent where url like '%notify-push' order by ctid desc limit 1",
  );
  check('it posts to notify-push', post?.url === 'https://demo.functions.supabase.co/notify-push');
  check('authenticating as the service role', post?.headers?.Authorization === 'Bearer svc-key-abc');
  check(
    'carrying the notification id and nothing else',
    post?.body?.notification_id && Object.keys(post.body).length === 1,
    'the title and body are already in the row; sending them here copies job details into net._http_response',
  );
});

// --- 7. an erased recipient ------------------------------------------------

await run('scenario 7 — the recipient is gone', async () => {
  const result = await q(
    "select public.queue_notification('deadbeef-0000-0000-0000-00000000dead', 'payout_paid', 'x', 'Gone') as id",
  );
  check('it returns null rather than raising', result[0].id === null);
  check(
    'and says so in app_events',
    (await q(
      "select count(*)::int as n from public.app_events where message like '%no longer exists%'",
    ))[0].n > 0,
    'erase_person racing a delivery must not stop the parcel being marked Delivered',
  );
});

// --- 8. reminders fire once -------------------------------------------------

await run('scenario 8 — pickup reminders', async () => {
  const booking = await newBooking('PKR-004');
  await q(
    `update public.bookings set status='Assigned', driver_id=$2, driver='X',
            accepted_at = now() - interval '31 minutes' where id=$1`,
    [booking, DRIVER],
  );

  check('a stalled pickup is chased', (await q('select public.sweep_pickup_reminders() as n'))[0].n === 1);
  check(
    'and only once, however often the sweeper runs',
    (await q('select public.sweep_pickup_reminders() as n'))[0].n === 0,
    'subject_id is the booking id, so a job that sits all day produces one reminder rather than twenty-four',
  );
});

// --- 9. retention -----------------------------------------------------------

await run('scenario 9 — retention keeps the evidence longer', async () => {
  await db.exec(`
    update public.notifications set created_at = now() - interval '100 days';
    update public.notifications set read_at = now() where kind = 'offer_received';
  `);
  await q('select public.sweep_notifications()');

  check(
    'a 100-day READ notification is gone',
    (await q("select count(*)::int as n from public.notifications where kind='offer_received'"))[0].n === 0,
  );
  check(
    'a 100-day UNREAD notification survives',
    (await q('select count(*)::int as n from public.notifications where read_at is null'))[0].n > 0,
    'an unread notification is the evidence in "I was never told" — it must outlive one that was read',
  );
});

// ---------------------------------------------------------------------------

await db.close();

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('verify:pg-notifications — all checks passed');
