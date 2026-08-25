/**
 * Assertions for the transactional email templates.
 *
 * ⚠ An email is the one thing here that leaves the building.
 *
 *   Everything else in this app is behind a sign-in and a row-level policy. An
 *   email is forwarded, left open on a shared laptop, synced to somebody's
 *   cloud backup and indexed by their provider. What goes into one is a
 *   different decision from what goes onto a screen, and these assertions are
 *   mostly about what must *not*.
 *
 * ⚠ Rendered here rather than sent.
 *
 *   `templates.ts` is pure — no Deno, no network, no key — precisely so this
 *   file can render all nine and read the output. A template exercised only by
 *   sending real mail is a template nobody checks until a customer does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EMAIL_KINDS, render, type Context } from '../supabase/functions/notify-events/templates';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const CONTEXT: Context = {
  appUrl: 'https://app.loci.test',
  supportEmail: 'support@loci.test',
};

/*
 * ⚠ Hostile values in every field a person can type.
 *
 *   Names, cancellation reasons and review notes all reach a template, and a
 *   mail client is a browser. This payload is reused for every kind so that a
 *   template which forgets to escape one field fails somewhere.
 */
const XSS = '<script>alert(1)</script>';
const HOSTILE: Record<string, unknown> = {
  full_name: `${XSS} Ada`,
  reference: 'LOCI-123',
  base_city: XSS,
  reason: `${XSS} not enough documents`,
  tracking_id: 'LC-99',
  status: XSS,
  recipient_name: XSS,
  driver_name: XSS,
  route: XSS,
  fare: 5400,
  amount: 12500,
  account_hint: '1234',
  has_proof: true,
  cancelled_by: 'driver',
  delivered_at: '2026-08-20T10:30:00Z',
  cancelled_at: '2026-08-20T10:30:00Z',
  changed_at: '2026-08-20T10:30:00Z',
  verified_at: '2026-08-20T10:30:00Z',
  paid_at: '2026-08-20T10:30:00Z',
  expires_at: '2026-08-20T11:30:00Z',
};

// -------------------------------------------- every kind renders at all ----

for (const kind of EMAIL_KINDS) {
  const rendered = render(kind, HOSTILE, CONTEXT);
  check(`${kind} renders`, rendered !== null);
  if (!rendered) continue;

  check(`${kind} has a subject`, rendered.subject.trim().length > 0);
  /*
   * ⚠ A text part on every one.
   *
   *   A multipart email without one is scored as spam by most filters, and a
   *   recipient on a data-saving client may never be shown the HTML at all.
   */
  check(
    `${kind} has a text part`,
    rendered.text.trim().length > 40,
    'an HTML-only email is filtered as spam and unreadable on a data-saving client',
  );

  /*
   * ⚠ Header injection: the subject becomes an SMTP header.
   *
   *   A newline in a user-supplied value lets somebody append their own `Bcc:`
   *   to mail this domain signs.
   */
  check(
    `${kind}'s subject carries no newline`,
    !/[\r\n]/.test(rendered.subject),
    'a newline in a subject is a header-injection hole in a DKIM-signed domain',
  );

  /*
   * ⚠ The escaping assertion, stated as the absence of an executable tag.
   *
   *   `includes('&lt;script')` would pass on a template that escaped one field
   *   and interpolated another raw. Looking for the *unescaped* form is what
   *   actually catches a missed field.
   */
  check(
    `${kind} escapes hostile input`,
    !rendered.html.includes('<script>'),
    'a cancellation reason is a place somebody can put a payload, and some clients run it',
  );
  check(
    `${kind} escapes it everywhere, not only in the heading`,
    (rendered.html.match(/&lt;script&gt;/g) ?? []).length > 0 || !rendered.html.includes('script'),
    '',
  );
}

// --------------------------------------------- what must never be in one ----

/*
 * ⚠ The list, and why each is on it.
 *
 *   A NIN identifies a person to a government register. A full bank account
 *   number is enough to attempt a debit. A signed storage URL opens a private
 *   photo to whoever the email reaches. None of these is needed by any sentence
 *   in any of these emails.
 */
/*
 * ⚠ Comments stripped first.
 *
 *   The first version of the NIN check matched the sentence in this file's own
 *   header explaining that no NIN is included — an assertion satisfied by
 *   somebody describing the rule rather than following it. Third time this
 *   exact trap has bitten in this project.
 */
const stripComments = (source: string) =>
  source.replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, '');

const templatesSource = stripComments(read('supabase/functions/notify-events/templates.ts'));
const migration = read('supabase/38_transactional_email.sql');
const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

