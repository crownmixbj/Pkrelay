import { errorMessage } from '@/lib/errors';
import { resolvePlaceCity, type AddressComponent, type PlaceResolution } from '@/lib/place-to-city';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { estimateRoadKm, type Distance, type Point } from '@/lib/distance';

/**
 * Address suggestions, and what they mean to the quote.
 *
 * Everything here goes through the `places-lookup` edge function — see that
 * file for why the Google key is not in this bundle.
 */

export type Suggestion = {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
};

/**
 * Whether address lookup can be used at all.
 *
 * ⚠ Three states, not two, and the third is the one that matters.
 *
 *   `unavailable` means the app should quietly offer the city picker instead:
 *   no key on this deployment, no network, Google rate-limiting us. None of
 *   those is the person's fault and none of them should cost them a quote, so
 *   they are not errors — they are a reason to show a different control.
 */
export type LookupStatus = 'idle' | 'searching' | 'unavailable';

/**
 * Why lookup could not be used, when it could not.
 *
 * ⚠ Three reasons, not one boolean, because the field has to say which.
 *
 *   The first version collapsed all of these into `available: false`, and the
 *   field swapped itself for the city picker without a word. Somebody typing an
 *   address watched the control they were using turn into a dropdown and had no
 *   way to tell whether they had done something wrong, whether the feature was
 *   broken, or whether it had never been switched on. Silence is the worst
 *   answer of the three.
 */
export type Unavailable = 'not-configured' | 'refused' | 'unreachable';

export type SuggestionResult = {
  suggestions: Suggestion[];
  /** Null when lookup worked, whether or not it matched anything. */
  unavailable: Unavailable | null;
};

/**
 * How long a known outage is believed before trying again.
 *
 * ⚠ Long enough to stop a storm, short enough to notice a fix.
 *
 *   A minute means somebody who deploys the function waits at most a minute
 *   before the app picks it up, without a reload. Making it permanent for the
 *   session would be tidier for us and worse for them.
 */
const OUTAGE_COOLDOWN_MS = 60_000;

let outage: { reason: Unavailable; until: number } | null = null;

function knownOutage(): Unavailable | null {
  if (!outage) return null;
  if (Date.now() >= outage.until) {
    outage = null;
    return null;
  }
  return outage.reason;
}

export async function fetchSuggestions(
  input: string,
  sessionToken: string,
  /** The deployment panel needs the real state, not a remembered one. */
  options: { ignoreCooldown?: boolean } = {},
): Promise<SuggestionResult> {
  if (!isSupabaseConfigured) return { suggestions: [], unavailable: 'not-configured' };

  /*
   * ⚠ Stop asking something that has already said no.
   *
   *   Without this, a deployment where lookup is broken — no key, function not
   *   deployed, CORS refusing the preflight — gets one failed request per
   *   keystroke per field, forever. That is a console full of red for anybody
   *   debugging something else, a delay on every character while the failure
   *   round-trips, and on a metered connection somebody else's data.
   *
   *   The field's behaviour is identical either way: it already treats an
   *   unavailable lookup as "carry on typing". This only stops the asking.
   */
  if (!options.ignoreCooldown) {
    const remembered = knownOutage();
    if (remembered) return { suggestions: [], unavailable: remembered };
  }

  try {
    const { data, error } = await supabase.functions.invoke('places-lookup', {
      body: { mode: 'suggest', input, session_token: sessionToken },
    });

    /*
     * ⚠ An invoke error is most often the function not being deployed.
     *
     *   `functions.invoke` answers a missing function with a transport-level
     *   error rather than a 404 body, so this branch and a genuine network
     *   failure look identical from here. It is reported as unreachable, and
     *   the deployment panel — which probes the function directly — is where
     *   the difference is resolved.
     */
    if (error) return remember('unreachable');

    const payload = (data ?? {}) as {
      configured?: boolean;
      suggestions?: Suggestion[];
      error?: string;
    };

    if (payload.configured === false) return remember('not-configured');

    /*
     * Google refused: out of quota, key restricted, billing lapsed. Separated
     * from the two above because it is the one that is nobody's fault here and
     * usually fixes itself.
     */
    if (payload.error) return remember('refused');

    /*
     * An empty list from a working lookup is available — it means "nowhere
     * matched", which is worth saying rather than hiding the field for.
     *
     * It answered, so whatever was wrong before is not wrong now: any
     * remembered outage is cleared rather than left to time out.
     */
    outage = null;
    return { suggestions: payload.suggestions ?? [], unavailable: null };
  } catch {
    return remember('unreachable');
  }
}

