/**
 * Assertions for what happens when somebody clicks a confirmation link.
 *
 * ⚠ Every branch here is awkward to reach by hand, which is exactly why they
 *   are worth pinning.
 *
 *   Reproducing an expired token means waiting an hour. Reproducing the
 *   wrong-account case means two accounts, two mailboxes and a shared browser.
 *   Nobody does that twice, so these paths get written once, tested once and
 *   then quietly rot — while being the paths that decide whether an account
 *   ends up confirmed against the wrong person.
 *
 * The rules are imported and run, not transcribed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  hasConfirmationParams,
  isAlreadyConfirmed,
  parseConfirmationParams,
  resolveConfirmation,
} from '../src/lib/email-confirmation';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const code = (source: string) =>
  source
    .replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// --------------------------------------------------------------- parsing ---

const EXPIRED_QUERY =
  'https://pkrelay.example/confirm?email=ada%40example.com&error=access_denied' +
  '&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

const expiredParams = parseConfirmationParams(EXPIRED_QUERY);

check('the error code is read', expiredParams.errorCode === 'otp_expired', expiredParams.errorCode);
check('and the address it was issued for', expiredParams.email === 'ada@example.com');
check(
  'the description is readable, not plus-encoded',
  expiredParams.errorDescription === 'Email link is invalid or has expired',
  expiredParams.errorDescription,
);

/*
 * ⚠ The hash as well as the query.
 *
 *   PKCE puts these on the query string and the implicit flow puts them after
 *   the `#`. Which one a project uses is a dashboard setting that somebody can
 *   change without knowing this file exists, so both are read.
 */
const hashParams = parseConfirmationParams(
  'https://pkrelay.example/confirm#error=access_denied&error_code=otp_expired',
);
check('a fragment is read too', hashParams.errorCode === 'otp_expired', hashParams.errorCode);

check(
  'the email is lower-cased',
  parseConfirmationParams('https://x/confirm?email=Ada%40Example.COM&code=1').email ===
    'ada@example.com',
);
check(
  'a bare page has no parameters',
  !hasConfirmationParams(parseConfirmationParams('https://x/')),
);

// -------------------------------------------------------------- resolving ---

const resolve = (url: string, sessionEmail: string | null = null) =>
  resolveConfirmation({ params: parseConfirmationParams(url), sessionEmail });

check('nothing on the URL means nothing to do', resolve('https://x/confirm').kind === 'nothing');

check(
  'a code with no session is exchanged',
  resolve('https://x/confirm?code=abc&email=ada@example.com').kind === 'exchange',
);

check(
  'an expired link offers a resend',
  resolve(EXPIRED_QUERY).kind === 'expired',
  'the whole point is that the person is not left on a page that says nothing',
);
check(
  'and carries the address forward',
  (() => {
    const outcome = resolve(EXPIRED_QUERY);
    return outcome.kind === 'expired' && outcome.email === 'ada@example.com';
  })(),
  'without it the resend form has nobody to send to and has to ask',
);

/*
 * ⚠ The case this file exists for.
 *
 *   Somebody is signed in on a shared laptop and clicks a link belonging to
 *   another account. Claiming it would attach one person's confirmation to
 *   another person's session, and nothing on screen would say so.
 */
const mismatch = resolve('https://x/confirm?code=abc&email=ada@example.com', 'bola@example.com');
check('a link for another account is refused', mismatch.kind === 'wrong-account', mismatch.kind);
check(
  'and names both sides',
  mismatch.kind === 'wrong-account' &&
    mismatch.signedInAs === 'bola@example.com' &&
    mismatch.linkFor === 'ada@example.com',
  'on a family laptop, one address alone leaves them guessing which is which',
);

/*
 * ⚠ Checked before the expiry branch, deliberately.
 *
 *   An expired link belonging to somebody else must not be answered with "send
 *   yourself a fresh one" — that hands a stranger a working route into an
 *   account on a machine they are already sitting at.
 */
