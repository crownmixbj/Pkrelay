import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { errorMessage } from '@/lib/errors';
import { schemaGapMessage } from '@/lib/schema-gap';
import { isSupabaseConfigured } from '@/lib/supabase';
import { claimBooking, fetchBookings, insertBooking } from '@/store/bookings-remote';
import { SESSION_USER, useSession } from '@/store/session';

/**
 * What's inside the parcel. "Fragile" is deliberately absent — fragility is a
 * handling flag (`fragile`) that can apply to any category.
 */
export const CATEGORIES = ['Electronics', 'Documents', 'Clothing', 'Perishables', 'Other'] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * One hub per state — the state capital, or the primary commercial city where
 * that differs. Alphabetical so a 37-item picker stays scannable.
 */
export const CITIES = [
  'Abakaliki',
  'Abeokuta',
  'Abuja',
  'Ado-Ekiti',
  'Akure',
  'Asaba',
  'Awka',
  'Bauchi',
  'Benin City',
  'Birnin Kebbi',
  'Calabar',
  'Damaturu',
  'Dutse',
  'Enugu',
  'Gombe',
  'Gusau',
  'Ibadan',
  'Ilorin',
  'Jalingo',
  'Jos',
  'Kaduna',
  'Kano',
  'Katsina',
  'Lafia',
  'Lagos',
  'Lokoja',
  'Maiduguri',
  'Makurdi',
  'Minna',
  'Osogbo',
  'Owerri',
  'Port Harcourt',
  'Sokoto',
  'Umuahia',
  'Uyo',
  'Yenagoa',
  'Yola',
] as const;

export type City = (typeof CITIES)[number];

export const DEFAULT_CITY: City = 'Ibadan';

/**
 * State each hub sits in. Shown in dropdown labels only — bookings store the
 * plain city name, so this is presentation and never touches the fee engine.
 */
export const CITY_STATES: Record<City, string> = {
  Umuahia: 'Abia',
  Yola: 'Adamawa',
  Uyo: 'Akwa Ibom',
  Awka: 'Anambra',
  Bauchi: 'Bauchi',
  Yenagoa: 'Bayelsa',
  Makurdi: 'Benue',
  Maiduguri: 'Borno',
  Calabar: 'Cross River',
  Asaba: 'Delta',
  Abakaliki: 'Ebonyi',
  'Benin City': 'Edo',
  'Ado-Ekiti': 'Ekiti',
  Enugu: 'Enugu',
  // Spelled exactly as in `NIGERIA_STATES` so a state can be mapped back to its
  // city. 'FCT' alone looked tidier but silently broke that lookup for Abuja.
  Abuja: 'FCT - Abuja',
  Gombe: 'Gombe',
  Owerri: 'Imo',
  Dutse: 'Jigawa',
  Kaduna: 'Kaduna',
  Kano: 'Kano',
  Katsina: 'Katsina',
  'Birnin Kebbi': 'Kebbi',
  Lokoja: 'Kogi',
  Ilorin: 'Kwara',
  Lagos: 'Lagos',
  Lafia: 'Nasarawa',
  Minna: 'Niger',
  Abeokuta: 'Ogun',
  Akure: 'Ondo',
  Osogbo: 'Osun',
  Ibadan: 'Oyo',
  Jos: 'Plateau',
  'Port Harcourt': 'Rivers',
  Sokoto: 'Sokoto',
  Jalingo: 'Taraba',
  Damaturu: 'Yobe',
  Gusau: 'Zamfara',
};

/**
 * "Ibadan — Oyo". Abuja's state is stored as 'FCT - Abuja' so it matches the
 * driver state picker exactly; shortening it here stops the label reading
 * "Abuja — FCT - Abuja".
 */
export function cityHubLabel(city: City): string {
  const state = CITY_STATES[city];
  return `${city} — ${state === 'FCT - Abuja' ? 'FCT' : state}`;
}

/**
 * Reverse of `CITY_STATES`. Each state has exactly one LOCI city, so a driver
 * who registers a state of operation has an unambiguous base city — which is
 * what the jobs feed filters on.
 */
const CITY_BY_STATE: Record<string, City> = Object.fromEntries(
  (Object.entries(CITY_STATES) as [City, string][]).map(([city, state]) => [state, city]),
);

/** The city a driver registered in that state works out of, or null if unknown. */
export function cityForState(state: string): City | null {
  return CITY_BY_STATE[state] ?? null;
}

/**
 * Curated neighbourhoods, where we have them. Partial by design: inventing
 * areas for a city we don't operate in yet would put fake places in front of
 * users. Anywhere without an entry falls back to "Other…" and a free-text box.
 */
export const AREAS_BY_CITY: Partial<Record<City, readonly string[]>> = {
  Ibadan: [
    'Bodija',
    'Dugbe',
    'Ring Road',
    'Mokola',
    'Challenge',
    'UI/Agbowo',
    'Iwo Road',
    'Apata',
    'Sango',
    'Akobo',
  ],
  Lagos: ['Ikeja', 'Yaba', 'Lekki', 'Victoria Island', 'Surulere', 'Ikorodu', 'Apapa', 'Ajah'],
  Abuja: ['Wuse II', 'Garki', 'Maitama', 'Gwarinpa', 'Asokoro', 'Kubwa', 'Lugbe'],
  Abeokuta: ['Oke-Ilewo', 'Panseke', 'Kuto', 'Obantoko', 'Camp', 'Asero'],
  'Port Harcourt': ['GRA Phase 2', 'D-Line', 'Rumuokoro', 'Trans-Amadi', 'Woji', 'Eliozu'],
  Kano: ['Nassarawa', 'Sabon Gari', 'Bompai', 'Fagge', 'Tarauni'],
  'Benin City': ['GRA', 'Ugbowo', 'Sapele Road', 'Ring Road', 'Ikpoba Hill'],
  Enugu: ['Independence Layout', 'New Haven', 'Trans-Ekulu', 'Achara Layout', 'Uwani'],
  Kaduna: ['Barnawa', 'Malali', 'Kawo', 'Sabon Tasha', 'Ungwan Rimi'],
};

