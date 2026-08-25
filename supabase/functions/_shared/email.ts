/**
 * Sending mail through Resend, and the two escapes every template needs.
 *
 * ⚠ Extracted from `notify-application/email.ts`, which had all of this for one
 *   email. There are eight now, and escaping that lives in one of nine files is
 *   escaping that is missing from eight of them.
 */

/**
 * Escapes text going into the HTML part.
 *
 * ⚠ Every value in these templates is user-entered, and a mail client is a
 *   browser.
 *
 *   Names, addresses, cancellation reasons and item descriptions all reach a
 *   template. A `<` breaks the layout; a `<script>` or an `<img onerror=...>`
 *   in a cancellation reason is a stored payload that some clients will run,
 *   sent from a domain LOCI signs. The value is escaped at the point it is
 *   interpolated, never on the way into the database, because the database is
 *   not the thing being attacked.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strips anything that could start a new header line.
 *
 * ⚠ Subjects and display names become SMTP headers.
 *
 *   A newline in a user-supplied value lets somebody append their own `Bcc:` to
 *   an email your domain is sending and DKIM-signing. Every subject below goes
 *   through this, including the ones built from a tracking id — because a
 *   tracking id is generated, until the day somebody lets a customer choose one.
 */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** First word of a name, for the greeting. Falls back to something neutral. */
export function firstName(fullName: string | null | undefined): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  return first.length > 0 ? first : 'there';
}

/** Naira, formatted the way the app formats it. */
export function naira(amount: number | string | null | undefined): string {
  const value = typeof amount === 'string' ? Number(amount) : (amount ?? 0);
  if (!Number.isFinite(value)) return '₦0';
  return `₦${Math.round(value).toLocaleString('en-NG')}`;
}

/** A date somebody can read, in Lagos time. */
export function whenReadable(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  return at.toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const ROW = (label: string, value: string) => `
      <tr>
        <td style="padding:6px 0;color:#64748B;font-size:14px;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#0F172A;font-size:14px;font-weight:600;text-align:right;">${escapeHtml(
          value,
        )}</td>
      </tr>`;

/**
 * The shell every email shares.
 *
 * ⚠ Inline styles and a table, which looks like 2005 because mail clients are.
 *
 *   Outlook renders with Word's engine, Gmail strips `<style>` blocks, and
 *   flexbox is unusable in both. This is the layout that survives them.
 */
export function layout(options: {
  heading: string;
  intro: string;
  bodyHtml: string;
  cta?: { label: string; url: string } | null;
  footerNote: string;
}): string {
  const cta = options.cta
    ? `
      <tr><td style="padding-top:24px;">
        <a href="${escapeHtml(options.cta.url)}"
           style="display:inline-block;background:#0B5FFF;color:#FFFFFF;text-decoration:none;
                  padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600;">
          ${escapeHtml(options.cta.label)}
        </a>
      </td></tr>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#F1F5F9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:12px;">
      <tr><td style="padding:28px 28px 0;">
        <div style="color:#0B5FFF;font-size:20px;font-weight:800;letter-spacing:1.6px;">LOCI</div>
      </td></tr>
      <tr><td style="padding:20px 28px 0;">
        <h1 style="margin:0;color:#0F172A;font-size:20px;font-weight:700;">${escapeHtml(options.heading)}</h1>
        <p style="margin:12px 0 0;color:#334155;font-size:15px;line-height:22px;">${escapeHtml(options.intro)}</p>
      </td></tr>
      <tr><td style="padding:20px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${options.bodyHtml}
        </table>
      </td></tr>
      ${cta ? `<tr><td style="padding:0 28px;"><table role="presentation">${cta}</table></td></tr>` : ''}
      <tr><td style="padding:24px 28px 28px;">
        <p style="margin:0;color:#94A3B8;font-size:12px;line-height:18px;">${escapeHtml(options.footerNote)}</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

export type SendResult = { ok: true; id: string | null } | { ok: false; error: string };

/**
 * One email, through Resend.
 *
 * ⚠ Never throws. The caller is a trigger's downstream, and a thrown error
 *   there is a queued row that looks stuck rather than one that records why.
 */
export async function sendEmail(input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
}): Promise<SendResult> {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: headerSafe(input.subject),
        html: input.html,
        /*
         * ⚠ The text part is not a courtesy.
         *
         *   A multipart email without one is scored as spam by most filters,
         *   and a Nigerian recipient on a data-saving client may never be shown
         *   the HTML at all.
         */
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return { ok: false, error: `Resend ${response.status}: ${detail.slice(0, 300)}` };
    }

    const payload = (await response.json()) as { id?: string };
    return { ok: true, id: payload.id ?? null };
  } catch (thrown) {
    return { ok: false, error: thrown instanceof Error ? thrown.message : 'Send failed' };
  }
}
