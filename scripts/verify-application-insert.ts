/**
 * The driver application the client writes, against the table it writes into.
 *
 * ⚠ This exists because a comment was true and the schema was not.
 *
 *   02 created `guarantor_relationship`, `guarantor_address` and `guarantor_nin`
 *   as `not null`. 39 stopped collecting them, said so — "left in place, and
 *   nothing writes them any more" — and left all three `not null` with no
 *   default. `submitApplication` correctly stopped sending them.
 *
 *   Every driver application after that failed with
 *
 *     null value in column "guarantor_relationship" ... violates not-null
 *     constraint (23502)
 *
 *   after thirty fields, five documents and a photograph of the applicant's own
 *   face. Nothing caught it: the two pg harnesses that touch this table both
 *   hand-stub it, so neither has ever seen 02's constraints, and no assertion
 *   compared what the client sends with what the column list demands.
 *
 *   This is that comparison, in both directions:
 *
 *     * a column that is `not null` with no default and is not in the insert is
 *       a submission that cannot succeed — 23502, at the end of the form;
 *     * a key in the insert that is not a column is PGRST204, and arrives as
 *       "Check your connection and try again" to somebody whose connection is
 *       fine (see `src/lib/schema-gap.ts`).
 *
 * The schema is read out of the migrations rather than out of a live database,
 * so this runs anywhere and fails on the commit that introduces the drift rather
 * than on the deploy that exposes it.
 *
 * Run with `npm run verify:application-insert`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const TABLE = 'driver_applications';

/*
 * Every migration, in order. A column's state is whatever the *last* statement
 * about it says — 02 makes three of them `not null` and 52 takes it back off.
 */
const migrations = readdirSync(join(ROOT, 'supabase/migrations'))
  .filter((name) => /^\d+_.*\.sql$/.test(name))
  .sort()
  .map((name) => read(`supabase/migrations/${name}`))
  .join('\n');

/* Comments in this repo are long and contain SQL. They are not SQL. */
const sql = migrations.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

type Column = { notNull: boolean; hasDefault: boolean };

const columns = new Map<string, Column>();

// ------------------------------------------------- what 02 creates ---------

const createTable = new RegExp(
  `create table if not exists public\\.${TABLE}\\s*\\(([\\s\\S]*?)\\n\\);`,
).exec(sql)?.[1];

check('the create table was found', Boolean(createTable), `no create statement for ${TABLE}`);

if (createTable) {
  /*
   * Split on the commas that end a column definition — the ones at the body's
   * own indent level. `check (status in ('a', 'b'))` has commas inside it, and
   * splitting on every comma would invent columns called `'b'`.
   */
  for (const line of createTable.split('\n')) {
    const definition = line.trim();
    const name = /^([a-z_][a-z0-9_]*)\s+(text|uuid|jsonb|timestamptz|boolean|integer|numeric|bigint)\b/.exec(
      definition,
    );
    if (!name) continue;

    columns.set(name[1], {
      notNull: /\bnot null\b/.test(definition),
      hasDefault: /\bdefault\b/.test(definition),
    });
  }
}

check('columns were parsed', columns.size > 10, `parsed ${columns.size}`);

// -------------------------------------- and what every later migration does -

for (const [, name, rest] of sql.matchAll(
  new RegExp(`alter table (?:only )?public\\.${TABLE}\\s+add column (?:if not exists )?([a-z_]+)([^;,]*)`, 'g'),
)) {
  columns.set(name, {
    notNull: /\bnot null\b/.test(rest),
    hasDefault: /\bdefault\b/.test(rest),
  });
}

/*
 * ⚠ Alters are read across the whole statement, not line by line.
 *
 *   52 drops the constraint from three columns in one `alter table`, separated
 *   by commas and newlines. A per-line reader sees the first and misses the
 *   other two — and would then report this file as green while two of the three
 *   columns still refused every application.
 */
for (const [, body] of sql.matchAll(
  new RegExp(`alter table (?:only )?public\\.${TABLE}\\s+((?:alter column[\\s\\S]*?));`, 'g'),
)) {
  for (const [, name, action] of body.matchAll(/alter column\s+([a-z_]+)\s+(drop not null|set not null)/g)) {
    const existing = columns.get(name);
    if (!existing) continue;
    columns.set(name, { ...existing, notNull: action === 'set not null' });
  }
}

// ------------------------------------------------- what the client sends ----

const store = read('src/store/driver-applications.ts');

const insertBody = /\.insert\(\{([\s\S]*?)\n\s*\}\)/.exec(store)?.[1] ?? '';
check('the insert was found', insertBody.length > 0, 'no .insert({…}) in submitApplication');

/* Keys only: `full_name: application.fullName,` → `full_name`. */
const sent = new Set(
  [...insertBody.matchAll(/^\s{6}([a-z_][a-z0-9_]*)\s*:/gm)].map((match) => match[1]),
);

check('the insert keys were parsed', sent.size > 10, `parsed ${sent.size}: ${[...sent].join(', ')}`);

// ----------------------------------------------------- the two comparisons --

/*
 * ⚠ Required means `not null` AND no default.
 *
 *   `documents`, `status` and `submitted_at` are all `not null` and all have
 *   defaults, so the client may omit them — and `status` in particular *must*
 *   omit it, because the insert policy refuses any value but the default.
 */
const required = [...columns.entries()]
  .filter(([, column]) => column.notNull && !column.hasDefault)
  .map(([name]) => name);

check('some columns are required', required.length > 5, required.join(', '));

for (const column of required) {
  check(
    `the client sends ${column}, which the table requires`,
    sent.has(column),
    'a not-null column with no default that the client omits is a 23502 at the end of the form',
  );
}

for (const key of sent) {
  check(
    `${key} is a real column`,
    columns.has(key),
    'a key with no column is PGRST204, which the app renders as a connection problem',
  );
}

/*
 * ⚠ And the three that started it, by name.
 *
 *   The loop above would go green if somebody re-added these to the client
 *   instead — which would mean a driver typing their guarantor's national
 *   identifier again, the exact thing 39 exists to stop. The fix has to be the
 *   constraint, not the form.
 */
for (const column of ['guarantor_relationship', 'guarantor_address', 'guarantor_nin']) {
  check(
    `${column} is nullable, because nothing collects it any more`,
    columns.get(column)?.notNull === false,
    '39 stopped writing this column and left it not null; see 52',
  );
  check(
    `and the client does not ask a driver for ${column}`,
    !sent.has(column),
    'a driver has no business entering somebody else’s national identifier — see 39',
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — every not-null column without a default is sent by submitApplication, every key\n' +
    '       it sends is a real column, and the three guarantor columns 39 orphaned are\n' +
    '       nullable rather than re-asked of the driver.',
);
