/**
 * Assertions for the admin review queue, now that it has six statuses.
 *
 * ⚠ The failure this guards is a queue that looks emptier than it is.
 *
 *   `pending` and `ready_for_review` both mean "an admin's to pick up". The
 *   first is every application submitted before guarantor verification existed;
 *   the second is every one submitted since. A filter or a count that knows
 *   only `pending` shows a *shrinking* number while the real queue grows,
 *   because the half it hides is the half that is still arriving.
 *
 *   Nothing about that looks broken. The screen renders, the list is sorted,
 *   the count is a number — it is simply the wrong number, in the direction
 *   that stops anybody investigating.
 *
 * ⚠ And an application waiting on a guarantor is not backlog.
 *
 *   Nobody at LOCI may touch it. Counting it as overdue would inflate the
 *   figure an ops team staffs against with work that hiring cannot clear.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { reviewTimeline } from '../src/store/application-timeline';
import {
  AWAITING_REVIEW,
  STATUS_LABELS,
  canApprove,
  canReject,
  isAwaitingReview,
  isOverdue,
  isWaitingOnGuarantor,
  statusChangeMessage,
  type ApplicationStatus,
  type DriverApplication,
} from '../src/store/driver-applications';

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
 * ⚠ Derived from the labels, not hand-written.
 *
 *   A hand-written list here would be a third copy of the status vocabulary,
 *   and the assertions below would go on passing when somebody adds a seventh
 *   status and forgets this file — which is exactly the bug they exist to
 *   catch.
 */
const ALL_STATUSES = Object.keys(STATUS_LABELS) as ApplicationStatus[];

const application = (status: ApplicationStatus, submittedAt: string): DriverApplication =>
  ({
    id: 'a',
    status,
    submittedAt,
    reference: 'LOCI-1',
    reviewNote: null,
    reviewedAt: null,
    /*
     * ⚠ Present, because the guarantor step only renders for applications that
     *   have one — a legacy application with no invitation is not shown a
     *   confirmation that never happened. `verify-drivers` covers that case.
     */
    guarantorEmail: 'guarantor@example.test',
  }) as unknown as DriverApplication;

// ------------------------------------- the queue is one set, counted once ----

check(
  'both queue statuses are treated as waiting',
  isAwaitingReview('pending') && isAwaitingReview('ready_for_review'),
  'to a reviewer these are the same thing; a filter that knows one hides the other half',
);
check(
  'the exported set and the predicate agree',
  AWAITING_REVIEW.every(isAwaitingReview) && AWAITING_REVIEW.length === 2,
  'a query filtering on the array and a screen filtering on the function must select the same rows',
);
check(
  'and nothing else is',
  ALL_STATUSES.filter(isAwaitingReview).length === 2,
  `${ALL_STATUSES.filter(isAwaitingReview).join(', ')} — an approved application in the queue is work that does not exist`,
);
check(
  'the guarantor wait is not the queue',
  !isAwaitingReview('pending_guarantor'),
  'no admin can act on it, so it must not be counted as something waiting for one',
);
check(
  'and is identifiable on its own',
  isWaitingOnGuarantor('pending_guarantor') &&
    ALL_STATUSES.filter(isWaitingOnGuarantor).length === 1,
  '',
);

// --------------------------------------------- what an admin may do, when ---

/*
 * ⚠ The gap between "not yet decided" and "decidable" is the guarantor feature.
 *
 *   The card gated its buttons on `status !== 'approved' && status !== 'rejected'`,
 *   which is true of `pending_guarantor`. An admin working the list top to
 *   bottom could approve a driver nobody had vouched for, and the row that
 *   results is indistinguishable from one that went through properly.
 */
