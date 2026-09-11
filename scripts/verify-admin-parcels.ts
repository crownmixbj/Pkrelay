/**
 * Assertions for admin parcel access.
 *
 * The whole risk here is a privacy one, and it is quiet. Nobody notices an
 * admin dashboard that hands out every customer's home address — it just works,
 * and works a bit too well. So the assertions guard the boundary rather than
 * the behaviour:
 *
 *   - no broad admin read policy on `bookings`, ever
 *   - the detail function returns no contact column
 *   - every reveal is logged before the data is returned
 *   - the open board is no longer readable by any signed-in account
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ageLabel } from '../src/store/admin';

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
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');

const flat = (source: string) => source.replace(/\s+/g, ' ');

const sql = read('supabase/migrations/20250101000017_admin_parcel_detail.sql');
const sqlCode = code(sql);
const drawer = read('src/components/ui/admin-parcel-drawer.tsx');
const overview = read('src/components/ui/admin-overview.tsx');
const store = read('src/store/admin.ts');

// ------------------------------------------------- the open board is closed --

check(
  'the unclaimed feed now requires an approved driver',
  flat(sqlCode).includes('or (driver_id is null and public.is_approved_driver())'),
  'it used to end "or driver_id is null" — any signed-in account could read every sender’s phone and pickup address',
);
check(
  'and the bare version is gone from the current policy',
  !/using \(\s*sender_id = \(select auth\.uid\(\)\)\s*or driver_id = \(select auth\.uid\(\)\)\s*or driver_id is null\s*\)/.test(
    flat(sqlCode),
  ),
);
check(
  'the remaining narrower exposure is written down rather than left to be found',
  /approved.*driver browsing the board still reads the whole row/is.test(sql) &&
    /not done here/i.test(sql),
  'an approved driver still sees sender contacts on unclaimed parcels; the fix is a view and it is not built',
);

// --------------------------------------------- no back door onto the table --

/*
 * Checked across every migration, not just this one.
 *
 * The danger is not that this file adds a policy — it is that a later file does,
 * quietly making all of the redaction below pointless. This assertion fails the
 * day that happens.
 */
/*
 * Read by suffix, not by ordinal.
 *
 * Migrations live in \`supabase/migrations/\` under a timestamped version prefix,
 * so the old '01', '07', … lookup no longer names a file. Worse, it failed
 * *open*: a miss returned an empty string and every assertion below passed on
 * nothing. Matching on the descriptive tail survives a renumber, and an
 * unmatched name is now a thrown error rather than a silent pass.
 */
const MIGRATION_DIR = 'supabase/migrations';

const migrationBySuffix = (suffix: string): string => {
  const match = readdirSync(join(ROOT, MIGRATION_DIR)).find((name) =>
    name.endsWith(`_${suffix}.sql`),
  );
  if (!match) throw new Error(`no migration ending in _${suffix}.sql`);
  return read(`${MIGRATION_DIR}/${match}`);
};

const allSql = [
  'bookings',
  'admin',
  'bans',
  'cancellation',
  'dispatch',
  'driver_identity',
  'admin_parcel_detail',
]
  .map((suffix) => code(migrationBySuffix(suffix)))
  .join('\n');

check(
  'no migration grants admins a blanket read on bookings',
  !/on public\.bookings for select[\s\S]{0,400}?is_admin\(\)/i.test(allSql),
  'a policy would hand every admin token select * over every parcel, including the contact columns',
);

// ---------------------------------------- the detail carries no identities --

const detailFn = sqlCode.slice(
  sqlCode.indexOf('function public.admin_parcel_detail'),
  sqlCode.indexOf('function public.admin_parcels'),
);

for (const column of [
  'recipient_name',
  'recipient_phone',
  'sender_phone',
  'pickup_address',
  'dropoff_address',
  'pickup_contact_name',
]) {
  check(
    `admin_parcel_detail does not return ${column}`,
    !detailFn.includes(column),
    'operational questions do not need the people; the reveal function exists for the ones that do',
  );
}

