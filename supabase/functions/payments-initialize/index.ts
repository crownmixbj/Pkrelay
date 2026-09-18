/**
 * Opens a Paystack checkout for a parcel that has been posted but not paid for.
 *
 * ⚠ The client sends a booking id and nothing else. Not an amount.
 *
 *   An amount in the request body is an amount the sender chooses. The fare is
 *   read here from the parcel's own `estimated_fee` — immutable since the
 *   insert (`bookings_guard_immutable`, 20250101000001_bookings.sql) — through
 *   `parcel_fare_kobo`, which is the same arithmetic the settlement check uses.
 *   There is no path by which the two disagree.
 *
 * ⚠ The reference is written to this database before Paystack is told about it.
 *
 *   The other order loses it whenever the API call times out, leaving a charge
 *   at the provider that nothing here points at. `open_parcel_payment` creates
 *   the row; this function then initializes it.
 *
 * Deploy:
 *
 *   supabase functions deploy payments-initialize
 *
 * Secrets: PAYSTACK_SECRET_KEY, LOCI_APP_URL. See `docs/PAYMENTS.md`.
 */

import { json, preflight } from '../_shared/cors.ts';
import { logger } from '../_shared/service-role.ts';
import {
  callbackUrl,
  initializeTransaction,
  readPaystackConfig,
} from '../_shared/paystack.ts';

const env = (key: string) => Deno.env.get(key) ?? undefined;

const ENV: Record<string, string | undefined> = {
  PAYSTACK_SECRET_KEY: env('PAYSTACK_SECRET_KEY'),
  LOCI_APP_URL: env('LOCI_APP_URL'),
  LOCI_ENVIRONMENT: env('LOCI_ENVIRONMENT'),
};

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/** The caller, as the auth server sees them. Email included — Paystack wants one. */
async function caller(
  authHeader: string | null,
): Promise<{ id: string; email: string } | null> {
  if (!authHeader) return null;

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: SERVICE_KEY },
  });
  if (!response.ok) return null;

  const user = (await response.json()) as { id?: string; email?: string };
  if (typeof user.id !== 'string') return null;

  return { id: user.id, email: typeof user.email === 'string' ? user.email : '' };
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