/** Areas offered for a city, always with an "Other…" escape hatch appended. */
export const OTHER_AREA = 'Other…';

export function areasForCity(city: City): string[] {
  return [...(AREAS_BY_CITY[city] ?? []), OTHER_AREA];
}

export type DeliveryType = 'local' | 'interstate';

export const DELIVERY_TYPES: readonly DeliveryType[] = ['local', 'interstate'];

export const DELIVERY_TYPE_LABELS: Record<DeliveryType, string> = {
  local: 'Local Area',
  interstate: 'Inter-State',
};

/** Ordered delivery stages. A booking's status implies every earlier stage is done. */
export const BOOKING_STAGES = [
  'Booked',
  'Assigned',
  'Picked Up',
  'In Transit',
  'Out for Delivery',
  'Delivered',
] as const;

/**
 * The ordered pipeline, plus the one status that is not part of it.
 *
 * 'Cancelled' is deliberately outside `BOOKING_STAGES`: it is where a parcel
 * stops, not a stage it passes through. Putting it in the array would make it
 * reachable from `nextStage`, so a driver could "advance" a delivery into
 * cancellation — see `supabase/11_cancellation.sql`.
 */
export type BookingStage = (typeof BOOKING_STAGES)[number] | 'Cancelled';

/**
 * Where a parcel changes hands at each end of the journey.
 *
 * - `hub` — a LOCI partner hub (see `app/(tabs)/locations.tsx`). The sender
 *   drops off there; at the far end the recipient collects in person. That
 *   collection is the OTP step described in the "How LOCI Works" copy. No code
 *   is actually generated or checked anywhere in this codebase yet, so `hub`
 *   records intent, not an enforced handover.
 * - `meetpoint` — an agreed public place, away from a hub but not a private
 *   address: a filling station, a mall entrance, a campus gate. The driver is
 *   already passing, so this carries no surcharge.
 * - `doorstep` — a driver runs the leg to a private address. Chargeable at the
 *   dropoff end only.
 *
 * Which of these costs extra depends on the *leg*, not the mode — see
 * `isChargeableHandover` below. A mode not named there is free, which is the
 * safer way round to get it wrong.
 */
export type HandoverMode = 'hub' | 'meetpoint' | 'doorstep';

/**
 * Which leg of which mode attracts the surcharge.
 *
 * Chargeability is a property of the *leg*, not of the mode, because the two
 * ends are priced for opposite reasons:
 *
 *   pickup, `hub`        charged. Not because it costs LOCI more — it costs
 *                        less — but to discourage senders bringing parcels to
 *                        a hub, which is a queue LOCI has to staff.
 *   pickup, anything     free. A driver collecting from a public location is
 *                        already passing.
 *   dropoff, `doorstep`  charged. A driver runs an extra leg to a private
 *                        address.
 *   dropoff, anything    free.
 *
 * The same mode therefore costs ₦800 at one end and nothing at the other, which
 * is why this cannot be a set of modes. It used to be, and reading `'doorstep'`
 * as "the expensive one" is now wrong in both directions.
 */
export type HandoverLeg = 'pickup' | 'dropoff';

export function isChargeableHandover(mode: HandoverMode | undefined, leg: HandoverLeg): boolean {
  if (mode === undefined) return false;
  return leg === 'pickup' ? mode === 'hub' : mode === 'doorstep';
}

/** The cheapest legal mode at each end. Used for "from ₦X" headline quotes. */
export const CHEAPEST_HANDOVER: Record<HandoverLeg, HandoverMode> = {
  pickup: 'meetpoint',
  dropoff: 'hub',
};

export type Booking = {
  id: string;
  trackingId: string;
  deliveryType: DeliveryType;

  /** How the parcel leaves the sender, and how it reaches the recipient. */
  pickupMode: HandoverMode;
  dropoffMode: HandoverMode;

  /** For local deliveries, originCity and destinationCity are always the same. */
  originCity: City;
  destinationCity: City;

  /** Neighbourhood / area within the city, e.g. "Bodija". */
  pickupArea: string;
  dropoffArea: string;

  /** Street-level address lines. */
  pickupAddress: string;
  dropoffAddress: string;

  /**
   * Exact handover points, dropped by the sender on a map.
   *
   * Null when the parcel predates the map, or the sender skipped it. Screens
   * fall back to the text address — a missing pin is a missing pin, not a
   * broken screen.
   */
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;

  /** Who physically hands the parcel over. Required by the form. */
  pickupContactName: string;
  senderPhone: string;
  recipientName: string;
  recipientPhone: string;

  /** What's actually in the parcel, e.g. "Laptop charger". Shown as the job title to drivers. */
  itemDescription: string;
  /**
   * Local URI of a photo of the parcel, or null. Optional, and held only in
   * memory — there is no upload, so this does not survive a reload and is not
   * evidence of anything until a real backend stores it.
   */
  itemPhotoUri: string | null;
  category: Category;
  weight: number;
  /** Declared value in naira, used for the 1% insurance component of the fee. */
  declaredValue: number;
  /** Needs careful handling — surfaces as a warning badge to drivers. */
  fragile: boolean;
  notes: string;

  /** Quoted fee in naira at the time of booking. */
  estimatedFee: number;

  /** Session id of whoever posted the parcel. Set by the store, not the form. */
  senderId: string;

  /**
   * The capture session holding the selfie that authorised this parcel.
   *
   * ⚠ Sent with the insert, and the parcel is refused without it.
   *
   *   The photo is the record of who handed a driver a box. It used to be
   *   linked afterwards by a call whose failure was swallowed, which produced
   *   parcels with no evidence and nothing saying so. Now the server resolves
   *   it in the same statement — see `44_selfie_with_the_parcel.sql`.
   *
   *   Null only for rows read back from the database, where the server has
   *   already turned it into `senderPhotoPath`.
   */
  captureSessionId: string | null;

  status: BookingStage;
  /** Name of the driver who accepted the job, or null while it sits in the feed. */
  driver: string | null;
  /** Session id of that driver. Null while unclaimed — the two move together. */
  driverId: string | null;
  acceptedAt: string | null;
  createdAt: string;

  /**
   * When each irreversible step actually happened, and the evidence for the
   * last one. See `supabase/10_delivery.sql`.
   *
   * Null on every parcel that predates the delivery migration — the tracking
   * screen shows a timestamp only where one exists rather than inventing it.
   */
  pickedUpAt: string | null;
  deliveredAt: string | null;

  /**
   * Set only when a *sender* called the parcel off. A driver releasing a job
   * leaves none of these — the shipment survives and returns to the board.
   */
  cancelledAt: string | null;
  cancellationReason: string | null;
  /** Who physically took it. Often not the named recipient. */
  receivedBy: string | null;
  /** Path in the private `delivery-proof` bucket, opened via a signed URL. */
  proofPath: string | null;
  proofNote: string | null;
};

