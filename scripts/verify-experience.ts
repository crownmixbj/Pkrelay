/**
 * Assertions for platform and role routing.
 *
 * The rule is a pure function, so this exercises it directly rather than
 * transcribing it. What the file adds on top is the two things a pure function
 * cannot check on its own: that every route someone can reach is reachable, and
 * that the navigation and the guard read the same rule.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tabsAreRoutable, tabsFor } from '../src/components/ui/bottom-tab-bar';
import {
  completionRedirect,
  EXPERIENCES,
  EXPERIENCE_HOME,
  recoveryRedirect,
  redirectFor,
  resolveExperience,
  routeAllowed,
  signedInRedirect,
  UPDATE_PASSWORD_ROUTE,
} from '../src/lib/experience';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

// ------------------------------------------------------------ resolution ----

const at = (over: Partial<Parameters<typeof resolveExperience>[0]>) =>
  resolveExperience({
    platform: 'ios',
    authLoading: false,
    isAuthenticated: true,
    isApprovedDriver: false,
    role: 'sender',
    ...over,
  });

check('web is web, signed out', at({ platform: 'web', isAuthenticated: false }) === 'web');
check(
  'web is web, as an approved driver',
  at({ platform: 'web', isApprovedDriver: true, role: 'driver' }) === 'web',
);
check(
  'web wins over role',
  at({ platform: 'web', isApprovedDriver: true, role: 'driver' }) !== 'driver',
  'the dashboard is one interface; what it contains is decided by RLS',
);

check('a signed-out phone gets the sender app', at({ isAuthenticated: false }) === 'sender');
check('a signed-in sender gets the sender app', at({}) === 'sender');

/*
 * The security-shaped question. The Sender/Driver toggle is a view preference
 * anyone can flip; routing on it alone would hand the driver interface to any
 * sender who tapped it once.
 */
check(
  'flipping the toggle without an approved application does NOT give the driver app',
  at({ role: 'driver', isApprovedDriver: false }) === 'sender',
  'the toggle is a preference, not a credential',
);
check(
  'an approved driver who chose Driver gets it',
  at({ role: 'driver', isApprovedDriver: true }) === 'driver',
);
check(
  'an approved driver who chose Sender stays a sender',
  at({ role: 'sender', isApprovedDriver: true }) === 'sender',
  'someone who is both should be able to book a parcel',
);

check(
  'nothing is decided while auth is restoring',
  at({ authLoading: true }) === null && at({ authLoading: true, platform: 'web' }) === null,
  'guessing sender flicks an approved driver through the wrong home on every launch',
);

// --------------------------------------------------------------- routing ----

check(
  'every experience has a home',
  EXPERIENCES.every((e) => Boolean(EXPERIENCE_HOME[e])),
);
check(
  'and every home is allowed in its own experience',
  EXPERIENCES.every((e) => routeAllowed(EXPERIENCE_HOME[e], e)),
  'a home the guard bounces off is an infinite redirect',
);

check('a driver keeps their portal', routeAllowed('/driver', 'driver'));
check('and the job board', routeAllowed('/available-packages', 'driver'));
check('but not the booking form', !routeAllowed('/book', 'driver'));
check('nor the sender parcel list', !routeAllowed('/my-packages', 'driver'));

check('a sender keeps the booking form', routeAllowed('/book', 'sender'));
check('but not the driver portal', !routeAllowed('/driver', 'sender'));

check(
  'web keeps everything',
  ['/book', '/driver', '/available-packages', '/my-packages', '/admin'].every((r) =>
    routeAllowed(r, 'web'),
  ),
);

/*
 * Admin deliberately stays on every device. Blocking it on a phone would mean
 * nobody could approve a driver or lift a ban without a laptop, and platform is
 * not a security boundary anyway.
 */
for (const experience of EXPERIENCES) {
  check(`admin is reachable in ${experience}`, routeAllowed('/admin', experience));
  check(
    `and so are the admin sub-screens in ${experience}`,
    routeAllowed('/admin-users', experience),
  );
}

