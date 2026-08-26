/**
 * Assertions for the Admin area.
 *
 * Weighted heavily toward the SQL. This is the one part of the app where a
 * mistake hands someone else's NIN and bank details to an account that should
 * not have them, or lets a normal user make themselves an administrator — so
 * most of what follows reads `07_admin.sql` and checks the guards are actually
 * present rather than merely intended.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/**
 * Comments stripped before searching.
 *
 * These files *discuss* the things being checked — `07_admin.sql` explains why
 * `security definer` is used, and the shell explains why it does not say "you
 * are not an admin". Searching the raw text finds the explanation and reports
 * it as the problem.
 */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');

/** Collapses the line breaks Prettier introduces inside JSX text. */
const flat = (source: string) => source.replace(/\s+/g, ' ');

const sql = read('supabase/07_admin.sql');
const older = read('supabase/02_driver_applications.sql');
const navSource = read('src/components/ui/app-nav-bar.tsx');

// --------------------------------------------------------- route coverage ---

/*
 * ⚠ Read out of the nav rather than listed again here.
 *
 *   This was a hand-written map of five labels to five routes, plus an
 *   assertion pinning the `also` array verbatim. Both broke the day a sixth
 *   admin screen was added — reporting a missing route for a route that
 *   exists, and a wrong array for an array that had simply grown. An assertion
 *   that fails on every unrelated change is one somebody edits without reading,
 *   and the property it was defending gets lost in the edit.
 *
 *   What actually matters is unchanged and is asserted below: every entry the
 *   dropdown offers leads somewhere real, and nothing an admin can click is a
 *   dead end.
 */
const adminEntry =
  /key: 'admin',[\s\S]*?children: \[([\s\S]*?)\n {4}\],/.exec(navSource)?.[1] ?? '';

check('the Admin dropdown parsed', adminEntry.length > 0, 'nothing to check is not a pass');

const children = [...adminEntry.matchAll(/label: '([^']+)',\s*\n\s*href: '([^']+)',/g)].map(
  (match) => ({ label: match[1], href: match[2] }),
);

check(
  'it offers more than a couple of screens',
  children.length >= 5,
  `parsed ${children.length} — the regex has probably stopped matching the file`,
);

for (const { label, href } of children) {
  /*
   * `/admin` is one screen with sections; everything else is its own route.
   * Either way the file has to exist, because expo-router resolves by filename
   * and a missing one is a blank screen rather than an error.
   */
  const route = href.replace(/^\//, '');

  let exists = true;
  try {
    read(`src/app/(tabs)/${route}.tsx`);
  } catch {
    exists = false;
  }
  check(`"${label}" resolves to a real screen`, exists, `src/app/(tabs)/${route}.tsx is missing`);
}

/*
 * ⚠ A child pointing at a section that no longer exists is a dead link that
 *   renders the Overview instead.
 *
 *   `parseAdminSection` falls back to 'overview' for anything it does not
 *   recognise — which is right at runtime and silent. So a nav entry left
 *   behind after a section moved out to its own route would quietly send
 *   somebody to the dashboard, and look like a bug in the dashboard.
 */
const sections =
  /const SECTIONS = \[([^\]]*)\] as const;/.exec(read('src/app/(tabs)/admin.tsx'))?.[1] ?? '';
const sectionNames = [...sections.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

check('the admin sections parsed', sectionNames.length >= 3, sections);

for (const [, key] of adminEntry.matchAll(/section: '([a-z_]+)'/g)) {
  check(
    `the "${key}" nav entry points at a section that exists`,
    sectionNames.includes(key),
    `admin.tsx knows ${sectionNames.join(', ')} — anything else silently opens the Overview`,
  );
}

check(
  'the entry is Admin, and the old Applications tab is gone',
  navSource.includes("label: 'Admin'") && !navSource.includes("label: 'Applications'"),
  'the review queue is one of several now — leaving it top-level duplicates it',
);

check(
  'Admin is still filtered to admins',
  navSource.includes("link.key !== 'admin' || isAdmin"),
  'hiding it is a courtesy, but it should still be hidden',
);

/*
 * ⚠ `also` is what keeps the Admin entry highlighted on its sibling routes.
 *
 *   Without an entry here, opening Sender ID Review leaves the nav showing
 *   nothing selected — the person is on an admin screen and the chrome says
 *   they are nowhere. Asserted as coverage of the children rather than as a
 *   fixed list, so adding a seventh screen fails here on the day it is added.
 */
const also = /key: 'admin',[\s\S]*?also: \[([^\]]*)\]/.exec(navSource)?.[1] ?? '';
const alsoHrefs = [...also.matchAll(/'([^']+)'/g)].map((m) => m[1]);

