/**
 * Runs 20250101000059_support_tickets.sql against a real Postgres, on top of
 * the real chain, under RLS.
 *
 * ⚠ What is being proved, in one sentence: an operator sees the whole thread
 *   and a customer sees exactly the half meant for them.
 *
 *   1. A non-admin gets an exception from every admin function, and cannot
 *      read another person's ticket or *anybody's* internal note. The screen's
 *      own guard is a courtesy; these functions are the control.
 *   2. A customer cannot write either table directly — no insert policy — so
 *      `status`, `reference` and `first_response_at` cannot be set by a client.
 *   3. `first_response_at` moves on a public reply and stays put for an
 *      internal note. That one distinction is the entire response-time metric.
 *   4. Resolving requires a note, and the note reaches the customer.
 *   5. A customer's reply to a resolved ticket reopens it and clears the
 *      resolution, leaving no row that is both open and closed.
 *   6. Erasing an account empties its threads and leaves the shells.
 *
 * Usage: node scripts/pg/support-tickets-harness.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();

/* Same three as every other full-chain harness: pg_net and the push plumbing. */
const SKIP = new Set([
  '20250101000005_storage_and_alerts.sql',
  '20250101000019_push.sql',
  '20250101000024_push_delivery.sql',
]);

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
const OTHER = '22222222-2222-2222-2222-222222222222';
const DRIVER = '33333333-3333-3333-3333-333333333333';
const ADMIN = '44444444-4444-4444-4444-444444444444';

const SUPABASE_SHIM = `
  create role anon; create role authenticated; create role service_role;
  create role supabase_auth_admin;
  create schema auth; create schema storage; create schema extensions;
  create schema private; create schema net;
  create publication supabase_realtime;

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

  create function auth.uid() returns uuid language sql stable as $fn$ select null::uuid $fn$;
`;

const SEED = `
  create table public.who (id uuid);
  create or replace function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1
  $fn$;
  grant select on public.who to authenticated;

  insert into auth.users (id, email, phone) values
    ('${SENDER}', 'sender@pkrelay.test', '08030000001'),
    ('${OTHER}',  'other@pkrelay.test',  '08030000002'),
    ('${DRIVER}', 'driver@pkrelay.test', '08030000003'),
    ('${ADMIN}',  'admin@pkrelay.test',  '08030000004');

  update public.profiles set full_name = 'Test Sender', phone = '08030000001' where id = '${SENDER}';
  update public.profiles set full_name = 'Other Person', phone = '08030000002' where id = '${OTHER}';
  update public.profiles set full_name = 'Test Driver', phone = '08030000003' where id = '${DRIVER}';
  update public.profiles set full_name = 'Test Admin', is_admin = true where id = '${ADMIN}';

  insert into public.sender_identity (user_id, status, verified_at)
  values ('${SENDER}', 'verified', now()), ('${OTHER}', 'verified', now())
  on conflict (user_id) do update set status = 'verified', verified_at = now();
`;

/*
 * Dispatch is replaced by a no-op. Nothing here is about matching drivers, and
 * the real matcher writes offer rows that would only add noise.
 */
const SPY = `
  create table public.dispatched (booking_id uuid, at timestamptz default clock_timestamp());
  create or replace function public.dispatch_booking(booking_id uuid)
  returns uuid language plpgsql security definer set search_path = '' as $fn$
  begin
    insert into public.dispatched (booking_id) values (dispatch_booking.booking_id);
    return null;
  end;
  $fn$;
`;

const BOOKING_COLUMNS = `
  tracking_id, delivery_type, pickup_mode, dropoff_mode, origin_city, destination_city,
  item_description, category, weight, estimated_fee, sender_id, status, capture_session_id`;

async function build() {
  const db = await PGlite.create();
  await db.exec(SUPABASE_SHIM);

  for (const name of MIGRATIONS) {
    if (SKIP.has(name)) continue;
    await db.exec(read(name));
  }

  await db.exec(SEED);
  await db.exec(SPY);
  return db;
}