Deno.serve(async (request: Request) => {
  /* Before the method check, or the browser reports a CORS block. See cors.ts. */
  const options = preflight(request);
  if (options) return options;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const log = logger('payments-initialize', crypto.randomUUID());

  const config = readPaystackConfig(ENV);
  if (!config.ok) {
    log('misconfigured', { error: config.error });
    /*
     * Deliberately vague to the caller and specific in the log. "Refusing to
     * use a live Paystack key on staging" is an operational fact, not
     * something to render inside a sender's checkout.
     */
    return json({ error: 'Payments are not available right now.' }, 503);
  }

  const person = await caller(request.headers.get('Authorization'));
  if (!person) return json({ error: 'Not signed in' }, 401);

  let bookingId = '';
  try {
    const body = (await request.json()) as { booking_id?: unknown };
    bookingId = typeof body.booking_id === 'string' ? body.booking_id : '';
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  if (!bookingId) return json({ error: 'booking_id is required' }, 400);

  /*
   * ⚠ Ownership is checked here, against the row, before anything is created.
   *
   *   Every read below this line uses the service key and therefore bypasses
   *   RLS — which is necessary, because the function has to see columns the
   *   sender's own policy would allow but the *parcel's* payment state lives
   *   behind. The price of bypassing RLS is that the ownership check nobody
   *   else is doing has to happen explicitly, right here.
   */
  const found = await db(
    `bookings?id=eq.${encodeURIComponent(bookingId)}` +
      `&select=id,sender_id,tracking_id,estimated_fee,status,payment_status`,
  );

  if (!found.ok) {
    log('booking-read-failed', { status: found.status });
    return json({ error: 'Could not read that parcel.' }, 502);
  }

  const rows = (await found.json()) as {
    id: string;
    sender_id: string;
    tracking_id: string;
    estimated_fee: string | number;
    status: string;
    payment_status: string;
  }[];

  const parcel = rows[0];

  /*
   * One answer for "no such parcel" and "not yours".
   *
   * Distinguishing them turns this endpoint into a way of asking whether a
   * given uuid is a real booking.
   */
  if (!parcel || parcel.sender_id !== person.id) {
    log('refused', { reason: 'not-the-sender' });
    return json({ error: 'No such parcel' }, 404);
  }

  if (parcel.payment_status !== 'pending') {
    return json({ error: 'That parcel has already been paid for.', already_paid: true }, 409);
  }

  if (parcel.status === 'Cancelled') {
    return json({ error: 'That parcel was cancelled.' }, 409);
  }

  if (!person.email) {
    /*
     * Paystack requires an email on every transaction — it is the receipt
     * address and the customer key. An account with none is a Supabase
     * phone-only signup, which this app does not create; saying so plainly
     * beats a 400 from the gateway.
     */
    return json({ error: 'Your account has no email address to send a receipt to.' }, 422);
  }

  /*
   * The reference is generated by the database call, not here — `open_parcel_payment`
   * reuses an existing live attempt when there is one, and a reference minted
   * before that call would be discarded on the reuse path and leak into logs
   * as a charge that never existed.
   */
  const opened = await rpc('open_parcel_payment', {
    p_booking: bookingId,
    p_reference: `pkr_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    p_provider: 'paystack',
  });

  if (!opened.ok) {
    const detail = await opened.text();
    log('open-failed', { status: opened.status, detail: detail.slice(0, 300) });
    return json({ error: 'Could not start that payment.' }, 409);
  }

  const payment = (await opened.json()) as {
    id: string;
    reference: string;
    amount_kobo: string | number;
    authorization_url: string | null;
  };

  const amountKobo = Number(payment.amount_kobo);

  const started = await initializeTransaction(config.config, {
    reference: payment.reference,
    amountKobo,
    email: person.email,
    callbackUrl: callbackUrl(ENV, payment.reference),
    /*
     * Metadata is for the human in the Paystack dashboard reconciling a
     * disputed charge. The tracking id is what a support conversation is
     * actually about; the booking id is what a query needs. No names, no
     * phone numbers — that dashboard is a third party's.
     */
    metadata: {
      booking_id: parcel.id,
      tracking_id: parcel.tracking_id,
      environment: ENV.LOCI_ENVIRONMENT ?? 'production',
      custom_fields: [
        {
          display_name: 'Parcel',
          variable_name: 'tracking_id',
          value: parcel.tracking_id,
        },
      ],
    },
  });

  if (!started.ok) {
    log('initialize-failed', { error: started.error, reference: payment.reference });

    /*
     * The attempt is closed rather than left pending. A 'pending' row the
     * gateway never heard of would hold the one-live-attempt index against the
     * sender and lock them out of paying for their own parcel.
     */
    await rpc('fail_parcel_payment', {
      p_reference: payment.reference,
      p_reason: `Initialize failed: ${started.error}`.slice(0, 500),
      p_abandoned: false,
    });

    return json({ error: 'Could not reach the payment provider. Try again.' }, 502);
  }

  await db(`parcel_payments?id=eq.${encodeURIComponent(payment.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ authorization_url: started.authorizationUrl, updated_at: new Date().toISOString() }),
  });

  log('initialized', {
    reference: payment.reference,
    amount_kobo: amountKobo,
    mode: config.config.mode,
  });

  return json({
    reference: payment.reference,
    authorization_url: started.authorizationUrl,
    access_code: started.accessCode,
    amount_kobo: amountKobo,
    /* So the sheet can show what is being charged without recomputing it. */
    tracking_id: parcel.tracking_id,
  });
});
