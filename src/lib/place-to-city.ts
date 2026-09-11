import { cityForState, CITIES, type City } from '@/store/bookings';

/**
 * Turning "14 Allen Avenue, Ikeja" into a city Package Relay actually serves.
 *
 * ⚠ The quote is banded, not measured, and this is the whole reason this file
 *   is small.
 *
 *   `estimateFee` charges `base + weight × perKg`, where both come from
 *   comparing two cities: same city is local, different is inter-state.
 *   Distance never enters it. So an address is not an input to the price — it
 *   is a friendlier way of *choosing the city*, and everything below exists to
 *   get from what somebody typed to one of the 37 names the pricing knows.
 *
 *   Which also means a wrong answer here is not a rounding error. Resolving
 *   Ikeja to the wrong city moves a quote between ₦1,500 and ₦4,500 flat, so
 *   the rules prefer "we do not serve this" over a confident guess.
 */

/** One address component, in the shape Google returns. */
export type AddressComponent = {
  longName: string;
  shortName: string;
  types: string[];
};

export type PlaceResolution =
  /** A city the pricing knows, and how confident we are about it. */
  | { kind: 'served'; city: City; via: 'locality' | 'state' }
  /** In Nigeria, but nowhere Package Relay operates. */
  | { kind: 'unserved'; describedAs: string }
  /** Nothing usable in the components at all. */
  | { kind: 'unknown' };

const normalise = (value: string) =>
  value
    .trim()
    .toLowerCase()
    /*
      "Lagos State" and "Lagos" are the same place to a person and different
      strings to a computer. Google returns the long name with the suffix and
      the short name usually without it.
    */
    .replace(/\s+state$/, '')
    .replace(/[^a-z\s-]/g, '')
    .replace(/\s+/g, ' ');

const CITY_BY_NAME = new Map<string, City>(CITIES.map((city) => [normalise(city), city]));

/** "Lagos State" → "Lagos". Case is preserved: `cityForState` matches exactly. */
function withoutStateSuffix(value: string): string {
  return value.trim().replace(/\s+state$/i, '');
}

function pick(components: AddressComponent[], type: string): AddressComponent | undefined {
  return components.find((component) => component.types.includes(type));
}

/**
 * ⚠ Locality first, state second, and the order is not interchangeable.
 *
 *   A Nigerian address usually reports the town in `locality` and the state in
 *   `administrative_area_level_1`. Reading the state first would send every
 *   address in Oyo to Ibadan — correct for most of the state and wrong for
 *   anybody in a town Package Relay also serves separately.
 *
 *   `administrative_area_level_2` is consulted between the two because Google
 *   frequently files Nigerian towns there rather than in `locality`, and
 *   ignoring it drops perfectly ordinary addresses to their state's default.
 */
export function resolvePlaceCity(components: AddressComponent[]): PlaceResolution {
  for (const type of ['locality', 'administrative_area_level_2', 'administrative_area_level_3']) {
    const component = pick(components, type);
    if (!component) continue;

    const match =
      CITY_BY_NAME.get(normalise(component.longName)) ??
      CITY_BY_NAME.get(normalise(component.shortName));

    if (match) return { kind: 'served', city: match, via: 'locality' };
  }

  /*
   * The state, as a fallback rather than a first answer.
   *
   * `cityForState` is the same map the driver application uses to decide which
   * city a new driver works out of, so a parcel and a driver in the same state
   * agree on where that is. Somebody in a village in Oyo gets Ibadan, which is
   * where their parcel would actually be handled.
   */
  const state = pick(components, 'administrative_area_level_1');
  if (state) {
    /*
      ⚠ The " State" suffix has to come off before the lookup.

        `cityForState` is keyed on the names the driver application uses —
        "Lagos", "Oyo" — and Google returns "Lagos State". Passing the long name
        straight through matched nothing, so every address that reached this
        fallback was reported as unserved. The short name is not a reliable
        substitute either: Google abbreviates some of them.
    */
    const viaState =
      cityForState(withoutStateSuffix(state.longName)) ??
      cityForState(withoutStateSuffix(state.shortName));

    if (viaState) return { kind: 'served', city: viaState, via: 'state' };

    return { kind: 'unserved', describedAs: state.longName };
  }

  return { kind: 'unknown' };
}

/**
 * The line shown under the field once a suggestion is taken.
 *
 * ⚠ It names the city the price is based on, not just the address.
 *
 *   Somebody who types a street in Ikeja and sees a Lagos rate needs to be able
 *   to see *why* — otherwise the number looks arbitrary and the first support
 *   question is "why does my quote say Lagos". Saying which of the two things
 *   the price came from turns a surprise into an explanation.
 */
export function resolutionSummary(resolution: PlaceResolution): string {
  if (resolution.kind === 'served') {
    return resolution.via === 'locality'
      ? `Priced as ${resolution.city}`
      : `Priced as ${resolution.city}, the nearest city we serve`;
  }

  if (resolution.kind === 'unserved') {
    return `Package Relay does not deliver in ${resolution.describedAs} yet — pick a city instead.`;
  }

  return 'That address could not be matched to a city — pick one instead.';
}
