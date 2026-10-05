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

import { stallTone } from '../src/store/admin';
import {
  attemptsLabel,
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

const repair = read('supabase/migrations/20250101000069_assign_parcel_repair.sql');
const counts = read('supabase/migrations/20250101000071_offer_attempt_counts.sql');
const inFlight = read('supabase/migrations/20250101000073_parcels_in_flight.sql');
const closing = read('supabase/migrations/20250101000074_admin_record_delivery.sql');
const board = read('src/components/ui/parcels-in-flight.tsx');
const adminScreen = read('src/app/(tabs)/admin.tsx');
const drawer = read('src/components/ui/admin-parcel-drawer.tsx');
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('the availability panel holds.\n');
