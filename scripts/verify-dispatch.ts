/**
 * Assertions for automated dispatch.
 *
 * The failure modes worth guarding are the ones that lose a parcel rather than
 * the ones that throw:
 *
 *   - Two drivers told the same parcel is theirs.
 *   - A parcel held by an offer nobody will ever answer.
 *   - A declined offer rotating straight back to the driver who declined it.
 *   - A driver able to offer themselves any parcel in the country.
 *
 * None of those produces an error. Each produces an app that looks like it is
 * working while parcels quietly stop moving.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  combineDeparture,
  dayOptions,
  dayValueOf,
  departureLabel,
  MAX_DEPARTURE_DAYS,
  MINUTE_STEP,
  minutesOf,
  nextDepartureSlot,
  timeOptions,
} from '../src/lib/departure';
import {
  activeFlashShift,
  OFFER_COOLDOWN_MINUTES,
  OFFER_HOLD_MINUTES,
  offerHoldMinutes,
  offerIsUrgent,
  matchStatus,
  matchStatusLabel,
  modeAction,
  scheduledJourneys,
  secondsLeft,
  validateJourney,
  type DispatchOffer,
  type Journey,
} from '../src/store/dispatch';
import { complianceState } from '../src/components/ui/driver-summary-card';
import type { DriverApplication } from '../src/store/driver-applications';

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
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');

const flat = (source: string) => source.replace(/\s+/g, ' ');

const sql = read('supabase/migrations/20250101000015_dispatch.sql');
const sqlCode = code(sql);
const store = read('src/store/dispatch.ts');
const planner = read('src/components/ui/journey-planner.tsx');

// ------------------------------------------------------- no double-booking --

check(
  'at most one live offer per parcel, enforced by a unique index',
  flat(sqlCode).includes(
    'create unique index if not exists dispatch_offers_one_live_per_booking',
  ) && flat(sqlCode).includes("where status = 'offered'"),
  'two matching runs racing would otherwise offer the same parcel to two drivers, and both would think it theirs',
);

/*
 * This assertion changed shape in `20250101000020_dispatch_repair.sql`.
 *
 * It used to require that a parcel never returned to the same driver at all.
 * That conflated two different things: a decline, which is an answer, and an
 * expiry, which — with no push notification — means they never saw it. The
 * strict rule retired a parcel permanently after one missed offer, which in a
 * one-driver city is the first offer.
 */
check(
  'the original blanket rule is present in 20250101000015_dispatch.sql',
  flat(sqlCode).includes('create unique index if not exists dispatch_offers_once_per_driver'),
  'kept as history — 20250101000020_dispatch_repair.sql drops it and replaces it with a decline-only index',
);
check(
  'and the matcher excludes them explicitly too',
  flat(sqlCode).includes(
    'and not exists ( select 1 from public.dispatch_offers o where o.booking_id',
  ),
  'the index refuses the insert; this stops the matcher choosing a journey it cannot use',
);

check(
  'accepting re-checks the parcel is still unclaimed',
  flat(sqlCode).includes("and b.driver_id is null and b.status = 'Booked'"),
  'without it, accepting a stale offer overwrites a claim someone made from the board',
);
check(
  'and a lost race settles the offer instead of throwing it away',
  flat(sqlCode).includes('if not found then') &&
    flat(sqlCode).includes('That parcel has already been taken.'),
);

// -------------------------------------------------- nothing gets stranded --

check(
  'there is a sweeper for offers nobody answered',
  flat(sqlCode).includes('create or replace function public.expire_dispatch_offers()'),
  'an ignored offer holds a parcel until someone opens the app — the one failure that strands it silently',
);
check(
  'the sweeper re-dispatches what it expires',
  flat(sqlCode).includes('perform public.dispatch_booking(expired_booking)'),
  'expiring without re-offering leaves the parcel unclaimed and invisible to dispatch',
);
check(
  'and a driver opening a lapsed offer moves it on immediately',
  flat(sqlCode).includes('perform public.dispatch_booking(offer.booking_id); raise exception') ||
    flat(sqlCode).includes(
      "perform public.dispatch_booking(offer.booking_id); raise exception 'That offer expired",
    ),
  'that tap is the earliest anyone knows it lapsed',
);
check(
  'declining re-dispatches too',
  (flat(sqlCode).match(/perform public\.dispatch_booking\(offer\.booking_id\)/g) ?? []).length >= 2,
  'a declined parcel that waits for the sweeper loses five minutes for no reason',
);

check(
  'a parcel that matches nothing stays on the open board',
  flat(sqlCode).includes('if chosen.id is null then return null;'),
  'dispatch is additive — no match must not mean no parcel',
);

// ------------------------------------------------------------- authority --

check(
  'drivers cannot run the matcher',
  flat(sqlCode).includes(
    'revoke all on function public.dispatch_booking(uuid) from public, anon, authenticated',
  ),
  'a driver who could call it would hammer it until a parcel rotated to them',
);
check(
  'nor the sweeper',
  flat(sqlCode).includes(
    'revoke all on function public.expire_dispatch_offers() from public, anon, authenticated',
  ),
);
check(
  'but they can answer their own offers',
  flat(sqlCode).includes(
    'grant execute on function public.respond_to_offer(uuid, boolean) to authenticated',
  ),
);
check('and only their own', flat(sqlCode).includes('if offer.driver_id <> actor then'));

check(
  'there is no client write path to the offers table',
  !/create policy[^;]*for (insert|update|delete)[^;]*dispatch_offers/is.test(sqlCode),
  'a driver who could write this table could offer themselves anything',
);
check(
  'only an approved driver can declare a journey',
  flat(sqlCode).includes(
    'with check (driver_id = (select auth.uid()) and public.is_approved_driver())',
  ),
  'is_approved_driver already excludes banned and erased accounts',
);
check(
  'approval is re-checked at the moment of accepting',
  flat(sqlCode).includes('if not public.is_approved_driver() then'),
  'a driver can be banned between declaring a journey and answering an offer',
);

check(
  'dispatch runs from a trigger, not from the client',
  flat(sqlCode).includes('create trigger bookings_dispatch_on_insert'),
  'a client that simply never called it would leave parcels looking normal but never dispatched',
);

// ---------------------------------------------------------- the matching --

