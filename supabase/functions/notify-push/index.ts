/**
 * Sends one queued notification to a person's devices, and records what happened.
 *
 * Called by the `notifications_dispatch_push` trigger in
 * `20250101000050_notification_triggers.sql`, once per row, with nothing but a
 * notification id — and again by `sweep_unsent_pushes` for anything that never
 * got an answer.
 *
 * ⚠ The id, not the content. Same argument as `notify-events`.
 *
 *   A trigger that posted the rendered message would copy a driver's job
 *   details into a pg_net request body and its logs, and would make this an
 *   endpoint that pushes whatever it is handed — reachable by anything holding
 *   the service key. Passing an id means the function reads the row itself and
 *   can only ever send what the database decided to send.
 *
 * ⚠ It writes the outcome and never deletes the row.
 *
 *   `notifications` is the record of what Package Relay told somebody. "Was the
 *   driver notified about that job?" gets asked weeks later, usually during an
 *   argument about a missed pickup, and a queue that empties itself cannot
 *   answer it.
 *
 * Deploy:
 *   supabase functions deploy notify-push
 *
 * It needs no secret of its own — Expo's push API is unauthenticated, because
 * the token *is* the credential. It does need `edge_url` and `service_key` in
 * `private.app_settings`, the same pair `notify-offer` uses.
 */

import { json, preflight } from '../_shared/cors.ts';
import { pushEnabled } from '../_shared/environment.ts';
import { chunk, sendBatch } from '../_shared/expo-push.ts';
import { buildMessage, type NotificationRow } from './message.ts';

const env = (key: string) => Deno.env.get(key) ?? null;

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

type Row = NotificationRow & {
  pushed_at: string | null;
  push_requested: boolean;
  push_attempts: number;
};

async function readRow(id: string): Promise<Row | null> {
  const url =
    `${SUPABASE_URL}/rest/v1/notifications` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=id,user_id,kind,title,body,metadata,pushed_at,push_requested,push_attempts&limit=1`;

  const response = await fetch(url, { headers: restHeaders });
  if (!response.ok) return null;

  const rows = (await response.json()) as Row[];
  return rows[0] ?? null;
}

/**
 * Writes the delivery record.
 *
 * ⚠ `push_attempts` is incremented whatever the outcome, including success.
 *
 *   It is the count of times this function ran for the row, which is what
 *   `sweep_unsent_pushes` needs to stop retrying forever. A counter that only
 *   moved on failure would let a row that fails in a new way each time retry
 *   indefinitely.
 */
async function record(row: Row, error: string | null): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/notifications?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { ...restHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        pushed_at: error ? null : new Date().toISOString(),
        push_error: error,
        push_attempts: (row.push_attempts ?? 0) + 1,
      }),
    });
  } catch (thrown) {
    // Logged, not thrown: the push may well have gone out, and failing here
    // would make a delivered notification look like a failure.
    console.error('Could not record push outcome', thrown);
  }
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: restHeaders,
    body: JSON.stringify(args),
  });
  if (!response.ok) return null;
  return response.json();
}

Deno.serve(async (request: Request) => {
  const options = preflight(request);
  if (options) return options;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /*
   * ⚠ Only the service role.
   *
   *   Supabase already refuses an unauthenticated call, but the anon key ships
   *   in the app bundle and would otherwise be enough to reach this — and an
   *   endpoint that takes a notification id and pushes it is an endpoint that
   *   can be replayed at somebody else's phone.
   */
  const auth = request.headers.get('Authorization') ?? '';
  if (!SERVICE_KEY || auth !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: 'Forbidden' }, 403);
  }

  let notificationId = '';
  try {
    const body = (await request.json()) as { notification_id?: unknown };
    notificationId = typeof body.notification_id === 'string' ? body.notification_id : '';
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  if (!notificationId) return json({ error: 'notification_id is required' }, 400);

  const row = await readRow(notificationId);
  if (!row) return json({ error: 'No such notification' }, 404);

  /*
   * ⚠ The second half of exactly-once.
   *
   *   The unique key in 49 stops a second row being queued. This stops a second
   *   *send* of the same row — the retry sweeper racing a slow first request, or
   *   somebody replaying a call. Both halves are needed; neither is sufficient.
   */
  if (row.pushed_at) return json({ ok: true, skipped: 'already pushed' });
  if (!row.push_requested) return json({ ok: true, skipped: 'inbox only' });

  /*
   * ⚠ Staging must not reach a real driver's phone.
   *
   *   `_shared/environment.ts` already redirects email and mutes Slack for this
   *   reason. Push was the one outbound integration with no such gate — and it
   *   is the worst one to miss, because a staging database restored from a
   *   production backup carries production push tokens, which are bearer
   *   credentials for real devices. Test rows would ring real phones with real
   *   "job assigned" alerts.
   *
   *   Recorded rather than silently skipped, so the row explains itself.
   */
  if (!pushEnabled({ LOCI_ENVIRONMENT: env('LOCI_ENVIRONMENT') ?? undefined, LOCI_STAGING_PUSH: env('LOCI_STAGING_PUSH') ?? undefined })) {
    await record(row, 'push is disabled in this environment');
    return json({ ok: false, skipped: 'staging' });
  }

  const tokenRows = (await rpc('push_tokens_for', { target: row.user_id })) as
    | { token: string }[]
    | null;

  const tokens = (tokenRows ?? []).map((entry) => entry.token).filter(Boolean);

  /*
   * ⚠ No device is recorded, not shrugged off.
   *
   *   `notify-offer` returns `no-devices` and writes nothing, which is fine for
   *   a function with no delivery record to keep. Here it matters: "the driver
   *   has never registered a device" is the actual answer to "why did they not
   *   get told", and it is not the same answer as "Expo rejected it".
   */
  if (tokens.length === 0) {
    await record(row, 'no registered devices');
    return json({ ok: false, status: 'no-devices' });
  }

  let sent = 0;
  let failed = 0;
  const errors = new Set<string>();

  for (const batch of chunk(tokens)) {
    const outcome = await sendBatch(batch.map((token) => buildMessage(token, row)));
    sent += outcome.sent;
    failed += outcome.failed;
    if (outcome.error) errors.add(outcome.error);

    /*
     * Drop what Expo says is gone.
     *
     * A token for an uninstalled app never becomes valid again, and keeping it
     * makes "we notified them" true in the record and false in the world.
     */
    for (const dead of outcome.deadTokens) {
      await rpc('forget_push_token', { dead_token: dead });
    }
  }

  /*
   * ⚠ One device accepting is a success.
   *
   *   A driver with a dead tablet and a live phone was reached. Recording that
   *   as a failure would put the row back in the retry queue and push the phone
   *   again on the next sweep.
   */
  const delivered = sent > 0;
  await record(row, delivered ? null : ([...errors].join(', ') || 'Expo accepted no messages'));

  // Counts only. Tokens are credentials and never appear in a response or a log.
  return json({ ok: delivered, sent, failed });
});
