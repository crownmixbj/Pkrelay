/**
 * Matches a live selfie against the photo NIMC holds for a NIN.
 *
 * ⚠ Two subjects, one check: a driver applicant and a parcel sender.
 *
 *   Both are the same call to Dojah and differ only in where the NIN comes from
 *   and where the verdict is written. This function used to serve the driver
 *   alone, which meant `submitOnboarding` in `store/identity.ts` — the sender's
 *   whole onboarding path — called it without a NIN, got a 400 back, and
 *   reported 'unavailable' forever. Senders typed a NIN and photographed a slip
 *   for a check that could not run.
 *
 *   The sender's NIN is read from `sender_identity`, not from the request body.
 *   `begin_identity_check` has already recorded it under RLS, and taking it
 *   from the row means the verdict is stamped against the NIN of record rather
 *   than one supplied at call time by the client being checked.
 *
 * ⚠ Sensitive personal data. Unlike the sender liveness check, this processes a
 *   face *to establish who someone is* — the NDPA's definition of biometric
 *   data as sensitive personal data, with explicit-consent and impact-assessment
 *   obligations. See `docs/PRIVACY-NOTES.md`. LEGAL_REVIEW_REQUIRED.
 *
 * ⚠ A mismatch is a flag, not a rejection. NIMC photos can be a decade old. This
 *   function records what Dojah said and nothing else decides anything — the
 *   application still reaches a human, which is the whole point of choosing to
 *   flag rather than block.
 *
 * Shape follows `verify-liveness`: the client sends a capture session id, the
 * server fetches the image itself, and the Dojah secret never leaves here.
 *
 * Deploy:
 *
 *   supabase functions deploy verify-identity
 *
 * It reuses the same DOJAH_* secrets as `verify-liveness`.
 */

import { json, preflight } from '../_shared/cors.ts';

import { readCredentials, verifyNinSelfie } from '../verify-liveness/dojah.ts';

const env = (key: string) => Deno.env.get(key) ?? null;

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';


