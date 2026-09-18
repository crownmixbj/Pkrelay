/**
 * Tells a driver an offer is waiting.
 *
 * Called by the `dispatch_offers_notify` trigger in `20250101000019_push.sql`, the moment an
 * offer row appears — which covers every path that creates one: a parcel being
 * posted, an offer expiring, a decline, and a flash shift going online.
 *
 * This is the piece every dispatch file so far has named as missing. An offer is
 * held five minutes within a city and ten between them (`public.offer_hold`);
 * without this it reaches a driver only if the app is open. The countdown in the
 * message body is read from the offer row, so it follows whichever window
 * applies rather than assuming one.
 *
 * Deploy:
 *
 *   supabase functions deploy notify-offer
 *
 * It needs no secret of its own — Expo's push API is unauthenticated, because
 * the token *is* the credential. It does need `edge_url` and `service_key` in
 * `private.app_settings`, the same pair `notify-application` uses.
 */

import { buildMessage, chunk, sendBatch, type OfferPayload } from './expo-push.ts';
import { isServiceRole } from '../_shared/service-role.ts';

const env = (key: string) => Deno.env.get(key) ?? null;

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) return null;
  return response.json();
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /*
   * Called by a database trigger, not by a client.
   *
   * The trigger sends the service key. Anything else reaching this endpoint has
   * no business here — and without the check, an arbitrary caller could pass an
   * offer id and cause a notification to somebody else's phone.
   */
  const auth = request.headers.get('Authorization') ?? '';
  /*
   * ⚠ The role, not a comparison with this deployment's own copy of the key.
   *
   *   See `_shared/service-role.ts`. The identical check in `notify-events`
   *   turned a rotated key — and a key pasted into the SQL editor with a
   *   trailing newline — into a 403 that recorded nothing anywhere, while the
   *   database went on believing it had posted. This function is reached by the
   *   same trigger machinery, carrying the same key from the same table.
   */
  const caller = isServiceRole(auth, SERVICE_KEY);
  if (!caller.ok) {
    console.log(JSON.stringify({ fn: 'notify-offer', stage: 'refused', why: caller.how }));
    return json({ error: 'Not allowed' }, 401);
  }

  let offerId = '';
  try {
    const body = (await request.json()) as { offer_id?: unknown };
    offerId = typeof body.offer_id === 'string' ? body.offer_id : '';
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  if (!offerId) return json({ error: 'offer_id is required' }, 400);

  const rows = (await rpc('offer_push_payload', { offer_id: offerId })) as
    Record<string, unknown>[] | null;

  const row = rows?.[0];
  /*
   * No row means the offer settled between the trigger firing and this running
   * — declined on another device, or swept. Not an error; there is simply
   * nobody to tell any more.
   */
  if (!row) return json({ status: 'gone' });

  const driverId = String(row.driver_id ?? '');
  if (!driverId) return json({ status: 'gone' });

  const tokenRows = (await rpc('push_tokens_for', { target: driverId })) as
    { token: string }[] | null;

  const tokens = (tokenRows ?? []).map((entry) => entry.token).filter(Boolean);

  /*
   * A driver with no registered device is the common case on day one, and is
   * not a failure. They will see the offer when they open the app, exactly as
   * they did before this existed.
   */
  if (tokens.length === 0) return json({ status: 'no-devices' });

  const offer: OfferPayload = {
    // From the request, not the row: it is the id the trigger sent and the one
    // the driver's tap has to resolve back to.
    offerId,
    bookingId: String(row.booking_id ?? ''),
    originCity: String(row.origin_city ?? ''),
    destinationCity: String(row.destination_city ?? ''),
    weight: Number(row.weight ?? 0),
    fee: Number(row.fee ?? 0),
    isLocal: row.is_local === true,
    expiresAt: String(row.expires_at ?? new Date().toISOString()),
  };

  let sent = 0;
  let failed = 0;

  for (const batch of chunk(tokens)) {
    const outcome = await sendBatch(batch.map((token) => buildMessage(token, offer)));
    sent += outcome.sent;
    failed += outcome.failed;

    /*
     * Drop what Expo says is gone.
     *
     * A token for an uninstalled app never stops being invalid, and keeping it
     * means paying to send into a void on every future offer — and, worse,
     * makes "we notified them" true in the log and false in the world.
     */
    for (const dead of outcome.deadTokens) {
      await rpc('forget_push_token', { dead_token: dead });
    }
  }

  // Counts only. Tokens are credentials and never appear in a response or a log.
  return json({ status: 'sent', sent, failed });
});
