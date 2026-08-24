import { useEffect, useRef, useState } from 'react';

import {
  fetchPlaceDetails,
  fetchSuggestions,
  newSessionToken,
  type PlaceDetails,
  type Suggestion,
  type Unavailable,
} from '@/store/places';

/** Long enough that a typist does not spend a session per letter. */
export const DEBOUNCE_MS = 300;

/**
 * The lookup half of an address field, without any opinion about the outcome.
 *
 * ⚠ Extracted because two fields need identical behaviour and different answers.
 *
 *   The quote form wants a city and a coordinate, and falls back to a city
 *   picker when Places cannot answer. Every other address in the app — a
 *   driver's home, a guarantor's, a hub's — wants a string, and must stay
 *   typeable whether or not Google is reachable. Same debounce, same session
 *   token, same three failure modes; completely different consequences.
 *
 *   Copying the logic into both was the alternative, and the half that drifts
 *   is always the one that spends money.
 */
export function useAddressSuggestions(query: string) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  const [emptyResult, setEmptyResult] = useState(false);

  /**
   * Suppresses the search that a chosen suggestion would otherwise trigger.
   *
   * Taking a suggestion writes its text into the field, which looks exactly
   * like typing — so without this the component would immediately search for
   * the address it had just resolved, billing a second session for an answer
   * it already had.
   */
  const [settled, setSettled] = useState(false);

  /** One token per address chosen, so a lookup is billed once. See `places.ts`. */
  const session = useRef(newSessionToken());

  useEffect(() => {
    const term = query.trim();

    if (term.length < 2 || settled) {
      setSuggestions([]);
      setEmptyResult(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    const timer = setTimeout(async () => {
      const result = await fetchSuggestions(term, session.current);
      if (cancelled) return;

      setSearching(false);
      setSuggestions(result.suggestions);
      setUnavailable(result.unavailable);
      setEmptyResult(!result.unavailable && result.suggestions.length === 0);
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSearching(false);
    };
  }, [query, settled]);

  /** Resolves a chosen suggestion, and closes the billing session. */
  const resolve = async (
    suggestion: Suggestion,
  ): Promise<{ ok: true; details: PlaceDetails } | { ok: false; error: string }> => {
    setSettled(true);
    setSuggestions([]);

    const result = await fetchPlaceDetails(suggestion.placeId, session.current);
    session.current = newSessionToken();

    return result;
  };

  /** Called when somebody edits the text again, so searching resumes. */
  const reopen = () => setSettled(false);

  return { suggestions, searching, unavailable, emptyResult, resolve, reopen };
}