/*
 * Prefix matching must not swallow siblings. `/driver` is driver-only, but
 * `/driver-signup` is how a *sender* applies — if the rule caught it, nobody
 * could ever become a driver.
 */
for (const route of ['/driver-signup', '/driver-updates', '/driver-guidelines']) {
  check(
    `${route} stays open to senders`,
    routeAllowed(route, 'sender'),
    'this is how someone applies',
  );
}
check('but /driver/anything is still driver-only', !routeAllowed('/driver/foo', 'sender'));

check(
  'an unlisted route is shared rather than hidden',
  routeAllowed('/some-new-screen', 'driver') && routeAllowed('/some-new-screen', 'sender'),
  'an allowlist fails as a blank screen nobody can explain',
);

// ------------------------------------------------------------- redirects ----

check('no redirect when the route is fine', redirectFor('/book', 'sender') === null);
check(
  'a driver on the booking form goes to their portal',
  redirectFor('/book', 'driver') === '/driver',
);
check(
  'a sender on the portal goes to their home',
  redirectFor('/driver', 'sender') === '/book',
  'the sender home is the booking form on a phone, not the marketing page',
);

/*
 * The landing page is web-only. Without that rule a native cold start lands on
 * the hero with no tab selected, which reads as the app failing to open.
 */
check('the marketing home is web-only', routeAllowed('/', 'web') && !routeAllowed('/', 'sender'));
check('and a native cold start is moved off it', redirectFor('/', 'sender') === '/book');
check('for a driver too', redirectFor('/', 'driver') === '/driver');
check(
  'the root rule matches only the root',
  routeAllowed('/book', 'sender') && routeAllowed('/locations', 'sender'),
  "a prefix of '/' would otherwise swallow every route in the app",
);
check(
  'nothing happens while auth is restoring',
  redirectFor('/driver', null) === null,
  'redirecting before the session is known bounces people twice',
);

/*
 * Every redirect target must itself be allowed, or the guard sends someone
 * somewhere it will immediately send them away from again.
 */
for (const experience of EXPERIENCES) {
  for (const route of ['/book', '/driver', '/my-packages', '/available-packages']) {
    const target = redirectFor(route, experience);
    if (!target) continue;
    check(
      `${experience}: the redirect away from ${route} lands somewhere allowed`,
      routeAllowed(target, experience),
      `sent to ${target}`,
    );
  }
}

// ------------------------------------------ already signed in, at the door ---

/*
 * The bug: a signed-in person opening /sign-in was shown the form.
 *
 * The screen renders the same thing either way — it has no idea who is looking
 * at it — so the fix is a rule the guard applies, and these are its edges. The
 * `next` cases matter most: the screen sends somebody to `next` after a
 * successful sign-in while this rule is firing on the same session change, so
 * the two have to agree on the destination.
 */
const signedIn = (over: Partial<Parameters<typeof signedInRedirect>[0]> = {}) =>
  signedInRedirect({
    pathname: '/sign-in',
    isAuthenticated: true,
    needsPhone: false,
    experience: 'web',
    ...over,
  });

check(
  'a signed-in person on the sign-in form is sent home',
  signedIn() === EXPERIENCE_HOME.web,
  'this is the reported bug: the form renders the same whether or not there is a session',
);
check(
  'and on sign-up too',
  signedIn({ pathname: '/sign-up' }) === EXPERIENCE_HOME.web,
  'an account creation form is no more use to somebody who already has one',
);
check(
  'to the home their interface actually has',
  signedIn({ experience: 'sender' }) === '/book' && signedIn({ experience: 'driver' }) === '/driver',
);
check(
  'a signed-out person is left alone',
  signedIn({ isAuthenticated: false }) === null,
  'the whole point of the screen',
);
check(
  'nothing happens while auth is restoring',
  signedIn({ experience: null }) === null,
  'a cold start would otherwise bounce off its own sign-in screen',
);
check(
  'and nothing happens to an account that still owes a phone number',
  signedIn({ needsPhone: true }) === null,
  'the completion gate keeps the auth routes open as that account\'s way back out',
);
check(
  'every other auth screen is left alone',
  ['/verify-email', '/confirm', '/forgot-password', '/complete-profile'].every(
    (route) => signedIn({ pathname: route }) === null,
  ),
  'those belong to somebody mid-signup, who often does have a session',
);
check(
  'and so does the rest of the app',
  ['/', '/book', '/profile'].every((route) => signedIn({ pathname: route }) === null),
);

