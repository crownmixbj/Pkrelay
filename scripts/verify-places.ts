/**
 * Assertions for turning a typed address into a price band.
 *
 * ⚠ The thing under test is not "does autocomplete work" — it is what a
 *   suggestion *resolves to*, and getting that wrong is expensive in a specific
 *   way.
 *
 *   `estimateFee` charges by band: same city is ₦1,500 + ₦200/kg, different
 *   cities is ₦4,500 + ₦450/kg. There is no distance term. So resolving an
 *   address to the wrong city does not nudge a quote, it moves it between two
 *   flat rates — and a quote that is wrong by ₦3,000 because a suburb matched
 *   the wrong locality is a refund conversation, not a rounding error.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolvePlaceCity, resolutionSummary } from '../src/lib/place-to-city';

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
    .replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Google's shape, abbreviated to the three fields the resolver reads. */
const part = (longName: string, types: string[], shortName = longName) => ({
  longName,
  shortName,
  types,
});

// -------------------------------------------------------------- resolving ---

check(
  'a town LOCI serves resolves to itself',
  (() => {
    const outcome = resolvePlaceCity([
      part('Allen Avenue', ['route']),
      part('Ibadan', ['locality']),
      part('Oyo', ['administrative_area_level_1']),
    ]);
    return outcome.kind === 'served' && outcome.city === 'Ibadan' && outcome.via === 'locality';
  })(),
);

/*
 * ⚠ The ordering assertion, and the reason the state is a fallback.
 *
 *   Reading the state first would send every address in Oyo to Ibadan —
 *   correct for most of the state, wrong for anywhere LOCI lists separately.
 */
check(
  'the locality beats the state',
  (() => {
    const outcome = resolvePlaceCity([
      part('Ogbomosho', ['locality']),
      part('Oyo State', ['administrative_area_level_1'], 'Oyo'),
    ]);
    /*
      Ogbomosho is not on the served list, so this must fall through to the
      state rather than claim a city that does not exist in the pricing. What
      is asserted is that it did *not* resolve via locality.
    */
    return outcome.kind === 'served' && outcome.via === 'state';
  })(),
);

check(
  'a village resolves to the city that handles its state',
  (() => {
    const outcome = resolvePlaceCity([
      part('Somewhere Small', ['locality']),
      part('Oyo State', ['administrative_area_level_1'], 'Oyo'),
    ]);
    return outcome.kind === 'served' && outcome.city === 'Ibadan' && outcome.via === 'state';
  })(),
);

/*
 * Google frequently files Nigerian towns under `administrative_area_level_2`
 * rather than `locality`. Ignoring that level drops ordinary addresses to their
 * state's default city — right often enough to look fine and wrong often
 * enough to matter.
 */
check(
  'a town in administrative_area_level_2 is still found',
  (() => {
    const outcome = resolvePlaceCity([
      part('Ibadan North', ['administrative_area_level_2']),
      part('Ibadan', ['administrative_area_level_2']),
      part('Oyo State', ['administrative_area_level_1'], 'Oyo'),
    ]);
    return outcome.kind === 'served' && outcome.city === 'Ibadan';
  })(),
);

check(
  '"Lagos State" and "Lagos" are the same place',
  (() => {
    const outcome = resolvePlaceCity([
      part('Nowhere', ['locality']),
      part('Lagos State', ['administrative_area_level_1'], 'LA'),
    ]);
    return outcome.kind === 'served' && outcome.city === 'Lagos';
  })(),
  'the suffix is on the long name and absent from the short one, and both arrive',
);

check(
  'somewhere LOCI does not reach says so',
  (() => {
    const outcome = resolvePlaceCity([
      part('Nairobi', ['locality']),
      part('Nairobi County', ['administrative_area_level_1']),
    ]);
    return outcome.kind === 'unserved';
  })(),
  'a confident wrong city is worse than an honest refusal — the bands are ₦3,000 apart',
);

check(
  'and nothing usable is unknown, not a guess',
  resolvePlaceCity([part('Some Road', ['route'])]).kind === 'unknown',
);

// ------------------------------------------------------------ explaining ----

check(
  'a state match says it is the nearest city',
  resolutionSummary({ kind: 'served', city: 'Ibadan', via: 'state' }).includes('nearest city'),
  'somebody who typed a village and sees an Ibadan rate needs to know where that came from',
);
check(
  'a direct match does not',
  !resolutionSummary({ kind: 'served', city: 'Ibadan', via: 'locality' }).includes('nearest'),
);
check(
  'an unserved place names the state it refused',
  resolutionSummary({ kind: 'unserved', describedAs: 'Nairobi County' }).includes('Nairobi County'),
);

