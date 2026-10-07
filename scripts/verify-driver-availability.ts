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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { stallTone } from '../src/store/admin';
import { formatSoon } from '../src/lib/when';
import {
  attemptsLabel,
  candidateDepartureLine,
  departureLine,
  offersGoingUnanswered,
  shiftLabel,
  waitLabel,
  UNKNOWN_AVAILABILITY,
} from '../src/store/dispatch-mode';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Every .ts/.tsx under a directory, as repo-relative paths. */
function listSourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return listSourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const repair = read('supabase/migrations/20250101000069_assign_parcel_repair.sql');
const counts = read('supabase/migrations/20250101000071_offer_attempt_counts.sql');
const inFlight = read('supabase/migrations/20250101000073_parcels_in_flight.sql');
const closing = read('supabase/migrations/20250101000074_admin_record_delivery.sql');
const board = read('src/components/ui/parcels-in-flight.tsx');
const adminScreen = read('src/app/(tabs)/admin.tsx');
const drawer = read('src/components/ui/admin-parcel-drawer.tsx');
const availability = read('supabase/migrations/20250101000070_driver_availability.sql');
const priority = read('supabase/migrations/20250101000075_departure_priority.sql');
const triggers = read('supabase/migrations/20250101000050_notification_triggers.sql');
const spine = read('supabase/migrations/20250101000076_notification_spine_repair.sql');
const dispatchMode = read('supabase/migrations/20250101000032_dispatch_mode.sql');
const gaps = read('src/lib/schema-gap.ts');
const drift = read('supabase/migrations/20250101000079_definition_drift_repair.sql');
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

// ------------------------------- 10. attempts are not drivers (71) --------

{
  const sql = code(counts);

  check(
    'one function counts attempts and drivers',
    /create or replace function public\.offer_attempts\(parcel uuid\)/.test(sql),
    'three hand-written count blocks is how the next screen disagrees with the other two',
  );
  check(
    'it counts distinct drivers, not rows',
    /count\(distinct o\.driver_id\)/.test(sql),
    'the whole defect: 7 offer rows at 1 driver rendered as "5 drivers"',
  );
  check(
    'it separates declines from timeouts',
    /filter \(where o\.status = 'declined'\)/.test(sql) &&
      /filter \(where o\.status = 'expired'\)/.test(sql),
    'a parcel drivers refused and a parcel nobody answered are different problems',
  );
  check(
    'and it is admin-gated like everything that reads the offer table',
    /is_admin\(\)/.test(sql) &&
      /revoke all on function public\.offer_attempts\(uuid\) from public, anon/.test(counts),
  );

  for (const fn of ['unassigned_parcels', 'admin_parcels_for_driver'] as const) {
    check(
      `${fn} is dropped before it is recreated`,
      new RegExp(`drop function if exists public\\.${fn}\\(`).test(counts),
      'create or replace cannot widen a returns-table signature',
    );
    check(
      `${fn} reads the counts from offer_attempts`,
      new RegExp(`${fn}[\\s\\S]{0,2600}cross join lateral public\\.offer_attempts`).test(sql),
      'otherwise there are two definitions of "tried" again',
    );
  }

  check(
    'the queue keeps its deliberate lack of a dispatch-mode gate',
    !/unassigned_parcels[\s\S]{0,1200}dispatch_mode\(\)/.test(sql),
    'blanking the queue in auto mode hides it exactly when the automation is failing',
  );
  check(
    'and admin_parcel_detail is left alone',
    !/function public\.admin_parcel_detail/.test(counts),
    'thirty columns recreated to add three is how a condition goes missing',
  );
}

// --------------------------------- 11. the sentence, and where it is said --

