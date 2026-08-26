import type { IdentityStatus, SenderIdentity } from '@/store/identity';

/**
 * Whether this account may publish a parcel, and what to say if not.
 *
 * ⚠ A reversal, recorded because the reasoning matters.
 *
 *   Until now a sender could post whether or not they were verified; the
 *   per-parcel selfie was recorded rather than matched, and nothing was
 *   refused. That was a deliberate choice, and this replaces it with a
 *   just-in-time gate: fill the form freely, verify at the moment of
 *   publishing.
 *
 *   The gate is deliberately narrow. It stops exactly one group — people who
 *   have never submitted a NIN — and lets everybody else through.
 *
 * ⚠ Pending and flagged are *not* blocked, and that is not an oversight.
 *
 *   The modal says "complete your one-time ID verification". Someone at
 *   `pending` has completed it and is waiting on a provider; someone at
 *   `flagged` has completed it and is waiting on a person. Showing either of
 *   them a prompt to do a thing they have already done is both false and a
 *   dead end — there is no button that resolves it. They post, and the check
 *   catches up.
 *
 * ⚠ And an unreachable provider opens the gate rather than closing it.
 *
 *   Verification runs through an edge function and Dojah. If either is down —
 *   or the function is simply not deployed yet — then nobody in the country
 *   can verify, and a gate that held would turn a third-party outage into a
 *   total outage of the one thing this app is for. The block is only
 *   defensible while the way past it works.
 */
export type GateDecision =
  | { allowed: true; reason: 'verified' | 'in-progress' | 'verification-unavailable' }
  | { allowed: false; reason: 'unverified' | 'rejected' };

export function postingGate(
  identity: SenderIdentity | null,
  /** False once a submission has failed for reasons that are not the person's. */
  verificationAvailable: boolean,
): GateDecision {
  const status: IdentityStatus = identity?.status ?? 'unverified';

  if (status === 'verified') return { allowed: true, reason: 'verified' };

  /*
   * ⚠ Rejected is checked before the availability escape hatch, and it is the
   *   one status that must not be opened by an outage.
   *
   *   Everything below treats "nobody can verify right now" as a reason to let
   *   people through, because a third-party outage must not become an outage of
   *   the product. That argument does not reach here: a person has already
   *   looked at this account and said no. Dojah being down changes nothing
   *   about that decision, and letting a refused account post whenever the
   *   provider hiccups would make the refusal meaningless.
   *
   *   `41_sender_identity_review.sql` holds the same rule, and this is the half
   *   that keeps the sender from being walked into a failed submit.
   */
  if (status === 'rejected') return { allowed: false, reason: 'rejected' };

  /*
   * Submitted and waiting, either on the provider or on a reviewer. Nothing
   * they can do, so nothing to ask them for.
   */
  if (status === 'pending' || status === 'flagged') {
    return { allowed: true, reason: 'in-progress' };
  }

  if (!verificationAvailable) {
    return { allowed: true, reason: 'verification-unavailable' };
  }

  return { allowed: false, reason: 'unverified' };
}

/**
 * What to put in front of somebody the gate has stopped.
 *
 * ⚠ Two blocks that need two different sentences.
 *
 *   "Complete your one-time ID verification" is right for a person who never
 *   started and actively misleading for one who did and was refused — they
 *   would go to the profile screen looking for a step they have already done.
 *   The rejected message has to say a decision was made, and the reason has to
 *   come with it, or the only way to find out is to email support.
 */
export function blockedMessage(decision: GateDecision, reviewNote: string | null): string {
  if (decision.allowed) return '';

  if (decision.reason === 'rejected') {
    const why = (reviewNote ?? '').trim();
    return why
      ? `We could not accept your ID: ${why} Submit it again from your profile to start sending parcels.`
      : 'We could not accept the ID you submitted. Submit it again from your profile to start sending parcels.';
  }

  return 'Please complete your one-time ID verification in your profile to publish this parcel.';
}

/**
 * Whether the banner should be on screen.
 *
 * ⚠ Only for the people the banner's sentence is true of.
 *
 *   "Complete your profile verification (NIN) to start sending parcels" is a
 *   correct instruction for somebody who has not started, and a wrong one for
 *   somebody waiting on a result. A persistent banner that a person cannot
 *   dismiss and cannot act on is how people learn to ignore banners.
 */
export function shouldShowVerifyBanner(
  identity: SenderIdentity | null,
  verificationAvailable: boolean,
): boolean {
  return postingGate(identity, verificationAvailable).allowed === false;
}

/**
 * The heading over a refusal.
 *
 * ⚠ "One-time ID verification needed" is false for a rejected sender.
 *
 *   It is not the first time and it is not merely needed — it was done, looked
 *   at, and refused. A title that denies that puts the person into a support
 *   conversation about whether the system has lost their submission.
 */
export function gateTitle(decision: GateDecision): string {
  return decision.allowed === false && decision.reason === 'rejected'
    ? 'We could not accept your ID'
    : 'One-time ID verification needed';
}

/** Appended by the booking form, where there is a filled-in form to reassure about. */
export const FORM_IS_SAVED = 'Everything you have filled in is saved.';
