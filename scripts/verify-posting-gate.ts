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
  BANNER_MESSAGE,
  GATE_MESSAGE,
  postingGate,
  shouldShowVerifyBanner,
} from '../src/lib/posting-gate';
import type { SenderIdentity } from '../src/store/identity';

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
});

// ------------------------------------------------- who is actually stopped --

check(
  'somebody who has never submitted is stopped',
  postingGate(identity('unverified'), true).allowed === false,
  'this is the one group the gate is for',
);
check(
  'and so is an account with no identity row at all',
  postingGate(null, true).allowed === false,
  'no row is the same as unverified — a first-time sender has neither',
);

// ------------------------------------------- and who must never be stopped --

check('a verified sender posts', postingGate(identity('verified'), true).allowed === true);

/*
 * ⚠ The two that look like failures and are not.
 *
 *   `pending` is somebody waiting on the provider; `flagged` is somebody
 *   waiting on a person. Both have done exactly what the modal would ask them
 *   to do. Blocking either shows them a prompt for a task they have completed,
 *   with no button that resolves it — a dead end dressed as an instruction.
 */
for (const status of ['pending', 'flagged'] as const) {
  const decision = postingGate(identity(status), true);
  check(
    `a ${status} sender is not stopped`,
    decision.allowed === true,
    'they have already submitted; there is nothing the prompt could ask them to do',
  );
  check(
    `and the reason says they are in progress`,
    decision.allowed === true && decision.reason === 'in-progress',
    'lumping them in with "verified" would hide a real state from anything that reads this',
  );
}

/*
 * ⚠ The most important one in this file.
 *
 *   Verification runs through an edge function and Dojah. If either is down, or
 *   the function is not deployed, nobody in the country can verify — and a gate
 *   that held would turn a third-party outage into a total outage of the only
 *   thing this app does. The block is defensible only while the way past it
 *   works.
 */
check(
  'an unreachable verification service opens the gate',
  postingGate(identity('unverified'), false).allowed === true,
  'a provider outage must not stop every sender in Nigeria from posting a parcel',
);
check(
  'and says that is why',
  (() => {
    const decision = postingGate(identity('unverified'), false);
    return decision.allowed === true && decision.reason === 'verification-unavailable';
  })(),
  'a silent bypass is indistinguishable from the gate not working',
);

// ------------------------------------------------------------- the banner --

check(
  'the banner is shown to exactly the people the gate stops',
  shouldShowVerifyBanner(identity('unverified'), true) === true &&
    shouldShowVerifyBanner(identity('pending'), true) === false &&
    shouldShowVerifyBanner(identity('flagged'), true) === false &&
    shouldShowVerifyBanner(identity('verified'), true) === false,
  'a banner somebody cannot act on or dismiss is how people learn to ignore banners',
);
check(
  'and not while verification is unreachable',
  shouldShowVerifyBanner(identity('unverified'), false) === false,
  'telling somebody to do a thing that is currently impossible is worse than saying nothing',
);
check(
  'the banner says what was asked for',
  BANNER_MESSAGE === 'Complete your profile verification (NIN) to start sending parcels.',
);

// -------------------------------------------------------------- the wiring --

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
check(
  'the gate stops the post',
  /if \(!gate\.allowed\) \{[\s\S]{0,400}return;/.test(code),
  'computing the decision and carrying on is the shape this bug takes',
);
check(
  'and offers a way to the profile rather than only refusing',
  code.includes("router.push('/(tabs)/profile')") && code.includes('Go to my profile'),
  'a refusal with no route to the fix is a dead end',
);
check(
  'the prompt says the form is not lost',
  GATE_MESSAGE.includes('saved'),
  'somebody who has filled three pages needs to know before they decide whether to leave',
);
check(
  'the gate reads live availability rather than assuming',
  code.includes('postingGate(identity, isVerificationAvailable())'),
  'hardcoding true here would remove the outage escape hatch entirely',
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
  'PASS — only a sender who has never submitted is stopped, pending and flagged post\n' +
    '       freely, an unreachable provider opens the gate rather than closing it, the\n' +
    '       form fills before anything is checked, the refusal routes to the profile,\n' +
    '       and submitting a NIN is acknowledged by email every time.',
);
