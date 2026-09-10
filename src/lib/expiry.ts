/**
 * Expiry dates: parsing what a driver types, and saying what it means.
 *
 * Pure, and separate from any component, because these are the rules a driver's
 * ability to earn now depends on — an expired licence stops dispatch — and they
 * should be testable without a screen, a clock or a database.
 *
 * ⚠ Typed, not picked, and that is deliberate.
 *
 *   `DeparturePicker` offers the next fourteen days because a journey departs
 *   soon. A licence expires in 2029. Scrolling a wheel from today to a date
 *   four years out is worse than typing eight digits, and the driver is holding
 *   the document with the date printed on it while they do it.
 *
 * ⚠ Day-first, because Nigeria writes dates day-first.
 *
 *   `03/04/2029` is 3 April here and 4 March in an American reading. Getting
 *   this backwards would not error — it would silently store a date up to
 *   eleven months wrong, fire reminders on the wrong day, and block a driver
 *   whose licence is perfectly valid. So the input is masked to DD/MM/YYYY and
 *   the parsed result is echoed back in an unambiguous long form ("3 April
 *   2029") for the driver to check against the card in their hand.
 */

/** How the server wants it: an ISO calendar date, no time, no zone. */
export type IsoDate = string;

/** Digits only, then grouped. Anything else the keyboard produced is dropped. */
export function maskExpiryInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

export type ParsedExpiry =
  { ok: true; iso: IsoDate; pretty: string } | { ok: false; error: string } | { ok: null };

/**
 * Turns `DD/MM/YYYY` into an ISO date, or says why it cannot.
 *
 * Returns `{ ok: null }` for an incomplete entry rather than an error: a field
 * that turns red on the third keystroke is a field that is shouting at somebody
 * who is still typing.
 */
export function parseExpiry(input: string, today = new Date()): ParsedExpiry {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 0) return { ok: null };
  if (digits.length < 8) return { ok: null };

  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const year = Number(digits.slice(4, 8));

  if (month < 1 || month > 12) return { ok: false, error: 'That month does not exist.' };
  if (day < 1 || day > 31) return { ok: false, error: 'That day does not exist.' };

  /*
   * Built in UTC and checked by round-trip.
   *
   * `new Date(2029, 1, 30)` silently becomes 2 March — JavaScript rolls
   * overflow rather than refusing it, so 30 February would be accepted and
   * stored as a date the driver never typed. Comparing the components back is
   * the only way to catch it.
   */
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, error: 'There is no such date in that month.' };
  }

  const startOfToday = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );

  if (date < startOfToday) {
    return {
      ok: false,
      // The server refuses this too. Saying so here means the driver finds out
      // while the document is still in their hand rather than after an upload.
      error: 'That date has already passed. Please use a current document.',
    };
  }

  /*
   * A ceiling, because a typo in the year is the likeliest mistake here and the
   * one with the worst consequences: `2029` mistyped as `2209` produces a
   * document that never expires, never prompts a renewal, and never blocks
   * dispatch. Fifty years is comfortably past any real licence.
   */
  if (year > today.getUTCFullYear() + 50) {
    return { ok: false, error: 'Check the year on that date.' };
  }

  return { ok: true, iso: date.toISOString().slice(0, 10), pretty: prettyDate(date) };
}

/** "3 April 2029" — unambiguous in a way DD/MM and MM/DD are not. */
export function prettyDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function prettyIso(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? iso : prettyDate(date);
}

/** `DD/MM/YYYY` for an ISO date, so an existing value can be edited. */
export function isoToInput(iso: string | null): string {
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return year && month && day ? `${day}/${month}/${year}` : '';
}

export type ExpiryState = 'missing' | 'none' | 'ok' | 'expiring' | 'expired';

/**
 * How urgent this document is, and what to say about it.
 *
 * Mirrors `document_state` in `supabase/migrations/20250101000031_document_expiry.sql`. The server is
 * the authority — it is what actually gates dispatch — and this exists so a
 * screen can colour a row without a round trip. They are asserted to agree.
 */
export function expiryTone(state: ExpiryState): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'expired':
      return 'danger';
    case 'expiring':
      return 'warning';
    case 'ok':
      return 'success';
    default:
      return 'neutral';
  }
}

/**
 * The sentence under a document row.
 *
 * ⚠ An expired *blocking* document says what it costs, in the same breath.
 *
 *   "Expired" alone is a status. "Expired — you are not being offered parcels
 *   until you upload a renewal" is the only version that explains why the work
 *   stopped, and a driver who cannot connect those two facts concludes the app
 *   is broken rather than that their licence lapsed.
 */
export function expiryMessage(args: {
  state: ExpiryState;
  daysLeft: number | null;
  expiresAt: string | null;
  blocksDispatch: boolean;
  /** False for slots that carry no date at all — NIN, guarantor ID, vehicle photo. */
  expiryAllowed: boolean;
}): string {
  const { state, daysLeft, expiresAt, blocksDispatch, expiryAllowed } = args;

  if (state === 'missing') return 'Not uploaded yet.';

  /*
   * ⚠ Two different absences, and they must not share a sentence.
   *
   *   A NIN slip has no expiry because none exists to record. A licence with a
   *   blank date has one printed on it that Package Relay never asked for. "No expiry
   *   date recorded" is true of both and useful for neither: on the NIN it
   *   reads as a gap the driver should close and cannot, and on the licence it
   *   fails to say that closing it is exactly what is wanted.
   *
   *   This became load-bearing when the government ID slots stopped carrying
   *   dates — three of the five rows now hit the first branch.
   */
  if (!expiryAllowed) return 'This document does not expire.';
  if (state === 'none' || expiresAt === null) {
    return 'No expiry date recorded yet — add the date printed on it.';
  }

  if (state === 'expired') {
    const ago =
      daysLeft === null
        ? ''
        : ` ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} ago`;
    return blocksDispatch
      ? `Expired${ago}. You are not being offered parcels until you upload a renewal.`
      : `Expired${ago} — please upload a current one.`;
  }

  if (state === 'expiring') {
    if (daysLeft === 0) return `Expires today (${prettyIso(expiresAt)}). Renew it now.`;
    const days = `${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    return blocksDispatch
      ? `Expires in ${days}, on ${prettyIso(expiresAt)}. After that you stop receiving parcels.`
      : `Expires in ${days}, on ${prettyIso(expiresAt)}.`;
  }

  return `Valid until ${prettyIso(expiresAt)}.`;
}
