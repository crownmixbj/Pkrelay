/**
 * Runs the liveness check on a photo a sender just uploaded.
 *
 * Why this exists as an edge function at all: the Dojah secret key must never
 * reach a phone or a browser. Anything prefixed `EXPO_PUBLIC_` is compiled into
 * the app bundle and readable by anyone who installs it, and a key in a client
 * is a key someone else can spend your wallet with. So the client sends a
 * session id, and the server does everything that involves the secret.
 *
 * The flow:
 *
 *   1. Verify the caller's JWT and get their user id.
 *   2. Confirm the capture session is theirs and has a photo.
 *   3. Download that photo with the service role — the client never re-sends
 *      the image, so it cannot substitute a different one between upload and
 *      check.
 *   4. Ask Dojah.
 *   5. Write the verdict where the client cannot.
 *
 * Deploy:
 *
 *   supabase functions deploy verify-liveness
 *   supabase secrets set DOJAH_APP_ID="..."
 *   supabase secrets set DOJAH_SECRET_KEY="..."
 *   supabase secrets set DOJAH_ENVIRONMENT="sandbox"
 *
 * `DOJAH_ENVIRONMENT` defaults to sandbox when unset. See `docs/DOJAH.md`.
 */

import { json, preflight } from '../_shared/cors.ts';

import { checkLiveness, readCredentials } from './dojah.ts';

const env = (key: string) => Deno.env.get(key) ?? null;

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';


/**
 * Who is calling.
 *
 * The caller's own JWT is used against `/auth/v1/user`, so identity comes from
 * Supabase rather than from anything in the request body. A body-supplied user
 * id would let any signed-in account run checks against another person's
 * session.
 */
async function callerId(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: SERVICE_KEY },
  });
  if (!response.ok) return null;

  const user = (await response.json()) as { id?: string };
  return typeof user.id === 'string' ? user.id : null;
}

/** Service-role PostgREST. Bypasses RLS, so every query filters by owner. */
async function db(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/** Base64 without blowing the stack on a large image. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (request: Request) => {
  /*
   * ⚠ The preflight is answered before anything else, including the method
   *   check — which would otherwise refuse it with a 405 and leave the browser
   *   reporting a CORS block for a function that is deployed and healthy.
   */
  const options = preflight(request);
  if (options) return options;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const userId = await callerId(request.headers.get('Authorization'));
  if (!userId) return json({ error: 'Not signed in' }, 401);

  let sessionId = '';
  try {
    const body = (await request.json()) as { session_id?: unknown };
    sessionId = typeof body.session_id === 'string' ? body.session_id : '';
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  if (!sessionId) return json({ error: 'session_id is required' }, 400);

  // The session must be this caller's, and must have a photo on it.
  const lookup = await db(
    `photo_capture_sessions?id=eq.${encodeURIComponent(sessionId)}&owner_id=eq.${encodeURIComponent(userId)}&select=id,photo_path,liveness_status`,
  );
  if (!lookup.ok) return json({ error: 'Could not read the session' }, 500);

  const rows = (await lookup.json()) as {
    id: string;
    photo_path: string | null;
    liveness_status: string | null;
  }[];

  const session = rows[0];
  if (!session) return json({ error: 'No such session' }, 404);
  if (!session.photo_path) return json({ error: 'No photo on that session yet' }, 409);

  /*
   * Already checked? Return what we have.
   *
   * Re-running would let a sender retry the same image until a probabilistic
   * check happened to pass it, which is exactly the property a liveness check
   * is supposed to deny.
   */
  if (session.liveness_status) {
    return json({ status: session.liveness_status, repeated: true });
  }

  const credentials = readCredentials({
    DOJAH_APP_ID: env('DOJAH_APP_ID') ?? undefined,
    DOJAH_SECRET_KEY: env('DOJAH_SECRET_KEY') ?? undefined,
    DOJAH_ENVIRONMENT: env('DOJAH_ENVIRONMENT') ?? undefined,
    LOCI_ENVIRONMENT: env('LOCI_ENVIRONMENT') ?? undefined,
  });

  /*
   * No credentials is 'unavailable', not an error and not a pass.
   *
   * A Package Relay instance with no Dojah account still has to be able to post parcels
   * — otherwise adding this integration would break every deployment that has
   * not bought one yet, including the preview builds testers are using.
   */
  if (!credentials) {
    await recordVerdict(sessionId, {
      status: 'unavailable',
      probability: null,
      environment: null,
    });
    return json({
      status: 'unavailable',
      message: 'Liveness checking is not configured on this environment.',
    });
  }

  // The image is fetched here, not sent by the client — so what is checked is
  // exactly what was uploaded.
  const download = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sender-photo/${session.photo_path}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!download.ok) return json({ error: 'Could not read the photo' }, 500);

  const image = toBase64(new Uint8Array(await download.arrayBuffer()));
  const result = await checkLiveness(image, credentials);

  await recordVerdict(sessionId, {
    status: result.verdict,
    probability: result.probability,
    environment: result.environment,
  });

  /*
   * The response carries no provider payload.
   *
   * Dojah's full response includes estimated age, gender, emotion and facial
   * hair. None of that is needed to post a parcel, Package Relay has no lawful basis to
   * collect it, and shipping it to the client would put it in a place it can be
   * read. The verdict and a probability are the whole of what leaves here.
   */
  return json({
    status: result.verdict,
    probability: result.probability,
    environment: result.environment,
    message: result.message,
  });
});

async function recordVerdict(
  sessionId: string,
  verdict: { status: string; probability: number | null; environment: string | null },
): Promise<void> {
  await db(`photo_capture_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      liveness_status: verdict.status,
      liveness_probability: verdict.probability,
      liveness_provider: 'dojah',
      liveness_environment: verdict.environment,
      liveness_checked_at: new Date().toISOString(),
    }),
  });
}