check(
  'the destination the auth gate asked for is honoured',
  signedIn({ next: '/book' }) === '/book',
  'the screen sends them to next on sign-in; this rule fires on the same session change',
);
check(
  'unless that interface does not have it',
  signedIn({ next: '/book', experience: 'driver' }) === '/driver',
  'following it would land them somewhere the next rule bounces them off',
);
check(
  'a next pointing back at the door is ignored',
  signedIn({ next: '/sign-in' }) === EXPERIENCE_HOME.web,
  'a screen that redirects to itself is a browser that hangs',
);

/*
 * ⚠ `next` is attacker-supplied: it arrives in a link anybody can send, and on
 *   the web it reaches `router.replace`. A URL is not a path.
 */
check(
  'an off-site next is refused',
  ['//evil.example', '/\\evil.example', 'https://evil.example', 'evil.example'].every(
    (hostile) => signedIn({ next: hostile }) === EXPERIENCE_HOME.web,
  ),
  'protocol-relative and backslash forms are both parsed as another origin by browsers',
);
check(
  'and so is a duplicated one',
  signedIn({ next: ['/book', '/driver'] }) === EXPERIENCE_HOME.web,
  'expo-router hands back an array; there is no unambiguous request to honour',
);

const routerSource = read('src/components/ui/experience-router.tsx');
const signInScreen = read('src/app/(auth)/sign-in.tsx');

/*
 * ⚠ The screen reads the same rule, and does not restate it.
 *
 *   The guard is what navigates, but it navigates from an effect — so for a
 *   frame or two the form is on screen, which is the symptom that was reported
 *   in the first place. The screen therefore asks the same function whether
 *   this person is leaving, rather than testing `isAuthenticated` itself: a
 *   second copy of the condition is how the two start disagreeing about who is
 *   signed in, and a signed-in person sees a form again.
 */
check(
  'the sign-in screen reads the shared rule',
  signInScreen.includes('signedInRedirect({') &&
    signInScreen.includes("from '@/lib/experience'"),
  'a hand-written isAuthenticated check here is the second copy this avoids',
);
check(
  'and renders no form to somebody it is redirecting',
  (() => {
    const guardAt = signInScreen.indexOf('if (leaving)');
    const formAt = signInScreen.indexOf('<ValidatedEmailInput');
    return guardAt !== -1 && formAt !== -1 && guardAt < formAt;
  })(),
  'the early return has to come before the form, or both render',
);

check(
  'the guard applies the rule',
  routerSource.includes('signedInRedirect({'),
  'a correct rule nothing calls is a comment',
);
check(
  'after the completion gate and before the experience rule',
  (() => {
    const completion = routerSource.indexOf('completionRedirect(pathname, needsPhone)');
    const signedInAt = routerSource.indexOf('signedInRedirect({');
    const experienceAt = routerSource.indexOf('redirectFor(pathname, experience)');
    return completion !== -1 && completion < signedInAt && signedInAt < experienceAt;
  })(),
  'an account owing a phone number outranks this; being on a route your interface lacks does not',
);
check(
  'and reads next from the current route, not from its own',
  routerSource.includes('useGlobalSearchParams<{ next?: string }>()'),
  'this component lives in the root layout, outside every screen: the local hook reads nothing there',
);

// ------------------------------------------------- the recovery gate -------

/*
 * A reset link mints an ordinary session, so `status` alone cannot tell a
 * password somebody knows from an inbox somebody can read. These assertions are
 * the difference — and they are worth having as assertions rather than as a
 * careful reading of the component, because every one of them describes a state
 * that is awkward to reach by hand and easy to regress by accident.
 */