check(
  'the queue is approvable',
  AWAITING_REVIEW.every(canApprove) && canApprove('under_review'),
  'these are the states an admin is looking at in order to decide',
);
check(
  'an unanswered guarantor is not',
  !canApprove('pending_guarantor'),
  'approving here skips the one check the whole of 39 exists to add',
);
check(
  'and a decision is not revisited from this screen',
  !canApprove('approved') && !canApprove('rejected'),
  'a second approval would overwrite reviewed_at and lose who decided',
);

/*
 * ⚠ Rejection is deliberately wider, and that asymmetry is the point.
 *
 *   An application can be bad on its face — a licence that is not a licence, an
 *   account already banned. Holding it until a stranger opens an email leaves
 *   it in the queue for a week and asks that stranger to vouch for somebody
 *   LOCI has already decided against.
 */
check(
  'an application held on a guarantor can still be rejected',
  canReject('pending_guarantor'),
  'otherwise an obviously bad application is un-actionable for seven days',
);
check(
  'but a decided one cannot be re-rejected',
  !canReject('approved') && !canReject('rejected'),
  '',
);
check(
  'and the two predicates are not the same function',
  ALL_STATUSES.some((s) => canReject(s) !== canApprove(s)),
  'if they agree everywhere, one of them is not doing what its name says',
);

// ------------------------------------------- nothing can hide from the UI ----

const admin = read('src/app/(tabs)/admin.tsx');

/*
 * ⚠ Block comments first, then the JSX braces around them. The order is not
 *   cosmetic.
 *
 *   Stripping `{ ... }` wrappers first looks equivalent and is not: a plain
 *   block comment that happens to follow an opening brace starts a match that
 *   runs on until the next comment-close-then-brace anywhere in the file. In this file that ate
 *   5,500 characters of live code, and a mutation test that reinstated the very
 *   thing an assertion below forbids passed, because the assertion could no
 *   longer see it.
 *
 *   Every other stripper in `scripts/` already does it in this order. These two
 *   were the exceptions.
 */
const adminCode = admin
  .replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/*
 * ⚠ Asserted on the screen, not only on the predicates.
 *
 *   A correct `canApprove` that no component calls is a comment. The failure
 *   being guarded is specifically a card that reintroduces its own inline
 *   `status !== 'approved' && status !== 'rejected'` test for the buttons.
 */
check(
  'the Approve button is gated on canApprove',
  /canApprove\(application\.status\)\s*&&/.test(admin),
  'an inline "not yet decided" test here is what let an unvouched driver be approved',
);
check(
  'and the Reject button on canReject',
  /canReject\(application\.status\)\s*&&/.test(admin),
  '',
);
check(
  'the guarantor wait explains itself rather than showing a missing button',
  admin.includes('isWaitingOnGuarantor(application.status)') &&
    /Approval opens once the guarantor confirms/.test(admin),
  'an admin who cannot tell a deliberate omission from a broken screen approves from the SQL editor instead',
);

// ------------------------------------------- the approval attestation -------

/*
 * ⚠ The gate is a *disabled prop*, not a hidden button.
 *
 *   An Approve that appears when the box is ticked is a control somebody has to
 *   discover; a greyed one beside an unticked box explains itself. Both stop the
 *   click, but only one of them tells the reviewer why.
 */
check(
  'Approve is gated on the attestation',
  /disabled=\{busy \|\| !attested\}/.test(adminCode),
  'an ungated Approve is a button reachable by momentum from the card above it',
);
check(
  'the checkbox is the shared one rather than a second implementation',
  admin.includes('<ConfirmCheckbox') && admin.includes("from '@/components/ui/form-wizard'"),
  'a hand-rolled checkbox here would drift from the one on every form in the app',
);
/*
 * ⚠ The label names the documents.
 *
 *   "I confirm" attests to nothing and gets ticked without reading. Naming the
 *   driver's details *and* the guarantor confirmation is what makes somebody
 *   notice they have not opened one of them.
 */
check(
  'and it says what was checked',
  /I have verified this driver's details and their guarantor confirmation/.test(admin),
  'a generic agreement is a box people tick without looking',
);