const asUser = async (db, id) => {
  await db.exec(
    `reset role; delete from public.who; insert into public.who (id) values ('${id}');`,
  );
  await db.exec('set role authenticated');
};

const asOwner = async (db) => db.exec('reset role; delete from public.who;');

const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

let counter = 0;

/** Posts a parcel as `owner`, the way the app does. Returns its row. */
async function postParcel(db, owner) {
  await db.exec('reset role');
  const session = await db.query(
    `insert into public.photo_capture_sessions
       (owner_id, photo_path, completed_at, liveness_status, liveness_environment, liveness_checked_at)
     values ($1, 'sender-photo/' || gen_random_uuid() || '.jpg', now(), 'passed', 'sandbox', now())
     returning id`,
    [owner],
  );

  await asUser(db, owner);
  const { rows } = await db.query(
    `insert into public.bookings (${BOOKING_COLUMNS})
     values ($1, 'local', 'hub', 'hub', 'Lagos', 'Abuja', 'A box', 'documents', 2, 2800, $2,
             'Booked', $3)
     returning id, tracking_id`,
    [`PKR-S-T${++counter}`, owner, session.rows[0].id],
  );
  return rows[0];
}

const db = await build();

// ------------------------------------------------ 1. the tables are shut --

{
  await asUser(db, SENDER);

  const inserted = await refusal(() =>
    db.query(
      `insert into public.support_tickets (requester_id, subject, status)
       values ($1, 'Direct insert', 'resolved')`,
      [SENDER],
    ),
  );
  check(
    'a client cannot insert a ticket directly',
    inserted !== null,
    'with an insert policy a client sets its own status, reference and first_response_at —\n' +
      '       every response-time number on the admin screen becomes whatever the client says',
  );

  const messaged = await refusal(() =>
    db.query(
      `insert into public.support_ticket_messages (ticket_id, author_id, author_role, visibility, body)
       values (gen_random_uuid(), $1, 'admin', 'public', 'We refunded you')`,
      [SENDER],
    ),
  );
  check(
    'a client cannot insert a message directly',
    messaged !== null,
    'otherwise a customer writes a reply from Package Relay into their own thread',
  );
}

// -------------------------------------------- 2. opening one, the app way --

let ticketId;
let ticketRef;
/** A parcel belonging to OTHER, used twice: once as the one that must be refused. */
let strangerParcel;

{
  const parcel = await postParcel(db, SENDER);
  await asUser(db, SENDER);

  const short = await refusal(() =>
    db.query(`select * from public.create_support_ticket('Help', 'help', 'parcel', null)`),
  );
  check(
    'a body of two words is refused',
    short !== null,
    '"help" costs an operator a whole round trip to learn nothing',
  );

  strangerParcel = await postParcel(db, OTHER);
  const stranger = strangerParcel;
  await asUser(db, SENDER);
  const notMine = await refusal(() =>
    db.query(
      `select * from public.create_support_ticket(
         'Where is my parcel', 'It has not arrived and nobody called me.', 'parcel', $1)`,
      [stranger.id],
    ),
  );
  check(
    "a ticket cannot be attached to somebody else's parcel",
    notMine !== null && /not on your account/i.test(notMine),
    'the queue would print a stranger’s tracking id and route beside this person’s name',
  );

  const { rows } = await db.query(
    `select * from public.create_support_ticket(
       'Where is my parcel', 'Booked on Monday and it has not moved since.', 'parcel', $1)`,
    [parcel.id],
  );
  ticketId = rows[0].id;
  ticketRef = rows[0].reference;

  check('a ticket comes back with a readable reference', /^PKR-S-\d{5}$/.test(ticketRef ?? ''), ticketRef);

  await asOwner(db);
  const state = await db.query(
    `select status, last_message_from, booking_tracking_id, first_response_at, channel,
            (select count(*) from public.support_ticket_messages m where m.ticket_id = t.id) as messages
       from public.support_tickets t where t.id = $1`,
    [ticketId],
  );
  const ticket = state.rows[0];

  check('it opens as Open', ticket.status === 'open', ticket.status);
  check('the customer spoke last', ticket.last_message_from === 'customer');
  check('nobody has answered yet', ticket.first_response_at === null);
  check('the channel is the app', ticket.channel === 'app');
  check('the first message is stored with it', Number(ticket.messages) === 1);
  check(
    'the tracking id is snapshotted onto the ticket',
    ticket.booking_tracking_id === parcel.tracking_id,
    'without the snapshot a resolved ticket stops saying which parcel it was about',
  );

  const admins = await db.query(
    `select user_id, kind from public.notifications where subject_id = $1`,
    [ticketId],
  );
  check(
    'every admin is told a ticket arrived',
    admins.rows.length === 1 && admins.rows[0].user_id === ADMIN,
    'a ticket nobody is told about is a ticket nobody reads until the customer chases it',
  );
  check(
    'and it rides on the existing message_received kind',
    admins.rows[0]?.kind === 'message_received',
    '49’s check constraint is in a pushed migration and already carries the right value',
  );
}

