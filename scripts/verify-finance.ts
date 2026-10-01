/**
 * Assertions for the Admin finance screens.
 *
 * ⚠ Three of these guard mistakes that would be invisible on the screen.
 *
 *   1. A ledger function that forgot `is_admin()` looks identical in the
 *      browser to one that has it — the admin testing it is an admin. What
 *      changes is that every driver can read every other driver's balance.
 *   2. The two currencies. Sender payments are stored in kobo; driver earnings
 *      are stored in naira. One ÷100 too many or too few is a screen that is
 *      wrong by a factor of a hundred and entirely plausible.
 *   3. The account number. The ledger is supposed to carry four digits and the
 *      full number is supposed to be a second, logged call. Widening the ledger
 *      to include it would make the screen *more* convenient and put every
 *      driver's bank details in front of anybody who opens the tab.
 *
 * Run with `npm run verify:finance`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { csvFilename, toCsv } from '../src/lib/csv';
import {
  PAYMENT_CSV_COLUMNS,
  PAYOUT_STATE_LABELS,
  TRANSACTION_CSV_COLUMNS,
  fromDateInput,
  resolveRange,
  type PayoutState,
} from '../src/store/finance';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const migration = read('supabase/migrations/20250101000058_admin_finance.sql');
const store = read('src/store/finance.ts');
const screen = read('src/app/(tabs)/admin-finance.tsx');
const migration60 = read('supabase/migrations/20250101000060_finance_reporting.sql');

/**
 * The migration that currently *owns* a function, not the one that first
 * created it.
 *
 * ⚠ `20250101000060_finance_reporting.sql` drops and recreates two of 58's
 *   functions, and asserting against 58 after that is asserting against a
 *   definition the database never sees.
 *
 *   The RLS harness learned this the expensive way: its mutation testing
 *   silently stopped proving anything the moment a later migration recreated
 *   the policy it was breaking. The rule is the same here — the last file that
 *   defines a thing is the definition.
 */
