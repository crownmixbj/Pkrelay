import { formatStamp, formatDay, formatClock } from '../src/lib/when';
const rows: [string, string][] = [
  ['posted (midday Lagos)', '2026-10-02T11:00:00.000Z'],
  ['accepted 25 min later', '2026-10-02T11:25:00.000Z'],
  ['collected', '2026-10-02T13:05:00.000Z'],
  ['delivered', '2026-10-02T16:42:00.000Z'],
  ['late-night post (UTC is still 1 Oct)', '2026-10-01T23:30:00.000Z'],
];
for (const [label, iso] of rows) console.log(`${label.padEnd(38)} ${iso}  ->  ${formatStamp(iso)}`);
console.log(`${'date only'.padEnd(38)} ->  ${formatDay(rows[0][1])}`);
console.log(`${'time only'.padEnd(38)} ->  ${formatClock(rows[0][1])}`);
console.log(`${'missing value'.padEnd(38)} ->  "${formatStamp(null)}"`);