check(
  'a match needs the same route and enough capacity',
  flat(sqlCode).includes(
    'journey_origin = parcel_origin and journey_destination = parcel_destination',
  ) && flat(sqlCode).includes('journey_capacity >= coalesce(parcel_weight, 0)'),
);
check(
  'a journey that has already departed matches nothing',
  flat(sqlCode).includes('journey_departs_before > now()'),
);
check(
  'ties break on the oldest declaration',
  flat(sqlCode).includes('order by j.departs_after asc,') &&
    flat(sqlCode).includes('j.created_at asc'),
  'arbitrary ordering means a driver cannot tell why they are not getting work',
);

// ------------------------------------------------------ the client's copy --

const future = (hours: number) => new Date(Date.now() + hours * 3600_000);
const base = {
  originCity: 'Ibadan' as const,
  destinationCity: 'Lagos' as const,
  departureAt: future(4),
  capacityKg: 40,
  vehicleType: 'Motorcycle',
};

check('a sane journey validates', Object.keys(validateJourney(base)).length === 0);
check(
  'the same city at both ends is refused',
  validateJourney({ ...base, destinationCity: 'Ibadan' }).destinationCity !== undefined,
);
check(
  'zero capacity is refused',
  validateJourney({ ...base, capacityKg: 0 }).capacityKg !== undefined,
);
check(
  'an absurd capacity is refused',
  validateJourney({ ...base, capacityKg: 5000 }).capacityKg !== undefined,
  'a driver who means 50 and types 500 is offered parcels no motorcycle can take, and looks unreliable for a typo',
);
check(
  'a departure that has already passed is refused',
  validateJourney({ ...base, departureAt: new Date(Date.now() - 1000) }).departureAt !== undefined,
);
/*
 * The ceiling is written out, not read from the constant.
 *
 * My first version of this compared against `MAX_DEPARTURE_DAYS + 1`, so
 * raising the constant to ten years moved the test with it and the assertion
 * could never fail. A bound is only asserted if the number is stated twice.
 */
check('the ceiling is fourteen days', MAX_DEPARTURE_DAYS === 14);
check(
  'a departure three weeks out is refused',
  validateJourney({ ...base, departureAt: future(24 * 21) }).departureAt !== undefined,
  'an exact picker can express "three weeks", which the hours field could not — and a route that far out listens for three weeks',
);
check(
  'a departure thirteen days out is accepted',
  validateJourney({ ...base, departureAt: future(24 * 13) }).departureAt === undefined,
);
check(
  'an unset departure is refused rather than sent as an invalid date',
  validateJourney({ ...base, departureAt: new Date('nonsense') }).departureAt !== undefined,
);

// -------------------------------------- changing your mind about a route ---

const editSql = read('supabase/migrations/20250101000027_journey_edit.sql');
const editCode = code(editSql);

check(
  'a driver can withdraw their own route',
  flat(editCode).includes('create or replace function public.cancel_journey(journey uuid)'),
);
check(
  'and only their own',
  flat(editCode).includes("if owner <> actor then raise exception 'Not your journey'"),
  'the update policy lets a client PATCH the row directly, so the rule has to hold in the function too',
);
check(
  'withdrawing frees any parcel waiting on that route immediately',
  flat(editCode).includes('perform public.dispatch_booking(stranded);') &&
    flat(editCode).includes(
      "set status = 'expired', responded_at = now() where journey_id = journey",
    ),
  'a parcel held for the rest of its window by a driver who has walked away is the stranding this design exists to prevent',
);
check(
  'the offer is settled before the parcel is re-offered',
  flat(editCode).indexOf(
    "set status = 'expired', responded_at = now() where journey_id = journey",
  ) < flat(editCode).indexOf('perform public.dispatch_booking(stranded);'),
  'the other order hits the "genuinely out with someone" guard inside dispatch_booking and returns without re-offering',
);
check(
  'withdrawing twice is a no-op rather than an error',
  flat(editCode).includes("if current_status in ('cancelled', 'completed') then"),
);

check(
  'a route can be edited',
  flat(editCode).includes('create or replace function public.update_journey('),
);
check(
  'but never while a trip is waiting on an answer',
  flat(editCode).includes(
    "raise exception 'Answer the trip offered on this route before changing it'",
  ),
  'a driver offered a Lagos parcel could otherwise switch the route to Abuja and accept, arriving in the wrong city carrying it',
);
check(
  'a flash shift is sent to the online toggle instead',
  flat(editCode).includes("raise exception 'Go offline and back online to change a flash shift'"),
);
check(
  'an edit leaves the departure to the sync trigger',
  flat(editCode).includes('departure_time = coalesce(new_departure, departure_time)') &&
    !flat(editCode).includes('departs_before = coalesce'),
);
check(
  'and an edit does not re-sweep',
  !flat(editCode).includes('redispatch_unassigned()') &&
    /change the capacity by a kilogram, collect a fresh sweep/i.test(editSql),
  'sweeping on edit is the pause/resume queue jump with one more step',
);

check(
  'the client surfaces the server sentence rather than a generic one',
  code(store).includes('return { ok: false, error: error.message }') &&
    code(planner).includes("showDialog('That change did not go through', outcome.error)"),
  'every way an edit fails is something the driver has to act on, and "could not save" leaves them pressing the button again',
);

check(
  'the journey row offers edit and withdraw',
  code(planner).includes('onEdit={() => startEdit(journey)}') &&
    code(planner).includes('onCancel={() => confirmCancel(journey)}'),
);
check(
  'withdrawing asks first, and says what it costs',
  code(planner).includes("'Withdraw this journey?'") &&
    /goes straight to another driver/.test(planner),
);
check(
  'editing loads the route back into the one form',
  code(planner).includes('setCapacity(String(journey.capacityKg))') &&
    code(planner).includes(
      'setDepartureAt(new Date(journey.departureAt ?? journey.departsBefore))',
    ),
  'a second form for the same fields is a second place for the validation to drift',
);
check(
  'and the submit button says which of the two things it does',
  code(planner).includes("editing ? 'Save changes' : 'Broadcast this journey'"),
);

check(
  'the listed journey shows a date, not just a time',
  code(planner).includes('leaves {departureLabel(departs)}'),
  '"leaves by 11:00" is the same sentence for today and for Thursday',
);
check(
  'a withdrawn route keeps its row and loses its controls',
  code(planner).includes("journey.status === 'cancelled' || journey.status === 'completed'") &&
    code(planner).includes("{journey.status === 'cancelled' ? 'Withdrawn' : 'Done'}"),
  'a row that vanishes on cancel reads as a save that failed',
);