function definitionOf(fn: string): string {
  const owner = [migration, migration60].filter((source) =>
    source.includes(`function public.${fn}(`),
  );
  const source = owner.at(-1) ?? '';
  const start = source.indexOf(`function public.${fn}(`);
  if (start < 0) return '';

  /* Bounded at the next definition, or a slice bleeds into its neighbours. */
  const next = source.indexOf('function public.', start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

/** Source with comments stripped — the prose here quotes what it forbids. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '').replace(/\/\/.*$/gm, '');

// ------------------------------------------------ 1. every door is guarded --

const LEDGER_FUNCTIONS = [
  'admin_payment_totals',
  'admin_payments_ledger',
  'admin_payout_ledger',
  'admin_driver_ledger',
  'admin_reveal_payout_account',
] as const;

for (const fn of LEDGER_FUNCTIONS) {
  const start = migration.indexOf(`function public.${fn}(`);
  check(`${fn} exists`, start >= 0);
  if (start < 0) continue;

  const next = LEDGER_FUNCTIONS.map((other) =>
    other === fn ? -1 : migration.indexOf(`function public.${other}(`),
  ).filter((at) => at > start);
  const body = migration.slice(start, next.length ? Math.min(...next) : undefined);

  check(
    `${fn} checks is_admin()`,
    /is_admin\(\)/.test(body),
    'a definer function over money with no caller check is a public API for the whole table',
  );
  check(
    `${fn} is security definer with a pinned search_path`,
    /security definer/.test(body) && /set search_path = ''/.test(body),
    'a definer function without a pinned search_path can be redirected by a caller-set path',
  );
  check(
    `${fn} is revoked from anon`,
    new RegExp(`revoke all on function public\\.${fn}\\(`).test(migration),
    'granted to anon, these answer to a key that ships in the app bundle',
  );
}

// -------------------------------------------- 2. what the ledgers hand back --

{
  const payoutLedger = definitionOf('admin_payout_ledger');

  check(
    'the payout ledger returns an account hint, not an account number',
    /open_account_hint/.test(payoutLedger) && !/open_account_number/.test(payoutLedger),
    'a full account number in a list view is one on screen all day, unlogged',
  );
  check(
    'and it is right(…, 4)',
    /right\(o\.account_number, 4\)/.test(payoutLedger),
    'four digits identify an account; they cannot be used to move money',
  );

  const reveal = definitionOf('admin_reveal_payout_account');
  check(
    'only the reveal returns the whole number',
    /select r\.bank_name, r\.account_number/.test(reveal),
  );
  check(
    'and it writes an audit line first',
    reveal.indexOf('insert into public.app_events') < reveal.indexOf('return query'),
    'logging after the read means a failed read is an unlogged read',
  );
  check(
    'naming the admin who asked',
    /actor_id\s*\)?[\s\S]{0,200}auth\.uid\(\)/.test(reveal) || /auth\.uid\(\)/.test(reveal),
    'an audit line with no actor answers nothing',
  );

  const payments = definitionOf('admin_payments_ledger');
  check(
    'the payments ledger carries no sender phone or address',
    !/sender_phone|pickup_address|dropoff_address|recipient_phone/.test(payments),
    'those already live behind admin_reveal_parcel_contacts, which records who looked',
  );
  check(
    'and it sums kobo rather than converting in SQL',
    /amount_kobo/.test(payments) && !/amount_kobo\s*\/\s*100/.test(payments),
    'converting in two places is two places to get it wrong; the screen divides once',
  );
}

// ------------------------------------------------- 3. the two currencies ----

{
  const inbound = store.slice(store.indexOf('export async function fetchPaymentTotals'), store.indexOf('// ---------------------------------------------------------------- outbound --'));
  const outbound = store.slice(store.indexOf('// ---------------------------------------------------------------- outbound --'));

  const divisions = (inbound.match(/\/ 100/g) ?? []).length;
  check(
    'the inbound store converts kobo to naira',
    divisions >= 3,
    `${divisions} conversions — the totals and the row amounts are all stored in kobo`,
  );

  check(
    'and the outbound store converts nothing',
    !/\/ 100/.test(outbound),
    'driver earnings are stored in naira by 20250101000030_driver_wallet.sql. Dividing them\n' +
      '       by 100 pays somebody ₦23.80 for a ₦2,380 delivery',
  );

  check(
    'the screen never divides an amount itself',
    !/\/ 100/.test(code(screen)),
    'one ÷100 in a component is one the next component forgets',
  );
}

// ------------------------------------------------- 4. the settle action ----

{
  check(
    'marking a payout paid requires a reference',
    /reasonRequired/.test(screen) && /Bank transfer reference/.test(screen),
    'a settled payout with nothing recorded cannot be matched to a bank statement when a\n' +
      '       driver says the money never arrived',
  );

  check(
    'and it goes through settle_payout rather than writing the table',
    /rpc\('settle_payout'/.test(store) && !/from\('payout_requests'\)/.test(store),
    'payout_requests has no client write policy at all; a direct write would simply fail',
  );

  check(
    'the dialog says plainly that no money moves',
    /does not move any money/i.test(screen),
    'an operator who thinks this makes the transfer is an operator who does not make it',
  );
}

// ----------------------------------------------------- 5. the four states --

{
  const states: PayoutState[] = ['pending', 'ready', 'holding', 'paid'];

  for (const state of states) {
    check(`the SQL can produce '${state}'`, new RegExp(`'${state}'`).test(migration));
    check(`and the app has a label for it`, Boolean(PAYOUT_STATE_LABELS[state]));
  }

  check(
    "'ready' is derived from the balance, not from a row",
    /available >= \(select minimum from settings\)[\s\S]{0,40}then 'ready'/.test(migration),
    'payout_requests has no row for a driver who has not asked yet — a ledger built on that\n' +
      '       table alone is empty on the day the platform owes the most',
  );

  check(
    "and 'pending' wins over it",
    migration.indexOf("then 'pending'") < migration.indexOf("then 'ready'"),
    'a driver with an open request is waiting on us, not on themselves',
  );
}

// ------------------------------------------- 6. the screen is not the guard --

{
  check(
    'the finance screen is wrapped in AdminShell',
    /<AdminShell/.test(screen),
    'not as the control — as the courtesy that keeps a non-admin off a screen that would be\n' +
      '       empty anyway',
  );
  check(
    'and it says so in the file',
    /is_admin\(\)/.test(screen),
    'the next person to read this needs to know where the boundary actually is',
  );
  check(
    'the nav entry resolves to the route',
    read('src/components/ui/app-nav-bar.tsx').includes("href: '/admin-finance'"),
  );
  check(
    'and the route is in the admin `also` list',
    /also: \[[^\]]*'\/admin-finance'/.test(read('src/components/ui/app-nav-bar.tsx')),
    'without it the Admin tab stops looking active on this screen',
  );
}

// -------------------------------------------------------- 7. the CSV writer --

{
  type Row = { a: string; n: number };
  const columns = [
    { header: 'Text', value: (row: Row) => row.a },
    { header: 'Number', value: (row: Row) => row.n },
  ];

  const csv = toCsv(
    [
      { a: 'Bodija, Ibadan', n: 2800 },
      { a: 'He said "leave it"', n: 0 },
      { a: 'line one\nline two', n: -1 },
    ],
    columns,
  );

  check(
    'a field containing a comma is quoted',
    csv.includes('"Bodija, Ibadan"'),
    'unquoted, every column after it shifts by one and the amounts land against the wrong\n' +
      '       references — silently, from that row onwards',
  );
  check(
    'a quote inside a field is doubled',
    csv.includes('"He said ""leave it"""'),
    'RFC 4180: a bare quote inside a quoted field ends the field early',
  );
  check(
    'a newline inside a field survives',
    csv.includes('"line one\nline two"'),
    'an address over two lines must be one cell, not two rows',
  );
  check(
    'numbers are written bare',
    /,2800(\r|$)/m.test(csv) && !csv.includes('"2800"'),
    'a column of quoted, symbol-prefixed amounts is text, and text does not add up',
  );
  check('rows are CRLF-terminated', csv.includes('\r\n'));

  /* ⚠ The one that is a security property rather than a formatting one. */
  const dangerous = toCsv([{ a: '=1+1', n: 0 }, { a: '@SUM(A1)', n: 0 }], columns);
  check(
    'a field that would execute as a formula is defused',
    dangerous.includes('"\t=1+1"') && dangerous.includes('"\t@SUM(A1)"'),
    'Excel, Sheets and Numbers all run a cell beginning = + - or @ when the file is opened,\n' +
      '       and a payout reference is typed by a person',
  );

  check(
    'the filename carries the range',
    csvFilename('payments', new Date(2026, 2, 1), new Date(2026, 2, 31)).includes('2026-03-01'),
  );
}

// ------------------------------------------------------- 8. the date range --

{
  /* A Wednesday, mid-afternoon, so nothing below depends on the day it runs. */
  const now = new Date(2026, 8, 16, 14, 30, 0);

  const today = resolveRange('today', undefined, now);
  check(
    'today starts at local midnight',
    today.from?.getHours() === 0 && today.from?.getDate() === 16,
    `${today.from?.toString()}`,
  );
  check(
    'and ends at the next midnight, exclusive',
    today.to?.getDate() === 17 && today.to?.getHours() === 0,
    'an inclusive bound puts a charge made at exactly midnight into two adjacent exports',
  );

  const week = resolveRange('7d', undefined, now);
  check(
    'last 7 days covers seven days including today',
    week.from?.getDate() === 10,
    `${week.from?.toDateString()} — six days back plus today is seven`,
  );

  const month = resolveRange('30d', undefined, now);
  check('last 30 days covers thirty', month.from?.getDate() === 18 && month.from?.getMonth() === 7);

  const all = resolveRange('all', undefined, now);
  check('all time is unbounded', all.from === null && all.to === null);

  const custom = resolveRange(
    'custom',
    { from: new Date(2026, 2, 1), to: new Date(2026, 2, 31) },
    now,
  );
  check(
    'a custom end date is inclusive of that day',
    custom.to?.getDate() === 1 && custom.to?.getMonth() === 3,
    'the picker takes an end date a person means to include, so the bound is the day after',
  );

  check(
    'a typed date is parsed as local midnight',
    fromDateInput('2026-03-01')?.getDate() === 1,
    "new Date('2026-03-01') is UTC midnight, which is the 28th of February in half the world",
  );
  check('and nonsense is rejected', fromDateInput('not a date') === null);
}

// ------------------------------------------- 9. the split, and the export --

{
  const ledger = definitionOf('admin_payments_ledger');

  check(
    'the ledger returns whether the split is real',
    /split_is_actual boolean/.test(ledger),
    'without it the same three numbers mean "owed" on one row and "forecast" on the next',
  );
  check(
    'and it is true only when an earning row exists',
    /e\.id is not null/.test(ledger),
    'driver_earnings is written at delivery; before that there is no split to report',
  );
  check(
    'the projection uses the live commission rate',
    /commission_rate\(\)/.test(ledger) && /coalesce\(e\.commission,/.test(ledger),
    'a hardcoded rate in the ledger is a second place for the rate to live',
  );
  check(
    'and a recorded split uses the rate stored on the earning',
    /coalesce\(e\.commission_rate,/.test(ledger),
    '30 stores the rate on the row so a change next quarter cannot rewrite last quarter',
  );

  check(
    'the screen labels a projection rather than showing a bare number',
    /Projected at the current rate/.test(screen) && /splitIsActual \? 'Recorded' : 'Expected'/.test(screen),
    'a forecast that reads as a liability is the whole failure this column can have',
  );

  const splitBasis = PAYMENT_CSV_COLUMNS.find((column) => column.header === 'Split basis');
  check('the export says which basis each row used', Boolean(splitBasis));
  check(
    'and spells it out rather than exporting a boolean',
    splitBasis?.value({ splitIsActual: false } as never) === 'projected at current rate',
    'TRUE/FALSE in a spreadsheet is read past; a sentence is not',
  );

  for (const column of [...PAYMENT_CSV_COLUMNS, ...TRANSACTION_CSV_COLUMNS]) {
    if (!/\(NGN\)|rate/.test(column.header)) continue;
    const value = column.value({
      amount: 2800, fare: 2800, commission: 420, driverShare: 2380, commissionRate: 0.15,
      gross: 2800,
    } as never);
    check(
      `the "${column.header}" column exports a number`,
      typeof value === 'number',
      `got ${typeof value} — a formatted currency string is text, and text does not sum`,
    );
  }
}

// ------------------------------------------------ 10. the manual sync ------

{
  const verify = read('supabase/functions/payments-verify/index.ts');

  check(
    'an admin may verify a charge that is not theirs',
    /onBehalf/.test(verify) && /isAdmin\(/.test(verify),
    'a dropped webhook leaves a charge Paystack took and a parcel nobody can see, long after\n' +
      "       the sender's own retry window has gone",
  );
  check(
    'and only an admin',
    /onBehalf && !admin/.test(verify),
    'without the second half of that condition this reads any reference for anybody',
  );
  check(
    'the reach is logged before the work, not after',
    verify.indexOf("'admin re-verified a charge'") < verify.indexOf('verifyTransaction('),
    'a log written only on success is silent about the attempts that failed, which are the\n' +
      '       interesting ones',
  );
  check(
    'the app reaches it through the existing verify path',
    /verifyParcelPayment/.test(store) && !/payments-admin-sync/.test(store),
    'a second endpoint means a second amount comparison and a second definition of settled',
  );
  check(
    'and the screen offers it on settled rows too',
    /Re-check with Paystack/.test(screen),
    'the mirror case — our row says success, the parcel still says unpaid — is the same dropped\n' +
      '       webhook seen from the other end',
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('the finance screens hold.\n');
