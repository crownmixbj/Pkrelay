/**
 * Assertions for when things happened, and whose clock says so.
 *
 * ⚠ The failure this pins is not a crash — it is two true answers.
 *
 *   Every screen used to call `toLocaleString()` on its own, which renders in
 *   the *reader's* zone. A driver in Lagos and a support console in Dublin
 *   therefore saw different times for one pickup, with nothing on either screen
 *   to say which zone it was. Any argument about whether a parcel was collected
 *   before a cut-off had two numbers and no tie-break.
 *
 * So: one formatter, one zone, and the zone written on the face of it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { TIME_ZONE_LABEL, formatClock, formatDay, formatStamp, lagosNow } from '../src/lib/when';
import { stageTimestamp } from '../src/store/bookings';
import type { Booking } from '../src/store/bookings';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Every .ts/.tsx under a directory, as repo-relative paths. */
function listSourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return listSourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// ------------------------------------------------------- the formatter -----

check(
  'a UTC instant is rendered in Lagos time',
  formatStamp('2026-10-02T13:35:00.000Z') === `2 Oct 2026, 14:35 ${TIME_ZONE_LABEL}`,
  formatStamp('2026-10-02T13:35:00.000Z'),
);

/*
 * The case that proves it is a zone conversion rather than a label stuck on
 * UTC: 23:30 UTC is already tomorrow in Lagos, so the *date* has to move too.
 */
check(
  'and the day moves with it across midnight',
  formatStamp('2026-10-01T23:30:00.000Z') === `2 Oct 2026, 00:30 ${TIME_ZONE_LABEL}`,
  formatStamp('2026-10-01T23:30:00.000Z'),
);

check(
  'midday is unambiguous',
  formatClock('2026-10-02T11:00:00.000Z') === `12:00 ${TIME_ZONE_LABEL}` &&
    formatClock('2026-10-02T23:00:00.000Z') === `00:00 ${TIME_ZONE_LABEL}`,
  '24-hour, because "12:00" with no am/pm is the one mistake a timestamp cannot make',
);

check('single digits are padded', formatClock('2026-10-02T06:05:00.000Z') === `07:05 ${TIME_ZONE_LABEL}`);
check('the date alone drops the time', formatDay('2026-10-02T13:35:00.000Z') === '2 Oct 2026');

/*
 * ⚠ Nothing renders as "Invalid Date" in front of a customer.
 */
for (const empty of [null, undefined, '', 'not a date']) {
  check(
    `an unusable value (${JSON.stringify(empty)}) formats as nothing`,
    formatStamp(empty) === '' && formatDay(empty) === '' && formatClock(empty) === '',
  );
}

/*
 * ⚠ No `Intl` time zone, and this is a runtime-safety rule rather than taste.
 *
 *   `Intl.DateTimeFormat(..., { timeZone: 'Africa/Lagos' })` throws RangeError
 *   on a Hermes build without full ICU — on a phone, in the field, on a screen
 *   that worked in the simulator. WAT is UTC+1 year round, so the arithmetic is
 *   exact and engine-independent.
 */
const when = code(read('src/lib/when.ts'));

check(
  'the formatter does not depend on Intl time zones',
  !/Intl\.DateTimeFormat/.test(when) && !/timeZone:/.test(when),
  'an unsupported zone on Hermes is a RangeError at runtime, not a fallback',
);
check(
  'the offset is stated once',
  /WAT_OFFSET_MINUTES = 60/.test(when),
  'Nigeria does not observe daylight saving, so one constant covers the year',
);

// ------------------------------------------- what the sender actually sees --

/*
 * Four surfaces, and before this change three of them never said when. A sender
 * with two parcels of the same thing could not tell the rows apart.
 */
const SENDER_SURFACES: [string, string][] = [
  ['the home parcel card', 'src/app/(tabs)/index.tsx'],
  ['the My Shipments row', 'src/app/(tabs)/my-packages.tsx'],
  ['the parcel detail', 'src/app/parcel/[id].tsx'],
  ['the posting confirmation', 'src/app/(tabs)/parcel-confirmed.tsx'],
];