check('a session that is not recovering is left alone', recoveryRedirect('/', false) === null);
check(
  'a recovering session is pulled off the app home',
  recoveryRedirect('/', true) === UPDATE_PASSWORD_ROUTE,
);
check(
  'and off the booking form, the driver hub and the profile alike',
  ['/book', '/driver', '/profile', '/my-packages', '/admin'].every(
    (route) => recoveryRedirect(route, true) === UPDATE_PASSWORD_ROUTE,
  ),
  'the gate is the whole route table minus its exemptions, not a list of screens somebody remembered',
);
check(
  'the update-password screen itself does not bounce',
  recoveryRedirect(UPDATE_PASSWORD_ROUTE, true) === null,
  'a redirect to the screen you are on is an infinite loop',
);
check(
  'nor does the legal text underneath it',
  recoveryRedirect('/legal', true) === null && recoveryRedirect('/legal/terms', true) === null,
);
check(
  'but sign-in does, because leaving by that door strands an untrusted session',
  recoveryRedirect('/sign-in', true) === UPDATE_PASSWORD_ROUTE,
  'signing out is the exit; it clears the flag and then every route opens',
);

check(
  'the completion gate exempts the update-password screen',
  completionRedirect(UPDATE_PASSWORD_ROUTE, true) === null,
  'otherwise recovery and completion take turns and neither screen is ever finished',
);

check(
  'the guard applies the recovery rule',
  routerSource.includes('recoveryRedirect(pathname, recovering)'),
  'a correct rule nothing calls is a comment',
);
check(
  'ahead of every other rule',
  (() => {
    const recovery = routerSource.indexOf('recoveryRedirect(pathname, recovering)');
    const completion = routerSource.indexOf('completionRedirect(pathname, needsPhone)');
    return recovery !== -1 && recovery < completion;
  })(),
  'every rule below assumes a session the person earned; running one first hands a half-reset session a home screen',
);
check(
  'and re-runs when the flag changes',
  /}, \[[^\]]*\brecovering\b[^\]]*\]\);/.test(routerSource),
  'omitted from the deps, the gate closes on the next unrelated navigation instead of on the event',
);

/*
 * The store side of the same rule. Read as source rather than executed: the
 * provider needs a React tree and a Supabase client, and neither is worth
 * standing up to assert that four lines exist.
 */
const sessionStore = read('src/store/session.tsx');

check(
  'the store listens for PASSWORD_RECOVERY',
  sessionStore.includes("event === 'PASSWORD_RECOVERY'"),
  'without the listener the flag is never set and the gate never closes',
);
check(
  'and returns before the sign-in branches, so recovery is never greeted as a sign-in',
  (() => {
    const recovery = sessionStore.indexOf("event === 'PASSWORD_RECOVERY'");
    const greeting = sessionStore.indexOf("event === 'SIGNED_IN'");
    return recovery !== -1 && greeting !== -1 && recovery < greeting;
  })(),
);
check(
  'the flag survives a restart',
  sessionStore.includes('recoveryKey(') && sessionStore.includes("AsyncStorage.setItem(recoveryKey"),
  'held only in memory, force-quitting the app is enough to be left signed in on a half-reset session',
);
check(
  'and is cleared only once a password has actually been set',
  (() => {
    const call = sessionStore.indexOf('supabase.auth.updateUser({ password })');
    const clear = sessionStore.indexOf('setRecovering(false);\n        if (data.user)');
    return call !== -1 && clear !== -1 && call < clear;
  })(),
  'clearing optimistically releases the gate on a request that failed',
);
/*
 * The regression that sent somebody back to their inbox for a link that was
 * never the problem: a fresh reset link reported as expired.
 */
const updatePasswordScreen = read('src/app/(auth)/update-password.tsx');

