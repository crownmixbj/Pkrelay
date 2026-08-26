/**
 * Assertions for the sender identity review screen and the statuses behind it.
 *
 * ⚠ The failure this guards is a queue that reports a small, calm number.
 *
 *   Two statuses wait on a person. `flagged` is a machine disagreeing with a
 *   photo; `pending` is no machine having answered at all — the check was never
 *   run, or the provider was unreachable. To the sender they are identical:
 *   they did what was asked and nothing happened.
 *
 *   `admin_flagged_identities` knew only the first, which is why this feature
 *   exists. Until `verify-identity` is deployed, *every* sender is at `pending`,
 *   so a queue that shows only flagged accounts shows zero for ever while the
 *   real backlog is everybody.
 *
 * ⚠ And a rejection that nobody can recover from.
 *
 *   Blocking a customer from the product is the sharpest thing this codebase
 *   does. It is only defensible while the reason is told to them and the way
 *   back in works — so those are asserted here as hard as the block is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { postingGate } from '../src/lib/posting-gate';
import type { IdentityStatus, SenderIdentity } from '../src/store/identity';
import { verificationPath } from '../src/store/identity';
import {
  AWAITING_IDENTITY_REVIEW,
  IDENTITY_STATUS_LABELS,
  confidenceLabel,
  isAwaitingIdentityReview,
} from '../src/store/identity-review';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/*
 * ⚠ Derived from the labels rather than hand-written.
 *
 *   A second copy of the status vocabulary here would let the assertions below
 *   keep passing when somebody adds a sixth status and forgets this file, which
 *   is exactly the bug they exist to catch.
 */
const ALL_STATUSES = Object.keys(IDENTITY_STATUS_LABELS) as IdentityStatus[];

const identity = (status: IdentityStatus): SenderIdentity => ({
  status,
  hasReference: status === 'verified',
  ninLast4: status === 'unverified' ? null : '8901',
  confidence: null,
  environment: null,
  checkedAt: null,
  reviewNote: status === 'rejected' ? 'The slip photo is too blurry.' : null,
});

// --------------------------------------------- what is waiting for a person --

check(
  'both waiting statuses are treated as one queue',
  isAwaitingIdentityReview('pending') && isAwaitingIdentityReview('flagged'),
  'a queue that knows only `flagged` reads zero while every sender sits at `pending`',
);
check(
  'the exported set and the predicate agree',
  AWAITING_IDENTITY_REVIEW.every(isAwaitingIdentityReview) && AWAITING_IDENTITY_REVIEW.length === 2,
  'a query filtering on the array and a screen filtering on the function must select the same rows',
);
check(
  'and nothing else is',
  ALL_STATUSES.filter(isAwaitingIdentityReview).length === 2,
  `${ALL_STATUSES.filter(isAwaitingIdentityReview).join(', ')} — a decided account in the queue is work that does not exist`,
);
check(
  'a decided account is not waiting',
  !isAwaitingIdentityReview('verified') && !isAwaitingIdentityReview('rejected'),
  '',
);
check(
  'nor is one that submitted nothing',
  !isAwaitingIdentityReview('unverified'),
  'there is no NIN and no photo — there is nothing for a reviewer to look at',
);

check(
  'every status has a label',
  ALL_STATUSES.every((s) => (IDENTITY_STATUS_LABELS[s] ?? '').length > 0),
  'an unlabelled status renders as blank beside somebody’s name',
);
/*
 * ⚠ Named for what is true, not for the machine's internal state.
 *
 *   "Pending" reads as "in progress somewhere else" and would leave a reviewer
 *   waiting for a result that is never coming. Nobody is checking it but them.
 */
check(
  'the un-checked status does not imply somebody else is working on it',
  !/pending|progress|waiting/i.test(IDENTITY_STATUS_LABELS.pending),
  `"${IDENTITY_STATUS_LABELS.pending}" — a reviewer who thinks a result is coming does not decide`,
);

// ------------------------------------------- the machine and the person ------

/*
 * ⚠ `flagged` and `rejected` must not collapse into each other.
 *
 *   Treat a flag as a refusal and honest customers are locked out by a dark
 *   room or an old NIMC photo. Treat a refusal as a flag and the review does
 *   nothing at all. `28_sender_identity.sql` argues the first half; this is
 *   what keeps both halves true.
 */
check(
  'a machine flag does not block',
  postingGate(identity('flagged'), true).allowed === true,
  'a mismatch is as often a bad camera as a fraud',
);
check(
  'a person’s rejection does',
  postingGate(identity('rejected'), true).allowed === false,
  'otherwise the reviewer’s decision changed nothing',
);

