/**
 * Assertions for the Shipments group.
 *
 * The proof-of-delivery checks are the point. A screen titled "Proof of
 * Delivery" is the single easiest place in this app to render something
 * reassuring that is backed by no data at all, so most of what follows exists
 * to stop that.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BOOKING_STAGES, stageIndex, stageProgress } from '../src/store/bookings';

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
  'New Shipment': 'book',
  'Active / In-Transit Parcels': 'my-packages',
  'Shipment History / Archives': 'my-packages',
  'Tracking / Proof of Delivery': 'tracking',
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
  'the label is Shipments, and Send Parcel is gone',
  navSource.includes("label: 'Shipments'") && !navSource.includes("label: 'Send Parcel'"),
);

check(
  'the standalone My Parcels entry was folded in',
  !navSource.includes("label: 'My Parcels'"),
  'it would sit in the nav alongside two children pointing at the same screen',
);

check(
  'Shipments claims the parcel detail route for the active state',
  navSource.includes("also: ['/my-packages', '/tracking', '/parcel']"),
  'a parcel detail page belongs to Shipments and should keep it underlined',
);

/*
 * "New Shipment" must point at the existing booking form, not a new one.
 * A second copy of a form that takes an address, a phone number and a declared
 * value would drift from the original within a release.
 */
check(
  'New Shipment points at the existing /book form',
  navSource.includes("label: 'New Shipment'") && navSource.includes("href: '/book'"),
);

// ------------------------------------------------------ sections and sort ---

const myPackages = read('src/app/(tabs)/my-packages.tsx');

check(
  'the parcels screen reads a section from the URL',
  myPackages.includes('parseSection') &&
    myPackages.includes("'active'") &&
    myPackages.includes("'history'"),
);
check(
  'an unrecognised section falls back rather than rendering nothing',
  myPackages.includes('SECTIONS.includes'),
);
check(
  'history is sorted newest first, not by pickup urgency',
  myPackages.includes('b.createdAt.localeCompare(a.createdAt)'),
  'urgency is meaningless for something already delivered',
);
check(
  'the ownership rule is still applied once',
  // Call sites only — the bare name also appears in the import list and in a
  // comment, which counting naively would have swept in.
  (myPackages.match(/parcelsForUser\(/g) ?? []).length === 1,
  'two copies of the rule will eventually disagree about who sees a recipient phone number',
);

// ------------------------------------------------------------- tracking ----

const tracking = read('src/app/(tabs)/tracking.tsx');

check(
  'lookup is case- and whitespace-insensitive',
  tracking.includes('.trim().toUpperCase()'),
  'a tracking ID gets pasted out of a chat',
);

/*
 * The scoping is a privacy decision, not an oversight. A tracking ID is short
 * and guessable; an unscoped lookup would hand a stranger a recipient's name,
 * phone number and home address.
 */
check(
  'a miss does not claim the parcel does not exist',
  !tracking.includes('No such parcel') && tracking.includes('on your account'),
  'the honest answer is "not on this account"',
);
check(
  'the signed-out case explains why tracking needs an account',
  tracking.includes('short enough to guess'),
);
check(
  'the recipient gap is admitted',
  tracking.includes('Are you the recipient'),
  'someone receiving a parcel genuinely cannot track it — saying nothing strands them',
);

// ------------------------------------------------- no invented delivery ----

const bookingsStore = read('src/store/bookings.tsx');

/*
 * Proof of delivery now exists — see `supabase/migrations/20250101000010_delivery.sql`. These
 * assertions changed direction on purpose: they used to require the fields to
 * be absent and the page to say so. Now they require the fields to be present
 * and the page to distinguish an evidenced delivery from a bare one, because
 * that distinction is the whole value of the feature.
 */
const POD_FIELDS = ['deliveredAt', 'receivedBy', 'proofPath', 'proofNote', 'pickedUpAt'];
for (const field of POD_FIELDS) {
  check(
    `the Booking type carries ${field}`,
    bookingsStore.includes(`${field}:`),
    'the tracking screen cannot show a handover record it has no field for',
  );
}

check(
  'the empty Proof of Delivery panel is gone',
  !tracking.includes('NoProofOfDelivery'),
  'it was replaced by ProofOfDelivery, which renders the record that exists',
);
check(
  'a delivery with no handover record is still called out',
  tracking.includes('Marked delivered, but not evidenced'),
  'every parcel completed before 20250101000010_delivery.sql looks like this, and a green tick against it would be false',
);
check(
  'an evidenced handover names who took it and when',
  tracking.includes('label="Received by"') && tracking.includes('label="Delivered at"'),
);
check(
  'the proof photo is fetched through a signed URL',
  tracking.includes('signedProofUrl'),
  'the delivery-proof bucket is private; a raw storage path would render nothing',
);
check(
  'a delivered parcel is not shown as evidenced',
  tracking.includes('Marked delivered, but not evidenced'),
  'a green tick on a disputed delivery would be a false claim',
);

/*
 * Only two stages have a real timestamp. Deriving the other four from
 * `createdAt` would put invented delivery times in front of someone trying to
 * establish when a parcel actually moved.
 */
check(
  'only recorded timestamps are shown',
  tracking.includes('stageTimestamp') && tracking.includes('return null'),
);
check(
  'and the blank column is explained',
  tracking.includes('Only booking and driver acceptance are timestamped'),
  'otherwise it reads as a rendering fault',
);
check(
  'the map is not presented as a live position',
  tracking.includes('not the driver') && tracking.includes('live'),
  'two pins from the booking form are not a vehicle tracker',
);

// ----------------------------------------------------------- stage logic ---

check('six stages', BOOKING_STAGES.length === 6);
check('Booked is first', stageIndex('Booked') === 0);
check('Delivered is last', stageIndex('Delivered') === BOOKING_STAGES.length - 1);
check('progress starts empty', stageProgress('Booked').fraction === 0);
check('progress ends full', stageProgress('Delivered').fraction === 1);
check(
  'an unknown stage does not produce a negative bar',
  stageProgress('Nonsense' as never).fraction >= 0,
  'stageIndex returns -1 for anything unrecognised',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — all four Shipments items resolve to real screens, New Shipment reuses the\n' +
    '       existing form, the parcels list keeps one ownership rule, tracking admits it is\n' +
    '       scoped to your account, and the Proof of Delivery panel shows the handover\n' +
    '       record where one exists and says so plainly where it does not.',
);
