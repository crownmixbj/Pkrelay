import { supabase } from '@/lib/supabase';

/**
 * Automatic matching, or a person placing every parcel.
 *
 * The switch is one row in `private.app_settings`, read by `dispatch_mode()`
 * and enforced inside `dispatch_booking` itself — see the header of
 * `supabase/migrations/20250101000032_dispatch_mode.sql` for why the gate is in the function rather
 * than on the insert trigger.
 *
 * ⚠ Manual does not pause Package Relay. Senders keep booking, drivers keep delivering,
 *   and offers already live keep their countdowns. The only thing that stops is
 *   the making of *new* offers. Every string in this file says so, because the
 *   opposite assumption is easy to form and expensive to hold.
 */

export type DispatchMode = 'auto' | 'manual';

export type DispatchHealth = {
  mode: DispatchMode;
  /** Parcels booked, paid for, and with nobody carrying them. */
  unassigned: number;
  /** How long the oldest one has been waiting. */
  oldestWaitMinutes: number;
  liveOffers: number;
  /** Approved drivers sidelined by a lapsed licence or insurance. */
  blockedDrivers: number;
};

export const UNKNOWN_HEALTH: DispatchHealth = {
  mode: 'auto',
  unassigned: 0,
  oldestWaitMinutes: 0,
  liveOffers: 0,
  blockedDrivers: 0,
};

/**
 * PostgREST's code for "no such function".
 *
 * Its own message — "Could not find the function public.set_dispatch_mode(mode)
 * in the schema cache" — is accurate and tells an operator nothing they can
 * act on. It means one of exactly two things, and both have a fix.
 */
const FUNCTION_MISSING = 'PGRST202';

function readableError(error: { code?: string; message: string }): string {
  if (error.code !== FUNCTION_MISSING) return error.message;

  return (
    'This database does not have the dispatch functions yet. Run ' +
    'supabase/migrations/20250101000031_document_expiry.sql and 20250101000032_dispatch_mode.sql, then reload the API ' +
    "schema cache (notify pgrst, 'reload schema')."
  );
}

export type HealthOutcome = { ok: true; health: DispatchHealth } | { ok: false; error: string };

/**
 * ⚠ Returns an outcome, not a `DispatchHealth`, and the change is the point.
 *
 *   This used to swallow the error and return `UNKNOWN_HEALTH` — mode 'auto',
 *   every count zero. That is indistinguishable from a healthy platform with an
 *   empty queue, so a screen that had failed to load anything at all rendered a
 *   green "Automatic matching is on. Nothing is waiting."
 *
 *   It was wrong in the most expensive direction available: the one panel whose
 *   job is to tell an operator whether parcels are moving reported that they
 *   were, on no evidence. A dispatch outage and a quiet Tuesday looked the same.
 */
export async function fetchDispatchHealth(): Promise<HealthOutcome> {
  const { data, error } = await supabase.rpc('dispatch_health');

  if (error) return { ok: false, error: readableError(error) };
  if (!data) return { ok: false, error: 'The server returned no dispatch status.' };

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, error: 'The server returned no dispatch status.' };

  return {
    ok: true,
    health: {
      mode: row.mode === 'manual' ? 'manual' : 'auto',
      unassigned: Number(row.unassigned ?? 0),
      oldestWaitMinutes: Number(row.oldest_wait_minutes ?? 0),
      liveOffers: Number(row.live_offers ?? 0),
      blockedDrivers: Number(row.blocked_drivers ?? 0),
    },
  };
}

export type ModeOutcome = { ok: true; mode: DispatchMode } | { ok: false; error: string };

/**
 * Flips the switch.
 *
 * ⚠ Returns the server's answer, not the requested one, and callers must render
 *   *that*.
 *
 *   Two admins can have this screen open at once. Optimistically showing what
 *   was clicked would leave the loser of that race looking at a toggle that
 *   disagrees with the platform — and this is the control that decides whether
 *   parcels move on their own.
 */
export async function setDispatchMode(mode: DispatchMode): Promise<ModeOutcome> {
  const { data, error } = await supabase.rpc('set_dispatch_mode', { mode });

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, mode: data === 'manual' ? 'manual' : 'auto' };
}

export type UnassignedParcel = {
  id: string;
  trackingId: string;
  originCity: string;
  destinationCity: string;
  weight: number;
  deliveryType: string;
  estimatedFee: number;
  waitingMinutes: number;
  /** How many drivers have already been offered it and passed. */
  offersMade: number;
};

/**
 * The queue, in both modes.
 *
 * Auto-dispatch leaves parcels unassigned routinely — nobody going that way,
 * every candidate in cooldown, the only match holding an expired licence. Those
 * are precisely the parcels a human should see, so this is not gated on the
 * mode.
 */
/**
 * ⚠ `null` for "could not load", `[]` for "genuinely nothing waiting".
 *
 *   Same failure as `fetchDispatchHealth` had: an empty array rendered "Nothing
 *   waiting. Every booked parcel has a driver or a live offer" — a specific,
 *   reassuring claim about a query that never returned.
 */