/** Fields the booking form supplies; the store fills in the rest. */
export type NewBookingInput = Omit<
  Booking,
  | 'id'
  | 'trackingId'
  | 'status'
  | 'createdAt'
  | 'driver'
  | 'driverId'
  | 'acceptedAt'
  | 'senderId'
  // Delivery facts, written by `advance_booking` and never by the form.
  | 'pickedUpAt'
  | 'deliveredAt'
  | 'receivedBy'
  | 'proofPath'
  | 'proofNote'
  | 'cancelledAt'
  | 'cancellationReason'
> &
  Partial<Pick<Booking, 'status'>>;

/**
 * Position in the ordered pipeline, or -1.
 *
 * 'Cancelled' is not in the pipeline, so it returns -1 — the same answer as an
 * unrecognised status. Callers that draw progress must treat a negative index
 * as "no progress to draw" rather than clamping it to the first stage, which
 * would show a cancelled parcel as freshly booked.
 */
export function stageIndex(stage: BookingStage): number {
  return (BOOKING_STAGES as readonly string[]).indexOf(stage);
}

/** True for a parcel that has stopped, whichever way it stopped. */
export function isFinished(booking: Booking): boolean {
  return booking.status === 'Delivered' || booking.status === 'Cancelled';
}

/**
 * Journey progress for the compact grid card. `fraction` is 0 at Booked and 1
 * at Delivered, so the bar fills across the whole six-stage journey rather than
 * starting part-full.
 */
export function stageProgress(stage: BookingStage): {
  step: number;
  total: number;
  fraction: number;
} {
  const index = stageIndex(stage);
  const total = BOOKING_STAGES.length;
  const safeIndex = index < 0 ? 0 : index;

  return {
    step: safeIndex + 1,
    total,
    fraction: total > 1 ? safeIndex / (total - 1) : 1,
  };
}

/* ------------------------------------------------------------------ *
 * Pricing
 *
 * Placeholder tariff — replace with server-side rates before launch.
 * ------------------------------------------------------------------ */

export const PRICING = {
  /*
    ⚠ REBALANCED FOR DISTANCE PRICING — these numbers need signing off.

      The fare used to be a flat band plus weight: ₦1,500 within a city and
      ₦4,500 between two, whatever the journey. A 3km hop across Ibadan and a
      700km run to Abuja were charged the same, which is the inaccuracy the
      distance term below exists to remove.

      Adding a per-km charge on top of the old base would have raised every
      price. So the base came down and the difference moved into `perKm`,
      calibrated so a *typical* trip costs what it costs today:

        local, 8km, 2kg      700 + 400 + 800   = ₦1,900   (was ₦1,900)
        Ibadan→Lagos, 2kg   1500 + 900 + 2990  = ₦5,390   (was ₦5,400)
        Abuja→Lagos, 2kg    1500 + 900 + 16100 = ₦18,500  (was ₦5,400)

      The third line is the point, and it is also the risk: long routes now
      cost what they cost to run, and nobody has been charged that before.
      These four numbers are a commercial decision, not a technical one.
  */
  base: { local: 700, interstate: 1500 },
  perKg: { local: 200, interstate: 450 },
  /** Charged on the measured route, or on a straight line when that is all there is. */
  perKm: { local: 100, interstate: 23 },
  /** Share of declared value charged as insurance. */
  insuranceRate: 0.01,
  /**
   * Flat fee per chargeable leg — see `isChargeableHandover` for which those
   * are. A parcel brought to a hub and delivered to a door pays it twice; one
   * collected from a public location and met at a hub pays nothing.
   *
   * This is the only optional charge left. Fragile handling is free and carries
   * no surcharge: it's an advisory flag drivers act on, not a paid service.
   * There is no speed tier either — a parcel moves when a driver travelling
   * that route claims it.
   */
  handoverSurcharge: 800,
} as const;

export type FeeInput = {
  deliveryType: DeliveryType;
  weight: number;
  /**
   * Road kilometres between the two ends, when they are known.
   *
   * ⚠ Optional, and absent means *no distance charge at all* rather than a
   *   default one.
   *
   *   Half the callers have no coordinates to offer: the rate calculator, the
   *   booking form, the service catalogue, and the quote form itself whenever
   *   address search is unavailable and somebody picks a city. Charging them a
   *   guessed distance would invent a number; charging them nothing leaves
   *   them on exactly the fare they saw before this existed.
   */
  distanceKm?: number;
  declaredValue: number;
  /**
   * Both default to the cheapest legal mode for their end — see
   * `CHEAPEST_HANDOVER` — so the headline "from ₦X" quotes on the rate
   * calculator, the quick quote and the service catalogue stay honest.
   *
   * They used to default to `hub` at both ends, which was the free option until
   * hub pickup became chargeable. Leaving that default would have quietly added
   * ₦800 to every "from" price in the app.
   */
  pickupMode?: HandoverMode;
  dropoffMode?: HandoverMode;
};