const staleMismatch = resolve(EXPIRED_QUERY, 'bola@example.com');
check(
  'an expired link for another account is still a mismatch',
  staleMismatch.kind === 'wrong-account',
  `resolved as ${staleMismatch.kind} — a resend offered here is a resend to somebody else's inbox`,
);

check(
  'the same person, already signed in, is simply let through',
  resolve('https://x/confirm?code=abc&email=ada@example.com', 'ada@example.com').kind ===
    'already-signed-in',
);
check(
  'and an expired link is not an error once they are already in',
  resolve(EXPIRED_QUERY, 'ada@example.com').kind === 'already-signed-in',
  'the token rotted after doing its job; that is not worth a red banner',
);
check(
  'case and spacing do not make two addresses different people',
  resolve('https://x/confirm?code=abc&email=ada@example.com', ' Ada@Example.com ').kind ===
    'already-signed-in',
);

/*
 * A link with no email on it — anything issued before `emailRedirectTo` carried
 * one. It cannot be checked against the session, so a signed-in visitor is
 * treated as already in rather than accused of a mismatch that may not exist.
 */
check(
  'a link with no address does not invent a mismatch',
  resolve('https://x/confirm?code=abc', 'ada@example.com').kind === 'already-signed-in',
);

check(
  'an unknown refusal keeps the provider’s own words',
  (() => {
    const outcome = resolve('https://x/confirm?error=server_error&error_description=Down+for+now');
    return outcome.kind === 'failed' && outcome.message === 'Down for now';
  })(),
  'a generic "something went wrong" throws away the only clue there is',
);

// ------------------------------------------------- already confirmed ---------

/*
 * ⚠ Supabase reports a spent token and an expired one identically, so the URL
 *   cannot tell them apart. The resend refusing is the only trustworthy signal.
 */
check(
  'a refusal naming confirmation is recognised',
  isAlreadyConfirmed(undefined, 'Email address already confirmed') &&
    isAlreadyConfirmed('email_address_already_confirmed', '') &&
    isAlreadyConfirmed(undefined, 'User already registered'),
);
check(
  'an unrelated refusal is not',
  !isAlreadyConfirmed(
    undefined,
    'For security purposes, you can only request this once every 60 seconds',
  ),
  'treating a rate limit as "already confirmed" would send an unconfirmed person to a sign-in that cannot work',
);

// ----------------------------------------------------------- the wiring -----

const links = code(read('src/constants/links.ts'));
const session = code(read('src/store/session.tsx'));
const confirm = code(read('src/app/(auth)/confirm.tsx'));
const resend = code(read('src/components/ui/resend-verification.tsx'));

check(
  'sign-up sends the link to the confirm route',
  session.includes('emailRedirectTo: emailConfirmationLink(params.email)'),
  'without it the link lands on the Site URL, where nothing reads the parameters',
);
check(
  'and the address travels with it',
  links.includes('email=${encodeURIComponent(email.trim().toLowerCase())}'),
  'an error redirect carries nothing else identifying, so two branches depend on this',
);
check(
  'the confirm route is registered with the navigator',
  read('src/app/(auth)/_layout.tsx').includes('name="confirm"'),
  'an unregistered screen is a blank route',
);
check(
  'the resend uses the signup type',
  session.includes("supabase.auth.resend({ type: 'signup'"),
  'the recovery type sends a password reset, which is a different email entirely',
);
check(
  'the resend can ask for an address it was not given',
  resend.includes('<Field') && resend.includes('isValidEmail'),
  'a link that arrives without an email would otherwise offer a button with nobody to send to',
);
check(
  'and turns "already confirmed" into a route rather than an error',
  resend.includes('onAlreadyConfirmed(address)') &&
    confirm.includes("router.replace({ pathname: '/sign-in'"),
  'this is the only reliable way to detect a spent token, so it must not read as a failure',
);
/*
 * ⚠ The heading is asserted as an exact string, which is unusual here and
 *   deliberate: it was specified as exact.
 *
 *   Most copy in this repo is checked loosely, because pinning a sentence makes
 *   a test that fails on every rewording. This one is a specific requirement
 *   rather than a phrasing choice, so it is pinned to the character.
 */
