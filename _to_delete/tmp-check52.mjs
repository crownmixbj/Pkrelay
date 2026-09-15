import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = await PGlite.create();
await db.exec(`
  create table public.driver_applications (
    id uuid primary key default gen_random_uuid(),
    guarantor_relationship text not null,
    guarantor_address text not null,
    guarantor_nin text not null,
    full_name text not null
  );
  create role anon; create role authenticated;
`);

const before = await db.query(`select 1 from information_schema.columns
  where table_name='driver_applications' and column_name='guarantor_relationship' and is_nullable='NO'`);
console.log('before 52 — constrained:', before.rows.length === 1);

let refused = null;
try {
  await db.query(`insert into public.driver_applications (full_name) values ('Tunde')`);
} catch (e) { refused = e.message; }
console.log('before 52 — insert refused:', /not-null|null value/i.test(refused ?? ''), '→', refused);

await db.exec(readFileSync('supabase/migrations/20250101000052_guarantor_columns_nullable.sql', 'utf8'));

const [row] = (await db.query('select public.driver_application_guarantor_optional() as ok')).rows;
console.log('after 52 — function says optional:', row.ok);

const [inserted] = (await db.query(
  `insert into public.driver_applications (full_name) values ('Tunde') returning id, guarantor_relationship`
)).rows;
console.log('after 52 — insert accepted:', Boolean(inserted.id), '| relationship is null:', inserted.guarantor_relationship === null);

await db.exec(`alter table public.driver_applications alter column guarantor_nin set not null`);
const [again] = (await db.query('select public.driver_application_guarantor_optional() as ok')).rows;
console.log('re-constrained by hand — function notices:', again.ok === false);

await db.close();