// ------------------------------------------- the departure on the row ------

const departureSql = read('supabase/migrations/20250101000026_departure_time.sql');
const departureCode = code(departureSql);

check(
  'the journey row carries an exact departure',
  flat(departureCode).includes('add column if not exists departure_time timestamptz'),
);
check(
  'and one trigger keeps departs_before equal to it',
  flat(departureCode).includes('new.departs_before := new.departure_time;') &&
    flat(departureCode).includes('before insert or update on public.driver_journeys'),
  'two columns for one fact drift the moment somebody writes one of them',
);
check(
  'a flash shift is left without a departure',
  flat(departureCode).includes('if new.departure_time is not null then'),
  'a shift ends rather than departs; giving the column a value there would make it mean two things',
);
check(
  'the backfill lengthens an existing route rather than shortening it',
  flat(departureCode).includes('set departure_time = departs_before') &&
    flat(departureCode).includes("and mode = 'scheduled'"),
  'the true departure inside an old window is unknowable, and guessing early would silently stop a live route matching',
);
check(
  'departs_after defaults, so the client stops sending it',
  flat(departureCode).includes('alter column departs_after set default now()'),
);

check(
  'the old matcher signature is dropped rather than overloaded',
  flat(departureCode).includes(
    'drop function if exists public.journey_matches( text, text, timestamptz, timestamptz, numeric, text, text, numeric, text )',
  ),
  'a tenth parameter with a default leaves both callable with nine arguments, and Postgres refuses the ambiguous call',
);
check(
  'the matcher takes the departure and prefers it over the window',
  flat(departureCode).includes('journey_departure timestamptz default null') &&
    flat(departureCode).includes('coalesce(journey_departure, journey_departs_before) > now()'),
);
check(
  'and every caller of the dropped signature is rebuilt in the same file',
  flat(departureCode).includes('j.mode, j.departure_time') &&
    flat(departureCode).includes('new.mode, new.departure_time'),
  'dispatch_booking and sweep_for_journey both called it; leaving either behind would raise on the next dispatch',
);
check(
  'ties now break on the soonest departure',
  flat(departureCode).includes('coalesce(j.departure_time, j.departs_before) asc'),
  'departs_after was the earliest a driver might leave, which is not the same as when they do',
);

/*
 * Scoped to the insert, not the whole module.
 *
 * The first version of this checked `departs_before:` appeared nowhere in the
 * store and failed on the row *type* — which legitimately describes what comes
 * back. Only the write path is the concern.
 */
const insertPayload = (() => {
  const source = code(store);
  const from = source.indexOf('.insert({');
  const to = source.indexOf('})', from);
  return from >= 0 && to > from ? source.slice(from, to) : '';
})();

check(
  'the client sends a departure and nothing else about timing',
  insertPayload.includes('departure_time: input.departureAt.toISOString()') &&
    !insertPayload.includes('departs_before') &&
    !insertPayload.includes('departs_after'),
  'sending either would be a second opinion about a value the database owns, and the trigger silently wins',
);

check(
  'the form has no hours field left',
  !code(planner).includes('Leaving within') && !code(planner).includes('setHours'),
);
check('and uses the departure selector', code(planner).includes('<DeparturePicker'));
check(
  'the selector does not nest a scroll container inside the sheet',
  !code(read('src/components/ui/departure-picker.tsx')).includes('ScrollView'),
  'BottomSheet already scrolls; nesting two collapses the inner one on web',
);
check(
  'and its tap targets carry a pointer cursor',
  code(read('src/components/ui/departure-picker.tsx')).includes("tappable: { cursor: 'pointer' }"),
);

// ------------------------------------------------- picking a departure -----

check(
  'the day list starts today and runs to the ceiling',
  dayOptions(new Date('2026-08-14T10:00:00')).length === MAX_DEPARTURE_DAYS &&
    dayOptions(new Date('2026-08-14T10:00:00'))[0].label === 'Today' &&
    dayOptions(new Date('2026-08-14T10:00:00'))[1].label === 'Tomorrow',
);
check(
  'days are local midnights, not UTC ones',
  new Date(dayOptions(new Date('2026-08-14T23:30:00'))[0].value).getDate() === 14,
  'building these from toISOString would roll a day early for anyone east of Greenwich and put the wrong date on the button',
);
check(
  'the time list is quarter hours across a full day',
  timeOptions().length === 96 &&
    timeOptions()[0].label === '00:00' &&
    timeOptions()[95].label === '23:45',
);
check(
  'a day and a time combine into that exact local moment',
  (() => {
    const day = dayOptions(new Date('2026-08-14T10:00:00'))[1].value;
    const when = combineDeparture(day, 18 * 60 + 30);
    return when.getDate() === 15 && when.getHours() === 18 && when.getMinutes() === 30;
  })(),
);
check(
  'the default slot leaves real time to get moving, and sits on the grid',
  (() => {
    const now = new Date('2026-08-14T10:07:00');
    const slot = nextDepartureSlot(now);
    const minutesAway = (slot.getTime() - now.getTime()) / 60_000;
    // At least the 30-minute lead, and never more than a slot beyond it.
    return (
      minutesAway >= 30 && minutesAway <= 30 + MINUTE_STEP && slot.getMinutes() % MINUTE_STEP === 0
    );
  })(),
  'rounding up alone puts the default seconds into the future — a driver who opens the form and submits it has declared a departure they cannot make',
);
check(
  'reopening the selector lands on what was chosen',
  (() => {
    const chosen = combineDeparture(dayOptions(new Date())[2].value, 9 * 60 + 45);
    return (
      dayValueOf(chosen) === dayOptions(new Date())[2].value && minutesOf(chosen) === 9 * 60 + 45
    );
  })(),
);
check(
  'the closed field reads as a day and a time',
  /Today, /.test(departureLabel(new Date(), new Date())) &&
    departureLabel(null) === 'Choose a departure',
);

const offer = (secondsFromNow: number): DispatchOffer => ({
  id: 'o1',
  bookingId: 'b1',
  journeyId: 'j1',
  status: 'offered',
  offeredAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + secondsFromNow * 1000).toISOString(),
});

