/**
 * Talking to Dojah, and deciding what its answer means.
 *
 * Deliberately free of Deno globals so it can be bundled and tested under node
 * — the same arrangement as `notify-application/email.ts`. Everything that
 * needs a network or a secret is passed in.
 *
 * ⚠ WHAT THIS CHECK IS.
 *
 *   `POST /api/v1/ml/liveness` is a *passive* liveness check: Dojah is handed
 *   one still image and reports how likely it is to be a live person rather
 *   than a photo of a photo. It is materially stronger than the bare selfie
 *   this replaces — it will reject a printed picture held to the lens, which
 *   the old flow accepted — but it is not an *active* check. Nothing asks the
 *   person to blink, turn, or follow a prompt, so a good-quality video replayed
 *   on a second screen is a route it does not close.
 *
 *   Dojah does offer active liveness, through the EasyOnboard widget rather
 *   than this endpoint. Moving to it means adopting their hosted UI in place of
 *   Package Relay's own capture screen — a bigger change, and the right one if replay
 *   attacks turn out to matter.
 *
 * ⚠ AND WHAT SANDBOX IS.
 *
 *   Sandbox returns mock data and charges nothing. Dojah's own documentation
 *   says: "Sandbox results are not real verifications. Never use mock data to
 *   make a live trust decision." Every result carries the environment it came
 *   from for exactly that reason — see `LivenessResult.environment`.
 */

import { isStaging } from '../_shared/environment.ts';

export type DojahEnvironment = 'sandbox' | 'production';

export const DOJAH_BASE_URLS: Record<DojahEnvironment, string> = {
  sandbox: 'https://sandbox.dojah.io',
  production: 'https://api.dojah.io',
};

export type DojahCredentials = {
  appId: string;
  secretKey: string;
  environment: DojahEnvironment;
};

/**
 * Reads credentials out of a plain record.
 *
 * Returns null rather than throwing when they are absent: a Package Relay instance with
 * no Dojah account should degrade to "not checked" rather than refusing to post
 * parcels, and the caller decides what that means.
 */
export function readCredentials(env: Record<string, string | undefined>): DojahCredentials | null {
  const appId = (env.DOJAH_APP_ID ?? '').trim();
  const secretKey = (env.DOJAH_SECRET_KEY ?? '').trim();
  if (!appId || !secretKey) return null;

  /*
   * Sandbox is the default, and that is the safe way round.
   *
   * A misconfigured deployment that silently called production would spend real
   * money from the wallet on every parcel posted. One that silently calls
   * sandbox produces results clearly labelled as mock, which is a mistake
   * somebody notices.
   */
  /*
   * ⚠ Staging outranks DOJAH_ENVIRONMENT, in that order and not the other.
   *
   *   Every other guard here protects against a value being absent. This one
   *   protects against a value being *present and wrong* — a production Dojah
   *   secret pasted into the staging project "just to check the real flow",
   *   which then spends the real wallet on every test parcel. Reading
   *   LOCI_ENVIRONMENT last means no combination of DOJAH_* can talk the
   *   staging deployment into calling api.dojah.io.
   */
  const configured: DojahEnvironment =
    (env.DOJAH_ENVIRONMENT ?? '').trim().toLowerCase() === 'production' ? 'production' : 'sandbox';

  const environment: DojahEnvironment = isStaging(env) ? 'sandbox' : configured;

  return { appId, secretKey, environment };
}

/**
 * Strips a data-URL prefix if one is present.
 *
 * The web fallback captures with `canvas.toDataURL()`, which yields
 * `data:image/jpeg;base64,...`. Dojah wants the payload only, and sending the
 * prefix is a 400 that reads like a malformed image.
 */
export function bareBase64(image: string): string {
  const comma = image.indexOf(',');
  return image.startsWith('data:') && comma !== -1 ? image.slice(comma + 1) : image;
}

export type LivenessVerdict = 'passed' | 'failed' | 'unavailable';

export type LivenessResult = {
  verdict: LivenessVerdict;
  /** 0–100 as Dojah reports it, or null when there is no number to report. */
  probability: number | null;
  /** Whether a face was found at all — a common and separately useful failure. */
  faceDetected: boolean | null;
  /** More than one face in frame. Dojah reports this and it is worth keeping. */
  multipleFaces: boolean | null;
  environment: DojahEnvironment;
  /** Short, human-readable, safe to show a sender. */
  message: string;
};