export type FeeBreakdown = {
  base: number;
  weight: number;
  /** The per-km charge. ₦0 whenever no distance was measured. */
  distance: number;
  /** The kilometres it was charged on, or null when nothing was measured. */
  distanceKm: number | null;
  insurance: number;
  /** Handover fee, ₦0 / ₦800 / ₦1,600 depending on the two legs. */
  handover: number;
  /** How many legs that covers, so the summary can label the line honestly. */
  handoverLegs: number;
  /**
   * Rounding applied to reach a clean ₦50 figure, so the line items always sum
   * to `total`. Never more than ₦49, and ₦0 whenever the parts already land on
   * a multiple of 50.
   */
  rounding: number;
  total: number;
};

/**
 * base + weight + insurance, plus a flat fee per chargeable handover leg,
 * rounded up to the nearest ₦50 so quotes read cleanly. Invalid or missing
 * numbers count as zero.
 *
 * Marking a parcel fragile costs nothing — it only changes how drivers are told
 * to handle it.
 */
export function estimateFee(input: FeeInput): FeeBreakdown {
  /*
    Accepts `undefined` as well as a number, because `distanceKm` is optional
    and "not measured" has to arrive here as 0 rather than as NaN.
  */
  const safe = (n: number | undefined) =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;

  const base = PRICING.base[input.deliveryType];
  const weight = Math.round(safe(input.weight) * PRICING.perKg[input.deliveryType]);
  const insurance = Math.round(safe(input.declaredValue) * PRICING.insuranceRate);

  /*
   * ⚠ Zero when the distance is unknown, and that is load-bearing.
   *
   *   `safe` turns undefined, NaN and negatives into 0, so a caller with no
   *   coordinates pays exactly what it paid before the distance term existed.
   *   Every screen but the quote form is in that position, and so is the quote
   *   form whenever address search cannot answer — `verify-pricing` pins the
   *   two fares against each other so this cannot drift.
   */
  const distance = Math.round(safe(input.distanceKm) * PRICING.perKm[input.deliveryType]);

  const handoverLegs =
    (isChargeableHandover(input.pickupMode ?? CHEAPEST_HANDOVER.pickup, 'pickup') ? 1 : 0) +
    (isChargeableHandover(input.dropoffMode ?? CHEAPEST_HANDOVER.dropoff, 'dropoff') ? 1 : 0);
  const handover = handoverLegs * PRICING.handoverSurcharge;

  const subtotal = base + weight + distance + insurance + handover;
  const total = Math.ceil(subtotal / 50) * 50;

  return {
    base,
    weight,
    distance,
    /** Null when nothing was measured, so a summary can say so rather than print "0 km". */
    distanceKm: safe(input.distanceKm) > 0 ? safe(input.distanceKm) : null,
    insurance,
    handover,
    handoverLegs,
    rounding: total - subtotal,
    total,
  };
}

/** ₦12,950 */
export function formatNaira(amount: number): string {
  return `₦${Math.round(amount).toLocaleString('en-NG')}`;
}

/**
 * Groups a naira amount as the user types: "53635" → "53,635".
 *
 * Grouping is done with a regex rather than `toLocaleString`, because the
 * latter needs a `Number` round-trip: that loses precision past 2^53 and, worse,
 * mangles input mid-typing — a trailing "." disappears and "007" silently
 * becomes "7" under the cursor. Working on the string keeps what the user typed.
 *
 * Anything that isn't a digit or a decimal point is dropped, so a paste of
 * "₦45,000.00" cleans up to "45,000.00". Decimals are capped at two places and
 * a lone leading "." is treated as "0.".
 */
export function formatAmountInput(value: string): string {
  const cleaned = value.replace(/[^\d.]/g, '');
  if (!cleaned) return '';

  // Only the first "." counts; later ones are typos, not more decimals.
  const firstDot = cleaned.indexOf('.');
  const hasDecimal = firstDot !== -1;
  const rawInteger = hasDecimal ? cleaned.slice(0, firstDot) : cleaned;
  const decimals = hasDecimal
    ? cleaned
        .slice(firstDot + 1)
        .replace(/\./g, '')
        .slice(0, 2)
    : '';

  // Strip leading zeros but keep a single one, so "007" → "7" and "0" stays "0".
  const integer = rawInteger.replace(/^0+(?=\d)/, '') || (hasDecimal ? '0' : '');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // Keep the trailing "." while it's still being typed.
  return hasDecimal ? `${grouped}.${decimals}` : grouped;
}

/**
 * The numeric value behind a formatted amount. Accepts "45,000", "45000" and
 * "₦45,000.50" alike. Blank is 0; genuinely unparseable input is NaN, so
 * callers can still tell the two apart.
 */
export function parseAmountInput(value: string): number {
  const cleaned = value.replace(/[,\s₦]/g, '');
  return cleaned === '' ? 0 : Number(cleaned);
}

/**
 * Above this, a parcel is somebody's phone call rather than a form submission.
 *
 * Not a technical limit — an underwriting one. A ₦10m parcel is worth ₦100,000
 * in cover at 1%, which is not a thing to accept from a stranger unattended.
 */
export const DECLARED_VALUE_CEILING = 10_000_000;

/**
 * Why a declared value cannot be accepted, or null when it can.
 *
 * ⚠ Required, where it was optional until August 2026.
 *
 *   Insurance is 1% of this number. Left blank it parsed to zero, so the parcel
 *   travelled with no cover and the fare was 1% lower. Nobody chose that: the
 *   field looked optional, most people skipped it, and the first anyone learned
 *   of the gap was a loss with no declared value to pay out against.
 *
 *   Every booking now carries an insurance line, so a ₦45,000 parcel costs ₦450
 *   more than it did. That is the trade, made deliberately.
 *
 * ⚠ Above zero, with no floor invented above it.
 *
 *   A ₦1,000 minimum would overstate parcels genuinely worth less — documents,
 *   a returned charger. Under-declaring to dodge the 1% is the obvious gap, and
 *   the honest deterrent is that a payout is capped at the declared value:
 *   declare a phone at ₦500 and ₦500 is what losing it is worth. That belongs
 *   in the compensation terms, not in a refusal here.
 *
 * Lives beside the pricing rather than in the screen so it can be tested as
 * behaviour — a rule about money asserted only by grepping the JSX is a rule
 * that passes while it is broken.
 */