check('a live offer reports time left', secondsLeft(offer(120)) > 110);
check(
  'a lapsed one floors at zero',
  secondsLeft(offer(-60)) === 0,
  'a negative countdown reads as broken',
);

// --------------------------------------------------------- the dashboard --

check(
  'an offer outranks everything on the summary card',
  matchStatus({ liveOffers: 1, activeJobs: 3, openJourneys: 2 }).kind === 'offer',
  'the only item with a clock on it goes first',
);
check(
  'carrying outranks listening',
  matchStatus({ liveOffers: 0, activeJobs: 1, openJourneys: 2 }).kind === 'carrying',
);
check(
  'listening shows when journeys are open but nothing has landed',
  matchStatus({ liveOffers: 0, activeJobs: 0, openJourneys: 2 }).kind === 'waiting',
);
check(
  'and idle tells the driver what to do rather than that nothing matched',
  matchStatus({ liveOffers: 0, activeJobs: 0, openJourneys: 0 }).kind === 'idle' &&
    /setup trip/i.test(matchStatusLabel({ kind: 'idle' })),
  '"no matches" implies waiting will help; there is nothing to match against',
);
check(
  'and names the control that does it',
  /setup trip/i.test(matchStatusLabel({ kind: 'idle' })),
  'this hint used to say "schedule a journey" while the button said something else — an instruction that names nothing on screen is not an instruction',
);

const application = (status: DriverApplication['status']) => ({ status }) as DriverApplication;

check(
  'a driver who has not applied is blocked, with a way in',
  complianceState(null, false).tone === 'blocked' &&
    complianceState(null, false).action?.href === '/driver-signup',
);
check(
  'an approved active driver gets a clean line and no nag',
  complianceState(application('approved'), true).tone === 'ok' &&
    complianceState(application('approved'), true).action === undefined,
);
check(
  'approved but not active reads differently from under review',
  complianceState(application('approved'), false).label === 'Approved, but not active' &&
    complianceState(application('under_review'), false).label !== 'Approved, but not active',
  'a banned driver told "under review" waits for a decision that already happened',
);
check(
  'a rejected application is blocked, not merely warned',
  complianceState(application('rejected'), false).tone === 'blocked',
);

// ------------------------------------------------------- the honest gaps --

check(
  'the missing push notification is stated in the SQL',
  /no push notification/i.test(sql) && /Dispatch is not finished/i.test(sql),
  'an offer nobody is told about is a countdown running in an empty room',
);
check('and in the client module', /no push notification/i.test(store));
/*
 * This pair used to require the opposite.
 *
 * They asserted both waiting messages contained "Keep this screen open", which
 * was right while Package Relay could not send a notification at all. Push is deployed
 * now, so that sentence is false for most drivers — but still true for a phone
 * where the permission was refused. The assertion follows the same split the
 * copy does.
 */
const waiting = (alertsOn: boolean) => [
  modeAction({ mode: 'flash', onlineFlash: true, openRoutes: 0, alertsOn }).message,
  modeAction({ mode: 'scheduled', onlineFlash: false, openRoutes: 2, alertsOn }).message,
];

check(
  'a driver who can be reached is told so, on both modes',
  waiting(true).every(
    (message) => /alert you the moment/i.test(message) && !/keep this screen open/i.test(message),
  ),
  'the old copy claimed Package Relay could not send a notification, which stopped being true',
);
check(
  'and a phone that cannot be reached is still warned, on both modes',
  waiting(false).every(
    (message) =>
      /Notifications are off on this phone/i.test(message) &&
      /keep this screen open/i.test(message),
  ),
  'deleting the warning outright would leave exactly the drivers who cannot be reached with no idea of it',
);
check(
  'the warning is off by default rather than assumed away',
  /Notifications are off on this phone/i.test(
    modeAction({ mode: 'flash', onlineFlash: true, openRoutes: 0 }).message,
  ),
  'a caller that forgets the flag should get the cautious sentence, not the reassuring one',
);
check(
  'and the scheduling tab sends them to the right one',
  /appear on your Assigned Trip screen, not here/i.test(flat(planner)),
);

check(
  'the copy no longer promises there is no auto-dispatch',
  !/No forced dispatch/.test(read('src/app/(tabs)/about.tsx')) &&
    !/Claimed, not auto-assigned/.test(read('src/constants/how-it-works-steps.tsx')),
  'shipping the mechanism while leaving the promise standing tells drivers something untrue',
);
check(
  'and says what the new deal is',
  /can be declined/i.test(read('src/app/(tabs)/about.tsx')) &&
    /Offered, not forced/.test(read('src/constants/how-it-works-steps.tsx')),
);

/*
 * This assertion used to require the opposite.
 *
 * It read "the manual board survives as a fallback — a parcel no journey
 * matched still has to be claimable by somebody". That was true while dispatch
 * was new and browsing was the safety net. 20250101000025_dispatch_only.sql makes the offer
 * the only route, so the claim it protected is now the thing to prevent; the
 * fallback moved to `admin_assign_parcel`, which is asserted further down.
 */
check(
  'nothing is claimable from the scheduling screen any more',
  !flat(read('src/app/(tabs)/available-packages.tsx')).includes('Or browse what is unmatched'),
  'a parcel a driver can claim is a parcel that can be taken from under another driver mid-countdown',
);

// ----------------------------------------------------------- flash mode ----

const flashSql = read('supabase/migrations/20250101000018_flash_mode.sql');
const flashCode = code(flashSql);
const hub = read('src/components/ui/driver-hub.tsx');
const modeCard = read('src/components/ui/operating-mode-card.tsx');

/*
 * The gap flash closes.
 *
 * Before it, no local parcel could be dispatched at all: a journey could not
 * have the same city at both ends, and matching required both ends to equal the
 * parcel's. Every local parcel went past the matcher onto the open board with
 * nothing saying so.
 */
check(
  'a flash shift may have one city at both ends',
  flat(flashCode).includes("mode = 'flash' or origin_city <> destination_city"),
  'the original constraint made every local parcel undispatchable',
);
check(
  'and a scheduled journey still may not',
  flat(flashCode).includes('journey_route_distinct') &&
    !flat(flashCode).includes(
      'drop constraint if exists journey_route_distinct; alter table public.driver_journeys add constraint journey_route_distinct check ( true )',
    ),
);

