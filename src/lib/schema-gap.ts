/**
 * Which migration a missing database function or column belongs to.
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
  /*
   * ⚠ Added on the same commit as the migration, because the assertion
   *   introduced last time refused to let it be otherwise.
   *
   *   The list falling behind is what made the panel report a healthy schema
   *   over a broken screen. `verify-identity-review.ts` now fails when the
   *   newest file in supabase/ is not here, and it failed on this one — which
   *   is the guard working on the first opportunity it had.
   */
  {
    label: 'Verified senders only',
    fn: 'is_verified_sender',
    migration: '42_verified_senders_only.sql',
  },
  {
    label: 'Review sees the selfie',
    fn: 'sender_selfie_path',
    migration: '43_review_sees_the_selfie.sql',
  },
  {
    label: 'Selfie with the parcel',
    fn: 'attach_capture_on_insert',
    migration: '44_selfie_with_the_parcel.sql',
  },
  /*
   * ⚠ 45 replaces a function that already exists, so its absence cannot be
   *   probed by name.
   *
   *   `handle_new_user` is created by 02 and present on every database. The
   *   panel would report this capability as installed on a project that has
   *   never run 45 — a green tick for a migration nobody applied, which is the
   *   exact failure this list was extended to stop.
   *
   *   Listed anyway, because leaving it out would fail the newest-migration
   *   assertion and quietly reintroduce the habit of the list falling behind.
   *   The honest reading is "02 ran", and that is what the label says.
   */
  {
    label: 'Account profiles (02; 45 refines it)',
    fn: 'handle_new_user',
    migration: '45_google_identities.sql',
  },
];

/**
 * Columns the client writes that a migration adds.
 *
 * ⚠ This exists because I shipped one and broke posting.
 *
 *   `bookingToInsert` started sending `capture_session_id` when 44 made the
 *   selfie part of the insert. On a database where 44 has not been run,
 *   PostgREST refuses the whole row with PGRST204 — and the booking form
 *   rendered that as "Check your connection and try again", to somebody whose
 *   connection was fine.
 *
 *   A client that writes a column is making a claim about the schema. When the
 *   claim is wrong, the person is owed the filename rather than a guess about
 *   their router.
 */
const COLUMN_MIGRATIONS: Readonly<Record<string, { label: string; migration: string }>> = {
  capture_session_id: {
    label: 'Posting a parcel with its selfie',
    migration: '44_selfie_with_the_parcel.sql',
  },
};

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

/**
 * And its code for "that column is not in the schema".
 *
 * A different failure with the same cause and the same remedy: something the
 * client knows about does not exist in the database yet.
 */
const COLUMN_MISSING = 'PGRST204';

/** The function name out of the message, when there is one to be had. */
function functionIn(message: string): string | null {
  return /(?:function|procedure)\s+public\.([a-z0-9_]+)/i.exec(message)?.[1] ?? null;
}

/**
 * The column name out of the message.
 *
 * PostgREST phrases it as: Could not find the 'x' column of 'y' in the schema
 * cache. Both quote styles are accepted because the wording has moved between
 * releases and a parser that only knows today's is a parser that silently stops
 * working on an upgrade.
 */
function columnIn(message: string): string | null {
  return /(?:column\s+)?['"`]([a-z0-9_]+)['"`]\s+column/i.exec(message)?.[1] ?? null;
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
  if (error.code !== FUNCTION_MISSING && error.code !== COLUMN_MISSING) return null;

  const message = typeof error.message === 'string' ? error.message : '';

  if (error.code === COLUMN_MISSING) {
    const column = columnIn(message);
    const known = column ? COLUMN_MIGRATIONS[column] : undefined;

    if (known) {
      return `${known.label} needs a database change that has not been made yet. Run supabase/${known.migration} in the Supabase SQL editor, then reload.`;
    }

    return column
      ? `This needs a database column that is not there yet: ${column}. A migration in supabase/ has not been run.`
      : 'This needs part of the database schema that has not been created yet. A migration in supabase/ has not been run.';
  }

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
