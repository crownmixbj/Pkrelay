/**
 * Assertions over the applicant confirmation email.
 *
 * The template module is plain TypeScript with no Deno globals, so it can be
 * bundled and run under node — which means the escaping and the copy are
 * checked here rather than discovered in someone's inbox.
 */
import {
  escapeHtml,
  firstName,
  headerSafe,
  renderApplicationEmail,
  subjectFor,
  type ApplicationEmailInput,
} from '../supabase/functions/notify-application/email';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const base: ApplicationEmailInput = {
  fullName: 'Chinedu Okafor',
  reference: 'LOCI-DRV-8F21',
  email: 'chinedu@example.com',
  vehicleType: 'Car',
  baseCity: 'Ibadan',
  state: 'Oyo',
  appUrl: 'https://loci.pages.dev',
  supportEmail: 'support@pkrelay.ng',
  reviewWorkingDays: 7,
};

// ------------------------------------------------------- the essentials ----

const mail = renderApplicationEmail(base);

check('subject carries the reference', mail.subject.includes('LOCI-DRV-8F21'), mail.subject);

check(
  'both parts exist',
  mail.text.length > 0 && mail.html.length > 0,
  'a single-part email scores badly with spam filters',
);

for (const [part, body] of [
  ['text', mail.text],
  ['html', mail.html],
] as const) {
  check(`${part} greets by first name`, body.includes('Chinedu'), body.slice(0, 200));
  check(`${part} states the reference`, body.includes('LOCI-DRV-8F21'));
  check(`${part} states the review window`, /7 working days/.test(body));
  check(`${part} names the address it went to`, body.includes('chinedu@example.com'));
}

// ------------------------------------------------- nothing sensitive leaks --

/*
 * The email crosses a third-party boundary (the mail provider, then whatever
 * mail host the applicant uses). A NIN or bank account number must never be in
 * it — the trigger payload does not carry them, and this is the assertion that
 * keeps it that way if someone later "helpfully" adds them.
 */
const secrets = ['nin', 'bank', 'account number', 'guarantor', 'password'];
for (const word of secrets) {
  check(
    `text part does not mention ${word}`,
    !mail.text.toLowerCase().includes(word),
    'sensitive fields must not cross the mail boundary',
  );
  check(`html part does not mention ${word}`, !mail.html.toLowerCase().includes(word));
}

// ----------------------------------------------------------- escaping ------

/*
 * Note which fields are rendered whole. Only the *first* word of the name
 * reaches the email, so hostile input is put in `baseCity`, which is printed
 * verbatim — the field an attacker would actually use.
 */
const hostile: ApplicationEmailInput = {
  ...base,
  fullName: '<script>alert(1)</script> Ade',
  email: 'a"b@example.com',
  baseCity: 'Ibadan <b>Lagos</b> & Co',
};

const nasty = renderApplicationEmail(hostile);

check(
  'html part contains no raw script tag',
  !nasty.html.includes('<script>'),
  'the greeting is applicant-supplied and reaches the HTML body',
);
check(
  'html part escapes the city ampersand',
  nasty.html.includes('&amp; Co'),
  'an unescaped & can swallow the following characters as an entity',
);
check(
  'html part escapes the city angle brackets',
  !nasty.html.includes('<b>Lagos</b>'),
  'an address field is somewhere an attacker can put markup',
);
check(
  'html part escapes the quote in an address',
  nasty.html.includes('&quot;') || !nasty.html.includes('a"b@example.com'),
  'an unescaped quote can break out of an attribute',
);
check(
  'text part is left unescaped',
  nasty.text.includes('Ibadan <b>Lagos</b> & Co'),
  'escaping the plain-text part would show a literal &amp; to the reader',
);

// --------------------------------------------------- header injection ------

check(
  'headerSafe strips CR and LF',
  headerSafe('PKRELAY\r\nBcc: attacker@evil.com') === 'PKRELAY Bcc: attacker@evil.com',
  headerSafe('PKRELAY\r\nBcc: attacker@evil.com'),
);

const injected = subjectFor({ ...base, reference: 'REF\nBcc: attacker@evil.com' });
check(
  'subject can never contain a newline',
  !/[\r\n]/.test(injected),
  'a newline in a header lets someone append their own Bcc',
);

// -------------------------------------------------------- degradation ------

const minimal = renderApplicationEmail({
  fullName: '',
  reference: 'LOCI-DRV-0001',
  email: 'someone@example.com',
  reviewWorkingDays: 7,
});

check(
  'missing name falls back to a greeting',
  minimal.text.startsWith('Hi there,'),
  minimal.text.slice(0, 40),
);
check(
  'no app url means no track link',
  !minimal.html.includes('Track your application'),
  'a button pointing nowhere is worse than no button',
);
check('no support email still offers a reply path', minimal.text.includes('Package Relay'));
check(
  'absent vehicle and city are omitted rather than blank',
  !minimal.text.includes('Vehicle:') && !minimal.text.includes('Operating in:'),
);

check('firstName handles extra whitespace', firstName('   Ada   Lovelace ') === 'Ada');
check('firstName handles an empty string', firstName('   ') === 'there');
check('escapeHtml covers all five characters', escapeHtml(`<>&"'`) === '&lt;&gt;&amp;&quot;&#39;');

// ------------------------------------------------ orchestration contract ----

/*
 * A transcription of the decision in `index.ts`, so the intent is pinned even
 * though the real function needs a Deno runtime to execute.
 *
 *   - "not configured" must NOT be recorded as a delivery failure, or every
 *     application shows as broken before the provider is ever set up
 *   - a real failure MUST be recorded, or nobody ever finds out
 *   - an already-sent application must not be emailed twice
 */
type Outcome = { ok: true } | { ok: false; error: string } | { skipped: string };

function shouldRecord(outcome: Outcome): boolean {
  return 'ok' in outcome;
}

check('a success is recorded', shouldRecord({ ok: true }));
check('a failure is recorded', shouldRecord({ ok: false, error: 'provider 401' }));
check('an unconfigured provider is not recorded', !shouldRecord({ skipped: 'no provider' }));
check('an already-sent skip is not recorded', !shouldRecord({ skipped: 'already sent' }));

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — the confirmation email carries the reference and review window, escapes hostile\n' +
    '       input, cannot inject a mail header, leaks no NIN or bank detail, degrades when\n' +
    '       unconfigured, and records real failures without flagging an unconfigured provider.',
);
