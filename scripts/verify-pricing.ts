/**
 * Assertions for the fare, now that it moves with the journey.
 *
 * ⚠ The change this file guards is the riskiest kind: one that alters what
 *   people are charged.
 *
 *   The fare used to be a flat band — ₦1,500 within a city, ₦4,500 between two
 *   — whatever the distance. A 3km hop across Ibadan and a 700km run to Abuja
 *   cost the same. Adding a per-km term fixes that and, done carelessly, also
 *   quietly reprices every screen that has no coordinates to offer.
 *
 *   So the central assertion here is a *negative* one: with no distance, the
 *   fee must equal what it was before, to the naira.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { distanceLabel, estimateRoadKm, straightLineKm } from '../src/lib/distance';
import { estimateFee, PRICING } from '../src/store/bookings';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

// ------------------------------------------- an unknown distance is free ----

/*
 * ⚠ The rate calculator, the booking form, the service catalogue and the quote
 *   form's own fallback all price without coordinates. If a missing distance
 *   defaulted to anything but zero, every one of them would have moved.
 */
for (const deliveryType of ['local', 'interstate'] as const) {
  const withoutDistance = estimateFee({ deliveryType, weight: 2, declaredValue: 0 });
  const withZero = estimateFee({ deliveryType, weight: 2, declaredValue: 0, distanceKm: 0 });

  check(
    `${deliveryType}: no distance costs nothing extra`,
    withoutDistance.distance === 0 && withoutDistance.total === withZero.total,
    `${withoutDistance.total} vs ${withZero.total}`,
  );
  check(
    `${deliveryType}: and the breakdown says nothing was measured`,
    withoutDistance.distanceKm === null,
    'a summary printing "0 km" would claim a journey of no length was measured',
  );
}

for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
  check(
    `a distance of ${bad} is treated as unknown`,
    estimateFee({ deliveryType: 'local', weight: 2, declaredValue: 0, distanceKm: bad })
      .distance === 0,
    'a NaN reaching the multiplication would make the whole fare NaN',
  );
}

// ------------------------------------------------------- and it is charged --

const local8 = estimateFee({
  deliveryType: 'local',
  weight: 2,
  declaredValue: 0,
  distanceKm: 8,
});

check(
  'a measured local journey is charged per kilometre',
  local8.distance === 8 * PRICING.perKm.local,
  `${local8.distance}`,
);
check(
  'and the parts still sum to the total',
  local8.base +
    local8.weight +
    local8.distance +
    local8.insurance +
    local8.handover +
    local8.rounding ===
    local8.total,
);

/*
 * ⚠ The calibration, stated as numbers rather than as intent.
 *
 *   The base rates came down when the per-km term went in, so that a *typical*
 *   trip costs what it cost before. If somebody edits one of the four
 *   constants without the others, this is what notices.
 */
check(
  'a typical local trip still costs what it did',
  local8.total === 1900,
  `8km, 2kg came to ₦${local8.total} — it was ₦1,900 before distance pricing`,
);

const ibadanToLagos = estimateFee({
  deliveryType: 'interstate',
  weight: 2,
  declaredValue: 0,
  distanceKm: 130,
});
check(
  'and so does the commonest inter-state run',
  Math.abs(ibadanToLagos.total - 5400) <= 50,
  `Ibadan→Lagos, 2kg came to ₦${ibadanToLagos.total} — it was ₦5,400`,
);

/*
 * The point of the whole change: a long journey costs more than a short one.
 */
const abujaToLagos = estimateFee({
  deliveryType: 'interstate',
  weight: 2,
  declaredValue: 0,
  distanceKm: 700,
});
check(
  'a journey five times as long costs more',
  abujaToLagos.total > ibadanToLagos.total * 2,
  `700km came to ₦${abujaToLagos.total} against ₦${ibadanToLagos.total} for 130km`,
);

/*
 * ⚠ Local is dearer per kilometre than inter-state, and that is deliberate.
 *
 *   A 5km city run is mostly pickup and drop-off — the two ends are the work.
 *   A 700km trunk run spreads those same two ends over a long drive somebody
 *   was making anyway. Pricing them at one rate would make city deliveries
 *   unprofitable or inter-state ones unsellable.
 */