export function declaredValueError(raw: string): string | null {
  if (!raw.trim()) return 'Declared value is required';

  const declared = parseAmountInput(raw);
  if (Number.isNaN(declared) || declared <= 0) return 'Enter what the parcel is worth';
  if (declared > DECLARED_VALUE_CEILING) return 'Contact support for high-value items';

  return null;
}

/**
 * What the user sees on a status badge. A parcel sitting at "Booked" with no
 * driver reads as "Pending Driver Pickup" — clearer than the raw stage name.
 */
export function statusLabel(booking: Booking): string {
  if (booking.status === 'Booked' && !booking.driver) {
    return 'Pending Driver Pickup';
  }
  return booking.status;
}

/** Semantic tone for the status badge. Mirrors `Tone` in constants/theme. */
export type StatusTone = 'primary' | 'success' | 'warning' | 'neutral';

export function statusTone(booking: Booking): StatusTone {
  switch (booking.status) {
    case 'Delivered':
      return 'success';
    case 'Cancelled':
      // Neutral, not danger. A sender who changed their mind did nothing wrong;
      // a red badge on their own decision reads as an error they must fix.
      return 'neutral';
    case 'Booked':
      // Amber while it waits for a driver to claim it.
      return booking.driver ? 'primary' : 'warning';
    case 'Assigned':
    case 'Picked Up':
    case 'In Transit':
    case 'Out for Delivery':
      return 'primary';
    default:
      return 'neutral';
  }
}

/** "Local: Bodija → Dugbe" / "Inter-State: Ibadan → Lagos" */
export function routeLabel(booking: Booking): string {
  if (booking.deliveryType === 'local') {
    return `Local: ${booking.pickupArea} → ${booking.dropoffArea}`;
  }
  return `Inter-State: ${booking.originCity} → ${booking.destinationCity}`;
}

/** Formats a booking's creation date for card metadata, e.g. "3 Aug 2026". */
export function formatBookingDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Short route line without the type prefix, for dense list rows. */
export function routeEndpoints(booking: Booking): string {
  if (booking.deliveryType === 'local') {
    return `${booking.pickupArea} → ${booking.dropoffArea}, ${booking.originCity}`;
  }
  return `${booking.pickupArea}, ${booking.originCity} → ${booking.dropoffArea}, ${booking.destinationCity}`;
}

let sequence = 0;

function generateTrackingId(): string {
  sequence += 1;
  const random = Math.floor(1000 + Math.random() * 9000);
  return `PKG-${random}${sequence.toString().padStart(2, '0')}`;
}

/**
 * A parcel with nothing delivered yet.
 *
 * Spread rather than repeated so that adding a delivery column later means one
 * edit here, not one per seed row — and so a missing field is a type error
 * rather than an `undefined` that reads as "no record" at a glance.
 */
const NO_DELIVERY_RECORD = {
  pickedUpAt: null,
  deliveredAt: null,
  receivedBy: null,
  proofPath: null,
  proofNote: null,
  cancelledAt: null,
  cancellationReason: null,
} satisfies Pick<
  Booking,
  | 'pickedUpAt'
  | 'deliveredAt'
  | 'receivedBy'
  | 'proofPath'
  | 'proofNote'
  | 'cancelledAt'
  | 'cancellationReason'
>;

