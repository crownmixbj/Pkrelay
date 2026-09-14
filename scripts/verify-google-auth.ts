/**
 * Assertions for signing in with Google.
 *
 * ⚠ The failure this guards is a whole class of account the phone lock does not
 *   cover.
 *
 *   `guard_application_phone` in `20250101000016_driver_identity.sql` stops a driver
 *   applicant claiming a number that is not their account's. It deliberately
 *   passes accounts that have *no* number, because some predate the field —
 *   which was safe while every account came from a sign-up form that refuses to
 *   submit without a valid Nigerian phone.
 *
 *   Google accounts arrive with none. Without the screen these assertions pin,
 *   the lock would hold for every email signup and for no Google signup, and
 *   nothing on any screen would say so. That is not a visible bug; it is a
 *   guard quietly covering half of what it used to.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { COMPLETE_PROFILE_ROUTE, completionRedirect } from '../src/lib/experience';

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

const flat = (source: string) => source.replace(/\s+/g, ' ');

// --------------------------------------- nobody gets in without a number ----

check(
  'an account with no phone is sent to the form',
  completionRedirect('/', true) === COMPLETE_PROFILE_ROUTE,
  'this is the whole point: a Google account has no number and the driver lock assumes one',
);
check(
  'and so is every other screen',
  ['/book', '/my-packages', '/profile', '/driver', '/admin'].every(
    (route) => completionRedirect(route, true) === COMPLETE_PROFILE_ROUTE,
  ),
  'a gate on one screen is a gate somebody walks around by opening another',
);
check(
  'an account that has one is left alone',
  ['/', '/book', '/profile'].every((route) => completionRedirect(route, false) === null),
  'redirecting somebody who has nothing to fix in is an infinite loop',
);

/*
 * ⚠ The exits stay open, and that is not a hole.
 *
 *   A gate with no way back is a trap. Somebody who signed in with the wrong
 *   Google account, or who does not want to give a number, needs to reach
 *   sign-out — and the form itself has to be reachable or the redirect loops
 *   forever.
 */
check(
  'the form itself is not redirected away from',
  completionRedirect(COMPLETE_PROFILE_ROUTE, true) === null,
  'a screen that redirects to itself is a browser that hangs',
);
for (const exit of ['/sign-in', '/sign-up']) {
  check(
    `and ${exit} stays reachable`,
    completionRedirect(exit, true) === null,
    'without a route out, somebody who picked the wrong account is stuck on a form for ever',
  );
}

// ------------------------------------------- the gate is on the router ------

const router = code(read('src/components/ui/experience-router.tsx'));

check(
  'the router applies it',
  router.includes('completionRedirect(pathname, needsPhone)'),
  'a correct rule nothing calls is a comment',
);
/*
 * ⚠ Before the experience rule, not after.
 *
 *   Running the experience rules first bounces somebody to a home screen and
 *   then to the form — two navigations to reach one destination, and on web two
 *   entries in the history to press back through.
 *
 * ⚠ Order, not adjacency. This used to require the two calls to sit either side
 *   of one `??`, which broke the day a third rule (`signedInRedirect`) joined
 *   the chain between them — a correct change failing an assertion that had
 *   pinned the wrong thing. What matters is that the phone-number gate is
 *   consulted first; what sits after it is that rule's business.
 */
const completionAt = flat(router).indexOf('completionRedirect(pathname, needsPhone)');
const experienceAt = flat(router).indexOf('redirectFor(pathname, experience)');

check(
  'before the experience rules',
  completionAt !== -1 && experienceAt !== -1 && completionAt < experienceAt,
  'the other order is two redirects where one belongs',
);

// ------------------------------------------------ what "needs" means --------

const session = code(read('src/store/session.tsx'));

check(
  'the flag is derived from the account, not stored',
  /needsPhone: status === 'signedIn' && \(user\?\.phone \?\? ''\)\.trim\(\)\.length === 0/.test(
    flat(session),
  ),
  'a stored flag drifts from the profile it is supposed to describe',
);
/*
 * ⚠ Only while signed in.
 *
 *   A signed-out visitor has no phone either. Without the status check every
 *   anonymous person browsing the marketing pages would be thrown at a form
 *   asking for their number.
 */