/**
 * The bar a probability has to clear.
 *
 * 70 is a deliberate middle. Dojah's own example of a clean capture scores 98,
 * so a genuine selfie in reasonable light clears this comfortably; setting it at
 * 90 would start rejecting people in poor light, which on a Nigerian street at
 * dusk is most of them. The cost of a false reject here is a sender who cannot
 * post a parcel at all, and that is a worse failure than a marginal photo
 * getting through to a record nobody may ever read.
 *
 * `liveness_check` is Dojah's own boolean; the threshold is a second opinion on
 * the number behind it, and both have to agree.
 */
export const LIVENESS_THRESHOLD = 70;

type DojahLivenessResponse = {
  entity?: {
    face?: {
      face_detected?: boolean;
      multiface_detected?: boolean;
      message?: string;
    };
    liveness?: {
      liveness_check?: boolean;
      liveness_probability?: number;
    };
  };
  error?: unknown;
};

/**
 * Turns a Dojah response into a verdict.
 *
 * Split from the request so the interesting part — what counts as a pass — is
 * testable without a network or a key.
 */
export function interpret(
  payload: unknown,
  environment: DojahEnvironment,
  threshold = LIVENESS_THRESHOLD,
): LivenessResult {
  const body = (payload ?? {}) as DojahLivenessResponse;
  const face = body.entity?.face;
  const liveness = body.entity?.liveness;

  const faceDetected = typeof face?.face_detected === 'boolean' ? face.face_detected : null;
  const multipleFaces =
    typeof face?.multiface_detected === 'boolean' ? face.multiface_detected : null;
  const probability =
    typeof liveness?.liveness_probability === 'number' ? liveness.liveness_probability : null;

  /*
   * A response with no liveness block at all is 'unavailable', not 'failed'.
   *
   * The difference decides whether a sender is blocked. Dojah being down, or
   * changing a field name, must not read as "this person is not real" — that
   * would turn an outage at the provider into every Package Relay sender being accused
   * of fraud.
   */
  if (!body.entity || (liveness?.liveness_check === undefined && probability === null)) {
    return {
      verdict: 'unavailable',
      probability: null,
      faceDetected,
      multipleFaces,
      environment,
      message: 'The liveness service did not return a result.',
    };
  }

  if (faceDetected === false) {
    return {
      verdict: 'failed',
      probability,
      faceDetected,
      multipleFaces,
      environment,
      message: 'No face was found in the photo. Take it again with your face in frame.',
    };
  }

  if (multipleFaces === true) {
    return {
      verdict: 'failed',
      probability,
      faceDetected,
      multipleFaces,
      environment,
      message: 'More than one face was in the photo. Take it again on your own.',
    };
  }

  const passed = liveness?.liveness_check === true && (probability ?? 0) >= threshold;

  return {
    verdict: passed ? 'passed' : 'failed',
    probability,
    faceDetected,
    multipleFaces,
    environment,
    message: passed
      ? 'Liveness check passed.'
      : 'The photo did not pass the liveness check. Take it again in better light, looking straight at the camera.',
  };
}

/**
 * Calls Dojah.
 *
 * `fetchImpl` is injected so the whole path can be exercised in a test without
 * a network. The secret goes in a header and is never logged — this function
 * returns the parsed body and nothing that would carry the key into a log line.
 */
export async function checkLiveness(
  imageBase64: string,
  credentials: DojahCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<LivenessResult> {
  const url = `${DOJAH_BASE_URLS[credentials.environment]}/api/v1/ml/liveness`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        // Sent as-is. Dojah rejects a `Bearer` prefix, which is the single most
        // common way this integration fails with a confusing 401.
        Authorization: credentials.secretKey,
        AppId: credentials.appId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: bareBase64(imageBase64) }),
    });
  } catch {
    return {
      verdict: 'unavailable',
      probability: null,
      faceDetected: null,
      multipleFaces: null,
      environment: credentials.environment,
      message: 'Could not reach the liveness service.',
    };
  }

  if (!response.ok) {
    /*
     * Provider-side failures are 'unavailable', not 'failed'.
     *
     * 401 is our key being wrong. 402 is an empty wallet. 429 is our rate
     * limit. None of them is a statement about the person in the photo, and
     * treating them as one would block senders for our billing problem.
     */
    return {
      verdict: 'unavailable',
      probability: null,
      faceDetected: null,
      multipleFaces: null,
      environment: credentials.environment,
      message: `The liveness service returned ${response.status}.`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      verdict: 'unavailable',
      probability: null,
      faceDetected: null,
      multipleFaces: null,
      environment: credentials.environment,
      message: 'The liveness service returned something unreadable.',
    };
  }

  return interpret(payload, credentials.environment);
}

