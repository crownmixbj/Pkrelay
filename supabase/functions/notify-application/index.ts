/**
 * Fires the moment a driver application is inserted, and does two independent
 * things:
 *
 *   1. Emails the applicant a confirmation. This is the one the *applicant*
 *      notices — the app tells them to check their inbox, so something has to
 *      actually arrive.
 *   2. Posts a Slack alert so someone knows there is a queue to work.
 *
 * They are independent on purpose. A dead Slack webhook must not stop an
 * applicant's confirmation, and a missing email provider must not silence ops.
 *
 * Deployed to Supabase Edge Functions (Deno):
 *
 *   supabase functions deploy notify-application
 *   supabase secrets set RESEND_API_KEY="re_..."
 *   supabase secrets set LOCI_FROM_EMAIL="Package Relay <noreply@yourdomain.com>"
 *
 * Called by the `on_driver_application_created` trigger in
 * `20250101000005_storage_and_alerts.sql`.
 */

import { resolveRecipient, slackEnabled } from '../_shared/environment.ts';

import { renderApplicationEmail, headerSafe } from './email.ts';

type ApplicationPayload = {
  reference?: string;
  full_name?: string;
  phone?: string;
  email?: string;
  state?: string;
  base_city?: string | null;
  vehicle_type?: string;
  submitted_at?: string;
};

/** Matches `REVIEW_WORKING_DAYS` in `src/store/driver-applications.ts`. */
const REVIEW_WORKING_DAYS = 7;

const env = (key: string) => Deno.env.get(key) ?? null;

// ------------------------------------------------------------ write-back ----

/**
 * PostgREST directly rather than `@supabase/supabase-js`.
 *
 * Two calls against one table do not justify pulling a client library into a
 * cold-started edge function, and the raw call makes it obvious that this runs
 * as the service role — which bypasses every RLS policy in the project.
 */
function restUrl(reference: string, select?: string): string | null {
  const base = env('SUPABASE_URL');
  if (!base) return null;

  const url = new URL(`${base}/rest/v1/driver_applications`);
  url.searchParams.set('reference', `eq.${reference}`);
  if (select) url.searchParams.set('select', select);
  return url.toString();
}

function serviceHeaders(): Record<string, string> | null {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) return null;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Whether this application has already been emailed.
 *
 * pg_net does not retry, so in normal running this is always false. It matters
 * when someone replays a payload by hand to debug — sending a second "we have
 * your application" a week later reads as a system that lost the first one.
 */
async function alreadyEmailed(reference: string): Promise<boolean> {
  const url = restUrl(reference, 'confirmation_email_sent_at');
  const headers = serviceHeaders();
  if (!url || !headers) return false;

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return false;

    const rows = (await response.json()) as { confirmation_email_sent_at: string | null }[];
    return Boolean(rows[0]?.confirmation_email_sent_at);
  } catch {
    // Unreachable database: send anyway. A duplicate confirmation is a far
    // smaller failure than a missing one.
    return false;
  }
}

/**
 * Records the outcome on the application row.
 *
 * A failure that leaves no trace is a failure nobody fixes: the applicant is
 * told to check an inbox that will stay empty, and the reviewer has no idea.
 * Writing the error where the admin dashboard can read it makes it visible.
 */
async function recordEmailOutcome(reference: string, error: string | null): Promise<void> {
  const url = restUrl(reference);
  const headers = serviceHeaders();
  if (!url || !headers) return;

  try {
    await fetch(url, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        confirmation_email_sent_at: error ? null : new Date().toISOString(),
        confirmation_email_error: error,
      }),
    });
  } catch (thrown) {
    console.error('Could not record email outcome', thrown);
  }
}

// ----------------------------------------------------------------- email ----

type Outcome = { ok: true } | { ok: false; error: string } | { skipped: string };

/**
 * Sends the applicant confirmation through Resend.
 *
 * Supabase's built-in mailer cannot be used for this: it only sends the auth
 * templates (confirmation, recovery, magic link) and is rate-limited to a
 * couple of messages an hour on the free tier. A transactional provider is not
 * optional here.
 *
 * Swapping to SendGrid or Postmark means changing this one function — the
 * template and the orchestration below do not know which provider is in use.
 */
