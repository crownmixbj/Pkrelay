import { supabase } from '@/lib/supabase';
import type { Booking, BookingStage } from '@/store/bookings';

/**
 * Who can call off a parcel, and until when.
 *
 * The rule lives in `supabase/migrations/20250101000011_cancellation.sql` — `cancellation_allowed`.
 * This is the client's copy of it, used only to decide whether to *show* a
 * button. Every attempt is re-checked on the server, so a modified client gains
 * nothing but a button that returns an error.
 *
 * Two windows, both closing at the moment somebody else's effort is committed:
 *
 *   sender  while the parcel is still 'Booked'. Once a driver claims it,
 *           someone may already be riding towards the pickup.
 *   driver  while the parcel is still 'Assigned'. Once it is 'Picked Up' the
 *           driver is holding someone else's property, and there is no flow in
 *           this app for handing it back.
 */

export type CancelRole = 'sender' | 'driver';

/** Mirrors `public.cancellation_allowed`. Keep the two in step. */
export function cancellationAllowed(status: BookingStage, role: CancelRole): boolean {
  return role === 'sender' ? status === 'Booked' : status === 'Assigned';
}

/** Which role, if either, this viewer holds on this parcel. */
export function cancelRoleFor(booking: Booking, viewerId: string | null): CancelRole | null {
  if (!viewerId) return null;
  if (booking.senderId === viewerId) return 'sender';
  if (booking.driverId === viewerId) return 'driver';
  return null;
}

/** Whether to show a cancel control at all. */
export function canCancel(booking: Booking, viewerId: string | null): boolean {
  const role = cancelRoleFor(booking, viewerId);
  return role !== null && cancellationAllowed(booking.status, role);
}

/**
 * What the two sides are actually doing, in their own words.
 *
 * A driver is not cancelling the shipment — the parcel survives and returns to
 * the open board for someone else. Calling both actions "cancel" in the UI
 * would tell a driver they had destroyed a sender's parcel, which they have
 * not.
 */
export function cancelActionLabel(role: CancelRole): string {
  return role === 'sender' ? 'Cancel this parcel' : 'Release this job';
}

export function cancelConfirmTitle(role: CancelRole): string {
  return role === 'sender' ? 'Cancel this parcel?' : 'Release this job?';
}

export function cancelConfirmBody(role: CancelRole): string {
  return role === 'sender'
    ? 'The parcel is withdrawn and no driver will collect it. This cannot be undone — posting it again means filling in the form again.'
    : 'The parcel goes back to the open jobs board for another driver. The sender keeps their shipment. Repeated releases are logged.';
}

/**
 * Why the button is not there, for someone who expected it.
 *
 * Returns null while cancelling is still permitted. Silence is worse than a
 * sentence here: a sender who cannot find the cancel button assumes the app is
 * broken rather than that the window has closed.
 */
export function cancelClosedReason(booking: Booking, role: CancelRole): string | null {
  if (cancellationAllowed(booking.status, role)) return null;

  if (role === 'sender') {
    if (booking.status === 'Cancelled') return 'This parcel is already cancelled.';
    if (booking.status === 'Delivered') return 'This parcel has been delivered.';
    return 'A driver has accepted this parcel, so it can no longer be cancelled here. Contact support if something is wrong.';
  }

  if (booking.status === 'Delivered') return 'This delivery is complete.';
  return 'You are already carrying this parcel. Releasing stops at pickup — contact support if you cannot complete it.';
}

/**
 * Calls it off.
 *
 * Returns the status the parcel ended up at: 'Cancelled' for a sender,
 * 'Booked' for a driver release, because the shipment goes back on the board
 * rather than ending.
 */
export async function cancelBooking(bookingId: string, reason?: string): Promise<BookingStage> {
  const { data, error } = await supabase.rpc('cancel_booking', {
    booking_id: bookingId,
    reason: reason?.trim() || null,
  });

  if (error) throw error;
  return String(data) as BookingStage;
}