check(
  'and never for a signed-out visitor',
  flat(session).includes("status === 'signedIn' &&"),
  'a browsing stranger is not an account missing a field',
);

/*
 * ⚠ The number is written to both places it is read from.
 *
 *   `handle_new_user` copies the metadata into `profiles.phone` at signup, and
 *   `guard_application_phone` reads the *metadata* rather than the profile.
 *   Writing one and not the other leaves the profile screen showing a number
 *   the driver phone lock cannot see — which is the worst of both, because it
 *   looks done.
 */
check(
  'saving writes the auth metadata',
  flat(session).includes('updateUser({ data: { phone: trimmed } })'),
  'guard_application_phone reads this, not the profile row',
);
check(
  'and the profile row',
  /from\('profiles'\)\s*\.update\(\{ phone: trimmed \}\)/.test(flat(session)),
  'the profile screen reads this, not the metadata',
);

// ------------------------------------------------------- the OAuth call -----

check(
  'the provider is Google and the redirect is registered',
  session.includes("provider: 'google'") && session.includes('redirectTo: oauthRedirectLink()'),
  'without an explicit redirect Supabase falls back to the Site URL and this looks broken',
);
/*
 * ⚠ Web redirects itself; native must not.
 *
 *   Left to redirect on native there is no document to replace. The URL is
 *   opened in a modal browser instead, and the custom scheme is what closes it
 *   and hands the tokens back — a universal link would be caught by the browser
 *   showing Google's page rather than by the app that opened it.
 */
check(
  'native opens a browser rather than redirecting',
  session.includes("skipBrowserRedirect: Platform.OS !== 'web'") &&
    session.includes('WebBrowser.openAuthSessionAsync'),
  'a native redirect has no page to navigate and silently does nothing',
);
check(
  'and turns the returned tokens into a session',
  session.includes('supabase.auth.setSession({ access_token, refresh_token })'),
  'without this the browser closes and the person is still signed out',
);
/*
 * ⚠ Closing the sheet is not an error.
 *
 *   Somebody who changes their mind gets `dismiss` or `cancel`. A red banner
 *   over a deliberate act teaches people the banners are noise.
 */
check(
  'and a dismissed sheet is not reported as a failure',
  /result\.type !== 'success'\) return \{ error: null \}/.test(flat(session)),
  'cancelling is a choice, not a fault',
);

const links = code(read('src/constants/links.ts'));
/*
 * ⚠ The *returned value*, not the guard above it.
 *
 *   The first version matched `if (typeof window !== 'undefined' &&
 *   window.location?.origin)` — so replacing the return with a hardcoded
 *   domain left the assertion passing. The condition is not the answer.
 */
