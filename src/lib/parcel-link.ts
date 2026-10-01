/**
 * Which parcel a link is pointing at.
 *
 * ⚠ Two identifier shapes reach `/parcel/[id]`, and matching only one is how
 *   every emailed tracking link broke.
 *
 *   In-app navigation uses the row's uuid — `/parcel/${booking.id}` in
 *   tracking, parcel-confirmed, the driver hub and the notification centre.
 *   The email templates in `notify-events/templates.ts` use the tracking id,
 *   because that is the string a person can read out over the phone and a uuid
 *   is not. Both are legitimate. The screen has to accept both, and emails
 *   already delivered mean it always will — a link in an August delivery notice
 *   cannot be reissued.
 *
 * ⚠ A leaf module on purpose: it imports nothing.
 *
 *   It lived in `store/bookings.tsx` first, which drags React, the Supabase
 *   client and the whole booking model into anything that wants to test this
 *   rule. The rule is three lines of string comparison and deserves to be
 *   checkable as such — the same reasoning that keeps `payoutStatusLine` out of
 *   the wallet screen.
 *
 * Structurally typed rather than importing `Booking`, so there is no import at
 * all; any row with the two fields resolves, and callers keep their own type.
 */
export type ParcelIdentity = {
  id: string;
  trackingId: string;
};

export function findParcel<T extends ParcelIdentity>(
  parcels: readonly T[],
  identifier: string | null | undefined,
): T | undefined {
  const key = (identifier ?? '').trim();
  if (!key) return undefined;

  /*
   * uuid first. It is exact and genuinely unique, where a tracking id is
   * compared case-insensitively and is unique only because the generator says
   * so — so when a string could be read as either, the stronger claim wins.
   */
  return (
    parcels.find((parcel) => parcel.id === key) ??
    parcels.find((parcel) => parcel.trackingId.toLowerCase() === key.toLowerCase())
  );
}