/*
 * ⚠ The single most important assertion about this feature.
 *
 *   `visible` is filtered and re-sorted, and the default chip hides an
 *   application the moment it is decided — so the card in a given position is a
 *   *different applicant* a second later. A tick that survived that would
 *   approve the next person in the queue on an attestation made about somebody
 *   else, and the audit would record a check that never happened. That is worse
 *   than having no checkbox at all.
 */
check(
  'the tick cannot outlive the card it was made on',
  /useEffect\(\(\) => \{\s*setAttested\(false\);[\s\S]{0,160}\}, \[application\.id\]\)/.test(
    adminCode,
  ),
  'a checkbox keyed on nothing stays ticked while the row underneath it becomes another person',
);

/*
 * ⚠ Reject is deliberately *not* gated, and that asymmetry is load-bearing.
 *
 *   The tick exists because approving is the direction that cannot be undone —
 *   it puts somebody on the road with other people's parcels. Rejecting is
 *   recoverable and already costs a written reason. Gating both would make the
 *   tick a reflex performed on every card, which is precisely what stops it
 *   working on the one that matters.
 */
const rejectButton = /label="Reject"[\s\S]{0,400}?\/>/.exec(adminCode)?.[0] ?? '';
check('the Reject button parsed', rejectButton.length > 0, '');
check(
  'Reject is not gated on the attestation',
  !rejectButton.includes('attested'),
  'a tick required everywhere is a tick performed everywhere, and then it means nothing anywhere',
);

/*
 * ⚠ One confirmation, not two.
 *
 *   Approving used to open a modal as well. Three deliberate acts for one
 *   decision is how a confirmation becomes a thing people dismiss without
 *   reading — including the ones that matter. The consequence sentence the
 *   dialog carried now sits beside the checkbox, where it is read *before* the
 *   decision rather than after it.
 */
check(
  'the approval modal is gone',
  !adminCode.includes('Approve this driver?'),
  'a checkbox and a modal for one decision teaches people to click through both',
);
check(
  'and its consequence survived onto the card',
  /accept delivery jobs immediately/.test(admin) && /only gate/.test(admin),
  'deleting the dialog must not delete the one sentence that said what approval does',
);

// ----------------------------------------------- a rejection says why -------

/*
 * ⚠ `review_note` has been rendering an empty space since the day it was
 *   written.
 *
 *   It is shown to the driver on their timeline and it is the `reason` field of
 *   the rejection email — and the single call site passed no note, so a rejected
 *   driver was told they were unsuccessful and nothing else. That is the one
 *   thing they cannot act on.
 */
const store = read('src/store/driver-applications.ts');

check(
  'the note is required on a rejection by the type, not by a runtime check',
  /status:\s*'rejected';\s*note:\s*string;/.test(store),
  'an optional field is one a future call site forgets, and nothing fails when it does',
);
check(
  'the screen passes the reason through',
  /status:\s*'rejected',\s*note:\s*reason/.test(admin),
  'the field can be typed into and still discarded on the way to the server',
);
check(
  'and will not submit a token one',
  /reason\.trim\(\)\.length\s*<\s*MIN_REASON/.test(admin) && /const MIN_REASON = \d+/.test(admin),
  'a one-character reason satisfies "not empty" and tells the driver nothing',
);
/*
 * ⚠ The server holds the same rule, because the screen is a courtesy.
 *
 *   `review-controls-harness.mjs` proves it runs. This only proves it ships:
 *   deleting the migration would leave that harness passing against a file it
 *   no longer reads.
 */
check(
  'the same rule exists in the database',
  /a rejection must record a reason/.test(read('supabase/40_review_controls.sql')),
  'the SQL editor, a script and every future component bypass the screen',
);

/*
 * ⚠ The generalisable version of this whole task.
 *
 *   Adding a status to the database without adding it to a filter is what left
 *   `ready_for_review` invisible in the first place. Rather than assert the two
 *   new names, this asserts the *property*: every status the app knows about is
 *   reachable through some chip. A seventh added next year fails here on the
 *   day it is added, not on the day somebody notices the queue is short.
 */