{
  check(
    'seven offers at one driver reads as one driver',
    attemptsLabel({ attempts: 7, driversTried: 1, declined: 0, expired: 7, live: 0 }) ===
      '7 offers to 1 driver — all timed out, none declined',
    attemptsLabel({ attempts: 7, driversTried: 1, declined: 0, expired: 7, live: 0 }) ?? 'null',
  );
  check(
    'a live offer is called out rather than counted as a refusal',
    attemptsLabel({ attempts: 7, driversTried: 1, declined: 0, expired: 6, live: 1 }) ===
      '7 offers to 1 driver — 6 timed out, one live right now',
    attemptsLabel({ attempts: 7, driversTried: 1, declined: 0, expired: 6, live: 1 }) ?? 'null',
  );
  check(
    'declines and timeouts are reported separately',
    attemptsLabel({ attempts: 5, driversTried: 4, declined: 3, expired: 2, live: 0 }) ===
      '5 offers to 4 drivers — 3 declined, 2 timed out',
    attemptsLabel({ attempts: 5, driversTried: 4, declined: 3, expired: 2, live: 0 }) ?? 'null',
  );
  check(
    'a parcel never offered says nothing at all',
    attemptsLabel({ attempts: 0, driversTried: 0, declined: 0, expired: 0, live: 0 }) === null,
  );

  check(
    'three unanswered offers is a flag',
    offersGoingUnanswered({ attempts: 3, driversTried: 1, declined: 0, expired: 3, live: 0 }),
    'nobody refusing and nobody answering is a notification fault, not a dispatch one',
  );
  check(
    'but a declined one is not',
    !offersGoingUnanswered({ attempts: 4, driversTried: 2, declined: 1, expired: 3, live: 0 }),
    'somebody looked at it and said no — that is the system working',
  );

  for (const [name, source] of [
    ['the dispatch queue', control],
    ['the give-a-parcel sheet', panel],
    ['the parcel drawer', drawer],
  ] as const) {
    check(
      `${name} uses the shared sentence`,
      /attemptsLabel\(/.test(source),
      'one phrasing means there is no fourth place for it to drift to',
    );
    check(
      `${name} no longer claims N drivers from a row count`,
      !/Offered to \{?\w*\.?offersMade/.test(source) &&
        !/offered to \$\{parcel\.offersMade\}/.test(source),
      'that sentence sent somebody looking for a routing problem for a day',
    );
  }

  check(
    'the queue warns when offers are expiring unanswered',
    /offersGoingUnanswered\(/.test(control) && /being notified/.test(control),
    'the signal that would have found this in a minute rather than a day',
  );
}

// ------------------------------ 12. collected, and not collected (72) -----

{
  const sql = code(inFlight);

  check(
    'the stage clock is added nullable and backfilled, in that order',
    /add column if not exists status_changed_at timestamptz;/.test(sql) &&
      /update public\.bookings[\s\S]{0,260}where status_changed_at is null/.test(sql) &&
      /alter column status_changed_at set default now\(\)/.test(sql),
    'not null default now() would stamp every historical parcel with the migration, and a\n' +
      '       re-run would wipe the real timestamps the trigger had since recorded',
  );
  check(
    'the trigger only fires on a real move',
    /when \(new\.status is distinct from old\.status\)/.test(sql),
    'an update that leaves the status alone is not a stage change',
  );
  check(
    'and it is not security definer',
    !/function public\.set_booking_status_changed_at[\s\S]{0,260}security definer/.test(sql),
    'it writes one column on a row the caller is already allowed to write',
  );

  const fn = sql.slice(sql.indexOf('function public.admin_parcels_in_flight('));
  check('admin_parcels_in_flight exists', fn.length > 0);
  check(
    'it checks is_admin()',
    /is_admin\(\)/.test(fn),
    'every driver name and route on the platform, otherwise',
  );
  check(
    'it is security definer with a pinned search_path',
    /security definer/.test(fn) && /set search_path = ''/.test(fn),
  );
  check(
    'it is revoked from anon and granted to authenticated',
    /revoke all on function public\.admin_parcels_in_flight\(integer\) from public, anon/.test(
      inFlight,
    ) && /grant execute on function public\.admin_parcels_in_flight\(integer\)/.test(inFlight),
  );

  check(
    'collected is the pickup timestamp, not the status',
    /\(b\.picked_up_at is not null\) as collected/.test(fn),
    'a stage inserted before Picked Up would silently reclassify half the board',
  );
  check(
    'delivered and cancelled parcels are off the board',
    /b\.status not in \('Delivered', 'Cancelled'\)/.test(fn),
    'it is what is in flight, not what moved',
  );
  check(
    'only parcels that have a driver are on it',
    /b\.driver_id is not null/.test(fn),
    'a parcel with no driver belongs to the Dispatch queue, which already has it',
  );
  check(
    'the totals are window counts, evaluated before the limit',
    /count\(\*\) over \(\)/.test(fn) &&
      /count\(\*\) filter \(where not f\.collected\) over \(\)/.test(fn),
    'tiles computed in the client from a capped list understate exactly when it matters',
  );
  check(
    'the uncollected sort above the moving',
    /order by f\.collected asc, f\.minutes_since_move desc/.test(fn),
    'a parcel claimed yesterday and never collected is the most urgent row on the screen',
  );
  check(
    'and nothing in the file writes to a parcel',
    !/update public\.bookings\s+set status\s*=/.test(sql),
    '10 lets only the carrying driver advance a parcel; an override here would need its own trail',
  );
}

// -------------------------------------- 13. the board, and where it lives --

{
  check(
    'the admin screen has an In transit section',
    /const SECTIONS = \['overview', 'dispatch', 'transit', 'review'\]/.test(adminScreen),
  );
  check(
    'it renders the board',
    /section === 'transit' && <ParcelsInFlight \/>/.test(adminScreen),
  );
  check(
    'the section has a title and a subtitle of its own',
    /transit: 'In Transit'/.test(adminScreen) && /collected from the sender/.test(adminScreen),
    'a fall-through arm once promised a review window on a screen that had never offered one',
  );
  check(
    'and the nav can reach it',
    /section: 'transit'/.test(read('src/components/ui/app-nav-bar.tsx')),
  );

  check(
    'the board reuses the existing parcel drawer',
    /<AdminParcelDrawer/.test(board) && /focusId=/.test(board),
    'a second drawer would mean a second copy of the audited contact reveal',
  );
  check(
    'it has no way to advance a parcel',
    !/advance_booking|advanceBooking/.test(board),
    'read-only is the design, not an omission',
  );
  check(
    'it says plainly when a parcel was claimed and never collected',
    /never collected/.test(board),
    'nothing happens when a collection does not happen — that is why it needs saying',
  );
  check(
    'a stalled parcel gets words, not just a colour',
    /Ring the driver/.test(board),
    'colour alone reads as decoration',
  );
  check(
    'and a failed read is not rendered as an empty board',
    /could not be read/.test(board),
    '"nothing in flight" on a query that never returned is the same lie as a green banner',
  );

  check('half a day is amber', stallTone(13 * 60) === 'warning');
  check('a full day is red', stallTone(25 * 60) === 'danger');
  check('an hour is neither', stallTone(60) === 'neutral');
}

// ------------------- 14. closing a delivery the driver never did (74) -----

{
  const sql = code(closing);

  check(
    'the row records who closed it',
    /add column if not exists delivery_recorded_by uuid references auth\.users/.test(sql),
    'null for a driver-recorded delivery and set for an admin one — the only thing that tells\n' +
      '       them apart six months later',
  );

  const fn = sql.slice(sql.indexOf('function public.admin_record_delivery('));
  check('admin_record_delivery exists', fn.length > 0);
  check('it checks is_admin()', /is_admin\(\)/.test(fn));
  check(
    'it is security definer with a pinned search_path',
    /security definer/.test(fn) && /set search_path = ''/.test(fn),
  );
  check(
    'it is revoked from anon',
    /revoke all on function public\.admin_record_delivery\(uuid, text, text\) from public, anon/.test(
      closing,
    ),
  );

  check(
    'a parcel that was never collected is refused',
    /row_picked is null/.test(fn) && /not been collected/.test(sql),
    'closing it would assert a collection nobody recorded',
  );
  check(
    'a delivered or cancelled parcel is refused',
    /already delivered/.test(sql) && /was cancelled/.test(sql),
    'a second close would be a second delivery email',
  );
  check(
    'a parcel with no driver is refused',
    /row_driver is null/.test(fn),
    'nobody carried it, so nobody delivered it',
  );
  check(
    'the recipient name is still required',
    /length\(clean_name\) < 2/.test(fn),
    "10's rule does not stop applying because an admin is the one typing",
  );
  check(
    'and so is an account of how they know',
    /length\(clean_reason\) < 4/.test(fn),
    'the operator did not witness it',
  );
  check(
    'the attribution is written with the delivery',
    /delivery_recorded_by = actor/.test(fn),
  );
  check(
    'and the override is logged as a warning naming the reason',
    /'warning',\s*\n\s*'delivery'/.test(fn) && /'reason', left\(clean_reason/.test(fn),
    'one of these is a flat battery; a run of them is the delivery flow failing on real phones',
  );
  check(
    'nothing suppresses the downstream effects',
    !/alter table public\.bookings disable trigger/.test(sql) && !/session_replication_role/.test(sql),
    'the sender email, the notification and the fare all fire exactly as they would for the driver',
  );

  check(
    'the drawer can ask who closed it',
    /function public\.admin_delivery_attribution\(parcel uuid\)/.test(sql) &&
      /is_admin\(\)/.test(sql.slice(sql.indexOf('function public.admin_delivery_attribution('))),
  );
}

// ------------------------------------- 15. the action, where it is offered --

{
  check(
    'only a collected parcel offers the action',
    /onRecordDelivery\?: \(\) => void;/.test(board) &&
      /moving\.map[\s\S]{0,260}onRecordDelivery=/.test(board) &&
      !/awaiting\.map[\s\S]{0,260}onRecordDelivery=/.test(board),
    'there is nothing to close on a parcel nobody has picked up',
  );
  check(
    'the consequences are named before the button',
    /email the sender/.test(board) &&
      /credit \{parcel \? formatNaira/.test(board) &&
      /you closed it, not the driver/.test(board),
    'an operator who thought they were tidying a list has just told a customer their parcel\n' +
      '       arrived and paid somebody for it',
  );
  check(
    'the button cannot fire without both fields',
    /receivedBy\.trim\(\)\.length < 2 \|\| reason\.trim\(\)\.length < 4/.test(board),
    'the server refuses it anyway; the screen should not offer it',
  );
  check(
    "the server's refusals are shown verbatim",
    /showDialog\('Could not record that delivery', outcome\.error\)/.test(board),
    'each one tells the operator what to do instead',
  );
  check(
    'and the drawer says when a delivery was closed from an office',
    /recordedByAdmin/.test(drawer) && /never recorded it/.test(drawer),
  );
  check(
    'a finished parcel is not filed under Dispatch',
    /finished \? \(detail\.status === 'Cancelled' \? 'Carrier' : 'Delivery'\) : 'Dispatch'/.test(
      drawer,
    ),
    '"Dispatch" on a delivered parcel reads as though the platform is still trying to place it',
  );
  check(
    'and its offer history goes with the heading',
    /\{!finished && \(/.test(drawer),
    'how a parcel got matched is not part of how it ended — the attempts stay in app_events',
  );
  check(
    'but who carried it survives, because that is the delivery record',
    /<SectionLabel>[\s\S]{0,200}<Row label="Driver"/.test(drawer),
  );
  check(
    'the drawer opened on one parcel has exactly one way out',
    /backLabel=\{focusId \? null : 'Back to the list'\}/.test(drawer),
    'the sheet already ends with its own Close; a second one stacked two identical buttons',
  );
  check(
    'and the detail renders its back control only when it has somewhere to go',
    (drawer.match(/\{!!backLabel && <Button label=\{backLabel\}/g) ?? []).length === 2,
    'both the missing-parcel branch and the normal one',
  );
}

// ------------------------------------ 16. the clock decides the order (75) --

{
  const sql = code(priority);

  check(
    'the waiting list keeps its signature and all twenty columns',
    /create or replace function public\.admin_waiting_drivers\(max_rows integer default 50\)/.test(
      sql,
    ) &&
      ['departs_after', 'departs_before', 'departure_time', 'leaves_in_minutes', 'matching_parcels']
        .every((column) => sql.includes(column)),
    'create or replace swaps the whole function — a column left out of 75 is a column deleted',
  );

  /*
   * ⚠ The assertion that matters: the admin lists and the matcher sort on the
   *   same expression. If they ever disagree, a human working the queue by hand
   *   silently undoes the priority dispatch applies automatically.
   */
  const expression = 'coalesce(j.departure_time, j.departs_before) asc';
  check(
    'the waiting list sorts on the departure',
    sql.includes(expression),
    'without it the order is `created_at` — when the shift was declared, not when it leaves',
  );
  check(
    'and it is the same expression the matcher has used since 26',
    code(matcher).includes('coalesce(journey_departure, journey_departs_before)') &&
      code(dispatchMode).includes(expression),
    'two definitions of "leaving soonest" is how the screen and the automation drift apart',
  );

  check(
    'the matching count is reduced to a boolean ahead of it',
    /order by\s*\(\s*exists \(/.test(sql) && !/\)\s*desc,\s*\n\s*j\.created_at asc\s*\n\s*limit/.test(sql),
    'a count as the leading key put nine parcels leaving tomorrow above one leaving in ten minutes',
  );

  check(
    'the candidate list is dropped before it is recreated',
    /drop function if exists public\.assignable_drivers\(uuid\);/.test(sql) &&
      /create function public\.assignable_drivers\(parcel uuid\)/.test(sql),
    'create or replace cannot change a function’s output columns',
  );
  check(
    'and it returns the departure it now sorts on',
    /next_departure timestamptz/.test(sql) && /journey_mode text/.test(sql),
  );
  check(
    'the candidate sort puts departure above the parcel count',
    sql.indexOf('c.next_departure asc nulls last') > sql.indexOf('c.route_matches desc') &&
      sql.indexOf('c.next_departure asc nulls last') < sql.indexOf('c.active_parcels asc'),
    'a driver leaving within the hour beats one carrying one fewer parcel and leaving tomorrow',
  );
  check(
    'nulls sort last rather than first',
    /nulls last/.test(sql),
    'plain asc puts every driver with no live journey at the top of the list',
  );

  check(
    'the drivers the function deliberately still returns survived the recreate',
    /No journey declared/.test(sql) &&
      /Blocked — a required document has expired/.test(sql) &&
      /Online, but not going this way/.test(sql) &&
      /Matches this route/.test(sql),
    'an operator is on that screen because they know something the matcher does not',
  );

  check(
    'both halves are probed by reading the live bodies',
    /pg_get_functiondef/.test(sql) && /departure_priority_live/.test(sql),
    'both functions existed before 75 — their presence proves nothing about what they sort on',
  );
}

// ------------------------------------------ 17. saying it on screen (75) --

{
  const now = new Date('2026-10-06T09:00:00.000Z');

  check(
    'a scheduled departure reads as a departure',
    departureLine(
      { mode: 'scheduled', departureTime: '2026-10-06T13:35:00.000Z', departsBefore: null },
      now,
    ) === 'Leaves Today, 14:35 WAT',
    String(
      departureLine(
        { mode: 'scheduled', departureTime: '2026-10-06T13:35:00.000Z', departsBefore: null },
        now,
      ),
    ),
  );
  check(
    'tomorrow is named rather than dated',
    departureLine(
      { mode: 'scheduled', departureTime: '2026-10-07T05:00:00.000Z', departsBefore: null },
      now,
    ) === 'Leaves Tomorrow, 06:00 WAT',
  );
  check(
    'and anything further off carries its date',
    departureLine(
      { mode: 'scheduled', departureTime: '2026-10-12T05:00:00.000Z', departsBefore: null },
      now,
    ) === 'Leaves 12 Oct, 06:00 WAT',
  );

  /*
   * ⚠ A flash shift's `departs_before` is when their availability lapses, not
   *   when they set off — `declare_journey` sets it to now() + hours. Wording
   *   it as a departure tells an operator a driver is leaving for somewhere
   *   when they are going off shift.
   */
  check(
    'a flash shift says when it ends, not when it leaves',
    departureLine({ mode: 'flash', departsBefore: '2026-10-06T17:00:00.000Z' }, now) ===
      'On shift until Today, 18:00 WAT',
    String(departureLine({ mode: 'flash', departsBefore: '2026-10-06T17:00:00.000Z' }, now)),
  );
  check(
    'a journey declared before 26 does not claim a precision it has not got',
    departureLine(
      { mode: 'scheduled', departureTime: null, departsBefore: '2026-10-06T17:00:00.000Z' },
      now,
    ) === 'Leaves by Today, 18:00 WAT',
  );
  check(
    'and nothing to say renders nothing',
    departureLine({ mode: 'scheduled', departureTime: null, departsBefore: null }, now) === null &&
      candidateDepartureLine({ nextDeparture: null, journeyMode: null }, now) === null,
    'a caller skips the row rather than drawing an empty one',
  );
  check(
    'a candidate row reads the one timestamp it is given',
    candidateDepartureLine(
      { nextDeparture: '2026-10-06T13:35:00.000Z', journeyMode: 'scheduled' },
      now,
    ) === 'Leaves Today, 14:35 WAT' &&
      candidateDepartureLine(
        { nextDeparture: '2026-10-06T17:00:00.000Z', journeyMode: 'flash' },
        now,
      ) === 'On shift until Today, 18:00 WAT',
  );

  /* The year is dropped here and nowhere else — see `formatSoon`. */
  check(
    'the relative stamp is in Lagos time and drops the year',
    formatSoon('2026-10-06T23:30:00.000Z', now) === 'Tomorrow, 00:30 WAT',
    'the day has to move across midnight, or the word is wrong for an hour every night',
  );
  check(
    'and an unusable value formats as nothing',
    formatSoon(null) === '' && formatSoon('not a date') === '',
  );

  check(
    'the waiting row shows the time beside the countdown, not instead of it',
    /departureLine\(driver\)/.test(panel) && /Leaves in \$\{waitLabel/.test(panel),
    'the countdown decides who gets the parcel; the clock time is what gets read out on the phone',
  );
  check(
    'the sheet repeats it, because the row it covers is the one being decided',
    (panel.match(/departureLine\(driver\)/g) ?? []).length >= 3,
  );
  check(
    'the store maps both new columns off the candidate row',
    /next_departure/.test(store) && /journey_mode/.test(store),
  );
  check(
    'and the assign-a-driver sheet says it too',
    /candidateDepartureLine\(candidate\)/.test(control),
    'that list is the one that used to sort by name',
  );
}

// -------------------------- 18. the notification spine, applied for real --

{
  /*
   * ⚠ Production carried a migration-history row for 50 while none of that
   *   file's thirteen objects were in the database. A delivery produced the
   *   sender's email and no in-app notification at all, for weeks, silently.
   *   76 is the convergence point; these checks are what keep it one.
   */
  const marker = '-- ------------------------------------------------------------- hardening ----';
  const carried = triggers.slice(triggers.indexOf(marker));

  check('50 still has the marker 76 was generated from', triggers.includes(marker));
  check(
    '76 carries 50’s body byte for byte',
    carried.length > 1000 && spine.includes(carried),
    'the two files cannot be allowed to drift: 76 is what runs on a database that already claims 50',
  );

  check(
    'and it is the sender’s delivery notification that the repair is about',
    /notify_on_booking_status/.test(spine) &&
      /on_booking_status_notify/.test(spine) &&
      /after update of status on public\.bookings/.test(spine),
  );

  {
    /* Counted on the code, not the prose — the header above it quotes both. */
    const statements = code(spine);
    check(
      'every statement in it is re-runnable',
      !/\ncreate function /.test(statements) &&
        (statements.match(/drop trigger if exists/g) ?? []).length === 8 &&
        (statements.match(/drop trigger if exists/g) ?? []).length ===
          (statements.match(/\ncreate trigger /g) ?? []).length,
      'this file will be applied to databases that already have some of it',
    );
  }

  /*
   * ⚠ The probe asserts the triggers, not the functions. A function nothing is
   *   wired to is the precise shape of the failure being probed for, and a
   *   `to_regprocedure` check would have gone green on it.
   */
  check(
    'the probe asks whether a delivery actually reaches the inbox',
    /notification_spine_live/.test(spine) &&
      /from pg_trigger/.test(spine) &&
      /tgname = 'on_booking_status_notify'/.test(spine) &&
      /tgname = 'notifications_dispatch_push'/.test(spine),
    'the functions existed on staging and the triggers did not — that is the bug',
  );
  check(
    'it does not settle for the functions being present',
    !/to_regprocedure\('public\.notify_on_booking_status/.test(spine),
  );

  check(
    'the email path is untouched',
    !/email_on_booking_status/.test(code(spine)),
    'the delivery email has always been immediate — dispatch_email POSTs it on insert (53)',
  );

  check(
    'both new migrations are on the deployment panel',
    /20250101000075_departure_priority\.sql/.test(gaps) &&
      /20250101000076_notification_spine_repair\.sql/.test(gaps),
    'a missing migration whose only symptom is a wrong sort order, or a silent inbox',
  );
}

// ------------------------- 19. an older migration cannot win quietly (79) --

/*
 * ⚠ Three production defects, one cause: an early range of migrations was
 *   replayed over a database that already had the later ones, and `create or
 *   replace function` went backwards without complaining. Hand assignment
 *   raised `column reference "driver" is ambiguous`, every email waited five
 *   minutes for the sweep instead of going out on the trigger, and a driver
 *   could not decline the same parcel twice — all on a migration history that
 *   looked perfect.
 *
 * The checks below are about the manifest in 79, and they are the reason it can
 * be trusted: one proves it covers everything the chain puts at risk, the other
 * proves every marker in it actually discriminates.
 */
{
  /** Every migration file, newest last. */
  const migrations = readdirSync(join(ROOT, 'supabase/migrations'))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
    .map((name) => ({ version: name.slice(0, 14), sql: read(`supabase/migrations/${name}`) }));

  /**
   * Every `create [or replace] function` in one file, as (name, body).
   *
   * The body runs to the closing dollar-quote, found from the opening tag
   * rather than assumed to be `$$` — 53 and others use `$fn$`.
   */
  const definitions = (sql: string): { name: string; body: string }[] => {
    const found: { name: string; body: string }[] = [];
    const head = /create\s+(?:or replace\s+)?function\s+((?:public|private)\.\w+)\s*\(/gi;

    for (let m = head.exec(sql); m !== null; m = head.exec(sql)) {
      const tag = /as\s+(\$\w*\$)/i.exec(sql.slice(m.index, m.index + 4000));
      if (!tag) continue;
      const opens = m.index + tag.index + tag[0].length;
      const closes = sql.indexOf(tag[1], opens);
      if (closes === -1) continue;
      found.push({ name: m[1], body: sql.slice(m.index, closes + tag[1].length) });
    }

    return found;
  };

  /** Comments out, whitespace flattened — two definitions differ or they do not. */
  const normalise = (body: string) =>
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*--.*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim();

  const history = new Map<string, { version: string; body: string }[]>();
  for (const migration of migrations) {
    for (const found of definitions(migration.sql)) {
      const seen = history.get(found.name) ?? [];
      seen.push({ version: migration.version, body: normalise(found.body) });
      history.set(found.name, seen);
    }
  }

  /*
   * At risk = defined in more than one migration, with at least one of the
   * older definitions textually different from the newest. 76 re-applying 50's
   * own functions verbatim is not at risk: replaying 50 over it changes nothing.
   */
  const atRisk = [...history.entries()].filter(([, seen]) => {
    const newest = seen[seen.length - 1].body;
    return seen.slice(0, -1).some((earlier) => earlier.body !== newest);
  });

  check(
    'the chain still has objects that an older migration could overwrite',
    atRisk.length > 30,
    `found ${atRisk.length} — if this collapsed, the parser above stopped matching`,
  );

  /*
   * The manifest, read from whichever migration defines `stale_definitions`
   * last — 79 wrote it, 80 extended it, and the next file to replace a function
   * will extend it again. Pinning this to 79 would check an obsolete copy and
   * pass while the live one went stale, which is the failure in miniature.
   *
   * Row shape: ('object', 'owner', 'fn', 'schema', 'name', 'marker')
   */
  const manifestSource =
    migrations
      .filter((migration) =>
        /create\s+or replace\s+function\s+public\.stale_definitions\s*\(/i.test(migration.sql),
      )
      .map((migration) => migration.sql)
      .pop() ?? '';

  check(
    'some migration defines the manifest',
    manifestSource.length > 0,
    '79 creates `stale_definitions`; a later file may replace it',
  );

  const manifest = new Map<string, string>();
  const row =
    /\(\s*'([^']*(?:''[^']*)*)'\s*,\s*'(\d+)'\s*,\s*'fn'\s*,\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*'([^']*(?:''[^']*)*)'\s*\)/g;
  for (let m = row.exec(manifestSource); m !== null; m = row.exec(manifestSource)) {
    manifest.set(`${m[3]}.${m[4]}`, m[5].replace(/''/g, "'"));
  }

  check('the manifest parses', manifest.size >= 39, `parsed ${manifest.size} function rows out of the newest manifest`);

  /*
   * ⚠ This is the check that stops the manifest becoming a snapshot of October
   *   2026. A future migration that replaces an old function has to be listed,
   *   or the build goes red — which is the only way a drift probe stays honest
   *   as the chain grows.
   */
  const unlisted = atRisk.map(([name]) => name).filter((name) => !manifest.has(name));
  check(
    'every object the chain puts at risk is in the manifest',
    unlisted.length === 0,
    unlisted.length === 0
      ? ''
      : `missing from the manifest: ${unlisted.join(', ')}\n` +
        '       a migration replaced one of these — add it with a marker only its newest\n' +
        '       definition contains, or `definitions_current` goes green on a stale database',
  );

  /*
   * ⚠ And this is the check that stops a marker lying.
   *
   *   A marker that also appears in an older definition reports a reverted
   *   function as current; one that appears in no definition at all reports a
   *   healthy function as stale. Both are worse than having no probe. An early
   *   draft of 79 used a function's own name as its marker, which
   *   `pg_get_functiondef` always contains — it would have gone green on
   *   anything. This check is what caught it.
   */
  const wrong: string[] = [];
  for (const [name, seen] of history) {
    const marker = manifest.get(name);
    if (!marker) continue;

    const newest = seen[seen.length - 1].body;
    if (!newest.includes(marker)) {
      wrong.push(`${name}: marker "${marker}" is not in its newest definition`);
      continue;
    }

    const leaked = seen
      .slice(0, -1)
      .filter((earlier) => earlier.body !== newest && earlier.body.includes(marker));
    if (leaked.length > 0) {
      wrong.push(
        `${name}: marker "${marker}" is also in ${leaked.map((e) => e.version.slice(-3)).join(', ')}`,
      );
    }
  }
  check(
    'every marker is in the newest definition and in none of the older ones',
    wrong.length === 0,
    wrong.join('\n       '),
  );

  /* The repair half: the seven bodies are their owning migrations', verbatim. */
  const carried: [string, string, string][] = [
    ['admin_assign_parcel', '20250101000069_assign_parcel_repair.sql', 'public.admin_assign_parcel'],
    ['dispatch_email', '20250101000053_email_dispatch_repair.sql', 'public.dispatch_email'],
    [
      'email_on_booking_status',
      '20250101000064_status_email_driver_name.sql',
      'public.email_on_booking_status',
    ],
    [
      'record_identity_result',
      '20250101000041_sender_identity_review.sql',
      'public.record_identity_result',
    ],
    [
      'begin_identity_check',
      '20250101000041_sender_identity_review.sql',
      'public.begin_identity_check',
    ],
    ['handle_new_user', '20250101000045_google_identities.sql', 'public.handle_new_user'],
    [
      'pg_net_calls_are_resolvable',
      '20250101000068_pg_net_probe_self_match.sql',
      'public.pg_net_calls_are_resolvable',
    ],
  ];

  for (const [label, file, name] of carried) {
    const source = definitions(read(`supabase/migrations/${file}`)).find((d) => d.name === name);
    const repaired = definitions(drift).find((d) => d.name === name);
    check(
      `79 carries ${label} exactly as ${file.slice(11, 14)} wrote it`,
      !!source && !!repaired && source.body === repaired.body,
      'generated from that file rather than retyped — a hand copy is how the two drift apart',
    );
  }

  check(
    'the trigger that makes the email immediate comes with it',
    /drop trigger if exists on_email_queued on public\.email_outbox;/.test(drift) &&
      /after insert on public\.email_outbox/.test(drift),
    '53 is the file that moved the POST off app.settings.* and onto private.app_settings',
  );

  check(
    'the drift probe is on the deployment panel',
    /20250101000079_definition_drift_repair\.sql/.test(gaps) && /definitions_current/.test(gaps),
    'a history row is not evidence that a migration ran — this is the line that says so',
  );
}

// -------------------------------- 20. handing a parcel back (80) ----------

/*
 * ⚠ The driver's Release button has never worked, on any environment.
 *
 *   `cancel_booking` (11) clears `driver_id` to put the parcel back on the
 *   board; `bookings_guard_immutable` (01) refuses any change to `driver_id`
 *   once it is set. 01 predates 11 and nothing revisited it, so pressing
 *   Release produced "a claimed job cannot be reassigned (P0001)" from the day
 *   the button shipped. The same guard was aborting the erasure of anybody who
 *   had ever carried a parcel, because `driver_id` is `on delete set null` and
 *   a referential action fires row triggers.
 */
{
  const release = read('supabase/migrations/20250101000080_parcel_release.sql');
  const flight = read('src/components/ui/parcels-in-flight.tsx');
  const driverScreen = read('src/app/(tabs)/driver.tsx');
  const signedOut = read('src/components/ui/signed-out-state.tsx');
  const sql = code(release);

  check(
    'the guard lets a parcel lose its driver',
    /old\.driver_id is not null\s*and new\.driver_id is not null\s*and new\.driver_id is distinct from old\.driver_id/.test(
      sql,
    ),
    'without the middle condition, a release and an account erasure both raise P0001',
  );
  check(
    'and still refuses one driver becoming another',
    /handed to another driver/.test(sql),
    'that is what 01 wrote the guard for, and it is not being given up',
  );
  check(
    'the trigger is recreated, not just the function',
    /drop trigger if exists bookings_guard_immutable on public\.bookings;/.test(sql) &&
      /before update on public\.bookings/.test(sql),
    'a replaced function with no trigger is the failure 76 was written about',
  );

  check(
    'a release is recorded against the pair',
    /create table if not exists public\.parcel_releases/.test(sql) &&
      /primary key \(booking_id, driver_id\)/.test(sql),
    'keyed on the pair, so releasing the same parcel twice is one row',
  );
  check(
    'and nobody can write it by hand',
    /alter table public\.parcel_releases enable row level security/.test(sql) &&
      !/create policy[^;]*on public\.parcel_releases for (insert|update|delete)/.test(sql),
    'the only writers are the two security definer functions',
  );

  /*
   * ⚠ A release is not a decline, and this is the assertion that keeps them
   *   apart. 23 made a decline a cooldown and 78 removed the index still
   *   enforcing the old permanent rule; nothing here may quietly put that back.
   */
  check(
    'the matcher stops offering a parcel to the driver who gave it back',
    /not exists \(\s*select 1 from public\.parcel_releases r\s*where r\.booking_id = dispatch_booking\.booking_id\s*and r\.driver_id = j\.driver_id\s*\)/.test(
      sql,
    ),
    'no window on it — a release is a stronger answer than a declined offer',
  );
  check(
    'and the decline cooldown is untouched',
    /o\.status in \('declined', 'expired'\)/.test(sql) && /now\(\) - cooldown/.test(sql),
    '23 and 78 both exist because a permanent per-pair block was the wrong rule',
  );
  check(
    'the release is written before the parcel is let go',
    sql.indexOf('insert into public.parcel_releases') <
      sql.indexOf("set status = 'Booked',"),
    'redispatch is a cron sweep, so the other order leaves a window to hand it straight back',
  );

  check(
    'an admin can take a parcel off a driver',
    /create or replace function public\.admin_release_parcel\(/.test(sql) &&
      /if not public\.is_admin\(\) then/.test(sql),
  );
  check(
    'and must say why',
    /Say why this parcel is being taken off the driver/.test(sql),
    'the driver is told nothing by the status change, so this string is the only record',
  );
  check(
    'it stops at collection, naming the right tool instead',
    /the driver already has it\. Reassigning stops at collection/.test(sql),
    'a parcel in somebody’s bag cannot be put back on the open board',
  );
  check(
    'and it is logged as an override rather than a routine action',
    /'warning', 'dispatch', 'admin took a parcel off a driver'/.test(sql),
  );

  check(
    'the candidate list says so rather than hiding them',
    /Released this parcel — not offered it again/.test(sql) &&
      sql.indexOf('c.released_it then') < sql.indexOf('c.route_matches then'),
    'an operator is the one who knows the driver rang back; the note outranks the route',
  );

  check(
    'the probe asks whether a release would actually work',
    /release_controls_installed/.test(sql) &&
      /like '%handed to another driver%'/.test(sql),
    'the table and the function can both exist on a database whose guard is still 01’s',
  );

  /* ---------------------------------------------------- and on the screen */

  check(
    'the web driver card has the release control at last',
    /<CancelAction booking=\{booking\} \/>/.test(driverScreen),
    'driver-hub has had it since it shipped; the browser screen never did',
  );
  check(
    'the admin board offers it only before collection',
    /onRelease=\{\(\) => setReleasing\(parcel\)\}/.test(flight) &&
      /awaiting\.map[\s\S]{0,280}onRelease=/.test(flight) &&
      !/moving\.map[\s\S]{0,280}onRelease=/.test(flight),
  );
  check(
    'and names the consequence that is not obvious',
    /stop the matcher offering this parcel to/.test(flight),
    'an operator expecting a retry reads the unassigned parcel as dispatch being broken',
  );
  check(
    'the reason is required before the button works',
    /disabled=\{busy \|\| reason\.trim\(\)\.length < 4\}/.test(flight),
    'the server refuses it anyway; the screen should not offer it',
  );

  /* ----------------------------------------- and the sign-in page flash --- */

  /*
   * ⚠ `status` passes through 'loading' on every launch, and during it
   *   `isAuthenticated` is false. Nine screens branched on `isAuthenticated`
   *   alone, so on the web — where restoring means reading storage and then
   *   refreshing the token over the network — every reload painted the sign-in
   *   card before the real page replaced it. A signed-in person does not read
   *   that as a loading state.
   */
  check(
    'the sign-in card refuses to render while the session is still restoring',
    /useSession/.test(signedOut) && /status === 'loading'/.test(signedOut),
    'put in the component, not the nine callers, so a screen added next year cannot reintroduce it',
  );
  check(
    'and it holds the space rather than collapsing it',
    /<ActivityIndicator color=\{theme\.primary\} \/>/.test(signedOut),
    'a card that appears from nothing moves the page under the reader',
  );
}

// ------------------ 21. nothing is refused before it is known (session) ----

/*
 * ⚠ The same bug three times, on three different flags, and this section is
 *   the rule that ends it.
 *
 *     status === 'loading'   the sign-in card flashed on every web reload
 *     isAdmin                "This area isn't available on your account"
 *                            flashed at an administrator on every admin reload
 *     isApprovedDriver       the wallet and the journey planner told an
 *                            approved driver they were not approved
 *
 *   Every one is a screen rendering a *refusal* from a flag that has an
 *   "unknown" phase and defaults to false during it. `status` leaves 'loading'
 *   when the stored session is restored; `isAdmin` and `isApprovedDriver`
 *   arrive on a second round trip after that. `permissionsKnown` is the one
 *   flag that means "both answers are in", and the checks below require every
 *   refusal in the app to wait for it.
 */
{
  const sessionStore = read('src/store/session.tsx');
  const experience = read('src/lib/experience.ts');
  const useExperienceHook = read('src/hooks/use-experience.ts');
  const shell = read('src/components/ui/admin-shell.tsx');
  const signedOut = read('src/components/ui/signed-out-state.tsx');
  const adminScreen2 = read('src/app/(tabs)/admin.tsx');

  /** The two modules allowed to render a refusal, because they do the waiting. */
  const GATES = ['src/components/ui/admin-shell.tsx', 'src/components/ui/signed-out-state.tsx'];

  check(
    'the session says when it knows what somebody may see',
    /permissionsKnown: boolean;/.test(sessionStore) &&
      /permissionsKnown: status !== 'loading' && \(!user \|\| driverStatusLoaded\)/.test(
        sessionStore,
      ),
    'signed out is known at once; signed in waits for the admin and driver lookups',
  );
  check(
    'and the lookup flag is in the memo it is read from',
    /driverStatusLoaded,\n\s*isAdmin,\n\s*refreshDriverStatus,/.test(code(sessionStore)),
    'omitted, the context does not change identity when the answer lands',
  );

  /*
   * ⚠ The routing rule has the same hole and it is easy to miss, because it
   *   already guarded against the *first* version of this bug.
   */
  check(
    'the experience router waits for the same flag',
    /accessLoading: !permissionsKnown/.test(useExperienceHook) &&
      /accessLoading: boolean;/.test(experience),
    'keyed on the session alone, an approved driver on a phone resolved to the sender\n' +
      '       app for a moment and then flicked to the driver one',
  );

  check(
    'both gates wait on it',
    /permissionsKnown/.test(shell) && /permissionsKnown/.test(signedOut),
  );
  check(
    'and render a spinner rather than the refusal while they do',
    /if \(!permissionsKnown\) \{[\s\S]{0,400}ActivityIndicator/.test(shell) &&
      /if \(!permissionsKnown\) \{[\s\S]{0,400}ActivityIndicator/.test(signedOut),
  );

  /* There is one of the refusal card, not two. */
  const deniedCopy = listSourceFiles('src').filter((path) =>
    code(read(path)).includes("This area isn't available on your account"),
  );
  check(
    'the not-available card exists in exactly one module',
    deniedCopy.length === 1 && deniedCopy[0] === 'src/components/ui/admin-shell.tsx',
    `found in: ${deniedCopy.join(', ')} — the admin screen used to carry a second copy,\n` +
      '       with its own copy of the missing readiness check',
  );
  check(
    'and the admin dashboard reaches it through the shared gate',
    /const gate = useAdminGate\(\);/.test(adminScreen2) &&
      /gate === 'loading'/.test(adminScreen2) &&
      /<AdminDenied \/>/.test(adminScreen2),
  );

  /*
   * ⚠ The sweep. This is the part that has to keep working on a screen written
   *   next year by somebody who has never read any of the above.
   *
   *   A render branch is `if (!flag) { … return ( …` — a refusal the reader
   *   sees. Two things are deliberately not matched:
   *
   *     `if (!isApprovedDriver) return;`   inside a callback. It claims nothing
   *                                        to anybody, so it needs no waiting.
   *     a `}` before the `return (`        the branch has closed and the
   *                                        `return (` belongs to the component,
   *                                        not to the refusal. `[^}]` is what
   *                                        enforces that, and without it this
   *                                        sweep reports every admin screen
   *                                        whose effect guards on `isAdmin`.
   */
  const REFUSING_FLAGS = ['isAdmin', 'isApprovedDriver'];

  /** `if (!flag) {` … `return (`, with no closing brace in between. */
  const refusalBranch = (flag: string) => new RegExp(`if \\(!${flag}\\)\\s*\\{[^}]{0,400}?return \\(`);

  /*
   * ⚠ The sweep checks itself first.
   *
   *   A regex that matches nothing passes silently and for ever. These two
   *   strings are the shape the bug had and the shape the effect guards have;
   *   if a later edit makes the pattern stop telling them apart, this fails
   *   before the sweep gets a chance to be uselessly green.
   */
  check(
    'the sweep still recognises a refusal branch',
    refusalBranch('isAdmin').test('if (!isAdmin) { return ( <Denied /> ); }'),
    'the pattern below has stopped matching the bug it is for',
  );
  check(
    'and still ignores an effect guard',
    !refusalBranch('isAdmin').test(
      'if (!isAdmin) { setLoading(false); return; } void load(); }, [isAdmin]); return (',
    ),
    'every admin screen guards its loader this way; matching those is just noise',
  );

  const unguarded: string[] = [];

  for (const path of listSourceFiles('src')) {
    if (GATES.includes(path)) continue;
    const source = code(read(path));

    for (const flag of REFUSING_FLAGS) {
      if (!refusalBranch(flag).test(source)) continue;
      if (/permissionsKnown/.test(source) || /useAdminGate\(\)/.test(source)) continue;
      unguarded.push(`${path} (!${flag})`);
    }
  }

  check(
    'no screen renders a refusal from a flag that is still unknown',
    unguarded.length === 0,
    unguarded.length === 0
      ? ''
      : `${unguarded.join(', ')}\n` +
        '       `isAdmin` and `isApprovedDriver` are false until a second round trip lands, so\n' +
        '       this renders "you cannot see this" at somebody who can. Wait for\n' +
        '       `permissionsKnown` from useSession, or use `useAdminGate`.',
  );

  /*
   * And the authentication half: a screen may branch on `isAuthenticated`
   * freely, provided what it renders is the card that does its own waiting.
   */
  const wrongRefusal: string[] = [];
  for (const path of listSourceFiles('src')) {
    if (GATES.includes(path)) continue;
    const source = code(read(path));
    /* Same shape, same reason for `[^}]`: stop at the end of the branch. */
    const branch = /if \(!isAuthenticated[^)]*\)\s*\{([^}]{0,600}?return \([\s\S]{0,400})/g;

    for (let m = branch.exec(source); m !== null; m = branch.exec(source)) {
      if (/SignedOutState/.test(m[1])) continue;
      if (/permissionsKnown|useAdminGate\(\)/.test(source)) continue;
      wrongRefusal.push(path);
    }
  }
  check(
    'and a signed-out screen renders the card that waits, not its own',
    wrongRefusal.length === 0,
    `${wrongRefusal.join(', ')} — SignedOutState holds the readiness check; a hand-rolled\n` +
      '       sign-in panel would not',
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('the availability panel holds.\n');
