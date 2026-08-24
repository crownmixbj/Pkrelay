import { errorMessage } from '@/lib/errors';
import { resolvePlaceCity, type AddressComponent, type PlaceResolution } from '@/lib/place-to-city';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

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

export type SuggestionResult = {
  suggestions: Suggestion[];
  /** False when the deployment has no key, or Google refused. */
  available: boolean;
};

export async function fetchSuggestions(
  input: string,
  sessionToken: string,
): Promise<SuggestionResult> {
  if (!isSupabaseConfigured) return { suggestions: [], available: false };

  try {
    const { data, error } = await supabase.functions.invoke('places-lookup', {
      body: { mode: 'suggest', input, session_token: sessionToken },
    });

    if (error) return { suggestions: [], available: false };

    const payload = (data ?? {}) as {
      configured?: boolean;
      suggestions?: Suggestion[];
      error?: string;
    };

    /*
     * An empty list from a working lookup is *available* — it means "nowhere
     * matched", which is worth saying. An empty list because the lookup itself
     * failed is not, and hides the field in favour of the picker.
     */
    if (payload.configured === false || payload.error) {
      return { suggestions: [], available: false };
    }

    return { suggestions: payload.suggestions ?? [], available: true };
  } catch {
    return { suggestions: [], available: false };
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
