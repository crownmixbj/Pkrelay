/**
 * Talking to Paystack, and the three things that must not be got wrong.
 *
 * ⚠ Nothing here reads `Deno.env`, and it must stay that way.
 *
 *   Same rule as `environment.ts` and `service-role.ts`: `npm run
 *   verify:payments` bundles this module with esbuild and runs it under node,
 *   where `Deno` does not exist. Every function takes what it needs as an
 *   argument and the callers do the reading. `crypto.subtle` is used rather
 *   than `node:crypto` for the same reason from the other side — it is a
 *   standard global in both runtimes, so the signature check the webhook
 *   depends on is the code the assertions actually execute.
 *
 * The three:
 *
 *   1. Kobo. Paystack is denominated in the minor unit. A fare of ₦2,800 is
 *      280000, and sending 2800 charges twenty-eight naira.
 *   2. The amount that matters is the one that came back, not the one that was
 *      sent. `initialize` proposes; `verify` reports. Only the second is
 *      evidence, and it is compared with what was owed in
 *      `settle_parcel_payment`.
 *   3. A webhook is an anonymous POST from the internet. The signature is the
 *      only thing that makes it Paystack's.
 */

import { isStaging, readEnvironment, type EnvRecord } from './environment.ts';

export const PAYSTACK_API = 'https://api.paystack.co';

export type PaystackConfig = {
  secretKey: string;
  /** 'test' or 'live', read from the key itself rather than configured twice. */
  mode: 'test' | 'live';
};

export type ConfigResult =
  | { ok: true; config: PaystackConfig }
  | { ok: false; error: string };

/**
 * The secret key, and the refusal that matters most.
 *
 * ⚠ Staging may only ever hold a test key, and this is what enforces it.
 *
 *   `environment.ts` already redirects email, mutes Slack and forces the Dojah
 *   sandbox, and its reasoning applies here with money attached: staging shares
 *   this repository and these functions with production, so the only thing
 *   stopping a production secret from being pasted into the staging project is
 *   somebody remembering. A live key on staging means a test parcel takes real
 *   naira off a real card.
 *
 *   It fails closed — no key, or the wrong kind of key, and the function
 *   refuses rather than falling back to anything.
 */
export function readPaystackConfig(env: EnvRecord): ConfigResult {
  const secretKey = (env.PAYSTACK_SECRET_KEY ?? '').trim();

  if (!secretKey) {
    return { ok: false, error: 'PAYSTACK_SECRET_KEY is not set' };
  }

  if (!/^sk_(test|live)_/.test(secretKey)) {
    return {
      ok: false,
      error: 'PAYSTACK_SECRET_KEY does not look like a Paystack secret key (sk_test_ / sk_live_)',
    };
  }

  const mode: 'test' | 'live' = secretKey.startsWith('sk_live_') ? 'live' : 'test';

  if (isStaging(env) && mode === 'live') {
    return {
      ok: false,
      error: 'Refusing to use a live Paystack key on staging',
    };
  }

  return { ok: true, config: { secretKey, mode } };
}

/**
 * A reference, ours, unguessable.
 *
 * ⚠ Not the booking id, and not a counter.
 *
 *   Paystack references are echoed in redirect URLs and in emails. A reference
 *   that is the parcel's primary key hands that key to anybody who sees one,
 *   and a sequential one lets somebody enumerate every charge the platform has
 *   taken. The random half is what makes a reference safe to put in a URL.
 *
 * The `pkr_` prefix is for the human reading the Paystack dashboard, who
 * otherwise sees a column of indistinguishable hex.
 */
export function paymentReference(random: () => string = defaultRandom): string {
  return `pkr_${Date.now().toString(36)}_${random()}`;
}

function defaultRandom(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Naira to the minor unit. Rounded, because a fare is money and not a float. */
export function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}

/** Kobo back to something a person reads, e.g. "₦2,800.00". */
export function formatKobo(kobo: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
  }).format(kobo / 100);
}

export type InitializeInput = {
  reference: string;
  amountKobo: number;
  email: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
};

export type InitializeResult =
  | { ok: true; authorizationUrl: string; accessCode: string; reference: string }
  | { ok: false; error: string };

