import { supabase } from '@/lib/supabase';
import type { IdentityStatus } from '@/store/identity';

/**
 * The admin side of sender identity: what is waiting, and the verdict.
 *
 * ⚠ Nothing here is the security boundary.
 *
 *   Every call is a `security definer` function that checks `is_admin()`
 *   itself — see `20250101000041_sender_identity_review.sql`. Hiding the section from the
 *   nav is a courtesy; these fail for a non-admin.
 *
 * ⚠ And nothing here carries a NIN or a photo path.
 *
 *   The queue returns the last four digits and two booleans saying whether the
 *   documents exist. Seeing the documents is a separate, audited act —
 *   `revealIdentityForUser` in `parcel-photos.ts`. Working a list and looking
 *   at somebody's face are different things, and only the second one should
 *   write a privacy line.
 */

export type IdentityReview = {
  userId: string;
  fullName: string | null;
  email: string | null;
  status: IdentityStatus;
  confidence: number | null;
  /** `•••• •••• 8901` is built at render time; this is the raw four. */
  ninLast4: string | null;
  hasSlip: boolean;
  hasSelfie: boolean;
  submittedAt: string | null;
  checkedAt: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
};

/**
 * ⚠ One definition of "waiting for a person", exported rather than repeated.
 *
 *   `pending` is waiting because no machine ever answered — the check was never
 *   run, or the provider was unreachable. `flagged` is waiting because one
 *   answered and disagreed. To the sender they are identical: they did what was
 *   asked and nothing happened. A count or a filter that knows only `flagged`
 *   reports a small, calm number while the other half grows unbounded — and
 *   until `verify-identity` is deployed, the other half is *everyone*.
 */
export const AWAITING_IDENTITY_REVIEW: readonly IdentityStatus[] = ['pending', 'flagged'];

export function isAwaitingIdentityReview(status: IdentityStatus): boolean {
  return AWAITING_IDENTITY_REVIEW.includes(status);
}

export const IDENTITY_STATUS_LABELS: Record<IdentityStatus, string> = {
  unverified: 'Nothing submitted',
  /*
   * ⚠ Named for what is true of it, not for the machine's state.
   *
   *   "Pending" reads as "in progress somewhere else" and would leave a
   *   reviewer waiting for a result that is never coming. Nobody is checking
   *   this but them.
   */
  pending: 'No check ran',
  flagged: 'Photo did not match',
  verified: 'Verified',
  rejected: 'Not accepted',
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

type Row = Record<string, unknown>;

function toReview(row: Row): IdentityReview {
  return {
    userId: String(row.user_id),
    fullName: text(row.full_name),
    email: text(row.email),
    status: (text(row.status) ?? 'unverified') as IdentityStatus,
    confidence:
      row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    ninLast4: text(row.nin_last4),
    hasSlip: row.has_slip === true,
    hasSelfie: row.has_selfie === true,
    submittedAt: text(row.submitted_at),
    checkedAt: text(row.checked_at),
    reviewNote: text(row.review_note),
    reviewedAt: text(row.reviewed_at),
  };
}

/** Everyone who has submitted an identity, waiting ones first. */
export async function fetchIdentityQueue(): Promise<IdentityReview[]> {
  const { data, error } = await supabase.rpc('admin_identity_queue');
  if (error) throw error;
  return ((data as Row[]) ?? []).map(toReview);
}

/**
 * A reviewer's verdict.
 *
 * ⚠ The note is required on a rejection by the type, not by a runtime check.
 *
 *   It is shown to the sender in the app and sent to them by email, and it is
 *   what makes the block survivable — a refusal with no reason is the one
 *   outcome they cannot act on. `sender_identity_rejection_has_reason` refuses
 *   the row as well; this is the half that means a call site which forgets does
 *   not compile.
 */
export type IdentityVerdict =
  { verdict: 'verified'; note?: string } | { verdict: 'rejected'; note: string };

export async function reviewIdentity(userId: string, decision: IdentityVerdict): Promise<void> {
  const { error } = await supabase.rpc('admin_review_identity', {
    target: userId,
    verdict: decision.verdict,
    note: decision.note?.trim() || null,
  });

  if (error) throw error;
}

/**
 * How confident the machine was, for a human deciding whether to trust it.
 *
 * ⚠ Absent rather than zero when no check ran.
 *
 *   A `pending` row has a null confidence, and rendering that as "0%" would
 *   tell a reviewer the photo scored the worst possible match when in fact
 *   nothing was ever compared. That is the difference between "this is probably
 *   not them" and "we do not know", and it is the whole decision.
 */
export function confidenceLabel(confidence: number | null): string {
  if (confidence === null || !Number.isFinite(confidence)) return 'No score — no check ran';
  return `Match confidence ${Math.round(confidence * 100)}%`;
}