// ------------------------------------------- 3. what the other side sees --

{
  await asUser(db, OTHER);
  const seen = await db.query(`select id from public.support_tickets where id = $1`, [ticketId]);
  check(
    "another customer cannot read somebody else's ticket",
    seen.rows.length === 0,
    'the subject line alone is free text about a stranger',
  );

  const queue = await refusal(() => db.query(`select * from public.admin_support_queue('all')`));
  check('a non-admin is refused the queue', queue !== null && /administrator/i.test(queue));

  const thread = await refusal(() =>
    db.query(`select * from public.admin_support_messages($1)`, [ticketId]),
  );
  check(
    'a non-admin is refused the thread',
    thread !== null && /administrator/i.test(thread),
    'this is the only path to an internal note in the whole schema',
  );

  const counts = await refusal(() => db.query(`select public.admin_support_counts()`));
  check('a non-admin is refused the counts', counts !== null);
}

// ------------------------------------- 4. an internal note is not an answer --

{
  await asUser(db, ADMIN);
  await db.query(
    `select public.admin_reply_support_ticket($1, 'Driver says the recipient number is dead.', true)`,
    [ticketId],
  );

  await asOwner(db);
  const after = await db.query(
    `select status, first_response_at, last_message_from from public.support_tickets where id = $1`,
    [ticketId],
  );
  check(
    'an internal note does not count as a first response',
    after.rows[0].first_response_at === null,
    'counting one is how a team reports a four-minute median while nobody outside has heard anything',
  );
  check('and it does not move the status', after.rows[0].status === 'open');
  check('and it does not change who spoke last', after.rows[0].last_message_from === 'customer');

  const pinged = await db.query(
    `select count(*)::int as n from public.notifications where user_id = $1`,
    [SENDER],
  );
  check(
    'the customer is not notified about an internal note',
    pinged.rows[0].n === 0,
    'the note exists precisely because they should not read it',
  );

  await asUser(db, SENDER);
  const visible = await db.query(
    `select count(*)::int as n from public.support_ticket_messages where ticket_id = $1`,
    [ticketId],
  );
  check(
    'and the customer cannot read it',
    visible.rows[0].n === 1,
    'their own message is public and visible; the note is not',
  );
}

// ------------------------------------------------ 5. a public reply answers --

{
  await asUser(db, ADMIN);
  await db.query(
    `select public.admin_reply_support_ticket($1, 'We have reached the driver — collection is Tuesday.', false)`,
    [ticketId],
  );

  await asOwner(db);
  const after = await db.query(
    `select status, first_response_at, last_message_from from public.support_tickets where id = $1`,
    [ticketId],
  );
  check('a public reply sets the first response', after.rows[0].first_response_at !== null);
  check(
    'and takes an Open ticket into In Progress',
    after.rows[0].status === 'in_progress',
    'answering something is starting work on it — one saved click that otherwise goes unclicked',
  );
  check('and it is now our word that is last', after.rows[0].last_message_from === 'admin');

  const told = await db.query(
    `select kind, title from public.notifications where user_id = $1`,
    [SENDER],
  );
  check('the customer is notified', told.rows.length === 1);
  check(
    'and the title names their reference',
    (told.rows[0]?.title ?? '').includes(ticketRef),
    'a notification that says "you have a reply" and not to what is a notification nobody can file',
  );
}

