/**
 * Asks Paystack what happened to a reference, and settles the parcel on the
 * strength of the answer.
 *
 * ⚠ This is the fast path, not the authority.
 *
 *   `payments-webhook` is the one that must work. It arrives whether or not
 *   the sender's browser came back, whether or not their phone lost signal on
 *   the way, and Paystack retries it. This function exists so the sender is not
 *   left looking at a spinner while waiting for a webhook — it reaches the same
 *   `settle_parcel_payment`, which is idempotent precisely because both of them
 *   will usually fire for the same charge.
 *
 * ⚠ The reference the client sends is checked against the caller's own
 *   payments before it is verified.
 *
 *   Without that, anybody signed in could feed this any reference they liked
 *   and settle somebody else's parcel. It would still cost them nothing and
 *   still tell them nothing — but the parcel would dispatch, which is the part
 *   that matters.
 *
 * Deploy:
 *
 *   supabase functions deploy payments-verify
 */

import { json, preflight } from '../_shared/cors.ts';
import { logger } from '../_shared/service-role.ts';
import { readPaystackConfig, verifyTransaction } from '../_shared/paystack.ts';

const env = (key: string) => Deno.env.get(key) ?? undefined;

const ENV: Record<string, string | undefined> = {
  PAYSTACK_SECRET_KEY: env('PAYSTACK_SECRET_KEY'),
  LOCI_ENVIRONMENT: env('LOCI_ENVIRONMENT'),
};

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/**
 * Whether this account is an administrator.
 *
 * ⚠ Read from `profiles` with the service key rather than by calling
 *   `is_admin()` as the caller.
 *
 *   Either would work. This one cannot be affected by what the caller's token
 *   can or cannot execute, and it is one round trip against a table this
 *   function already has a connection to. `profiles.is_admin` is not writable
 *   by any client — 07 makes sure of that — so it is as good an answer as the
 *   policy's own.
 */
async function isAdmin(userId: string): Promise<boolean> {
  const response = await db(
    `profiles?id=eq.${encodeURIComponent(userId)}&select=is_admin&limit=1`,
  );
  if (!response.ok) return false;

  const rows = (await response.json()) as { is_admin?: boolean }[];
  return rows[0]?.is_admin === true;
}

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

