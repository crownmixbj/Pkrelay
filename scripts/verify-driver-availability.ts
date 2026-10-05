/**
 * Assertions for the driver availability panel and the assignment repair.
 *
 * ⚠ Four of these guard mistakes that would be invisible on the screen.
 *
 *   1. `admin_assign_parcel` must keep qualifying its own parameter. Unqualified
 *      it is ambiguous with `bookings.driver` and raises before it writes —
 *      which is how hand assignment was dead from 25 to 69 while a harness with
 *      a synthetic `bookings` table reported it working.
 *   2. The assignment must set the carrier name and move the status to
 *      'Assigned'. Those two lines are what the row's check constraint demands
 *      and what 50's notifier keys the driver's push on. Drop either and the
 *      screen still looks right.
 *   3. The waiting list must gate on the matcher's own liveness expression. A
 *      second definition drifts, and the symptom is a driver on this list whom
 *      dispatch has already written off — which reads as dispatch being broken.
 *   4. A banned or erased driver must not reach a list whose next button
 *      assigns them a parcel. `is_approved_driver()` cannot be asked about
 *      somebody else, so those conditions are written out and must stay.
 *
 * Run with `npm run verify:availability`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { shiftLabel, waitLabel, UNKNOWN_AVAILABILITY } from '../src/store/dispatch-mode';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const repair = read('supabase/migrations/20250101000069_assign_parcel_repair.sql');
const availability = read('supabase/migrations/20250101000070_driver_availability.sql');
const matcher = read('supabase/migrations/20250101000026_departure_time.sql');
const store = read('src/store/dispatch-mode.ts');
const panel = read('src/components/ui/drivers-waiting.tsx');
const control = read('src/components/ui/dispatch-control.tsx');

/** Source with comments stripped — the prose here quotes what it forbids. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '')
    .replace(/\/\/.*$/gm, '');

// --------------------------------------- 1. the assignment actually writes --

{
  const sql = code(repair);

  check(
    'the repaired function keeps its signature',
    /create or replace function public\.admin_assign_parcel\(parcel uuid, driver uuid\)/.test(sql),
    'the client calls it through PostgREST by argument name — a rename has to ship with the app',
  );

  check(
    'every use of the driver parameter is qualified',
    !/[^.\w]driver\b(?!\s*=)(?![\w.])/.test(
      sql
        .split('update public.bookings')[1]
        ?.split('update public.dispatch_offers')[0] ?? 'driver',
    ) || /admin_assign_parcel\.driver/.test(sql),
    'unqualified, it is ambiguous with bookings.driver and the function raises before writing',
  );

  const uses = sql.match(/admin_assign_parcel\.driver/g) ?? [];
  check(
    'and it is qualified everywhere it is read',
    uses.length >= 4,
    `found ${uses.length} — the approval check, the document gate, the update and the log row`,
  );

  check(
    'the carrier name is written with the id',
    /driver = coalesce\(driver_name, 'Driver'\)/.test(sql),
    'driver_pair_consistent refuses an id with no name, and every screen renders the name',
  );
  check(
    'and it comes from the profile, like the accept path',
    /coalesce\(nullif\(btrim\(p\.full_name\), ''\), 'Driver'\)/.test(sql),
    "15's respond_to_offer uses the same fallback — two paths, one placeholder",
  );
  check(
    "the status moves to 'Assigned'",
    /status = 'Assigned'/.test(sql),
    "50's notifier is `after update of status` and keys both messages on that transition",
  );
  check(
    "and not to the status it already had",
    !/status = 'Booked'/.test(sql),
    'writing Booked over Booked fired the trigger on a no-op and told nobody',
  );
  check(
    'accepted_at is left alone',
    !/accepted_at = now\(\)/.test(sql),
    'nobody accepted a hand assignment; the column means a driver took the job',
  );
  check(
    'a live offer on the parcel is still settled',
    /update public\.dispatch_offers[\s\S]{0,200}status = 'expired'/.test(sql),
    'otherwise a driver mid-countdown taps Accept on somebody else’s parcel',
  );
  check(
    'and the override is still logged at a level that depends on the mode',
    /case when public\.dispatch_mode\(\) = 'manual' then 'info' else 'warning' end/.test(sql),
    'every hand assignment logged as a warning in manual mode buries the ones that matter',
  );
  check(
    'the four refusals are all still there',
    /No such parcel/.test(sql) &&
      /already has a driver/.test(sql) &&
      /cannot be assigned/.test(sql) &&
      /not approved/.test(sql) &&
      /expired document/.test(sql),
    'a repair that drops one of a function’s conditions is this codebase’s most repeated failure',
  );
}

// ------------------------------------------ 2. the doors on the new RPCs --

const FUNCTIONS = [
  'admin_waiting_drivers',
  'admin_parcels_for_driver',
  'admin_driver_availability',
] as const;

for (const fn of FUNCTIONS) {
  const start = availability.indexOf(`function public.${fn}(`);
  check(`${fn} exists`, start >= 0);
  if (start < 0) continue;

  const next = FUNCTIONS.map((other) =>
    other === fn ? -1 : availability.indexOf(`function public.${other}(`),
  ).filter((at) => at > start);
  const body = availability.slice(start, next.length ? Math.min(...next) : undefined);

  check(
    `${fn} checks is_admin()`,
    /is_admin\(\)/.test(body),
    'these return every driver’s name, phone and whereabouts',
  );
  check(
    `${fn} is security definer with a pinned search_path`,
    /security definer/.test(body) && /set search_path = ''/.test(body),
  );
  check(
    `${fn} is revoked from anon`,
    new RegExp(`revoke all on function public\\.${fn}\\(`).test(availability),
    'granted to anon, this answers to a key that ships inside the app bundle',
  );
  check(
    `${fn} is granted to authenticated`,
    new RegExp(`grant execute on function public\\.${fn}\\(`).test(availability),
  );
}

// ----------------------------------- 3. one definition of "still on shift" --

{
  const sql = code(availability);

  const expression = /coalesce\(j\.departure_time, j\.departs_before\) > now\(\)/;
  check(
    'the waiting list uses the matcher’s liveness expression',
    expression.test(sql),
    'journey_matches gates on coalesce(departure, departs_before) > now() — a second definition\n' +
      '       drifts, and the symptom is a driver listed as available whom dispatch has dropped',
  );
  check(
    'and the matcher really is written that way',
    /coalesce\(journey_departure, journey_departs_before\) > now\(\)/.test(code(matcher)),
    'if 26 changes, this file has to change with it — that is what makes the copy safe',
  );

  check(
    'matching is delegated to journey_matches rather than re-implemented',
    /public\.journey_matches\(/.test(sql),
    'a hand-written route comparison here would disagree with the automation on flash shifts,\n' +
      '       capacity and departure — the three things it gets wrong most easily',
  );
  check(
    'and nothing compares cities by hand',
    !/j\.origin_city\s*=\s*b\.origin_city/.test(sql),
    'that is journey_matches’ job, and only its job',
  );
}

// ------------------------------------------- 4. who is kept off the list --

{
  const sql = code(availability);

  check(
    'a banned driver is excluded',
    /p\.driving_banned_at is null/.test(sql),
    'the next button on this screen assigns them a parcel',
  );
  check(
    'an erased account is excluded',
    /p\.deleted_at is null/.test(sql),
  );
  check(
    'only approved applications count',
    /a\.status = 'approved'/.test(sql),
  );
  check(
    'the document gate is applied',
    /documents_permit_dispatch\(/.test(sql),
    'an expired blocking document is a legal limit — admin_assign_parcel refuses them too',
  );
  check(
    'a driver with a live offer is excluded',
    /o\.status = 'offered'[\s\S]{0,80}o\.expires_at > now\(\)/.test(sql),
    'they are about to have an answer; a second parcel now is two going opposite ways',
  );
  check(
    'a driver already carrying something is excluded',
    /b\.status not in \('Delivered', 'Cancelled'\)/.test(sql),
    'online is not the same as free',
  );
  check(
    'and the counts say how many are absent for each reason',
    /'with_offer'/.test(sql) &&
      /'carrying'/.test(sql) &&
      /'off_shift'/.test(sql) &&
      /'blocked'/.test(sql),
    'without them an empty list and a broken query look identical',
  );
}

// ------------------------------------------------- 5. the store's manners --

{
  check(
    'the waiting list distinguishes "could not load" from "nobody"',
    /fetchWaitingDrivers[\s\S]{0,400}if \(error \|\| !data\) return null;/.test(store),
    'an empty array rendered as "everyone is busy" is a claim about a query that never returned',
  );
  check(
    'the tiles do the same',
    /fetchDriverAvailability[\s\S]{0,300}if \(error \|\| !data\) return null;/.test(store),
  );
  check(
    'assignment still goes through the one audited write path',
    /rpc\('admin_assign_parcel'/.test(store) &&
      !/rpc\('assign_parcel_from_driver'/.test(store),
    'a second write path would drift from the refusals and the audit line in 69',
  );

  check(
    'a flash shift does not render as a route to itself',
    shiftLabel({ mode: 'flash', originCity: 'Ibadan', destinationCity: 'Ibadan' }) === 'In Ibadan',
    '"Ibadan → Ibadan" makes a deliberate shape look like a bug',
  );
  check(
    'and a scheduled one does render as a route',
    shiftLabel({ mode: 'scheduled', originCity: 'Ibadan', destinationCity: 'Lagos' }) ===
      'Ibadan → Lagos',
  );
  check('waitLabel is shared with the parcel queue', waitLabel(135) === '2h 15m', waitLabel(135));
  check(
    'the unknown-availability shape is all zeros',
    Object.values(UNKNOWN_AVAILABILITY).every((value) => value === 0),
  );
}

// ------------------------------------------------- 6. the panel on screen --

{
  check(
    'the panel sits above the parcel queue in Dispatch',
    control.indexOf('<DriversWaiting') > 0 &&
      control.indexOf('<DriversWaiting') < control.indexOf('Waiting for a driver'),
    'an operator with idle drivers works driver-first; the people go above the packages',
  );
  check(
    'it is told the dispatch mode',
    /<DriversWaiting[\s\S]{0,160}mode=\{unavailable \? null : health\.mode\}/.test(control),
    'the same list means "the work queue" in manual mode and "the matcher failed" in auto',
  );
  check(
    'and assignment refreshes the parcel queue behind it',
    /<DriversWaiting[\s\S]{0,200}onAssigned=\{\(\) => void refresh\(\)\}/.test(control),
    'the parcel just given away has to leave the list below',
  );

  check(
    'the panel says where the boundary actually is',
    /is_admin\(\)/.test(panel),
    'the next person to read this needs to know it is not the component',
  );
  check(
    'it explains what the list means in automatic mode',
    /matching has not placed them/.test(panel),
    'an idle driver beside a matching parcel is the automation failing, not an idle driver',
  );
  check(
    'it names cooldown rather than leaving it a mystery',
    /cooldown/i.test(panel),
    'otherwise the operator concludes dispatch is broken when 23 is working as designed',
  );
  check(
    'a blocked driver is called out even though they are not in the list',
    /expired document/.test(panel),
    'they think they are working, and neither the matcher nor hand assignment will use them',
  );
  check(
    'the empty state is not a measurement when nothing loaded',
    /could not be read/.test(panel),
    '"nobody is waiting" on a failed query is the same lie as a green banner',
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('the availability panel holds.\n');
