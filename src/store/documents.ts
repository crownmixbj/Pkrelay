import { supabase } from '@/lib/supabase';
import type { ExpiryState } from '@/lib/expiry';

/**
 * A driver's documents: what is on file, whether it is still valid, and whether
 * a lapsed one has stopped them working.
 *
 * The records live in `public.driver_documents` (`supabase/31_document_expiry
 * .sql`) rather than in the `documents` jsonb on the application. The jsonb is
 * still there and still holds what a reviewer approved; it has nowhere to put
 * an expiry date or a per-document status, which is why this exists.
 *
 * ⚠ Nothing here decides anything. `documents_permit_dispatch` on the server
 *   gates the matcher, and a client that disagreed would simply be wrong about
 *   why a driver is not being offered work.
 */

export type DocumentStatus = 'missing' | 'pending' | 'verified' | 'rejected';

export type DriverDocument = {
  kind: string;
  label: string;
  /** Storage path in the private bucket, or null if never uploaded. */
  path: string | null;
  status: DocumentStatus;
  reviewNote: string | null;
  expiresAt: string | null;
  /** Negative once past. Null when the document has no expiry. */
  daysLeft: number | null;
  state: ExpiryState;
  expiryRequired: boolean;
  expiryAllowed: boolean;
  /** Past expiry, this one stops the driver receiving offers. */
  blocksDispatch: boolean;
  uploadedAt: string | null;
};

export async function fetchMyDocuments(): Promise<DriverDocument[]> {
  const { data, error } = await supabase.rpc('my_documents');

  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    kind: String(row.kind),
    label: String(row.label),
    path: (row.path as string | null) ?? null,
    status: (row.status as DocumentStatus) ?? 'missing',
    reviewNote: (row.review_note as string | null) ?? null,
    expiresAt: (row.expires_at as string | null) ?? null,
    daysLeft: row.days_left === null || row.days_left === undefined ? null : Number(row.days_left),
    state: (row.state as ExpiryState) ?? 'missing',
    expiryRequired: row.expiry_required === true,
    expiryAllowed: row.expiry_allowed === true,
    blocksDispatch: row.blocks_dispatch === true,
    uploadedAt: (row.uploaded_at as string | null) ?? null,
  }));
}

export type Blocker = {
  kind: string;
  label: string;
  expiresAt: string | null;
  daysLeft: number | null;
};

/**
 * Why this driver is not being offered parcels, if they are not.
 *
 * Empty when they are clear. Fetched separately from `fetchMyDocuments` even
 * though it is derivable from it, because the answer is needed on screens that
 * have no business listing five documents — the Assigned Trip empty state needs
 * to say "your insurance lapsed", not render a document manager.
 */
export async function fetchDispatchBlockers(): Promise<Blocker[]> {
  const { data, error } = await supabase.rpc('dispatch_blockers');

  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    kind: String(row.kind),
    label: String(row.label),
    expiresAt: (row.expires_at as string | null) ?? null,
    daysLeft: row.days_left === null ? null : Number(row.days_left),
  }));
}

export type DocumentOutcome = { ok: true } | { ok: false; error: string };

/**
 * Records a document after its bytes are in storage.
 *
 * Called *after* the upload, never before: a row claiming a file exists when
 * the upload failed is worse than no row, because a reviewer opening it gets a
 * broken link rather than an empty slot they can chase.
 */
export async function recordDocument(args: {
  kind: string;
  path: string;
  expires?: string | null;
  applicationId?: string | null;
}): Promise<DocumentOutcome> {
  const { error } = await supabase.rpc('record_document', {
    document_kind: args.kind,
    storage_path: args.path,
    expires: args.expires ?? null,
    application: args.applicationId ?? null,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Supplies or corrects a date without re-uploading the file.
 *
 * The migration backfills every existing document without a date — none was
 * ever collected — so this is the path that closes that gap. Requiring a fresh
 * scan of a licence somebody already sent, purely to type the date next to it,
 * is the kind of busywork that makes people ignore the prompt entirely.
 */
export async function setDocumentExpiry(kind: string, iso: string): Promise<DocumentOutcome> {
  const { error } = await supabase.rpc('set_document_expiry', {
    document_kind: kind,
    expires: iso,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Whether the driver may touch this document's expiry date.
 *
 * A document that is comfortably in date is read-only. There is nothing to
 * correct on it, and an always-open date field on a valid licence is an
 * invitation to push the date out rather than renew the card.
 *
 * It unlocks in three situations, and each one is a real need rather than a
 * convenience:
 *
 *   · no date has ever been recorded — every document that predates
 *     `20250101000031_document_expiry.sql` is in this state, because the backfill could not
 *     invent dates. Without this the reminder ladder can never start for any
 *     existing driver, and the dispatch block never covers them.
 *
 *   · the document has expired — the case the lock exists to allow.
 *
 *   · the document is inside its renewal window.
 *
 * ⚠ THE THIRD ONE IS A DELIBERATE WIDENING OF THE BRIEF, and it should be easy
 *   to reverse: delete `state === 'expiring'` below.
 *
 *   "Not editable until it has expired" read strictly means a driver who
 *   renews their licence three weeks early cannot tell Package Relay until the old one
 *   lapses — so dispatch stops, they lose at least a day's work, and they lose
 *   it for having been organised. That directly contradicts what the reminder
 *   says to them ("renew before the date and nothing changes"), and the warning
 *   window is precisely when renewal happens.
 *
 *   The concern the lock addresses — a driver quietly extending a date on a
 *   valid document — is untouched by this: outside the window it is still
 *   read-only, and the server refuses any date in the past regardless.
 */
export function canEditExpiry(doc: DriverDocument): boolean {
  if (doc.path === null || !doc.expiryAllowed) return false;
  if (doc.expiresAt === null) return true;
  return doc.state === 'expired' || doc.state === 'expiring';
}

/**
 * Why the date cannot be changed, on the row that cannot change it.
 *
 * A locked control with no explanation is read as a broken control. This says
 * both that the lock is deliberate and when it lifts, so nobody emails support
 * about a field that will open on its own.
 */
export const EXPIRY_LOCK_REASON =
  'Locked while this document is in date. It unlocks when renewal is due, or if it lapses.';

/** Human wording for the review state. `missing` is handled by the expiry copy. */
export function statusLabel(status: DocumentStatus): string {
  switch (status) {
    case 'verified':
      return 'Verified';
    case 'rejected':
      return 'Rejected';
    case 'pending':
      return 'Awaiting review';
    default:
      return 'Not uploaded';
  }
}

export function statusTone(status: DocumentStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'verified':
      return 'success';
    case 'rejected':
      return 'danger';
    case 'pending':
      return 'warning';
    default:
      return 'neutral';
  }
}

/**
 * The two facts a document row carries, ranked.
 *
 * ⚠ Expiry outranks review status, and the order matters.
 *
 *   A licence can be `verified` and expired at the same time — a reviewer
 *   approved it in March and it lapsed in August. Leading with "Verified" on
 *   that row would tell a driver everything is fine about the exact document
 *   that has stopped them working.
 */
export function headlineTone(doc: DriverDocument): 'success' | 'warning' | 'danger' | 'neutral' {
  if (doc.state === 'expired') return 'danger';
  if (doc.state === 'expiring') return 'warning';
  return statusTone(doc.status);
}
