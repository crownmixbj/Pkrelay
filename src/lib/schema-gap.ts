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
  { label: 'Parcel photos', fn: 'attach_parcel_photo', migration: '20250101000036_parcel_photos.sql' },
  {
    label: 'Sender identity reveal',
    fn: 'admin_reveal_sender_identity',
    migration: '20250101000037_admin_sender_identity.sql',
  },
  { label: 'Driver wallet', fn: 'request_payout', migration: '20250101000030_driver_wallet.sql' },
  { label: 'Document expiry', fn: 'record_document', migration: '20250101000031_document_expiry.sql' },
  { label: 'Manual dispatch', fn: 'set_dispatch_mode', migration: '20250101000032_dispatch_mode.sql' },
  { label: 'Account erasure', fn: 'attach_identity_result', migration: '20250101000034_identity_handoff.sql' },

  /*
   * ⚠ These four were missing, and their absence is why the panel could report
   *   a healthy schema while the screen in front of somebody was broken.
   *
   *   The list stopped at 37 and the app kept shipping migrations. A panel whose
   *   whole job is "is the database behind the code" is worse than no panel
   *   when it is itself behind the code — it turns a question somebody would
   *   have investigated into a reassuring green tick.
   */
  { label: 'Transactional email', fn: 'queue_email', migration: '20250101000038_transactional_email.sql' },
  {
    label: 'Guarantor verification',
    fn: 'open_guarantor_invitation',
    migration: '20250101000039_guarantor_verification.sql',
  },
  {
    label: 'Driver review controls',
    fn: 'guard_application_decision',
    migration: '20250101000040_review_controls.sql',
  },
  {
    label: 'Sender ID review',
    fn: 'admin_identity_queue',
    migration: '20250101000041_sender_identity_review.sql',
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
    migration: '20250101000042_verified_senders_only.sql',
  },
  {
    label: 'Review sees the selfie',
    fn: 'sender_selfie_path',
    migration: '20250101000043_review_sees_the_selfie.sql',
  },
  {
    label: 'Selfie with the parcel',
    fn: 'attach_capture_on_insert',
    migration: '20250101000044_selfie_with_the_parcel.sql',
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
    migration: '20250101000045_google_identities.sql',
  },
  /*
   * ⚠ This one is not a feature, and its absence is not a broken screen.
   *
   *   48 closes gaps: the missing half of 44's insert policy, a trigger that
   *   stops a client writing the delivery record `advance_booking` owns, and a
   *   handful of policies rewritten to stop calling `is_admin()` once per row.
   *   Nothing in the app calls a function that only 48 provides, so no
   *   PGRST202 will ever name it and no message here will ever be shown.
   *
   *   It is listed because the panel's question is "is this database behind the
   *   code", and on a project missing 48 the honest answer is yes — a parcel
   *   can be posted with no selfie and a driver can mark one delivered without
   *   delivering it. A capability list that omitted the security migrations
   *   would answer that question with a green tick.
   */
  {
    label: 'RLS hardening',
    fn: 'guard_delivery_state',
    migration: '20250101000048_rls_hardening.sql',
  },
  /*
   * ⚠ 49 and 50 were missing from this list, and the guard above had already
   *   caught it.
   *
   *   `verify-identity-review` fails when the newest migration is not listed
   *   here, and on this working tree it was failing on 50 before 51 existed.
   *   Adding only 51 would have turned the assertion green while leaving the
   *   panel reporting a healthy schema on a project with no notifications table
   *   — which is the precise failure the assertion exists to prevent, achieved
   *   by satisfying the assertion. So all three are here.
   */
  {
    label: 'Notifications',
    fn: 'queue_notification',
    migration: '20250101000049_notifications.sql',
  },
  {
    label: 'Notification triggers',
    fn: 'notify_on_application_decision',
    migration: '20250101000050_notification_triggers.sql',
  },
  /*
   * ⚠ Probed on a *new* function, not on one 51 replaces.
   *
   *   51 drops and recreates four functions that 39 already created, so none of
   *   those can answer "has 51 been applied" — they exist on a database that has
   *   only ever run 39. `guarantor_document_slot` is new in 51, which makes its
   *   absence the honest signal.
   */
  {
    label: 'Guarantor form and documents',
    fn: 'guarantor_document_slot',
    migration: '20250101000051_guarantor_full_form.sql',
  },
  /*
   * ⚠ 52 creates nothing, so nothing here can probe it — and it is listed
   *   anyway, for the same two reasons 45 and 48 are.
   *
   *   It drops three `not null` constraints that 39 orphaned. A database without
   *   it refuses every driver application with 23502 rather than PGRST202, so no
   *   missing-function message will ever name it; `NOT_NULL_MIGRATIONS` below is
   *   what actually turns that failure into this filename.
   *
   *   So 52 carries a function whose only job is to be askable, and which reads
   *   the catalogue rather than returning a constant — it answers correctly even
   *   on a database where somebody restored an old dump or re-added the
   *   constraint by hand. Naming 51's function here instead would have reported
   *   52 as installed on a database that has never run it, and
   *   `verify-identity-review.ts` refuses that: it checks the migration really
   *   defines the function it is attributed to.
   */
  {
    label: 'Submitting a driver application',
    fn: 'driver_application_guarantor_optional',
    migration: '20250101000052_guarantor_columns_nullable.sql',
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
    migration: '20250101000044_selfie_with_the_parcel.sql',
  },
};

