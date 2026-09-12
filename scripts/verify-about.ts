/**
 * Assertions for the About Us group.
 *
 * The privacy notice is the part that matters. A page listing what an app
 * collects is only worth anything if it is *complete* — an undisclosed field is
 * the whole failure mode — so this reads the SQL and checks that every
 * sensitive column is accounted for in the notice.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHANNELS, CONTACT_IS_PLACEHOLDER, SELF_SERVE } from '../src/constants/contact';
import {
  DATA_COLLECTED,
  LEGAL_REVIEW_REQUIRED,
  LEGAL_SECTIONS,
  LEGAL_SECTION_LABELS,
  PROCESSORS,
  RETENTION_UNDECIDED,
  TERMS,
  TERMS_GAPS,
  YOUR_RIGHTS,
  parseLegalSection,
} from '../src/constants/legal';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

// --------------------------------------------------------- route coverage ---

const navSource = read('src/components/ui/app-nav-bar.tsx');

const DROPDOWN: Record<string, string> = {
  'About Package Relay': 'about',
  'Support / Contact Us': 'support',
  'Terms of Service & Privacy Policy': 'legal',
};

for (const [label, route] of Object.entries(DROPDOWN)) {
  check(`the nav offers "${label}"`, navSource.includes(label));

  let exists = true;
  try {
    read(`src/app/(tabs)/${route}.tsx`);
  } catch {
    exists = false;
  }
  check(`"${label}" resolves to a real screen`, exists, `src/app/(tabs)/${route}.tsx is missing`);
}

check(
  'About Us claims its two extra routes for the active state',
  navSource.includes("also: ['/support', '/legal']"),
  'otherwise the nav shows nothing selected on Support and Legal',
);

/*
 * The last links open their menu leftwards. Without this the 296px panel hangs
 * off the right of the capsule, where there is only the role pill and the
 * avatar — so half of it lands outside the viewport.
 */
/*
 * A parent with children must not navigate.
 *
 * Every grouped `href` is the same destination as that group's first child, so
 * a navigating heading looked exactly like the app picking option one — which
 * is what it was doing. The press has to toggle the menu instead.
 */
check(
  'a parent toggles its menu rather than navigating',
  navSource.includes('if (!hasChildren) {') && navSource.includes('onSubmenuChange(!submenuOpen)'),
  'a heading that navigates jumps straight to its first child',
);
check(
  'and announces itself as a menu, not a link',
  navSource.includes("accessibilityRole={hasChildren ? 'button' : 'link'}") &&
    navSource.includes('hasChildren ? { expanded: submenuOpen } : { selected: active }'),
  '"link, selected" promises navigation that does not happen',
);
/*
 * The drawer is an accordion, not a permanently expanded list.
 *
 * Every group used to be open at once. Eleven children across four groups
 * turned the drawer into a wall on a phone and pushed About Us and Admin below
 * the fold — so the last two entries became the hardest to reach rather than
 * the easiest.
 */
check(
  'a drawer group toggles rather than navigating',
  navSource.includes('setExpanded(isOpen ? null : link.key)') &&
    navSource.includes('accessibilityState={{ expanded: isOpen }}'),
  'its children sit directly below it, so a navigating header picks one for you',
);
check(
  'children render only when their group is open',
  navSource.includes('{isOpen &&'),
  'permanently expanded is what buried the last two groups',
);
check(
  'one group at a time',
  navSource.includes('useState<string | null>(null)') && !navSource.includes('Set<string>'),
  'two groups expanded is most of the scroll back',
);
check(
  'the group holding the current page opens automatically',
  navSource.includes('links.find((link) => link.children && isActive(pathname, link))'),
  'someone deep in the driver screens should see those siblings without hunting',
);
check(
  'and that is recomputed each time the drawer opens',
  navSource.includes('}, [open, pathname, links]);'),
  'the route changes underneath a drawer that stays mounted',
);

check(
  'the rightmost dropdowns are end-aligned',
  navSource.includes('alignEnd={index >= navLinks.length - 2}') && navSource.includes('submenuEnd'),
  'a right-hand dropdown anchored from the left overflows the screen',
);

/*
 * Stacking inside the sticky header.
 *
 * The navbar and the live ticker are siblings. Without an explicit z-index on
 * each they stack in document order, and the ticker — rendered second — drew
 * over any open dropdown, hiding its first item behind the "No parcels moving
 * right now" bar. Asserted on both files because a fix applied to only one of
 * them is a fix that survives until the next person reorders the header.
 */
const stickyHeader = read('src/components/ui/sticky-header.tsx');