check(
  'flash matches only parcels that stay inside its city',
  flat(flashCode).includes(
    "when 'flash' then parcel_origin = parcel_destination and parcel_origin = journey_origin",
  ),
  'matching on origin alone would offer a Lagos run to somebody who said they had two hours in Ibadan',
);
check(
  'and the scheduled branch is unchanged',
  flat(flashCode).includes(
    'else journey_origin = parcel_origin and journey_destination = parcel_destination',
  ),
);
check(
  'the matcher passes the mode through',
  flat(flashCode).includes('parcel.weight, j.mode'),
  'without it every journey would be matched as scheduled and flash would do nothing',
);

check(
  'going online closes any earlier shift',
  flat(flashCode).includes("where driver_id = actor and mode = 'flash' and status = 'open'"),
  'two open shifts double one driver’s chances and halve everybody else’s',
);
check(
  'and sweeps the parcels already waiting',
  flat(flashCode).includes('perform public.dispatch_booking(b.id)') &&
    flat(flashCode).includes('b.origin_city::text = city and b.destination_city::text = city'),
  'a two-hour shift that only sees parcels posted during it is mostly an empty two hours',
);
check(
  'a shift is bounded in length',
  flat(flashCode).includes('greatest(0.25, least(coalesce(hours, 2), 12))'),
  'nothing expires a shift, so an unbounded one collects offers until the driver reopens the app',
);
check(
  'only an approved driver can go online',
  flat(flashCode).includes('if not public.is_approved_driver() then'),
);
check(
  'the missing push notification is named as worse for flash',
  // Flattened: the sentence wraps across two lines in the SQL comment.
  /whole mode assumes a notification that does not exist/i.test(flat(flashSql)),
  'scheduled work is planned ahead; a flash shift is somebody holding the phone for two hours',
);

// ------------------------------------------------------- the mode, client ---

const journey = (over: Partial<Journey>): Journey => ({
  id: 'j',
  mode: 'scheduled',
  originCity: 'Ibadan',
  destinationCity: 'Lagos',
  departsAfter: new Date().toISOString(),
  departureAt: null,
  departsBefore: new Date(Date.now() + 3_600_000).toISOString(),
  capacityKg: 20,
  vehicleType: 'Motorcycle',
  status: 'open',
  createdAt: new Date().toISOString(),
  ...over,
});

check(
  'a live flash shift is found',
  activeFlashShift([journey({ mode: 'flash', destinationCity: 'Ibadan' })]) !== null,
);
check(
  'an expired one is not',
  activeFlashShift([
    journey({
      mode: 'flash',
      destinationCity: 'Ibadan',
      departsBefore: new Date(Date.now() - 1000).toISOString(),
    }),
  ]) === null,
  'a driver whose shift ran out is not online, whatever the row still says',
);
check(
  'a scheduled route is never mistaken for a shift',
  activeFlashShift([journey({})]) === null &&
    scheduledJourneys([journey({ mode: 'flash', destinationCity: 'Ibadan' })]).length === 0,
);
check(
  'a row written before flash existed reads as scheduled',
  flat(code(store)).includes("mode: row.mode === 'flash' ? 'flash' : 'scheduled'"),
);

check(
  'flash never tells a driver to plan a route',
  !/where you are going/i.test(
    modeAction({ mode: 'flash', onlineFlash: false, openRoutes: 0 }).message,
  ),
  'that is the one thing flash exists to avoid asking for',
);
check(
  'and offline flash offers going online',
  /go online/i.test(modeAction({ mode: 'flash', onlineFlash: false, openRoutes: 0 }).button),
);
check(
  'online flash offers going offline',
  /offline/i.test(modeAction({ mode: 'flash', onlineFlash: true, openRoutes: 0 }).button),
);
check(
  'scheduled with no routes offers scheduling one',
  modeAction({ mode: 'scheduled', onlineFlash: false, openRoutes: 0 }).button ===
    'Schedule a Journey',
);
check(
  'and scheduled with routes says what is listening',
  /Listening on 2 routes/.test(
    modeAction({ mode: 'scheduled', onlineFlash: false, openRoutes: 2 }).message,
  ),
);

check(
  'the card states the active mode in words, not only by switch position',
  flat(modeCard).includes('color: active ? theme.text : theme.textMuted') &&
    flat(modeCard).includes('Currently ${MODE_LABEL[mode]}'),
  'a switch has an on state, not a left and a right — nothing on it says which side is Flash',
);
check(
  'and the state is not carried by colour alone',
  flat(modeCard).includes('backgroundColor: active ? theme.primary'),
  'WCAG 1.4.1 — the underline is what makes the active side readable at arm’s length',
);
check(
  'both labels are pressable, not just the switch',
  (flat(modeCard).match(/accessibilityLabel={`Switch to \${label}`}/g) ?? []).length === 1 &&
    flat(modeCard).includes('onPress={() => onChange('),
  'on a phone the label is the bigger target and people tap it',
);

check(
  'the card sits above the empty state on the hub',
  hub.indexOf('<OperatingModeCard') < hub.indexOf('<EmptyState'),
);
check(
  'switching to scheduled ends a live flash shift',
  flat(code(hub)).includes("if (next === 'scheduled' && flashShift) {"),
  'leaving it open keeps offering local jobs to somebody who just said they are doing something else',
);
check(
  'the flash city comes from the approved application',
  flat(code(hub)).includes('const city = application?.baseCity;'),
  'a driver who could type any city could go online somewhere they have never been',
);

// ------------------------------------------- the stale-offer lock (fixed) --

/*
 * The bug this guards against, stated plainly so it cannot come back.
 *
 * A partial unique index cannot call `now()`, so `dispatch_offers_one_live_per_booking`
 * has no time component and counts an *expired* row as live. `dispatch_booking`
 * did have a time component. The two disagreed, and the moment an offer lapsed
 * unanswered the insert hit the index, the function raised, and the parcel was
 * never offered again — silently, on a board where it still looked normal.
 */
const repairSql = read('supabase/migrations/20250101000020_dispatch_repair.sql');
const repairCode = code(repairSql);

