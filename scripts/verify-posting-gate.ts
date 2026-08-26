/**
 * Assertions for the just-in-time verification gate.
 *
 * ⚠ This reverses a decision, so the assertions have to change sides carefully.
 *
 *   Until now nothing refused a parcel: an unverified sender posted, and the
 *   per-parcel selfie was recorded rather than matched. `verify-liveness` still
 *   holds the assertion that pinned that, repointed rather than deleted.
 *
 *   A gate is only defensible while the way past it works, so most of what
 *   follows is about who must *not* be stopped. Everything else in this app
 *   degrades rather than refuses — a Google outage falls back to a city, a
 *   failed identity check still posts the parcel — and a blocking gate is the
 *   first thing here that can strand somebody.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  blockedMessage,
  canActNow,
  FORM_IS_SAVED,
  gateTitle,
  postingGate,
  shouldShowVerifyBanner,
} from '../src/lib/posting-gate';
import type { IdentityStatus, SenderIdentity } from '../src/store/identity';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const identity = (status: SenderIdentity['status']): SenderIdentity => ({
  status,
  hasReference: status === 'verified',
  ninLast4: status === 'unverified' ? null : '1234',
  confidence: null,
  environment: null,
  checkedAt: null,
  reviewNote: status === 'rejected' ? 'The slip photo is too blurry to read.' : null,
});

// ------------------------------------------------- who is actually stopped --

check(
  'somebody who has never submitted is stopped',
  postingGate(identity('unverified')).allowed === false,
  'this is the one group the gate is for',
);
check(
  'and so is an account with no identity row at all',
  postingGate(null).allowed === false,
  'no row is the same as unverified — a first-time sender has neither',
);

// ---------------------------------------- exactly one status may post -------

check('a verified sender posts', postingGate(identity('verified')).allowed === true);

/*
 * ⚠ The reversal, and the reason it is defensible now and was not before.
 *
 *   `pending` and `flagged` used to pass. The argument was sound: a mismatch is
 *   as often an old NIMC photo or a dark room as a fraud, and refusing on that
 *   evidence locked real customers out with *no recourse* — the only path was
 *   automated and had already said no.
 *
 *   41 built the recourse. Both statuses now sit in a queue a person works, and
 *   can be approved by hand. Blocking is a delay rather than a wall, which is
 *   the only thing that ever made the old position necessary.
 */
for (const status of ['unverified', 'pending', 'flagged', 'rejected'] as const) {
  const decision = postingGate(identity(status));
  check(
    `a ${status} sender is stopped`,
    decision.allowed === false,
    'the server refuses this row; letting the form submit means finding out after three pages',
  );
  check(
    `and the reason is "${status}" rather than a generic block`,
    decision.allowed === false && decision.reason === status,
    'four situations collapsed into one reason is four people told the same wrong thing',
  );
}

/*
 * ⚠ `status <> 'rejected'` is the rewrite that would pass a glance.
 *
 *   It reads almost identically to the intent and lets three of the four
 *   through. Asserting that *only* verified passes, by counting, is what makes
 *   that impossible to introduce quietly.
 */
const ALL: readonly IdentityStatus[] = ['unverified', 'pending', 'verified', 'flagged', 'rejected'];
check(
  'and exactly one status may post',
  ALL.filter((status) => postingGate(identity(status)).allowed).length === 1,
  `${ALL.filter((status) => postingGate(identity(status)).allowed).join(', ')} — more than one means the predicate is looser than it reads`,
);

/*
 * ⚠ The outage escape hatch is gone, deliberately, and this is where that is
 *   recorded.
 *
 *   It used to open the gate when Dojah was unreachable, so a third-party
 *   outage could not become a total outage of the product. That cannot survive
 *   this rule: an outage is exactly when an unverified account would slip
 *   through, and a gate that opens under load is not a gate. The cost is
 *   accepted — a new sender during an outage waits for Dojah or for an admin.
 */
check(
  'an unreachable verification service does not open the gate',
  // @ts-expect-error the parameter is gone; a call site still passing it must not compile
  postingGate(identity('unverified'), false).allowed === false,
  'a gate that opens when the provider is down is open exactly when it matters',
);

// ------------------------------------------------------------- the banner --

/*
 * ⚠ Shown to everybody who is stopped, which is now everybody unverified.
 *
 *   The old rule hid it from `pending` and `flagged` on the argument that a
 *   banner somebody cannot act on is one they learn to ignore. That is still
 *   true, and is now handled by the *message* and by hiding the button —
 *   somebody who cannot post needs to know before they fill a form, even when
 *   the answer is "wait".
 */
check(
  'the banner is shown to exactly the people the gate stops',
  ALL.every(
    (status) =>
      shouldShowVerifyBanner(identity(status)) ===
      (postingGate(identity(status)).allowed === false),
  ),
  'a banner whose audience is computed separately from the gate will disagree with it',
);

/*
 * ⚠ Four blocks, four different sentences, and none of them a dead end.
 *
 *   This is what makes the rule defensible rather than merely strict. Two of
 *   these people have done everything asked and are waiting on LOCI.
 */