/*
 * ⚠ A refusal sends them back to the beginning, not to the selfie.
 *
 *   What was refused is the submission — slip, NIN and face. The selfie path
 *   would ask for the one thing that cannot fix it, and would leave the
 *   rejection standing afterwards.
 */
check(
  'a rejected sender is sent through onboarding again',
  verificationPath(identity('rejected')) === 'onboarding',
  'a route that cannot clear the block is a dead end with extra steps',
);

check(
  'no score is not a zero score',
  confidenceLabel(null) !== confidenceLabel(0),
  'rendering "no check ran" as 0% tells a reviewer the photo scored worst when nothing was compared',
);
check(
  'and says so',
  /no check ran/i.test(confidenceLabel(null)),
  'the difference between "probably not them" and "we do not know" is the whole decision',
);

// ------------------------------------------------------------ the screen ----

const panel = read('src/components/ui/identity-review-panel.tsx');
const store = read('src/store/identity-review.ts');
const admin = read('src/app/(tabs)/admin.tsx');
const nav = read('src/components/ui/app-nav-bar.tsx');

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
const panelCode = panel
  .replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

check(
  'the queue is reachable from the admin screen',
  admin.includes("section === 'identity'") && admin.includes('<IdentityReviewPanel />'),
  '',
);
check(
  'and from the nav, not only by typing a URL',
  nav.includes("section: 'identity'"),
  'a screen with no way in is a screen nobody uses',
);
check(
  'the default filter is what is waiting, not everything',
  panel.includes("useState<Filter>('awaiting')"),
  'an admin opening this must land on the work rather than on a list of decided accounts',
);
check(
  'the waiting count spans both statuses',
  panel.includes('rows.filter((row) => isAwaitingIdentityReview(row.status)).length'),
  'counting only `flagged` reports zero while everybody sits at `pending`',
);
check(
  'one function decides what a chip shows',
  panel.includes('function matches(') && panel.includes('matches(row, filter)'),
  'a chip whose meaning is spelled out at each use site is a chip that means two things',
);

// ------------------------------------------- the approval attestation -------

/*
 * ⚠ Approving a sender is not only unblocking them.
 *
 *   It promotes this selfie to the master reference photo that every future
 *   shipment of theirs is matched against. An operator who does not know that
 *   is making a smaller decision than the one they are actually making, so the
 *   card says it.
 */
check(
  'Approve is gated on the attestation',
  /disabled=\{busy \|\| !attested\}/.test(panelCode),
  'an ungated Approve is one click away from the reveal button directly above it',
);
check(
  'the checkbox is the shared one rather than a second implementation',
  panelCode.includes('<ConfirmCheckbox') &&
    panelCode.includes("from '@/components/ui/form-wizard'"),
  '',
);
check(
  'and its label names the act rather than an agreement',
  /I have compared the selfie against the NIN slip/.test(panel),
  '"I confirm this is correct" is a box people tick without looking at anything',
);
check(
  'the card says approval keeps the photo as the reference',
  /reference photo/.test(panel) && /matched against it/.test(panel),
  'the consequence of this decision outlives the decision, so it has to be on screen for it',
);

/*
 * ⚠ The tick, the reveal and the reason all reset with the account.
 *
 *   The list is re-fetched after every decision and the default chip hides what
 *   was just decided, so the card in a given position becomes a different
 *   person a moment later. A surviving tick would approve the next account on
 *   an attestation made about somebody else — a record of a comparison that
 *   never happened. A surviving reveal would leave a signed URL to one person's
 *   face on screen under another person's name.
 */
check(
  'nothing outlives the card it belongs to',
  /useEffect\(\(\) => \{\s*setAttested\(false\);\s*setRevealed\(null\);[\s\S]{0,120}\}, \[review\.userId\]\)/.test(
    panelCode,
  ),
  'state keyed on nothing persists while the row underneath it becomes another person',
);

/*
 * ⚠ Reject is not gated, and the asymmetry is deliberate.
 *
 *   Rejecting already costs a written reason and is recoverable — the sender
 *   resubmits. A tick required on every card is a tick performed on every card,
 *   and then it means nothing on the one that matters.
 */
const senderReject = /label="Reject"[\s\S]{0,400}?\/>/.exec(panelCode)?.[0] ?? '';
check('the Reject button parsed', senderReject.length > 0, '');
check('Reject is not gated on the attestation', !senderReject.includes('attested'), '');

// ------------------------------------------------- the decision, and the note --