export async function fetchUnassignedParcels(limit = 100): Promise<UnassignedParcel[] | null> {
  const { data, error } = await supabase.rpc('unassigned_parcels', { limit_rows: limit });

  if (error || !data) return null;

  return (data as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    trackingId: String(row.tracking_id ?? ''),
    originCity: String(row.origin_city ?? ''),
    destinationCity: String(row.destination_city ?? ''),
    weight: Number(row.weight ?? 0),
    deliveryType: String(row.delivery_type ?? ''),
    estimatedFee: Number(row.estimated_fee ?? 0),
    waitingMinutes: Number(row.waiting_minutes ?? 0),
    offersMade: Number(row.offers_made ?? 0),
  }));
}

export type Candidate = {
  driverId: string;
  fullName: string;
  baseCity: string;
  vehicleType: string;
  phone: string;
  activeParcels: number;
  hasOpenJourney: boolean;
  routeMatches: boolean;
  documentsOk: boolean;
  /** False only for a hard refusal — currently just an expired document. */
  eligible: boolean;
  /** Plain English: what the matcher thinks of this driver for this parcel. */
  note: string;
};

/**
 * Who could take a parcel, including the ones the matcher would pass over.
 *
 * ⚠ Ineligible drivers are in this list on purpose. An operator is here because
 *   they know something the matcher does not — the driver who has not declared
 *   a route but is standing in the hub. Hiding everyone the automation would
 *   skip makes this a slower copy of the automation.
 */
export async function fetchCandidates(parcelId: string): Promise<Candidate[]> {
  const { data, error } = await supabase.rpc('assignable_drivers', { parcel: parcelId });

  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    driverId: String(row.driver_id),
    fullName: String(row.full_name ?? ''),
    baseCity: String(row.base_city ?? ''),
    vehicleType: String(row.vehicle_type ?? ''),
    phone: String(row.phone ?? ''),
    activeParcels: Number(row.active_parcels ?? 0),
    hasOpenJourney: row.has_open_journey === true,
    routeMatches: row.route_matches === true,
    documentsOk: row.documents_ok === true,
    eligible: row.eligible === true,
    note: String(row.note ?? ''),
  }));
}

export async function assignParcel(
  parcelId: string,
  driverId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc('admin_assign_parcel', {
    parcel: parcelId,
    driver: driverId,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ------------------------------------------------- the other direction ----

/**
 * A driver on an open shift with nothing in their hands.
 *
 * ⚠ The mirror of `UnassignedParcel`, and the two are read together.
 *
 *   One screen, two questions: why has this parcel not moved, and why is this
 *   driver idle. A platform that can only answer the first hears about the
 *   second from the driver.
 */
export type WaitingDriver = {
  driverId: string;
  fullName: string;
  /** Dialable (+234 …). The action after "waiting two hours" is to ring them. */
  phone: string;
  vehicleType: string;
  baseCity: string;
  journeyId: string;
  /** 'scheduled' is a declared route; 'flash' is a shift inside one city. */
  mode: 'scheduled' | 'flash';
  originCity: string;
  destinationCity: string;
  departsBefore: string | null;
  departureTime: string | null;
  capacityKg: number;
  /** Since they declared the shift. */
  waitingMinutes: number;
  /** Until it lapses. */
  leavesInMinutes: number;
  /**
   * Unassigned parcels this shift would match, counted through `journey_matches`
   * itself. A row with none is a driver nobody can help; a row with several is
   * either manual mode or the matcher failing.
   */
  matchingParcels: number;
  /** Offers they declined or let expire in the last 24h. */
  offersPassed: number;
  /** The matcher is skipping them after a decline. Not a reason not to assign. */
  inCooldown: boolean;
  deliveredToday: number;
};

/**
 * ⚠ `null` for "could not load", `[]` for "nobody is waiting" — the same
 *   distinction `fetchUnassignedParcels` draws, for the same reason: an empty
 *   array rendered as "everyone is busy" is a confident claim about a query
 *   that never returned.
 */
export async function fetchWaitingDrivers(limit = 50): Promise<WaitingDriver[] | null> {
  const { data, error } = await supabase.rpc('admin_waiting_drivers', { max_rows: limit });

  if (error || !data) return null;

  return (data as Record<string, unknown>[]).map((row) => ({
    driverId: String(row.driver_id),
    fullName: String(row.full_name ?? ''),
    phone: String(row.phone ?? ''),
    vehicleType: String(row.vehicle_type ?? ''),
    baseCity: String(row.base_city ?? ''),
    journeyId: String(row.journey_id ?? ''),
    mode: row.mode === 'flash' ? 'flash' : 'scheduled',
    originCity: String(row.origin_city ?? ''),
    destinationCity: String(row.destination_city ?? ''),
    departsBefore: (row.departs_before as string | null) ?? null,
    departureTime: (row.departure_time as string | null) ?? null,
    capacityKg: Number(row.capacity_kg ?? 0),
    waitingMinutes: Number(row.waiting_minutes ?? 0),
    leavesInMinutes: Number(row.leaves_in_minutes ?? 0),
    matchingParcels: Number(row.matching_parcels ?? 0),
    offersPassed: Number(row.offers_passed ?? 0),
    inCooldown: row.in_cooldown === true,
    deliveredToday: Number(row.delivered_today ?? 0),
  }));
}

/** An unassigned parcel, judged against one driver's shift. */
export type ParcelForDriver = UnassignedParcel & {
  /** Whether their open shift would have been offered it. */
  routeMatches: boolean;
  /** Plain English for the row that is not a match. */
  note: string;
};

/**
 * What one driver could be given.
 *
 * ⚠ Parcels the matcher would refuse them are in this list, marked — the same
 *   call `assignable_drivers` makes in the other direction. An operator is here
 *   because they know something the automation does not; a list that hid
 *   everything off-route would be a slower copy of the matcher.
 */
export async function fetchParcelsForDriver(driverId: string): Promise<ParcelForDriver[]> {
  const { data, error } = await supabase.rpc('admin_parcels_for_driver', { driver: driverId });

  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    trackingId: String(row.tracking_id ?? ''),
    originCity: String(row.origin_city ?? ''),
    destinationCity: String(row.destination_city ?? ''),
    weight: Number(row.weight ?? 0),
    deliveryType: String(row.delivery_type ?? ''),
    estimatedFee: Number(row.estimated_fee ?? 0),
    waitingMinutes: Number(row.waiting_minutes ?? 0),
    offersMade: Number(row.offers_made ?? 0),
    routeMatches: row.route_matches === true,
    note: String(row.note ?? ''),
  }));
}