check(
  'it does return the driver, who is a vetted counterparty rather than a customer',
  detailFn.includes('b.driver,'),
);
check(
  'and the dispatch history, which is usually the reason a parcel is stuck',
  detailFn.includes('from public.dispatch_offers o where o.booking_id = b.id'),
);

check(
  'both read functions refuse a non-admin',
  (flat(sqlCode).match(/if not public\.is_admin\(\) then raise exception/g) ?? []).length >= 3,
);

check(
  'the list is bounded',
  flat(sqlCode).includes('limit greatest(1, least(coalesce(max_rows, 50), 200))'),
  'an unbounded query on a busy day times out on the screen someone opens first every morning',
);
check(
  'and ordered oldest first',
  flat(sqlCode).includes('order by b.created_at asc'),
  'an operator opening a backlog wants the parcel that has waited longest',
);

// ------------------------------------------------------- the audited door --

check(
  'revealing contacts writes an audit line',
  flat(sqlCode).includes("'admin revealed parcel contact details'"),
);
check(
  'the log names the admin and the parcel',
  flat(sqlCode).includes("jsonb_build_object( 'booking', booking_id,") &&
    flat(sqlCode).includes('actor'),
);
check(
  'and it is written before the data is returned',
  sqlCode.indexOf('insert into public.app_events') <
    sqlCode.indexOf('select b.pickup_contact_name'),
  'an audit written afterwards is one an error can skip',
);
check(
  'the reveal is a separate call from the detail',
  flat(store).includes('export async function revealParcelContacts(') &&
    flat(store).includes('export async function fetchAdminParcelDetail('),
  'bundling them puts a customer’s address on screen every time somebody opens a stuck parcel',
);
check(
  'the UI says the view is logged, before and after',
  flat(drawer).includes(
    'Opening them writes a line to the audit log with your name and this parcel',
  ) && flat(drawer).includes('Contact details — this view has been logged'),
  'an audit nobody knows about does not deter anything',
);
check(
  'and asks what it is for',
  flat(drawer).includes('Why do you need the contact details?'),
  'a log of who looked is useful; a log of who looked and why is one somebody can review',
);
check(
  'contacts are hidden until asked for',
  flat(drawer).includes('Names, phone numbers and addresses are hidden'),
);

// ----------------------------------------------------------- the clickable --

/*
 * Every parcel card behaves the same way on a plain click.
 *
 * The version this replaces had Unclaimed toggling an inline list on click and
 * opening the drawer on a *long press*. With a mouse that is barely an
 * affordance at all, and Unclaimed read as the one card that did not work.
 */
check(
  'all four parcel cards open the drawer',
  (flat(overview).match(/<ParcelMetric/g) ?? []).length === 4,
  'a number an operator cannot act on is one they learn to ignore',
);
check(
  'nothing important is behind a long press',
  !/onLongPress/.test(code(overview)),
  'there is no long press with a mouse, and this dashboard is a desktop screen',
);
check(
  'the destination filter lives with the list it filters',
  flat(drawer).includes('setPickedCity(destination.city)') &&
    flat(drawer).includes('fetchUnassignedByDestination()'),
  'it used to be an expander on the card, which made that card behave unlike every other one',
);
check(
  'and the filter chips carry the oldest wait, not just a count',
  flat(drawer).includes('hint={`oldest ${waitedLabel(destination.oldestHours)}`}'),
  'four parcels waiting two days is a different problem from four posted this morning',
);
check(
  'the tappable cards say so',
  flat(overview).includes('hint="Tap to open"'),
  'an interactive card identical to a static one is one nobody taps',
);
check(
  'and they are announced as buttons',
  flat(overview).includes('accessibilityLabel={`${label}: ${value}. Open the parcel list.`}'),
);
/*
 * Two layout traps that make a working handler look broken.
 *
 * Neither throws. The first opens a sheet that appears empty; the second makes
 * the tappable cards a different height from the static ones beside them. Both
 * read to a user as "this is not clickable".
 */