check(
  'only a waiting account offers the buttons',
  panel.includes('const decidable = isAwaitingIdentityReview(review.status)') &&
    panel.includes('{decidable ?'),
  'offering Approve on a decided row invites a second decision that overwrites who made the first',
);
check(
  'the note is required on a rejection by the type',
  /verdict:\s*'rejected';\s*note:\s*string/.test(store),
  'an optional field is one a call site forgets, and nothing fails when it does',
);
check(
  'the screen passes the typed reason through',
  /verdict:\s*'rejected',\s*note:\s*reason\.trim\(\)/.test(panel),
  'a field that can be typed into and still discarded on the way to the server',
);
check(
  'and will not submit a token one',
  /reason\.trim\(\)\.length\s*<\s*MIN_REASON/.test(panel) && /const MIN_REASON = \d+/.test(panel),
  'a one-character reason satisfies "not empty" and tells the sender nothing',
);
check(
  'the reviewer is told the sender reads it verbatim',
  /word for word/i.test(panel),
  'somebody writing an internal note into a field the customer receives is a copy problem nobody catches',
);

// ----------------------------------------------------------- looking is logged --

/*
 * ⚠ Listing and looking are different acts, and only one is audited.
 *
 *   If the queue carried the photo paths, every page load would be an unlogged
 *   reveal — and the audit line the reveal writes would mean nothing, because
 *   the data was already on screen without one.
 */
check(
  'the list does not carry photo paths',
  !/selfie_path|slip_path|reference_path/.test(store),
  'a path in the list is a reveal nobody recorded',
);
check('the documents come from the audited reveal', panel.includes('revealIdentityForUser('), '');
check(
  'which is asked for a reason rather than called bare',
  /revealIdentityForUser\(\s*review\.userId,\s*'[^']{20,}'/.test(panel),
  'an empty reason makes the audit line unreadable to whoever has to interpret it later',
);
/*
 * ⚠ Keyed on the account, because the people in this queue have no parcel.
 *
 *   `revealSenderIdentity` takes a booking id — it was written for the parcel
 *   drawer. The account most likely to be sitting here has just verified from
 *   their profile and has never posted anything, so the booking-keyed reveal
 *   returns nothing for exactly the people who need reviewing.
 */
check(
  'the reveal is keyed on the account, not a booking',
  read('src/store/parcel-photos.ts').includes('admin_reveal_identity_for_user'),
  'a sender in this queue may have no parcel at all',
);
check(
  'and both reveals share one path-signing function',
  read('src/store/parcel-photos.ts').includes('async function signRevealed('),
  'two copies of "which bucket holds the slip" produce a blank square and no error when they drift',
);

// ------------------------------------------------- what the sender is told ----

const sql = read('supabase/41_sender_identity_review.sql');
const templates = read('supabase/functions/notify-events/templates.ts');

check(
  'a rejection cannot be stored without a reason',
  /check \(status <> 'rejected' or coalesce\(btrim\(review_note\), ''\) <> ''\)/.test(sql),
  'the function is the door people use; the constraint is what covers the others',
);
check(
  'resubmitting clears the review',
  /review_note = null,\s*reviewed_by = null,\s*reviewed_at = null;/.test(sql),
  'a stale note explains a photo they have already replaced, and the block stands',
);
check(
  'a rejected sender is emailed',
  /sender_verification_rejected/.test(sql) && /sender_verification_rejected/.test(templates),
  'otherwise they learn about it only by reopening the app, which they have no reason to do',
);
check(
  'the email carries the reason',
  /jsonb_build_object\('reason', coalesce\(new\.review_note, ''\)\)/.test(sql),
  'a refusal with no reason is the one people reply to and support cannot answer',
);
/*
 * ⚠ The outbox is a table an admin can read and a payload that reaches a mail
 *   provider. No sentence in this email needs a NIN or a photo, so neither
 *   travels — the same rule as every other LOCI email.
 */
check(
  'and nothing else',
  !/'nin'|nin_last4|slip_path|reference_path|candidate_path/.test(
    sql.slice(sql.indexOf('email_on_sender_rejected')),
  ),
  'a government identifier in a mail provider’s logs cannot be recalled',
);
check(
  'the rejection email says how to get back in',
  /Submit again|submit again/.test(templates),
  'a refusal that does not name the next step turns into a support ticket',
);
check(
  'and the sender’s own copy of the reason reaches the app',
  read('src/store/identity.ts').includes('reviewNote: row.review_note'),
  'without it the app can only say no, and the reason exists only in an email they may have lost',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — the queue counts an unrun check and a machine flag as one set and says which is\n' +
    '       which, a person’s rejection blocks where a machine’s flag does not, the reason\n' +
    '       is required by the type and by the table and travels to the sender in the app\n' +
    '       and by email with no NIN beside it, resubmitting clears the block, and seeing\n' +
    '       somebody’s face is a separate audited act from working the list.',
);
