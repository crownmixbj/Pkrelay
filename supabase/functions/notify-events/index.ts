/**
 * Sends one queued email, and records what happened to it.
 *
 * Called by the `on_email_queued` trigger in `38_transactional_email.sql`, once
 * per row, with nothing but an outbox id.
 *
 * ⚠ The id, not the content.
 *
 *   A trigger that posted the rendered email would put a recipient address and
 *   somebody's parcel details into a pg_net request body and its logs. It would
 *   also mean an endpoint that emails whatever it is handed — and this endpoint
 *   is reachable by anything holding the service key. Passing an id means the
 *   function reads the row itself, and can only ever send mail the database
 *   decided to send.
 *
 * ⚠ It marks the row before deciding it succeeded, and never deletes it.
 *
 *   The outbox is the record of what LOCI told somebody. "Did the driver get
 *   the rejection?" is a question that gets asked months later, and a queue
 *   that empties itself cannot answer it.
 *
 * Deploy:
 *   supabase functions deploy notify-events
 *   supabase secrets set RESEND_API_KEY="re_..."
 *   supabase secrets set LOCI_FROM_EMAIL="LOCI <noreply@yourdomain.com>"
 *   supabase secrets set LOCI_APP_URL="https://app.yourdomain.com"
 *   supabase secrets set LOCI_SUPPORT_EMAIL="support@yourdomain.com"
 */

import { json, preflight } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/email.ts';
import { render } from './templates.ts';

const env = (key: string) => Deno.env.get(key) ?? null;

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_KEY = env('RESEND_API_KEY') ?? '';
const FROM = env('LOCI_FROM_EMAIL') ?? '';
const APP_URL = env('LOCI_APP_URL');
const SUPPORT_EMAIL = env('LOCI_SUPPORT_EMAIL');

const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

type OutboxRow = {
  id: string;
  kind: string;
  recipient: string;
  payload: Record<string, unknown>;
  sent_at: string | null;
};

async function readRow(id: string): Promise<OutboxRow | null> {
  const url =
    `${SUPABASE_URL}/rest/v1/email_outbox` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=id,kind,recipient,payload,sent_at&limit=1`;

  const response = await fetch(url, { headers: restHeaders });
  if (!response.ok) return null;

  const rows = (await response.json()) as OutboxRow[];
  return rows[0] ?? null;
}

async function recordOutcome(id: string, error: string | null): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/email_outbox?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...restHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        sent_at: error ? null : new Date().toISOString(),
        error,
      }),
    });
  } catch (thrown) {
    // Logged, not thrown: the email may well have gone out, and failing here
    // would make a delivered email look like a failure.
    console.error('Could not record email outcome', thrown);
  }
}

Deno.serve(async (request: Request) => {
  const options = preflight(request);
  if (options) return options;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /*
   * ⚠ Only the service role. This endpoint sends mail from a signed domain.
   *
   *   Supabase already refuses an unauthenticated call, but the anon key is in
   *   the app bundle and would otherwise be enough to reach it.
   */
  const auth = request.headers.get('Authorization') ?? '';
  if (!SERVICE_KEY || auth !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: 'Forbidden' }, 403);
  }

  let outboxId = '';
  try {
    const body = (await request.json()) as { outbox_id?: string };
    outboxId = typeof body.outbox_id === 'string' ? body.outbox_id : '';
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  if (!outboxId) return json({ error: 'outbox_id is required' }, 400);

  const row = await readRow(outboxId);
  if (!row) return json({ error: 'No such email' }, 404);

  /*
   * ⚠ The second half of exactly-once.
   *
   *   The unique key stops a second row being queued. This stops a second
   *   *send* of the same row — a retried pg_net call, or somebody replaying a
   *   request. Both halves are needed: neither is sufficient alone.
   */
  if (row.sent_at) return json({ ok: true, skipped: 'already sent' });

  if (!RESEND_KEY || !FROM) {
    /*
     * Not configured is recorded rather than thrown, so the row shows why it is
     * sitting there instead of looking like a provider outage.
     */
    await recordOutcome(outboxId, 'RESEND_API_KEY or LOCI_FROM_EMAIL is not set');
    return json({ ok: false, configured: false });
  }

  const rendered = render(row.kind, row.payload ?? {}, {
    appUrl: APP_URL,
    supportEmail: SUPPORT_EMAIL,
  });

  if (!rendered) {
    await recordOutcome(outboxId, `No template for kind "${row.kind}"`);
    return json({ ok: false, error: 'Unknown kind' }, 422);
  }

  const result = await sendEmail({
    apiKey: RESEND_KEY,
    from: FROM,
    to: row.recipient,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: SUPPORT_EMAIL,
  });

  await recordOutcome(outboxId, result.ok ? null : result.error);

  return result.ok
    ? json({ ok: true, id: result.id })
    : json({ ok: false, error: result.error }, 502);
});