// ---------------------------------------- 6. resolving, and being told so --

{
  await asUser(db, ADMIN);

  const bare = await refusal(() =>
    db.query(`select public.admin_set_support_status($1, 'resolved', null)`, [ticketId]),
  );
  check(
    'a ticket cannot be resolved with no note',
    bare !== null && /resolved it/i.test(bare),
    'from the outside, a silent close is indistinguishable from being ignored',
  );

  await db.query(
    `select public.admin_set_support_status($1, 'resolved', 'Collected from Ikeja hub on Tuesday.')`,
    [ticketId],
  );

  await asOwner(db);
  const resolved = await db.query(
    `select status, resolved_at, resolution from public.support_tickets where id = $1`,
    [ticketId],
  );
  check('it is resolved', resolved.rows[0].status === 'resolved');
  check('with a timestamp', resolved.rows[0].resolved_at !== null);
  check('and the note is kept', /Ikeja/.test(resolved.rows[0].resolution ?? ''));

  await asUser(db, SENDER);
  const thread = await db.query(
    `select body from public.support_ticket_messages where ticket_id = $1 order by created_at`,
    [ticketId],
  );
  check(
    'the resolution is in the thread the customer can read',
    thread.rows.some((row) => /Ikeja/.test(row.body)),
    'filing it where only staff can read it answers nobody',
  );
}

// --------------------------------------------- 7. a reply reopens it --

{
  await asUser(db, SENDER);
  await db.query(`select public.reply_support_ticket($1, 'It still has not arrived.')`, [ticketId]);

  await asOwner(db);
  const reopened = await db.query(
    `select status, resolved_at, resolution, last_message_from
       from public.support_tickets where id = $1`,
    [ticketId],
  );
  check('a reply to a resolved ticket reopens it', reopened.rows[0].status === 'open');
  check(
    'and clears the resolved timestamp',
    reopened.rows[0].resolved_at === null,
    'a row that is open and also closed makes every count built on either column wrong',
  );
  check(
    'and clears the stale resolution',
    reopened.rows[0].resolution === null,
    '"we refunded you" sitting on an open ticket is worse than no note at all',
  );
  check('and the ball is back in our court', reopened.rows[0].last_message_from === 'customer');
}

// ------------------------------------------- 8. the constraint, and counts --

{
  await asOwner(db);
  const lie = await refusal(() =>
    db.query(
      `insert into public.support_ticket_messages (ticket_id, author_id, author_role, visibility, body)
       values ($1, $2, 'customer', 'internal', 'Filed where they can never see it')`,
      [ticketId, SENDER],
    ),
  );
  check(
    'a customer-authored internal note is refused by the table',
    lie !== null,
    'one transposed argument would silently lose half a thread with no error anywhere',
  );

  await asUser(db, ADMIN);
  const counts = (await db.query(`select public.admin_support_counts() as c`)).rows[0].c;

  check('the counts see one open ticket', counts.open === 1, JSON.stringify(counts));
  check(
    'and it is awaiting us',
    counts.awaiting_us === 1,
    'awaiting_us is the last message’s direction, not the status somebody last clicked',
  );
  check('and it is not counted unanswered', counts.unanswered === 0, 'it has been answered once');
  check('and it is unassigned', counts.unassigned === 1);

  const queue = await db.query(`select * from public.admin_support_queue('awaiting_us')`);
  check('the awaiting_us filter finds it', queue.rows.length === 1);
  check('the row carries the requester name', queue.rows[0].requester_name === 'Test Sender');
  check('and counts the whole thread, notes included', Number(queue.rows[0].message_count) === 5);

  const byPhone = await db.query(`select * from public.admin_support_queue('all', '0803000000')`);
  check(
    'searching by phone number finds the ticket',
    byPhone.rows.length >= 1,
    'the operator typing it already has it — somebody is on the line',
  );

  const byRef = await db.query(`select * from public.admin_support_queue('all', $1)`, [ticketRef]);
  check('and so does the reference', byRef.rows.length === 1);
}

