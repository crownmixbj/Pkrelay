import type { IdentityStatus, SenderIdentity } from '@/store/identity';

/**
 * Whether this account may publish a parcel, and what to say if not.
 *
 * ⚠ Verified, or nothing. This is the second reversal, and both are recorded
 *   because the reasoning is the point.
 *
 *   First LOCI let everyone post and recorded a selfie afterwards. Then a
 *   just-in-time gate stopped only accounts that had never submitted a NIN,
 *   deliberately letting `pending` and `flagged` through. Now only `verified`
 *   passes.
 *
 * ⚠ What changed is not the risk appetite. It is that a person can now say yes.
 *
 *   The old reasoning was sound: a mismatch is as often an old NIMC photo or a
 *   dark room as it is a fraud, and blocking on that evidence locks real
 *   customers out with no recourse — because the only path was automated, and
 *   it had already refused them. Nothing they could do would change it.
 *
 *   41 built the recourse. A flagged or unchecked account sits in a queue an
 *   administrator works, and can be approved by a human comparing the slip to
 *   the face. Refusing is defensible now precisely because the refusal is no
 *   longer final.
 *
 * ⚠ The provider being unreachable no longer opens the gate.
 *
 *   That escape hatch existed so a third-party outage could not become a total
 *   outage of the one thing this app is for. It cannot survive this rule: an
 *   outage is exactly when an unverified account would slip through, and a gate
 *   that opens under load is not a gate. The cost is real and is accepted — a
 *   new sender during a Dojah outage cannot post until either Dojah returns or
 *   an admin approves them by hand, and the copy below says so rather than
 *   leaving them guessing.
 *
 *   `isVerificationAvailable()` in `store/identity.ts` is therefore no longer
 *   consulted here, and the parameter that carried it is gone rather than left
 *   accepted-and-ignored: an argument a function quietly discards is how a call
 *   site goes on looking like it handles an outage years after it stopped.
 *
 * ⚠ `42_verified_senders_only.sql` holds the same rule in the insert policy.
 *
 *   Nothing here is the security boundary. This exists so somebody is told
 *   *before* filling a form that the server will refuse the submit, and told
 *   which of four different things is wrong.
 */

/** Every way the gate can refuse. Each one needs its own sentence. */
export type BlockedReason =
  /** Never submitted a NIN. */
  | 'unverified'
  /** Submitted; nobody and nothing has answered yet. */
  | 'pending'
  /** A machine compared the photo and disagreed. A person must settle it. */
  | 'flagged'
  /** A person looked and said no. */
  | 'rejected';

export type GateDecision =
  { allowed: true; reason: 'verified' } | { allowed: false; reason: BlockedReason };

export function postingGate(identity: SenderIdentity | null): GateDecision {
  const status: IdentityStatus = identity?.status ?? 'unverified';

  if (status === 'verified') return { allowed: true, reason: 'verified' };

  /*
   * Every other status is a refusal, and each is a different situation for the
   * person in it. They are returned separately rather than collapsed into one
   * `blocked`, because the whole difficulty of this feature is telling four
   * groups of people four true things.
   */
  if (status === 'pending') return { allowed: false, reason: 'pending' };
  if (status === 'flagged') return { allowed: false, reason: 'flagged' };
  if (status === 'rejected') return { allowed: false, reason: 'rejected' };

  return { allowed: false, reason: 'unverified' };
}

/**
 * Whether the standing prompt should be on screen.
 *
 * ⚠ Now true for everyone the gate stops, which is everyone unverified.
 *
 *   It used to appear only for accounts that had never started, on the
 *   argument that a banner somebody cannot act on is a banner they learn to
 *   ignore. That still holds — and is now handled by the *message* rather than
 *   by hiding it. Somebody who cannot post needs to know before they fill a
 *   form, including when the answer is "wait".
 */
export function shouldShowVerifyBanner(identity: SenderIdentity | null): boolean {
  return postingGate(identity).allowed === false;
}

/**
 * The heading over a refusal.
 *
 * ⚠ "One-time ID verification needed" is false for three of the four.
 *
 *   Somebody at `pending` has done it. Somebody `flagged` has done it and is
 *   waiting on a person. Somebody `rejected` did it and was refused. A title
 *   that denies what they did is a title that sends them to support to argue
 *   about whether the system lost their submission.
 */
export function gateTitle(decision: GateDecision): string {
  if (decision.allowed) return '';

  switch (decision.reason) {
    case 'unverified':
      return 'One-time ID verification needed';
    case 'pending':
      return 'Your ID is still being checked';
    case 'flagged':
      return 'Your ID needs a second look';
    case 'rejected':
      return 'We could not accept your ID';
  }
}

/**
 * What to put in front of somebody the gate has stopped.
 *
 * ⚠ Four blocks, four sentences, and none of them may be a dead end.
 *
 *   This is the part that makes the block defensible rather than merely
 *   strict. Two of these people have done everything asked and are waiting on
 *   LOCI — telling them to "complete your verification" would be a lie, and
 *   telling them nothing would leave them refreshing a form that will keep
 *   refusing. So the waiting cases say who is waiting and roughly how they
 *   find out, and the actionable cases say exactly what to do.
 */
export function blockedMessage(decision: GateDecision, reviewNote: string | null): string {
  if (decision.allowed) return '';

  switch (decision.reason) {
    case 'unverified':
      return 'Please complete your one-time ID verification in your profile before sending a parcel.';

    /*
     * ⚠ Says a person will look, not "please wait".
     *
     *   "Please wait" with no end and no actor is how somebody decides the app
     *   is broken. Naming that a person reviews it, and that an email follows,
     *   is both true and the only thing here they can plan around.
     */
    case 'pending':
      return 'Your ID has been submitted and is waiting to be checked. We will email you as soon as it is approved — you can send parcels straight after that.';

    /*
     * ⚠ Does not tell them the photo failed.
     *
     *   The confidence score is a machine's opinion, frequently wrong about an
     *   old NIMC photo or a badly lit room, and repeating it to the customer
     *   as a verdict would be LOCI asserting something no person has checked.
     */
    case 'flagged':
      return 'Your ID needs to be checked by a person before you can send parcels. We will email you as soon as that is done.';

    case 'rejected': {
      const why = (reviewNote ?? '').trim();
      return why
        ? `We could not accept your ID: ${why} Submit it again from your profile to start sending parcels.`
        : 'We could not accept the ID you submitted. Submit it again from your profile to start sending parcels.';
    }
  }
}

/**
 * Whether the profile screen is where this person needs to go.
 *
 * ⚠ False while they are waiting, because there is nothing to do there.
 *
 *   A "Verify now" button shown to somebody at `pending` opens a form they have
 *   already filled. Worse, submitting it again would *reset* their place in the
 *   queue — `begin_identity_check` clears the review and starts them over. So
 *   the button is offered only to the two who can actually change something.
 */
export function canActNow(decision: GateDecision): boolean {
  return (
    decision.allowed === false && decision.reason !== 'pending' && decision.reason !== 'flagged'
  );
}

/** Appended by the booking form, where there is a filled-in form to reassure about. */
export const FORM_IS_SAVED = 'Everything you have filled in is saved.';