// ------------------------------------------- matching a face to a record ----

/**
 * Matching a selfie against the photo NIMC holds for a NIN.
 *
 * ⚠ This is a different thing from the liveness check above, legally and
 *   practically. Liveness asks "is this a live human". This asks "is this
 *   *that* human" — processing biometric data to uniquely identify a person,
 *   which is the NDPA's definition of sensitive personal data. See
 *   `docs/PRIVACY-NOTES.md`. LEGAL_REVIEW_REQUIRED.
 *
 * ⚠ And a mismatch is not proof of fraud. The photo NIMC holds can be a decade
 *   old and taken on equipment that was poor when it was new. A confident
 *   system that auto-rejected on this number would lock out real drivers whose
 *   only offence is having aged. The verdict is a flag for a human, and the
 *   name says so.
 *
 * Dojah has no driver's-licence lookup for Nigeria — their coverage is NIN, BVN
 * and phone. A licence can only be face-matched against an image the applicant
 * uploaded, which proves the face on the document matches, not that the
 * document is genuine. That is not built.
 */
export type IdentityVerdict = 'matched' | 'mismatch' | 'unavailable';

export type IdentityResult = {
  verdict: IdentityVerdict;
  /** Dojah's `confidence_value`, 0–100, or null when it returned none. */
  confidence: number | null;
  environment: DojahEnvironment;
  message: string;
};

/**
 * The bar for a match.
 *
 * Higher than the liveness threshold, and deliberately so: a false *pass* here
 * means an application approved in someone else's name, which is worse than the
 * false *reject* it trades against — because a reject is reviewed by a human
 * and a pass is not. Dojah's own worked example scores 99.81.
 */
export const IDENTITY_THRESHOLD = 90;

type DojahIdentityResponse = {
  entity?: {
    selfie_verification?: {
      confidence_value?: number;
      match?: boolean;
    };
  };
};

export function interpretIdentity(
  payload: unknown,
  environment: DojahEnvironment,
  threshold = IDENTITY_THRESHOLD,
): IdentityResult {
  const verification = (payload as DojahIdentityResponse)?.entity?.selfie_verification;

  const confidence =
    typeof verification?.confidence_value === 'number' ? verification.confidence_value : null;

  /*
   * No verification block is 'unavailable', never 'mismatch'.
   *
   * The same rule as the liveness check, for the same reason: Dojah being down,
   * NIMC being unreachable, or a field being renamed must not read as "this
   * person is lying about who they are".
   */
  if (!verification || (verification.match === undefined && confidence === null)) {
    return {
      verdict: 'unavailable',
      confidence: null,
      environment,
      message: 'The identity service did not return a result.',
    };
  }

  const matched = verification.match === true && (confidence ?? 0) >= threshold;

  return {
    verdict: matched ? 'matched' : 'mismatch',
    confidence,
    environment,
    message: matched
      ? 'Selfie matched the photo on your NIN record.'
      : 'The selfie did not match the photo on your NIN record. Your application will still be reviewed by a person.',
  };
}

/**
 * Calls Dojah's NIN-with-selfie endpoint.
 *
 * Note the NIN travels to Dojah, which is unavoidable — matching against a
 * government record requires telling them which record. It is not logged and
 * not returned.
 */
export async function verifyNinSelfie(
  nin: string,
  selfieBase64: string,
  credentials: DojahCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<IdentityResult> {
  const url = `${DOJAH_BASE_URLS[credentials.environment]}/api/v1/kyc/nin/verify`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: credentials.secretKey,
        AppId: credentials.appId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        nin: nin.replace(/\D/g, ''),
        selfie_image: bareBase64(selfieBase64),
      }),
    });
  } catch {
    return {
      verdict: 'unavailable',
      confidence: null,
      environment: credentials.environment,
      message: 'Could not reach the identity service.',
    };
  }

  if (!response.ok) {
    return {
      verdict: 'unavailable',
      confidence: null,
      environment: credentials.environment,
      message: `The identity service returned ${response.status}.`,
    };
  }

  try {
    return interpretIdentity(await response.json(), credentials.environment);
  } catch {
    return {
      verdict: 'unavailable',
      confidence: null,
      environment: credentials.environment,
      message: 'The identity service returned something unreadable.',
    };
  }
}