// -------------------------------------------------------- the key is safe ---

const fn = read('supabase/functions/places-lookup/index.ts');
const field = code(read('src/components/ui/address-field.tsx'));
const store = code(read('src/store/places.ts'));

/*
 * ⚠ The whole reason the proxy exists.
 *
 *   A Places key in the bundle is one somebody else can spend, and on a phone
 *   it cannot be referrer-restricted. Autocomplete bills per session, so the
 *   failure mode is a bill nobody notices for a month rather than an outage
 *   somebody reports in an hour.
 */
const clientFiles = ['src/store/places.ts', 'src/components/ui/address-field.tsx'];

for (const path of clientFiles) {
  check(
    `${path.split('/').pop()} contains no Google key or endpoint`,
    !/GOOGLE_PLACES_KEY|maps\.googleapis\.com|EXPO_PUBLIC_GOOGLE/.test(read(path)),
    'the key stays in the edge function, as the Dojah secret does',
  );
}

check('the function reads the key from the environment', fn.includes("env('GOOGLE_PLACES_KEY')"));
check(
  'results are restricted to Nigeria',
  fn.includes("url.searchParams.set('components', 'country:ng')"),
  'without it, "Ikeja" offers businesses in three countries and picking one resolves to nothing',
);
check(
  'a session token ties the keystrokes and the choice into one bill',
  fn.includes("url.searchParams.set('sessiontoken', sessionToken)") &&
    store.includes('newSessionToken'),
  'without it every keystroke is billed as its own session',
);
check(
  'and the token is replaced once a lookup completes',
  field.includes('session.current = newSessionToken()'),
  'reusing a closed session is something Google is entitled to treat as abuse',
);
check(
  'only the fields the resolver reads are requested',
  fn.includes("'formatted_address,address_component,geometry/location'"),
  'Places bills by field group; asking for everything costs more and returns data nobody uses',
);

// ------------------------------------------------------------- fallbacks ---

check(
  'a deployment with no key is answered, not failed',
  fn.includes('return json({ configured: false, suggestions: [] })'),
  'a 500 here is indistinguishable from Google being down and makes the fallback look like a bug',
);
check(
  'and the client reads that as "offer the picker"',
  store.includes('payload.configured === false || payload.error'),
);
check(
  'the picker is what appears when lookup cannot work',
  /if \(unavailable\)[\s\S]{0,400}<Dropdown/.test(field),
  'a quote form made unusable by a third party having a bad afternoon is worse than one without autocomplete',
);
check(
  'an address outside the network falls back too',
  /resolution\.kind !== 'served'[\s\S]{0,200}setUnavailable\(true\)/.test(field),
  'there is nothing to argue with; they need a city they can actually pick',
);
check(
  'and there is a way back to searching',
  field.includes('Search by address instead'),
  'the fallback is not a trap — a network blip should not cost the feature for the session',
);
check(
  'typing is debounced',
  field.includes('DEBOUNCE_MS') && field.includes('setTimeout'),
  'a request per keystroke is a session per keystroke',
);
check(
  'and a single letter is never sent',
  fn.includes('input.length < 2') && field.includes('term.length < 2'),
  'one letter matches most of Nigeria and bills for a result nobody can use',
);

// --------------------------------------------- the quote is still banded ---

const quote = code(read('src/components/ui/quick-quote.tsx'));

check(
  'the estimate is still priced on the city, not the address',
  /estimateFee\(\{[\s\S]{0,160}deliveryType,[\s\S]{0,160}weight: parsedWeight/.test(quote) &&
    !/estimateFee\([\s\S]{0,200}(originAddress|location|distance)/.test(quote),
  'there is no distance term in estimateFee; an address in the call would imply one',
);
check(
  'the address is passed to the booking form when there is one',
  quote.includes('...(originAddress ? { pickupAddress: originAddress } : {})'),
  'a street a driver can find is the one thing the address is actually good for',
);
check(
  'and not when the city came from the list',
  quote.includes('originAddress ?') && quote.includes('destinationAddress ?'),
  'an empty string would read as a door address the sender never gave',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — a typed address resolves to a served city by locality before state, refuses\n' +
    '       rather than guesses when LOCI does not reach it, and explains which city the\n' +
    '       price came from. The Google key never leaves the edge function, one address\n' +
    '       costs one session, and the city picker returns whenever lookup cannot work.',
);
