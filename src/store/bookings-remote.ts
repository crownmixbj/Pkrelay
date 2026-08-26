import { supabase } from '@/lib/supabase';
import type {
  Booking,
  BookingStage,
  Category,
  City,
  DeliveryType,
  HandoverMode,
} from '@/store/bookings';

/**
 * Translation between the `bookings` table and the `Booking` type.
 *
 * Postgres columns are snake_case by convention and the app is camelCase, so
 * the mapping lives here rather than being sprinkled through screens. Doing it
 * in one place also means a renamed column breaks in exactly one file.
 */
export type BookingRow = {
  id: string;
  tracking_id: string;
  delivery_type: string;
  pickup_mode: string;
  dropoff_mode: string;
  origin_city: string;
  destination_city: string;
  pickup_area: string;
  dropoff_area: string;
  pickup_address: string;
  dropoff_address: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  pickup_contact_name: string;
  sender_phone: string;
  recipient_name: string;
  recipient_phone: string;
  item_description: string;
  item_photo_uri: string | null;
  category: string;
  weight: number;
  declared_value: number;
  fragile: boolean;
  notes: string;
  estimated_fee: number;
  sender_id: string;
  capture_session_id: string | null;
  status: string;
  driver: string | null;
  driver_id: string | null;
  accepted_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  received_by: string | null;
  proof_path: string | null;
  proof_note: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
};

export function rowToBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    trackingId: row.tracking_id,
    deliveryType: row.delivery_type as DeliveryType,
    pickupMode: row.pickup_mode as HandoverMode,
    dropoffMode: row.dropoff_mode as HandoverMode,
    originCity: row.origin_city as City,
    destinationCity: row.destination_city as City,
    pickupArea: row.pickup_area,
    dropoffArea: row.dropoff_area,
    pickupAddress: row.pickup_address,
    dropoffAddress: row.dropoff_address,
    // `numeric` arrives as a string from PostgREST, and null must stay null —
    // Number(null) is 0, which is a real coordinate in the Gulf of Guinea.
    pickupLat: row.pickup_lat === null ? null : Number(row.pickup_lat),
    pickupLng: row.pickup_lng === null ? null : Number(row.pickup_lng),
    dropoffLat: row.dropoff_lat === null ? null : Number(row.dropoff_lat),
    dropoffLng: row.dropoff_lng === null ? null : Number(row.dropoff_lng),
    pickupContactName: row.pickup_contact_name,
    senderPhone: row.sender_phone,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone,
    itemDescription: row.item_description,
    itemPhotoUri: row.item_photo_uri,
    category: row.category as Category,
    // Postgres `numeric` arrives as a string through PostgREST when it exceeds
    // what JSON can hold safely, so coerce rather than trusting the type.
    weight: Number(row.weight),
    declaredValue: Number(row.declared_value),
    fragile: row.fragile,
    notes: row.notes,
    estimatedFee: Number(row.estimated_fee),
    senderId: row.sender_id,
    captureSessionId: row.capture_session_id,
    status: row.status as BookingStage,
    driver: row.driver,
    driverId: row.driver_id,
    acceptedAt: row.accepted_at,
    pickedUpAt: (row.picked_up_at as string | null) ?? null,
    deliveredAt: (row.delivered_at as string | null) ?? null,
    receivedBy: (row.received_by as string | null) ?? null,
    proofPath: (row.proof_path as string | null) ?? null,
    proofNote: (row.proof_note as string | null) ?? null,
    cancelledAt: (row.cancelled_at as string | null) ?? null,
    cancellationReason: (row.cancellation_reason as string | null) ?? null,
    createdAt: row.created_at,
  };
}

/**
 * The insert payload. Server-owned columns are deliberately absent.
 *
 * ⚠ `capture_session_id` travels here rather than in a call afterwards.
 *
 *   The selfie used to be linked by `consume_capture_session`, run once the
 *   booking existed — and `book.tsx` swallowed a failure there on purpose,
 *   because the parcel was already posted and sending somebody back to a
 *   completed form would have lost it. The result was parcels with no record of
 *   who posted them and nothing anywhere saying so.
 *
 *   Sent with the insert, a BEFORE INSERT trigger resolves it and the policy
 *   requires the result — see `44_selfie_with_the_parcel.sql`. There is no
 *   window where one exists without the other.
 */
