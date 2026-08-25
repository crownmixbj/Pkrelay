/**
 * Assertions for the profile screen.
 *
 * ⚠ This screen was built from a mockup, and mockups carry invented facts.
 *
 *   The design it came from showed "Joy Ada", "Member Since: March 2023", a
 *   wallet balance of "₦12,500.00", "3 Active" shipments, "5 locations" and
 *   "3 cards". Every one of those is a placeholder, and a screen that ships
 *   with any of them demos perfectly and lies to each real person who opens
 *   it. A balance is the worst of them to be confidently wrong about.
 *
 * ⚠ It also showed four features that do not exist.
 *
 *   Saved Addresses, Payment Methods and Delivery Preferences have no table,
 *   no policy and no screen; the wallet is a driver *earnings* ledger with
 *   payouts and holds, so "Top Up" is a direction money cannot travel. Tiles
 *   for them would be taps into nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { memberSince } from '../src/store/own-details';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const screen = read('src/app/(tabs)/profile.tsx');
const details = read('src/store/own-details.ts');
const menu = read('src/components/ui/settings-menu.tsx');

/** Comments explain the placeholders; the JSX must not contain them. */
const code = screen
  .replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// ------------------------------------------------- nothing is made up ----

for (const invented of ['Joy Ada', 'March 2023', '12,500', '12500', '3 Active', '5 locations']) {
  check(
    `the mockup's ${JSON.stringify(invented)} did not survive into the screen`,
    !code.includes(invented),
    'a placeholder that ships is a screen that lies to everyone who is not in the mockup',
  );
}

/*
 * ⚠ The counts come from the data, and the assertion says which data.
 *
 *   "No hardcoded 3" is satisfied by hardcoding 4. What makes the number
 *   honest is that it is derived, so that is what is checked.
 */
check(
  'the active count is this account’s own unfinished parcels',
  code.includes('parcelsForUser(bookings, viewerId)') && code.includes('!isFinished(booking)'),
  'a count over every parcel would show a stranger’s shipments as yours',
);
check('the hub count is the hub list’s length', code.includes('hubs.length'), '');
check(
  'the balance is read from the ledger',
  code.includes('fetchBalance()') && code.includes('balance.available'),
  'a rendered balance that is not the ledger’s is a number somebody will act on',
);
check(
  'and it says nothing at all until it has arrived',
  /balance \?[\s\S]{0,400}<ActivityIndicator/.test(code),
  'defaulting to ₦0 while loading tells a driver they have earned nothing',
);

// --------------------------------- no feature is implied that does not exist --

/*
 * ⚠ Named individually, because each is a separate promise.
 *
 *   These were dropped after checking the schema: there is no saved-address
 *   table, no stored payment method, and no preferences. If one is built
 *   later, its tile arrives with it — and this list is where somebody will
 *   notice they have to remove a line here to add one there.
 */
for (const absent of ['Saved Addresses', 'Payment Methods', 'Delivery Preferences', 'Top Up']) {
  check(
    `no tile promises ${JSON.stringify(absent)}`,
    !code.includes(absent),
    'nothing in the app or the schema backs this, so the tile would be a tap into nothing',
  );
}

check(
  'the wallet row says it is earnings',
  code.includes('Wallet — earnings'),
  'calling a payout-only ledger "Wallet Balance" invites somebody to try to spend it',
);

/*
 * Every tile has to go to a route that exists. A grid of four is exactly where
 * a dead link hides, because the tile still looks right.
 */
const tileRoutes = [...code.matchAll(/router\.push\('\/\(tabs\)\/([a-z-]+)'\)/g)].map(
  (match) => match[1],
);
check('the grid routes somewhere', tileRoutes.length >= 4, `${tileRoutes.length} routes found`);
for (const route of new Set(tileRoutes)) {
  try {
    read(`src/app/(tabs)/${route}.tsx`);
  } catch {
    check(`/${route} exists`, false, 'a tile pointing at a route with no screen is a dead end');
  }
}

// ------------------------------------- roles do not leak across the screen --