for (const { label, href } of children) {
  if (href === '/admin') continue;
  check(
    `Admin stays selected on "${label}"`,
    alsoHrefs.includes(href),
    `${href} is missing from \`also\` — the nav shows nothing selected while standing on it`,
  );
}

// ------------------------------------------------ privilege escalation ------

/*
 * `profiles.is_admin` must stay un-writable by any client. The trigger added in
 * 02 is what enforces that, and nothing in 07 may drop or weaken it — the whole
 * role system rests on that one guard.
 */
check(
  'the is_admin guard trigger still exists',
  older.includes('profiles_guard_admin') &&
    older.includes("current_user in ('authenticated', 'anon')"),
);
check(
  'and 07 does not drop it',
  !/drop\s+trigger[^;]*profiles_guard_admin/i.test(sql),
  'removing it would let any client promote itself with a plain UPDATE',
);
check(
  'no policy grants clients update on profiles.is_admin',
  !/create policy[^;]*on public\.profiles for update[^;]*is_admin/is.test(sql),
);

/*
 * The grant function is the single audited path around that trigger. Each of
 * these is a distinct failure it has to refuse.
 */
check(
  'set_admin_role checks the caller is an admin',
  sql.includes('if not public.is_admin() then') &&
    sql.includes('Only an administrator can change roles'),
  'without it, any signed-in account could call the RPC and promote anyone',
);
check('it refuses to be called signed out', sql.includes("raise exception 'Not signed in'"));
check(
  'it refuses to change your own role',
  sql.includes('if target_id = actor then'),
  'stops both self-promotion and the last admin demoting themselves by accident',
);
check(
  'it refuses to remove the last admin',
  sql.includes('This is the only administrator left'),
  'otherwise a project can lock itself out of its own admin area',
);
check(
  'the last-admin count runs inside the same statement as the update',
  sql.indexOf('count(*) from public.profiles where is_admin') <
    sql.indexOf('update public.profiles set is_admin'),
  'checking after the write would let two simultaneous demotions both pass',
);
check(
  'anon cannot execute it',
  sql.includes(
    'revoke all on function public.set_admin_role(uuid, boolean, text) from public, anon',
  ),
);

// ------------------------------------------------------------- audit log ----

check(
  'there is a role_grants table',
  sql.includes('create table if not exists public.role_grants'),
);
check(
  'the actor is never null',
  /actor_id\s+uuid not null/.test(sql),
  'an unattributed privilege change is not an audit trail',
);
check(
  'the subject can read their own grants',
  sql.includes('subject_id = (select auth.uid())'),
  'being told you were demoted, and by whom, is the minimum it owes them',
);

/*
 * No client-side write path at all. A client that could insert here could forge
 * the record of its own promotion — a log that looks authoritative and is false
 * is worse than no log.
 */
check(
  'no insert policy on role_grants',
  !/create policy[^;]*on public\.role_grants for insert/is.test(sql),
);
check(
  'no update or delete policy either',
  !/create policy[^;]*on public\.role_grants for (update|delete)/is.test(sql),
);
check(
  'role_grants has RLS enabled',
  sql.includes('alter table public.role_grants enable row level security'),
);

// -------------------------------------------------------------- events ------

