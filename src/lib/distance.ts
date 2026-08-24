export type Point = { lat: number; lng: number };

/**
 * How far apart two points are, when nothing has measured the road.
 *
 * ⚠ A straight line is not a journey, and the factor below is the admission.
 *
 *   Great-circle distance between two Nigerian addresses is reliably shorter
 *   than the drive: roads bend around waterways, one-ways and the Lagos
 *   lagoons. Charging the straight line would systematically undercharge every
 *   fare that reaches this path.
 *
 *   1.3 is the usual road-network detour ratio for cities laid out like these.
 *   It is an estimate and is labelled as one wherever it reaches a person —
 *   the quote says "about", because a number presented to the naira implies a
 *   precision this does not have.
 */
const ROAD_FACTOR = 1.3;

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle kilometres. Exported for the tests; callers want `estimateRoadKm`. */
export function straightLineKm(from: Point, to: Point): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** The straight line, bent by the usual amount, rounded to a whole kilometre. */
export function estimateRoadKm(from: Point, to: Point): number {
  return Math.round(straightLineKm(from, to) * ROAD_FACTOR);
}

export type DistanceSource = 'measured' | 'estimated';

export type Distance = {
  km: number;
  source: DistanceSource;
};

/**
 * What to tell somebody about the distance their fare is based on.
 *
 * ⚠ A measured route and an estimate are described differently on purpose.
 *
 *   Both are a number of kilometres and only one of them was driven. Printing
 *   "14 km" for an estimate invites somebody to check it against their
 *   odometer and conclude the fare is wrong, when the honest claim was always
 *   "about 14".
 */
export function distanceLabel(distance: Distance | null): string {
  if (!distance) return 'Distance not measured';
  return distance.source === 'measured' ? `${distance.km} km` : `about ${distance.km} km`;
}
