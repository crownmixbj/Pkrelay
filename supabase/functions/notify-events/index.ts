/**
 * Sends one queued email, and records what happened to it.
 *
 * Called by the `on_email_queued` trigger in `20250101000038_transactional_email.sql`, once
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
 *   The outbox is the record of what Package Relay told somebody. "Did the driver get
 *   the rejection?" is a question that gets asked months later, and a queue
 *   that empties itself cannot answer it.
 *
 * ⚠ Every exit records something. That is this file's rule, and it did not
 *   used to be.
 *
 *   Three paths returned with the row untouched — a rejected Authorization
 *   header, an unparseable body, and a row the REST read did not return — so
 *   `sent_at` stayed null, `error` stayed null, and the only evidence that
 *   anything had happened at all was `attempts` ticking up. From the database
 *   side that is indistinguishable from the function never having been called.
 *
 *   Below, once the outbox id is known, no path returns without either setting
 *   `sent_at` or writing a sentence into `error`. The paths that run before the
 *   id is known cannot write to a row, so they log instead — loudly, with a
 *   request id, because a function that refuses a request and says nothing is
 *   how an afternoon disappears.
 *
 * Deploy:
 *   supabase functions deploy notify-events
 *   supabase secrets set RESEND_API_KEY="re_..."
 *   supabase secrets set LOCI_FROM_EMAIL="…"   # optional; defaults to DEFAULT_FROM
 *   supabase secrets set LOCI_APP_URL="https://app.yourdomain.com"
 *   supabase secrets set LOCI_SUPPORT_EMAIL="support@yourdomain.com"
 */

import { json, preflight } from '../_shared/cors.ts';
import { absoluteUrl, DEFAULT_FROM, sendEmail } from '../_shared/email.ts';
import { render } from './templates.ts';
import { isServiceRole, logger } from '../_shared/service-role.ts';

const env = (key: string) => Deno.env.get(key) ?? null;

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_KEY = env('RESEND_API_KEY') ?? '';
/* `LOCI_FROM_EMAIL` overrides it; a whitespace-only secret does not. */
const FROM = (env('LOCI_FROM_EMAIL') ?? '').trim() || DEFAULT_FROM;
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

type ReadResult =
  | { ok: true; row: OutboxRow }
  | { ok: false; reason: 'absent' }
  | { ok: false; reason: 'unreadable'; detail: string };

/**
 * Reads the row this request is about.
 *
 * ⚠ "The read failed" and "there is no such row" are different answers, and
 *   this used to give the same one to both.
 *
 *   It was `if (!response.ok) return null`, and the caller turned null into a
 *   404 "No such email". So a REST call refused for a bad key, a paused
 *   project, or a schema-cache miss was reported to the database as *the row
 *   does not exist* — a sentence that sends whoever reads it looking in the
 *   wrong place entirely. They are separated here because only one of them is
 *   worth retrying.
 */
