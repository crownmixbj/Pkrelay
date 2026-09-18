/**
 * Paystack's own word on a charge, and the path that must work when the
 * sender's does not.
 *
 * ⚠ Deployed WITHOUT JWT verification, and that is the whole difficulty.
 *
 *     supabase functions deploy payments-webhook --no-verify-jwt
 *
 *   Paystack's servers have no Supabase token and never will. Every other
 *   function in this directory is protected by the gateway refusing anything
 *   without a project JWT; this one is an anonymous POST endpoint open to the
 *   internet, and the HMAC signature below is the only thing between it and
 *   anybody who can spell its URL. Deploying it *with* jwt verification is the
 *   other failure: Paystack is refused at the gateway, this function's logs
 *   stay empty, and every payment sits pending until somebody notices.
 *
 * ⚠ The body is read as text once, and the signature is checked over exactly
 *   those bytes before it is parsed.
 *
 *   See `verifyWebhookSignature`. Parsing first and re-serialising for the
 *   digest produces a check that fails every time, which in a log looks
 *   identical to being under attack.
 *
 * ⚠ A valid signature still does not settle anything on its own.
 *
 *   The body says a charge succeeded and is genuinely from Paystack — and a
 *   replayed old body carries a genuinely valid old signature. So the
 *   reference is put back to Paystack's verify endpoint, and it is that answer
 *   that reaches `settle_parcel_payment`. The signature decides whether to look;
 *   the API decides what is true.
 *
 * Retries: Paystack re-sends on any non-2xx. So a failure this end answers 500
 * and gets another chance, while anything permanent — an unknown reference, an
 * event we do not handle — answers 200, because retrying it forever helps
 * nobody.
 */

import { logger } from '../_shared/service-role.ts';
import {
  readPaystackConfig,
  verifyTransaction,
  verifyWebhookSignature,
} from '../_shared/paystack.ts';

const env = (key: string) => Deno.env.get(key) ?? undefined;

const ENV: Record<string, string | undefined> = {
  PAYSTACK_SECRET_KEY: env('PAYSTACK_SECRET_KEY'),
  LOCI_ENVIRONMENT: env('LOCI_ENVIRONMENT'),
};

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/*
 * No CORS helpers here, deliberately.
 *
 * `_shared/cors.ts` exists for functions a browser calls. No browser calls this
 * one — Paystack's server does, server to server, with no origin and no
 * preflight — and answering `Access-Control-Allow-Origin: *` on an unauthenticated
 * endpoint would additionally invite a page anywhere on the internet to POST to
 * it and read the reply.
 */
function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function rpc(name: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);

  const log = logger('payments-webhook', crypto.randomUUID());

  const config = readPaystackConfig(ENV);
  if (!config.ok) {
    log('misconfigured', { error: config.error });
    /* 500 so Paystack retries once the key is set, rather than dropping it. */
    return reply({ error: 'not configured' }, 500);
  }

  const raw = await request.text();
  const signature = request.headers.get('x-paystack-signature') ?? '';

  const genuine = await verifyWebhookSignature(config.config.secretKey, raw, signature);

  if (!genuine) {
    /*
     * 401 and nothing else. No detail about which part was wrong, and no
     * retry-worthy 500 — a forged request should learn nothing and get no
     * second attempt.
     */
    log('bad-signature', { bytes: raw.length });
    return reply({ error: 'unauthorised' }, 401);
  }

  let event: { event?: string; data?: { reference?: string } };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    log('unparseable', {});
    return reply({ ok: true });
  }

  const kind = event.event ?? '';
  const reference = event.data?.reference ?? '';

  if (!reference) {
    log('no-reference', { kind });
    return reply({ ok: true });
  }

  /*
   * Only the charge events. Paystack sends transfers, subscriptions, disputes
   * and refunds down the same URL; acknowledging them is right, acting on them
   * here is not.
   */
  if (kind !== 'charge.success' && kind !== 'charge.failed') {
    log('ignored', { kind });
    return reply({ ok: true });
  }

  if (kind === 'charge.failed') {
    await rpc('fail_parcel_payment', {
      p_reference: reference,
      p_reason: 'Paystack reported the charge failed',
      p_abandoned: false,
    });
    log('failed', { reference });
    return reply({ ok: true });
  }

  /* Signed, therefore worth looking at. Now find out what is actually true. */
  const verified = await verifyTransaction(config.config, reference);

  if (!verified.ok) {
    log('verify-failed', { reference, error: verified.error });
    /* Transient by assumption — 500 asks Paystack to send it again. */
    return reply({ error: 'could not verify' }, 500);
  }

  if (verified.charge.status !== 'success') {
    /*
     * Signed as charge.success, reported as something else by the API. The API
     * wins. Nothing is settled and nothing is retried.
     */
    log('contradicted', { reference, gateway_status: verified.charge.status });
    return reply({ ok: true });
  }

  const settled = await rpc('settle_parcel_payment', {
    p_reference: reference,
    p_gateway_reference: verified.charge.gatewayReference,
    p_amount_kobo: verified.charge.amountKobo,
    p_channel: verified.charge.channel,
    p_paid_at: verified.charge.paidAt,
    p_raw: verified.charge.raw,
  });

  if (!settled.ok) {
    const detail = await settled.text();
    log('settle-failed', { reference, status: settled.status, detail: detail.slice(0, 300) });
    return reply({ error: 'could not settle' }, 500);
  }

  const verdict = (await settled.json()) as {
    ok?: boolean;
    reason?: string;
    booking_id?: string;
    already_settled?: boolean;
    refund_owed?: boolean;
  };

  log('settled', {
    reference,
    booking_id: verdict.booking_id,
    already_settled: verdict.already_settled ?? false,
    refund_owed: verdict.refund_owed ?? false,
    reason: verdict.reason,
  });

  /*
   * 200 even when the verdict is `ok: false`.
   *
   * An unknown reference or an amount mismatch is a permanent state of
   * affairs, recorded in `parcel_payments` for a person to look at. Answering
   * 500 would have Paystack redeliver it for days and change nothing.
   */
  return reply({ ok: true });
});