// ------------------------------------------------- selfie against a face ---

/**
 * The endpoint that compares two faces.
 *
 * ⚠ CONFIRM THIS AGAINST YOUR DOJAH PLAN BEFORE PRODUCTION.
 *
 *   Dojah's documentation is client-rendered and could not be read from the
 *   environment this was written in, so the path below is the documented shape
 *   rather than one I have seen respond. It is read from
 *   `DOJAH_FACE_MATCH_PATH` precisely so it can be corrected without a code
 *   change:
 *
 *       supabase secrets set DOJAH_FACE_MATCH_PATH=/api/v1/kyc/photoid/verify
 *
 *   If your plan exposes no face-comparison endpoint at all, leave it unset.
 *   `compareFaces` then returns 'unavailable', every repeat sender is recorded
 *   rather than matched, and nothing breaks — which is the same behaviour as an
 *   outage, and the reason that path was built first.
 */
export const DEFAULT_FACE_MATCH_PATH = '/api/v1/kyc/photoid/verify';

type DojahFaceMatchResponse = {
  entity?: {
    selfie_verification?: { confidence_value?: number; match?: boolean };
    /** Some Dojah endpoints answer with this shape instead. */
    match?: boolean;
    confidence_value?: number;
  };
};

/**
 * Reads either response shape Dojah uses for a face comparison.
 *
 * Two shapes rather than one because the NIN endpoint nests its verdict under
 * `selfie_verification` and the photo-ID endpoints have been seen to put it at
 * the top of `entity`. Reading both costs four lines and removes a class of
 * "returned unavailable forever because a field moved" that nobody would notice
 * — the check would simply stop deciding anything.
 */
export function interpretFaceMatch(
  payload: unknown,
  environment: DojahEnvironment,
  threshold = IDENTITY_THRESHOLD,
): IdentityResult {
  const entity = (payload as DojahFaceMatchResponse)?.entity;
  const nested = entity?.selfie_verification;

  const match = nested?.match ?? entity?.match;
  const confidence =
    typeof nested?.confidence_value === 'number'
      ? nested.confidence_value
      : typeof entity?.confidence_value === 'number'
        ? entity.confidence_value
        : null;

  if (match === undefined && confidence === null) {
    return {
      verdict: 'unavailable',
      confidence: null,
      environment,
      message: 'The identity service did not return a result.',
    };
  }

  const matched = match === true && (confidence ?? 0) >= threshold;

  return {
    verdict: matched ? 'matched' : 'mismatch',
    confidence,
    environment,
    message: matched
      ? 'Selfie matched your reference photo.'
      : 'That selfie did not match your reference photo. Your parcel still goes ahead and someone will check.',
  };
}

/**
 * Compares a fresh selfie against the account's stored reference photo.
 *
 * Both images are base64 and both come from private storage read with the
 * service role — the client sends neither.
 */
export async function compareFaces(
  selfieBase64: string,
  referenceBase64: string,
  credentials: DojahCredentials,
  path: string | null = DEFAULT_FACE_MATCH_PATH,
  fetchImpl: typeof fetch = fetch,
): Promise<IdentityResult> {
  if (!path) {
    return {
      verdict: 'unavailable',
      confidence: null,
      environment: credentials.environment,
      message: 'Face comparison is not configured.',
    };
  }

  const url = `${DOJAH_BASE_URLS[credentials.environment]}${path}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: credentials.secretKey,
        AppId: credentials.appId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        selfie_image: bareBase64(selfieBase64),
        photoid_image: bareBase64(referenceBase64),
      }),
    });
  } catch {
    return {
      verdict: 'unavailable',
      confidence: null,
      environment: credentials.environment,
      message: 'Could not reach the identity service.',
    };
  }

  if (!response.ok) {
    return {
      verdict: 'unavailable',
      confidence: null,
      environment: credentials.environment,
      message: `The identity service answered ${response.status}.`,
    };
  }

  try {
    return interpretFaceMatch(await response.json(), credentials.environment);
  } catch {
    return {
      verdict: 'unavailable',
      confidence: null,
      environment: credentials.environment,
      message: 'The identity service returned something unreadable.',
    };
  }
}
