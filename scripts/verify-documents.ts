/**
 * Assertions for document expiry and the dispatch mode switch.
 *
 * `scripts/pg/documents-harness.mjs` executes both migrations and proves the
 * behaviour. This file covers what execution cannot see:
 *
 *   · that the client's copy of the document policy agrees with the SQL,
 *     field for field — they are two hand-maintained lists and the failure
 *     mode of a disagreement is silent
 *   · that a date typed day-first is read day-first
 *   · that the surfaces say what the rules cost
 *
 * The first of those is the one that matters most. A driver's ability to earn
 * now depends on a key matching between a TypeScript array and a Postgres
 * table, and nothing in either language checks the other.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expiryMessage, isoToInput, maskExpiryInput, parseExpiry } from '../src/lib/expiry';
import { canEditExpiry, EXPIRY_LOCK_REASON, type DriverDocument } from '../src/store/documents';
import {
  modeBanner,
  waitLabel,
  UNKNOWN_HEALTH,
  type DispatchHealth,
} from '../src/store/dispatch-mode';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const expirySql = read('supabase/31_document_expiry.sql');
const modeSql = read('supabase/32_dispatch_mode.sql');
const signup = read('src/app/(tabs)/driver-signup.tsx');
const locker = read('src/components/ui/document-locker.tsx');
const control = read('src/components/ui/dispatch-control.tsx');
const store = read('src/store/dispatch-mode.ts');
const admin = read('src/app/(tabs)/admin.tsx');

/*
 * ⚠ `/*` only counts as a comment when something could precede it.
 *
 *   `driver-signup.tsx` passes `type: ['image/*', 'application/pdf']` to the
 *   document picker. The old pattern saw the `/*` inside that string, ran to
 *   the next real `*\/` hundreds of lines below, and deleted everything in
 *   between — including a guard this file asserts the presence of, and,
 *   worse, code that other negative assertions were checking the *absence* of.
 *   Those passed for the best part of a day by examining a truncated file.
 *
 *   Requiring a boundary character in front distinguishes a comment opener
 *   from two characters in the middle of a string.
 */
const code = (source: string) =>
  source
    .replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// ------------------------------------------- the two copies of the policy --

/*
 * The document policy exists twice: `public.document_kinds` decides, and the
 * `expiry` field on the signup form's DOCUMENTS array decides which input to
 * render. They are parsed out of both files and compared rather than
 * transcribed, so this cannot pass by me writing the same wrong thing twice.
 */
type Policy = { required: boolean; allowed: boolean; blocks: boolean };

