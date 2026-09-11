/**
 * Assertions for the driver wallet.
 *
 * The ledger itself is proven by execution — `scripts/pg/wallet-harness.mjs`
 * runs the migration in PGlite and checks the arithmetic against real Postgres.
 * This file covers the part a harness cannot see: whether the screen a driver
 * actually opens tells them the truth about the money, and whether they can get
 * to it at all.
 *
 * Three of these exist because of mistakes already made on this project:
 * a screen added to the web dropdown and left unreachable on the phone
 * (`/available-packages` and the offer card), a caveat asserted by pinning a
 * string that a rename walks straight past, and a route added without a
 * `ROUTE_EXPERIENCES` line quietly appearing in the sender app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tabsFor } from '../src/components/ui/bottom-tab-bar';
import { routeAllowed } from '../src/lib/experience';
import {
  canRequest,
  naira,
  payoutStatusLine,
  EMPTY_BALANCE,
  type Balance,
  type OpenPayout,
} from '../src/store/wallet';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const screen = read('src/app/(tabs)/driver-wallet.tsx');
const store = read('src/store/wallet.ts');
const navBar = read('src/components/ui/app-nav-bar.tsx');
const sql = read('supabase/migrations/20250101000030_driver_wallet.sql');

/** Strips comments, so an assertion cannot be satisfied by prose about it. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// --------------------------------------------------- the balance arithmetic --

const balance = (over: Partial<Balance> = {}): Balance => ({ ...EMPTY_BALANCE, ...over });
const openPayout: OpenPayout = { id: 'p1', amount: 3000, requestedAt: new Date().toISOString() };

check(
  'a driver with money and no open request can ask for it',
  canRequest(balance({ earned: 6000, available: 6000 }), null, 1000),
);
check(
  'a driver with an open request cannot ask again',
  !canRequest(balance({ earned: 6000, available: 3000 }), openPayout, 1000),
  'the one-open-request index would refuse it, but only after the button had promised otherwise',
);
check(
  'below the minimum the button does nothing',
  !canRequest(balance({ earned: 900, available: 900 }), null, 1000),
);
check('an empty balance cannot be withdrawn', !canRequest(EMPTY_BALANCE, null, 1000));

/*
 * The exactly-at-minimum case, which is the one an off-by-one gets wrong.
 *
 * `request_payout` refuses `wanted < minimum`, so ₦1,000 against a ₦1,000
 * minimum is allowed. A client using `>` here would grey out a button the
 * server would have honoured, and the driver has no way to discover that.
 */
check(
  'exactly the minimum is allowed, matching the server',
  canRequest(balance({ earned: 1000, available: 1000 }), null, 1000),
  'the SQL refuses `wanted < minimum`, so the boundary belongs to the driver',
);
check(
  'and the SQL really does use a strict less-than',
  /if wanted < minimum then/.test(sql),
  'if the server ever moves to <=, the check above becomes a lie in the driver’s favour',
);

// ------------------------------------------------- what the screen says why --

/*
 * Every branch of the status line names a *reason*. A driver looking at a
 * disabled Request button with no sentence next to it has no way to tell a hold
 * from a minimum from a request they already made — three different situations
 * with three different next steps.
 */
check(
  'a hold explains itself in hours',
  payoutStatusLine(balance({ earned: 5000, onHold: 5000 }), null, 24, 1000).includes('24-hour'),
);
check(
  'money below the minimum says what the minimum is',
  payoutStatusLine(balance({ earned: 500, available: 500 }), null, 24, 1000).includes(naira(1000)),
);
check(
  'an open request says Package Relay transfers by hand',
  /manually|by hand/i.test(payoutStatusLine(balance(), openPayout, 24, 1000)),
  'a "Processing" chip with no sentence reads as an automated payout rail',
);
check(
  'a driver who has earned nothing is told how to start, not that they are broke',
  payoutStatusLine(EMPTY_BALANCE, null, 24, 1000).includes('Deliver a parcel'),
);
check(
  'and money ready to withdraw is stated as such',
  payoutStatusLine(balance({ earned: 5000, available: 5000 }), null, 24, 1000).includes(
    'ready to withdraw',
  ),
);

