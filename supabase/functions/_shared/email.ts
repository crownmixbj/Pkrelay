/**
 * Sending mail through Resend, and the two escapes every template needs.
 *
 * ⚠ Extracted from `notify-application/email.ts`, which had all of this for one
 *   email. There are eight now, and escaping that lives in one of nine files is
 *   escaping that is missing from eight of them.
 */

import { resolveRecipient, type EnvRecord } from './environment.ts';

/**
 * Escapes text going into the HTML part.
 *
 * ⚠ Every value in these templates is user-entered, and a mail client is a
 *   browser.
 *
 *   Names, addresses, cancellation reasons and item descriptions all reach a
 *   template. A `<` breaks the layout; a `<script>` or an `<img onerror=...>`
 *   in a cancellation reason is a stored payload that some clients will run,
 *   sent from a domain Package Relay signs. The value is escaped at the point it is
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
  /*
   * ⚠ The colour is on the cell and the anchor fills it, which is what makes
   *   the whole button clickable.
   *
   *   This was a bare `<a style="display:inline-block;background:…;padding:…">`.
   *   In a browser that is a perfectly good button. Outlook renders with Word,
   *   which ignores `display` and much of the padding on an inline element — so
   *   the blue box is painted by the surrounding cell and only the *text* inside
   *   it is the link. The result is a button where the middle works and the
   *   edges do nothing, which is exactly what it looks like: broken.
   *
   *   Background on the `<td>`, `display:block` on the `<a>`, and the padding
   *   moved onto the anchor so the padded area belongs to the link rather than
   *   to the cell. This is the standard bulletproof-button shape and it behaves
   *   the same in Gmail, Apple Mail and Outlook.
   *
   * ⚠ `target="_blank"` and `rel`, because some clients open in a frame, and
   *   `noopener` on a link handed to a stranger costs nothing.
   */
  const url = options.cta ? absoluteUrl(options.cta.url) : null;

  const cta = options.cta && url
    ? `
      <tr><td align="left" style="padding-top:24px;">
        <table class="pkr-button-table" role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center" bgcolor="#0B5FFF" style="background:#0B5FFF;border-radius:8px;">
              <a class="pkr-button" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:block;padding:15px 28px;min-height:20px;color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:600;line-height:20px;text-align:center;">${escapeHtml(
                options.cta.label,
              )}</a>
            </td>
          </tr>
        </table>
      </td></tr>
      ${
        /*
         * ⚠ The address in full, underneath.
         *
         *   Corporate clients strip styles and some strip anchors outright; a
         *   guarantor left with a button that will not open has nothing else to
         *   go on. A URL they can copy is the fallback that always works, and it
         *   is also how somebody checks where a link goes before pressing it —
         *   which is a reasonable instinct for an unexpected email asking for a
         *   national identifier.
         */ ''
      }
      <tr><td style="padding-top:12px;">
        <p style="margin:0;color:#64748B;font-size:12px;line-height:18px;word-break:break-all;">
          Or paste this into your browser:<br />
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"
             style="color:#0B5FFF;">${escapeHtml(url)}</a>
        </p>
      </td></tr>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <!--
      ⚠ There was no head at all, and this is the mobile Gmail report.

        The Gmail Android and iOS apps render a message in a webview. Without a
        viewport the webview lays the mail out at desktop width and scales the
        whole thing down to fit — so a 48px button becomes roughly 28px of
        actual screen, below the ~44px minimum a thumb reliably hits. It looks
        like a button, it is a real link, and tapping it misses. "Unclickable"
        is exactly how that is reported.

        Desktop clients ignore this tag, so it costs nothing anywhere else.
    -->
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- Stops iOS Mail shrinking the message to fit, which does the same thing. -->
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <style>
      /*
       * ⚠ Progressive enhancement only. Every rule here is already inlined
       *   above, because Gmail drops style blocks in several contexts — a
       *   clipped message, and any non-Gmail account added to the Gmail app.
       *   Nothing below is load-bearing; it makes an already-working button
       *   easier to hit.
       */
      @media only screen and (max-width: 480px) {
        .pkr-button-table { width: 100% !important; }
        .pkr-button {
          display: block !important;
          width: auto !important;
          padding: 17px 24px !important;
          font-size: 17px !important;
        }
      }
    </style>
  </head>
  <body style="margin:0;padding:24px;background:#F1F5F9;-webkit-text-size-adjust:100%;text-size-adjust:100%;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:12px;">
      <tr><td style="padding:28px 28px 0;">
        <div style="color:#0B5FFF;font-size:20px;font-weight:800;letter-spacing:1.6px;">PKRELAY</div>
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
      ${
        cta
          ? `<tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cta}</table></td></tr>`
          : ''
      }
      <tr><td style="padding:24px 28px 28px;">
        <p style="margin:0;color:#94A3B8;font-size:12px;line-height:18px;">${escapeHtml(options.footerNote)}</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

/**
 * Who Package Relay's mail comes from.
 *
 * ⚠ A constant with an override, rather than a secret that must be set.
 *
 *   This was `env('LOCI_FROM_EMAIL') ?? ''`, and an unset secret meant the
 *   function recorded "LOCI_FROM_EMAIL is not set" against the row and sent
 *   nothing — a deployment step standing between a queued email and a person,
 *   for a value that is not a secret and is the same on every deployment.
 *
 *   `LOCI_FROM_EMAIL` still wins where it is set, because staging uses it to
 *   send from an address that is obviously not production.
 *
 * ⚠ The display name follows the prose rule: `Package Relay`, not `PKRELAY`.
 *   A From line is the most-read user-facing string this system produces.
 *
 * ⚠ The domain has to be verified with Resend before anything sends from it.
 *   An unverified domain is a 403 from the provider, recorded against the row
 *   as `Resend 403: …`, which is the one failure this default cannot prevent.
 */
/**
 * An absolute URL for an email, or null when one cannot be built.
 *
 * ⚠ A mail client has no page to be relative to.
 *
 *   `href="app.pkrelay.com/guarantor/abc"` is a *relative* URL. A browser would
 *   resolve it against the current page; a mail client has no current page, so
 *   Gmail and Outlook variously render it as unlinked text, strip the anchor, or
 *   open a search. The button looks perfect and does nothing, which is the
 *   report that produced this function.
 *
 *   `LOCI_APP_URL` is typed by a person into `supabase secrets set`, so it
 *   arrives with a scheme, without one, with a trailing slash, or with a stray
 *   space. Every caller used to interpolate it raw.
 *
 * ⚠ Returns null rather than guessing, and the caller then omits the button.
 *
 *   A link that cannot be built is not a link. Rendering `href=""` gives
 *   somebody a button that silently fails; omitting it leaves the plain-text URL
 *   and the explanation, which at least can be acted on.
 */
/**
 * A hostname: dot-separated labels of letters, digits and hyphens.
 *
 * Deliberately stricter than what `new URL` accepts, because `new URL` is
 * parsing a URL and this is validating a setting somebody typed.
 */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function absoluteUrl(base: string | null | undefined, path = ''): string | null {
  const raw = (base ?? '').trim();
  if (!raw) return null;

  /* No scheme is the common typo, and https is the only sane assumption. */
  const hadScheme = /^https?:\/\//i.test(raw);
  const withScheme = hadScheme ? raw : `https://${raw}`;

  let origin: URL;
  try {
    origin = new URL(withScheme);
  } catch {
    return null;
  }

  /*
   * ⚠ A hostname, not merely a string containing a dot.
   *
   *   The first version of this checked `hostname.includes('.')`, which let
   *   through the exact value that prompted it. `LOCI_APP_URL` had been set to
   *   `.https://staging.pkrelay.com` — one stray leading dot, invisible in a
   *   dashboard field. Prefixing the guessed scheme gives
   *   `https://.https://staging…`, whose hostname is `.https` and whose path is
   *   `//staging.pkrelay.com`. It contains a dot, so it passed, and the email
   *   went out carrying `https://.https//staging.pkrelay.com/guarantor/<token>`
   *   — a link that resolves to nothing, in the one email whose entire purpose
   *   is the link.
   *
   *   So the hostname is matched properly: labels of letters, digits and
   *   hyphens, separated by single dots, none of them empty.
   */
  if (!HOSTNAME.test(origin.hostname)) return null;

  /*
   * ⚠ And a doubled slash in the path means the scheme was mangled.
   *
   *   `https//host` and `.https://host` both parse into something with `//`
   *   left in the path. No legitimate value for this setting has that, and it
   *   is the fingerprint of exactly the typo above.
   */
  if (origin.pathname.includes('//')) return null;

  /*
   * ⚠ The dotless-host rule applies only when the scheme was guessed.
   *
   *   Guessing turns any old string into something `new URL` accepts. Requiring
   *   a dot is what separates a hostname from a typo. But `http://localhost:8081`
   *   is a deliberate value somebody typed in full for a local build, and
   *   refusing it would drop the button on a deployment working exactly as
   *   intended. Written scheme, written host, believed.
   */
  if (!hadScheme && !origin.hostname.includes('.')) return null;

  /* One slash between the two halves, whichever way they were typed. */
  const left = `${origin.origin}${origin.pathname}`.replace(/\/+$/, '');
  const right = path ? `/${path.replace(/^\/+/, '')}` : '';
  return `${left}${right}`;
}

export const DEFAULT_FROM = 'Package Relay <noreply@app.pkrelay.com>';

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
  env: EnvRecord;
}): Promise<SendResult> {
  /*
   * ⚠ The staging redirect belongs here and nowhere else.
   *
   *   Eight templates reach this function and more will follow. A guard at any
   *   of the call sites is a guard the ninth template forgets, and the failure
   *   mode of forgetting is an email to a real person from a test database.
   *   One chokepoint, applied before the address is ever handed to Resend.
   */
  const destination = resolveRecipient(input.to, input.env);
  if (!destination) {
    return {
      ok: false,
      error: 'staging has no LOCI_STAGING_EMAIL set — refusing to send to a real address',
    };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: input.from,
        to: [destination.to],
        subject: headerSafe(`${destination.subjectPrefix}${input.subject}`),
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