check(
  'no template reads a NIN',
  !/\bnin\b/i.test(templatesSource),
  'the field exists on the application row and would render happily',
);
check(
  'and no trigger puts one in a payload',
  !/'nin'|new\.nin/i.test(migrationCode),
  'the outbox is a table an admin can read and a payload that reaches a mail provider',
);
check(
  'no template reads a full account number',
  !templatesSource.includes('account_number'),
  'the payout payload carries only the last four digits, and the template must not reach past that',
);
check(
  'the payout trigger only sends the last four digits',
  migration.includes("right(coalesce(new.account_number, ''), 4)"),
  'enough to recognise the account, not enough to use it',
);
check(
  'no template builds a storage link',
  !/storage\/v1|createSignedUrl|sign\?token/.test(templatesSource),
  'a signed URL in an email is readable by anyone it is forwarded to, until it expires',
);

/*
 * ⚠ The proof-of-delivery photo, specifically.
 *
 *   This was the one asked for by name. It is behind the sender's sign-in, and
 *   the email says the photo exists and where to see it rather than carrying it.
 */
const delivered = render('delivery_completed', HOSTILE, CONTEXT);
check(
  'the delivery email links into the app rather than to the image',
  Boolean(delivered) && delivered!.html.includes('https://app.loci.test/parcel/'),
  '',
);
check(
  'and says the photo is behind a sign-in',
  Boolean(delivered) && /open the parcel/i.test(delivered!.text),
  'somebody expecting an attachment needs to be told where it actually is',
);

/*
 * ⚠ Never the word "receipt".
 *
 *   LOCI has no payment provider, no charge record and no paid state on a
 *   booking. A document headed "Receipt" is one somebody may hand to an
 *   accountant, an insurer or a court for money this system never witnessed.
 */
check(
  'the delivery email is a summary, not a receipt',
  Boolean(delivered) &&
    !/receipt/i.test(delivered!.subject) &&
    delivered!.text.includes('not a payment receipt'),
  'the fare is what was owed; nothing here saw it paid',
);
check(
  'and no template anywhere calls itself an invoice or a receipt',
  !/subject:.*(receipt|invoice)/i.test(templatesSource),
  '',
);

// ------------------------------------------------ absent data is handled ----

/*
 * ⚠ Rendered with nothing at all.
 *
 *   A trigger fires on a row where the optional columns are null — a rejection
 *   with no note, a booking with no driver. A template that assumed them prints
 *   "undefined" or "NaN" to a customer.
 */
for (const kind of EMAIL_KINDS) {
  const bare = render(kind, {}, { appUrl: null, supportEmail: null });
  check(`${kind} renders with an empty payload`, bare !== null);
  if (!bare) continue;

  for (const leak of ['undefined', 'NaN', 'null', '[object Object]']) {
    check(
      `${kind} prints no "${leak}"`,
      !bare.text.includes(leak) && !bare.html.includes(leak),
      'an optional column that was null reached the template unguarded',
    );
  }
}

/*
 * ⚠ And with no app URL, which is a real deployment state.
 *
 *   A call-to-action button whose href is "null/parcel/LC-99" is a broken link
 *   in an email that cannot be recalled.
 */
const noUrl = render('delivery_completed', HOSTILE, { appUrl: null, supportEmail: null });
check(
  'no call to action when there is nowhere to send them',
  Boolean(noUrl) && !noUrl!.html.includes('href="null'),
  'a dead link in an email cannot be fixed after it is sent',
);

// --------------------------------------- the kinds and the schema agree ----

/*
 * ⚠ Both lists, compared.
 *
 *   The migration's `check (kind in (...))` and this file's template map are
 *   two hand-written lists of the same thing. A kind in the database with no
 *   template queues an email that can never be sent; a template with no kind is
 *   dead code. Neither shows up until the event happens in production.
 */
const kindsInSql = [...migration.matchAll(/^\s*'([a-z_]+)',?$/gm)]
  .map((match) => match[1])
  .filter((value) => EMAIL_KINDS.includes(value as never) || value.includes('_'));

for (const kind of EMAIL_KINDS) {
  check(
    `the migration knows about "${kind}"`,
    migration.includes(`'${kind}'`),
    'a template with no trigger is dead code',
  );
}
for (const kind of new Set(kindsInSql)) {
  check(
    `there is a template for "${kind}"`,
    EMAIL_KINDS.includes(kind as never),
    'a queued email with no template can never be sent, and fails silently in a table nobody watches',
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — all nine templates render with hostile input escaped and with an empty payload,\n' +
    '       every one has a text part and a newline-free subject, none carries a NIN, a full\n' +
    '       account number or a link to private storage, the delivery email is a summary\n' +
    '       rather than a receipt, and the SQL kinds and the templates are the same list.',
);