/*
 * The four branches must be distinguishable from each other. Asserting each
 * one's wording separately would still pass if two of them returned the same
 * sentence, which is exactly the bug that makes the line useless.
 */
const lines = new Set([
  payoutStatusLine(balance({ earned: 5000, onHold: 5000 }), null, 24, 1000),
  payoutStatusLine(balance({ earned: 500, available: 500 }), null, 24, 1000),
  payoutStatusLine(balance(), openPayout, 24, 1000),
  payoutStatusLine(EMPTY_BALANCE, null, 24, 1000),
  payoutStatusLine(balance({ earned: 5000, available: 5000 }), null, 24, 1000),
]);
check('the five situations produce five different sentences', lines.size === 5, `${lines.size}/5`);

// -------------------------------------------------- honesty about transfers --

/*
 * The one claim this screen must never make.
 *
 * `settle_payout` records that a human sent money; nothing in Package Relay moves it. A
 * balance, a button and a tidy status chip read exactly like an automated rail,
 * so the manual step is stated in the schedule line, the confirmation and the
 * footnote. Asserted on stripped code so a comment saying so cannot pass it.
 */
check(
  'the screen states that Package Relay transfers by hand',
  /by hand|manually/i.test(code(screen)),
  'a wallet that shows a balance and a button implies an automated payout rail',
);
check(
  'and says what "paid" actually means, with a way to challenge it',
  /someone at Package Relay made\s+the transfer/.test(code(screen)) && /contact support/i.test(code(screen)),
  'a driver whose bank disagrees with a row marked paid needs to know the row is a human claim',
);
check(
  'the SQL agrees that settling is a record, not a transfer',
  /does not transfer anything/i.test(sql),
);

// --------------------------------------------- one bank-change path, not two --

/*
 * The 48-hour cooling window in `20250101000016_driver_identity.sql` is the only control
 * stopping a hijacked session redirecting the next payout. A wallet screen with
 * its own bank form would be a second door past it.
 */
/*
 * Pinned to the guard, not to the name.
 *
 * `includes('PayoutAccountCard')` was the first version of this and it was
 * worthless: the import line alone satisfies it, so gating the card out with
 * `{false && ...}` passed. Mutation testing caught that. The condition is the
 * thing worth asserting — the card renders whenever there is an application.
 */