check('there is an app_events table', sql.includes('create table if not exists public.app_events'));
check(
  'app_events has RLS enabled',
  sql.includes('alter table public.app_events enable row level security'),
);
check(
  'clients may insert but only admins may read',
  /create policy "anyone signed in may log"[\s\S]*for insert/.test(sql) &&
    /create policy "admins read events"[\s\S]*for select[\s\S]*public\.is_admin\(\)/.test(sql),
  'a log the app can read back is a log an attacker can read back',
);
check(
  'an event cannot be attributed to someone else',
  sql.includes('actor_id is null or actor_id = (select auth.uid())'),
);

const adminStore = read('src/store/admin.ts');
check(
  'the logger swallows its own failure',
  adminStore.includes('Failing to log must never mask the original failure'),
  'a logger that throws turns a handled error into an unhandled one',
);
check(
  'and truncates the message',
  adminStore.includes('message.slice(0, 500)'),
  'an error can be a whole HTML page from a proxy',
);

// ------------------------------------------------ aggregates, not rows ------

check(
  'the overview returns counts, not rows',
  sql.includes('returns jsonb') && sql.includes('admin_overview'),
);
check(
  'and checks is_admin before returning them',
  /admin_overview[\s\S]*?if not public\.is_admin\(\) then/.test(sql),
  'a security definer function without a guard is a hole, not a feature',
);
check(
  'city volumes are guarded too',
  /admin_city_volumes[\s\S]*?if not public\.is_admin\(\) then/.test(sql),
);
check(
  'no admin read policy was added to bookings',
  !/create policy[^;]*on public\.bookings for select/is.test(sql),
  'counting parcels does not require reading recipient addresses',
);
const sqlCode = code(sql);
check(
  'every security definer function pins search_path',
  (sqlCode.match(/security definer/g) ?? []).length ===
    (sqlCode.match(/set search_path = ''/g) ?? []).length,
  `${(sqlCode.match(/security definer/g) ?? []).length} definer vs ${
    (sqlCode.match(/set search_path = ''/g) ?? []).length
  } pinned — an unpinned search_path on a definer function is an escalation route`,
);

// -------------------------------------------------------------- screens -----

const shell = read('src/components/ui/admin-shell.tsx');
check(
  'the shared shell handles all three access states',
  shell.includes("status === 'loading'") &&
    shell.includes('!isAuthenticated') &&
    shell.includes('!isAdmin'),
  'four screens repeating this is four chances to get the third one wrong',
);
check(
  'the denial does not confirm that an admin tier exists',
  shell.includes("This area isn't available on your account") &&
    !code(shell).includes('You are not an admin'),
);

const users = read('src/app/(tabs)/admin-users.tsx');
check(
  'the role control is hidden on your own row',
  users.includes('{!isSelf && ('),
  'the server refuses it, so offering it invites an error',
);
/*
 * This assertion pinned the bug.
 *
 * It required `thrown instanceof Error ? thrown.message` — the exact expression
 * that never evaluates to the message for a Supabase failure — and called the
 * result "shown verbatim". It passed for months while every refusal on this
 * screen printed a fallback. An assertion can only be as right as the belief
 * behind it, and the belief here was that PostgrestError extends Error.
 */
check(
  "the server's refusal message is shown verbatim",
  users.includes('errorMessage(thrown'),
  '"This is the only administrator left" is the one useful thing to say, and it never reached anybody',
);

// ------------------------------------------------- user segmentation -------

/*
 * The segments, transcribed. Nobody signs up as a driver — every account is
 * created the same way and some people then apply — so "sender" is the absence
 * of an application, not a choice.
 */
type Segment = 'all' | 'senders' | 'applicants' | 'approved';

const inSegment = (
  application: { status: 'pending' | 'under_review' | 'approved' | 'rejected' } | undefined,
  which: Segment,
): boolean => {
  switch (which) {
    case 'senders':
      return !application;
    case 'applicants':
      return Boolean(application);
    case 'approved':
      return application?.status === 'approved';
    case 'all':
      return true;
  }
};

