import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
const ROOT = process.cwd();
const SKIP = new Set(['20250101000005_storage_and_alerts.sql','20250101000019_push.sql','20250101000024_push_delivery.sql']);
const db = await PGlite.create();
await db.exec(readFileSync('/tmp/shim.sql','utf8'));
for (const n of readdirSync(join(ROOT,'supabase/migrations')).filter((x)=>/^\d+_.*\.sql$/.test(x)).sort()) {
  if (SKIP.has(n)) continue;
  try { await db.exec(readFileSync(join(ROOT,'supabase/migrations',n),'utf8')); }
  catch (e) { console.error('FAILED ON', n, '\n', e.message); process.exit(1); }
}
const rows = (await db.query('select * from public.stale_definitions()')).rows;
console.log(`${rows.length} manifest rows; not current:`, rows.filter(r=>r.state!=='current').map(r=>`${r.object}(${r.owner_migration})=${r.state}`).join(', ') || 'none');
console.log('release probe:', (await db.query('select public.release_controls_installed() as ok')).rows[0].ok);
await db.close();