/**
 * The tiles above the list.
 *
 * ⚠ Four of these six numbers are about drivers the list does not show, which
 *   is the question an operator asks the moment it is shorter than they
 *   expected. Without them an empty list and a broken query look identical.
 */
export type DriverAvailability = {
  approved: number;
  waiting: number;
  withOffer: number;
  carrying: number;
  offShift: number;
  /** On shift, and refused by the document gate. The one to act on. */
  blocked: number;
  unassignedParcels: number;
};

export const UNKNOWN_AVAILABILITY: DriverAvailability = {
  approved: 0,
  waiting: 0,
  withOffer: 0,
  carrying: 0,
  offShift: 0,
  blocked: 0,
  unassignedParcels: 0,
};

export async function fetchDriverAvailability(): Promise<DriverAvailability | null> {
  const { data, error } = await supabase.rpc('admin_driver_availability');

  if (error || !data) return null;

  const raw = data as Record<string, unknown>;

  return {
    approved: Number(raw.approved ?? 0),
    waiting: Number(raw.waiting ?? 0),
    withOffer: Number(raw.with_offer ?? 0),
    carrying: Number(raw.carrying ?? 0),
    offShift: Number(raw.off_shift ?? 0),
    blocked: Number(raw.blocked ?? 0),
    unassignedParcels: Number(raw.unassigned_parcels ?? 0),
  };
}

/**
 * How a shift reads on one line.
 *
 * Flash shifts have the same city at both ends by design, and rendering that as
 * "Ibadan → Ibadan" makes a deliberate shape look like a bug.
 */
export function shiftLabel(driver: Pick<WaitingDriver, 'mode' | 'originCity' | 'destinationCity'>): string {
  return driver.mode === 'flash'
    ? `In ${driver.originCity}`
    : `${driver.originCity} → ${driver.destinationCity}`;
}

// ------------------------------------------------------------------ words --

/** "2h 15m" — a queue age somebody can react to. */
export function waitLabel(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * What the mode banner says, and how loudly.
 *
 * ⚠ Manual mode with a backlog escalates to danger, and this is the only reason
 *   `dispatch_health` returns a count at all.
 *
 *   A toggle that silently stops dispatch and then shows nothing is how a
 *   platform spends a night not assigning parcels. Tying the tone to the actual
 *   queue means the screen gets louder as the cost of the setting grows,
 *   instead of looking identical at zero parcels and at ninety.
 */
export function modeBanner(health: DispatchHealth): {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  body: string;
} {
  if (health.mode === 'auto') {
    return {
      tone: 'success',
      title: 'Automatic matching is on',
      body:
        health.unassigned > 0
          ? `Package Relay is offering parcels to drivers as they are booked. ${health.unassigned} parcel${health.unassigned === 1 ? ' has' : 's have'} found nobody yet — oldest waiting ${waitLabel(health.oldestWaitMinutes)}.`
          : 'Package Relay is offering parcels to drivers as they are booked. Nothing is waiting.',
    };
  }

  if (health.unassigned === 0) {
    return {
      tone: 'warning',
      title: 'Manual assignment is on',
      body: 'No new offers are being made. Nothing is waiting yet — parcels booked from now on will sit here until you assign them.',
    };
  }

  return {
    tone: health.unassigned >= 5 || health.oldestWaitMinutes >= 60 ? 'danger' : 'warning',
    title: 'Manual assignment is on',
    body: `${health.unassigned} parcel${health.unassigned === 1 ? '' : 's'} waiting for you, oldest ${waitLabel(health.oldestWaitMinutes)}. No offers are being made automatically.`,
  };
}
