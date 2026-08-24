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
  details.includes('if (!createdAt) return null') && code.includes('{joined && ('),
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