check(
  'the driver toggle is offered only to approved drivers',
  /isApprovedDriver \?[\s\S]{0,400}<ToggleRow/.test(code),
  'a toggle that is refused server-side and springs back is worse than no toggle',
);
check(
  'and the wallet row with it',
  /isApprovedDriver &&[\s\S]{0,200}styles\.walletRow/.test(code),
  'a sender has no balance, and a row reading ₦0 implies they could have one',
);
check(
  'a sender is not asked for a balance at all',
  /if \(!isApprovedDriver\) \{[\s\S]{0,120}return;/.test(code),
  'calling a driver-only RPC from every sender’s device is a failing request per load',
);

// ------------------------ editing still goes through review, not around it --

/*
 * ⚠ The important assertion in this file.
 *
 *   `29_driver_profile_edits.sql` classes name and phone as high risk: for a
 *   driver, changing either suspends approval and files both values for an
 *   admin. `auth.updateUser` writes `user_metadata` with none of that. An
 *   inline editor calling it directly would change the name a sender sees on
 *   the person collecting their parcel, leave the vetted application untouched
 *   and raise no review — a hole opened by adding a convenience.
 */
check(
  'the screen never writes metadata itself',
  !code.includes('auth.updateUser'),
  'the branch belongs in one place, not in whichever screen grows an editor next',
);
check(
  'it saves through the one function that knows the difference',
  code.includes('saveOwnDetails('),
  '',
);
check(
  'a driver’s edit goes to update_driver_profile',
  /if \(hasDriverApplication\) \{[\s\S]{0,200}saveProfile\(patch\)/.test(details),
  'the RPC is what suspends approval and records the old value for review',
);
check(
  'and any application counts, not just an approved one',
  details.includes('hasDriverApplication') && !details.includes('isApprovedDriver'),
  'a pending application is being read by an admin right now — editing it underneath them is the same bug',
);
check(
  'the screen passes whether an application exists',
  code.includes('hasApplication={Boolean(application)}'),
  'passing isApprovedDriver here would route a pending applicant down the metadata path',
);
check(
  'a suspension is announced rather than logged',
  code.includes('Sent for review') && code.includes('approval is paused'),
  'somebody who tapped a pencil to fix a typo and is now off the road has to be told',
);
check(
  'and warned before they save, not only after',
  code.includes('pauses your driver approval until an admin reviews it'),
  'the cost of a high-risk edit is worth knowing while it can still be cancelled',
);

/*
 * ⚠ Email is not editable here, and must not pretend to be.
 *
 *   It is the login and the address every confirmation goes to; changing it is
 *   an auth flow that re-confirms the new address first. A chevron opening an
 *   editor that then silently did nothing is worse than a row that does not
 *   open.
 */
/*
 * Sliced to the element's own closing `/>`. A fixed character window ran past
 * it into the phone row below, found that row's `onPress` and failed against
 * correct code.
 */
const emailAt = code.indexOf('label="Email address"');
const emailRow = code.slice(emailAt, code.indexOf('/>', emailAt));
check(
  'the email row offers no editor',
  emailAt >= 0 && !emailRow.includes('onPress='),
  'a row that opens an editor which cannot save is worse than one that does not open',
);

// ------------------------------------------------------- honest absences --

check(
  'a missing join date is omitted rather than guessed',
  /*
   * `{joined && (` became `{!!joined && (` — a bare string guard renders the
   * empty string as a text node, which react-native-web refuses inside a
   * `<View>`. The rule this assertion cared about is unchanged: the row is
   * conditional on there being a date at all.
   */
  details.includes('if (!createdAt) return null') && /\{!!joined && \(/.test(code),
  '"Member since January 1970" is what a silent fallback to zero produces',
);
check(
  'an unparseable date is treated the same way',
  details.includes('Number.isNaN(at.getTime())'),
  '',
);
check(
  'and memberSince actually returns null for both',
  memberSince(null) === null && memberSince('not a date') === null,
  'asserted as behaviour, because this is the branch that renders 1970',
);
check(
  'a real date still formats',
  (memberSince('2023-03-14T00:00:00Z') ?? '').includes('2023'),
  'guarding against a null-returning stub that would pass every check above',
);

/*
 * ⚠ Verification has four states and only one of them is a green tick.
 *
 *   Collapsing them to verified/not tells somebody mid-review they have
 *   failed, and somebody flagged that they are fine. Flagged is a support
 *   conversation, not a retry.
 */
for (const state of ['verified', 'pending', 'flagged', 'unverified']) {
  check(
    `the badge handles ${state}`,
    code.includes(`${state}:`),
    'a missing state renders nothing',
  );
}

// ------------------------------------------------------- it is reachable --

check(
  'something links to the profile screen',
  menu.includes("router.push('/profile')"),
  'a route with no door is only reachable by typing the URL',
);

// ------------------------------------- the settings menu's account card --

const menuCode = menu
  .replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/*
 * ⚠ The email appeared three times on one small sheet.
 *
 *   Under the title, then again as the subtitle of the identity row below it.
 *   Repetition in a menu this size reads as a rendering bug rather than as
 *   emphasis.
 */
check(
  'the header no longer prints the email',
  !/styles\.title[\s\S]{0,400}user\?\.email/.test(menuCode),
  'it was stated under the title and again in the card a few pixels down',
);
check(
  'but a signed-out visitor is still told so',
  menuCode.includes('Not signed in'),
  'an empty menu with no explanation is worse than a redundant line',
);

/*
 * ⚠ One target for one destination.
 *
 *   The identity row and the profile link were adjacent, looked alike, and only
 *   one of them did anything. Merging them is the change; asserting the card is
 *   pressable *and* that the passive row is gone is what stops it drifting back
 *   into two.
 */
const cardAt = menuCode.indexOf('styles.accountCard');
check('the account card exists', cardAt >= 0);

/*
 * The card's own element, bounded by its closing tag rather than by a
 * character count — prettier reflowed it past a fixed window and this failed
 * against correct markup.
 */
const card = menuCode.slice(
  Math.max(0, menuCode.lastIndexOf('<Pressable', cardAt)),
  menuCode.indexOf('</Pressable>', cardAt),
);
check(
  'the whole card navigates to the profile',
  card.includes("router.push('/profile')") && card.includes('<Pressable'),
  'a chevron on something that is not pressable is a control that does nothing',
);
check(
  'it carries an avatar, the name and a chevron',
  card.includes('styles.avatar') && card.includes('user?.name') && card.includes('<ChevronRight'),
  '',
);
check(
  'the helper text says what is on the other side',
  card.includes('View personal info, NIN and verification'),
  'helper text under a link is a promise about where the tap goes',
);
check(
  'and it does not print the email again',
  !card.includes('user?.email'),
  'the address it replaced was the redundancy this change is about',
);
check(
  'the passive identity row is gone rather than merely unused',
  !menuCode.includes('function Row('),
  'leaving it behind invites somebody to render it next to the card and restore the duplication',
);

/*
 * ⚠ The helper text names the NIN, so the NIN has to be there.
 *
 *   It was not, until this change added the row. Copy is the cheapest thing to
 *   write and the easiest to leave pointing at nothing.
 */
check(
  'the profile screen actually shows a NIN',
  code.includes('label="NIN"') && code.includes('ninLast4'),
  'the settings card promises it — either the row exists or the promise is false',
);
check(
  'and only its last four digits',
  code.includes('•••• •••• ${ninLast4}') || /`[^`]*\$\{ninLast4\}`/.test(code),
  'the full number is sensitive personal data under the NDPA and never leaves the server',
);
check(
  'the NIN row is not editable',
  !/label="NIN"[\s\S]{0,300}onPress=/.test(code),
  'changing a verified NIN is a re-verification, not a text edit',
);

/*
 * Sign out sits apart. Flush against the account card it reads as part of it,
 * and it is the one irreversible action in the sheet.
 */
// --------------------------------------------------------- the header ----

const nav = read('src/components/ui/app-nav-bar.tsx');
const header = read('src/components/ui/screen.tsx');

/*
 * ⚠ The gear is gone from every screen, not hidden on this one.
 *
 *   A previous pass hid it on `/profile` only, on the reasoning that removing
 *   it globally would strip role switching and sign out from twenty other
 *   screens. That reasoning was wrong: the avatar sitting beside it already
 *   opened the same sheet, so nothing was ever reachable through the gear
 *   alone. Two controls onto one destination is a choice the reader has to
 *   make for no benefit.
 */
check(
  'there is no settings gear anywhere in the nav bar',
  !nav.includes('<Settings color'),
  'it opened the same sheet as the avatar next to it',
);
check(
  'and the avatar is the way in',
  nav.includes('const openAccountMenu = () => setSettingsOpen(true)') &&
    nav.includes('onPress={isAuthenticated ? openAccountMenu : goToSignIn}'),
  'removing the gear is only safe because the avatar reaches the same place — and sends a signed-out visitor straight to sign-in, which is all that sheet offers them',
);
check(
  'the route-specific hiding went with it',
  !nav.includes("matchesHref(pathname, '/profile')"),
  'a condition guarding a control that no longer exists reads as live code and is not',
);

check('the screen is titled My Profile', code.includes('title="My Profile"'), '');

/*
 * ⚠ The back arrow needs somewhere to go when there is no history.
 *
 *   Opened from a link, a bookmark or a reload, the stack is empty and
 *   `router.back()` does nothing at all — an arrow that silently refuses is
 *   worse than no arrow.
 */
check(
  'the back arrow handles an empty history',
  /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\(/.test(code),
  'router.back() on an empty stack is a control that does nothing',
);
check(
  'the header renders the arrow beside the title',
  header.includes('styles.titleRow') && header.includes('<ArrowLeft'),
  '',
);
check(
  'and the arrow is opt-in rather than on every screen',
  header.includes('onBack ? (') && header.includes('onBack?: () => void'),
  'a back arrow on a top-level tab either does nothing or reverses a tab switch',
);

/*
 * ⚠ No Edit button in the header, deliberately.
 *
 *   The avatar carries a pencil and each editable row carries a chevron. A
 *   third control for the same job would also be the vaguest of the three —
 *   it would not say what it edits.
 */
check(
  'the header carries no third edit control',
  !/<ScreenHeader[\s\S]{0,300}[Ee]dit/.test(code),
  'the avatar pencil and the row chevrons already edit; a header Edit would not say what it edits',
);
check(
  'the pencil on the avatar is still there',
  code.includes('accessibilityLabel="Edit your details"'),
  'removing the header action must not leave the screen with no edit affordance at all',
);

check(
  'sign out is in its own block',
  menuCode.includes('styles.signOutBlock'),
  'the one irreversible action should not be a neighbour of the one people open the menu for',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — nothing from the mockup was hardcoded, every count and the balance are read,\n' +
    '       no tile promises a feature that does not exist, the driver toggle and wallet\n' +
    '       appear only for approved drivers, and a name or phone change still goes\n' +
    '       through review rather than straight into auth metadata.',
);