const messages = (['unverified', 'pending', 'flagged', 'rejected'] as const).map((status) =>
  blockedMessage(postingGate(identity(status)), identity(status).reviewNote),
);

check(
  'every blocked state says something',
  messages.every((message) => message.length > 20),
  '',
);
check(
  'and no two of them say the same thing',
  new Set(messages).size === messages.length,
  'one sentence for four situations is three people told something untrue',
);
check(
  'the titles differ too',
  new Set(
    (['unverified', 'pending', 'flagged', 'rejected'] as const).map((status) =>
      gateTitle(postingGate(identity(status))),
    ),
  ).size === 4,
  'a heading that denies what somebody already did sends them to support',
);

/*
 * ⚠ Nobody waiting is told to go and do something.
 *
 *   Re-submitting on the profile screen calls `begin_identity_check`, which
 *   clears the review and puts them back at the start of the queue. Sending a
 *   waiting sender there does not just waste their time, it makes their
 *   situation worse.
 */
check(
  'somebody waiting is not told to complete a verification',
  !/complete your/i.test(blockedMessage(postingGate(identity('pending')), null)) &&
    !/complete your/i.test(blockedMessage(postingGate(identity('flagged')), null)),
  'they have already done it; the instruction is false and the button would reset their place in the queue',
);
check(
  'and is offered no button',
  !canActNow(postingGate(identity('pending'))) && !canActNow(postingGate(identity('flagged'))),
  're-submitting clears the review and starts them over',
);
check(
  'while the two who can act are offered one',
  canActNow(postingGate(identity('unverified'))) && canActNow(postingGate(identity('rejected'))),
  'a refusal with no route to the fix is a dead end',
);
check(
  'the waiting messages say a result is coming',
  /email/i.test(blockedMessage(postingGate(identity('pending')), null)) &&
    /email/i.test(blockedMessage(postingGate(identity('flagged')), null)),
  '"please wait" with no actor and no end is how somebody decides the app is broken',
);
/*
 * ⚠ The machine's opinion is not repeated to the customer as a verdict.
 *
 *   A flag is frequently wrong about an old NIMC photo or a dark room. Telling
 *   somebody their photo did not match, before any person has looked, is LOCI
 *   asserting something nobody has checked.
 */
check(
  'a flagged sender is not told their photo failed',
  !/did not match|does not match|failed/i.test(
    blockedMessage(postingGate(identity('flagged')), null),
  ),
  'no person has looked yet; the score is a machine’s guess',
);

check(
  'a rejection carries the reviewer’s reason',
  blockedMessage(postingGate(identity('rejected')), 'The slip photo is too blurry.').includes(
    'The slip photo is too blurry.',
  ),
  'without it the only way to learn what to fix is to email support about a photo they cannot see',
);
check(
  'and still says what to do when no reason survived',
  /submit it again/i.test(blockedMessage(postingGate(identity('rejected')), null)),
  '',
);

// -------------------------------------------------- and the server agrees --

/*
 * ⚠ The half that is not a courtesy.
 *
 *   Everything above decides what the app *says*. Until 42 that was the entire
 *   enforcement, and an app is a suggestion: anyone with the anon key and curl
 *   could POST to /rest/v1/bookings. `verified-senders-harness.mjs` proves the
 *   policy refuses; this only proves it ships.
 */
const gateMigration = read('supabase/42_verified_senders_only.sql');

check(
  'the insert policy requires a verified sender',
  /and public\.is_verified_sender\(\)/.test(gateMigration),
  'a rule only the client knows is a rule anyone can skip',
);
check(
  'the predicate accepts nothing but verified',
  /i\.status = 'verified'/.test(gateMigration) &&
    !/status <>/.test(
      gateMigration.replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*--.*$/gm, ''),
    ),
  '"not rejected" reads the same and lets three of the four through',
);
/*
 * ⚠ 09 warned about exactly this and it is worth pinning.
 *
 *   42 drops and recreates the policy. Recreating it with only the new
 *   condition would quietly remove the others, letting a client post a parcel
 *   pre-assigned to a driver.
 */
for (const guard of ['driver_id is null', 'driver is null', "status = 'Booked'", 'is_erased()']) {
  check(
    `and still carries "${guard}"`,
    gateMigration.includes(guard),
    'a migration that adds one rule while dropping three looks like a success',
  );
}

// -------------------------------------------------------------- the wiring --// -------------------------------------------------------------- the wiring --

const book = read('src/app/(tabs)/book.tsx');
const banner = read('src/components/ui/verify-banner.tsx');
const home = read('src/app/(tabs)/index.tsx');

const code = book
  .replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

check(
  'the banner is on the home screen and the booking form',
  home.includes('<VerifyBanner />') && book.includes('<VerifyBanner />'),
  '',
);
check(
  'the banner routes to the profile',
  banner.includes("router.push('/(tabs)/profile')") && banner.includes('Verify Now'),
  '',
);

