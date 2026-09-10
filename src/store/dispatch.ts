import { supabase } from '@/lib/supabase';
import { MAX_DEPARTURE_DAYS } from '@/lib/departure';
import type { City } from '@/store/bookings';

/**
 * Automated dispatch, from the client's side.
 *
 * A driver declares the journeys they are making; parcels on those routes are
 * offered to them one at a time and held briefly. They accept, decline, or let
 * it lapse.
 *
 * The rules are in `supabase/migrations/20250101000015_dispatch.sql` and every one of them is enforced
 * there — the matcher and the expiry sweeper are not even granted to
 * `authenticated`, so nothing here can trigger dispatch. This module declares
 * journeys, reads offers, and answers them.
 *
 * ⚠ Dispatch is not finished. There is no push notification, so an offer held
 *   for five minutes only surfaces if the driver happens to have the app open.
 *   Until `expo-notifications` is wired in, expect most offers to expire. Said
 *   plainly here because it is invisible from the code that follows.
 */

export type JourneyStatus = 'open' | 'paused' | 'completed' | 'cancelled';

/**
 * How a driver is working right now.
 *
 *   scheduled  a planned interstate route, declared ahead — "Ibadan → Lagos
 *              this afternoon".
 *   flash      an ad-hoc shift inside one city — "I am in Ibadan and free for
 *              two hours". Local parcels only.
 *
 * ⚠ Flash is not cosmetic. Until `supabase/migrations/20250101000018_flash_mode.sql`, no local parcel
 *   could be dispatched at all: a journey was forbidden from having the same
 *   city at both ends, and matching required both ends to equal the parcel's.
 *   Every local parcel went silently past the matcher onto the open board.
 */
export type OperatingMode = 'scheduled' | 'flash';

export const MODE_LABEL: Record<OperatingMode, string> = {
  scheduled: 'Scheduled',
  flash: 'Flash',
};

export const MODE_MEANING: Record<OperatingMode, string> = {
  scheduled: 'Interstate · you declare a route in advance',
  flash: 'Intrastate · local jobs offered while you are online',
};

export type Journey = {
  id: string;
  mode: OperatingMode;
  originCity: City;
  destinationCity: City;
  departsAfter: string;
  /**
   * When this journey stops being offered parcels.
   *
   * For a scheduled route the database keeps this equal to `departureAt`; for a
   * flash shift it is the end of the shift and `departureAt` is null. Reading
   * this is how one piece of code can ask "is it still listening" without
   * caring which kind it has.
   */
  departsBefore: string;
  /** The exact departure a driver chose. Null on flash shifts. */
  departureAt: string | null;
  capacityKg: number;
  vehicleType: string;
  status: JourneyStatus;
  createdAt: string;
};

export type NewJourney = {
  originCity: City;
  destinationCity: City;
  /**
   * The exact moment this driver leaves.
   *
   * Replaces the `departsAfter`/`departsBefore` pair. A driver used to say
   * "leaving within 4 hours" and the form turned that into a window; they now
   * pick a time. The database derives `departs_before` from this — see
   * `journey_departure_sync` in `supabase/migrations/20250101000026_departure_time.sql` — so there is
   * one value here and one on the row.
   */
  departureAt: Date;
  capacityKg: number;
  vehicleType: string;
};

type JourneyRow = {
  id: string;
  mode?: string;
  origin_city: string;
  destination_city: string;
  departs_after: string;
  departs_before: string;
  departure_time?: string | null;
  capacity_kg: number | string;
  vehicle_type: string;
  status: string;
  created_at: string;
};

const toJourney = (row: JourneyRow): Journey => ({
  id: row.id,
  // Rows written before flash existed have no mode and are all scheduled.
  mode: row.mode === 'flash' ? 'flash' : 'scheduled',
  originCity: row.origin_city as City,
  destinationCity: row.destination_city as City,
  departsAfter: row.departs_after,
  departsBefore: row.departs_before,
  // Absent on rows written before 20250101000026_departure_time.sql, and on flash shifts.
  departureAt: row.departure_time ?? null,
  capacityKg: Number(row.capacity_kg),
  vehicleType: row.vehicle_type,
  status: row.status as JourneyStatus,
  createdAt: row.created_at,
});

// ------------------------------------------------------------ validation ---

export type JourneyErrors = Partial<Record<keyof NewJourney, string>>;