check('someone who never applied is a sender', inSegment(undefined, 'senders'));
check('and is not an applicant', !inSegment(undefined, 'applicants'));
check('a pending applicant is an applicant', inSegment({ status: 'pending' }, 'applicants'));
check(
  'but not yet an approved driver',
  !inSegment({ status: 'pending' }, 'approved'),
  'counting pending applications as drivers would overstate capacity',
);
check(
  'a rejected applicant is still an applicant, not a sender',
  inSegment({ status: 'rejected' }, 'applicants') && !inSegment({ status: 'rejected' }, 'senders'),
  'they applied — moving them back to senders would hide that from the count',
);
check(
  'an approved driver is both',
  inSegment({ status: 'approved' }, 'applicants') && inSegment({ status: 'approved' }, 'approved'),
);

/*
 * Senders and applicants must partition the accounts exactly: nobody in both,
 * nobody in neither, or the two numbers stop adding up to the total.
 */
for (const status of ['pending', 'under_review', 'approved', 'rejected'] as const) {
  check(
    `${status}: senders and applicants are mutually exclusive`,
    inSegment({ status }, 'senders') !== inSegment({ status }, 'applicants'),
  );
}
check(
  'and exclusive for someone with no application',
  inSegment(undefined, 'senders') !== inSegment(undefined, 'applicants'),
);

check(
  'the screen says the split is derived, not a signup choice',
  flat(users).includes('Everyone signs up the same way'),
  'a "senders" number read as a signup statistic is the wrong conclusion',
);
check(
  'chip counts come from the whole list, not the filtered one',
  users.includes('Counted from the whole list'),
  'a count that moves when you type is describing your query, not the platform',
);
check(
  'the user list pulls only an application summary',
  read('src/store/admin.ts').includes('fetchApplicationSummaries') &&
    !users.includes('fetchAllApplications'),
  'the full row carries a NIN and a bank account this screen has no use for',
);

const summarySelect =
  /fetchApplicationSummaries[\s\S]*?\.select\('([^']*)'\)/.exec(read('src/store/admin.ts'))?.[1] ??
  '';
check(
  'and that summary selects no sensitive column',
  summarySelect.length > 0 && !/nin|account_number|bank|guarantor|address/i.test(summarySelect),
  `selected: ${summarySelect}`,
);

// ------------------------------------------------ bans and erasure ---------

const bans = read('supabase/09_bans.sql');
const dialog = read('src/components/ui/moderation-dialog.tsx');

/*
 * A ban has to bite in the database, not in the UI. `is_approved_driver()` is
 * what the claim policy on `bookings` calls, so tightening that one function
 * bans the driver in the feed and at the claim simultaneously.
 */
check(
  'the driving gate excludes banned drivers',
  /create or replace function public\.is_approved_driver[\s\S]*?driving_banned_at is null/.test(
    bans,
  ),
  'a ban enforced only in the UI is a suggestion',
);
check(
  'and excludes erased ones',
  /create or replace function public\.is_approved_driver[\s\S]*?p\.deleted_at is null/.test(bans),
);
check(
  'a banned driver can still post a parcel',
  !/is_erased[\s\S]{0,200}driving_banned_at/.test(bans) &&
    bans.includes('a banned driver is still a customer'),
  'banning revokes driving, not the account — that was the choice made',
);

/*
 * Recreating a policy is where guards get silently dropped. The insert policy
 * gains one condition and must keep the three it already had, or a client could
 * post a parcel pre-assigned to a driver.
 */
const insertPolicy = /create policy "sender creates own"[\s\S]*?\);/.exec(bans)?.[0] ?? '';
check(
  'the rewritten insert policy kept its original guards',
  insertPolicy.includes('driver_id is null') &&
    insertPolicy.includes('driver is null') &&
    insertPolicy.includes("status = 'Booked'") &&
    insertPolicy.includes('not public.is_erased()'),
  'dropping and recreating a policy is how conditions disappear',
);

