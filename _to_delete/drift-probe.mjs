import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();
const SKIP = new Set([
  '20250101000005_storage_and_alerts.sql',
  '20250101000019_push.sql',
  '20250101000024_push_delivery.sql',
]);
const SHIM = readFileSync('/tmp/shim.sql', 'utf8');
const db = await PGlite.create();
await db.exec(SHIM);
for (const name of readdirSync(join(ROOT, 'supabase/migrations')).filter((n) => /^\d+_.*\.sql$/.test(n)).sort()) {
  if (SKIP.has(name)) continue;
  try { await db.exec(readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8')); }
  catch (e) { console.error('FAILED ON', name, '\n', e.message); process.exit(1); }
}
const rows = (await db.query('select * from public.stale_definitions()')).rows;
const bad = rows.filter((r) => r.state !== 'current');
console.log(`${rows.length} manifest rows, ${bad.length} not current`);
for (const r of bad) console.log('  ', r.state, r.object, '(owner', r.owner_migration + ')');
await db.close();
