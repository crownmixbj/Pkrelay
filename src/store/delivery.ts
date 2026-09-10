import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import {
  assertImageBytes,
  contentTypeFor,
  extensionOf,
  readFileBytes,
  type FileBytes,
} from '@/lib/upload';
import { BOOKING_STAGES, type Booking, type BookingStage } from '@/store/bookings';

/**
 * Moving a delivery forward, and recording that it happened.
 *
 * The rule lives in `supabase/migrations/20250101000010_delivery.sql`; this is the client side of it.
 * Every guard that matters — only the carrier, forwards only, a name before
 * Delivered — is enforced there, so a modified client gains nothing.
 */

/** The next stage, or null when the delivery is finished. Mirrors the SQL. */
export function nextStage(current: BookingStage): BookingStage | null {
  const order: BookingStage[] = [...BOOKING_STAGES];
  const index = order.indexOf(current);

  // 'Booked' advances by being claimed, which is a different action entirely.
  if (index < order.indexOf('Assigned')) return null;
  if (index < 0 || index >= order.length - 1) return null;

  return order[index + 1];
}

/** What the button should say for the stage a driver is currently on. */
export function advanceLabel(current: BookingStage): string | null {
  switch (nextStage(current)) {
    case 'Picked Up':
      return 'Confirm pickup';
    case 'In Transit':
      return 'Start the journey';
    case 'Out for Delivery':
      return 'Out for delivery';
    case 'Delivered':
      return 'Complete delivery';
    default:
      return null;
  }
}

// ------------------------------------------------- which end of the trip ---

/**
 * The half of the journey a driver is currently on.
 *
 * A delivery has two counterparties and a driver only ever needs one of them at
 * a time. Before collection the person who matters is whoever is handing the
 * parcel over; after it, the person receiving it. The screen used to show the
 * recipient for both halves, so a driver on an Assigned job saw the drop-off
 * address, a "Call recipient" button, and — if they pressed it — rang somebody
 * across the city about a parcel that had not been collected yet.
 *
 * Everything the screen needs for the current half comes from here, so the
 * button, the contact line and the navigation target cannot disagree with each
 * other. They disagreed before precisely because each was written separately.
 *
 * ⚠ Pure, and takes the stage rather than reading it. `advanceBooking` returns
 *   the new stage, so the caller can render the next leg from the response
 *   without waiting for a refetch — which is what makes the switch feel
 *   immediate when "Confirm pickup" is tapped.
 */
export type LegRole = 'sender' | 'recipient';

export type JobLeg = {
  role: LegRole;
  /** What the call button says. */
  callLabel: string;
  /** Who the driver is dealing with at this end. */
  name: string;
  phone: string;
  /** Street line, for the contact row. */
  address: string;
  /** Everything a maps app needs, including city and country. */
  navigationAddress: string;
  lat: number | null;
  lng: number | null;
  /** A short line explaining what this half of the job is. */
  hint: string;
};

/**
 * Whether the parcel is still to be collected.
 *
 * The boundary is 'Picked Up': at and beyond it the parcel is on the vehicle.
 * Written against `stageIndex` rather than a list of status strings so a new
 * stage inserted into `BOOKING_STAGES` lands on the correct side by position
 * instead of being silently treated as pre-pickup.
 *
 * 'Cancelled' sits outside the stage list and indexes to -1, which reads as
 * pre-pickup. That is the safe answer: a cancelled parcel was never collected.
 */
export function awaitingPickup(stage: BookingStage): boolean {
  const order: readonly string[] = BOOKING_STAGES;
  return order.indexOf(stage) < order.indexOf('Picked Up');
}

export function activeLeg(job: Booking, stage: BookingStage = job.status): JobLeg {
  if (awaitingPickup(stage)) {
    return {
      role: 'sender',
      callLabel: 'Call sender',
      /*
       * `pickupContactName`, not the account holder's name.
       *
       * The booking form asks who physically hands the parcel over, which is
       * often a shop assistant or a relative rather than whoever paid. That is
       * the person standing at the pickup address with the box.
       */
      name: job.pickupContactName,
      phone: job.senderPhone,
      address: job.pickupAddress,
      navigationAddress: `${job.pickupAddress}, ${job.pickupArea}, ${job.originCity}, Nigeria`,
      lat: job.pickupLat,
      lng: job.pickupLng,
      hint: 'Collect from here first.',
    };
  }

  return {
    role: 'recipient',
    callLabel: 'Call recipient',
    name: job.recipientName,
    phone: job.recipientPhone,
    address: job.dropoffAddress,
    navigationAddress: `${job.dropoffAddress}, ${job.dropoffArea}, ${job.destinationCity}, Nigeria`,
    lat: job.dropoffLat,
    lng: job.dropoffLng,
    hint: 'On board — deliver to here.',
  };
}

/** True for the step that ends the job, which is the one needing evidence. */
export function isFinalStep(current: BookingStage): boolean {
  return nextStage(current) === 'Delivered';
}

export type AdvanceInput = {
  bookingId: string;
  /** Required by the server on the final step. */
  receivedBy?: string;
  proofPath?: string;
  note?: string;
};

export async function advanceBooking(input: AdvanceInput): Promise<BookingStage> {
  const { data, error } = await supabase.rpc('advance_booking', {
    booking_id: input.bookingId,
    received_by_name: input.receivedBy ?? null,
    proof: input.proofPath ?? null,
    note: input.note ?? null,
  });

  if (error) throw error;
  return String(data) as BookingStage;
}