const SEED_BOOKINGS: Booking[] = [
  {
    ...NO_DELIVERY_RECORD,
    id: 'seed-1',
    trackingId: 'PKG-9821',
    deliveryType: 'interstate',
    pickupMode: 'hub',
    dropoffMode: 'hub',
    originCity: 'Ibadan',
    destinationCity: 'Lagos',
    pickupArea: 'Bodija',
    dropoffArea: 'Ikeja',
    pickupAddress: '12 Awolowo Avenue',
    dropoffAddress: '45 Allen Avenue',
    pickupLat: null,
    pickupLng: null,
    dropoffLat: null,
    dropoffLng: null,
    senderId: SESSION_USER.id,
    captureSessionId: null,
    pickupContactName: 'Sender',
    senderPhone: '+2348011112222',
    recipientName: 'Ada Obi',
    recipientPhone: '+2348012345678',
    itemDescription: 'Laptop charger and cables',
    itemPhotoUri: null,
    category: 'Electronics',
    weight: 2.5,
    declaredValue: 45000,
    fragile: false,
    notes: 'Call on arrival.',
    estimatedFee: 9500,
    status: 'In Transit',
    driver: 'Segun A.',
    driverId: 'driver-segun',
    acceptedAt: '2026-08-01T10:10:00.000Z',
    createdAt: '2026-08-01T09:30:00.000Z',
  },
  {
    ...NO_DELIVERY_RECORD,
    id: 'seed-2',
    trackingId: 'PKG-4410',
    deliveryType: 'local',
    pickupMode: 'doorstep',
    dropoffMode: 'doorstep',
    originCity: 'Ibadan',
    destinationCity: 'Ibadan',
    pickupArea: 'Dugbe',
    dropoffArea: 'Mokola',
    pickupAddress: '8 Lebanon Street',
    dropoffAddress: '17 Oyo Road',
    pickupLat: null,
    pickupLng: null,
    dropoffLat: null,
    dropoffLng: null,
    senderId: 'user-ngozi',
    captureSessionId: null,
    pickupContactName: 'Sender',
    senderPhone: '+2348033334444',
    recipientName: 'Tunde Bakare',
    recipientPhone: '+2348090001122',
    itemDescription: 'Signed contract documents',
    itemPhotoUri: null,
    category: 'Documents',
    weight: 0.4,
    declaredValue: 0,
    fragile: false,
    notes: '',
    estimatedFee: 1600,
    status: 'Out for Delivery',
    driver: SESSION_USER.name,
    driverId: SESSION_USER.id,
    acceptedAt: '2026-07-31T14:40:00.000Z',
    createdAt: '2026-07-31T14:05:00.000Z',
  },
  {
    ...NO_DELIVERY_RECORD,
    id: 'seed-3',
    trackingId: 'PKG-7305',
    deliveryType: 'interstate',
    pickupMode: 'hub',
    dropoffMode: 'doorstep',
    originCity: 'Port Harcourt',
    destinationCity: 'Kano',
    pickupArea: 'GRA Phase 2',
    dropoffArea: 'Nassarawa',
    pickupAddress: '3 Aba Road',
    dropoffAddress: '90 Zoo Road',
    pickupLat: null,
    pickupLng: null,
    dropoffLat: null,
    dropoffLng: null,
    senderId: 'user-ada',
    captureSessionId: null,
    pickupContactName: 'Sender',
    senderPhone: '+2348055556666',
    recipientName: 'Fatima Yusuf',
    recipientPhone: '+2347033445566',
    itemDescription: 'Office chair, boxed',
    itemPhotoUri: null,
    category: 'Other',
    weight: 14,
    declaredValue: 85000,
    fragile: false,
    notes: 'Leave with the security desk.',
    estimatedFee: 11700,
    status: 'Delivered',
    driver: 'Musa I.',
    driverId: 'driver-musa',
    acceptedAt: '2026-07-28T09:00:00.000Z',
    createdAt: '2026-07-28T08:15:00.000Z',
  },
  {
    ...NO_DELIVERY_RECORD,
    id: 'seed-4',
    trackingId: 'PKG-2288',
    deliveryType: 'local',
    pickupMode: 'doorstep',
    dropoffMode: 'hub',
    originCity: 'Ibadan',
    destinationCity: 'Ibadan',
    pickupArea: 'Challenge',
    dropoffArea: 'Ring Road',
    pickupAddress: '22 Lagos Bypass',
    dropoffAddress: '5 Adeoyo Street',
    pickupLat: null,
    pickupLng: null,
    dropoffLat: null,
    dropoffLng: null,
    senderId: SESSION_USER.id,
    captureSessionId: null,
    pickupContactName: 'Sender',
    senderPhone: '+2348077778888',
    recipientName: 'Bisi Adeyemi',
    recipientPhone: '+2348123456789',
    itemDescription: 'Set of drinking glasses',
    itemPhotoUri: null,
    category: 'Other',
    weight: 1.2,
    declaredValue: 18000,
    fragile: true,
    notes: 'Glassware — do not stack.',
    estimatedFee: 4400,
    status: 'Booked',
    driver: null,
    driverId: null,
    acceptedAt: null,
    createdAt: '2026-08-03T07:45:00.000Z',
  },
  {
    ...NO_DELIVERY_RECORD,
    id: 'seed-5',
    trackingId: 'PKG-6153',
    deliveryType: 'interstate',
    pickupMode: 'hub',
    dropoffMode: 'hub',
    originCity: 'Ibadan',
    destinationCity: 'Abuja',
    pickupArea: 'Mokola',
    dropoffArea: 'Wuse II',
    pickupAddress: '31 Queen Elizabeth Road',
    dropoffAddress: '14 Aminu Kano Crescent',
    pickupLat: null,
    pickupLng: null,
    dropoffLat: null,
    dropoffLng: null,
    senderId: 'user-tunde',
    captureSessionId: null,
    pickupContactName: 'Sender',
    senderPhone: '+2348099990000',
    recipientName: 'Emeka Nwosu',
    recipientPhone: '+2348134567890',
    itemDescription: 'Textbooks and stationery',
    itemPhotoUri: null,
    category: 'Other',
    weight: 5.8,
    declaredValue: 30000,
    fragile: false,
    notes: '',
    estimatedFee: 10900,
    status: 'Booked',
    driver: null,
    driverId: null,
    acceptedAt: null,
    createdAt: '2026-08-03T06:20:00.000Z',
  },
];

/** What a claim attempt actually did — the UI has to distinguish these. */
export type ClaimResult = 'claimed' | 'taken' | 'error';

type BookingsContextValue = {
  bookings: Booking[];
  /** True during the first load, so screens can avoid flashing an empty state. */
  loading: boolean;
  /** Set when the last server call failed. Null once a call succeeds. */
  error: string | null;
  refresh: () => Promise<void>;
  addBooking: (input: NewBookingInput) => Promise<Booking | null>;
  acceptBooking: (id: string) => Promise<ClaimResult>;
  getBooking: (trackingId: string) => Booking | undefined;
};

const BookingsContext = createContext<BookingsContextValue | null>(null);

