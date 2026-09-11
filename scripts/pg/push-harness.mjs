/**
 * Runs the offer-notification trigger against a real Postgres.
 *
 * This exists because `20250101000019_push.sql` shipped a call to
 * `extensions.net.http_post`, which Postgres rejects outright as a
 * cross-database reference — and nobody found out, because the guard above it
 * returns early whenever `edge_url` is unset, which it is on every deployment
 * so far. The bug was armed by configuring push, not by writing it.
 *
 * pg_net cannot run here, so `net.http_post` is replaced by a function that
 * records its arguments. That is enough to answer the questions that matter:
 * does the trigger resolve the function, does it post the right body, and does
 * a broken notifier take the offer down with it.
 *
 * Usage: node scripts/pg/push-harness.mjs
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
    if (error.query) console.error(`       in: ${String(error.query).trim().split('\n')[0]}…`);
  }
}

const db = await PGlite.create();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

// ------------------------------------------------------------- the schema --

await db.exec(`
  create schema private;

  create table private.app_settings (key text primary key, value text not null);

  create table public.push_tokens (
    token text primary key,
    user_id uuid not null,
    platform text,
    last_seen_at timestamptz not null default now()
  );

  create table public.dispatch_offers (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null,
    journey_id uuid not null,
    driver_id uuid not null,
    status text not null default 'offered',
    offered_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '5 minutes'),
    responded_at timestamptz
  );

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

  -- Stands in for pg_net. Records rather than sends.
  create schema net;
  create table public.sent (url text, headers jsonb, body jsonb);
  create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}')
  returns bigint language sql as $fn$
    insert into public.sent values (url, headers, body);
    select 1::bigint;
  $fn$;
`);

const push = read('supabase/migrations/20250101000024_push_delivery.sql');
await db.exec(extractFunction(push, 'create or replace function private.pg_net_post_fn('));
await db.exec(extractFunction(push, 'create or replace function public.notify_dispatch_offer('));
await db.exec(`
  create trigger dispatch_offers_notify
    after insert on public.dispatch_offers
    for each row execute function public.notify_dispatch_offer();
`);

const DRIVER = '11111111-1111-1111-1111-111111111111';
const newOffer = async () =>
  (
    await q(
      `insert into public.dispatch_offers (booking_id, journey_id, driver_id)
       values (gen_random_uuid(), gen_random_uuid(), $1) returning id`,
      [DRIVER],
    )
  )[0].id;

const configure = () =>
  db.exec(`
    insert into private.app_settings (key, value)
    values ('edge_url', 'https://demo.functions.supabase.co'), ('service_key', 'svc-key-abc')
    on conflict (key) do update set value = excluded.value;
  `);

const unconfigure = () => db.exec('delete from private.app_settings');

console.log('running the offer notifier against Postgres…\n');

// --- 1. pg_net is found, wherever it lives ----------------------------------

await run('scenario 1 — resolving pg_net', async () => {
  const found = (await q('select private.pg_net_post_fn() as fn'))[0].fn;
  check(
    'the notifier finds http_post by looking rather than guessing',
    found === 'net.http_post',
    'Supabase puts pg_net in net on some projects and extensions on others; hard-coding either is a coin flip',
  );
});

// --- 2. an offer with push configured posts to the edge function ------------

await run('scenario 2 — a configured project notifies', async () => {
  await configure();
  const offerId = await newOffer();

  const sent = await q('select * from public.sent');
  check('one offer produces exactly one post', sent.length === 1);
  check(
    'it posts to the notify-offer function',
    sent[0]?.url === 'https://demo.functions.supabase.co/notify-offer',
    'this is the line that was invalid SQL — it never ran, so it was never wrong out loud',
  );
  check(
    'and authenticates as the service role',
    sent[0]?.headers?.Authorization === 'Bearer svc-key-abc',
  );
  check(
    'the body carries the offer id and nothing else',
    sent[0]?.body?.offer_id === offerId && Object.keys(sent[0].body).length === 1,
    'a name or address here would land in net._http_response, which nobody thinks of as customer data',
  );
});

// --- 3. an unconfigured project dispatches silently -------------------------

await run('scenario 3 — an unconfigured project stays quiet', async () => {
  await db.exec('delete from public.sent');
  await unconfigure();
  await newOffer();

  check(
    'no push configuration means no post and no error',
    (await q('select * from public.sent')).length === 0,
    'every preview build in the field is in this state and must still dispatch',
  );
});

// --- 4. THE ONE THAT MATTERS ------------------------------------------------

await run('scenario 4 — a broken notifier does not take the offer with it', async () => {
  await configure();
  await db.exec('delete from public.sent; delete from public.dispatch_offers;');

  // Exactly the old failure: the function the trigger reaches for blows up.
  await db.exec(`
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}')
    returns bigint language plpgsql as $fn$
    begin
      raise exception 'cross-database references are not implemented: extensions.net.http_post';
    end;
    $fn$;
  `);

  let offerId = null;
  try {
    offerId = await newOffer();
  } catch {
    offerId = null;
  }

  check(
    'the offer is still created when the notifier raises',
    offerId !== null,
    'this is the whole bug — an AFTER INSERT trigger that raises aborts the insert, and dispatch runs inside the booking insert trigger, so posting a parcel would start failing the moment push was configured',
  );
  check(
    'and the failure is recorded rather than swallowed',
    (await q("select 1 from public.app_events where area = 'push' and level = 'error'")).length ===
      1,
  );
  check(
    'without putting the service key in the log',
    (await q("select 1 from public.app_events where context::text like '%svc-key-abc%'")).length ===
      0,
    'the key is in scope at the point the error is written, which is exactly when it is easiest to log by accident',
  );
});

// --- 5. pg_net missing entirely ---------------------------------------------

await run('scenario 5 — pg_net not enabled at all', async () => {
  await db.exec('drop function net.http_post(text, jsonb, jsonb); delete from public.app_events;');
  await db.exec('delete from public.dispatch_offers');

  let offerId = null;
  try {
    offerId = await newOffer();
  } catch {
    offerId = null;
  }

  check('an offer is still created', offerId !== null);
  check(
    'and the missing extension is called out by name',
    (
      await q(
        "select 1 from public.app_events where area = 'push' and message like '%pg_net is not enabled%'",
      )
    ).length === 1,
    'a project that never enabled pg_net looks identical to one where push simply never fires',
  );
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed against Postgres.`);
  process.exit(1);
}

console.log(
  'PASS — the notifier resolves pg_net rather than guessing its schema, posts only the offer\n' +
    '       id to notify-offer, stays silent on an unconfigured project, and — the reason this\n' +
    '       file exists — cannot abort the offer it is announcing, however badly it fails.',
);
