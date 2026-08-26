/**
 * Which migration a missing database function belongs to.
 *
 * ⚠ PostgREST's own words for this are true and useless.
 *
 *   "Could not find the function public.admin_identity_queue without parameters
 *   in the schema cache (PGRST202)" describes a cache lookup. What actually
 *   happened is that a migration has not been run, and the person reading it
 *   needs a filename, not a subsystem. Left untranslated it reads like a bug in
 *   the app, and the next hour goes into the app.
 *
 * ⚠ One list, shared with the deployment panel.
 *
 *   `deployment.ts` already maps a function to the migration that creates it,
 *   for a panel built to answer "is the schema stale". Keeping a second copy
 *   here would mean the panel and the error message disagreeing about which
 *   file to run — and the error message is the one somebody reads under
 *   pressure.
 */

/** A capability, and the function whose presence proves the migration ran. */
export type CapabilityDef = { label: string; fn: string; migration: string };

export const CAPABILITIES: readonly CapabilityDef[] = [
  { label: 'Parcel photos', fn: 'attach_parcel_photo', migration: '36_parcel_photos.sql' },
  {
    label: 'Sender identity reveal',
    fn: 'admin_reveal_sender_identity',
    migration: '37_admin_sender_identity.sql',
  },
  { label: 'Driver wallet', fn: 'request_payout', migration: '30_driver_wallet.sql' },
  { label: 'Document expiry', fn: 'record_document', migration: '31_document_expiry.sql' },
  { label: 'Manual dispatch', fn: 'set_dispatch_mode', migration: '32_dispatch_mode.sql' },
  { label: 'Account erasure', fn: 'attach_identity_result', migration: '34_identity_handoff.sql' },

  /*
   * ⚠ These four were missing, and their absence is why the panel could report
   *   a healthy schema while the screen in front of somebody was broken.
   *
   *   The list stopped at 37 and the app kept shipping migrations. A panel whose
   *   whole job is "is the database behind the code" is worse than no panel
   *   when it is itself behind the code — it turns a question somebody would
   *   have investigated into a reassuring green tick.
   */
  { label: 'Transactional email', fn: 'queue_email', migration: '38_transactional_email.sql' },
  {
    label: 'Guarantor verification',
    fn: 'open_guarantor_invitation',
    migration: '39_guarantor_verification.sql',
  },
  {
    label: 'Driver review controls',
    fn: 'guard_application_decision',
    migration: '40_review_controls.sql',
  },
  {
    label: 'Sender ID review',
    fn: 'admin_identity_queue',
    migration: '41_sender_identity_review.sql',
  },
];

type PostgrestLike = { message?: unknown; code?: unknown };

/**
 * PostgREST's code for "that function is not in the schema".
 *
 * Matched on the code rather than the sentence, because the sentence has been
 * reworded between PostgREST releases and a message match would silently stop
 * working on an upgrade — leaving the raw text back on screen with nothing
 * saying why.
 */
const FUNCTION_MISSING = 'PGRST202';

/** The function name out of the message, when there is one to be had. */
function functionIn(message: string): string | null {
  return /(?:function|procedure)\s+public\.([a-z0-9_]+)/i.exec(message)?.[1] ?? null;
}

/**
 * A sentence naming the file to run, or null when this is a different failure.
 *
 * ⚠ Null, not a guess.
 *
 *   Everything that is not a missing function should keep its own error. A
 *   helper that answered "run a migration" to a network timeout would send
 *   somebody to the SQL editor for a problem no SQL can fix, and the real error
 *   would be gone from the screen.
 */
export function schemaGapMessage(thrown: unknown): string | null {
  if (!thrown || typeof thrown !== 'object') return null;

  const error = thrown as PostgrestLike;
  if (error.code !== FUNCTION_MISSING) return null;

  const message = typeof error.message === 'string' ? error.message : '';
  const fn = functionIn(message);
  const known = CAPABILITIES.find((capability) => capability.fn === fn);

  /*
   * ⚠ Still useful when the function is not one this file knows.
   *
   *   A newer migration than this list would otherwise fall back to the raw
   *   PostgREST sentence — which is the failure being fixed. Naming the
   *   function and saying a migration is missing is correct for every case;
   *   naming the file is the bonus.
   */
  if (!known) {
    return fn
      ? `This screen needs a database function that is not there yet: ${fn}. A migration in supabase/ has not been run.`
      : 'This screen needs part of the database schema that has not been created yet. A migration in supabase/ has not been run.';
  }

  return `${known.label} is not set up on this database yet. Run supabase/${known.migration} in the Supabase SQL editor, then reload.`;
}
