/**
 * When something happened, written the same way everywhere.
 *
 * ⚠ One clock for everybody, and it is Lagos.
 *
 *   Package Relay runs in Nigeria only: the sender, the driver, the hub and the
 *   parcel are all in the same zone. Rendering in the *reader's* zone — which is
 *   what `toLocaleString()` does, and what nine screens were each doing their own
 *   way — means a support console in Dublin shows 15:35 for a pickup the driver
 *   saw at 14:35, with nothing on screen to say which is which. For a question
 *   like "when was this parcel collected", two numbers is one too many.
 *
 * ⚠ No `Intl` time zone, deliberately.
 *
 *   `Intl.DateTimeFormat(..., { timeZone: 'Africa/Lagos' })` is the obvious way
 *   to do this and it is not safe here: Hermes ships without full ICU on some
 *   builds, where an unsupported zone throws `RangeError` at runtime — on a
 *   phone, in the field, on a screen that was fine in the simulator. West Africa
 *   Time is UTC+1 all year (Nigeria has never observed daylight saving), so the
 *   arithmetic below is exact, dependency-free and identical on every engine.
 */

/** Minutes WAT runs ahead of UTC. Fixed: Nigeria does not observe DST. */
const WAT_OFFSET_MINUTES = 60;

/** Appended so a reader never has to guess whose clock this is. */
export const TIME_ZONE_LABEL = 'WAT';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * The instant, shifted into WAT and then read with UTC getters.
 *
 * Shifting the value and reading it as UTC is the trick that avoids both the
 * device's own zone and `Intl`: after adding the offset, `getUTCHours()` is the
 * Lagos hour by construction.
 */
function inLagos(iso: string): Date | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;

  return new Date(parsed.getTime() + WAT_OFFSET_MINUTES * 60_000);
}

const pad = (value: number): string => value.toString().padStart(2, '0');

/**
 * The Lagos wall clock, for code that reasons about *now* rather than renders a
 * stamp — "is this hub open", and anything else that compares against a
 * schedule written in local opening hours.
 *
 * `weekday` is 0 = Sunday, matching `Date.getDay()`.
 */
export function lagosNow(date: Date = new Date()): {
  weekday: number;
  hour: number;
  minute: number;
} {
  const shifted = new Date(date.getTime() + WAT_OFFSET_MINUTES * 60_000);

  return {
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/**
 * `2 Oct 2026` — a date with no time, for the few rows too narrow to carry one.
 *
 * Returns an empty string for anything unparseable, so a missing timestamp
 * renders as nothing rather than as "Invalid Date" in front of a customer.
 */
export function formatDay(iso: string | null | undefined): string {
  const date = iso ? inLagos(iso) : null;
  if (!date) return '';

  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** `14:35 WAT` — the time alone, for a line that already says which day. */
export function formatClock(iso: string | null | undefined): string {
  const date = iso ? inLagos(iso) : null;
  if (!date) return '';

  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} ${TIME_ZONE_LABEL}`;
}

/**
 * `2 Oct 2026, 14:35 WAT` — the full stamp, and the default.
 *
 * 24-hour because this is the reading that settles a dispute, and "2:35" with
 * no am/pm is the one mistake a timestamp must not make.
 */
export function formatStamp(iso: string | null | undefined): string {
  const date = iso ? inLagos(iso) : null;
  if (!date) return '';

  return `${formatDay(iso)}, ${formatClock(iso)}`;
}