export function bookingToInsert(
  booking: Omit<
    Booking,
    | 'id'
    | 'createdAt'
    | 'driver'
    | 'driverId'
    | 'acceptedAt'
    // Written by `advance_booking`, never by an insert.
    | 'pickedUpAt'
    | 'deliveredAt'
    | 'receivedBy'
    | 'proofPath'
    | 'proofNote'
    | 'cancelledAt'
    | 'cancellationReason'
  >,
) {
  return {
    tracking_id: booking.trackingId,
    delivery_type: booking.deliveryType,
    pickup_mode: booking.pickupMode,
    dropoff_mode: booking.dropoffMode,
    origin_city: booking.originCity,
    destination_city: booking.destinationCity,
    pickup_area: booking.pickupArea,
    dropoff_area: booking.dropoffArea,
    pickup_address: booking.pickupAddress,
    dropoff_address: booking.dropoffAddress,
    pickup_lat: booking.pickupLat,
    pickup_lng: booking.pickupLng,
    dropoff_lat: booking.dropoffLat,
    dropoff_lng: booking.dropoffLng,
    pickup_contact_name: booking.pickupContactName,
    sender_phone: booking.senderPhone,
    recipient_name: booking.recipientName,
    recipient_phone: booking.recipientPhone,
    item_description: booking.itemDescription,
    /*
     * Deliberately dropped. The picker gives a local `file://` URI that means
     * nothing on another device, and storing it would put a dead path in the
     * database that looks like a working photo. Send null until there's an
     * upload to a storage bucket.
     */
    item_photo_uri: null,
    category: booking.category,
    weight: booking.weight,
    declared_value: booking.declaredValue,
    fragile: booking.fragile,
    notes: booking.notes,
    estimated_fee: booking.estimatedFee,
    sender_id: booking.senderId,
    status: booking.status,
    capture_session_id: booking.captureSessionId,
  };
}

/** Everything this account may see: their parcels, their jobs, and open jobs. */
export async function fetchBookings(): Promise<Booking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(rowToBooking);
}

export async function insertBooking(
  booking: Omit<
    Booking,
    | 'id'
    | 'createdAt'
    | 'driver'
    | 'driverId'
    | 'acceptedAt'
    // Written by `advance_booking`, never by an insert.
    | 'pickedUpAt'
    | 'deliveredAt'
    | 'receivedBy'
    | 'proofPath'
    | 'proofNote'
    | 'cancelledAt'
    | 'cancellationReason'
  >,
): Promise<Booking> {
  const { data, error } = await supabase
    .from('bookings')
    .insert(bookingToInsert(booking))
    .select()
    .single();

  if (error) throw error;
  return rowToBooking(data);
}

/**
 * Claim a job.
 *
 * The `.is('driver_id', null)` is the whole point: it makes this a *conditional*
 * update, so if two drivers tap Accept at the same moment the second one
 * matches zero rows and is told the job has gone. Reading first and then
 * writing would let both succeed — the classic lost update.
 *
 * Returns the claimed booking, or null when someone else got there first.
 */
export async function claimBooking(
  id: string,
  driver: { id: string; name: string },
): Promise<Booking | null> {
  const { data, error } = await supabase
    .from('bookings')
    .update({
      driver: driver.name,
      driver_id: driver.id,
      accepted_at: new Date().toISOString(),
      status: 'Assigned',
    })
    .eq('id', id)
    .is('driver_id', null)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data ? rowToBooking(data) : null;
}

/** Advances a job the signed-in driver is carrying. RLS enforces the "carrying". */
export async function updateBookingStatus(id: string, status: BookingStage): Promise<Booking> {
  const { data, error } = await supabase
    .from('bookings')
    .update({ status })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return rowToBooking(data);
}
