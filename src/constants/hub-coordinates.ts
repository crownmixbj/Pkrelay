import type { City } from '@/store/bookings';

/**
 * Approximate centre of each hub city, in decimal degrees.
 *
 * Sourced from published city-centre coordinates and rounded to four decimal
 * places (~11 m), which is far finer than this is used for. These locate the
 * *city*, not a Package Relay depot — once real hub addresses exist, replace these with
 * the depot coordinates rather than adjusting them by hand.
 */
export const HUB_COORDINATES: Record<City, { lat: number; lon: number }> = {
  Abakaliki: { lat: 6.3249, lon: 8.1137 },
  Abeokuta: { lat: 7.1557, lon: 3.3451 },
  Abuja: { lat: 9.0765, lon: 7.3986 },
  'Ado-Ekiti': { lat: 7.6211, lon: 5.2214 },
  Akure: { lat: 7.2571, lon: 5.2058 },
  Asaba: { lat: 6.2059, lon: 6.6959 },
  Awka: { lat: 6.212, lon: 7.0741 },
  Bauchi: { lat: 10.3158, lon: 9.8442 },
  'Benin City': { lat: 6.335, lon: 5.6037 },
  'Birnin Kebbi': { lat: 12.4539, lon: 4.1975 },
  Calabar: { lat: 4.9757, lon: 8.3417 },
  Damaturu: { lat: 11.7469, lon: 11.9608 },
  Dutse: { lat: 11.7565, lon: 9.3387 },
  Enugu: { lat: 6.5244, lon: 7.5186 },
  Gombe: { lat: 10.2897, lon: 11.1673 },
  Gusau: { lat: 12.1628, lon: 6.6614 },
  Ibadan: { lat: 7.3775, lon: 3.947 },
  Ilorin: { lat: 8.4966, lon: 4.5421 },
  Jalingo: { lat: 8.8933, lon: 11.3667 },
  Jos: { lat: 9.8965, lon: 8.8583 },
  Kaduna: { lat: 10.5222, lon: 7.4383 },
  Kano: { lat: 12.0022, lon: 8.592 },
  Katsina: { lat: 12.9908, lon: 7.6018 },
  Lafia: { lat: 8.4939, lon: 8.5157 },
  Lagos: { lat: 6.5244, lon: 3.3792 },
  Lokoja: { lat: 7.8023, lon: 6.7333 },
  Maiduguri: { lat: 11.8311, lon: 13.151 },
  Makurdi: { lat: 7.7322, lon: 8.5391 },
  Minna: { lat: 9.6139, lon: 6.5569 },
  Osogbo: { lat: 7.7827, lon: 4.5418 },
  Owerri: { lat: 5.4836, lon: 7.0333 },
  'Port Harcourt': { lat: 4.8156, lon: 7.0498 },
  Sokoto: { lat: 13.0059, lon: 5.2476 },
  Umuahia: { lat: 5.5249, lon: 7.4944 },
  Uyo: { lat: 5.0377, lon: 7.9128 },
  Yenagoa: { lat: 4.9267, lon: 6.2676 },
  Yola: { lat: 9.2035, lon: 12.4954 },
};

/**
 * Great-circle distance in kilometres.
 *
 * Straight-line, not driving distance — Nigerian road routes run longer than
 * the crow flies, so `ROAD_FACTOR` below is what turns this into something a
 * driver can act on.
 */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Roads are longer than straight lines. 1.25 is the common detour index for
 * inter-city routes on a reasonably developed network; it keeps the estimate
 * honest without pretending to be a routing engine.
 */
const ROAD_FACTOR = 1.25;

/**
 * Rough road distance between two hubs, or null when both ends are the same
 * city — a local job's real distance depends on the two areas within that city,
 * which we don't have coordinates for, and "0 km" would be a lie.
 */
export function routeDistanceKm(origin: City, destination: City): number | null {
  if (origin === destination) return null;
  const a = HUB_COORDINATES[origin];
  const b = HUB_COORDINATES[destination];
  if (!a || !b) return null;
  return haversineKm(a, b) * ROAD_FACTOR;
}

/** "~130 km" — deliberately rounded, and marked as an estimate. */
export function formatDistance(km: number): string {
  const rounded = km >= 100 ? Math.round(km / 10) * 10 : Math.round(km);
  return `~${rounded} km`;
}