for (const [label, path] of SENDER_SURFACES) {
  const source = code(read(path));

  check(
    `${label} shows when the parcel was posted`,
    /formatStamp\(booking\.createdAt\)/.test(source),
    'the row carried what and where, never when',
  );
  check(
    `${label} formats through the shared helper`,
    !/toLocaleString\(|toLocaleTimeString\(|toLocaleDateString\(/.test(source),
    'a local call renders in the reader own zone, which is the bug this file exists for',
  );
}

/*
 * The journey timeline is the one place a dispute is settled, so each stage
 * that has a real timestamp shows it.
 */
const detail = code(read('src/app/parcel/[id].tsx'));

check(
  'the journey timeline stamps each stage it can',
  /formatStamp\(stageTimestamp\(booking, stage\)\)/.test(detail),
  'a stage list with no times says the parcel moved, not when',
);
check(
  'and a stage with no timestamp shows none',
  /\{!!at &&/.test(detail),
  '"Delivered —" on a parcel in transit reads as a delivery that went wrong',
);

/*
 * ⚠ One mapping of stage → timestamp, read by both screens.
 *
 *   The tracking screen had it as a private function; the parcel detail needed
 *   the same answers. Two copies is two chances to stamp "Picked Up" with the
 *   acceptance time.
 */
const base = {
  createdAt: '2026-10-01T08:00:00.000Z',
  acceptedAt: '2026-10-01T09:00:00.000Z',
  pickedUpAt: '2026-10-01T10:00:00.000Z',
  deliveredAt: '2026-10-01T15:00:00.000Z',
} as unknown as Booking;

check('Booked reads the posting time', stageTimestamp(base, 'Booked') === base.createdAt);
check('Assigned reads the acceptance', stageTimestamp(base, 'Assigned') === base.acceptedAt);
check('Picked Up reads the collection', stageTimestamp(base, 'Picked Up') === base.pickedUpAt);
check('Delivered reads the delivery', stageTimestamp(base, 'Delivered') === base.deliveredAt);
check(
  'and the stages nothing stamps return null rather than a guess',
  stageTimestamp(base, 'In Transit') === null &&
    stageTimestamp(base, 'Out for Delivery') === null,
  'deriving a plausible time from createdAt would put invented delivery times in front of a sender',
);

check(
  'the mapping is exported rather than copied',
  /export function stageTimestamp/.test(read('src/store/bookings.tsx')) &&
    !/function stageTimestamp/.test(code(read('src/app/(tabs)/tracking.tsx'))),
  'two copies is two chances to stamp a stage with the wrong column',
);

// ------------------------------------------ the clock the rest of it reads ---

/*
 * `lagosNow` is the same shift for code that reasons about *now* rather than
 * rendering a stamp — "is this hub open" being the one that matters.
 */
check(
  'lagosNow reads the Lagos wall clock',
  (() => {
    const at = lagosNow(new Date('2026-10-02T23:30:00.000Z'));
    /* 23:30 UTC on Friday is 00:30 on Saturday in Lagos. */
    return at.weekday === 6 && at.hour === 0 && at.minute === 30;
  })(),
  'the weekday has to move with the hour, or a hub reads as open on the wrong day',
);

const hubHours = code(read('src/constants/hub-hours.ts'));

check(
  'hub opening hours use it rather than an Intl time zone',
  /lagosNow\(/.test(hubHours) && !/timeZone: 'Africa\/Lagos'/.test(hubHours),
  'Intl with a named zone throws RangeError on a Hermes build without full ICU, and this decides whether a hub renders as open',
);

// ------------------------------------- one clock, everywhere it is a record --

/*
 * ⚠ A sweep, because the failure comes back one screen at a time.
 *
 *   `toLocaleString()` is the obvious thing to reach for and renders in the
 *   reader's own zone, which is the whole bug. The exceptions below are not
 *   event timestamps, and each is listed with why rather than being skipped
 *   quietly.
 */
const LOCAL_TIME_IS_CORRECT: Record<string, string> = {
  'src/lib/departure.ts':
    'a driver choosing when they will travel — the labels must match the device calendar the picker is drawn from, and "Today" has to mean the device\'s today',
  'src/lib/expiry.ts':
    'a document expiry is a calendar date, formatted against UTC on purpose so it cannot shift a day',
  'src/store/own-details.ts': 'member-since is a month and a year, not a moment',
};

const sources = listSourceFiles('src');

const strays = sources.filter((path) => {
  if (path in LOCAL_TIME_IS_CORRECT || path === 'src/lib/when.ts') return false;
  const source = code(read(path));
  /* `toLocaleString('en-NG')` on a number is money, not a time. */
  return /toLocale(String|DateString|TimeString)\((?!'en-NG'\))/.test(source);
});

check(
  'no screen formats a timestamp in the reader own zone',
  strays.length === 0,
  `still device-local: ${strays.join(', ') || 'none'} — use lib/when, or list the file with a reason`,
);

/*
 * The admin and driver surfaces specifically, since they are the ones a
 * dispute is reconstructed from.
 */
for (const [label, path] of [
  ['the admin parcel drawer', 'src/components/ui/admin-parcel-drawer.tsx'],
  ['the admin finance screen', 'src/app/(tabs)/admin-finance.tsx'],
  ['the admin log', 'src/app/(tabs)/admin-logs.tsx'],
  ['the admin user list', 'src/app/(tabs)/admin-users.tsx'],
  ['the driver wallet', 'src/app/(tabs)/driver-wallet.tsx'],
  ['the driver hub', 'src/components/ui/driver-hub.tsx'],
  ['driver earnings', 'src/store/earnings.ts'],
  ['the application timeline', 'src/store/application-timeline.ts'],
] as const) {
  check(
    `${label} reads the shared clock`,
    /formatStamp|formatDay|formatClock/.test(code(read(path))),
    'an admin reconstructing a delivery has to see the time the driver saw',
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — one formatter, one clock: every time the sender sees is Lagos time with the zone\n' +
    '       written on it, the date moves across midnight rather than the label alone, an\n' +
    '       unusable value renders as nothing, all four sender surfaces say when a parcel was\n' +
    '       posted, and stage times come from one exported mapping that guesses nothing.',
);