/**
 * What the form refuses before it reaches the server.
 *
 * The database enforces the ordering and the positive capacity; this exists so
 * a driver standing at a junction gets a sentence rather than a constraint
 * violation. Everything checked here is checked again there.
 */
export function validateJourney(input: NewJourney, now: Date = new Date()): JourneyErrors {
  const errors: JourneyErrors = {};

  if (input.originCity === input.destinationCity) {
    errors.destinationCity = 'Pick a different city from where you are starting.';
  }

  if (!(input.capacityKg > 0)) {
    errors.capacityKg = 'How many kilograms can you carry?';
  } else if (input.capacityKg > 1000) {
    /*
     * An upper bound, because a typo here is expensive.
     *
     * A driver who means 50 and types 500 will be offered parcels no motorcycle
     * can take, decline them all, and look unreliable in the dispatch log for a
     * mistake the form let through.
     */
    errors.capacityKg = 'That is more than any Package Relay vehicle carries. Check the number.';
  }

  if (!(input.departureAt instanceof Date) || Number.isNaN(input.departureAt.getTime())) {
    errors.departureAt = 'Pick when you are leaving.';
  } else if (input.departureAt <= now) {
    errors.departureAt = 'That time has already passed.';
  } else if (input.departureAt.getTime() - now.getTime() > MAX_DEPARTURE_DAYS * 24 * 3600_000) {
    /*
     * An upper bound, because an exact picker invites one.
     *
     * The old field asked for hours and could not express "three weeks". A
     * route declared that far out listens for three weeks, collecting offers
     * for parcels whose senders expect them to move today — and a mistyped year
     * would listen forever.
     *
     * ⚠ This is a client bound, which is a courtesy rather than a rule. The
     *   database enforces only that a departure is in the future
     *   (`journey_window_ordered`, once `departs_after` defaults to now()).
     *   The ceiling belongs there too if it matters; the right number is a
     *   product decision.
     */
    errors.departureAt = `Pick a departure within the next ${MAX_DEPARTURE_DAYS} days.`;
  }

  return errors;
}

// -------------------------------------------------------------- journeys ---

export async function declareJourney(input: NewJourney): Promise<Journey | null> {
  const { data: auth } = await supabase.auth.getUser();
  const driverId = auth.user?.id;
  if (!driverId) return null;

  const { data, error } = await supabase
    .from('driver_journeys')
    .insert({
      driver_id: driverId,
      origin_city: input.originCity,
      destination_city: input.destinationCity,
      /*
       * `departs_before` is not sent.
       *
       * The before-insert trigger sets it from `departure_time`, and
       * `departs_after` defaults to `now()`. Sending either from here would be
       * a second opinion about a value the database already owns — and the one
       * that loses is whichever the trigger overwrites, silently.
       */
      departure_time: input.departureAt.toISOString(),
      capacity_kg: input.capacityKg,
      vehicle_type: input.vehicleType,
    })
    .select()
    .single();

  if (error || !data) return null;
  return toJourney(data as JourneyRow);
}

export async function fetchJourneys(): Promise<Journey[]> {
  const { data, error } = await supabase
    .from('driver_journeys')
    .select('*')
    /*
     * Soonest departure first, matching how the matcher ranks them.
     *
     * This ordered on `departs_after`, which under the window model was the
     * earliest a driver might leave. With an exact departure that column is
     * just "when the route was declared", so a list ordered by it puts an old
     * declaration for next week above one leaving in an hour.
     */
    .order('departs_before', { ascending: true });

  if (error || !data) return [];
  return (data as JourneyRow[]).map(toJourney);
}

/**
 * Withdraws a route.
 *
 * Any offer still out on it is expired server-side and its parcel re-dispatched
 * at once — see `cancel_journey` in `supabase/migrations/20250101000027_journey_edit.sql`. Cancelling
 * a route does not release a parcel already accepted; that is done on Assigned
 * Trip, where the parcel actually lives.
 */
export async function cancelJourney(id: string): Promise<boolean> {
  const { error } = await supabase.rpc('cancel_journey', { journey: id });
  return !error;
}

export type JourneyEdit = {
  originCity?: City;
  destinationCity?: City;
  capacityKg?: number;
  departureAt?: Date;
};