/** Records the outage and answers with it, so callers read one shape. */
function remember(reason: Unavailable): SuggestionResult {
  outage = { reason, until: Date.now() + OUTAGE_COOLDOWN_MS };
  return { suggestions: [], unavailable: reason };
}

/**
 * Why lookup is unavailable, as a clause with no advice attached.
 *
 * ⚠ Split out because the two fields give different advice for the same cause.
 *
 *   The quote form falls back to a city picker, so it says "pick a city
 *   instead". The driver, guarantor and hub fields accept whatever is typed, so
 *   theirs says "type the address in full". They used to disagree about more
 *   than the advice: one named the cause and the other said only "Address
 *   search is unavailable", and that flatness cost real debugging time — a key
 *   Google was refusing read exactly like a key nobody had set, which read
 *   exactly like a function nobody had deployed.
 */
export function unavailableCause(reason: Unavailable): string {
  if (reason === 'not-configured') return 'Address search is not switched on yet';
  if (reason === 'refused') return 'Address search is busy right now';
  return 'Address search could not be reached';
}

/** What to tell somebody whose address field just turned into a dropdown. */
export function unavailableReason(reason: Unavailable): string {
  return `${unavailableCause(reason)} — pick a city instead.`;
}

/**
 * Whether the lookup is usable at all, without asking Google anything.
 *
 * ⚠ Free to call, deliberately.
 *
 *   A one-character input is refused by the edge function before it builds a
 *   Google request, so this returns the deployment's state and bills nothing.
 *   That is what makes it safe to run from a diagnostics panel on every load.
 */
export async function probePlacesLookup(): Promise<Unavailable | null> {
  const { unavailable } = await fetchSuggestions('a', 'probe', { ignoreCooldown: true });
  return unavailable;
}

/**
 * Road kilometres between two points, measured if possible and estimated if not.
 *
 * ⚠ Never returns null, and never blocks a quote.
 *
 *   Distance Matrix is a second billable Google product and a second thing that
 *   can be out of quota or unreachable. When it cannot answer, the straight
 *   line bent by a road factor is used instead — a worse number, honestly
 *   labelled, rather than a fare that cannot be quoted at all.
 */
export async function measureDistance(from: Point, to: Point): Promise<Distance> {
  const estimated: Distance = { km: estimateRoadKm(from, to), source: 'estimated' };

  /*
   * The same endpoint that suggestions use. If it is known to be down, the
   * straight-line estimate is what this would return anyway — so return it now
   * rather than after a failed round trip on every address change.
   */
  if (knownOutage()) return estimated;

  try {
    const { data, error } = await supabase.functions.invoke('places-lookup', {
      body: {
        mode: 'distance',
        origin: `${from.lat},${from.lng}`,
        destination: `${to.lat},${to.lng}`,
      },
    });

    if (error) return estimated;

    const payload = (data ?? {}) as { km?: number; error?: string };
    if (payload.error || typeof payload.km !== 'number' || payload.km <= 0) return estimated;

    return { km: payload.km, source: 'measured' };
  } catch {
    return estimated;
  }
}

export type PlaceDetails = {
  formattedAddress: string;
  resolution: PlaceResolution;
  location: { lat: number; lng: number } | null;
};

export async function fetchPlaceDetails(
  placeId: string,
  sessionToken: string,
): Promise<{ ok: true; details: PlaceDetails } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('places-lookup', {
      body: { mode: 'details', place_id: placeId, session_token: sessionToken },
    });

    if (error) return { ok: false, error: error.message };

    const payload = (data ?? {}) as {
      formattedAddress?: string;
      components?: AddressComponent[];
      location?: { lat: number; lng: number } | null;
      error?: string;
    };

    if (payload.error) return { ok: false, error: payload.error };

    return {
      ok: true,
      details: {
        formattedAddress: payload.formattedAddress ?? '',
        resolution: resolvePlaceCity(payload.components ?? []),
        location: payload.location ?? null,
      },
    };
  } catch (thrown) {
    return { ok: false, error: errorMessage(thrown, 'That address could not be looked up.') };
  }
}

/**
 * A token tying one person's keystrokes and their final choice into one
 * billable session.
 *
 * ⚠ Regenerated after every completed lookup, never reused.
 *
 *   Google bills a session from the first keystroke to the details call. Keep
 *   using one token and every subsequent address is folded into a session that
 *   has already been billed and closed, which Google is entitled to treat as
 *   abuse. A fresh one per address is both correct and cheaper than the
 *   alternative of not using tokens at all.
 */
export function newSessionToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