/**
 * Columns a migration made nullable, for the failure that arrives as 23502.
 *
 * ⚠ A third way for the same one thing to go wrong, and the only one that
 *   reaches a person mid-form.
 *
 *   02 created these three `not null`; 39 stopped collecting them and left the
 *   constraints; 52 drops them. On a database without 52 the insert fails with
 *
 *     null value in column "guarantor_relationship" of relation
 *     "driver_applications" violates not-null constraint
 *
 *   which the driver application showed verbatim to an applicant who had just
 *   filled in thirty fields, attached five documents and photographed their own
 *   face. It is not a fault they can act on, and it is not a connection problem.
 */
const NOT_NULL_MIGRATIONS: Readonly<Record<string, { label: string; migration: string }>> = {
  guarantor_relationship: {
    label: 'Submitting a driver application',
    migration: '20250101000052_guarantor_columns_nullable.sql',
  },
  guarantor_address: {
    label: 'Submitting a driver application',
    migration: '20250101000052_guarantor_columns_nullable.sql',
  },
  guarantor_nin: {
    label: 'Submitting a driver application',
    migration: '20250101000052_guarantor_columns_nullable.sql',
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

/**
 * And Postgres's own code for "that column may not be null".
 *
 * ⚠ Not a PostgREST code — it comes from the database itself and passes through
 *   untouched, which is why it arrived on screen as raw SQL.
 */
const NOT_NULL_VIOLATION = '23502';

/** The column name out of Postgres's not-null message. */
function notNullColumnIn(message: string): string | null {
  return /null value in column ["']([a-z0-9_]+)["']/i.exec(message)?.[1] ?? null;
}

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
  if (
    error.code !== FUNCTION_MISSING &&
    error.code !== COLUMN_MISSING &&
    error.code !== NOT_NULL_VIOLATION
  ) {
    return null;
  }

  const message = typeof error.message === 'string' ? error.message : '';

  if (error.code === NOT_NULL_VIOLATION) {
    const column = notNullColumnIn(message);
    const known = column ? NOT_NULL_MIGRATIONS[column] : undefined;

    /*
     * ⚠ Null for a column this file does not know, rather than a guess.
     *
     *   Most 23502s are a genuine client bug — a field the form failed to
     *   collect — and telling somebody to run a migration for one would send
     *   them to the SQL editor for a problem no SQL can fix. Only the columns
     *   named above are known to be a schema that is behind the code.
     */
    if (!known) return null;

    return `${known.label} needs a database change that has not been made yet. Run supabase/${known.migration} in the Supabase SQL editor, then try again.`;
  }

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