async function callerId(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: SERVICE_KEY },
  });
  if (!response.ok) return null;
  const user = (await response.json()) as { id?: string };
  return typeof user.id === 'string' ? user.id : null;
}

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
  let nin = '';
  let subject: 'driver' | 'sender' = 'driver';
  try {
    const body = (await request.json()) as {
      session_id?: unknown;
      nin?: unknown;
      subject?: unknown;
    };
    sessionId = typeof body.session_id === 'string' ? body.session_id : '';
    nin = typeof body.nin === 'string' ? body.nin.replace(/\D/g, '') : '';
    /*
     * Defaults to 'driver' — the only subject that existed when this shipped.
     * An older client that does not send the field keeps working.
     */
    subject = body.subject === 'sender' ? 'sender' : 'driver';
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  if (!sessionId) return json({ error: 'session_id is required' }, 400);

  /*
   * The sender's NIN is on their own row, put there by `begin_identity_check`.
   * Anything the client sent for a sender is ignored.
   */
  if (subject === 'sender') {
    const found = await db(`sender_identity?user_id=eq.${encodeURIComponent(userId)}&select=nin`);
    if (!found.ok) return json({ error: 'Could not read the identity record' }, 500);
    const identityRows = (await found.json()) as { nin: string | null }[];
    nin = (identityRows[0]?.nin ?? '').replace(/\D/g, '');

    if (!nin) {
      return json({
        status: 'unavailable',
        message: 'No NIN on file yet. Add your NIN and slip before the photo.',
      });
    }
  }

  /*
   * A NIN is eleven digits. Checked here so a typo costs nothing rather than a
   * paid call that comes back as a mismatch and puts a flag on an honest
   * applicant's file.
   */
  if (nin.length !== 11) {
    return json({ status: 'unavailable', message: 'A NIN is 11 digits.' });
  }

  const lookup = await db(
    `photo_capture_sessions?id=eq.${encodeURIComponent(sessionId)}&owner_id=eq.${encodeURIComponent(userId)}&select=id,photo_path`,
  );
  if (!lookup.ok) return json({ error: 'Could not read the session' }, 500);

  const rows = (await lookup.json()) as { id: string; photo_path: string | null }[];
  const session = rows[0];
  if (!session) return json({ error: 'No such session' }, 404);
  if (!session.photo_path) return json({ error: 'No photo on that session yet' }, 409);

  const credentials = readCredentials({
    DOJAH_APP_ID: env('DOJAH_APP_ID') ?? undefined,
    DOJAH_SECRET_KEY: env('DOJAH_SECRET_KEY') ?? undefined,
    DOJAH_ENVIRONMENT: env('DOJAH_ENVIRONMENT') ?? undefined,
  });

  /*
   * Not configured is 'unavailable', and the application still goes through.
   *
   * The alternative — refusing every driver application on an instance with no
   * Dojah account — would break the preview builds testers are using and every
   * deployment that has not bought one yet.
   */
  if (!credentials) {
    await record({ verdict: 'unavailable', confidence: null, environment: null, photoPath: null });
    return json({
      status: 'unavailable',
      message: 'Identity checking is not configured on this environment.',
    });
  }

  const download = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sender-photo/${session.photo_path}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!download.ok) return json({ error: 'Could not read the photo' }, 500);

  const selfie = toBase64(new Uint8Array(await download.arrayBuffer()));
  const result = await verifyNinSelfie(nin, selfie, credentials);

  await record({
    verdict: result.verdict,
    confidence: result.confidence,
    environment: result.environment,
    photoPath: session.photo_path,
  });

  /*
   * The identity record Dojah returns — name, date of birth, gender, and the
   * NIMC photo itself — is deliberately not stored and not returned.
   *
   * LOCI already has the applicant's name from the form. Keeping a second copy
   * pulled from a government database, plus their photograph, would be
   * collecting sensitive data for no purpose anyone could state.
   */
  /*
   * Answered in the vocabulary the caller's half of the system uses.
   *
   * `driver_applications` records matched/mismatch; `sender_identity` records
   * verified/flagged, because on that side a match also promotes the selfie to
   * the master reference every later parcel is compared against. Returning one
   * vocabulary to both callers would mean one of them silently mapping every
   * verdict to 'unavailable' — which is exactly what the sender store did.
   */
  return json({
    status: subject === 'sender' ? senderVerdict(result.verdict) : result.verdict,
    confidence: result.confidence,
    environment: result.environment,
    message: result.message,
  });

  function senderVerdict(verdict: string): string {
    if (verdict === 'matched') return 'verified';
    if (verdict === 'mismatch') return 'flagged';
    return 'unavailable';
  }

  async function record(outcome: {
    verdict: string;
    confidence: number | null;
    environment: string | null;
    /** Promoted to the sender's master reference on a match. Never on a driver. */
    photoPath: string | null;
  }): Promise<void> {
    if (subject === 'sender') {
      /*
       * Through the RPC, not a PATCH.
       *
       * `record_identity_result` is where the rules live: 'unavailable' leaves
       * the status untouched, and only a *matched* selfie is promoted to the
       * reference photo. Writing the columns directly from here would put a
       * second, quietly different copy of those rules in a file nobody reads
       * next to the first.
       */
      await db('rpc/record_identity_result', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          target: userId,
          verdict: senderVerdict(outcome.verdict),
          reference: outcome.photoPath,
          score: outcome.confidence,
          env: outcome.environment,
        }),
      });
      return;
    }

    const columns = {
      identity_status:
        outcome.verdict === 'matched'
          ? 'matched'
          : outcome.verdict === 'mismatch'
            ? 'mismatch'
            : 'unavailable',
      identity_confidence: outcome.confidence,
      identity_environment: outcome.environment,
      identity_checked_at: new Date().toISOString(),
    };

    /*
     * ⚠ On the session first, and this is the write that actually survives.
     *
     *   The applicant runs this check on page three of the wizard, *before*
     *   their application row exists. The PATCH below matches nothing at that
     *   point, so it used to be the only write and the verdict was lost. The
     *   session is where the photo already lives and it exists from the moment
     *   the camera opens; `attach_identity_result` copies these four columns
     *   onto the application once there is one.
     */
    await db(`photo_capture_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(columns),
    });

    /*
     * And onto a pending application if one is already open.
     *
     * Not redundant: an applicant re-taking their photo after submitting has a
     * row waiting, and this keeps it current without a second round trip.
     * Scoped by user id as well as status — the service role bypasses RLS, so
     * without the filter this would happily stamp a verdict on somebody else's
     * file.
     */
    await db(`driver_applications?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(columns),
    });
  }
});