async function readRow(id: string): Promise<ReadResult> {
  const url =
    `${SUPABASE_URL}/rest/v1/email_outbox` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=id,kind,recipient,payload,sent_at&limit=1`;

  let response: Response;
  try {
    response = await fetch(url, { headers: restHeaders });
  } catch (thrown) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: thrown instanceof Error ? thrown.message : 'fetch failed',
    };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return {
      ok: false,
      reason: 'unreadable',
      detail: `REST ${response.status}: ${detail.slice(0, 200)}`,
    };
  }

  const rows = (await response.json().catch(() => [])) as OutboxRow[];
  return rows[0] ? { ok: true, row: rows[0] } : { ok: false, reason: 'absent' };
}

/**
 * Writes the outcome back onto the row, and says whether that worked.
 *
 * ⚠ It used to ignore the response entirely.
 *
 *   `await fetch(...)` with no check on `response.ok`. If the PATCH was refused
 *   — a key without write access, a paused project, a schema-cache miss — the
 *   function returned `{ ok: true }`, the email had genuinely been sent, and
 *   `sent_at` stayed null. Which means `sweep_unsent_emails` picks the row up
 *   five minutes later and sends it again. And again. The guard against double
 *   sending is this column, so a write-back that fails silently is not a
 *   logging gap — it is a loop that mails somebody every five minutes until
 *   `attempts` hits three.
 *
 * Still never throws: by the time this runs the mail is gone, and turning a
 * delivered email into a 500 would make the caller retry a send that succeeded.
 */
type Log = (stage: string, detail?: Record<string, unknown>) => void;

async function recordOutcome(log: Log, id: string, error: string | null): Promise<boolean> {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/email_outbox?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { ...restHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          sent_at: error ? null : new Date().toISOString(),
          error,
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log('write-back-refused', {
        outbox: id,
        status: response.status,
        detail: detail.slice(0, 200),
        consequence: error ? 'the reason was lost' : 'THIS EMAIL WILL BE SENT AGAIN BY THE SWEEP',
      });
      return false;
    }

    log('recorded', { outbox: id, sent: error === null });
    return true;
  } catch (thrown) {
    log('write-back-threw', {
      outbox: id,
      detail: thrown instanceof Error ? thrown.message : 'unknown',
    });
    return false;
  }
}

Deno.serve(async (request: Request) => {
  const options = preflight(request);
  if (options) return options;

  /* Short, random, and in every line below, so one request can be followed. */
  const requestId = crypto.randomUUID().slice(0, 8);
  const log = logger('notify-events', requestId);

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /*
   * ⚠ Only the service role. This endpoint sends mail from a signed domain.
   *
   *   Supabase already refuses an unauthenticated call, but the anon key is in
   *   the app bundle and would otherwise be enough to reach it.
   */
  const caller = isServiceRole(request.headers.get('Authorization') ?? '', SERVICE_KEY);
  if (!caller.ok) {
    /*
     * ⚠ Logged, because this exit cannot write to a row.
     *
     *   There is no trusted outbox id yet — the body is unauthenticated — so the
     *   database learns nothing from this path no matter what we do. `how` is
     *   the whole diagnosis: `jwt-role:anon` means something is calling with the
     *   publishable key; `key-mismatch` means the key in `private.app_settings`
     *   is not this deployment's service key, which is the single likeliest
     *   reason a swept row never moves.
     */
    log('refused', { why: caller.how });
    return json({ error: 'Forbidden', why: caller.how }, 403);
  }

  /*
   * ⚠ Parsed defensively and logged before anything is trusted.
   *
   *   pg_net posts `{"outbox_id": "<uuid>"}`. A body that is empty, not JSON, or
   *   shaped differently is a caller bug worth seeing rather than a silent 400 —
   *   and the raw text is safe to log here precisely because this is the shape
   *   that is *not* what we expect.
   */
  let outboxId = '';
  const raw = await request.text();
  try {
    const body = JSON.parse(raw || '{}') as { outbox_id?: unknown };
    outboxId = typeof body.outbox_id === 'string' ? body.outbox_id.trim() : '';
  } catch {
    log('unparseable-body', { bytes: raw.length, head: raw.slice(0, 120) });
    return json({ error: 'Bad request' }, 400);
  }

  if (!outboxId) {
    log('no-outbox-id', { keys: Object.keys(JSON.parse(raw || '{}') ?? {}) });
    return json({ error: 'outbox_id is required' }, 400);
  }

  log('received', { outbox: outboxId, auth: caller.how });

  const read = await readRow(outboxId);

  if (!read.ok && read.reason === 'absent') {
    log('no-such-row', { outbox: outboxId });
    return json({ error: 'No such email' }, 404);
  }

  if (!read.ok) {
    /*
     * The row may well exist; we could not read it. Recording is attempted
     * anyway — if the failure is transport, the write may still land, and if it
     * is credentials, the log line above is the answer.
     */
    log('unreadable-row', { outbox: outboxId, detail: read.detail });
    await recordOutcome(log, outboxId, `Could not read the row: ${read.detail}`);
    return json({ ok: false, error: 'Could not read the outbox row' }, 503);
  }

  const row = read.row;

  /*
   * ⚠ The second half of exactly-once.
   *
   *   The unique key stops a second row being queued. This stops a second
   *   *send* of the same row — a retried pg_net call, or somebody replaying a
   *   request. Both halves are needed: neither is sufficient alone.
   */
  if (row.sent_at) {
    log('already-sent', { outbox: outboxId, kind: row.kind });
    return json({ ok: true, skipped: 'already sent' });
  }

  if (!RESEND_KEY) {
    /*
     * Not configured is recorded rather than thrown, so the row shows why it is
     * sitting there instead of looking like a provider outage.
     *
     * Only the key can be missing now: the sender falls back to `DEFAULT_FROM`,
     * so an unset `LOCI_FROM_EMAIL` is no longer a reason not to send.
     */
    const why = 'RESEND_API_KEY is not set';
    log('unconfigured', { outbox: outboxId, why });
    await recordOutcome(log, outboxId, why);
    return json({ ok: false, configured: false, why });
  }

  /*
   * ⚠ An email whose whole purpose is a link is not sent without one.
   *
   *   `LOCI_APP_URL` was once set to `.https://staging.pkrelay.com`, and the
   *   guarantor invitation went out carrying a URL that resolved to nothing. The
   *   URL is repaired now where it can be, and refused where it cannot — but a
   *   refused URL means `render` produces an invitation with no button and no
   *   address, and posting that to a stranger is worse than posting nothing: it
   *   uses up the one email they will read, and there is no second one.
   *
   *   So it is recorded and held. The row keeps the token, the sweep will send
   *   it the moment the setting is fixed, and `error` names the setting and the
   *   value it was given.
   */
  const LINK_IS_THE_EMAIL = ['guarantor_invitation'];

  if (LINK_IS_THE_EMAIL.includes(row.kind) && !absoluteUrl(APP_URL)) {
    const why =
      `LOCI_APP_URL is not a usable absolute URL (${JSON.stringify(APP_URL)}), ` +
      `and a ${row.kind} without a link is not worth sending`;
    log('unusable-app-url', { outbox: outboxId, kind: row.kind, appUrl: APP_URL });
    await recordOutcome(log, outboxId, why);
    return json({ ok: false, error: 'LOCI_APP_URL is not usable' }, 503);
  }

  /*
   * ⚠ Rendering is wrapped, because a template is code.
   *
   *   `render` reads a payload assembled by a database trigger months earlier.
   *   A field that is null where the template expects a string throws, and an
   *   uncaught throw here is a 500 with the row untouched — the same invisible
   *   failure this file exists to stop.
   */
  let rendered: ReturnType<typeof render>;
  try {
    rendered = render(row.kind, row.payload ?? {}, {
      appUrl: APP_URL,
      supportEmail: SUPPORT_EMAIL,
    });
  } catch (thrown) {
    const detail = thrown instanceof Error ? thrown.message : 'render failed';
    log('render-threw', { outbox: outboxId, kind: row.kind, detail });
    await recordOutcome(log, outboxId, `Template "${row.kind}" failed: ${detail}`);
    return json({ ok: false, error: 'Template failed' }, 500);
  }

  if (!rendered) {
    log('no-template', { outbox: outboxId, kind: row.kind });
    await recordOutcome(log, outboxId, `No template for kind "${row.kind}"`);
    return json({ ok: false, error: 'Unknown kind' }, 422);
  }

  log('sending', { outbox: outboxId, kind: row.kind });

  const result = await sendEmail({
    apiKey: RESEND_KEY,
    from: FROM,
    to: row.recipient,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: SUPPORT_EMAIL,
    env: {
      LOCI_ENVIRONMENT: env('LOCI_ENVIRONMENT') ?? undefined,
      LOCI_STAGING_EMAIL: env('LOCI_STAGING_EMAIL') ?? undefined,
    },
  });

  if (!result.ok) {
    log('send-failed', { outbox: outboxId, kind: row.kind, detail: result.error });
    await recordOutcome(log, outboxId, result.error);
    return json({ ok: false, error: result.error }, 502);
  }

  const recorded = await recordOutcome(log, outboxId, null);

  /*
   * ⚠ A sent email whose row did not update is not a success, and must not be
   *   reported as one.
   *
   *   The row is the only thing stopping the sweeper sending it again, so this
   *   answers 500 — which is visibly wrong in the logs — rather than `ok: true`,
   *   which is invisibly wrong in somebody's inbox every five minutes.
   */
  if (!recorded) {
    return json(
      { ok: false, sent: true, recorded: false, error: 'sent but could not mark the row' },
      500,
    );
  }

  log('done', { outbox: outboxId, kind: row.kind });
  return json({ ok: true, id: result.id });
});
