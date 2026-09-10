/**
 * The confirmation email an applicant receives the moment they submit.
 *
 * Kept apart from `index.ts` so the template can be rendered and asserted on
 * without a network, an API key, or a Deno runtime — see
 * `scripts/verify-application-email.ts`.
 */

export type ApplicationEmailInput = {
  fullName: string;
  reference: string;
  email: string;
  vehicleType?: string | null;
  baseCity?: string | null;
  state?: string | null;
  /** Where the applicant can watch the status. Omitted when not configured. */
  appUrl?: string | null;
  supportEmail?: string | null;
  reviewWorkingDays: number;
};

/**
 * Escapes text going into the HTML part.
 *
 * Every value below is applicant-entered. A name containing `<` would break the
 * layout at best; an address field is a place someone can put a `<script>` tag,
 * and some mail clients will run it.
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
 * The subject and the display name end up in SMTP headers. A newline in an
 * applicant-supplied value is a header-injection hole — it lets someone append
 * their own `Bcc:` to an email your domain is sending and signing.
 */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** First word of a name, for the greeting. Falls back to something neutral. */
export function firstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? '';
  return first.length > 0 ? first : 'there';
}

export function subjectFor(input: ApplicationEmailInput): string {
  // The reference belongs in the subject: it is what the applicant quotes back
  // when they ask about progress, and it makes the thread searchable later.
  return headerSafe(`Package Relay driver application received — ${input.reference}`);
}

/**
 * The plain-text part.
 *
 * Not a courtesy. A multipart email without a text part is scored as spam by
 * most filters, and a Nigerian applicant on a data-saving client may never be
 * shown the HTML at all.
 */
export function textBody(input: ApplicationEmailInput): string {
  const where = input.baseCity ?? input.state ?? null;

  const lines = [
    `Hi ${firstName(input.fullName)},`,
    '',
    'We have your driver application. Nothing else is needed from you right now.',
    '',
    `Reference: ${input.reference}`,
  ];

  if (input.vehicleType) lines.push(`Vehicle: ${input.vehicleType}`);
  if (where) lines.push(`Operating in: ${where}`);

  lines.push(
    '',
    'What happens next',
    `1. Our compliance team verifies your documents. This takes up to ${input.reviewWorkingDays} working days.`,
    '2. We may call you to confirm a detail, so keep your phone reachable.',
    '3. Have your vehicle ready for a final inspection.',
    '',
    'We will email you as soon as a decision is made.',
  );

  if (input.appUrl) {
    lines.push('', `Track your application: ${input.appUrl}/driver-signup`);
  }

  if (input.supportEmail) {
    lines.push('', `Questions? Reply to this email or write to ${input.supportEmail}.`);
  }

  lines.push(
    '',
    'Package Relay',
    '',
    `You are receiving this because a driver application was submitted with this address (${input.email}). If that was not you, reply and tell us — we will remove it.`,
  );

  return lines.join('\n');
}

const ROW = (label: string, value: string) => `
      <tr>
        <td style="padding:6px 0;color:#64748B;font-size:14px;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#0F172A;font-size:14px;font-weight:600;text-align:right;">${escapeHtml(
          value,
        )}</td>
      </tr>`;

/**
 * The HTML part.
 *
 * Tables and inline styles, deliberately. Outlook renders with Word's engine —
 * no flexbox, no grid, and `<style>` blocks are stripped by several clients
 * including Gmail's web app in some configurations. This looks like 2005 markup
 * because email is still 2005.
 */
export function htmlBody(input: ApplicationEmailInput): string {
  const where = input.baseCity ?? input.state ?? null;

  const rows = [
    ROW('Reference', input.reference),
    input.vehicleType ? ROW('Vehicle', input.vehicleType) : '',
    where ? ROW('Operating in', where) : '',
  ].join('');

  const track = input.appUrl
    ? `
      <tr><td style="padding-top:24px;">
        <a href="${escapeHtml(input.appUrl)}/driver-signup"
           style="display:inline-block;background:#0077B6;color:#FFFFFF;text-decoration:none;
                  font-size:15px;font-weight:600;padding:12px 22px;border-radius:10px;">
          Track your application
        </a>
      </td></tr>`
    : '';

  const support = input.supportEmail
    ? `Questions? Reply to this email, or write to
       <a href="mailto:${escapeHtml(input.supportEmail)}" style="color:#0077B6;">${escapeHtml(
         input.supportEmail,
       )}</a>.`
    : 'Questions? Just reply to this email.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(subjectFor(input))}</title>
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
  <!-- Read aloud by screen readers, hidden in the client, shown in the inbox preview line. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    Reference ${escapeHtml(input.reference)} — we will review within ${
      input.reviewWorkingDays
    } working days.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#F1F5F9;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#FFFFFF;border-radius:16px;
                    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="padding:28px 28px 0;">
          <div style="font-size:24px;font-weight:800;letter-spacing:1px;color:#0077B6;">PKRELAY</div>
        </td></tr>

        <tr><td style="padding:20px 28px 0;">
          <h1 style="margin:0;font-size:22px;line-height:1.3;color:#0F172A;">
            Application received
          </h1>
          <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#334155;">
            Hi ${escapeHtml(firstName(input.fullName))}, thank you for applying to drive with Package Relay.
            Nothing else is needed from you right now.
          </p>
        </td></tr>

        <tr><td style="padding:20px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="background:#F8FAFC;border-radius:12px;padding:14px 16px;">
            ${rows}
          </table>
        </td></tr>

        <tr><td style="padding:24px 28px 0;">
          <div style="font-size:12px;font-weight:700;letter-spacing:.8px;color:#64748B;">
            WHAT HAPPENS NEXT
          </div>
          <ol style="margin:12px 0 0;padding-left:20px;font-size:15px;line-height:1.7;color:#334155;">
            <li>Our compliance team verifies your documents — up to ${
              input.reviewWorkingDays
            } working days.</li>
            <li>We may call to confirm a detail, so keep your phone reachable.</li>
            <li>Have your vehicle ready for a final inspection.</li>
          </ol>
          <p style="margin:14px 0 0;font-size:15px;line-height:1.6;color:#334155;">
            We will email you as soon as a decision is made.
          </p>
        </td></tr>

        ${track ? `<tr><td style="padding:0 28px;"><table role="presentation">${track}</table></td></tr>` : ''}

        <tr><td style="padding:24px 28px 28px;">
          <p style="margin:0;font-size:13px;line-height:1.6;color:#64748B;">${support}</p>
          <p style="margin:14px 0 0;font-size:12px;line-height:1.6;color:#94A3B8;">
            You are receiving this because a driver application was submitted with
            ${escapeHtml(input.email)}. If that was not you, reply and tell us — we will remove it.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function renderApplicationEmail(input: ApplicationEmailInput) {
  return {
    subject: subjectFor(input),
    text: textBody(input),
    html: htmlBody(input),
  };
}