/*
 * ⚠ The gate is at the end, not on the way in.
 *
 *   Just-in-time means the form is fillable by anybody and the check happens at
 *   the moment of publishing. A gate that ran earlier — on mount, on Next, on
 *   step one — would be the pattern this replaced, with the added insult of
 *   asking for a NIN before quoting a price.
 */
check(
  'nothing gates the form before the final button',
  code.indexOf('postingGate(') > code.indexOf('const goNext'),
  'the whole point is that the form fills freely and the check comes last',
);
/*
 * ⚠ Measured on a flattened source with a generous window.
 *
 *   The original allowed 400 characters between the guard and its `return`, and
 *   broke the moment the refusal grew a second dialog shape for the people who
 *   have nowhere to go. An assertion whose threshold is really "how long is the
 *   body right now" fails on every edit to that body while the property — that
 *   the function does not carry on past a refusal — is untouched.
 */
check(
  'the gate stops the post',
  /if \(!gate\.allowed\) \{.{0,900}return;/.test(code.replace(/\s+/g, ' ')),
  'computing the decision and carrying on is the shape this bug takes',
);
check(
  'and offers a way to the profile rather than only refusing',
  code.includes("router.push('/(tabs)/profile')") && code.includes('Go to my profile'),
  'a refusal with no route to the fix is a dead end',
);
check(
  'the prompt says the form is not lost',
  FORM_IS_SAVED.includes('saved') && code.includes('FORM_IS_SAVED'),
  'somebody who has filled three pages needs to know before they decide whether to leave',
);
/*
 * ⚠ Asserted on the screen, because a correct message nothing renders is a
 *   comment. The failure guarded is a call site that goes back to one constant
 *   sentence for both kinds of block.
 */
check(
  'the booking prompt is built from the decision rather than fixed',
  code.includes('gateTitle(gate)') && code.includes('blockedMessage(gate,'),
  'a hardcoded title and body would say "one-time verification needed" to somebody already refused',
);
check(
  'and the banner is too',
  banner.includes('blockedMessage(decision,') && banner.includes('postingGate(identity)'),
  '',
);
/*
 * ⚠ Repointed, because the thing it was defending is deliberately gone.
 *
 *   This pinned `postingGate(identity, isVerificationAvailable())` to stop
 *   somebody hardcoding `true` and removing the outage escape hatch. 42 removed
 *   that hatch on purpose — an outage is exactly when an unverified account
 *   would slip through. Leaving the assertion would have demanded a parameter
 *   the function no longer takes; deleting it silently would have lost the
 *   property underneath, which is that the gate reads *this account's* live
 *   identity rather than something cached or assumed.
 */
check(
  'the gate reads the identity it just fetched',
  code.includes('postingGate(identity)'),
  'a gate fed a stale or hardcoded identity is a gate that answers about the wrong person',
);

/*
 * ⚠ The per-parcel selfie is untouched by any of this.
 *
 *   It is the record of who handed this parcel over, and it was never what the
 *   gate is about. Removing it while adding a NIN gate would trade a
 *   per-shipment fact for an account-level one.
 */
check(
  'the selfie still happens on every parcel',
  code.includes('<LiveSelfieCard') && code.includes('runIdentityCheck(sessionId)'),
  '',
);

// ------------------------------------------------- the submission email ----

const migration = read('supabase/38_transactional_email.sql');
const templates = read('supabase/functions/notify-events/templates.ts');

check(
  'submitting a NIN queues an email',
  migration.includes("'sender_verification_submitted'") &&
    migration.includes('on_identity_submitted'),
  '',
);
check(
  'fired on the way into pending, which is what submission means',
  /new\.status <> 'pending' then[\s\S]{0,600}sender_verification_submitted/.test(migration),
  'begin_identity_check writes the NIN, the slip and pending in one statement',
);
/*
 * ⚠ A second submission after a flag must also be acknowledged.
 *
 *   Keyed on the user alone, the unique constraint would swallow every attempt
 *   after the first — and somebody on their second try is the person most in
 *   need of hearing that it arrived.
 */
check(
  'a re-submission is a new email rather than a swallowed one',
  migration.includes("to_char(now(), 'YYYYMMDDHH24MISS')"),
  'keyed on the user id alone, only the first submission would ever be acknowledged',
);
check(
  'the subject is the one asked for',
  templates.includes("headerSafe('Your NIN verification is under review')"),
  '',
);
check(
  'and it promises a second email rather than a deadline',
  templates.includes('as soon as the check is done'),
  'how long a third-party check takes is not something this system can commit to',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — only a verified sender may post: the database refuses the row and the app says so\n' +
    '       first; unverified, pending, flagged and rejected are each stopped with their own\n' +
    '       sentence and their own heading; nobody waiting on a review is told to go and do\n' +
    '       something that would reset their place in the queue; a rejection carries the\n' +
    '       reviewer\u2019s reason and a way back in; and the policy still refuses a parcel that\n' +
    '       arrives pre-assigned, mis-statused, on somebody else\u2019s behalf or from an erased\n' +
    '       account.',
);
