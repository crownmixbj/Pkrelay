/**
 * Assertions for tracking links and the first paint behind them.
 *
 * Two failures live here, and neither produced an error anywhere:
 *
 *   - A link in an email carried a tracking id; the screen resolved uuids. Every
 *     emailed tracking link landed on "Parcel not found", permanently, and the
 *     only symptom was a customer saying the link did not work.
 *   - The screen rendered that same not-found state on every cold load before
 *     the parcels had arrived, which is the flash people reported as "the page
 *     jumps".
 *
 * The first check below is the one that matters most: it compares the URL the
 * emails build against the identifier the screen can resolve. Those two facts
 * live in different languages in different directories and drifted apart
 * silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findParcel, type ParcelIdentity } from '../src/lib/parcel-link';

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
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const screen = read('src/app/parcel/[id].tsx');
const screenCode = code(screen);
const store = code(read('src/store/bookings.tsx'));
const skeleton = code(read('src/components/ui/skeleton.tsx'));
const templates = read('supabase/functions/notify-events/templates.ts');

// ------------------------------ 1. the emails and the screen agree --------

const emailedPaths = [...templates.matchAll(/`\/parcel\/\$\{encodeURIComponent\((\w+)\)\}`/g)].map(
  (match) => match[1],
);

check(
  'the email templates link to the parcel screen',
  emailedPaths.length > 0,
  'if this fails the templates changed shape and the rest of this section is not checking what it thinks',
);
check(
  'and every one of them carries a tracking id',
  emailedPaths.every((name) => name === 'tracking'),
  `variables interpolated into /parcel/: ${[...new Set(emailedPaths)].join(', ')}`,
);

const sample: ParcelIdentity[] = [
  { id: 'a1b2c3d4-0000-0000-0000-000000000001', trackingId: 'PKR-4821' },
  { id: 'a1b2c3d4-0000-0000-0000-000000000002', trackingId: 'PKR-9033' },
];

check(
  'the screen resolves the uuid the app navigates with',
  findParcel(sample, 'a1b2c3d4-0000-0000-0000-000000000002')?.trackingId === 'PKR-9033',
);
check(
  'and the tracking id the emails send',
  findParcel(sample, 'PKR-4821')?.id === sample[0].id,
  'this is the one that was broken — every emailed link hit the not-found state',
);
check(
  'case-insensitively, because people retype these from a phone call',
  findParcel(sample, 'pkr-4821')?.id === sample[0].id,
);
check('padding does not defeat it', findParcel(sample, '  PKR-4821 ')?.id === sample[0].id);
check('an unknown identifier resolves to nothing', findParcel(sample, 'PKR-0000') === undefined);
check('and so does an empty one', findParcel(sample, '') === undefined);
check('a missing param does not throw', findParcel(sample, undefined) === undefined);
check(
  'a uuid wins over a tracking id that happens to equal it',
  findParcel(
    [{ id: 'SAME', trackingId: 'other' }, { id: 'x', trackingId: 'SAME' }],
    'SAME',
  )?.trackingId === 'other',
  'exact and unique beats case-folded and merely-unlikely',
);
check(
  'the screen uses the shared resolver rather than matching inline',
  screenCode.includes('findParcel(bookings, id)') && !screenCode.includes('b.id === id'),
  'a second implementation of this question is how the two got out of step',
);

// --------------------------------- 2. loading is checked before empty -----

const loadingAt = screenCode.indexOf('!booking && loading');
const notFoundAt = screenCode.indexOf('if (!booking) {');

check('the screen reads the store loading flag', loadingAt !== -1);
check(
  'and checks it BEFORE rendering not-found',
  loadingAt !== -1 && notFoundAt !== -1 && loadingAt < notFoundAt,
  'the other order is the flash: empty state first, content a moment later',
);
check(
  'the placeholder is a skeleton, not a spinner',
  screenCode.includes('<ParcelDetailSkeleton />'),
);

const signedOutAt = screenCode.indexOf('!booking && !isAuthenticated');
check(
  'a signed-out visitor is asked to sign in, not told the parcel is gone',
  signedOutAt !== -1,
  'RLS scopes bookings to the sender and driver, so an emailed link opened on a signed-out device resolves nothing',
);
check(
  'and that is checked before the not-found state',
  signedOutAt !== -1 && notFoundAt !== -1 && signedOutAt < notFoundAt,
  '"this parcel may have been removed" about their own parcel is the worst available answer',
);
check(
  'the sign-in round trip returns them to this parcel',
  screenCode.includes('next={`/parcel/${id ?? \'\'}`}'),
  'sending them to the home screen loses the thing they clicked the link for',
);

// ------------------------- 3. the store does not guess during auth --------

check(
  'the store distinguishes "signed out" from "not known yet"',
  store.includes('const authSettling = status === ') && store.includes('if (authSettling) return;'),
  'a null user during session restore is indistinguishable from a visitor, and treating it as one empties the list',
);
check(
  'and reports loading while the session settles',
  store.includes('loading: loading || authSettling'),
  'otherwise every screen reading the store needs its own copy of this check, and one will forget',
);
check(
  'the store keeps no tracking-id matcher of its own',
  !store.includes('trackingId.toLowerCase()'),
  'one answer to "which parcel is this string", and it lives in lib/parcel-link.ts',
);
check(
  'and the resolver itself imports nothing',
  !/^\s*import /m.test(read('src/lib/parcel-link.ts')),
  'a rule this small should be testable without loading React and the Supabase client',
);

// --------------------------------------- 4. the skeleton holds the space --

for (const key of ['styles.container', 'styles.content', 'styles.header', 'styles.headerText', 'styles.pillRow']) {
  check(
    `the skeleton reuses ${key} so nothing moves on the swap`,
    screenCode.split('function ParcelDetailSkeleton')[1]?.includes(key) === true,
    'a skeleton with its own spacing is a second layout, and swapping layouts is the flash again',
  );
}
check(
  'motion is skipped when the person asked for less of it',
  skeleton.includes('isReduceMotionEnabled') && skeleton.includes('reduceMotionChanged'),
  'a pulsing rectangle is exactly what Reduce Motion is set to stop',
);
check(
  'a screen reader hears one thing, not twelve empty boxes',
  skeleton.includes('accessibilityElementsHidden') &&
    skeleton.includes('importantForAccessibility="no-hide-descendants"') &&
    skeleton.includes('busy: true'),
  'iOS needs the first, Android the second — one alone leaves the other reading out placeholders',
);

// -------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('verify:tracking-links — all checks passed');