check(
  'the web redirect uses the current origin',
  /oauthRedirectLink[\s\S]{0,400}return `\$\{window\.location\.origin\}/.test(links),
  'a hardcoded domain sends every preview deploy back to production',
);
/*
 * ⚠ `createURL`, not a hardcoded `parcelmobile://`.
 *
 *   Expo Go is a different app with a different scheme (`exp://<lan-ip>:<port>`).
 *   A literal scheme works in a release build and silently does nothing in
 *   development: the sheet closes, no tokens arrive, no error is shown.
 */
check(
  'and native comes back through the scheme this binary actually answers to',
  /oauthRedirectLink[\s\S]{0,1800}Linking\.createURL\('\/sign-in'\)/.test(links),
  'a hardcoded scheme leaves Google sign-in dead in Expo Go with nothing to read',
);
/*
 * ⚠ The one thing native must never return.
 *
 *   A universal link is caught by the browser showing the consent screen, not
 *   by the app that opened it — so the person lands on a web page inside a
 *   modal browser holding a session the app never sees.
 */
check(
  'and never as a universal link',
  !/oauthRedirectLink[\s\S]{0,1800}return `https:\/\/\$\{LINK_DOMAIN\}/.test(links),
  'LINK_DOMAIN here hands the session to the browser instead of the app',
);
/*
 * ⚠ No environment guessing on the web path.
 *
 *   `__DEV__` is true in a native dev build too, and a hostname allowlist has
 *   no entry for the per-branch `*.pages.dev` origin a preview deploy gets.
 */
check(
  'and the web path guesses at no environment',
  !/oauthRedirectLink[\s\S]{0,1800}(__DEV__|localhost:8081|staging\.pkrelay\.com)/.test(links),
  'a hardcoded environment list sends every preview deploy back to production',
);

// ------------------------------------------------------- both entry points --

for (const screen of ['src/app/(auth)/sign-in.tsx', 'src/app/(auth)/sign-up.tsx']) {
  check(
    `${screen} offers it`,
    read(screen).includes('<GoogleSignIn'),
    'somebody who signed up with Google and lands on the other screen has no password to be told is wrong',
  );
}

const button = read('src/components/ui/google-sign-in.tsx');
/*
 * ⚠ One label on both, because OAuth has no sign-up/sign-in distinction.
 *
 *   Google either recognises the address or it does not. "Sign up with Google"
 *   promises a difference that does not exist.
 */
check(
  'with the same label on both',
  button.includes('Continue with Google') &&
    !/Sign up with Google|Sign in with Google/.test(code(button)),
  'two labels for one action invite the question of which one made the account',
);

// ------------------------------------------------ the name Google sends -----

const migration = read('supabase/migrations/20250101000045_google_identities.sql');

check(
  'the profile trigger reads the key Google documents',
  /nullif\(new\.raw_user_meta_data ->> 'full_name', ''\)/.test(migration),
  "02 read only 'name', which Google happens to send today and does not promise to",
);
check(
  'and still reads the one this app writes',
  /nullif\(new\.raw_user_meta_data ->> 'name', ''\)/.test(migration),
  'an email signup writes `name`; dropping it would blank every account created by the form',
);
/*
 * ⚠ No invented phone number.
 *
 *   A placeholder would silently become the only number a Google account is
 *   allowed to claim on a driver application, because that is what
 *   `guard_application_phone` compares against.
 */
check(
  'and invents no phone number',
  /coalesce\(new\.raw_user_meta_data ->> 'phone', ''\)/.test(migration) &&
    !/'\+234|placeholder/i.test(code(migration)),
  'a placeholder becomes the number the driver lock holds them to',
);
/*
 * ⚠ The backfill only fills blanks.
 *
 *   `on conflict do nothing` means anybody who signed in with Google before
 *   this ran already has an empty profile row. Overwriting a name the owner has
 *   since edited would be this migration undoing somebody's correction.
 */
check(
  'the backfill does not overwrite an edited name',
  /and coalesce\(btrim\(p\.full_name\), ''\) = ''/.test(migration),
  'a migration that replaces what somebody typed is a migration nobody trusts twice',
);

// ------------------------------------------------------ nothing secret ------

/*
 * ⚠ The client id and secret live in the Supabase project, not in this bundle.
 *
 *   The exchange happens between Supabase and Google. Anything resembling a
 *   credential in these files would ship to every browser that loads the app.
 */
for (const file of [
  'src/components/ui/google-sign-in.tsx',
  'src/constants/links.ts',
  'src/store/session.tsx',
]) {
  check(
    `${file} carries no Google credential`,
    !/GOCSPX-|client_secret|googleusercontent\.com/i.test(read(file)),
    'a secret in the client is a secret published',
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — Google sign-in is offered on both auth screens under one label, redirects to an\n' +
    '       origin that works on a preview deploy and to a scheme that works on a phone, and\n' +
    '       no account reaches the app without a phone number — which is what the driver\n' +
    '       phone lock has always assumed. The form cannot be walked around, cannot be\n' +
    '       looped on, and can be left by signing out. No credential ships in the bundle.',
);
