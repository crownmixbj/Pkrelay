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
  /*
   * ⚠ Listed against a function 53 creates, not against `dispatch_email`.
   *
   *   38 created `dispatch_email` and 53 replaces it, so its presence says
   *   nothing about whether 53 has run — the same trap the 45 entry documents.
   *   `email_dispatch_config` is new in 53 and is therefore the honest probe.
   */
  {
    label: 'Transactional email dispatch',
    fn: 'email_dispatch_config',
    migration: '20250101000053_email_dispatch_repair.sql',
  },
  /*
   * ⚠ 54 replaces a function 39 created, so its presence proves nothing — the
   *   same limit the 45 and 52 entries document. It is listed because the
   *   newest-migration assertion exists to stop this list falling behind, and
   *   because a database still on 39's seven-day window while the app promises
   *   thirty is a promise broken to the one person in the flow who cannot check.
   */
  {
    label: 'Guarantor link window (39; 54 widens it)',
    fn: 'guarantor_invitation_window',
    migration: '20250101000054_guarantor_link_window.sql',
  },
  /*
   * ⚠ 55 is a one-off UPDATE, so it carries a function whose only job is to be
   *   askable — and which reads the live state rather than returning a constant,
   *   so it keeps answering after the migration has run. Its absence is
   *   otherwise invisible by construction: the emails send, the links work, and
   *   the only symptom is a date in somebody else's inbox that is not the date
   *   their link expires.
   */
  {
    label: 'Guarantor invite email dates',
    fn: 'guarantor_invite_dates_current',
    migration: '20250101000055_guarantor_invite_payload_refresh.sql',
  },
  /*
   * ⚠ Probed on `settle_parcel_payment`, which is new in 56 and is the one
   *   function whose absence has an unmistakable symptom.
   *
   *   Not `dispatch_new_booking`: 15 creates it and 56 replaces it, so it is
   *   present on every database and would report 56 installed where it is not —
   *   the trap the 45 and 53 entries document. On a project without 56 the
   *   booking insert fails with PGRST204 on `payment_status`, which
   *   `COLUMN_MIGRATIONS` below turns into this same filename.
   */
  {
    label: 'Parcel payments',
    fn: 'settle_parcel_payment',
    migration: '20250101000056_parcel_payments.sql',
  },
  /*
   * ⚠ Its absence is invisible from inside the app, which is why it is listed.
   *
   *   Without 57 the payment still settles, the parcel still dispatches and
   *   every screen is correct. The only symptom is that the sender hears from
   *   Paystack and never from Package Relay — a missing email nobody can see
   *   from a screenshot, and exactly the shape of the gap that produced this
   *   migration. `email_on_parcel_paid` is new in 57, so its absence is the
   *   honest probe.
   */
  {
    label: 'Payment confirmation email',
    fn: 'email_on_parcel_paid',
    migration: '20250101000057_payment_receipt_email.sql',
  },
  /*
   * ⚠ Probed on the ledger rather than on `settle_payout`, which 30 created.
   *
   *   58 grants an admin a view over two tables that already existed; the only
   *   new thing whose absence is unambiguous is the ledger itself. On a project
   *   without it the Finance screen renders empty tables and a PGRST202 naming
   *   this function, which is exactly the message worth translating.
   */
  {
    label: 'Admin finance ledgers',
    fn: 'admin_payout_ledger',
    migration: '20250101000058_admin_finance.sql',
  },
  /*
   * ⚠ 60 *changes the signature* of two functions 58 created, which is a
   *   failure mode this list has not had before.
   *
   *   Every other entry answers "is this function here at all". On a database
   *   with 58 but not 60, `admin_payments_ledger` exists — with the wrong
   *   argument list — so the app's call fails with PGRST202 naming a function
   *   that is plainly present, which reads as a bug in the client. The probe is
   *   therefore `admin_finance_transactions`, which 60 creates outright and
   *   whose absence is unambiguous.
   */
  {
    label: 'Finance reporting (dates, fee split, export)',
    fn: 'admin_finance_transactions',
    migration: '20250101000060_finance_reporting.sql',
  },
  /*
   * ⚠ Probed on the queue, and it is the only honest probe in 59.
   *
   *   Without 59 the Support screen shows an empty queue and the ticket panel on
   *   the public Support page renders nothing at all — no error, because a
   *   missing table reads to that panel as "not switched on yet". So the symptom
   *   is a support system that looks installed and quietly swallows everything
   *   anybody writes into it. `admin_support_queue` is new in 59 and is what
   *   every path on that screen calls first.
   */
  {
    label: 'Support ticketing queue',
    fn: 'admin_support_queue',
    migration: '20250101000059_support_tickets.sql',
  },
  /*
   * ⚠ 61 repairs a foreign key and adds no working function, so it carries a
   *   probe whose only job is to be askable — 55's arrangement, for 55's reason.
   *
   *   Its absence is the worst kind: erasing a sender who has posted a parcel
   *   raises a foreign key violation and scrubs nothing, so an NDPR request
   *   fails on a database that looks complete. And unlike every other entry
   *   here, the probe answers from the live catalog — it returns false if
   *   somebody re-adds that constraint without the `on delete` clause, which is
   *   how it went missing in the first place.
   */
  {
    label: 'Erasure: capture-session key repair',
    fn: 'capture_session_fk_repaired',
    migration: '20250101000061_capture_session_fk_repair.sql',
  },
  /*
   * ⚠ Probed on the waiting list, and 69 is deliberately not listed beside it.
   *
   *   Without 70 the Dispatch screen's driver panel reads "availability
   *   unavailable" and says so plainly, so its absence is already legible —
   *   `admin_waiting_drivers` is new in 70 and is the first thing that panel
   *   calls.
   *
   *   69 adds no function: it repairs `admin_assign_parcel`, which exists
   *   either way. Giving it a probe for this list would mean inventing a
   *   function whose only job is to be present, and unlike 61 its absence is
   *   not silent — pressing Assign fails with the database's own message naming
   *   the ambiguous column. A filename would tell somebody less than that does.
   */
  {
    label: 'Dispatch: drivers waiting for work',
    fn: 'admin_waiting_drivers',
    migration: '20250101000070_driver_availability.sql',
  },
  /*
   * ⚠ Probed on the counter, which is the only new object in 71.
   *
   *   Without it the three dispatch screens call `unassigned_parcels` and
   *   `admin_parcels_for_driver` for columns that are not there yet, and the
   *   attempts line renders empty — a parcel that has been offered seven times
   *   reads as one that has never been offered at all. `offer_attempts` is new
   *   in 71 and is what all three read the counts from.
   */
  {
    label: 'Dispatch: offer attempt counts',
    fn: 'offer_attempts',
    migration: '20250101000071_offer_attempt_counts.sql',
  },
  /*
   * ⚠ Probed on the board, which is the only function 72 adds.
   *
   *   Without it the In transit tab reads "could not be read" and says so, which
   *   is honest but unhelpful on a database where the answer is simply that the
   *   migration has not been run. The stage clock it also adds —
   *   `bookings.status_changed_at` — is a column, and `COLUMN_MIGRATIONS` below
   *   only maps columns the *client writes*; nothing writes this one, the
   *   trigger does.
   */
  {
    label: 'In transit board',
    fn: 'admin_parcels_in_flight',
    migration: '20250101000073_parcels_in_flight.sql',
  },
  /*
   * ⚠ Probed on the action itself.
   *
   *   Without 74 the In transit board renders a "Record delivery" button that
   *   fails with PGRST202 the moment somebody uses it on a parcel a driver left
   *   at Out for Delivery — which is the one moment they need it. The attribution
   *   column rides along in the same file.
   */
  {
    label: 'Admin-recorded delivery',
    fn: 'admin_record_delivery',
    migration: '20250101000074_admin_record_delivery.sql',
  },
  /*
   * ⚠ A sort order, which is the quietest thing on this list.
   *
   *   Without 75 both hand-assignment screens still work: they list the same
   *   drivers, with the same notes, and the Assign button does the same thing.
   *   They just put the driver leaving tomorrow above the one leaving in ten
   *   minutes, and nothing on screen says so. `departure_priority_live` reads
   *   the live function bodies rather than checking the functions exist,
   *   because both existed before 75 and what changed is what they sort on.
   */
  {
    label: 'Dispatch: soonest departure first',
    fn: 'departure_priority_live',
    migration: '20250101000075_departure_priority.sql',
  },
  /*
   * ⚠ The entry this whole list exists for.
   *
   *   Production carried a migration-history row for 50 while none of that
   *   file's thirteen objects were in the database — so for weeks a delivery
   *   produced the sender's email and no in-app notification at all, and
   *   nothing anywhere said so. A history row is not evidence that a migration
   *   ran, and this is the line that would have caught it.
   *
   *   `notification_spine_live` asserts the two triggers rather than the
   *   functions, deliberately: a function nothing is wired to is the exact
   *   shape of the failure being probed for.
   */
  {
    label: 'Notification spine (inbox and push)',
    fn: 'notification_spine_live',
    migration: '20250101000076_notification_spine_repair.sql',
  },
  /*
   * ⚠ The only entry here that is not about a feature.
   *
   *   Every other line answers "has this migration been applied". This one
   *   answers "is the database still what the chain says it should be", which
   *   is what three separate production defects turned out to be: an early
   *   range was replayed over a database that already had the later
   *   migrations, and `create or replace` went backwards without complaint.
   *   Hand assignment raised, every email waited five minutes for the sweep,
   *   and a driver could not decline twice — all on a history that looked
   *   perfect.
   *
   *   `definitions_current` is false while any object in 79's manifest has
   *   lost its newest definition. `stale_definitions()` names which.
   */
  {
    label: 'Definitions match the migration chain',
    fn: 'definitions_current',
    migration: '20250101000079_definition_drift_repair.sql',
  },
  /*
   * Without 62 nothing breaks on screen — new accounts are simply never sent
   * the welcome email — which is exactly why it needs a line here.
   */
  {
    label: 'Welcome email on sign-up confirmation',
    fn: 'welcome_email_installed',
    migration: '20250101000062_welcome_email.sql',
  },
  /* Without 63 a changed password goes unannounced — invisible until it matters. */
  {
    label: 'Password-changed security email',
    fn: 'password_changed_email_installed',
    migration: '20250101000063_password_changed_email.sql',
  },
  {
    label: "Driver's first name in parcel status emails",
    fn: 'status_email_has_driver_name',
    migration: '20250101000064_status_email_driver_name.sql',
  },
  /*
   * ⚠ 65 is the only entry here that reports on a policy rather than a table or
   *   a function, and it is here because that is exactly the failure that hides.
   *
   *   The storage policy was recreated by hand on a live project to fix a
   *   reviewer who could not open the guarantor's photographs. The hand-written
   *   version works — it just evaluates `is_admin()` once per row instead of
   *   once per statement, and no screen, log or error ever says so. A database
   *   whose policy has drifted from the file looks completely healthy until
   *   somebody reads the catalogue, so the panel is where it gets read.
   */
  {
    label: 'Guarantor identity policy matches the repo',
    fn: 'guarantor_identity_policy_canonical',
    migration: '20250101000065_guarantor_policy_canonical.sql',
  },
  /*
   * ⚠ Without 66 the applicant is told in the app and nowhere else.
   *
   *   The bell icon lights for somebody who has the app open; the person waiting
   *   on this step is an applicant who submitted days ago and has no reason to
   *   open it. There is no error and no failed row — the email simply never
   *   existed — so the panel is the only place its absence shows.
   */
  {
    label: 'Guarantor-completed email to the applicant',
    fn: 'guarantor_completed_email_installed',
    migration: '20250101000066_guarantor_completed_email.sql',
  },
  /*
   * ⚠ The one entry here that reports on a database being able to make an
   *   outbound call at all.
   *
   *   `extensions.net.http_post` is three names and Postgres refuses it before
   *   looking anything up. In the offer notifier it had no exception handler, so
   *   a database still carrying it could not post a parcel — the raise rolled
   *   the booking back. In the application notifier it did have one, so it was
   *   silent for a year. One line, two completely different symptoms, and the
   *   probe scans every function rather than the two we know about.
   */
  {
    label: 'pg_net calls resolve to a real schema',
    fn: 'pg_net_calls_are_resolvable',
    migration: '20250101000068_pg_net_probe_self_match.sql',
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
  /*
   * ⚠ Read, not written — and it still belongs here.
   *
   *   `bookingToInsert` deliberately does not send `payment_status`; the column
   *   default and the insert policy own it. But `fetchBookings` selects `*` and
   *   `rowToBooking` reads the column, and the shipments screen asks whether a
   *   parcel is awaiting payment. On a database without 56 that is a checkout
   *   button on a parcel that can never be paid for, and the honest message is
   *   the filename rather than a shrug about the connection.
   */
  payment_status: {
    label: 'Parcel payments',
    migration: '20250101000056_parcel_payments.sql',
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