const navZ = /wrapper:\s*\{[^}]*zIndex:\s*(\d+)/s.exec(navSource);
const tickerZ = /ticker:\s*\{[^}]*zIndex:\s*(\d+)/s.exec(stickyHeader);

check('the navbar wrapper declares a z-index', navZ !== null, 'nothing lifts it above the ticker');
check('the ticker declares one too', tickerZ !== null, 'implicit order is what caused the bug');
check(
  'and the navbar sits above the ticker',
  Number(navZ?.[1] ?? 0) > Number(tickerZ?.[1] ?? 0),
  `navbar ${navZ?.[1]} vs ticker ${tickerZ?.[1]}`,
);

/*
 * Nothing in the header may clip. An `overflow: 'hidden'` anywhere on the
 * chain would crop the dropdown at the header's edge no matter how the z-index
 * is arranged — and it is the obvious thing to reach for when tidying a layout.
 */
/**
 * Comments stripped before searching.
 *
 * Both files *discuss* `overflow: 'hidden'` in prose — the capsule carries a
 * comment explaining why it must not be used — so a naive search finds the
 * warning and reports it as the thing being warned about.
 */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check(
  'the sticky header does not clip its children',
  !/overflow:\s*'hidden'/.test(withoutComments(stickyHeader)),
  'an open dropdown extends past the header box by design',
);
check(
  'and neither does the capsule',
  !/overflow:\s*'hidden'/.test(withoutComments(navSource)),
  "the capsule comment already warns about this — it also crops the capsule's own iOS shadow",
);

// --------------------------------------- the privacy notice vs the schema ---

const bookingsSql = read('supabase/migrations/20250101000001_bookings.sql');
const applicationsSql = read('supabase/migrations/20250101000002_driver_applications.sql');
// Coordinates arrived in 04, not 01 — the notice covers the schema as a whole,
// so the check has to look where each column actually lives.
const coordinatesSql = read('supabase/migrations/20250101000004_realtime_and_coordinates.sql');
const storageSql = read('supabase/migrations/20250101000005_storage_and_alerts.sql');
const draftSource = read('src/hooks/use-form-draft.ts');

const notice = DATA_COLLECTED.map((item) => `${item.what} ${item.why} ${item.who}`)
  .join(' ')
  .toLowerCase();

/**
 * Columns whose disclosure is not optional, and the word the notice must use.
 *
 * Each is asserted to exist in the SQL *and* be described in the notice. The
 * first half stops the notice describing a field that was removed; the second
 * stops a field being collected without ever being mentioned.
 */
const SENSITIVE: { column: string; sql: string; mustSay: string }[] = [
  { column: 'nin', sql: applicationsSql, mustSay: 'national identification number' },
  { column: 'account_number', sql: applicationsSql, mustSay: 'account number' },
  { column: 'bank_name', sql: applicationsSql, mustSay: 'bank name' },
  { column: 'guarantor_nin', sql: applicationsSql, mustSay: 'guarantor' },
  { column: 'kin_phone', sql: applicationsSql, mustSay: 'next-of-kin' },
  { column: 'license_id', sql: applicationsSql, mustSay: 'licence' },
  { column: 'plate_number', sql: applicationsSql, mustSay: 'plate' },
  { column: 'recipient_phone', sql: bookingsSql, mustSay: 'recipient name and phone' },
  { column: 'pickup_address', sql: bookingsSql, mustSay: 'addresses' },
  { column: 'declared_value', sql: bookingsSql, mustSay: 'declared value' },
  { column: 'pickup_lat', sql: coordinatesSql, mustSay: 'coordinates' },
];

for (const item of SENSITIVE) {
  check(
    `${item.column} still exists in the schema`,
    item.sql.includes(item.column),
    'the notice describes a column that is no longer there',
  );
  check(
    `the privacy notice discloses ${item.column}`,
    notice.includes(item.mustSay),
    `nothing in DATA_COLLECTED mentions "${item.mustSay}"`,
  );
}

check(
  'the private document bucket is disclosed',
  storageSql.includes("'driver-documents'") && notice.includes('documents you upload'),
);
check(
  'the notice says documents are opened through short-lived links',
  notice.includes('signed links') || notice.includes('short-lived'),
  'a private bucket is only private because the links expire — that is the claim being made',
);

check(
  'the on-device draft is disclosed',
  draftSource.includes('DRAFT_KEYS') && notice.includes('draft'),
  'the draft holds a NIN and bank details in localStorage on web',
);
check(
  'and the notice states its 24-hour expiry',
  notice.includes('24 hours'),
  'the expiry is the mitigation, so it is the part worth stating',
);

