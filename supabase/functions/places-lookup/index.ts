/**
 * Address suggestions, without the API key leaving the server.
 *
 * ⚠ A Google key in the client bundle is a key somebody else can spend.
 *
 *   On the web it could be restricted by HTTP referrer, which is worth
 *   something. On a phone it cannot be: an APK is a zip file, and a key lifted
 *   out of one bills to this project until somebody notices. Places
 *   Autocomplete is charged per session, so the failure mode is a bill rather
 *   than an outage — the kind nobody spots for a month.
 *
 *   `verify-liveness` and `verify-identity` already keep the Dojah secret here
 *   for the same reason. This is the third paid third party and the third time
 *   the answer is the same.
 *
 * ⚠ Two modes, one session.
 *
 *   Google bills autocomplete per *session*: any number of keystroke requests
 *   plus one details call, tied together by a session token the client
 *   generates. Both modes take that token and pass it straight through, so a
 *   person typing an address costs one lookup rather than fifteen.
 *
 * Deploy:
 *
 *   supabase secrets set GOOGLE_PLACES_KEY=…
 *   supabase functions deploy places-lookup
 */

import { json, preflight } from '../_shared/cors.ts';

const env = (key: string) => Deno.env.get(key) ?? null;

const PLACES_KEY = env('GOOGLE_PLACES_KEY') ?? '';

/**
 * What Google actually said, in the function log.
 *
 * ⚠ The status alone is not a diagnosis, and this cost a day.
 *
 *   Google answers a refused key with `REQUEST_DENIED` and an `error_message`
 *   naming the reason — "API key not valid", "This API project is not
 *   authorized to use this API", "You must enable Billing", "API keys with
 *   referer restrictions cannot be used with this API". Only the status was
 *   ever forwarded, and all four collapse into one word at the client, which
 *   then says "Address search is busy right now" for a key that is not busy at
 *   all.
 *
 *   It is logged rather than returned: the message is operational detail about
 *   *our* Google project, and nobody typing an address can act on it. The
 *   client contract stays the status word it already handles.
 *
 * The key is never logged — `error_message` does not contain it, and nothing
 * here interpolates it.
 */
function logRefusal(mode: string, status: string | undefined, message: string | undefined) {
  console.error(
    `places-lookup ${mode} refused by Google: ${status ?? 'no status'}` +
      (message ? ` — ${message}` : ' — no error_message'),
  );
}

type Suggestion = {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
};