check(
  'a link is only called expired when Supabase says it is',
  !updatePasswordScreen.includes('Boolean(params.code)'),
  'deriving "expired" from a code being present reports every failed exchange as a dead link',
);
check(
  'and the wait for the exchange is not gated on seeing that code',
  !/if \(!params\.code \|\|/.test(updatePasswordScreen),
  'supabase-js strips its own params before this screen mounts, so the code is usually already gone',
);
check(
  'a link that produced no session names the device, not the clock',
  updatePasswordScreen.includes('could not be completed here'),
  'PKCE keeps the verifier in the browser that asked; a link opened elsewhere is fine and unusable',
);

check(
  'the reset email points somewhere that reads the token',
  read('src/store/session.tsx').includes('redirectTo: passwordResetLink(address)') &&
    read('src/constants/links.ts').includes('/update-password?'),
  'with no redirectTo Supabase falls back to the Site URL and PASSWORD_RECOVERY never fires at all',
);

// ------------------------------------------------------ the tab bar --------

const tabs = read('src/components/ui/bottom-tab-bar.tsx');
const header = read('src/components/ui/sticky-header.tsx');

check(
  'the sender tabs match the mockup',
  ['New Shipment', 'My Shipments', 'Account'].every((label) => tabs.includes(label)),
);
/*
 * Asserted on hrefs, not labels.
 *
 * This check used to name 'Schedule My Journey', so renaming that tab to 'Trip
 * Setup' failed it — while the thing it exists to protect, that a driver is
 * never handed the booking form, was never touched. Labels are copy; the route
 * list is the rule.
 */
const driverHrefs = tabsFor('driver').map((tab) => tab.href);
check(
  'the driver tabs cover the work, the board and the money',
  ['/driver', '/available-packages', '/driver-wallet'].every((href) => driverHrefs.includes(href)),
  driverHrefs.join(', '),
);
check(
  'and never the booking form',
  !driverHrefs.includes('/book'),
  'a driver has no booking form in their experience at all',
);
check(
  'web shows no tab bar',
  tabs.includes("if (experience === 'driver') return DRIVER_TABS") && tabs.includes('return [];'),
  'the capsule carries navigation there',
);
check(
  'the desktop header is hidden on a phone',
  header.includes("if (experience && experience !== 'web') return null"),
  'the capsule collapses to a hamburger, which buries every destination',
);
check(
  'the tab bar clears the home indicator',
  tabs.includes('insets.bottom > 0 ? insets.bottom'),
  'without it the labels sit under the iPhone home bar',
);
check(
  'the active tab is not marked by colour alone',
  tabs.includes('the label is always visible'),
  'the tinted pill is 1.15:1 on the bar',
);

// ------------------------------------------------- one rule, two readers ----

const nav = read('src/components/ui/app-nav-bar.tsx');
const guard = read('src/components/ui/experience-router.tsx');

check(
  'the navigation filters on the shared rule',
  nav.includes('routeAllowed(child.href, experience)') && nav.includes('routeAllowed(link.href'),
  'a second copy of the rule shows a link the guard bounces off',
);
check('the guard uses it too', guard.includes('redirectFor(pathname, experience)'));
check(
  'a group with no remaining children is dropped',
  nav.includes('return link.children.length > 0'),
  'otherwise it is a heading that opens an empty menu',
);
check(
  'the guard cannot loop',
  guard.includes('lastRedirect') && guard.includes('Stop rather than loop'),
  'a disallowed redirect target would otherwise navigate forever',
);
check(
  'the guard replaces rather than pushes',
  guard.includes('router.replace'),
  'the route they are leaving does not exist for them',
);

// -------------------------------------------------- switching the view -----

const settings = read('src/components/ui/settings-menu.tsx');
/** Prettier wraps JSX text, so a phrase can be split across lines in the source. */
const flat = (source: string) => source.replace(/\s+/g, ' ');
const session = read('src/store/session.tsx');

check(
  'there is one place to switch, not two',
  settings.includes("choose('driver')") &&
    !nav.includes('SESSION_ROLES') &&
    !nav.includes('styles.segmented'),
  'the old segmented control moved into the sheet; two controls drift apart',
);
/*
 * ⚠ This asserted a settings gear opened the sheet. There is no gear now.
 *
 *   It sat beside the avatar and opened the same panel. Two controls onto one
 *   destination is a choice the reader has to make for no benefit, so the
 *   avatar is the only way in — and when signed out it goes straight to
 *   sign-in, which is all that sheet offers a stranger anyway.
 */
check(
  'the avatar opens it, and is the only thing that does',
  nav.includes('const openAccountMenu = () => setSettingsOpen(true)') &&
    !nav.includes('<Settings color'),
  'the old avatar dialog was three quarters of this sheet; a second control beside it was the rest',
);
check(
  'only an approved driver is offered the choice',
  settings.includes("const canSwitch = isApprovedDriver && experience !== 'web'"),
  'the toggle is a preference, and offering it to a sender shows empty screens',
);
check(
  'and the web dashboard explains why it has none',
  flat(settings).includes('nothing to switch between'),
  'an approved driver would otherwise hunt for a control that is deliberately absent',
);
check(
  'switching navigates to the new home rather than staying put',
  settings.includes('router.replace(EXPERIENCE_HOME['),
  'the guard would move them anyway; doing it here reads as arriving, not being thrown',
);
check(
  'selection is not carried by colour alone',
  settings.includes('{selected && <Check'),
  'the tinted fill is 1.15:1 against the sheet, and colour alone fails WCAG 1.4.1',
);

// ---------------------------------------------------------- persistence ----

check(
  'the chosen view is stored per account',
  session.includes('const activeViewKey = (userId: string) => `loci.activeView.${userId}`'),
  "one shared key hands the next person on a shared device the last one's interface",
);
check(
  'it is restored when the person changes',
  session.includes('restoredViewFor') && session.includes('[user?.id, initialRole]'),
);
check(
  'but not re-read on every token refresh',
  !session.includes('}, [user, initialRole]);'),
  '`user` gets a new identity hourly',
);
check(
  'signing out forgets it',
  session.includes('AsyncStorage.removeItem(activeViewKey(user.id))'),
);
check(
  'the write does not block the switch',
  /setRoleState\(next\);\s*\n\s*if \(user\) void AsyncStorage\.setItem/.test(session),
  'a view preference is not worth a spinner',
);

/*
 * The case that matters most: someone whose approval is revoked while their
 * stored preference still says 'driver'. Nothing in the persistence layer
 * validates that — it does not need to, because the resolver already refuses.
 */
check(
  'a stored driver view cannot strand a revoked driver',
  at({ role: 'driver', isApprovedDriver: false }) === 'sender',
  'a banned driver reopening the app must land somewhere usable',
);
check(
  'and the guard then moves them off the portal',
  redirectFor('/driver', at({ role: 'driver', isApprovedDriver: false })) === '/book',
);

/*
 * Routing decides what is shown. It is not access control, and the file has to
 * say so — the next person to read it will otherwise assume the driver screens
 * are protected by it.
 */
/*
 * Every tab must point somewhere its own experience allows, or the guard
 * bounces the person straight back off a tab they just tapped.
 */
check('sender tabs are all routable in the sender experience', tabsAreRoutable('sender'));
check('driver tabs are all routable in the driver experience', tabsAreRoutable('driver'));

check(
  'the module states it is not a security boundary',
  read('src/lib/experience.ts').includes('not a security boundary'),
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — web resolves before role, an unapproved toggle never yields the driver app,\n' +
    '       the view switch lives in one place and is stored per account, a revoked\n' +
    '       driver cannot be stranded by a stale preference,\n' +
    '       nothing resolves while auth restores, /driver-signup stays open to senders,\n' +
    '       admin works on every device, every redirect lands somewhere allowed, a signed-in\n' +
    '       person is moved off the sign-in form to the destination the gate asked for —\n' +
    '       never to another origin, a session that arrived on a reset link is held on the\n' +
    '       update-password screen until a password is actually set and survives a restart\n' +
    '       there, and the navigation and the guard read one shared rule.',
);