// --------------------------------------------------- processors and gaps ----

const processorText = PROCESSORS.map((p) => `${p.name} ${p.shares}`)
  .join(' ')
  .toLowerCase();

check('Supabase is disclosed as the host', processorText.includes('supabase'));
check(
  'OpenStreetMap is disclosed',
  processorText.includes('openstreetmap') && processorText.includes('ip address'),
  'an embedded map sends the viewer IP to a third party — easy to forget, still a disclosure',
);
check(
  'the Slack alert is disclosed as excluding the sensitive fields',
  processorText.includes('slack') &&
    processorText.includes('not your nin') &&
    read('supabase/migrations/20250101000005_storage_and_alerts.sql').includes('Deliberately NOT sent'),
  'the claim on the page must match what the trigger actually sends',
);
check(
  'the email provider is disclosed as excluding them too',
  processorText.includes('resend') && processorText.includes('never your nin'),
);

// ---------------------------------------------------------- honest gaps -----

check(
  'the terms are still flagged as unreviewed',
  LEGAL_REVIEW_REQUIRED,
  'flip this only after a lawyer has actually read it',
);

const legalScreen = read('src/app/(tabs)/legal.tsx');
check(
  'the screen shows the unreviewed banner',
  legalScreen.includes('LEGAL_REVIEW_REQUIRED'),
  'a terms page that looks finished is worse than none',
);
check(
  'and it lists what is missing',
  legalScreen.includes('TERMS_GAPS') && TERMS_GAPS.length >= 5,
  String(TERMS_GAPS.length),
);
check(
  'liability and insurance are named as absent',
  TERMS_GAPS.join(' ').toLowerCase().includes('liability') &&
    TERMS_GAPS.join(' ').toLowerCase().includes('insurance'),
  'these are the two people assume exist',
);

check(
  'the missing retention policy is surfaced, not buried',
  RETENTION_UNDECIDED && legalScreen.includes('RETENTION_UNDECIDED'),
  'holding a rejected applicant NIN forever is the NDPR exposure',
);

/*
 * The terms must not claim protections the app does not implement. There is no
 * insurance and no refund path — a clause implying otherwise is the kind of
 * thing someone relies on at the worst moment.
 *
 * A payout ledger used to be on that list and no longer is: `30_driver_wallet
 * .sql` records earnings and payouts. What is still absent is any *transfer* —
 * `settle_payout` records that a human sent money, it does not send it — so
 * terms promising automatic or scheduled payment would be the same mistake in
 * a new place.
 */
const termsText = TERMS.map((c) => `${c.title} ${c.body}`)
  .join(' ')
  .toLowerCase();
check(
  'the terms state that nothing is insured',
  termsText.includes('not insured') || termsText.includes('does not buy cover'),
  termsText.slice(0, 120),
);
check(
  'and that there is no refund mechanism',
  termsText.includes('no refund'),
  'saying nothing would let someone assume one exists',
);

check('there are rights listed', YOUR_RIGHTS.length >= 4);
check(
  'the NDPR response window is quoted',
  legalScreen.includes('30 days') || CHANNELS.some((c) => c.responseTime.includes('30 days')),
);

// --------------------------------------------------------------- support ----

check(
  'the placeholder contact warning is shown while the addresses are fake',
  CONTACT_IS_PLACEHOLDER === read('src/app/(tabs)/support.tsx').includes('CONTACT_IS_PLACEHOLDER'),
  'unmonitored addresses presented as live read as being ignored',
);
check(
  'every channel says how long a reply takes',
  CHANNELS.every((c) => c.responseTime.length > 0),
);
check(
  'there is a privacy channel',
  CHANNELS.some((c) => c.key === 'privacy'),
);
check(
  'self-serve links point at real routes',
  SELF_SERVE.every((item) => item.href.startsWith('/')),
);

// ------------------------------------------------------------- sections -----

check('two legal sections', LEGAL_SECTIONS.length === 2);
check(
  'both are labelled as the nav promises',
  LEGAL_SECTION_LABELS.terms === 'Terms of Service' &&
    LEGAL_SECTION_LABELS.privacy === 'Privacy Policy',
);
check('a known section round-trips', parseLegalSection('privacy') === 'privacy');
check('an unknown section falls back to the terms', parseLegalSection('cookies') === 'terms');

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — all three About Us items resolve to real screens, the right-hand dropdowns open\n' +
    '       inwards, every sensitive column in the SQL is disclosed in the privacy notice\n' +
    '       (including the on-device draft and the map provider seeing your IP), and the terms\n' +
    '       admit they are unreviewed, uninsured, unrefundable and have no retention policy.',
);
