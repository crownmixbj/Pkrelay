import { isCarrier, isFinished, type Booking } from '@/store/bookings';

/**
 * What a driver has earned, and what they are still owed for work in progress.
 *
 * ⚠ "Expected", never "earned", and the distinction is the whole reason this
 *   file is careful.
 *
 *   Every figure here is the *quoted fare* on a parcel — what the sender was
 *   charged, gross. It is not a balance, and it is not what this driver will be
 *   paid.
 *
 * ⚠ There is now a ledger, and that made this file *more* dangerous rather than
 *   less.
 *
 *   `supabase/migrations/20250101000030_driver_wallet.sql` credits `driver_earnings` on delivery, net
 *   of the commission rate recorded on the row, and `driver_balance` subtracts
 *   a security hold and any open payout. So the wallet and this module will
 *   routinely disagree, in three compounding ways at once:
 *
 *     · this counts parcels still moving; the ledger credits only on delivery
 *     · this is gross; the ledger is net of commission
 *     · the ledger holds new money for a day, and subtracts open requests
 *
 *   A driver seeing "Expected ₦12,000" here and "Available ₦0" in the wallet
 *   has not found a bug, but they have found a contradiction — and being told
 *   two different numbers about your own money is worse than being told one
 *   vague one. Every screen showing this total therefore names it as a quote
 *   *and* points at the wallet as the figure that counts. Neither half alone is
 *   enough.
 */

export type EarningsEntry = {
  bookingId: string;
  trackingId: string;
  itemDescription: string;
  route: string;
  fee: number;
  /** When it was delivered. Null on rows that predate the timestamp. */
  deliveredAt: string | null;
  /** The stage a still-moving parcel is on. Null once delivered. */
  stage: string | null;
};

export type EarningsSummary = {
  delivered: { count: number; total: number; entries: EarningsEntry[] };
  inProgress: { count: number; total: number; entries: EarningsEntry[] };
  /** Delivered plus in progress — the figure on the summary card. */
  total: number;
};

const routeOf = (booking: Booking) =>
  booking.originCity === booking.destinationCity
    ? `${booking.pickupArea} → ${booking.dropoffArea}, ${booking.originCity}`
    : `${booking.pickupArea}, ${booking.originCity} → ${booking.dropoffArea}, ${booking.destinationCity}`;

const toEntry = (booking: Booking, delivered: boolean): EarningsEntry => ({
  bookingId: booking.id,
  trackingId: booking.trackingId,
  itemDescription: booking.itemDescription,
  route: routeOf(booking),
  fee: booking.estimatedFee,
  deliveredAt: booking.deliveredAt,
  stage: delivered ? null : booking.status,
});

/**
 * Everything this driver is carrying or has carried, split by whether it landed.
 *
 * ⚠ Cancelled parcels are excluded from both sides.
 *
 *   A cancelled job is not in progress and was never delivered, so counting it
 *   anywhere would either inflate what a driver is owed or imply a delivery
 *   that did not happen. `isFinished` covers Delivered and Cancelled together,
 *   so the delivered side checks the status explicitly rather than reusing it.
 *
 * The filter is on `driverId`, so this is the authenticated driver's own work —
 * the same predicate the Assigned Trip screen uses, and the same one RLS
 * enforces server-side. A row for somebody else's parcel could not be read in
 * the first place.
 */
export function earningsSummary(bookings: Booking[], viewerId: string | null): EarningsSummary {
  if (!viewerId) {
    return {
      delivered: { count: 0, total: 0, entries: [] },
      inProgress: { count: 0, total: 0, entries: [] },
      total: 0,
    };
  }

  const mine = bookings.filter((booking) => isCarrier(booking, viewerId));

  const deliveredEntries = mine
    .filter((booking) => booking.status === 'Delivered')
    .map((booking) => toEntry(booking, true))
    /*
     * Newest first, by when it was delivered.
     *
     * Rows without a `deliveredAt` sort to the bottom rather than to the top:
     * an unknown date is not a recent one, and putting it first would push
     * today's work below a parcel from before the column existed.
     */
    .sort((a, b) => {
      if (!a.deliveredAt) return 1;
      if (!b.deliveredAt) return -1;
      return Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt);
    });

  const inProgressEntries = mine
    .filter((booking) => !isFinished(booking))
    .map((booking) => toEntry(booking, false));

  const sum = (entries: EarningsEntry[]) => entries.reduce((running, e) => running + e.fee, 0);

  const delivered = {
    count: deliveredEntries.length,
    total: sum(deliveredEntries),
    entries: deliveredEntries,
  };
  const inProgress = {
    count: inProgressEntries.length,
    total: sum(inProgressEntries),
    entries: inProgressEntries,
  };

  return { delivered, inProgress, total: delivered.total + inProgress.total };
}

/**
 * A delivery timestamp a driver can read at a glance.
 *
 * Date and time, because two parcels delivered on the same day are common and
 * the order they landed in is the thing being checked.
 */
export function deliveredLabel(iso: string | null): string {
  if (!iso) return 'Date not recorded';

  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return 'Date not recorded';

  return when.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