// ------------------------------------------------- 9. assignment --

{
  await asUser(db, ADMIN);
  const notAnAdmin = await refusal(() =>
    db.query(`select public.admin_assign_support_ticket($1, $2)`, [ticketId, SENDER]),
  );
  check(
    'a ticket cannot be assigned to a non-admin',
    notAnAdmin !== null,
    'an assignee who cannot open the queue is a ticket quietly taken off every screen',
  );

  await db.query(`select public.admin_assign_support_ticket($1, $2)`, [ticketId, ADMIN]);
  await asOwner(db);
  const assigned = await db.query(
    `select assigned_admin_id from public.support_tickets where id = $1`,
    [ticketId],
  );
  check('assigning works', assigned.rows[0].assigned_admin_id === ADMIN);
}

// -------------------------------------------- 10. an admin logs a call --

{
  await asUser(db, ADMIN);
  const { rows } = await db.query(
    `select * from public.admin_create_support_ticket(
       $1, 'Called about a late pickup', 'Rang at 09:40, said the driver never came.',
       'parcel', 'phone', null)`,
    [DRIVER],
  );
  const phoned = rows[0].id;

  await asOwner(db);
  const logged = await db.query(
    `select requester_id, opened_by_admin_id, channel, last_message_from from public.support_tickets where id = $1`,
    [phoned],
  );
  check(
    'the ticket belongs to the customer, not the admin who typed it',
    logged.rows[0].requester_id === DRIVER,
    'requester = whoever created the row puts the admin on a quarter of the queue',
  );
  check('and records who logged it', logged.rows[0].opened_by_admin_id === ADMIN);
  check('and how it arrived', logged.rows[0].channel === 'phone');
  check(
    'and it counts as awaiting us',
    logged.rows[0].last_message_from === 'customer',
    'a phoned-in ticket is by definition somebody waiting on an answer',
  );

  const intake = await db.query(
    `select author_role, visibility from public.support_ticket_messages where ticket_id = $1`,
    [phoned],
  );
  check(
    "the intake note is the admin's, and internal",
    intake.rows[0].author_role === 'admin' && intake.rows[0].visibility === 'internal',
    'it is an operator’s summary of a phone call, not the customer’s own words',
  );

  /*
   * The tracking id, which is what an operator has on a phone call.
   *
   * Both halves matter: a parcel on that account links, and one that is not on
   * it is refused by name. Without the second, a mistyped id that happens to
   * exist would attach a stranger's parcel to this thread.
   */
  await asUser(db, ADMIN);
  const wrongOwner = await refusal(() =>
    db.query(
      `select * from public.admin_create_support_ticket(
         $1, 'Asking about a parcel', 'Rang about it.', 'parcel', 'phone', null, $2)`,
      [DRIVER, strangerParcel.tracking_id],
    ),
  );
  check(
    "a tracking id on somebody else's account is refused",
    wrongOwner !== null && /tracking id/i.test(wrongOwner),
    'and the message names the id, which is the only way an operator can tell it was a typo',
  );

  const linked = await db.query(
    `select * from public.admin_create_support_ticket(
       $1, 'Asking about a parcel', 'Rang about it.', 'parcel', 'phone', null, $2)`,
    [OTHER, strangerParcel.tracking_id.toLowerCase()],
  );

  await asOwner(db);
  const resolvedLink = await db.query(
    `select booking_id, booking_tracking_id from public.support_tickets where id = $1`,
    [linked.rows[0].id],
  );
  check(
    'a lower-cased tracking id still finds the parcel',
    resolvedLink.rows[0].booking_id === strangerParcel.id,
    'it is read down a phone line and typed back by hand',
  );
  check(
    'and the stored tracking id is the real one, not what was typed',
    resolvedLink.rows[0].booking_tracking_id === strangerParcel.tracking_id,
  );
}