check(
  'no BottomSheet caller nests a second ScrollView',
  ['src/components/ui/admin-parcel-drawer.tsx', 'src/components/ui/sender-photo-sheet.tsx'].every(
    (path) => {
      const source = read(path);
      const sheets = source.match(/<BottomSheet[\s\S]*?<\/BottomSheet>/g) ?? [];
      return sheets.every((sheet) => !sheet.includes('<ScrollView'));
    },
  ),
  'BottomSheet already scrolls — an inner scroll container with no bounded height collapses on web',
);
check(
  'and BottomSheet says so where someone would add one',
  /Do not put a `ScrollView` inside it/.test(read('src/components/ui/bottom-sheet.tsx')),
);
check(
  'a card inside a slot does not carry its own flex',
  flat(read('src/components/ui/admin-shell.tsx')).includes('nested && styles.metricNested') &&
    /*
      Matched field by field rather than as one literal — prettier splits the
      object across lines and adds a trailing comma, so an exact-string match
      breaks on formatting rather than on meaning.
    */
    ['flexGrow: 0', "flexBasis: 'auto'", "width: '100%'"].every((field) =>
      flat(read('src/components/ui/admin-shell.tsx'))
        .split('metricNested:')[1]
        ?.slice(0, 120)
        .includes(field),
    ),
  'a Pressable lays out in a column, so flexBasis:150 on the card sets its height, not its width',
);
check(
  'and ParcelMetric passes that through',
  flat(overview).includes(
    '<Metric label={label} value={value} tone={tone} hint="Tap to open" nested />',
  ),
);

/*
 * A pointer cursor, set explicitly.
 *
 * `Pressable` renders a plain `div` under react-native-web. Whether it picks up
 * a pointer cursor on its own depends on the version and on which props are
 * set, and a card that does not change the cursor reads as decoration however
 * many handlers are attached to it. Cheap to state, and ignored on native.
 */
for (const [file, source] of [
  ['admin-shell', read('src/components/ui/admin-shell.tsx')],
  ['admin-parcel-drawer', read('src/components/ui/admin-parcel-drawer.tsx')],
] as const) {
  check(
    `${file} sets a pointer cursor on its pressable surfaces`,
    flat(source).includes("cursor: 'pointer'"),
    'without it a clickable card looks identical to a static one',
  );
}

check(
  'every interactive surface in the drawer has one',
  ['metricSlot', 'row', 'chip'].every((name) => {
    const source = flat(
      read('src/components/ui/admin-shell.tsx') + read('src/components/ui/admin-parcel-drawer.tsx'),
    );
    const block = source.split(`${name}: {`)[1]?.slice(0, 260) ?? '';
    return block.includes("cursor: 'pointer'");
  }),
);

check(
  'the tappable wrapper keeps the row aligned',
  flat(overview).includes('adminStyles.metricSlot'),
  'a Pressable without the flex collapses to content width and breaks the row',
);

check('list rows open the detail', flat(drawer).includes('onPress={() => setOpenId(row.id)}'));
check(
  'a parcel with no driver says whether dispatch has tried',
  flat(drawer).includes("'Offered to a driver now'") &&
    flat(drawer).includes("'No driver, no live offer'"),
  '"unassigned" on a parcel dispatch is working reads very differently from one nobody has been offered',
);

check(
  'a missing timestamp renders as a dash, never an invented date',
  flat(drawer).includes("if (!iso) return '—';"),
);

check(
  'an age reads in hours below a day',
  ageLabel(new Date(Date.now() - 5 * 3_600_000).toISOString()) === '5h',
);
check(
  'and in days above one',
  ageLabel(new Date(Date.now() - 50 * 3_600_000).toISOString()) === '2 days',
);
check('a missing timestamp has no age', ageLabel(null) === '—');
check(
  'and a future timestamp does not render as a negative age',
  ageLabel(new Date(Date.now() + 3_600_000).toISOString()) === '—',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — no migration grants admins a blanket read on bookings, the parcel detail carries\n' +
    '       no name, phone or address, every reveal is logged before the data is returned and\n' +
    '       announced to the admin doing it, and the open board no longer hands every signed-in\n' +
    '       account the sender details of every unclaimed parcel.',
);