const sqlPolicy = new Map<string, Policy>();
for (const line of expirySql.matchAll(
  /\('(\w+)',\s*'[^']*(?:''[^']*)*',\s*(true|false),\s*(true|false),\s*(true|false),\s*\d+\)/g,
)) {
  sqlPolicy.set(line[1], {
    required: line[2] === 'true',
    allowed: line[3] === 'true',
    blocks: line[4] === 'true',
  });
}

const clientPolicy = new Map<string, string>();
for (const entry of signup.matchAll(/expiry: '(required|optional|none)',\s*\n\s*key: '(\w+)'/g)) {
  clientPolicy.set(entry[2], entry[1]);
}
// The first entry lists `key` before `expiry`; catch that ordering too.
for (const entry of signup.matchAll(
  /key: '(\w+)',[\s\S]{0,900}?expiry: '(required|optional|none)'/g,
)) {
  if (!clientPolicy.has(entry[1])) clientPolicy.set(entry[1], entry[2]);
}

/*
 * ⚠ Six in SQL, five on the form, and the gap is deliberate.
 *
 *   `guarantorId` — the guarantor's NIN slip — is no longer offered: the
 *   guarantor uploads nothing, and verifies themselves through an invitation
 *   instead. The policy row stays so that slips uploaded before that change
 *   remain valid documents an admin can still open. A form slot with no policy
 *   would be the dangerous direction; a policy with no slot is just history.
 */
check('the SQL policy table parsed', sqlPolicy.size === 6, `${sqlPolicy.size} kinds`);
check('the client policy parsed', clientPolicy.size === 5, `${clientPolicy.size} documents`);
check(
  'the form no longer asks for the guarantor’s ID',
  !clientPolicy.has('guarantorId'),
  'a driver photographing somebody else’s national ID is what this change removed',
);

/*
 * The licence is two uploads, and only the front carries the date.
 *
 * Both faces are needed — the back holds the class and the endorsements — but a
 * card has one expiry printed on one side. Asking for it twice invites two
 * different answers, and the row that decides whether dispatch stops would then
 * depend on which one the driver typed more carefully.
 */
check(
  'the licence has a front and a back slot',
  sqlPolicy.has('license') && sqlPolicy.has('licenseBack'),
  [...sqlPolicy.keys()].join(', '),
);
check(
  'and only the front asks for the expiry date',
  sqlPolicy.get('licenseBack')?.allowed === false && sqlPolicy.get('license')?.required === true,
  'one card, one date — two fields for it is two chances to disagree',
);
check(
  'the back does not block dispatch on its own',
  sqlPolicy.get('licenseBack')?.blocks === false,
  'it has no date to lapse, so it can only ever block by accident',
);

/*
 * Both government-ID slots are NIN, and the form has to say so.
 *
 * A slot labelled "government ID" collects passports, voter cards and driving
 * licences, and the NIN match at verification then fails against a number the
 * driver did give us — a rejection they cannot act on because nothing told them
 * which document was wanted.
 */
/*
 * ⚠ One slot now. The guarantor's came off the form entirely.
 */
for (const [key, whose] of [['id', "the driver's"]] as const) {
  // Labels are written with either quote — "Guarantor's NIN slip" cannot use
  // single ones. Matching only `'` walked past this entry into the next one.
  const label = new RegExp(`key: '${key}',\\s*\\n\\s*label: (['"])(.*?)\\1`).exec(signup)?.[2];
  check(
    `${whose} ID slot names NIN in the label`,
    /NIN/.test(label ?? ''),
    `label reads: ${label ?? '(not found)'}`,
  );
}

check(
  'every document the form uploads exists in the policy table',
  [...clientPolicy.keys()].every((key) => sqlPolicy.has(key)),
  `client: ${[...clientPolicy.keys()].join(', ')}\n       sql: ${[...sqlPolicy.keys()].join(', ')}`,
);

/*
 * The spelling trap, pinned explicitly because it already bit.
 *
 * The signup form has written `license` (US) into the documents jsonb and into
 * the storage path since it shipped. My first draft of `document_kinds` used
 * `licence` (British), which would have left the backfill matching nothing —
 * every existing licence unmodelled, and the dispatch block silently inert for
 * the one document it most needs to cover.
 */
check(
  'the licence key is spelled the way the storage paths already are',
  sqlPolicy.has('license') && !sqlPolicy.has('licence'),
  'a mismatch here is invisible: the backfill matches nothing and no document can ever expire',
);

for (const [key, expiry] of clientPolicy) {
  const sql = sqlPolicy.get(key);
  if (!sql) continue;

  check(
    `${key}: the form and the server agree on whether a date is required`,
    sql.required === (expiry === 'required'),
    `form says ${expiry}, SQL says required=${sql.required}`,
  );
  check(
    `${key}: the form and the server agree on whether a date is allowed at all`,
    sql.allowed === (expiry !== 'none'),
    `form says ${expiry}, SQL says allowed=${sql.allowed}`,
  );
}

check(
  'exactly the two documents with legal force block dispatch',
  [...sqlPolicy.entries()]
    .filter(([, p]) => p.blocks)
    .map(([k]) => k)
    .sort()
    .join(',') === 'insurance,license',
  'blocking a vehicle photograph would idle a driver over the age of a picture',
);

// ------------------------------------------------------ reading the date --

check(
  'a partial entry is not an error yet',
  parseExpiry('03/04').ok === null,
  'a field that turns red on the third keystroke is shouting at somebody still typing',
);
check('an empty entry is not an error', parseExpiry('').ok === null);

/*
 * A year computed from today, not a literal.
 *
 * My first version used 2099 and failed — correctly. `parseExpiry` refuses
 * anything more than fifty years out, because `2029` mistyped as `2209` makes a
 * document that never expires and never blocks, and the test had walked into
 * its own guard. A hard-coded year would also have quietly started failing on
 * some future run, which is the worst kind of test.
 */
const soon = new Date().getUTCFullYear() + 3;
const dayFirst = parseExpiry(`03/04/${soon}`);
check(
  'a date is read day-first, the way Nigeria writes them',
  dayFirst.ok === true && dayFirst.iso === `${soon}-04-03`,
  dayFirst.ok === true ? dayFirst.iso : JSON.stringify(dayFirst),
);
check(
  'and echoed back unambiguously for the driver to check',
  dayFirst.ok === true && dayFirst.pretty === `3 April ${soon}`,
  dayFirst.ok === true ? dayFirst.pretty : JSON.stringify(dayFirst),
);

/*
 * The overflow case, on an otherwise-acceptable year.
 *
 * `new Date(2029, 1, 30)` silently becomes 2 March, so a date the driver never
 * typed would be stored and reminded on. Using a far-future year here would
 * have passed for the wrong reason — the year ceiling would have caught it
 * before the calendar check ever ran.
 */
check(
  'a day that does not exist in that month is refused, not rolled forward',
  parseExpiry(`30/02/${soon}`).ok === false,
  'JavaScript rolls the overflow rather than refusing it',
);
check('a month above twelve is refused', parseExpiry(`01/13/${soon}`).ok === false);
check('a date already past is refused before the upload', parseExpiry('01/01/2020').ok === false);
check(
  'and an absurd year is caught',
  parseExpiry('03/04/2209').ok === false,
  '2029 mistyped as 2209 makes a document that never expires and never blocks',
);

check('the mask groups as it is typed', maskExpiryInput('03042049') === '03/04/2049');
check('and drops anything that is not a digit', maskExpiryInput('0a3/b04') === '03/04');
check('an ISO date round-trips back into the field', isoToInput('2049-04-03') === '03/04/2049');

// ------------------------------------------------- what the driver is told --

check(
  'an expired blocking document says what it costs in the same sentence',
  /not being offered parcels/i.test(
    expiryMessage({
      state: 'expired',
      daysLeft: -3,
      expiresAt: '2020-01-01',
      blocksDispatch: true,
      expiryAllowed: true,
    }),
  ),
  '"Expired" alone is a status; a driver cannot connect it to the work having stopped',
);
check(
  'an expired non-blocking one does not claim the work has stopped',
  !/not being offered/i.test(
    expiryMessage({
      state: 'expired',
      daysLeft: -3,
      expiresAt: '2020-01-01',
      blocksDispatch: false,
      expiryAllowed: true,
    }),
  ),
  'over-warning is how a driver learns to ignore the warning that matters',
);
check(
  'an approaching blocking one warns before the date',
  /stop receiving/i.test(
    expiryMessage({
      state: 'expiring',
      daysLeft: 9,
      expiresAt: '2099-01-01',
      blocksDispatch: true,
      expiryAllowed: true,
    }),
  ),
);
/*
 * ⚠ Two different absences, and the wording must not merge them.
 *
 *   A NIN slip has no expiry because none exists to record. A licence with a
 *   blank date has one printed on it that LOCI never asked for. Saying "no
 *   expiry date recorded" of both reads, on the NIN, as a gap the driver should
 *   close and cannot — and on the licence it fails to say that closing it is
 *   exactly what is wanted.
 *
 *   This became load-bearing when the government ID slots stopped carrying
 *   dates: three of the five rows now hit the first branch.
 */
check(
  'a document that cannot expire says so, and asks for nothing',
  /does not expire/i.test(
    expiryMessage({
      state: 'ok',
      daysLeft: null,
      expiresAt: null,
      blocksDispatch: false,
      expiryAllowed: false,
    }),
  ),
);
check(
  'a document that can expire but has no date asks for one',
  /add the date printed on it/i.test(
    expiryMessage({
      state: 'none',
      daysLeft: null,
      expiresAt: null,
      blocksDispatch: true,
      expiryAllowed: true,
    }),
  ),
  'the two absences read identically otherwise, and only one of them is actionable',
);

// ------------------------------------------ which slots carry a date at all --

check(
  'the government ID slots carry no expiry date',
  sqlPolicy.get('id')?.allowed === false && sqlPolicy.get('guarantorId')?.allowed === false,
  'a NIN slip has no date printed on it; an optional field there produces an invented one',
);
check('and neither does the vehicle photograph', sqlPolicy.get('vehicle')?.allowed === false);
check(
  'exactly the licence and insurance ask for a date',
  [...sqlPolicy.entries()]
    .filter(([, p]) => p.allowed)
    .map(([k]) => k)
    .sort()
    .join(',') === 'insurance,license',
);
check(
  'and a date recorded against a slot that no longer allows one is cleared',
  /set expires_at = null[\s\S]{0,200}not k\.expiry_allowed/.test(expirySql),
  'a re-run after the policy narrowed would otherwise strand a value nobody can correct',
);

// ------------------------------------------------------- the mode banner --

const health = (over: Partial<DispatchHealth>): DispatchHealth => ({ ...UNKNOWN_HEALTH, ...over });

check(
  'auto with a clear queue reads as fine',
  modeBanner(health({ mode: 'auto' })).tone === 'success',
);
check(
  'manual with nothing waiting is a warning, not an alarm',
  modeBanner(health({ mode: 'manual' })).tone === 'warning',
);
check(
  'manual with a real backlog escalates',
  modeBanner(health({ mode: 'manual', unassigned: 9, oldestWaitMinutes: 90 })).tone === 'danger',
  'a banner identical at zero parcels and at ninety is ignored in both cases',
);
check(
  'and every manual banner says offers have stopped',
  /no.*offers/i.test(modeBanner(health({ mode: 'manual' })).body) &&
    /no offers are being made/i.test(modeBanner(health({ mode: 'manual', unassigned: 3 })).body),
);
check(
  'auto still surfaces parcels nobody took',
  /found nobody/i.test(modeBanner(health({ mode: 'auto', unassigned: 4 })).body),
  'auto-dispatch leaves parcels unassigned routinely, and those are the ones a human should see',
);

check('a wait under an hour reads in minutes', waitLabel(45) === '45m');
check('and over an hour in both', waitLabel(135) === '2h 15m');

// --------------------------------------------------------- the SQL gates --

/*
 * `dispatch_booking` is defined in several migrations; 32 is the last one, so
 * it is the definition that survives. Both gates have to be in *that* copy.
 */
check(
  'the final dispatch_booking stands down in manual mode',
  /if public\.dispatch_mode\(\) = 'manual' then\s*\n\s*return null;/.test(modeSql),
  'guarding the insert trigger instead would leave the decline path rotating parcels while an operator believed they had control',
);
check(
  'and filters expired drivers inside the candidate query',
  /and public\.documents_permit_dispatch\(j\.driver_id\)/.test(modeSql),
  'checking after choosing would let a blocked driver consume the dispatch while an available one waits behind them',
);
check(
  'the document gate sits before the ORDER BY, not after the pick',
  modeSql.indexOf('documents_permit_dispatch(j.driver_id)') < modeSql.indexOf('order by'),
);
check(
  'an admin cannot hand a parcel to a blocked driver either',
  /if not public\.documents_permit_dispatch\(driver\) then/.test(modeSql),
  'that is a legal limit rather than a matching preference',
);
check(
  'hand-assigning settles any live offer on the parcel',
  /update public\.dispatch_offers[\s\S]{0,200}status = 'expired'[\s\S]{0,120}where booking_id = parcel/.test(
    modeSql,
  ),
  'otherwise a driver taps Accept on a parcel that is already gone',
);
check(
  'the queue feed is not gated on the mode',
  !/dispatch_mode\(\)/.test(
    modeSql.slice(
      modeSql.indexOf('function public.unassigned_parcels'),
      modeSql.indexOf('function public.assignable_drivers'),
    ),
  ),
  'hiding the queue in auto mode blanks the screen exactly when the automation is quietly failing',
);
check(
  'the mode defaults to auto rather than to manual',
  /= 'manual'\s*\n\s*then 'manual'\s*\n\s*else 'auto'/.test(modeSql),
  'the inverse default would let one absent settings row silently halt dispatch platform-wide',
);
check(
  'switching to manual is logged loudly, with the queue depth',
  /case when mode = 'manual' then 'warning' else 'info' end/.test(modeSql) &&
    /'unassigned_parcels', waiting/.test(modeSql),
);
check(
  'returning to auto sweeps the backlog rather than waiting for the next cron',
  /if mode = 'auto' and previous = 'manual' then[\s\S]{0,300}dispatch_booking\(b\.id\)/.test(
    modeSql,
  ),
  'an operator watching an unchanged queue concludes the toggle is broken',
);

check(
  'a document with no recorded date does not block anybody',
  /and d\.expires_at is not null\s*\n\s*and d\.expires_at < current_date/.test(expirySql),
  'the backfill cannot invent dates, so "has no valid document" would have taken every working driver off the road',
);
check(
  'the expired reminder is not throttled by an earlier, different reminder',
  /elsif doc\.reminder_stage = expired_stage then/.test(expirySql),
  'the one message a driver cannot afford to miss must not be swallowed by the one before it',
);
check(
  'a replacement clears both the verified badge and the ladder',
  /status = 'pending',[\s\S]{0,200}reminder_stage = null/.test(expirySql),
);
check(
  'document_state is stable rather than immutable',
  /create or replace function public\.document_state[\s\S]{0,200}\nstable\n/.test(expirySql),
  'it reads current_date; mislabelling it immutable is what let Postgres constant-fold journey_matches',
);

// ------------------------------------------------------------ the screens --

check(
  'the driver documents card names the block and how to clear it',
  /not being offered parcels/i.test(code(locker)) &&
    /start receiving trips again/i.test(code(locker)),
);
/*
 * The wording moved with the list.
 *
 * This used to pin "tap a document below", which stopped being true the moment
 * the list moved into the Edit your details sheet — the banner would have been
 * pointing at something no longer on the page. What is asserted now is the two
 * things that have to survive any rewording: no re-upload is needed, and the
 * driver is told where to go.
 */
check(
  'it prompts for the dates the backfill could not supply',
  /Add the expiry dates/.test(code(locker)) &&
    /do not need\s*\n?\s*to upload anything again|not need to upload anything again/i.test(
      code(locker),
    ) &&
    /Edit your details/.test(code(locker)),
  'requiring a fresh scan purely to type a date is the busywork that makes people ignore the prompt',
);
check(
  'and it renders slots that were never filled',
  /state === 'missing'|statusLabel/.test(code(locker)),
);

/*
 * ---------- status on the page, information in the sheet ----------
 *
 * The locker is two components on purpose. `DocumentAlerts` renders the urgent
 * banners on Be a Driver / Updates; `DocumentList` renders every document
 * inside Edit your details, next to the rest of the submitted application.
 *
 * Both halves are asserted, and so is the *absence* of each from the other
 * surface. One component in both places would either bury "you are not being
 * offered parcels" behind a button, or duplicate the whole card — and this
 * project has already had to undo that duplication twice.
 */
const sheet = read('src/components/ui/profile-edit-sheet.tsx');
const updates = read('src/app/(tabs)/driver-updates.tsx');

check(
  'the edit sheet shows the documents that were submitted',
  /<DocumentList \/>/.test(code(sheet)),
  'a sheet showing only the typed answers answers "what does LOCI have for me" by half',
);
check(
  'the updates page shows the alerts without opening anything',
  /<DocumentAlerts \/>/.test(code(updates)),
  'a driver whose work has stopped must not have to open an editing sheet to find out why',
);
check(
  'and neither surface carries the other half',
  !/<DocumentAlerts/.test(code(sheet)) && !/<DocumentList/.test(code(updates)),
  'one component in both places is the duplication this project keeps undoing',
);
check(
  'the alerts render nothing when there is nothing wrong',
  /if \(blocking\.length === 0 && expiring\.length === 0 && undated\.length === 0\) return null;/.test(
    code(locker),
  ),
  'an empty banner slot above the profile editor is a permanent gap on a healthy account',
);
check(
  'the expiry date is the only editable thing on a document',
  /setDocumentExpiry\(/.test(code(locker)) && !/uploadDocument|recordDocument/.test(code(locker)),
  'replacing a file is a support route today; a Replace button that did nothing would be worse than saying so',
);

/*
 * ---------- read-only while in date ----------
 *
 * A valid document's date cannot be changed. The point of the rule is that a
 * driver renews the card rather than pushes the date out, so the four cases
 * below are asserted as a pure function and the server is asserted to hold the
 * same line — a client-only lock is a statement about a form, not a system.
 */
const doc = (over: Partial<DriverDocument>): DriverDocument => ({
  kind: 'license',
  label: "Driver's licence",
  path: 'u1/license.jpg',
  status: 'verified',
  reviewNote: null,
  expiresAt: '2030-01-01',
  daysLeft: 900,
  state: 'ok',
  expiryRequired: true,
  expiryAllowed: true,
  blocksDispatch: true,
  uploadedAt: null,
  ...over,
});

check(
  'a document comfortably in date is read-only',
  !canEditExpiry(doc({})),
  'an always-open date field on a valid licence invites pushing the date out instead of renewing',
);
check('an expired one can be corrected', canEditExpiry(doc({ state: 'expired', daysLeft: -2 })));
check(
  'and so can one inside its renewal window',
  canEditExpiry(doc({ state: 'expiring', daysLeft: 9 })),
  'refusing here means a driver who renewed early loses a day of work for being organised',
);
check(
  'a document with no date on file is always editable',
  canEditExpiry(doc({ expiresAt: null, daysLeft: null, state: 'ok' })),
  'every document predating the migration is in this state; without it the reminder ladder never starts',
);
check(
  'a slot with no file, and one that carries no date at all, are not editable',
  !canEditExpiry(doc({ path: null, expiresAt: null })) &&
    !canEditExpiry(doc({ kind: 'vehicle', expiryAllowed: false, expiresAt: null })),
);
check(
  'the lock explains itself and says when it lifts',
  /unlocks when renewal is due/i.test(EXPIRY_LOCK_REASON),
  'a locked control with no explanation reads as a broken control',
);
/*
 * Declared *and shown on the locked row*.
 *
 * Asserting the constant's wording passed while the row that displays it was
 * gated off entirely — the explanation existed and nobody could read it.
 * Mutation testing caught that, so the guard is what is pinned now.
 */
check(
  'and the row that is locked is the row that explains it',
  /!canEditExpiry\(doc\) && \(/.test(code(locker)) && /\{EXPIRY_LOCK_REASON\}/.test(code(locker)),
  'an explanation nobody renders is the same as no explanation',
);
check(
  'and the server enforces the same window, not just the form',
  /current_row\.expires_at - current_date > public\.document_warning_days\(\)/.test(expirySql),
  'set_document_expiry is an rpc call; anyone who can open a network tab can send it',
);

/*
 * The empty card. This shipped rendering a header, a rule and a footnote with
 * nothing between them whenever `my_documents` came back empty — which is what
 * a driver saw before the migration had been run, and it reads as a broken
 * screen rather than a missing backend.
 */
/*
 * Pinned to the third branch, not to the phrase.
 *
 * `/documents\.length === 0 \?/` matched the *loading* line one branch above,
 * so gutting the empty branch left this passing. The property is that the
 * ternary has three arms: loading, empty, list.
 */
check(
  'an empty document list says so instead of rendering a blank card',
  /\) : documents\.length === 0 \? \([\s\S]{0,400}could not load your documents/i.test(
    code(locker),
  ),
);

check(
  'the admin screen has a Dispatch tab between Overview and Driver review',
  /const SECTIONS = \['overview', 'dispatch', 'review'\] as const;/.test(code(admin)),
  'the tab you reach for during an incident should not be furthest from the tab that told you there was one',
);
check(
  'and it renders the control',
  /section === 'dispatch' && <DispatchControl \/>/.test(code(admin)),
);

check(
  'switching into manual is confirmed and names the consequence',
  /Switch to manual assignment\?/.test(code(control)) &&
    /stop offering parcels/i.test(code(control)),
);
check(
  'switching back to auto is not confirmed',
  /if \(next === 'auto'\) \{\s*\n\s*void apply\(next\);/.test(code(control)),
  'a confirmation on the safe direction is a dialog people learn to dismiss, including the one that mattered',
);
check(
  'the control renders whatever mode the server reports, not what was clicked',
  /outcome\.mode === 'manual'/.test(code(control)) && !/next === 'manual' \?/.test(code(control)),
  'two admins can hold this screen at once',
);
check(
  'ineligible drivers are listed rather than hidden',
  /!candidate\.eligible/.test(code(control)) && /'Blocked'/.test(code(control)),
  'a list filtered to auto-eligible drivers is a slower copy of the automation',
);
check(
  'but a blocked one cannot be tapped',
  /disabled=\{busy \|\| !candidate\.eligible\}/.test(code(control)),
);
check(
  'blocked drivers are counted next to the queue',
  /Blocked drivers/.test(code(control)),
  '"nine waiting" and "four drivers blocked" is one story; the first half alone sends an operator hunting a dispatch bug',
);

/*
 * ---------- an unread status is not a healthy one ----------
 *
 * `fetchDispatchHealth` used to swallow every error and return `UNKNOWN_HEALTH`
 * — mode 'auto', all counts zero — which the panel rendered as a green
 * "Automatic matching is on. Nothing is waiting."
 *
 * So the one screen whose job is to say whether parcels are moving reported
 * that they were, on no evidence at all: a dispatch outage and a quiet Tuesday
 * looked identical. It shipped that way and an operator hit it.
 *
 * Four things have to hold, and each is a separate way of telling the same lie.
 */
/*
 * ⚠ Pinned to the error path, not to the type signature.
 *
 *   My first version checked that `HealthOutcome` appeared in the file and that
 *   `Promise<UnassignedParcel[] | null>` was the return type. Both survived
 *   mutation: the declarations stayed while the bodies went back to returning
 *   `{ ok: true, health: UNKNOWN_HEALTH }` and `[]`. A signature describes what
 *   a function *may* return; only the body decides what it does on failure.
 */
const bodyOf = (name: string) => {
  const start = code(store).indexOf(`export async function ${name}`);
  const rest = code(store).slice(start + 1);
  const end = rest.indexOf('\nexport ');
  return rest.slice(0, end === -1 ? undefined : end);
};

const healthBody = bodyOf('fetchDispatchHealth');
check(
  'the health fetch reports failure instead of a healthy-looking default',
  /return \{ ok: false/.test(healthBody) && !/UNKNOWN_HEALTH/.test(healthBody),
  'mode auto with every count at zero is indistinguishable from a working platform with an empty queue',
);

const queueBody = bodyOf('fetchUnassignedParcels');
check(
  'and the queue distinguishes "could not read" from "nothing waiting"',
  /if \(error \|\| !data\) return null;/.test(queueBody),
  'an empty array renders "every booked parcel has a driver", which is a claim about a query that never returned',
);
check(
  'the panel shows the reason rather than a mode it cannot verify',
  /Dispatch status unavailable/.test(code(control)) &&
    /active=\{!unavailable && health\.mode === 'auto'\}/.test(code(control)),
  'a toggle lit on Automatic during an outage asserts the one thing nobody can currently check',
);
check(
  'neither mode can be switched while the status is unknown',
  (code(control).match(/disabled=\{switching \|\| unavailable !== null\}/g) ?? []).length === 2,
  'the first thing an operator does with a broken panel is press the button on it',
);
check(
  'and the counts read as unknown rather than as zero',
  (code(control).match(/unavailable \? '—'/g) ?? []).length === 3,
  '"0 Waiting" is a measurement; printing it without measuring is the green banner in smaller type',
);

/*
 * PostgREST's own message — "Could not find the function … in the schema cache"
 * — is accurate and unactionable. It means the migration has not been run, or
 * has been run and the API cache is stale, and both have a fix worth naming.
 */
check(
  'a missing function is translated into what to actually do',
  /PGRST202/.test(code(store)) && /reload schema/.test(code(store)),
  'an operator cannot act on "schema cache"',
);

check(
  'the signup form explains the cost of letting one lapse',
  /stop offering you parcels/i.test(code(signup)),
);
check(
  'a failed expiry record does not throw away the application',
  /await recordDocument\(\{/.test(code(signup)) &&
    !/if \(!recorded\.ok\) \{[\s\S]{0,120}return;/.test(code(signup)),
  'refusing a thirty-field submission over a missing date is worse than the gap it prevents',
);

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failing assertion${failures === 1 ? '' : 's'}.`);
  process.exit(1);
}

console.log(
  'PASS — the form and the policy table agree on every document including the licence key\n' +
    '       spelling, dates are read day-first and echoed back to be checked, an impossible\n' +
    '       date is refused rather than rolled forward, a dateless document blocks nobody,\n' +
    '       the expired notice cannot be swallowed by an earlier one, manual mode is\n' +
    '       confirmed and loud while returning to auto is neither, and the queue stays\n' +
    '       visible in both modes.',
);