export function BookingsProvider({ children }: { children: ReactNode }) {
  /*
   * Two modes.
   *
   * With Supabase configured, this is a cache of the `bookings` table and every
   * mutation is a round trip — which is what makes an accepted job survive a
   * refresh and follow the driver to another device.
   *
   * Without it, the store falls back to the in-memory seed data so the app is
   * still explorable before anyone has run `supabase/schema.sql`. That fallback
   * is a development convenience, not a feature: nothing persists in it.
   */
  const remote = isSupabaseConfigured;

  const [bookings, setBookings] = useState<Booking[]>(remote ? [] : SEED_BOOKINGS);
  const [loading, setLoading] = useState(remote);
  const [error, setError] = useState<string | null>(null);

  // Ownership is stamped here rather than by the form, so no screen can post a
  // parcel on someone else's behalf.
  const { user } = useSession();

  const refresh = useCallback(async () => {
    if (!remote) return;

    try {
      setBookings(await fetchBookings());
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not load parcels.'));
    } finally {
      setLoading(false);
    }
  }, [remote]);

  /*
   * Reload whenever the signed-in user changes. Row Level Security decides what
   * the server returns, so a stale list from the previous session would be both
   * wrong and a leak — signing out has to empty it, not just stop updating it.
   */
  useEffect(() => {
    if (!remote) return;

    if (!user) {
      setBookings([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    void refresh();
  }, [remote, user?.id, refresh]);

  const addBooking = useCallback(
    async (input: NewBookingInput): Promise<Booking | null> => {
      // Posting is gated behind sign-in, so this is a routing bug if it fires.
      if (!user) return null;

      const draft = {
        ...input,
        trackingId: generateTrackingId(),
        senderId: user.id,
        status: input.status ?? ('Booked' as BookingStage),
      };

      if (!remote) {
        const booking: Booking = {
          ...draft,
          id: `booking-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          driver: null,
          driverId: null,
          acceptedAt: null,
          createdAt: new Date().toISOString(),
          ...NO_DELIVERY_RECORD,
        };
        setBookings((prev) => [booking, ...prev]);
        return booking;
      }

      try {
        const booking = await insertBooking(draft);
        // Newest first, matching the server's ordering.
        setBookings((prev) => [booking, ...prev]);
        setError(null);
        return booking;
      } catch (thrown) {
        /*
         * ⚠ A schema gap named, before the generic sentence.
         *
         *   The client writes columns that migrations add — `capture_session_id`
         *   since 44 — and PostgREST refuses the whole row when one is not
         *   there. Untranslated that reached the booking form as "Check your
         *   connection and try again", shown to somebody whose connection was
         *   fine, about a database that was four migrations behind.
         */
        setError(schemaGapMessage(thrown) ?? errorMessage(thrown, 'Could not post the parcel.'));
        return null;
      }
    },
    [remote, user],
  );

  /**
   * Claim a job for the signed-in driver.
   *
   * Returns `taken` rather than throwing when someone else got there first:
   * that is a normal outcome in a marketplace, not an error, and the driver
   * needs to be told plainly rather than shown a failure.
   */
  const acceptBooking = useCallback(
    async (id: string): Promise<ClaimResult> => {
      if (!user) return 'error';

      if (!remote) {
        let outcome: ClaimResult = 'taken';
        setBookings((prev) =>
          prev.map((booking) => {
            if (booking.id !== id || booking.driver) return booking;
            outcome = 'claimed';
            return {
              ...booking,
              driver: user.name,
              driverId: user.id,
              acceptedAt: new Date().toISOString(),
              status: 'Assigned',
            };
          }),
        );
        return outcome;
      }

      try {
        const claimed = await claimBooking(id, { id: user.id, name: user.name });

        if (!claimed) {
          // Someone else has it. Drop it from the feed so the stale card goes.
          await refresh();
          return 'taken';
        }

        setBookings((prev) => prev.map((booking) => (booking.id === id ? claimed : booking)));
        setError(null);
        return 'claimed';
      } catch (thrown) {
        setError(errorMessage(thrown, 'Could not accept the job.'));
        return 'error';
      }
    },
    [remote, user, refresh],
  );

  const getBooking = useCallback(
    (trackingId: string) =>
      bookings.find((booking) => booking.trackingId.toLowerCase() === trackingId.toLowerCase()),
    [bookings],
  );

  const value = useMemo(
    () => ({ bookings, loading, error, refresh, addBooking, acceptBooking, getBooking }),
    [bookings, loading, error, refresh, addBooking, acceptBooking, getBooking],
  );

  return <BookingsContext.Provider value={value}>{children}</BookingsContext.Provider>;
}

export function useBookings(): BookingsContextValue {
  const context = useContext(BookingsContext);

  if (!context) {
    throw new Error('useBookings must be used within a BookingsProvider');
  }

  return context;
}

/** Case-insensitive match across tracking ID, recipient, cities, areas, and addresses. */
export function filterBookings(bookings: Booking[], query: string): Booking[] {
  const term = query.trim().toLowerCase();

  if (!term) {
    return bookings;
  }

  return bookings.filter((booking) =>
    [
      booking.trackingId,
      booking.itemDescription,
      booking.recipientName,
      booking.originCity,
      booking.destinationCity,
      booking.pickupArea,
      booking.dropoffArea,
      booking.pickupAddress,
      booking.dropoffAddress,
    ]
      .join(' ')
      .toLowerCase()
      .includes(term),
  );
}

/**
 * Waiting for a driver to accept it. This is the state that needs the user's
 * attention, so it sorts first and gets the pulsing highlight.
 *
 * Note it's derived, not a raw status: the stored status is 'Booked', and what
 * makes it pending is that no driver has claimed it.
 */
export function isPendingPickup(booking: Booking): boolean {
  return booking.status === 'Booked' && !booking.driver;
}

/** Lower sorts higher. Pending first, delivered last. */
function pickupPriority(booking: Booking): number {
  if (isPendingPickup(booking)) return 0;

  switch (booking.status) {
    case 'Out for Delivery':
      return 1;
    case 'In Transit':
      return 2;
    case 'Picked Up':
      return 3;
    case 'Assigned':
      return 4;
    case 'Booked':
      return 5;
    case 'Delivered':
      return 6;
    /*
      Last, below Delivered.

      Without this the `default` branch returned 5 — the same rank as a freshly
      booked parcel — and a cancelled shipment sorted above a delivered one in
      a list ordered by "needs attention". A cancelled parcel needs none.
    */
    case 'Cancelled':
      return 7;
    default:
      return 5;
  }
}

/**
 * Orders parcels by how much they need attention. Ties break newest-first so
 * the sort is stable and predictable rather than dependent on insertion order.
 */
export function sortByPickupUrgency(bookings: Booking[]): Booking[] {
  return [...bookings].sort((a, b) => {
    const delta = pickupPriority(a) - pickupPriority(b);
    if (delta !== 0) return delta;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * Short description of the job shape for the driver feed — "Hub → Hub",
 * "Hub → Door" and so on. This replaced the delivery-speed metric, which no
 * longer exists: what a driver needs to know is how many door legs the job
 * involves, since that's what costs them time.
 */
/**
 * The words the booking form uses for each mode. Kept here so the form, the
 * confirmation screen and the driver feed can't describe the same parcel three
 * different ways — "Door → Meet" meant nothing to a sender who chose
 * "Public location pickup".
 */
/**
 * What the handover fee line should be called for a given pair of modes.
 *
 * Centralised because the wording is not derivable from a leg count any more:
 * one leg could be either end, and "Doorstep · pickup" is now simply wrong —
 * the chargeable pickup is a hub, not a door.
 */
export function handoverFeeLabel(
  pickupMode: HandoverMode | undefined,
  dropoffMode: HandoverMode | undefined,
): string {
  const parts: string[] = [];
  if (isChargeableHandover(pickupMode, 'pickup')) parts.push('hub pickup');
  if (isChargeableHandover(dropoffMode, 'dropoff')) parts.push('doorstep delivery');

  if (parts.length === 0) return 'Handover';
  return `Handover · ${parts.join(' and ')}`;
}

export function handoverModeLabel(mode: HandoverMode, end: 'pickup' | 'dropoff'): string {
  if (mode === 'hub') return end === 'pickup' ? 'LOCI hub' : 'LOCI hub (OTP collection)';
  if (mode === 'meetpoint') return 'Public location';
  return end === 'pickup' ? 'Public location pickup' : 'Home/office drop-off';
}

/** "Public location pickup · 56 dun dolly do, danladi, Abakaliki" */
export function pickupSummaryLine(args: {
  mode: HandoverMode;
  address: string;
  area: string;
  city: string;
}): string {
  const where = [args.address.trim(), args.area, args.city].filter(Boolean).join(', ');
  return `${handoverModeLabel(args.mode, 'pickup')} · ${where || args.city}`;
}

/** "LOCI hub (OTP collection) · jalingo, Abakaliki" */
export function dropoffSummaryLine(args: {
  mode: HandoverMode;
  address: string;
  area: string;
  city: string;
}): string {
  const where = [args.address.trim(), args.area, args.city].filter(Boolean).join(', ');
  return `${handoverModeLabel(args.mode, 'dropoff')} · ${where || args.city}`;
}

export function handoverLabel(booking: Booking): string {
  const end = (mode: HandoverMode) =>
    mode === 'hub' ? 'Hub' : mode === 'meetpoint' ? 'Meet' : 'Door';
  return `${end(booking.pickupMode)} → ${end(booking.dropoffMode)}`;
}

/**
 * Human-readable pickup expectation, derived rather than stored.
 *
 * There are no speed tiers: a parcel moves when a driver already travelling
 * that route claims it, so the honest answer depends on how far it's going and
 * whether someone has to come to the door. Replace with a real `pickupBy`
 * timestamp when the backend can set one.
 */
export function pickupWindow(booking: Booking): string {
  if (booking.pickupMode === 'hub') {
    return 'Drop off at your hub any time it is open';
  }

  // Phrased with the same words the form used, so the sender recognises it.
  const where = handoverModeLabel(booking.pickupMode, 'pickup');
  const window = booking.deliveryType === 'local' ? '24 hours' : '48 hours';
  return `${where} within ${window}`;
}

/** Rough parcel size band, shown to drivers alongside the category. */
export function sizeBand(booking: Booking): string {
  if (booking.weight <= 1) return 'Envelope';
  if (booking.weight <= 5) return 'Small box';
  if (booking.weight <= 20) return 'Medium box';
  return 'Large / freight';
}

/**
 * Unassigned parcels on a specific route. Either end accepts 'all', so a driver
 * can browse everything leaving a city without fixing the destination.
 */
export function bookingsOnRoute(
  bookings: Booking[],
  originCity: City | 'all',
  destinationCity: City | 'all',
): Booking[] {
  return bookings.filter(
    (b) =>
      !b.driver &&
      (originCity === 'all' || b.originCity === originCity) &&
      (destinationCity === 'all' || b.destinationCity === destinationCity),
  );
}

/** Name the signed-in user drives under. Stand-in until driver auth exists. */
export const CURRENT_DRIVER = SESSION_USER.name;

/**
 * Parcels this user is party to — ones they posted, plus ones they're driving.
 * Everything else, including other people's unclaimed jobs, is deliberately
 * absent: those belong to the Available Jobs feed, not to a personal list.
 */
export function parcelsForUser(bookings: Booking[], userId: string): Booking[] {
  return bookings.filter((booking) => booking.senderId === userId || booking.driverId === userId);
}

/** True when the user posted this parcel. */
export function isSender(booking: Booking, userId: string): boolean {
  return booking.senderId === userId;
}

/** True when the user is the driver carrying it. */
export function isCarrier(booking: Booking, userId: string): boolean {
  return booking.driverId === userId;
}

export type ActiveRole = 'driver' | 'sender';

export type ActiveMovement = {
  id: string;
  trackingId: string;
  role: ActiveRole;
  /** Where it's headed, e.g. "Bodija Market, Ibadan". */
  destination: string;
  /** Who receives it — what the ticker names in both roles. */
  recipientName: string;
  /** Who's carrying it, or null while the job is still unclaimed. */
  driverName: string | null;
};

/**
 * Parcels currently moving, split by the user's role. A parcel you accepted as
 * a driver reads "Delivering to"; one you posted reads "On the way to". Someone
 * doing both gets an entry in each list.
 */
export function activeMovements(
  bookings: Booking[],
  userId: string = SESSION_USER.id,
): ActiveMovement[] {
  return (
    parcelsForUser(bookings, userId)
      /*
        Anything still in motion. Cancelled counts as stopped: filtering on
        `!== 'Delivered'` alone put cancelled parcels in the live ticker,
        scrolling past as though they were on their way somewhere.
      */
      .filter((b) => !isFinished(b))
      .map((b) => ({
        id: b.id,
        trackingId: b.trackingId,
        role: (b.driverId === userId ? 'driver' : 'sender') as ActiveRole,
        destination: `${b.dropoffArea}, ${b.destinationCity}`,
        recipientName: b.recipientName,
        driverName: b.driver,
      }))
  );
}

/**
 * Jobs still waiting for a driver, optionally narrowed by route type and origin city.
 * A job is "available" when no driver has accepted it yet.
 */
export function availableBookings(
  bookings: Booking[],
  deliveryType: DeliveryType | 'all',
  originCity: City | 'all' = 'all',
): Booking[] {
  return bookings.filter(
    (booking) =>
      !booking.driver &&
      (deliveryType === 'all' || booking.deliveryType === deliveryType) &&
      (originCity === 'all' || booking.originCity === originCity),
  );
}