/**
 * Where a proof photo lives.
 *
 * The booking id leads, because that is what the storage policies join on —
 * ownership is carried by the path, exactly as it is for driver documents.
 *
 * The timestamp means a second photo never overwrites the first. Evidence that
 * can be replaced after the fact is not evidence.
 */
/*
 * The extension and mime logic moved to `src/lib/upload.ts`.
 *
 * It was duplicated in three uploaders and only fixed in this one, which is how
 * the sender's verification photo kept failing after the delivery proof stopped.
 */
export function proofPath(bookingId: string, fileName: string): string {
  return `${bookingId}/${Date.now()}.${extensionOf(fileName)}`;
}

export type UploadResult = { ok: true; path: string } | { ok: false; error: string };

/** The bytes of a local photo, ready to hand to storage. */
export type PhotoBytes = FileBytes;

/**
 * Reads a delivery proof photo.
 *
 * Thin wrapper over `readFileBytes` so the name reads at the call site; every
 * word of why it is not `fetch(uri).blob()` is in `src/lib/upload.ts`.
 */
export async function readPhotoBytes(uri: string): Promise<PhotoBytes> {
  return assertImageBytes(await readFileBytes(uri, contentTypeFor(uri)));
}

/**
 * Uploads one proof photo.
 *
 * `read` is injectable so the failure paths can be tested without a device —
 * an empty file, an unreadable URI, storage refusing the object. Every one of
 * those used to surface as the same opaque sentence to a driver standing at a
 * door with a parcel in their hand.
 */
export async function uploadProof(
  bookingId: string,
  uri: string,
  read: (uri: string) => Promise<PhotoBytes> = readPhotoBytes,
): Promise<UploadResult> {
  try {
    const { bytes, contentType } = await read(uri);

    /*
     * An empty body is a failure, not an upload.
     *
     * Checked here rather than only in `readPhotoBytes`, because the guard has
     * to hold for whatever reader it is given — a check that lives in one
     * implementation protects that implementation, not the invariant. Storage
     * accepts zero bytes without complaint, so without this the delivery is
     * marked complete against a `proof_path` pointing at an empty object:
     * evidence that is not evidence.
     */
    if (bytes.byteLength === 0) {
      return { ok: false, error: 'The photo file was empty — take it again.' };
    }

    const path = proofPath(bookingId, uri);
    const { error } = await supabase.storage.from('delivery-proof').upload(path, bytes, {
      contentType,
      // Never overwrite. The path is unique per capture by design.
      upsert: false,
    });

    if (error) return { ok: false, error: error.message };
    return { ok: true, path };
  } catch (thrown) {
    return { ok: false, error: errorMessage(thrown, 'Upload failed') };
  }
}

/** A short-lived URL for a stored proof photo. Null when there is none. */
export async function signedProofUrl(path: string | null, seconds = 3600): Promise<string | null> {
  if (!path) return null;

  const { data, error } = await supabase.storage
    .from('delivery-proof')
    .createSignedUrl(path, seconds);

  if (error) return null;
  return data?.signedUrl ?? null;
}

// ------------------------------------------------------------ the bell ------

export type DriverAlert = {
  key: string;
  title: string;
  detail: string;
  tone: 'info' | 'warning';
  href?: string;
};

/**
 * What the notification badge counts.
 *
 * Derived from rows that already exist rather than a notifications table. That
 * keeps it honest — every item corresponds to something real in the data, and
 * there is no third messaging path to keep in sync alongside toasts and email.
 *
 * The cost is that it cannot represent "read": the count reflects the current
 * state of the work, so it falls to zero when the work is done rather than when
 * someone has looked at it. For a driver that is arguably the more useful
 * meaning — this is a worklist, not an inbox.
 */
export function driverAlerts(jobs: Booking[], now: Date = new Date()): DriverAlert[] {
  const alerts: DriverAlert[] = [];

  const awaitingPickup = jobs.filter((job) => job.status === 'Assigned');
  if (awaitingPickup.length > 0) {
    alerts.push({
      key: 'awaiting-pickup',
      title: `${awaitingPickup.length} parcel${awaitingPickup.length === 1 ? '' : 's'} to collect`,
      detail: 'Accepted but not picked up yet.',
      tone: 'warning',
      href: '/driver',
    });
  }

  const inFlight = jobs.filter((job) => job.status === 'Picked Up' || job.status === 'In Transit');
  if (inFlight.length > 0) {
    alerts.push({
      key: 'in-flight',
      title: `${inFlight.length} on the move`,
      detail: 'Carrying now.',
      tone: 'info',
      href: '/driver',
    });
  }

  const outForDelivery = jobs.filter((job) => job.status === 'Out for Delivery');
  if (outForDelivery.length > 0) {
    alerts.push({
      key: 'out-for-delivery',
      title: `${outForDelivery.length} to hand over`,
      detail: 'Out for delivery — complete with a photo and a name.',
      tone: 'warning',
      href: '/driver',
    });
  }

  /*
   * Accepted a while ago and still not collected.
   *
   * The one alert that is about a problem rather than a state. A day is
   * deliberate: the pickup window is same-day, so anything older is late
   * whatever the window said.
   */
  const stale = jobs.filter((job) => {
    if (job.status !== 'Assigned' || !job.acceptedAt) return false;
    const accepted = Date.parse(job.acceptedAt);
    return Number.isFinite(accepted) && now.getTime() - accepted > 24 * 60 * 60 * 1000;
  });

  if (stale.length > 0) {
    alerts.push({
      key: 'stale',
      title: `${stale.length} overdue`,
      detail: 'Accepted more than a day ago and still not collected.',
      tone: 'warning',
      href: '/driver',
    });
  }

  return alerts;
}
