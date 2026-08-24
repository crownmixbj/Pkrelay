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
  EXPERIENCES,
  EXPERIENCE_HOME,
  redirectFor,
  resolveExperience,
  routeAllowed,
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
    '       admin works on every device, every redirect lands somewhere allowed, and the\n' +
    '       navigation and the guard read one shared rule.',
);