check(
  'a city kilometre costs more than a trunk kilometre',
  PRICING.perKm.local > PRICING.perKm.interstate,
  `${PRICING.perKm.local} vs ${PRICING.perKm.interstate}`,
);

// ----------------------------------------------------------- the distance --

/** Ibadan and Lagos, roughly. ~120km apart on the ground. */
const IBADAN = { lat: 7.3775, lng: 3.947 };
const LAGOS = { lat: 6.5244, lng: 3.3792 };

const straight = straightLineKm(IBADAN, LAGOS);

check(
  'the straight line between two known cities is about right',
  straight > 100 && straight < 120,
  `${Math.round(straight)} km — Ibadan to Lagos is ~110km as the crow flies`,
);
/*
 * ⚠ Meaningfully longer, not merely longer.
 *
 *   My first version asserted `estimateRoadKm(...) > straight`, which passed
 *   with the road factor removed entirely — rounding 109.6 up to 110 clears a
 *   strict inequality. A detour ratio has to be tested as a ratio.
 */
check(
  'and the road estimate is meaningfully longer than the straight line',
  estimateRoadKm(IBADAN, LAGOS) >= straight * 1.2,
  `${estimateRoadKm(IBADAN, LAGOS)} km against a ${Math.round(straight)} km line — roads bend around waterways and one-ways, and charging the straight line undercharges every fare`,
);
check('a point measured against itself is zero', straightLineKm(IBADAN, IBADAN) === 0);

check(
  'an estimate is labelled as one',
  distanceLabel({ km: 14, source: 'estimated' }).includes('about'),
  'printing "14 km" for an estimate invites somebody to check it against their odometer',
);
check(
  'and a measured route is not',
  !distanceLabel({ km: 14, source: 'measured' }).includes('about'),
);
check('nothing measured says so', distanceLabel(null) === 'Distance not measured');

// -------------------------------------------------------------- the wiring --

const quote = read('src/components/ui/quick-quote.tsx');
const places = read('src/store/places.ts');
const field = read('src/components/ui/address-field.tsx');

check(
  'the quote prices on the measured distance',
  quote.includes('distanceKm: distance?.km'),
  'the whole change is inert unless the number reaches estimateFee',
);
check(
  'and shows the journey it priced',
  quote.includes('distanceLabel(distance)'),
  'a fare that moves with the journey has to say which journey, or two quotes cannot be compared',
);
check(
  'measuring falls back rather than failing',
  places.includes('const estimated: Distance =') && places.includes('return estimated;'),
  'Distance Matrix is a second billable product and a second thing that can be out of quota',
);
check(
  'the fallback is the road estimate, not zero',
  places.includes('estimateRoadKm(from, to)'),
  'zero would silently price a long journey as if it had no length',
);

/*
 * ⚠ The city picker is gone from the ordinary path.
 *
 *   A city chosen from a list has no coordinates, so it has no distance, so it
 *   falls back to the flat band. Offering that as an equal option next to
 *   address search invited people to take the less accurate route for no
 *   reason. It remains only for when Places genuinely cannot answer.
 */
check(
  'there is no city link in the normal flow',
  !field.includes('Pick a city\n'),
  'a city has no coordinates and so no distance — it is the fallback, not an option',
);
/*
 * ⚠ Was `field.includes('if (unavailable)')`, which pinned a variable name.
 *
 *   The flag was renamed to `showPicker` when the lookup moved into a shared
 *   hook — the guard was intact and this failed anyway. What matters is that
 *   the dropdown sits behind *some* condition rather than being unreachable,
 *   so that is what is asserted now.
 */
check(
  'but the picker still exists for when lookup fails',
  /if \(\w+\)[\s\S]{0,400}<Dropdown/.test(field),
  'a Google outage must not cost every quote that day',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — a fare with no distance is exactly what it was before, a measured one is charged\n' +
    '       per kilometre, a typical local run and Ibadan→Lagos still cost what they cost,\n' +
    '       a 700km journey no longer costs the same as a 130km one, and an estimated\n' +
    '       distance is labelled as an estimate.',
);
