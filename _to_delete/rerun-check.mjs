/* Applies the chain, then applies 59 a second time. Re-runnable means re-runnable. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();
const SKIP = new Set(['20250101000005_storage_and_alerts.sql','20250101000019_push.sql','20250101000024_push_delivery.sql']);
const MIGRATIONS = readdirSync(join(ROOT,'supabase/migrations')).filter(n=>/^\d+_.*\.sql$/.test(n)).sort();
const read = (n) => readFileSync(join(ROOT,'supabase/migrations',n),'utf8');
const SHIM = readFileSync(join(ROOT,'scripts/pg/support-tickets-harness.mjs'),'utf8')
  .split('const SUPABASE_SHIM = `')[1].split('`;')[0];

const db = await PGlite.create();
await db.exec(SHIM);
for (const n of MIGRATIONS) { if (!SKIP.has(n)) await db.exec(read(n)); }
await db.exec(read('20250101000059_support_tickets.sql'));
await db.exec(read('20250101000059_support_tickets.sql'));
const { rows } = await db.query(`select count(*)::int as n from pg_proc where proname = 'admin_create_support_ticket'`);
console.log('second and third apply clean; admin_create_support_ticket overloads:', rows[0].n);
await db.close();