Deno.serve(async (request: Request) => {
  /*
   * ⚠ Before the method check, not after.
   *
   *   This function used to answer `OPTIONS` with the 405 below, which is a
   *   refusal the browser reads as "this origin may not call you". Every
   *   suggestion request from the web build was blocked before it was sent,
   *   and the function logged nothing because nothing arrived.
   */
  const options = preflight(request);
  if (options) return options;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /*
   * ⚠ Not configured is answered, not thrown.
   *
   *   A deployment without a Places key is a normal state — a preview build, a
   *   fork, this project before the key was bought. The client falls back to
   *   the city picker when it sees this, so the quote still works. A 500 would
   *   be indistinguishable from Google being down and would make the fallback
   *   look like a bug.
   */
  if (!PLACES_KEY) return json({ configured: false, suggestions: [] });

  let mode = '';
  let input = '';
  let placeId = '';
  let sessionToken = '';
  let bodyCache: Record<string, unknown> = {};

  try {
    const body = (await request.json()) as Record<string, unknown>;
    bodyCache = body;
    mode = typeof body.mode === 'string' ? body.mode : '';
    input = typeof body.input === 'string' ? body.input.trim() : '';
    placeId = typeof body.place_id === 'string' ? body.place_id : '';
    sessionToken = typeof body.session_token === 'string' ? body.session_token : '';
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  if (mode === 'suggest') {
    /*
     * Two characters is the floor.
     *
     * A single letter matches most of Nigeria and bills a session for a result
     * nobody can use.
     */
    if (input.length < 2) return json({ configured: true, suggestions: [] });

    const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
    url.searchParams.set('input', input);
    url.searchParams.set('key', PLACES_KEY);
    /*
     * Nigeria only, and addresses rather than businesses.
     *
     * Without the country filter a search for "Ikeja" offers restaurants in
     * three countries, and picking one of those resolves to no served city —
     * a dead end the person cannot diagnose.
     */
    url.searchParams.set('components', 'country:ng');
    url.searchParams.set('language', 'en');
    if (sessionToken) url.searchParams.set('sessiontoken', sessionToken);

    const response = await fetch(url);
    if (!response.ok) return json({ configured: true, suggestions: [], error: 'Lookup failed' });

    const payload = (await response.json()) as {
      status?: string;
      error_message?: string;
      predictions?: {
        place_id: string;
        description: string;
        structured_formatting?: { main_text?: string; secondary_text?: string };
      }[];
    };

    /*
     * `OVER_QUERY_LIMIT` and friends are reported as an empty, non-fatal answer.
     *
     * The client treats "no suggestions" as a reason to offer the city picker,
     * which is exactly the right response to being rate-limited: the person
     * still gets their quote.
     */
    if (payload.status && payload.status !== 'OK' && payload.status !== 'ZERO_RESULTS') {
      logRefusal('suggest', payload.status, payload.error_message);
      return json({ configured: true, suggestions: [], error: payload.status });
    }

    const suggestions: Suggestion[] = (payload.predictions ?? []).slice(0, 5).map((prediction) => ({
      placeId: prediction.place_id,
      description: prediction.description,
      mainText: prediction.structured_formatting?.main_text ?? prediction.description,
      secondaryText: prediction.structured_formatting?.secondary_text ?? '',
    }));

    return json({ configured: true, suggestions });
  }

  if (mode === 'details') {
    if (!placeId) return json({ error: 'place_id is required' }, 400);

    const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('key', PLACES_KEY);
    /*
     * Only the fields the resolver reads. Places bills by field group, so
     * asking for everything costs more and hands the client a pile of data it
     * has no use for.
     */
    url.searchParams.set('fields', 'formatted_address,address_component,geometry/location');
    url.searchParams.set('language', 'en');
    if (sessionToken) url.searchParams.set('sessiontoken', sessionToken);

    const response = await fetch(url);
    if (!response.ok) return json({ error: 'Lookup failed' }, 502);

    const payload = (await response.json()) as {
      status?: string;
      error_message?: string;
      result?: {
        formatted_address?: string;
        address_components?: { long_name: string; short_name: string; types: string[] }[];
        geometry?: { location?: { lat: number; lng: number } };
      };
    };

    if (payload.status !== 'OK' || !payload.result) {
      logRefusal('details', payload.status, payload.error_message);
      return json({ error: payload.status ?? 'No such place' }, 502);
    }

    return json({
      formattedAddress: payload.result.formatted_address ?? '',
      components: (payload.result.address_components ?? []).map((component) => ({
        longName: component.long_name,
        shortName: component.short_name,
        types: component.types,
      })),
      /*
       * Returned but not used for pricing today — `estimateFee` has no distance
       * term. Kept because the details call is already paid for, and a later
       * distance-based rate would otherwise need the whole lookup again.
       */
      location: payload.result.geometry?.location ?? null,
    });
  }

  if (mode === 'distance') {
    /*
     * ⚠ Road distance, and it is allowed to fail.
     *
     *   Distance Matrix is a second billable product on top of Autocomplete,
     *   and a second thing that can be out of quota. The client falls back to a
     *   straight line bent by a road factor, which is a worse number but never
     *   a missing quote — so this returns an error rather than trying to be
     *   clever, and the caller decides.
     */
    const origin = typeof (bodyCache.origin ?? null) === 'string' ? String(bodyCache.origin) : '';
    const destination =
      typeof (bodyCache.destination ?? null) === 'string' ? String(bodyCache.destination) : '';

    if (!origin || !destination) return json({ error: 'origin and destination are required' }, 400);

    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    url.searchParams.set('origins', origin);
    url.searchParams.set('destinations', destination);
    url.searchParams.set('key', PLACES_KEY);
    url.searchParams.set('units', 'metric');
    /*
     * Driving, because a parcel goes by road. The default is also driving, but
     * stating it means a change to that default cannot quietly reprice every
     * inter-state fare.
     */
    url.searchParams.set('mode', 'driving');

    const response = await fetch(url);
    if (!response.ok) return json({ error: 'Lookup failed' }, 502);

    const payload = (await response.json()) as {
      status?: string;
      error_message?: string;
      rows?: { elements?: { status?: string; distance?: { value?: number } }[] }[];
    };

    const element = payload.rows?.[0]?.elements?.[0];

    if (payload.status !== 'OK' || element?.status !== 'OK' || !element.distance?.value) {
      logRefusal('distance', element?.status ?? payload.status, payload.error_message);
      return json({ error: element?.status ?? payload.status ?? 'No route' }, 502);
    }

    /* Metres from Google; kilometres everywhere in this app. */
    return json({ km: Math.round(element.distance.value / 1000) });
  }

  return json({ error: 'Unknown mode' }, 400);
});
