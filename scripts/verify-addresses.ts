/**
 * Assertions for address lookup, now that it is on every address in the app.
 *
 * ⚠ Two failures matter here and neither is "autocomplete stopped working".
 *
 *   The first is a field that cannot be *filled* when Google cannot answer.
 *   Address search is deployed separately from the app, is billed, is rate
 *   limited, and does not know about half the addresses in Nigeria — new
 *   estates, informal settlements, "behind the second gate". Any form that
 *   refuses a typed address the moment lookup fails is a form nobody can
 *   submit, and it fails for the applicant rather than for us.
 *
 *   The second is a coordinate that outlives the address it came from. Pick
 *   "12 Awolowo, Ikoyi", then edit the text to a different street, and a stale
 *   point would price — and could dispatch — against the place you rejected.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEBOUNCE_MS } from '../src/hooks/use-address-suggestions';
import { estimateFee } from '../src/store/bookings';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const lookup = read('src/components/ui/address-lookup.tsx');
const hook = read('src/hooks/use-address-suggestions.ts');
const field = read('src/components/ui/address-field.tsx');
const book = read('src/app/(tabs)/book.tsx');
const signup = read('src/app/(tabs)/driver-signup.tsx');
const hubs = read('src/components/ui/hub-editor.tsx');

// ------------------------------------- every address input has lookup on it --

/*
 * ⚠ The list, not a count.
 *
 *   A count would be satisfied by putting six lookups on one screen. What was
 *   asked for was every place an address is typed, so each is named.
 */
const INPUTS: [string, string, string][] = [
  ['the pickup address', book, 'label="Pickup address"'],
  ['the dropoff address', book, "'Dropoff address' : 'Meeting point'"],
  ["the applicant's address", signup, 'value={form.address}'],
  ["the guarantor's address", signup, 'value={form.guarantorAddress}'],
];

for (const [name, source, marker] of INPUTS) {
  const at = source.indexOf(marker);
  check(`${name} exists at all`, at >= 0, `"${marker}" is not in the file any more`);

  /*
   * ⚠ Which element opened last, rather than which tag is nearest.
   *
   *   My first version took `lastIndexOf('<', at)` and read forward. That
   *   lands on the `<MapPin>` inside the `icon={(color, size) => …}` prop, not
   *   on the element being opened, so it failed on fields that had been
   *   converted correctly. Comparing where each candidate tag was last opened
   *   ignores the icon entirely and still fails if the element is a `<Field>`.
   */
  const before = source.slice(Math.max(0, at - 400), at);
  check(
    `${name} searches for addresses`,
    at >= 0 && before.lastIndexOf('<AddressLookup') > before.lastIndexOf('<Field'),
    `it is still a plain <Field>, so typing there gets no suggestions`,
  );
}

check(
  'the hub address searches for addresses',
  hubs.includes('<AddressSearchField') && hubs.includes('useAddressSuggestions'),
  'Get Directions hands this string to a maps app — an address Google cannot resolve fails silently for every sender who taps it',
);

// ------------------------------------------- and none of them is gated on it --

/*
 * ⚠ The negative that matters most.
 *
 *   `AddressLookup` renders a `Field` whose `value` is whatever the parent
 *   holds and whose `onChangeText` reports every keystroke. There is no branch
 *   in which the input is replaced, disabled or discarded. If somebody later
 *   adds one — an `if (unavailable) return <SomethingElse>` — this catches it.
 */