check(
  'dispatch settles lapsed offers before it tries to insert',
  flat(repairCode).includes(
    "update public.dispatch_offers set status = 'expired', responded_at = coalesce(responded_at, now()) where dispatch_offers.booking_id = dispatch_booking.booking_id and status = 'offered' and expires_at <= now();",
  ),
  'the index and the guard disagreed about "live", and only a sweep nobody scheduled reconciled them',
);
check(
  'and the insert can no longer raise',
  flat(repairCode).includes('on conflict do nothing') &&
    flat(repairCode).includes('if offer_id is null then return null;'),
  'it runs inside the insert trigger — a raise there stops a sender posting a parcel at all',
);

check(
  'a decline was permanent when 20250101000020_dispatch_repair.sql was written',
  flat(repairCode).includes('dispatch_offers_no_repeat_decline') &&
    flat(repairCode).includes("where status = 'declined'"),
  'rotating back to somebody who said no is how a driver learns to ignore dispatch',
);
check(
  'but a lapse is not',
  !flat(repairCode).includes('create unique index if not exists dispatch_offers_once_per_driver') &&
    flat(repairCode).includes('drop index if exists public.dispatch_offers_once_per_driver'),
  'with one approved driver the old rule retired a parcel permanently after the first miss',
);
check(
  'a lapsed offer is not retried immediately',
  flat(repairCode).includes(
    "o.status = 'expired' and o.responded_at > now() - interval '10 minutes'",
  ),
  'otherwise a single-driver parcel re-offers in a loop every time anything calls dispatch',
);
check(
  'and drivers who have never seen the parcel are tried first',
  flat(repairCode).includes('order by (exists ('),
  'coming back round should be the last resort, not the cheapest branch',
);

check(
  'the sweep is scheduled rather than described',
  flat(repairCode).includes("cron.schedule( 'loci-expire-offers', '* * * * *'") &&
    flat(repairCode).includes("cron.schedule( 'loci-redispatch'"),
  'leaving it as an instruction in a comment is what caused the bug',
);
check(
  'the payout sweep got scheduled too',
  flat(repairCode).includes("cron.schedule( 'loci-apply-payout-changes'"),
  '20250101000016_driver_identity.sql documented that one and stopped there as well',
);
check(
  'a project without pg_cron is warned, not broken',
  flat(repairCode).includes('raise warning') &&
    flat(repairCode).includes('Dispatch still heals itself on every call'),
);
check(
  'and anything already stuck is repaired by the migration itself',
  flat(repairCode).includes('select public.redispatch_unassigned() into offered;'),
  'a fix that needs somebody to remember a second script is a fix that half-happens',
);

check(
  'the re-dispatch safety net takes the oldest parcel first',
  flat(repairCode).includes('order by b.created_at asc'),
);
check(
  'and no client can call it',
  flat(repairCode).includes(
    'revoke all on function public.redispatch_unassigned(integer) from public, anon, authenticated',
  ),
);

// ------------------------------------------------ the offer window by type --

const windowSql = read('supabase/migrations/20250101000021_offer_windows.sql');
const windowCode = code(windowSql);

check(
  'the hold is five minutes for a local trip and ten for an interstate one',
  flat(windowCode).includes(
    "select case when is_local then interval '5 minutes' else interval '10 minutes' end;",
  ),
);
check(
  'and the client agrees with the database',
  OFFER_HOLD_MINUTES.local === 5 && OFFER_HOLD_MINUTES.interstate === 10,
  'a client promising five minutes on a ten-minute hold has drivers giving up early',
);
check(
  'the two are the same rule, read the same way',
  offerHoldMinutes(true) === 5 && offerHoldMinutes(false) === 10,
);

check(
  'the window is decided by the parcel, not by the journey that matched it',
  flat(windowCode).includes('local_trip := parcel.origin_city = parcel.destination_city;'),
  'they coincide today; deriving it from the journey would silently change every hold if matching widens',
);
check(
  'and dispatch sets it explicitly rather than leaning on the column default',
  flat(windowCode).includes(
    'insert into public.dispatch_offers (booking_id, journey_id, driver_id, expires_at) values (booking_id, chosen.id, chosen.driver_id, now() + hold)',
  ),
);
check(
  'the default is the longer window, so a fallback never cuts a driver short',
  flat(windowCode).includes("alter column expires_at set default (now() + interval '10 minutes')"),
  'holding a parcel slightly too long is recoverable; expiring while somebody reads the notification is not',
);
check(
  'the hold is recorded on the audit line',
  flat(windowCode).includes("'hold_minutes', extract(epoch from hold) / 60"),
  'a run of expiries is only readable against the window it was given',
);

check(
  'the retry cooldown follows the hold rather than a flat ten minutes',
  flat(windowCode).includes('and o.responded_at > now() - hold'),
  'a five-minute offer that could not come back for ten was waiting twice as long as it was held',
);

// ------------------------------------------------------------- rollover ----

check(
  'the sweeper marks lapsed offers expired',
  flat(windowCode).includes(
    "update public.dispatch_offers set status = 'expired', responded_at = coalesce(responded_at, now()) where status = 'offered' and expires_at <= now()",
  ),
);
check(
  'and re-offers each one in the same pass',
  flat(windowCode).includes('perform public.dispatch_booking(expired_booking);'),
  'expiring without re-offering is a tidy-up, not a rollover',
);
check(
  'the loop uses a data-modifying CTE',
  flat(windowCode).includes('with lapsed as ( update public.dispatch_offers') &&
    flat(windowCode).includes('select booking_id from lapsed'),
  'FOR ... IN with a bare UPDATE ... RETURNING is at best version-dependent; this form is not',
);
check(
  'and the rollover is scheduled, not described',
  flat(windowCode).includes("cron.schedule( 'loci-expire-offers', '* * * * *'"),
);
check(
  'a project without pg_cron is warned rather than silently idle',
  flat(windowCode).includes('nothing rolls an offer over while the app is idle'),
);

check(
  'offers already in flight are lengthened, never shortened',
  flat(windowCode).includes('and o.expires_at < o.offered_at + public.offer_hold(false)'),
  'a driver watching a countdown should never see it jump backwards',
);

// ------------------------------------- where the offer card actually lives --

const offerCard = read('src/components/ui/dispatch-offers.tsx');

check(
  'the offer card is its own component rather than buried in one screen',
  offerCard.includes('A trip for you') && offerCard.includes('export function DispatchOffers'),
);
check(
  'the Assigned Trip screen renders it',
  flat(hub).includes('<DispatchOffers offers={offers} busy={busyOffer} onAnswer={answerOffer} />'),
  'this is the driver home screen — the one they sit on rather than visit',
);
check(
  'and the scheduling tab no longer does',
  !code(planner).includes('A trip for you') && !code(planner).includes('DispatchOffers'),
  'the request was to move it, and two copies would fight over the same offer',
);

