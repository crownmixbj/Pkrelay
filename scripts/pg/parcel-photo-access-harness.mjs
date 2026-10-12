/**
 * Who can open a parcel photo (84), against a real Postgres.
 *
 * Must see it: the sender, an admin, the driver carrying the parcel, a driver
 * holding a live offer for it. Must not: any other driver, a driver whose offer
 * expired or was declined, a driver who released the job.
 *
 * Usage: node scripts/pg/parcel-photo-access-harness.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();
let failures = 0;
const check = (name, condition, detail) => {
  if (condition) return;
  failures += 1;
  console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
};

const db = await PGlite.create();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

await db.exec(`
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid());
  create function auth.uid() returns uuid language sql stable as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
  grant usage on schema auth to authenticated;

  create table public.profiles (id uuid primary key, is_admin boolean not null default false);
  create function public.is_admin() returns boolean language sql stable security definer
    set search_path = '' as $fn$
    select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false) $fn$;

  create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    sender_id uuid not null, driver_id uuid
  );
  create table public.dispatch_offers (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null, driver_id uuid not null,
    status text not null, expires_at timestamptz not null
  );
  grant select on public.bookings, public.dispatch_offers to authenticated;

  create schema storage;
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create function storage.foldername(name text) returns text[] language sql immutable as $fn$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $fn$;
  alter table storage.objects enable row level security;
  grant usage on schema storage to authenticated;
  grant select on storage.objects to authenticated;
`);

const migration = readFileSync(
  join(ROOT, 'supabase/migrations/20250101000084_driver_sees_parcel_photo.sql'),
  'utf8',
);
await db.exec(migration);
await db.exec(migration); // re-runnable

const ids = (await q(`insert into auth.users select gen_random_uuid() from generate_series(1, 7) returning id`)).map((r) => r.id);
const [sender, carrier, offered, expired, declined, stranger, admin] = ids;
await q(`insert into public.profiles values ($1, true)`, [admin]);

const [parcel] = await q(
  `insert into public.bookings (sender_id, driver_id) values ($1, $2) returning id`,
  [sender, carrier],
);
const [other] = await q(`insert into public.bookings (sender_id) values ($1) returning id`, [sender]);

await q(
  `insert into public.dispatch_offers (booking_id, driver_id, status, expires_at) values
     ($1, $2, 'offered', now() + interval '5 minutes'),
     ($1, $3, 'offered', now() - interval '1 minute'),
     ($1, $4, 'declined', now() + interval '5 minutes')`,
  [other.id, offered, expired, declined],
);

await q(
  `insert into storage.objects (bucket_id, name) values ('parcel-photo', $1), ('parcel-photo', $2), ('sender-photo', $3)`,
  [`${parcel.id}/a.jpg`, `${other.id}/b.jpg`, `${parcel.id}/face.jpg`],
);

async function visible(user, bookingId) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`);
  try {
    return (
      await q(
        `select count(*)::int n from storage.objects where bucket_id = 'parcel-photo' and name like $1`,
        [`${bookingId}/%`],
      )
    )[0].n;
  } finally {
    await db.exec(`reset role;`);
  }
}

check('the sender sees their parcel photo', (await visible(sender, parcel.id)) === 1);
check('an admin sees it', (await visible(admin, parcel.id)) === 1);
check('the driver carrying it sees it', (await visible(carrier, parcel.id)) === 1);
check('a driver with a live offer sees it', (await visible(offered, other.id)) === 1);
check('a driver whose offer expired does not', (await visible(expired, other.id)) === 0);
check('a driver who declined does not', (await visible(declined, other.id)) === 0);
check('an unrelated driver does not', (await visible(stranger, parcel.id)) === 0);
check('the carrier cannot see another parcel', (await visible(carrier, other.id)) === 0);

await q(`update public.bookings set driver_id = null where id = $1`, [parcel.id]);
check('a driver who released the job loses it', (await visible(carrier, parcel.id)) === 0);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log(
  'PASS — the parcel photo opens for the sender, admins, the carrying driver and a driver with\n' +
    '       a live offer; expired, declined, released and unrelated drivers see nothing.',
);