check(
  'moderation columns cannot be written by a client',
  bans.includes('profiles_guard_moderation') &&
    bans.includes("current_user in ('authenticated', 'anon')"),
  'otherwise a banned driver could clear their own ban with a profile update',
);
check(
  'banning requires a reason',
  bans.includes("raise exception 'Give a reason for the ban.'"),
  'an unexplained ban cannot be defended or lifted with confidence',
);
check('you cannot ban yourself', bans.includes("raise exception 'You cannot ban yourself.'"));
check(
  'both moderation functions check is_admin',
  /set_driving_ban[\s\S]*?if not public\.is_admin\(\) then/.test(bans) &&
    /erase_person[\s\S]*?if not public\.is_admin\(\) then/.test(bans),
);
check(
  'and neither is executable by anon',
  bans.includes(
    'revoke all on function public.set_driving_ban(uuid, boolean, text) from public, anon',
  ) && bans.includes('revoke all on function public.erase_person(uuid, text) from public, anon'),
);

/*
 * Erasure must remove the person and keep the deliveries. Every field named
 * here is one the privacy notice lists as collected.
 */
const erase = /create or replace function public\.erase_person[\s\S]*?\$\$;/.exec(bans)?.[0] ?? '';

for (const field of [
  'nin',
  'account_number',
  'bank_name',
  'guarantor_nin',
  'guarantor_phone',
  'kin_phone',
  'license_id',
  'plate_number',
  'address',
]) {
  check(`erase overwrites ${field}`, new RegExp(`\\b${field} = 'Erased'`).test(erase));
}
check('erase empties the documents map', erase.includes("documents = '{}'::jsonb"));
check(
  'and deletes the uploaded files',
  erase.includes('delete from storage.objects') && erase.includes("bucket_id = 'driver-documents'"),
  'licence and ID scans are the most sensitive thing held',
);

check(
  'erase destroys no parcel',
  !/delete from public\.bookings/.test(erase),
  "the sender's own history is theirs — destroying it to satisfy someone else's erasure is the wrong trade",
);
check(
  'a carried parcel keeps a non-null carrier name',
  erase.includes("set driver = 'Former driver'"),
  'driver_pair_consistent requires driver and driver_id to move together, so nulling one raises',
);
check(
  'an admin must be demoted before being erased',
  erase.includes("Remove this person''s admin role first"),
  'their id is referenced by the audit trail as an actor',
);
check(
  'the audit row names no personal detail',
  erase.includes('An audit row naming the person'),
  'logging who was erased keeps exactly the data the erasure removed',
);

/*
 * ---------- erasure, and the login it may or may not remove ----------
 *
 * This used to assert that the login always survives, and that the dialog said
 * so. Both were true and both stopped being true: `33_erase_repair.sql` makes
 * the delete non-destructive and `functions/erase-auth-user` performs it.
 *
 * What has to hold now is narrower and more important — the screen must report
 * which of the two actually happened. A project without the function deployed
 * still erases properly, and telling that operator "Account erased" would claim
 * a login was removed when it was not. For an erasure request that is the one
 * detail somebody may later have to answer for.
 */
const repair = read('supabase/33_erase_repair.sql');
const adminUsers = read('src/app/(tabs)/admin-users.tsx');

