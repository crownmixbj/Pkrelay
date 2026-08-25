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
  | { allowed: false; reason: 'unverified' };

export function postingGate(
  identity: SenderIdentity | null,
  /** False once a submission has failed for reasons that are not the person's. */
  verificationAvailable: boolean,
): GateDecision {
  const status: IdentityStatus = identity?.status ?? 'unverified';

  if (status === 'verified') return { allowed: true, reason: 'verified' };

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

export const BANNER_MESSAGE = 'Complete your profile verification (NIN) to start sending parcels.';

export const GATE_TITLE = 'One-time ID verification needed';

export const GATE_MESSAGE =
  'Please complete your one-time ID verification in your profile to publish this parcel. ' +
  'Everything you have filled in is saved.';