/**
 * Changes a route's terms.
 *
 * Returns the server's message on failure rather than a bare false, because
 * every way this can fail is something the driver has to act on: an offer
 * waiting to be answered, a shift rather than a route, a journey already gone.
 * "Could not save" would leave them tapping the same button.
 */
export async function updateJourney(
  id: string,
  edit: JourneyEdit,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc('update_journey', {
    journey: id,
    // Null means "leave it", so only what changed has to be sent.
    new_origin: edit.originCity ?? null,
    new_destination: edit.destinationCity ?? null,
    new_capacity: edit.capacityKg ?? null,
    new_departure: edit.departureAt?.toISOString() ?? null,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Stops new offers without deleting the declaration. */
export async function setJourneyStatus(id: string, status: JourneyStatus): Promise<boolean> {
  const { error } = await supabase.from('driver_journeys').update({ status }).eq('id', id);
  return !error;
}

// ---------------------------------------------------------------- offers ---

/**
 * How long a driver has to answer, by trip type.
 *
 * Mirrors `public.offer_hold` in `supabase/migrations/20250101000021_offer_windows.sql`, and the
 * verification suite asserts the two agree — a client that promised five
 * minutes on a ten-minute hold would have drivers giving up early.
 *
 * The asymmetry: a flash driver is holding the phone waiting, so five minutes is
 * generous and a longer hold just parks a local parcel somebody else could take.
 * A scheduled driver is driving, loading, or eating, and ten minutes is the
 * difference between an offer they can answer and one that was never theirs.
 */
export const OFFER_HOLD_MINUTES: Record<'local' | 'interstate', number> = {
  local: 5,
  interstate: 10,
};

/**
 * How long a parcel stays away from a driver who said no to it.
 *
 * Mirrors `public.offer_cooldown` in `supabase/migrations/20250101000023_offer_cooldown.sql`. Covers
 * both kinds of no — an explicit decline and a countdown that ran out — because
 * from the parcel's point of view they are the same event: this driver is not
 * taking it right now.
 *
 * Scoped to the pair, never to the driver. Somebody in cooldown on one parcel
 * keeps receiving every other parcel, and the parcel keeps rotating through
 * everybody else. The cooldown removes one edge from the queue, not a node.
 */
export const OFFER_COOLDOWN_MINUTES = 15;

/** The window a parcel's offer gets. Matches `offer_hold(is_local)` in SQL. */
export function offerHoldMinutes(isLocal: boolean): number {
  return isLocal ? OFFER_HOLD_MINUTES.local : OFFER_HOLD_MINUTES.interstate;
}

export type OfferStatus = 'offered' | 'accepted' | 'declined' | 'expired';

export type DispatchOffer = {
  id: string;
  bookingId: string;
  journeyId: string;
  status: OfferStatus;
  offeredAt: string;
  expiresAt: string;
};

type OfferRow = {
  id: string;
  booking_id: string;
  journey_id: string;
  status: string;
  offered_at: string;
  expires_at: string;
};

const toOffer = (row: OfferRow): DispatchOffer => ({
  id: row.id,
  bookingId: row.booking_id,
  journeyId: row.journey_id,
  status: row.status as OfferStatus,
  offeredAt: row.offered_at,
  expiresAt: row.expires_at,
});

/**
 * Offers currently waiting on this driver.
 *
 * Filtered on expiry client-side as well as by status, because the sweeper runs
 * on a schedule and an offer can be past its hold while still marked 'offered'.
 * Showing one of those would let a driver tap accept on a parcel the server is
 * about to hand to somebody else.
 */
export async function fetchLiveOffers(now: Date = new Date()): Promise<DispatchOffer[]> {
  const { data, error } = await supabase
    .from('dispatch_offers')
    .select('*')
    .eq('status', 'offered')
    .order('offered_at', { ascending: true });

  if (error || !data) return [];

  return (data as OfferRow[])
    .map(toOffer)
    .filter((offer) => Date.parse(offer.expiresAt) > now.getTime());
}

/**
 * Whole seconds left on an offer, floored at zero.
 *
 * Read from the row rather than computed from a constant, so a five-minute and
 * a ten-minute offer both count down correctly without this needing to know
 * which kind it is looking at.
 */
export function secondsLeft(offer: DispatchOffer, now: Date = new Date()): number {
  const remaining = Date.parse(offer.expiresAt) - now.getTime();
  return remaining > 0 ? Math.floor(remaining / 1000) : 0;
}

/**
 * Offers this driver was given and never answered.
 *
 * Dispatch reaching a driver and the driver seeing it are different events, and
 * until push notifications are deployed they come apart constantly: an offer is
 * created, held its five or ten minutes, expires, and rolls to somebody else
 * without the app ever having said anything.
 *
 * From inside the app that is indistinguishable from Package Relay having no work — the
 * driver sits on "you're online" for an afternoon and concludes the platform is
 * empty or that they are being passed over. Counting the misses is what turns a
 * silent failure into one they can see and report.
 *
 * Deliberately not filtered to 'expired'. A sweeper that is not running leaves
 * lapsed rows marked 'offered' — the exact bug `20250101000020_dispatch_repair.sql` fixed —
 * and reading only 'expired' would report zero misses precisely when dispatch is
 * most broken.
 */
export async function fetchMissedOffers(
  sinceHours = 12,
  now: Date = new Date(),
): Promise<DispatchOffer[]> {
  const since = new Date(now.getTime() - sinceHours * 3600_000).toISOString();

  const { data, error } = await supabase
    .from('dispatch_offers')
    .select('*')
    .neq('status', 'accepted')
    .neq('status', 'declined')
    .gte('offered_at', since)
    .order('offered_at', { ascending: false });

  if (error || !data) return [];

  return (data as OfferRow[])
    .map(toOffer)
    .filter((offer) => Date.parse(offer.expiresAt) <= now.getTime());
}

/**
 * When a countdown should start looking urgent.
 *
 * A fifth of the window, so a five-minute offer turns amber at one minute and a
 * ten-minute one at two. A flat threshold would either nag through half of a
 * short offer or arrive too late on a long one.
 */
export function offerIsUrgent(offer: DispatchOffer, now: Date = new Date()): boolean {
  const total = Math.max(1, (Date.parse(offer.expiresAt) - Date.parse(offer.offeredAt)) / 1000);
  return secondsLeft(offer, now) <= total / 5;
}

export type OfferResponse = 'accepted' | 'declined' | 'gone';

/**
 * Answers an offer.
 *
 * 'gone' covers every way the parcel can stop being available between the
 * screen rendering and the tap landing — expired hold, claimed from the board,
 * already answered on another device. They are one outcome from the driver's
 * point of view: it is not theirs, and the list should refresh.
 */
export async function respondToOffer(offerId: string, accept: boolean): Promise<OfferResponse> {
  const { data, error } = await supabase.rpc('respond_to_offer', {
    offer_id: offerId,
    accept,
  });

  if (error) return 'gone';
  return String(data) === 'accepted' ? 'accepted' : 'declined';
}

// ------------------------------------------------------------- the card ----

export type MatchStatus =
  | { kind: 'offer'; count: number }
  | { kind: 'carrying'; count: number }
  | { kind: 'waiting'; journeys: number }
  | { kind: 'idle' };

/**
 * What the driver's dashboard card should say about matching, in priority
 * order: something needs an answer, something is in your hands, something is
 * listening, or nothing at all.
 *
 * Pure so the wording can be tested without a database — the summary card is
 * the one place a driver checks at a glance, and "Active" appearing when
 * nothing is active is the kind of error nobody reports.
 */
export function matchStatus(input: {
  liveOffers: number;
  activeJobs: number;
  openJourneys: number;
}): MatchStatus {
  if (input.liveOffers > 0) return { kind: 'offer', count: input.liveOffers };
  if (input.activeJobs > 0) return { kind: 'carrying', count: input.activeJobs };
  if (input.openJourneys > 0) return { kind: 'waiting', journeys: input.openJourneys };
  return { kind: 'idle' };
}

export function matchStatusLabel(status: MatchStatus): string {
  switch (status.kind) {
    case 'offer':
      return status.count === 1 ? '1 trip offered — answer now' : `${status.count} trips offered`;
    case 'carrying':
      return status.count === 1 ? 'Carrying 1 parcel' : `Carrying ${status.count} parcels`;
    case 'waiting':
      return status.journeys === 1
        ? 'Listening on 1 journey'
        : `Listening on ${status.journeys} journeys`;
    case 'idle':
      // Not "no matches" — there is nothing to match against, and the fix is a
      // declared trip rather than patience. Named after the button that does
      // it, so the hint and the control a driver has to find agree.
      return 'Use Setup Trip to get offers';
  }
}

// ------------------------------------------------------------ flash shifts ---

/**
 * Goes online for local work in one city.
 *
 * Returns the shift id, or null. The server also sweeps the unclaimed board on
 * the way in, so a driver coming online is offered the local parcel that has
 * been waiting since this morning rather than only the next one posted — a
 * two-hour shift that saw only new parcels would be mostly an empty two hours.
 */
export async function startFlashShift(
  city: City,
  hours = 2,
  capacityKg = 20,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('start_flash_shift', {
    city,
    hours,
    capacity: capacityKg,
  });
  if (error) return null;
  return String(data);
}

export async function endFlashShift(): Promise<boolean> {
  const { error } = await supabase.rpc('end_flash_shift');
  return !error;
}

/** The driver's live flash shift, if they are online. */
export function activeFlashShift(journeys: Journey[], now: Date = new Date()): Journey | null {
  return (
    journeys.find(
      (journey) =>
        journey.mode === 'flash' &&
        journey.status === 'open' &&
        Date.parse(journey.departsBefore) > now.getTime(),
    ) ?? null
  );
}

/** Open scheduled routes. Flash shifts are not routes and are counted apart. */
export function scheduledJourneys(journeys: Journey[]): Journey[] {
  return journeys.filter((journey) => journey.mode === 'scheduled' && journey.status === 'open');
}

/**
 * What the home screen should offer, given the mode and what is live.
 *
 * Pure, so the wording can be tested without a database — this is the single
 * control on the driver's home screen and a button that describes the wrong
 * mode is worse than no button.
 */
export type ModeAction = {
  title: string;
  message: string;
  button: string;
};

/**
 * The tail of a waiting message.
 *
 * ⚠ This used to be one fixed sentence: "Keep this screen open — Package Relay cannot
 *   send you a phone notification yet." That was true of the product, so it was
 *   the right thing to say. Push is deployed now, so it is false for most
 *   drivers and the sentence had to go.
 *
 *   It is not simply deleted, because it is still true for *some* drivers: a
 *   phone where the permission was refused, a simulator, a device Expo could
 *   not mint a token for. Deleting the line outright would leave exactly the
 *   drivers who cannot be reached with no idea that they cannot be reached —
 *   which is worse than the stale copy, because at least the stale copy told
 *   everybody the truth about somebody.
 *
 *   So it follows the device. `alertsOn` comes from `pushIsEnabled()`, which
 *   reads the permission without prompting for it.
 */
function alertTail(alertsOn: boolean): string {
  return alertsOn
    ? 'We will alert you the moment one arrives, even if the app is closed.'
    : 'Notifications are off on this phone, so keep this screen open — an offer can expire before you see it.';
}

export function modeAction(input: {
  mode: OperatingMode;
  onlineFlash: boolean;
  openRoutes: number;
  /** Whether this device can actually receive a push. Defaults to off. */
  alertsOn?: boolean;
}): ModeAction {
  const tail = alertTail(input.alertsOn === true);

  if (input.mode === 'flash') {
    return input.onlineFlash
      ? {
          title: "You're online for local jobs",
          message: `Local parcels in your city are being offered to you as they are posted. ${tail}`,
          button: 'Go offline',
        }
      : {
          title: 'Nothing on your bike',
          message:
            'No trip assigned. Go online and local parcels in your city are offered to you straight away — no journey to plan.',
          button: 'Go online for local jobs',
        };
  }

  return input.openRoutes > 0
    ? {
        title: 'Nothing on your bike yet',
        /*
         * The same tail Flash gets.
         *
         * A scheduled driver with open routes is waiting for an offer exactly
         * as a flash driver is. Warning one and not the other left the
         * interstate driver — the one with the longer, more valuable trip — to
         * work out from missed work that the app could not reach them.
         */
        message: `Listening on ${input.openRoutes} ${
          input.openRoutes === 1 ? 'route' : 'routes'
        }. Parcels going your way are offered to you as they are posted. ${tail}`,
        button: 'Schedule another journey',
      }
    : {
        title: 'Nothing on your bike',
        message:
          'No trip assigned. Tell Package Relay where you are going and parcels on that route are offered to you.',
        button: 'Schedule a Journey',
      };
}