const filters = /const FILTERS = \[([\s\S]*?)\] as const;/.exec(admin)?.[1] ?? '';
const filterNames = [...filters.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

check('the filter list parsed', filterNames.length >= 5, filterNames.join(', '));

/*
 * ⚠ `all` does not count, and leaving it in made this assertion vacuous.
 *
 *   The first version accepted any status reachable through *some* chip —
 *   including All, which by definition matches everything. Deleting the
 *   `pending_guarantor` chip left the suite green, because All still "showed"
 *   it. A catch-all is not a way to find a class of application: nobody can
 *   answer "how many are stuck on a guarantor" by scrolling everything.
 */
for (const status of ALL_STATUSES) {
  const reachable =
    filterNames.includes(status) || (isAwaitingReview(status) && filterNames.includes('awaiting'));

  check(
    `an application at "${status}" has a filter of its own`,
    reachable,
    'a status only visible under All is one nobody can count',
  );
}

check(
  'every status has a label',
  ALL_STATUSES.every((s) => (STATUS_LABELS[s] ?? '').length > 0),
  'an unlabelled status renders as blank next to a real applicant',
);
/*
 * ⚠ The guarantor wait is labelled by *who* it waits on.
 *
 *   "Pending" would sit it beside applications an admin can pick up, and the
 *   first thing anybody seeing it needs to know is that they cannot.
 */
check(
  'and the guarantor wait says who it is waiting on',
  /guarantor/i.test(STATUS_LABELS.pending_guarantor),
  '"Pending" would put it beside work an admin can actually do',
);

// ------------------------------------------------ the counts and the chips --

check(
  'the awaiting count spans both statuses',
  admin.includes('applications.filter((a) => isAwaitingReview(a.status)).length'),
  'counting only `pending` shows a shrinking number while the real queue grows',
);
check(
  'the default filter is the queue, not one half of it',
  admin.includes("useState<Filter>('awaiting')"),
  'an admin opening the screen must see everything waiting for them',
);
check(
  'the guarantor wait is counted separately',
  admin.includes('waitingOnGuarantor'),
  'somebody has to be able to see four applications stuck on unopened emails',
);
check(
  'one function decides what a chip shows',
  admin.includes('function matchesFilter(') && admin.includes('matchesFilter(a.status, filter)'),
  'a chip whose meaning is spelled out at each use site is a chip that means two things',
);

// ------------------------------------------------ the overdue metric holds --

const old = new Date('2026-01-01T00:00:00Z').toISOString();
const now = new Date('2026-03-01T00:00:00Z');

check(
  'a long-unreviewed application is overdue',
  isOverdue(application('ready_for_review', old), now),
  'the metric has to work at all',
);
/*
 * ⚠ The one that matters. Nobody at LOCI is late here.
 *
 *   Hiring against a number inflated by applications held on strangers fixes
 *   nothing, and the real remedy — the driver re-inviting — is invisible to the
 *   person reading the figure.
 */
check(
  'but one waiting on a guarantor is not',
  !isOverdue(application('pending_guarantor', old), now),
  'a backlog figure that counts work nobody is allowed to do asks for the wrong response',
);
check(
  'and a decided one still is not',
  !isOverdue(application('approved', old), now) && !isOverdue(application('rejected', old), now),
);

// ------------------------------------------------- what the driver is told --

/*
 * ⚠ The driver learns their guarantor came through, and only here.
 *
 *   They asked somebody for a favour and have no other way of knowing whether
 *   it happened — the guarantor's confirmation page is not something they see.
 */
const confirmed = statusChangeMessage('pending_guarantor', 'ready_for_review');
check(
  'moving to the queue tells the driver their guarantor confirmed',
  confirmed !== null && /guarantor/i.test(confirmed.title),
  'otherwise the only signal is a progress bar that stopped being stuck',
);
check(
  'and arriving at pending_guarantor is not announced',
  statusChangeMessage('pending', 'pending_guarantor') === null,
  'it is the state their application is created in; the screen they are on already says so',
);

const timeline = reviewTimeline(application('pending_guarantor', old), now);
check(
  'the timeline shows the guarantor as its own step',
  timeline.some((entry) => entry.key === 'guarantor'),
  'folding it into review leaves them watching a bar that is not moving for no stated reason',
);
/*
 * ⚠ Asserted as what the copy *says*, not as the absence of one phrase.
 *
 *   The first version only checked that "chase us" was missing, which passes on
 *   an empty string and on any rewording. What protects the driver is that the
 *   review step explicitly says it has not started yet — so that is what is
 *   pinned. Removing the `!onGuarantor` guard from the overdue calculation
 *   still leaves this passing, and correctly: the branch that produces "chase
 *   us" sits *after* the guarantor branch and is unreachable in this state. The
 *   guard is belt-and-braces against a future reordering, not the thing doing
 *   the work — see the comment on it.
 */
const reviewStep = timeline.find((entry) => entry.key === 'review');
check(
  'and the review step says it has not started',
  /starts once your guarantor confirms/i.test(reviewStep?.detail ?? ''),
  'a day count and a promise of seven working days would be LOCI claiming a clock that is not running',
);
check(
  'nor is it shown as in progress',
  reviewStep?.tone === 'pending',
  'a step drawn as current is one somebody believes is being worked on',
);
check(
  'and does not tell them LOCI is late',
  !timeline.some((entry) => /chase us/i.test(entry.detail ?? '')),
  'telling somebody to chase support about a guarantor who has not replied sends them where nobody can help',
);

const moved = reviewTimeline(application('ready_for_review', old), now);
check(
  'once confirmed, the guarantor step reads as done',
  moved.find((entry) => entry.key === 'guarantor')?.tone === 'done',
  '',
);
check(
  'and the review clock starts then',
  moved.some((entry) => /chase us/i.test(entry.detail ?? '')),
  'the promise is seven working days of *review*, which begins when the queue takes it',
);

// ------------------------------------------------------- it arrives live ----

/*
 * ⚠ A guarantor completing is the first change to this table that nobody here
 *   made.
 *
 *   Every other transition is an admin clicking on this screen, so a snapshot
 *   was enough — you saw the result of your own action. This one happens when a
 *   stranger opens an email, and without a subscription the application sits
 *   unseen for as long as the tab stays open.
 */
check(
  'there is a subscription for every application, not just one',
  store.includes('export function subscribeToApplications('),
  '',
);
check(
  'and the admin screen uses it',
  admin.includes('subscribeToApplications('),
  'without it the queue is only as current as the last page load',
);
check(
  'an update replaces the row rather than duplicating it',
  admin.includes('const at = current.findIndex((a) => a.id === changed.id)'),
  'appending on every change would show one applicant several times',
);
check(
  'and a new application is added rather than dropped',
  admin.includes('if (at === -1) return [changed, ...current]'),
  'an INSERT arrives for a row the list has never seen',
);

/*
 * ⚠ The summary type is the shared one.
 *
 *   It listed the four old statuses inline. Adding two left it silently wrong —
 *   a `ready_for_review` row cast to a type that says the value is impossible,
 *   and any switch on it falling through. Two hand-written lists of the same
 *   thing always drift.
 */
check(
  'the admin summary reuses the status type',
  read('src/store/admin.ts').includes('status: ApplicationStatus;'),
  'a second hand-written union is a second thing to forget',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — every status is reachable through a filter and carries a label, the queue counts\n' +
    '       pending and ready_for_review as one set, an application held on a guarantor is\n' +
    '       visible without being counted as backlog or told that LOCI is late, the driver\n' +
    '       is told when their guarantor comes through, and the queue updates live.',
);