check(
  'a verified email says so, in those words',
  confirm.includes('title="Email Verified Successfully"'),
  'specified exactly; a near-miss like "Email verified successfully" is a different string',
);
/*
 * ⚠ Repointed. This required a "Continue to Package Relay" button, and the
 *   screen deliberately no longer has one.
 *
 *   The button was the original answer to a real risk: a success screen replaced
 *   on a timer can flicker past unread, and somebody who never sees it goes back
 *   to the email and clicks a link that is now spent — landing on "that link has
 *   expired" with a perfectly good account. The screen now confirms and moves on
 *   by itself, which is the better experience for the ninety-nine people who did
 *   read it and a worse one for nobody, *provided* three things hold.
 *
 *   So the risk is defended directly rather than through the control that used
 *   to mitigate it. Restoring the button is still a one-line change if the
 *   auto-redirect proves wrong in use; deleting these assertions is not.
 */
const confirmFlat = confirm.replace(/\s+/g, ' ');

check(
  'the success screen is on screen long enough to be read',
  (() => {
    const ms = /const SUCCESS_REDIRECT_MS = ([\d_]+)/.exec(confirm)?.[1];
    return ms !== undefined && Number(ms.replace(/_/g, '')) >= 1500;
  })(),
  'below about a second and a half it flickers past, which is how people end up clicking the link twice',
);
check(
  'and it leaves on a timer rather than on the render',
  /setTimeout\(\(\) => router\.replace\('\/'\), SUCCESS_REDIRECT_MS\)/.test(confirmFlat),
  'navigating during the render means the confirmation is never painted at all',
);
/*
 * ⚠ `replace`, not `push`, and this is the half that makes the redirect safe.
 *
 *   The URL this screen was opened with still carries the confirmation code.
 *   Pushing would leave it one back gesture away, and returning to it re-resolves
 *   a token that is now spent — which is the same "that link has expired" the
 *   button was protecting against, reached by a different route.
 */
check(
  'and it replaces the spent link rather than pushing past it',
  !/router\.push\('\/'\)/.test(confirmFlat),
  'a back gesture onto a used confirmation code lands on "expired" with nothing wrong',
);
check(
  'the timer starts only once there is a session, and is cleared on the way out',
  /if \(!verified\) return; const timer = setTimeout/.test(confirmFlat) &&
    /return \(\) => clearTimeout\(timer\)/.test(confirmFlat),
  'a timer that survives the screen navigates somebody away from wherever they went next',
);

/*
 * ⚠ And it is only shown once a session actually exists.
 *
 *   Under PKCE the code verifier lives on the device that signed up, so a link
 *   opened on a different one exchanges nothing. Announcing success on the
 *   presence of a code in the URL would be a claim made before the fact, and
 *   wrong for precisely the person whose link did not work.
 */
check(
  'success waits for the session, not for the code',
  confirm.includes("outcome?.kind === 'exchange' && status === 'signedIn'"),
  'a code in the URL is a request to exchange, not proof that one happened',
);
check(
  'and an exchange that never lands falls through to a resend',
  confirm.includes('setExchangeTimedOut(true)') &&
    confirm.includes("outcome.kind === 'expired' || outcome.kind === 'exchange'"),
  'otherwise the spinner is permanent and nothing on screen says what to do',
);

check(
  'the mismatch screen offers to sign out and re-resolve',
  confirm.includes('await signOut()') && confirm.includes('sessionEmail: null'),
  'sending them to sign-in instead would make them go and find the email again',
);
check(
  'and nothing is claimed before they choose',
  !/wrong-account[\s\S]{0,600}exchangeCodeForSession/.test(confirm),
  'the entire point of the branch is that the link is left unspent',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — an expired link explains itself and offers a resend to the right address, a link\n' +
    '       for another account is refused before anything is claimed, a link clicked twice\n' +
    '       or clicked while already signed in is not an error, "already confirmed" is read\n' +
    '       from the only signal that reports it honestly, and success is announced in the\n' +
    '       specified words only once a session exists to justify it.',
);
