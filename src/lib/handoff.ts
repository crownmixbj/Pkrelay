/**
 * Handing off to the phone's own apps.
 *
 * A delivery app cannot do turn-by-turn navigation well — it needs live traffic,
 * road data and a routing engine, and a half-built version of that is worse than
 * none. So Package Relay does not try: it hands the destination to Google Maps and the
 * number to the dialler, which are already installed, already trusted with
 * location, and already what the driver uses.
 *
 * Pure string builders, so the awkward parts (a Nigerian number written six
 * different ways, an address with a comma in it) can be tested without a device.
 */

/** Where the driver is going. Coordinates when we have them, text otherwise. */
export type Destination = {
  lat: number | null;
  lng: number | null;
  address: string;
};

/**
 * A Google Maps directions link.
 *
 * The universal `?api=1` form, which is the documented cross-platform one: on a
 * phone it opens the Google Maps app when installed and the web map when not,
 * and it needs no API key.
 *
 * Coordinates win over the address whenever we have them. A typed Nigerian
 * address geocodes badly — plenty of streets share a name across states, and
 * "No 14, off Ring Road" resolves to nothing at all — so a pin the sender
 * actually dropped is worth more than the words next to it.
 */
export function navigationUrl(destination: Destination): string {
  const hasPin =
    typeof destination.lat === 'number' &&
    typeof destination.lng === 'number' &&
    Number.isFinite(destination.lat) &&
    Number.isFinite(destination.lng);

  const target = hasPin ? `${destination.lat},${destination.lng}` : destination.address.trim();

  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    target,
  )}&travelmode=driving`;
}

/**
 * Normalises a Nigerian phone number to something a dialler will accept.
 *
 * Numbers reach us however the sender typed them: `0803 123 4567`,
 * `+234 803 123 4567`, `234-803-123-4567`. The dialler wants one shape, and a
 * driver standing at a gate is not going to retype it.
 *
 * Returns null when there is nothing dialable, so the caller can hide the
 * button rather than offer one that does nothing.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const explicitlyInternational = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7) return null;

  if (explicitlyInternational) return `+${digits}`;
  if (digits.startsWith('234')) return `+${digits}`;

  // 0803… — the local form, which is by far the most common thing typed.
  if (digits.startsWith('0') && digits.length === 11) return `+234${digits.slice(1)}`;

  // Anything else is passed through unchanged. Guessing a country code for a
  // number we do not recognise is how you dial a stranger.
  return digits;
}

/** A `tel:` URL, or null when the number is unusable. */
export function dialUrl(raw: string): string | null {
  const number = normalizePhone(raw);
  return number ? `tel:${number}` : null;
}