check(
  'the payout method card is the existing one, and actually renders',
  /\{application && \(\s*<PayoutAccountCard/.test(code(screen)),
  'a second bank-edit path would route around the 48-hour cooling window',
);
check(
  'and the wallet writes no bank details of its own',
  !/bank_name|account_number/.test(code(screen)),
  'the account on a payout row is snapshotted server-side by request_payout',
);

/*
 * ---------- the portal and the wallet are different pages ----------
 *
 * They were not. The payout account card rendered on both, and the portal
 * additionally showed an "Expected payout" total — gross, counting parcels
 * still moving — a click away from a wallet balance that is net of commission,
 * delivered-only and less a hold. Two money figures that disagree, and one bank
 * form duplicated between them.
 *
 * The split is by subject: the portal is identity and work, the wallet is
 * money. Asserted in both directions, because "no duplication" is satisfied by
 * deleting the wrong copy.
 */
const portal = read('src/app/(tabs)/driver.tsx');

check(
  'the payout account card renders on the wallet and nowhere else',
  /<PayoutAccountCard/.test(code(screen)) && !/PayoutAccountCard/.test(code(portal)),
  'two copies of the bank form is two paths to the 48-hour window',
);
/*
 * Banning `formatNaira` outright was the first version and it failed — for a
 * good reason. Per-parcel fares still belong on a job card; what does not
 * belong is a *total*, or a fare labelled as earnings.
 *
 * The label is the substantive half. A delivered card reading "Earned ₦4,000"
 * next to a wallet crediting ₦3,400 for the same trip is the Expected-payout
 * contradiction again, one parcel at a time.
 */
check(
  'the portal states no money total of its own',
  !/Expected payout/.test(code(portal)),
  'a gross total one click from a net balance invites the driver to trust the larger one',
);
check(
  'and calls per-parcel amounts fares rather than earnings',
  !/'Earned'/.test(code(portal)),
  'the fare is gross; what the driver earns on it is the fare less commission',
);
/*
 * ⚠ This assertion is inverted from how it started, and the flip is the point.
 *
 *   It first demanded the portal *link* to the wallet — "removing the figure
 *   without a signpost is a deletion, not a split". That was right while the
 *   wallet had no home of its own. It has one now, on both surfaces, so an
 *   in-page button was a third route to a screen already one click away in the
 *   same dropdown the driver used to get here.
 *
 *   Asserting the absence rather than deleting the check quietly: an in-page
 *   link is the obvious thing to re-add during a future "make the wallet easier
 *   to find" pass, and this is where the reason it was removed lives.
 *
 *   The cost of this is real and named: the wallet's reachability now rests
 *   entirely on the nav and tab assertions above. They are no longer a tidiness
 *   check.
 */
check(
  'the portal carries no wallet link either, because navigation does',
  !/driver-wallet/.test(code(portal)),
  'a button one row under a dropdown containing the same destination is a third route to one screen',
);
check(
  'and the wallet is the only screen calling the ledger',
  /rpc\('driver_balance'\)/.test(code(store)) && !/driver_balance/.test(code(portal)),
);

/*
 * The portal's read-only footnote must not contradict the profile editor.
 *
 * It said "email support" for months after `update_driver_profile` shipped —
 * copy telling someone to email support for a job the app now does.
 */
/*
 * `code(portal)`, not `portal` — the comment above this footnote explains the
 * change and mentions "Be a Driver / Updates", so the uncommented file would
 * have satisfied this assertion with the footnote reverted. Same trap as the
 * PayoutAccountCard import.
 */
check(
  'the portal points at the profile editor rather than at support',
  /Be a Driver \/ Updates/.test(code(portal)) &&
    !/Email support if anything has changed/.test(code(portal)),
  'an approved driver can change their own plate and address; the footnote denied it',
);

// ------------------------------------------------------ the money is fetched --

check(
  'the balance comes from the ledger, not from summing fares',
  code(store).includes("rpc('driver_balance')") && !code(store).includes('estimatedFee'),
);
check(
  'the hold and the minimum are read from the server, not hard-coded',
  code(store).includes("rpc('payout_hold_hours')") && code(store).includes("rpc('minimum_payout')"),
  'both live in private.app_settings so they can change without a release',
);
check(
  'the open request is scoped to the signed-in driver, not left to RLS alone',
  /\.eq\('driver_id', userId\)/.test(code(store)),
  'read own payouts also admits is_admin(), so maybeSingle would throw for staff who drive',
);
check(
  'server refusals reach the driver verbatim',
  code(store).includes('error: error.message'),
  '"You can withdraw up to ₦4,500" names the next step; "could not save" does not',
);

// ------------------------------------------------------------ reachability --

/*
 * The failure this whole section exists for: a screen in the web dropdown and
 * nowhere on the phone. The capsule is web-only, so for a native driver the tab
 * bar is the entire navigation.
 */
check(
  'a driver on a phone has a wallet tab',
  tabsFor('driver').some((tab) => tab.href === '/driver-wallet'),
  'the nav capsule is web-only — without a tab this screen is unreachable on the device it is for',
);
check('a sender does not', !tabsFor('sender').some((tab) => tab.href === '/driver-wallet'));
check(
  'and the tab points somewhere the driver experience allows',
  routeAllowed('/driver-wallet', 'driver'),
);
check('the web dashboard has it too', routeAllowed('/driver-wallet', 'web'));
check(
  'the sender app does not',
  !routeAllowed('/driver-wallet', 'sender'),
  '/driver-wallet does not match the /driver prefix — segment-wise matching means it needs its own line',
);

/*
 * Position in the dropdown, asserted by index rather than by the labels being
 * present.
 *
 * The brief was specific: the wallet sits in the middle of the driver's arc —
 * after the dashboard they work from, before the guidelines they look things up
 * in. Checking only that all three strings appear would pass with the wallet at
 * the bottom.
 *
 * Matched on href rather than label, and anchored to the following `icon:` line
 * so the group's own top-level href does not count as a child. Labels here have
 * already been rewritten twice; the routes have not moved.
 */
const order = ['/driver', '/driver-wallet', '/driver-guidelines'].map((href) =>
  navBar.indexOf(`href: '${href}',\n        icon`),
);
check(
  'all three dropdown entries exist',
  order.every((index) => index > 0),
  JSON.stringify(order),
);
check(
  'the wallet sits between the dashboard and the reference material',
  order[0] < order[1] && order[1] < order[2],
  `found at ${JSON.stringify(order)}`,
);
check('and the dropdown entry points at the route', /href: '\/driver-wallet'/.test(navBar));
check(
  'the Jobs & Drivers link stays underlined on the wallet',
  navBar.includes("'/driver-wallet',") && /also: \[[\s\S]*?'\/driver-wallet'/.test(navBar),
  'four of five destinations behind that dropdown would otherwise show nothing as selected',
);

/*
 * The tab bar's own ordering: money before settings. Settings is a sheet and
 * belongs last; a wallet buried behind it is one tap further than a driver
 * checking whether they have been paid should need.
 */
const driverTabs = tabsFor('driver').map((tab) => tab.key);
check(
  'the wallet tab comes before settings',
  driverTabs.indexOf('wallet') < driverTabs.indexOf('account'),
  driverTabs.join(' → '),
);
check(
  'and the route is registered with the navigator',
  read('src/app/(tabs)/_layout.tsx').includes('name="driver-wallet"'),
  'an unregistered screen in the tabs group is a blank route on native',
);

// ------------------------------- the two numbers must not silently disagree --

/*
 * The Expected total and the wallet balance are different figures for the same
 * work — gross versus net, all parcels versus delivered, before versus after
 * the hold. That is correct and unavoidable, which is why the screen showing
 * the larger one has to name the smaller one as the real balance.
 */
const sheet = read('src/components/ui/earnings-sheet.tsx');

/*
 * Pinned to the caveat itself, not to the file.
 *
 * `/Driver Wallet/.test(sheet)` was the first version and it survived deleting
 * the entire caveat — the words still appeared in the button label and in a
 * comment. Mutation testing caught that. What has to be true is narrower: the
 * *visible caveat*, the sentence a driver reads above the total, says both that
 * this is before commission and that the wallet is the real balance.
 */
check(
  'the earnings sheet caveat names commission and points at the wallet',
  /styles\.caveat[\s\S]{0,400}?commission[\s\S]{0,300}?Driver Wallet/.test(code(sheet)),
  'two screens showing different totals for the same work, with neither claiming to be the balance',
);
check(
  'and no longer claims there is no ledger',
  !/no payout ledger|does not track payouts/i.test(sheet),
  'the ledger exists now; the stale caveat would be the app calling itself a liar',
);
check(
  'nor does the driver portal or the guidelines',
  !/no payout ledger/i.test(read('src/app/(tabs)/driver.tsx')) &&
    !/no payout ledger/i.test(read('src/constants/driver-guidelines.ts')),
);

// ----------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failing assertion${failures === 1 ? '' : 's'}.`);
  process.exit(1);
}

console.log(
  'PASS — the wallet reads its balance from the ledger rather than from quoted fares, the\n' +
    '       button matches the server at the exact minimum, every disabled state says why,\n' +
    '       the screen never implies Package Relay moves money on its own, bank changes still go\n' +
    '       through the 48-hour window, and a driver on a phone can actually reach it.',
);
