import { useSyncExternalStore } from 'react';

import { supabase } from '@/lib/supabase';
import type { DispatchOffer, OfferResponse } from '@/store/dispatch';

/**
 * The offers waiting on this driver — one copy for the whole app.
 *
 * ⚠ One store rather than a fetch per screen, and that is the fix.
 *
 *   Assigned Trip used to own its offers: a 15-second poll and a reload after
 *   every answer. Two problems came out of that:
 *
 *     1. A poll that left before the driver tapped Decline could land after the
 *        reload that followed it, and paint the declined card back on screen.
 *        On a slow mobile connection that is the common case, and it reads as
 *        "Decline does nothing".
 *     2. Nothing outside that one screen knew an offer existed, so a driver on
 *        any other tab saw nothing until a push arrived — and with push off,
 *        nothing at all.
 *
 *   Here, every answered offer is remembered for the session and filtered out
 *   of every later fetch, and a fetch older than the newest one already applied
 *   is thrown away. The pop-up (`offer-popup.tsx`) and Assigned Trip read the
 *   same list, so answering in one clears the other.
 */

export type OfferParcel = {
  trackingId: string;
  originCity: string;
  destinationCity: string;
  weight: number;
  fare: number;
};

export type LiveOffer = DispatchOffer & {
  /** Null if the parcel row is not readable — the card then says less, not nothing. */
  parcel: OfferParcel | null;
};

type Row = {
  id: string;
  booking_id: string;
  journey_id: string;
  status: string;
  offered_at: string;
  expires_at: string;
  booking: {
    tracking_id: string;
    origin_city: string;
    destination_city: string;
    weight: number | string;
    estimated_fee: number | string;
  } | null;
};

let offers: LiveOffer[] = [];
const listeners = new Set<() => void>();

/** Offers this driver has answered in this session. Never shown again. */
const answered = new Set<string>();

/* Request ordering: a response older than the newest applied one is dropped. */
let nextRequest = 0;
let lastApplied = 0;

function publish(next: LiveOffer[]) {
  offers = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return offers;
}

/** Live offers, oldest first. Re-renders when they change. */
export function useLiveOffers(): LiveOffer[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Reads the offers again.
 *
 * Expired ones are filtered here as well as by the sweeper, which runs on a
 * schedule — an offer past its hold can still say 'offered' for a minute.
 */
export async function refreshLiveOffers(): Promise<void> {
  const request = ++nextRequest;

  const { data, error } = await supabase
    .from('dispatch_offers')
    .select(
      'id, booking_id, journey_id, status, offered_at, expires_at, ' +
        'booking:bookings(tracking_id, origin_city, destination_city, weight, estimated_fee)',
    )
    .eq('status', 'offered')
    .order('offered_at', { ascending: true });

  // A newer read has already landed; this one describes an older moment.
  if (request < lastApplied) return;
  // On failure keep what is on screen rather than blanking a live offer.
  if (error || !data) return;
  lastApplied = request;

  const now = Date.now();
  publish(
    (data as unknown as Row[])
      .filter((row) => !answered.has(row.id) && Date.parse(row.expires_at) > now)
      .map((row) => ({
        id: row.id,
        bookingId: row.booking_id,
        journeyId: row.journey_id,
        status: 'offered',
        offeredAt: row.offered_at,
        expiresAt: row.expires_at,
        parcel: row.booking
          ? {
              trackingId: row.booking.tracking_id,
              originCity: row.booking.origin_city,
              destinationCity: row.booking.destination_city,
              weight: Number(row.booking.weight),
              fare: Number(row.booking.estimated_fee),
            }
          : null,
      })),
  );
}

export type AnswerOutcome = { status: OfferResponse; message: string | null };

/**
 * Accepts or declines, and takes the card off screen immediately.
 *
 * The card goes before the server answers: a driver who taps Decline and still
 * sees the card concludes the tap did not register and taps again. If the
 * server refuses, the reason comes back in `message` — its own sentence, such
 * as "That offer expired. It has gone to another driver." — instead of being
 * flattened into a generic "no longer available".
 */
export async function answerLiveOffer(offerId: string, accept: boolean): Promise<AnswerOutcome> {
  answered.add(offerId);
  publish(offers.filter((offer) => offer.id !== offerId));

  const { data, error } = await supabase.rpc('respond_to_offer', {
    offer_id: offerId,
    accept,
  });

  void refreshLiveOffers();

  if (error) return { status: 'gone', message: error.message };
  return { status: String(data) === 'accepted' ? 'accepted' : 'declined', message: null };
}

/** On sign-out, so the next account on this phone starts clean. */
export function resetLiveOffers(): void {
  answered.clear();
  nextRequest = 0;
  lastApplied = 0;
  publish([]);
}