async function sendApplicantEmail(payload: ApplicationPayload): Promise<Outcome> {
  const apiKey = env('RESEND_API_KEY');
  const from = env('LOCI_FROM_EMAIL');

  if (!apiKey || !from) {
    console.warn('RESEND_API_KEY or LOCI_FROM_EMAIL not set — confirmation email skipped.');
    return { skipped: 'no email provider configured' };
  }

  const to = payload.email?.trim();
  if (!to) return { ok: false, error: 'application has no email address' };

  /*
   * ⚠ Staging must not confirm anything to a real applicant.
   *
   *   This is the one email in the system sent to somebody who did not ask for
   *   a test — a driver who filled in the real form. On staging it goes to the
   *   test inbox instead, and if no test inbox is configured it goes nowhere.
   */
  const destination = resolveRecipient(to, {
    LOCI_ENVIRONMENT: env('LOCI_ENVIRONMENT') ?? undefined,
    LOCI_STAGING_EMAIL: env('LOCI_STAGING_EMAIL') ?? undefined,
  });
  if (!destination) {
    console.warn('staging has no LOCI_STAGING_EMAIL — confirmation email skipped.');
    return { skipped: 'staging has no test inbox configured' };
  }

  const { subject, text, html } = renderApplicationEmail({
    fullName: payload.full_name ?? '',
    reference: payload.reference ?? '',
    email: to,
    vehicleType: payload.vehicle_type ?? null,
    baseCity: payload.base_city ?? null,
    state: payload.state ?? null,
    appUrl: env('LOCI_APP_URL'),
    supportEmail: env('LOCI_SUPPORT_EMAIL'),
    reviewWorkingDays: REVIEW_WORKING_DAYS,
  });

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: headerSafe(from),
        to: [headerSafe(destination.to)],
        subject: headerSafe(`${destination.subjectPrefix}${subject}`),
        text,
        html,
        /*
         * Replies go to a human. A confirmation the applicant cannot answer is
         * where "I sent the wrong account number" turns into a support ticket
         * nobody ever files.
         */
        reply_to: env('LOCI_SUPPORT_EMAIL') ?? undefined,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Resend rejected the message', response.status, detail);
      return { ok: false, error: `provider ${response.status}: ${detail.slice(0, 300)}` };
    }

    return { ok: true };
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error('Could not reach the email provider', message);
    return { ok: false, error: message };
  }
}

// ----------------------------------------------------------------- slack ----

/**
 * Slack renders mrkdwn, so a name containing `<` or `&` can break the layout or
 * inject a fake link. Escaping is Slack's documented requirement, not optional.
 */
function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const field = (label: string, value: string | null | undefined) => ({
  type: 'mrkdwn',
  text: `*${label}*\n${value ? escapeSlack(String(value)) : '—'}`,
});

async function postSlackAlert(payload: ApplicationPayload): Promise<Outcome> {
  const webhook = env('SLACK_WEBHOOK_URL');

  /*
   * ⚠ Slack is skipped on staging even when a webhook is set.
   *
   *   An ops channel carrying test alerts is a channel people learn to scroll
   *   past, and the cost of that is the real alert three weeks later that
   *   nobody opens. Checking the environment rather than only the webhook also
   *   means a webhook copied into the staging project by accident stays inert.
   */
  if (!slackEnabled(webhook, { LOCI_ENVIRONMENT: env('LOCI_ENVIRONMENT') ?? undefined })) {
    console.warn('Slack alert skipped — staging, or no webhook configured.');
    return { skipped: 'slack disabled for this environment' };
  }

  /* Narrowed by slackEnabled above, which returns false on an empty webhook. */
  const endpoint = webhook as string;

  const dashboardUrl = env('LOCI_APP_URL');

  const message = {
    text: `New driver application: ${payload.full_name ?? 'Unknown'} (${payload.reference ?? '—'})`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🚚 New driver application', emoji: true },
      },
      {
        type: 'section',
        fields: [
          field('Applicant', payload.full_name),
          field('Reference', payload.reference),
          field('Phone', payload.phone),
          field('Email', payload.email),
          field('Operating in', payload.base_city ?? payload.state),
          field('Vehicle', payload.vehicle_type),
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            /*
             * States the promise in the alert itself, so whoever sees it knows
             * the clock is running rather than treating it as FYI.
             */
            text: dashboardUrl
              ? `Review within ${REVIEW_WORKING_DAYS} working days — <${dashboardUrl}/admin|open the dashboard>`
              : `Review within ${REVIEW_WORKING_DAYS} working days — open the Applications tab in Package Relay`,
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Slack rejected the message', response.status, detail);
      return { ok: false, error: `slack ${response.status}` };
    }

    return { ok: true };
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return { ok: false, error: message };
  }
}

// ------------------------------------------------------------ entry point ----

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let payload: ApplicationPayload;
  try {
    payload = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const reference = payload.reference?.trim() ?? '';

  const emailTask = async (): Promise<Outcome> => {
    if (reference && (await alreadyEmailed(reference))) {
      return { skipped: 'already sent' };
    }

    const outcome = await sendApplicantEmail(payload);

    // Only record a real attempt. "Not configured" is a deployment state, not
    // a delivery failure, and writing it as one would make the dashboard show
    // every application as broken before the provider is ever set up.
    if (reference && 'ok' in outcome) {
      await recordEmailOutcome(reference, outcome.ok ? null : outcome.error);
    }

    return outcome;
  };

  /*
   * `allSettled`, not `all`. With `all`, a Slack outage would abort the
   * applicant's confirmation mid-flight — the exact coupling this function is
   * arranged to avoid.
   */
  const [email, slack] = await Promise.allSettled([emailTask(), postSlackAlert(payload)]);

  const unwrap = (result: PromiseSettledResult<Outcome>): Outcome =>
    result.status === 'fulfilled' ? result.value : { ok: false, error: String(result.reason) };

  const body = { email: unwrap(email), slack: unwrap(slack) };

  /*
   * Always 200. The caller is a database trigger with nobody to read a status
   * code; the detail above lands in the function logs, and the applicant's
   * failure is additionally written to their row where an admin will see it.
   */
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