check(
  'the address stays typeable when lookup is unavailable',
  !/if\s*\(\s*unavailable\s*\)\s*\{?\s*return/.test(lookup),
  'a form that cannot be filled during a Google outage cannot be filled by anyone Google has not heard of either',
);
check(
  'and says so rather than looking broken',
  lookup.includes('Address search is unavailable') && lookup.includes('type the address in full'),
  'a field that silently stops suggesting reads as the person doing something wrong',
);
check(
  'a lookup that matched nothing still accepts what was typed',
  lookup.includes('No matches') && lookup.includes('that works too'),
  '"no matches" must not read as "not accepted" — plenty of real Nigerian addresses are not on the map',
);
check(
  'the hub address survives an outage too',
  hubs.includes('Address search is unavailable'),
  'the admin sheet is where a hub that no sender can navigate to would be created',
);

// ------------------------------ a coordinate cannot outlive its address ----

/*
 * ⚠ Structural, not incidental.
 *
 *   `AddressLookup` exposes exactly one callback for both typing and choosing.
 *   That is what makes a stale point impossible: there is no handler a caller
 *   could wire that reports new text while leaving the old coordinate in
 *   place. Splitting it into `onChangeText` + `onSelect` would reintroduce the
 *   hazard, and would pass every other assertion in this file.
 */
check(
  'typing reports the text and clears the point together',
  lookup.includes('onChange({ address: text, point: null })'),
  'editing a chosen address must drop its coordinate, or the fare is priced on the place they rejected',
);
/*
 * ⚠ Declarations, not prose.
 *
 *   The first version of this was `!lookup.includes('onSelect')`, which failed
 *   against correct code — the comment above the prop explains why a separate
 *   `onSelect` would be a hazard, and the assertion matched the explanation.
 *   A check on the presence of a *word* will eventually be satisfied by
 *   somebody describing it; this matches the shape of a prop declaration.
 */
check(
  'and there is no second callback that could leave one behind',
  !/onSelect\s*\??\s*:/.test(lookup) && !/onChangeText\s*\??\s*:/.test(lookup),
  'one callback for both is the whole guarantee — two would let a caller keep a stale point',
);

for (const [name, setter, point] of [
  ['pickup', "setField('pickupAddress', next.address)", 'setPickupPoint(next.point)'],
  ['dropoff', "setField('dropoffAddress', next.address)", 'setDropoffPoint(next.point)'],
] as const) {
  const at = book.indexOf(setter);
  check(`the ${name} address is stored`, at >= 0);
  check(
    `and its point is set from the same change`,
    at >= 0 && book.slice(at, at + 200).includes(point),
    'storing the address without the point, or the point elsewhere, is how they drift apart',
  );
}

// ------------------------------- the booking and the quote price alike ----

/*
 * ⚠ Two numbers for one journey is the bug people screenshot.
 *
 *   The landing-page quote prices on the measured distance. Until the booking
 *   form did too, a sender quoted for Abuja→Lagos reached the booking form and
 *   was charged the old flat inter-state band for the identical parcel.
 */
check(
  'the booking prices on the measured distance',
  book.includes('distanceKm: distance?.km'),
  'the quote and the booking must not disagree about the same journey',
);
check(
  'and measures it from the two chosen addresses',
  book.includes('measureDistance(pickupPoint, dropoffPoint)'),
  '',
);
check(
  'it shows the journey it charged for',
  book.includes('fee.distance > 0') && book.includes('distanceLabel(distance)'),
  'a distance charge with no distance shown is an unexplained line on a receipt',
);

/*
 * ⚠ And the fallback is still exactly the old price.
 *
 *   A hub pickup has no address, so it has no coordinates and no distance.
 *   `verify-pricing` pins this to the naira; asserted again from this side
 *   because it is the reason the change above is safe to ship before the
 *   Places key is deployed.
 */
const noDistance = estimateFee({
  deliveryType: 'interstate',
  weight: 3,
  declaredValue: 0,
  pickupMode: 'hub',
  dropoffMode: 'hub',
});
check(
  'a booking with no measurable distance is priced as it always was',
  noDistance.distance === 0,
  `a hub-to-hub parcel has no address to measure, and must not be charged for one — got ${noDistance.distance}`,
);

// --------------------------------------- the billing behaviour is shared ----

/*
 * ⚠ Google bills a session, not a request.
 *
 *   One token covers every keystroke plus the one details call. Two components
 *   implementing that separately is how one of them ends up billing a session
 *   per letter, and the bill is the last place anybody would look.
 */
check(
  'both fields get their lookup from one place',
  lookup.includes('useAddressSuggestions') && field.includes('useAddressSuggestions'),
  'the debounce and the session token cannot live in two files and stay the same',
);
/*
 * ⚠ The delay has to be *used*, and has to be long enough to be one.
 *
 *   This began as `hook.includes('setTimeout') && hook.includes('DEBOUNCE_MS')`
 *   and survived replacing the delay with `0` — the constant's own declaration
 *   satisfied the second half, so the check passed while every keystroke fired
 *   a request. Mentioning a constant is not using it, and using it is not the
 *   same as its value being sane.
 */
check(
  'the shared hook debounces',
  /\},\s*DEBOUNCE_MS\s*\)/.test(hook),
  'the delay is declared but not passed to setTimeout — every keystroke bills a session',
);
check(
  'and the delay is long enough to collapse a burst of typing',
  DEBOUNCE_MS >= 200,
  `${DEBOUNCE_MS}ms is shorter than the gap between two keystrokes, so it debounces nothing`,
);
check(
  'and closes the session after each address',
  hook.includes('session.current = newSessionToken()'),
  'reusing a spent token is something Google is entitled to treat as abuse',
);
check(
  'choosing a suggestion does not search for what was just chosen',
  hook.includes('setSettled(true)') && hook.includes('|| settled'),
  'writing the chosen address into the field looks like typing, and would bill a second session for an answer already paid for',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — every address input in the app searches, none of them can be blocked by Google\n' +
    '       being unreachable, editing a chosen address drops its coordinate, the booking\n' +
    '       and the quote price the same journey alike, and a parcel with nothing to\n' +
    '       measure costs exactly what it did before.',
);
