/**
 * Runs the parcel chat rules (83) against a real Postgres.
 *
 * What must hold:
 *   - only the sender and the driver on the parcel can send, and only while
 *     the job is live (Assigned, Picked Up, In Transit);
 *   - nobody else can read a thread, and a driver who no longer has the
 *     parcel cannot read the next driver's conversation;
 *   - nothing can be inserted around `send_parcel_message`;
 *   - a burst of messages raises one notification, and reading the thread
 *     clears it.
 *
 * Usage: node scripts/pg/parcel-messages-harness.mjs
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

const db = await PGlite.create();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;

  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $fn$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;

  create table public.profiles (id uuid primary key, is_admin boolean not null default false);
  create function public.is_admin() returns boolean language sql stable security definer
    set search_path = '' as $fn$
    select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false)
  $fn$;
  grant execute on function public.is_admin() to authenticated;

  create table public.app_events (
    id bigint generated always as identity primary key,
    level text not null check (level in ('info','warning','error')),
    area text, message text, context jsonb, created_at timestamptz not null default now()
  );

  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    tracking_id text not null,
    sender_id uuid not null references auth.users(id),
    driver_id uuid references auth.users(id),
    driver text,
    status text not null check (status in
      ('Booked','Assigned','Picked Up','In Transit','Delivered','Cancelled'))
  );
  grant select on public.bookings to authenticated;

  create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    kind text not null check (kind in ('message_received','job_assigned')),
    subject_id text, title text not null check (btrim(title) <> ''),
    body text not null default '', metadata jsonb not null default '{}'::jsonb,
    read_at timestamptz, created_at timestamptz not null default now(),
    push_requested boolean not null default true,
    unique (user_id, kind, subject_id)
  );

  -- Copied from production (49).
  create function public.queue_notification(
    p_user uuid, p_kind text, p_subject_id text, p_title text,
    p_body text default '', p_metadata jsonb default '{}'::jsonb, p_push boolean default true)
  returns uuid language plpgsql security definer set search_path = '' as $fn$
  declare new_id uuid;
  begin
    if p_user is null or p_kind is null or btrim(coalesce(p_title, '')) = '' then
      return null;
    end if;
    insert into public.notifications
      (user_id, kind, subject_id, title, body, metadata, push_requested)
    values (p_user, p_kind, p_subject_id, btrim(p_title), coalesce(p_body, ''),
            coalesce(p_metadata, '{}'::jsonb), coalesce(p_push, true))
    on conflict (user_id, kind, subject_id) do nothing
    returning id into new_id;
    return new_id;
  end;
  $fn$;
`);

const migration = read('supabase/migrations/20250101000083_parcel_messages.sql');
await db.exec(migration);
// Re-runnable.
await db.exec(migration);

const [sender, driver, driver2, stranger, admin] = (
  await q(`insert into auth.users (email) values ('s@x'),('d@x'),('d2@x'),('x@x'),('a@x') returning id`)
).map((r) => r.id);
await q(`insert into public.profiles (id, is_admin) values ($1, true)`, [admin]);

const [live] = await q(
  `insert into public.bookings (tracking_id, sender_id, driver_id, driver, status)
   values ('PKG-1', $1, $2, 'Odun Ola', 'Assigned') returning id`,
  [sender, driver],
);
const [waiting] = await q(
  `insert into public.bookings (tracking_id, sender_id, status) values ('PKG-2', $1, 'Booked') returning id`,
  [sender],
);
const [done] = await q(
  `insert into public.bookings (tracking_id, sender_id, driver_id, status)
   values ('PKG-3', $1, $2, 'Delivered') returning id`,
  [sender, driver],
);

/** Runs `sql` as an authenticated user, then returns to the superuser. */
async function as(user, sql, params = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`);
  try {
    return await q(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}
async function refused(user, sql, params = []) {
  try {
    await as(user, sql, params);
    return null;
  } catch (error) {
    return error.message;
  }
}

const send = `select (public.send_parcel_message($1, $2)).id`;

// --- sending -----------------------------------------------------------------
await as(sender, send, [live.id, 'The parcel is ready for pickup.']);
await as(driver, send, [live.id, "I'm on my way."]);
await as(driver, send, [live.id, 'Ten minutes away.']);

const count = (await q(`select count(*)::int n from public.parcel_messages where booking_id = $1`, [live.id]))[0].n;
check('sender and driver can both send on a live job', count === 3, `expected 3, got ${count}`);

check(
  'a stranger cannot send',
  !!(await refused(stranger, send, [live.id, 'hello'])),
);
check(
  'nobody can message before a driver has the parcel',
  /No driver has this parcel/.test((await refused(sender, send, [waiting.id, 'hi'])) ?? ''),
);
check(
  'a delivered parcel is read-only',
  /chat is closed/.test((await refused(sender, send, [done.id, 'hi'])) ?? ''),
);
check('an empty message is refused', !!(await refused(sender, send, [live.id, '   '])));
check(
  'a message over 1000 characters is refused',
  !!(await refused(sender, send, [live.id, 'x'.repeat(1001)])),
);
check(
  'nothing can be inserted around the function',
  !!(await refused(
    sender,
    `insert into public.parcel_messages (booking_id, driver_id, author_id, body) values ($1,$2,$3,'sneak')`,
    [live.id, driver, sender],
  )),
);

// --- reading -----------------------------------------------------------------
const seen = async (user) =>
  (await as(user, `select count(*)::int n from public.parcel_messages where booking_id = $1`, [live.id]))[0].n;
check('the sender reads the thread', (await seen(sender)) === 3);
check('the driver reads the thread', (await seen(driver)) === 3);
check('an admin reads the thread', (await seen(admin)) === 3);
check('a stranger reads nothing', (await seen(stranger)) === 0);

// Reassignment: driver releases, driver2 takes it.
await q(`update public.bookings set driver_id = $1, driver = 'Second' where id = $2`, [driver2, live.id]);
check('the next driver does not inherit the old conversation', (await seen(driver2)) === 0);
await as(driver2, send, [live.id, 'New driver here.']);
check('the previous driver cannot read the new conversation', (await seen(driver)) === 3);
check('the sender keeps both', (await seen(sender)) === 4);
check(
  'the previous driver can no longer send',
  !!(await refused(driver, send, [live.id, 'still me?'])),
);

// --- notifications -----------------------------------------------------------
const notes = async (user) =>
  (await q(
    `select count(*)::int n from public.notifications where user_id = $1 and kind = 'message_received'`,
    [user],
  ))[0].n;
check('the driver was notified once for a burst', (await notes(driver)) === 1, `got ${await notes(driver)}`);
check('the sender was notified once for two driver messages', (await notes(sender)) === 1, `got ${await notes(sender)}`);
const [note] = await q(
  `select title, metadata from public.notifications where user_id = $1 order by created_at limit 1`,
  [sender],
);
check(
  'the notification names the driver and carries the parcel',
  /Odun Ola/.test(note.title) && note.metadata.booking_id === live.id,
  JSON.stringify(note),
);

// --- marking read ------------------------------------------------------------
await as(sender, `select public.mark_parcel_messages_read($1)`, [live.id]);
const unreadForSender = (await q(
  `select count(*)::int n from public.parcel_messages where booking_id = $1 and author_id <> $2 and read_at is null`,
  [live.id, sender],
))[0].n;
check('reading clears what the sender received', unreadForSender === 0);
const ownStillUnread = (await q(
  `select count(*)::int n from public.parcel_messages where author_id = $1 and read_at is not null`,
  [sender],
))[0].n;
check("reading never marks the reader's own messages", ownStillUnread === 0);
const senderNoteUnread = (await q(
  `select count(*)::int n from public.notifications where user_id = $1 and read_at is null`,
  [sender],
))[0].n;
check('reading also clears the inbox notification', senderNoteUnread === 0);

await as(stranger, `select public.mark_parcel_messages_read($1)`, [live.id]);
const driverUnread = (await q(
  `select count(*)::int n from public.parcel_messages where author_id = $1 and read_at is null`,
  [sender],
))[0].n;
check('a stranger cannot mark anything read', driverUnread === 1, `got ${driverUnread}`);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log(
  'PASS — only the sender and the current driver can message, only while the job is live;\n' +
    '       strangers and previous drivers read nothing; writes go through the function;\n' +
    '       a burst raises one notification and reading clears it.',
);