// ---------------------------------------------------- 11. erasure --

/*
 * The subject is the SENDER, who has posted a parcel — which is the case that
 * used to be impossible.
 *
 *   `erase_person` (33) deletes the target's capture sessions, and 44 added
 *   `bookings.capture_session_id` referencing them with no `on delete` action,
 *   so erasing anybody who had posted a parcel raised a foreign key violation
 *   and scrubbed nothing. 61 gave that key `on delete set null`. Erasing a
 *   sender with a parcel is therefore both the test of this file's trigger and
 *   the regression test for that repair.
 */
{
  await asOwner(db);
  const before = await db.query(
    `select count(*)::int as n from public.support_tickets where requester_id = $1`,
    [SENDER],
  );
  check('the sender has a ticket to erase', before.rows[0].n === 1);

  const parcels = await db.query(
    `select count(*)::int as n from public.bookings
      where sender_id = $1 and capture_session_id is not null`,
    [SENDER],
  );
  check(
    'and a parcel that points at a capture session',
    parcels.rows[0].n >= 1,
    'without one this stops being a regression test for 61',
  );

  /*
   * The clause itself, read out of the catalog.
   *
   * 'n' is set null, 'a' is no action. Asserting the behaviour below would catch
   * a regression only while a parcel with a session happens to exist in the
   * fixture; asserting the clause catches somebody re-adding this constraint
   * without it, which is how it went missing the first time.
   */
  const fk = await db.query(`
    select con.confdeltype
      from pg_constraint con
      join pg_attribute att
        on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'public.bookings'::regclass
       and con.contype = 'f'
       and att.attname = 'capture_session_id'
  `);
  check(
    'bookings.capture_session_id is on delete set null',
    fk.rows[0]?.confdeltype === 'n',
    `61 repairs the key 44 left as no-action; got ${fk.rows[0]?.confdeltype ?? 'no constraint'}`,
  );

  await asUser(db, ADMIN);
  const erased = await refusal(() =>
    db.query(`select public.erase_person($1, 'NDPR request')`, [SENDER]),
  );
  check(
    'erasing a sender who has posted a parcel succeeds',
    erased === null,
    `61 gives bookings.capture_session_id on delete set null; without it this is\n` +
      `       "violates foreign key constraint bookings_capture_session_id_fkey"\n` +
      `       got: ${erased}`,
  );

  await asOwner(db);
  const kept = await db.query(
    `select capture_session_id, pickup_contact_name from public.bookings
      where sender_id = $1 limit 1`,
    [SENDER],
  );
  check(
    'the parcel survives the erasure',
    kept.rows.length === 1,
    'set null rather than cascade — a recipient’s delivery history is theirs',
  );
  check(
    'with its capture session pointer cleared',
    kept.rows[0]?.capture_session_id === null,
  );
  check(
    'and the people scrubbed out of it',
    kept.rows[0]?.pickup_contact_name === 'Removed',
    'proof the scrub actually ran rather than aborting halfway',
  );

  const left = await db.query(
    `select t.subject, t.status,
            (select count(*)::int from public.support_ticket_messages m where m.ticket_id = t.id) as messages
       from public.support_tickets t where t.requester_id = $1`,
    [SENDER],
  );

  check('the ticket shell survives an erasure', left.rows.length === 1, 'the history is operational');
  check(
    'and its thread is gone',
    left.rows[0]?.messages === 0,
    'a support thread is the one place an address can arrive as prose',
  );
  check('and the subject with it', left.rows[0]?.subject === 'Removed');
}

await db.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('the support queue holds.\n');