async function rpc(name: string, body: Record<string, unknown>): Promise<Response> {
  return db(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
}

Deno.serve(async (request: Request) => {
  const options = preflight(request);
  if (options) return options;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const log = logger('payments-verify', crypto.randomUUID());

  const config = readPaystackConfig(ENV);
  if (!config.ok) {
    log('misconfigured', { error: config.error });
    return json({ error: 'Payments are not available right now.' }, 503);
  }

  const userId = await callerId(request.headers.get('Authorization'));
  if (!userId) return json({ error: 'Not signed in' }, 401);

  let reference = '';
  try {
    const body = (await request.json()) as { reference?: unknown };
    reference = typeof body.reference === 'string' ? body.reference.trim() : '';
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  if (!reference) return json({ error: 'reference is required' }, 400);

  const found = await db(
    `parcel_payments?reference=eq.${encodeURIComponent(reference)}` +
      `&select=id,booking_id,sender_id,status,amount_kobo`,
  );

  if (!found.ok) {
    log('payment-read-failed', { status: found.status });
    return json({ error: 'Could not check that payment.' }, 502);
  }

  const payment = ((await found.json()) as {
    id: string;
    booking_id: string;
    sender_id: string;
    status: string;
    amount_kobo: string | number;
  }[])[0];

  /*
   * ⚠ An administrator may verify a charge that is not theirs, and that is the
   *   whole of the manual-sync feature.
   *
   *   Paystack's webhook is the authority and it can be missed: a deploy in
   *   flight, a cold function, a signature check against a key that was being
   *   rotated. What is left behind is a charge that succeeded at the gateway
   *   and a parcel sitting unpaid and invisible to drivers, with the sender's
   *   own retry window long gone. Somebody has to be able to ask Paystack again
   *   on their behalf, and the admin console is where they do it.
   *
   *   It is not a new door. This function already re-asks the provider and
   *   settles through the same idempotent RPC; the only thing being widened is
   *   *whose* reference a caller may name. Everything downstream — the amount
   *   comparison, the cancelled-parcel branch, the single dispatch — is
   *   unchanged and unaware of who asked.
   */
  const onBehalf = Boolean(payment) && payment.sender_id !== userId;
  const admin = onBehalf ? await isAdmin(userId) : false;

  if (!payment || (onBehalf && !admin)) {
    log('refused', { reason: 'not-the-payer' });
    return json({ error: 'No such payment' }, 404);
  }

  if (admin) {
    /*
     * ⚠ Logged before the work, not after.
     *
     *   An admin reaching into somebody else's payment is an act with a
     *   consequence — it can flip a parcel live and pay a driver's clock — and
     *   a log written only on success is a log that is silent about the
     *   attempts that failed, which are the interesting ones.
     */
    await db('app_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        level: 'info',
        area: 'payment',
        message: 'admin re-verified a charge',
        context: { reference, booking_id: payment.booking_id },
        actor_id: userId,
      }),
    });

    log('admin-sync', { reference, admin: userId });
  }

  /*
   * Already settled — by the webhook, or by this sender hitting refresh.
   *
   * Answered without calling Paystack at all. The verdict cannot change, and a
   * network round trip to be told so is a second or two of the sender staring
   * at a screen that already knows the answer.
   */
  if (payment.status === 'success') {
    return json({ status: 'success', booking_id: payment.booking_id, already_settled: true });
  }

  const verified = await verifyTransaction(config.config, reference);

  if (!verified.ok) {
    log('verify-failed', { error: verified.error, reference });
    /*
     * ⚠ The attempt is NOT failed here.
     *
     *   "We could not reach Paystack" is not "the card was declined". Marking
     *   the row failed on an unreachable provider would let the sender start a
     *   second attempt for a charge that may well have succeeded — and the
     *   webhook, arriving later, would settle the first one. Left pending, the
     *   webhook settles it and the sender's screen catches up.
     */
    return json({ status: 'unknown', error: 'Could not confirm the payment yet.' }, 502);
  }

  const charge = verified.charge;

  if (charge.status !== 'success') {
    await rpc('fail_parcel_payment', {
      p_reference: reference,
      p_reason: charge.failureReason ?? `Paystack reported ${charge.status}`,
      p_abandoned: charge.status === 'abandoned',
    });

    log('not-successful', { reference, gateway_status: charge.status });

    return json({
      status: charge.status,
      booking_id: payment.booking_id,
      error: charge.failureReason ?? 'That payment did not go through.',
    });
  }

  const settled = await rpc('settle_parcel_payment', {
    p_reference: reference,
    p_gateway_reference: charge.gatewayReference,
    p_amount_kobo: charge.amountKobo,
    p_channel: charge.channel,
    p_paid_at: charge.paidAt,
    p_raw: charge.raw,
  });

  if (!settled.ok) {
    const detail = await settled.text();
    log('settle-failed', { status: settled.status, detail: detail.slice(0, 300) });
    return json({ status: 'unknown', error: 'Could not confirm the payment yet.' }, 502);
  }

  const verdict = (await settled.json()) as {
    ok?: boolean;
    reason?: string;
    booking_id?: string;
    refund_owed?: boolean;
  };

  if (!verdict.ok) {
    log('settle-refused', { reference, reason: verdict.reason });
    return json({
      status: 'failed',
      booking_id: payment.booking_id,
      error:
        verdict.reason === 'amount_mismatch'
          ? 'The amount paid did not match this parcel. Support can sort this out.'
          : 'That payment could not be applied to this parcel.',
    });
  }

  log('settled', { reference, booking_id: verdict.booking_id, refund_owed: verdict.refund_owed });

  return json({
    status: 'success',
    booking_id: verdict.booking_id ?? payment.booking_id,
    refund_owed: verdict.refund_owed ?? false,
  });
});