check(
  'a pending offer suppresses the empty state entirely',
  flat(hub).includes(') : offers.length > 0 ? null : ('),
  '"Nothing on your bike" above a live countdown contradicts itself',
);
check(
  'the offer is rendered above the current job, not below it',
  hub.indexOf('<DispatchOffers') < hub.indexOf('<CurrentJob'),
  'a driver already carrying a parcel can still be offered another, and it is the only thing here with a deadline',
);

check(
  'accepting reloads bookings as well as dispatch',
  flat(hub).includes('await Promise.all([reloadDispatch(), refresh()]);'),
  'reloading only dispatch would leave the driver on an empty state a second after accepting a trip',
);
check(
  'the card fetches nothing itself',
  !offerCard.includes('fetchLiveOffers') && !offerCard.includes('respondToOffer'),
  'a component that fetches cannot be placed on a second screen',
);

check(
  'the hub keeps looking for offers rather than fetching once',
  flat(hub).includes('const timer = setInterval(() => void load(), OFFER_POLL_MS);') &&
    flat(hub).includes('clearInterval(timer);'),
  'offers arrive from a background sweep, so nothing the driver does here would trigger a refetch',
);
check(
  'the poll is short against the shortest hold',
  /OFFER_POLL_MS = 15_000/.test(hub) && 15_000 <= (OFFER_HOLD_MINUTES.local * 60_000) / 10,
  'a poll slower than a tenth of the window shows a countdown the database has already finished',
);

check(
  'the countdown resets when a card appears rather than reusing a stale clock',
  flat(offerCard).includes('setNow(new Date()); const timer = setInterval'),
  'a screen left open for an hour would otherwise render the first card against an hour-old now',
);
check(
  'the clock stops when there is nothing counting down',
  flat(offerCard).includes('if (offers.length === 0) return;'),
);
check(
  'an expired offer cannot be accepted, but can still be declined away',
  flat(offerCard).includes('disabled={busy || left === 0}') &&
    flat(offerCard).includes('onPress={() => onAnswer(offer, false)} disabled={busy}'),
);

// -------------------------------------------- work that arrived and lapsed --

check(
  'the driver is told about offers that expired unseen',
  flat(hub).includes('offers.length === 0 && missed.length > 0') &&
    /expired before you saw/i.test(hub),
  'four offers came and went on the test phone and the app said nothing — from inside, that is indistinguishable from Package Relay having no work',
);
check(
  'the notice stands down while something is live',
  flat(hub).includes('{offers.length === 0 && missed.length > 0 && ('),
  'during a countdown nothing else should compete for the driver attention',
);
check(
  'a miss is counted by its expiry, not only by its status',
  code(store).includes(".neq('status', 'accepted')") &&
    code(store).includes('Date.parse(offer.expiresAt) <= now.getTime()'),
  'reading only status=expired reports zero misses exactly when the sweeper has stopped, which is when it matters most',
);

// -------------------------------------------------------- the matcher lies --

const volatility = read('supabase/migrations/20250101000022_matcher_volatility.sql');

check(
  'journey_matches is STABLE, not IMMUTABLE',
  flat(code(volatility)).includes('returns boolean language sql stable set search_path'),
  'it calls now(); labelling it immutable lets a pooled connection match against a cached clock',
);
check(
  'and the original mislabelling is still on record',
  flat(code(read('supabase/migrations/20250101000018_flash_mode.sql'))).includes(
    'returns boolean language sql immutable set search_path',
  ),
  'kept as history — 22 replaces it, and a reader should be able to see what changed',
);

check(
  'the diagnostic is read-only',
  !/\b(insert|update|delete|drop|alter|create)\b/i.test(
    code(read('supabase/diagnose_dispatch.sql')),
  ),
  'a script for a production database in a bad state must not be able to make it worse',
);
check(
  'and it reports which migrations never reached the database',
  read('supabase/diagnose_dispatch.sql').includes("to_regprocedure('public.offer_hold(boolean)')"),
  'most of what looks like a dispatch bug is a migration that was written and not run',
);

// ------------------------------------------------ one cooldown, both noes --

const cooldownSql = read('supabase/migrations/20250101000023_offer_cooldown.sql');
const cooldownCode = code(cooldownSql);

check(
  'the cooldown is fifteen minutes',
  flat(cooldownCode).includes("select interval '15 minutes';"),
);
check('and the client agrees with the database', OFFER_COOLDOWN_MINUTES === 15);
check(
  'it is a separate number from the answer window',
  OFFER_COOLDOWN_MINUTES !== OFFER_HOLD_MINUTES.local &&
    OFFER_COOLDOWN_MINUTES !== OFFER_HOLD_MINUTES.interstate,
  'the hold is how long a driver gets to answer; the cooldown is how long the parcel stays away afterwards',
);

check(
  'a decline and a lapse are held out by the same clause',
  flat(cooldownCode).includes("and o.status in ('declined', 'expired')"),
  'two rules for the same fact is how the last stranding bug happened',
);
check(
  'the decline-only unique index is dropped',
  flat(cooldownCode).includes('drop index if exists public.dispatch_offers_no_repeat_decline;'),
  'a second decline of the same parcel would collide with the first, and the driver would see an error on Decline',
);
check(
  'but one live offer per parcel still is not negotiable',
  flat(cooldownCode).includes(
    'create unique index if not exists dispatch_offers_one_live_per_booking',
  ),
);

check(
  'a lapse counts from when it lapsed, not from when the sweeper noticed',
  flat(cooldownCode).includes(
    "case when o.status = 'expired' then o.expires_at else o.responded_at end",
  ),
  'this project has a row that expired at 11:35 and was settled at 12:49 — measuring from responded_at holds a driver out for 74 extra minutes',
);