export async function initializeTransaction(
  config: PaystackConfig,
  input: InitializeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<InitializeResult> {
  let response: Response;

  try {
    response = await fetchImpl(`${PAYSTACK_API}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reference: input.reference,
        amount: input.amountKobo,
        email: input.email,
        currency: 'NGN',
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      }),
    });
  } catch (thrown) {
    return { ok: false, error: `Could not reach Paystack: ${String(thrown)}` };
  }

  const body = (await response.json().catch(() => null)) as
    | { status?: boolean; message?: string; data?: Record<string, unknown> }
    | null;

  if (!response.ok || !body?.status || !body.data) {
    return { ok: false, error: body?.message ?? `Paystack returned ${response.status}` };
  }

  const authorizationUrl = String(body.data.authorization_url ?? '');
  if (!authorizationUrl) {
    return { ok: false, error: 'Paystack returned no authorization_url' };
  }

  return {
    ok: true,
    authorizationUrl,
    accessCode: String(body.data.access_code ?? ''),
    reference: String(body.data.reference ?? input.reference),
  };
}

export type VerifiedCharge = {
  /** Paystack's own verdict, lower-cased: 'success', 'failed', 'abandoned', … */
  status: string;
  reference: string;
  gatewayReference: string | null;
  amountKobo: number;
  channel: string | null;
  paidAt: string | null;
  failureReason: string | null;
  raw: unknown;
};

export type VerifyResult = { ok: true; charge: VerifiedCharge } | { ok: false; error: string };

/**
 * Asks Paystack what actually happened to a reference.
 *
 * ⚠ This is the only statement about a charge that this system trusts.
 *
 *   Not the redirect the browser arrived on — anybody can type that URL. Not
 *   the webhook body — that is checked by signature and then *also* verified
 *   here, because a replayed body with a valid old signature is still a real
 *   signature. The provider's API, asked with the secret key, over TLS, is the
 *   authority.
 */
export async function verifyTransaction(
  config: PaystackConfig,
  reference: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  let response: Response;

  try {
    response = await fetchImpl(
      `${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${config.secretKey}` } },
    );
  } catch (thrown) {
    return { ok: false, error: `Could not reach Paystack: ${String(thrown)}` };
  }

  const body = (await response.json().catch(() => null)) as
    | { status?: boolean; message?: string; data?: Record<string, unknown> }
    | null;

  if (!response.ok || !body?.status || !body.data) {
    return { ok: false, error: body?.message ?? `Paystack returned ${response.status}` };
  }

  const data = body.data;

  return {
    ok: true,
    charge: {
      status: String(data.status ?? '').toLowerCase(),
      reference: String(data.reference ?? reference),
      gatewayReference: data.id === undefined || data.id === null ? null : String(data.id),
      /*
       * Paystack sends this as a number of kobo. Coerced rather than trusted:
       * a missing field must become 0 and fail the amount comparison in
       * `settle_parcel_payment`, not become NaN and pass every `<` test.
       */
      amountKobo: Number(data.amount ?? 0) || 0,
      channel: data.channel === undefined || data.channel === null ? null : String(data.channel),
      paidAt:
        typeof data.paid_at === 'string'
          ? data.paid_at
          : typeof data.paidAt === 'string'
            ? data.paidAt
            : null,
      failureReason:
        typeof data.gateway_response === 'string' ? data.gateway_response : null,
      raw: data,
    },
  };
}

/**
 * Whether this POST really came from Paystack.
 *
 * Paystack signs the raw request body with HMAC-SHA512 keyed on the secret key
 * and sends the hex digest in `x-paystack-signature`.
 *
 * ⚠ The *raw* body, byte for byte, and never a re-serialised object.
 *
 *   `JSON.stringify(await request.json())` reorders nothing in practice and
 *   changes whitespace in every case, and the digest is over bytes. Reading the
 *   body as text once and parsing that same string is the only arrangement that
 *   works; any function that parses first has a signature check that fails
 *   100% of the time, which reads in the logs exactly like an attack.
 *
 * ⚠ Compared without an early exit.
 *
 *   `a === b` on a digest leaks, through timing, how much of a forged signature
 *   was right. `timingSafeEqual` in `service-role.ts` exists for this and is
 *   reused rather than reimplemented.
 */
export async function verifyWebhookSignature(
  secretKey: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const provided = (signature ?? '').trim().toLowerCase();
  if (!provided || !secretKey) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );

  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );

  if (expected.length !== provided.length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Where the browser is sent back to after the gateway is finished with it.
 *
 * ⚠ Built from a configured origin, never from anything in the request.
 *
 *   A callback URL taken from a request header or body is an open redirect
 *   with a payment attached: a crafted initialize call would send the sender,
 *   mid-checkout, to somewhere that looks like Package Relay and asks for their
 *   card again. `LOCI_APP_URL` is the same secret the emails already use to
 *   build their buttons, and it is set per project.
 */
export function callbackUrl(env: EnvRecord, requestedOrigin?: string | null): string {
  const configured = (env.LOCI_APP_URL ?? '').trim().replace(/\/+$/, '');
  const origin = resolveReturnOrigin(env, configured, requestedOrigin);
  if (!origin) return '';

  /*
    ⚠ No `?reference=` of our own, and its absence is a bug fix.

      This used to append one. Paystack then appends *its* own
      `trxref=X&reference=X` to whatever callback it was handed, so every sender
      came back to `?reference=X&trxref=X&reference=X` — the key twice.
      expo-router represents a repeated key as an array, `.trim()` on an array
      throws, and the return page died with `A.trim is not a function` one
      second after the card was charged.

      Ours was redundant from the start: the reference the page reads is the one
      Paystack sends back. `payment-return` reads either key and tolerates an
      array now, but the duplicate is fixed here, where it was created.
  */
  return `${origin}/payment-return`;
}

/**
 * Which origin the sender is sent back to.
 *
 * ⚠ Never simply what the caller asked for — that is an open redirect with a
 *   payment attached.
 *
 *   A callback taken from the request body would let a crafted initialize call
 *   drop a sender, mid-checkout, on a page that looks like Package Relay and
 *   asks for their card again. The configured `LOCI_APP_URL` is the answer in
 *   every deployment.
 *
 * ⚠ The one exception is localhost, and only off production.
 *
 *   Without it, a checkout started against `localhost:8081` returns the
 *   developer to staging — a different origin, a different session, and a
 *   parcel they cannot see. That is not a bug in the code so much as a hole in
 *   being able to test it at all.
 *
 *   It is safe because an attacker cannot serve anything on their victim's
 *   localhost: redirecting somebody to their own machine reaches whatever they
 *   are already running, which is nothing an attacker controls. The production
 *   guard is belt and braces — a live deployment has no reason to ever emit a
 *   localhost callback, so it does not get to.
 */
export function resolveReturnOrigin(
  env: EnvRecord,
  configured: string,
  requested?: string | null,
): string {
  const asked = (requested ?? '').trim().replace(/\/+$/, '');
  if (!asked) return configured;
  if (asked === configured) return asked;

  if (readEnvironment(env) === 'production') return configured;

  return isLocalhostOrigin(asked) ? asked : configured;
}

/** `http://localhost:8081`, `http://127.0.0.1:19006` — and nothing else. */
export function isLocalhostOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}