check(
  'the destructive foreign key is fixed before any login is removed',
  repair.includes('alter column sender_id drop not null') && repair.includes('on delete set null'),
  'on delete cascade would take every parcel the person sent, and their recipients’ history with it',
);
check(
  'and the carrier pair tolerates a removed login',
  /driver_pair_consistent check \(\s*driver_id is null or driver is not null/.test(repair),
  'the old both-or-neither rule raised for anyone who had ever carried a parcel',
);
check(
  'the erase function reaches the tables added since 09_bans.sql',
  [
    'sender_identity',
    'photo_capture_sessions',
    'push_tokens',
    'payout_change_requests',
    'payout_requests',
    'driver_edit_history',
    'driver_documents',
  ].every((table) => repair.includes(`public.${table}`)),
  'an erasure that misses a NIN, a face photograph or a bank account is a failure reporting success',
);
/*
 * Pinned to the absence of a statement, not to a sentence about it.
 *
 * My first version matched the prose "driver_earnings is left alone" and failed
 * on a line wrap — the file says "`driver_earnings` is left\n alone". Wrapping
 * is not a behaviour change, and an assertion that a comment reflows can break
 * is an assertion nobody trusts. What matters is that no statement touches the
 * table.
 */
check(
  'the ledger amounts survive the scrub',
  !/(delete from|update)\s+public\.driver_earnings/.test(code(repair)),
  'deleting them would leave LOCI unable to reconcile its own bank statement',
);
/*
 * The guard, not its message.
 *
 * Checking for the sentence "has not been erased yet" passed while the `if`
 * around it was gutted to `if (false)` — the string stayed and the refusal
 * went. Third time this exact shape has slipped through in this project, so:
 * pin the condition.
 */
const eraseFn = read('supabase/functions/erase-auth-user/index.ts');
check(
  'the auth login is removed by a function that refuses to start an erasure',
  /if \(!subjectProfile\.deleted_at\)/.test(eraseFn) && eraseFn.includes('has not been erased yet'),
  'deleting a login first strands the data with no handle to reach it by',
);
check(
  'and it identifies the caller from their token rather than the body',
  eraseFn.includes('/auth/v1/user') && !/body\.(caller|admin|actor)/.test(eraseFn),
  'a body-supplied caller id would let any account claim to be an admin on the one endpoint holding the service key',
);
check(
  'and the screen reports which of the two happened',
  adminUsers.includes('Data erased, login remains') &&
    !adminUsers.includes('Their login still exists —'),
  'a plain "Account erased" would claim a login was removed on a project that cannot remove it',
);

check(
  'erasure needs a typed confirmation',
  read('src/app/(tabs)/admin-users.tsx').includes('confirmWord="ERASE"'),
  'irreversible should not be one tap',
);
check(
  'but banning does not',
  !/action === 'ban'[\s\S]{0,900}confirmWord/.test(read('src/app/(tabs)/admin-users.tsx')),
  'asking for a typed word everywhere trains people to type it without reading',
);
check(
  'the dialog lists consequences before the action',
  dialog.includes('consequences') && dialog.includes('Itemised rather than prose'),
);

const ops = read('src/app/(tabs)/admin-ops.tsx');
check(
  'hubs are editable and creatable from the ops screen',
  ops.includes('HubEditor') &&
    ops.includes("setEditor({ mode: 'edit', hub })") &&
    ops.includes("setEditor({ mode: 'create' })"),
  'this replaced the "hubs live in source control" notice',
);
check(
  'and the seed fallback disables saving rather than failing silently',
  ops.includes('disabled={usingSeed}') && flat(ops).includes('edits cannot be saved'),
  'without the table a save would fail after the address had been retyped',
);

const logs = read('src/app/(tabs)/admin-logs.tsx');
check(
  'the empty log distinguishes "nothing wrong" from "nothing wired up"',
  logs.includes('nothing has called logEvent yet'),
  'those look identical and mean opposite things',
);

// ------------------------------------- the server's sentence reaches a person --

/*
 * ⚠ `thrown instanceof Error` is FALSE for every Supabase failure.
 *
 *   `PostgrestError` is a plain object built from a JSON response —
 *   `{ message, details, hint, code }` — and has never been an `Error`
 *   subclass. So `thrown instanceof Error ? thrown.message : 'The database
 *   refused the change.'` took the second branch every single time.
 *
 *   Twenty-six call sites did exactly that. Every database refusal in the admin
 *   area, the auth screens and the driver flows printed the same fallback,
 *   whatever Postgres actually said — so "Use the phone number you signed up
 *   with" and a network timeout were indistinguishable, and an operator staring
 *   at "The database refused the change" had no way to act on it.
 *
 *   `String(thrown)` is the same bug wearing a different coat: on a plain
 *   object it yields "[object Object]".
 *
 * Swept over the whole of src/ rather than spot-checked. The failure mode is
 * one more `catch` written the obvious way, and a list of files to check would
 * go stale before the risk did.
 */
function walkSource(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkSource(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const swallowed: string[] = [];
for (const path of walkSource('src')) {
  if (path.endsWith('lib/errors.ts')) continue;
  const source = read(path);

  /*
   * The two shapes that discard the message. `instanceof Error` on its own is
   * fine — `upload.ts` rethrows a DOM error, `webcam-capture.tsx` reads a
   * `.name` — so only the message-losing forms are flagged.
   */
  for (const match of source.matchAll(/instanceof Error\s*\?\s*\w+\.message\s*:/g)) {
    swallowed.push(`${path}: ${match[0]}`);
  }
  /*
   * `String(thrown)` as the fallback is the same bug wearing a different coat:
   * on a plain object it yields "[object Object]", which then fails every
   * `includes` test downstream. Counted separately so the message names it.
   */
  if (/instanceof Error\s*\?\s*\w+\.message\s*:\s*String\(/.test(source)) {
    swallowed.push(`${path}: String() fallback yields "[object Object]"`);
  }
}

check(
  'no catch discards a Supabase error message',
  swallowed.length === 0,
  swallowed.slice(0, 6).join('\n       ') || 'use errorMessage() from src/lib/errors.ts',
);

check(
  'and the extractor reads a PostgrestError rather than requiring an Error',
  (() => {
    const errors = read('src/lib/errors.ts');
    return errors.includes('error.details') && errors.includes('error.hint');
  })(),
  'a foreign-key failure puts the useful half in `details`, which taking only `message` throws away',
);

// ---------------------------------------------- one vocabulary for levels --

/*
 * ⚠ Every `app_events` insert in every migration, checked against the CHECK
 *   constraint that will actually reject it.
 *
 *   `07_admin.sql` allows 'info' | 'warning' | 'error'. Twelve inserts across
 *   nine migrations wrote 'warn'. Each one was a statement that would abort at
 *   runtime — cancelling a parcel, changing a payout account, revealing a
 *   contact, recording an identity check, saving a high-risk profile edit,
 *   settling a failed payout, switching dispatch mode — and none of them was
 *   reachable from a test, because every PGlite scaffold stubbed the column as
 *   a bare `text`.
 *
 *   The harnesses now carry the real constraint, so the ones they exercise are
 *   caught by execution. This sweep covers the rest: it reads every migration
 *   rather than the ones somebody remembered to write a harness for.
 */
const MIGRATION_DIR = join(ROOT, 'supabase');
const ALLOWED_LEVELS = new Set(['info', 'warning', 'error']);

const badLevels: string[] = [];

for (const file of readdirSync(MIGRATION_DIR).filter((name) => name.endsWith('.sql'))) {
  const source = readFileSync(join(MIGRATION_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  /*
   * ⚠ Scoped to each `insert into public.app_events`, not swept across the file.
   *
   *   My first version matched `values ( 'x', 'y'` anywhere, which flagged the
   *   `document_kinds` seed in 31 — a table whose first column happens to be a
   *   quoted key. A sweep that reports a correct file is a sweep somebody
   *   silences.
   *
   *   Two shapes inside each insert: a literal first value, and the
   *   `case … then 'x' else 'y' end` form that picks a level per row.
   */
  for (const start of [...source.matchAll(/insert into public\.app_events/g)]) {
    const statement = source.slice(start.index ?? 0, (start.index ?? 0) + 700);

    for (const match of statement.matchAll(/values\s*\(\s*\n?\s*'(\w+)'/g)) {
      if (!ALLOWED_LEVELS.has(match[1])) badLevels.push(`${file}: values('${match[1]}', …)`);
    }
    for (const match of statement.matchAll(/then '(\w+)' else '(\w+)' end/g)) {
      for (const level of [match[1], match[2]]) {
        if (!ALLOWED_LEVELS.has(level)) badLevels.push(`${file}: case … '${level}'`);
      }
    }
  }
}

check(
  'no migration logs at a level the app_events constraint refuses',
  badLevels.length === 0,
  badLevels.join('\n       ') || 'allowed: info, warning, error',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — every Admin dropdown item resolves to a real screen, a ban bites in the database rather\n' +
    '       than the UI, erasure scrubs every identifying field and destroys no parcel,\n' +
    '       is_admin stays un-writable by any\n' +
    '       client, the grant function refuses self-changes and the last demotion, the audit\n' +
    '       log has no client write path, the event log is insert-only, and the dashboards\n' +
    '       count rows without granting anyone read access to parcels.',
);