check(
  'the cooldown excludes a driver from one parcel, not from the queue',
  flat(cooldownCode).includes(
    'and not exists ( select 1 from public.dispatch_offers o where o.booking_id = dispatch_booking.booking_id and o.driver_id = j.driver_id',
  ),
  'without the booking_id scope a driver in cooldown would stop receiving every other parcel too',
);
check(
  'and the parcel keeps rotating outward while they sit it out',
  flat(cooldownCode).includes('(exists ( select 1 from public.dispatch_offers o') &&
    flat(cooldownCode).includes(') asc, j.departs_after asc,'),
  'untried drivers first is the only thing stopping a parcel cycling between the two who already refused it',
);
check(
  'a repeat offer is recorded so the nagging loop is findable',
  flat(cooldownCode).includes("'repeat', exists ("),
);
check(
  'parcels held out by the old permanent rule are released on migration',
  flat(cooldownCode).includes('select public.redispatch_unassigned() into offered;'),
  'the new cooldown only applies to declines made after this runs — the stuck parcel is the one from before it',
);

check(
  'the driver is told the decline is temporary',
  read('src/components/ui/dispatch-offers.tsx').includes(
    'not come back to you for at\n                least {OFFER_COOLDOWN_MINUTES} minutes',
  ),
  'the card previously implied a decline was final, which it no longer is',
);

// --------------------------------------- an offer is the only way in -------

const only = read('supabase/migrations/20250101000025_dispatch_only.sql');
const onlyCode = code(only);
const board = read('src/app/(tabs)/available-packages.tsx');

check(
  'the claim branch is gone from the bookings update policy',
  flat(onlyCode).includes('drop policy if exists "claim or advance" on public.bookings;') &&
    !flat(onlyCode).includes(
      "driver_id is null and status = 'Booked' and public.is_approved_driver()",
    ),
  'removing the buttons leaves the capability — any approved driver could PATCH their id onto any unassigned parcel',
);
check(
  'what remains lets a driver advance only their own parcel',
  flat(onlyCode).includes(
    'using ( driver_id = (select auth.uid()) or sender_id = (select auth.uid()) )',
  ),
);
check(
  'and cannot be used to hand a parcel to somebody else',
  flat(onlyCode).includes('with check ( driver_id = (select auth.uid())'),
);

check(
  'the marketplace board is gone from the scheduling screen',
  !code(board).includes('Accept Order') &&
    !code(board).includes('acceptBooking') &&
    !code(board).includes('JobCard'),
);
check(
  'and the screen still declares journeys',
  code(board).includes('<JourneyPlanner />'),
  'removing the board must not remove the thing that replaces it',
);
check(
  'no second claim feed survives on the home screen',
  !/PackagesReadyForPick/.test(read('src/app/(tabs)/index.tsx')),
  'two ways to take a parcel is how one driver claims a parcel another is watching a countdown on',
);

check(
  'an admin can still assign a parcel by hand',
  flat(onlyCode).includes(
    'create or replace function public.admin_assign_parcel(parcel uuid, driver uuid)',
  ),
  'the board was the only thing that moved parcels when dispatch broke, and dispatch has broken twice',
);
check(
  'but only an admin, and only onto an approved driver',
  flat(onlyCode).includes('if not public.is_admin() then raise exception') &&
    flat(onlyCode).includes("where a.user_id = driver and a.status = 'approved'"),
);
check(
  'not over the top of a driver already carrying it',
  flat(onlyCode).includes('That parcel already has a driver'),
);
check(
  'it settles any live offer rather than leaving one dangling',
  flat(onlyCode).includes(
    "update public.dispatch_offers set status = 'expired', responded_at = coalesce(responded_at, now()) where booking_id = parcel and status = 'offered'",
  ),
  'a live offer row plus an assigned parcel is the index-versus-guard disagreement from 20250101000020_dispatch_repair.sql',
);
check(
  'every manual assignment is logged as a warning against the admin',
  flat(onlyCode).includes("'warning', 'dispatch', 'admin assigned a parcel by hand'"),
  'a run of these is a dispatch bug, not an admin habit — info level would bury that. ' +
    "'warn' is not in the app_events vocabulary: it is info | warning | error, and the " +
    'constraint refuses anything else at runtime',
);

check(
  'a push tap lands where the offer card actually is',
  code(read('src/components/ui/notification-router.tsx')).includes("router.navigate('/driver')"),
  'it pointed at the scheduling tab, which stopped holding offers the moment the card moved',
);

// ---------------------------------------------------------- the countdown --

const held = (minutes: number, elapsedSeconds: number): DispatchOffer => {
  const offeredAt = new Date(Date.now() - elapsedSeconds * 1000);
  return {
    id: 'o',
    bookingId: 'b',
    journeyId: 'j',
    status: 'offered',
    offeredAt: offeredAt.toISOString(),
    expiresAt: new Date(offeredAt.getTime() + minutes * 60_000).toISOString(),
  };
};

check('a fresh five-minute offer is not urgent', !offerIsUrgent(held(5, 10)));
check(
  'a five-minute offer turns urgent inside its last minute',
  offerIsUrgent(held(5, 4 * 60 + 15)),
);
check(
  'a ten-minute offer is not urgent at four minutes gone',
  !offerIsUrgent(held(10, 4 * 60)),
  'a flat sixty-second threshold would leave a long offer calm until it was nearly gone',
);
check('and is urgent inside its last two minutes', offerIsUrgent(held(10, 8 * 60 + 30)));
check(
  'the screen quotes both windows from the shared constant',
  planner.includes('{OFFER_HOLD_MINUTES.local} minutes') &&
    planner.includes('{OFFER_HOLD_MINUTES.interstate}'),
  'copy promising five minutes to an interstate driver is a promise the database does not keep',
);
check('and no longer states a single flat hold', !/held for five minutes/i.test(planner));
check(
  'the push body counts down from the offer row rather than a fixed number',
  read('supabase/functions/notify-offer/expo-push.ts').includes(
    'Date.parse(offer.expiresAt) - now.getTime()',
  ),
);

check(
  'the countdown itself reads from the row, so both windows tick correctly',
  secondsLeft(held(10, 60)) > 8 * 60 && secondsLeft(held(5, 60)) < 5 * 60,
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — one live offer per parcel, a no of either kind holds that parcel off that driver\n' +
    '       for fifteen minutes while it keeps rotating and they keep taking other work,\n' +
    '       settles stale offers itself so a missed one cannot strand a parcel, the sweeps are\n' +
    '       scheduled rather than described, drivers cannot run the matcher or write offers,\n' +
    '       and the missing push notification is admitted everywhere it matters.',
);
