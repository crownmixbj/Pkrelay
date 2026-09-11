import { supabase } from '@/lib/supabase';

/**
 * Driver applications, and the review workflow around them.
 *
 * Everything here is subject to Row Level Security: an applicant's queries can
 * only ever return their own row, and the review calls only succeed for an
 * account whose profile has `is_admin`. The client code below is therefore a
 * convenience, not the security boundary — see `supabase/migrations/20250101000002_driver_applications.sql`.
 */
export type ApplicationStatus =
  /**
   * ⚠ Submitted, but waiting on somebody outside Package Relay.
   *
   *   The guarantor has been emailed a link and has not used it. No admin can
   *   act on this and no amount of staffing clears it, which is why it is kept
   *   apart from everything below rather than folded into `pending`.
   */
  | 'pending_guarantor'
  /** The guarantor has verified. The queue owns it. */
  | 'ready_for_review'
  /**
   * ⚠ Also the queue's, and only still distinct for historical reasons.
   *
   *   Every application submitted before guarantor verification existed is
   *   `pending`, as is any submitted without a guarantor email. To an admin it
   *   means exactly what `ready_for_review` means. Anything deciding whether
   *   somebody has work to do must treat the two identically — see
   *   `isAwaitingReview`, which exists so that decision is made once.
   */
  | 'pending'
  | 'under_review'
  | 'approved'
  | 'rejected';

/**
 * The statuses that are an admin's to act on.
 *
 * ⚠ The single most important line in this file.
 *
 *   `pending` and `ready_for_review` are the same thing to a reviewer. A filter,
 *   a count or a query that knows only one of them shows half the queue — and
 *   the half it hides is the *new* half, because every application submitted
 *   from now on arrives as `ready_for_review`. The queue would look emptier
 *   than it is, which is the worst possible direction for that error.
 */
export const AWAITING_REVIEW: readonly ApplicationStatus[] = ['pending', 'ready_for_review'];

/** True when the application is sitting in the review queue. */
export function isAwaitingReview(status: ApplicationStatus): boolean {
  return AWAITING_REVIEW.includes(status);
}

/** True when nobody at Package Relay can move it — it is held on a third party. */
export function isWaitingOnGuarantor(status: ApplicationStatus): boolean {
  return status === 'pending_guarantor';
}

/**
 * Whether an admin may approve this application right now.
 *
 * ⚠ Narrower than "not yet decided", and the gap is the whole guarantor feature.
 *
 *   The review card used to show its buttons whenever the status was neither
 *   `approved` nor `rejected` — which includes `pending_guarantor`. An admin
 *   working the list top to bottom could therefore approve a driver whose
 *   guarantor had not answered, and the resulting row is indistinguishable from
 *   one that went through properly: `approved`, with no guarantor record and
 *   nothing to say the step was skipped.
 *
 *   `20250101000040_review_controls.sql` refuses that update as well. This is the half that
 *   stops an admin being offered it in the first place.
 */
export function canApprove(status: ApplicationStatus): boolean {
  return isAwaitingReview(status) || status === 'under_review';
}

/**
 * Whether an admin may reject it right now.
 *
 * ⚠ Deliberately wider than `canApprove`, including the guarantor wait.
 *
 *   An application can be obviously bad on its face — a licence that is not a
 *   licence, an account already banned. Making the reviewer wait on an email to
 *   a stranger before they may say so would leave an unusable application in
 *   the list for a week, and the guarantor would be asked to vouch for somebody
 *   Package Relay has already decided against.
 */
export function canReject(status: ApplicationStatus): boolean {
  return status !== 'approved' && status !== 'rejected';
}

/** How long the copy promises a review takes. Used to flag overdue queues. */
export const REVIEW_WORKING_DAYS = 7;

export type DriverApplication = {
  id: string;
  userId: string;
  reference: string;

  fullName: string;
  phone: string;
  email: string;
  nin: string;
  address: string;
  state: string;
  baseCity: string | null;

  vehicleType: string;
  /**
   * Added by `20250101000029_driver_profile_edits.sql`, so it is absent on every row
   * created before it. Nullable rather than `string` for that reason — an
   * application submitted last month genuinely has no colour, and defaulting it
   * to `''` here would make "not recorded" indistinguishable from "cleared".
   */
  vehicleColour: string | null;
  plateNumber: string;
  licenseId: string;

  guarantorName: string;
  guarantorPhone: string;
  /** Where the verification invitation goes. */
  guarantorEmail: string;

  /*
   * ⚠ Still read, never written any more.
   *
   *   The guarantor supplies their own NIN through an invitation now — see
   *   `20250101000039_guarantor_verification.sql`. These three stay on the *read* type
   *   because applications submitted before that change hold values in them,
   *   and an admin reviewing a driver approved last year should still see what
   *   was recorded at the time. `NewApplication` omits them, so nothing can
   *   write them again.
   */
  guarantorRelationship: string;
  guarantorAddress: string;
  guarantorNin: string;

  bankName: string;
  accountNumber: string;
  accountName: string;

  kinName: string;
  kinPhone: string;
  kinRelationship: string;

  /** Filenames of what was attached. The files themselves aren't uploaded yet. */
  documents: Record<string, string | null>;

  status: ApplicationStatus;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  submittedAt: string;

  /**
   * When the confirmation email was accepted by the provider, and why it wasn't.
   *
   * Both null means never attempted — no email provider is configured yet.
   * Written only by the Edge Function running as the service role; a trigger in
   * `20250101000006_application_email.sql` refuses client writes, so an applicant cannot
   * mark their own row as delivered.
   */
  confirmationEmailSentAt: string | null;
  confirmationEmailError: string | null;
};

type Row = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableStr = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export function rowToApplication(row: Row): DriverApplication {
  return {
    id: str(row.id),
    userId: str(row.user_id),
    reference: str(row.reference),
    fullName: str(row.full_name),
    phone: str(row.phone),
    email: str(row.email),
    nin: str(row.nin),
    address: str(row.address),
    state: str(row.state),
    baseCity: nullableStr(row.base_city),
    vehicleType: str(row.vehicle_type),
    vehicleColour: nullableStr(row.vehicle_colour),
    plateNumber: str(row.plate_number),
    licenseId: str(row.license_id),
    guarantorName: str(row.guarantor_name),
    guarantorPhone: str(row.guarantor_phone),
    guarantorEmail: str(row.guarantor_email),
    guarantorRelationship: str(row.guarantor_relationship),
    guarantorAddress: str(row.guarantor_address),
    guarantorNin: str(row.guarantor_nin),
    bankName: str(row.bank_name),
    accountNumber: str(row.account_number),
    accountName: str(row.account_name),
    kinName: str(row.kin_name),
    kinPhone: str(row.kin_phone),
    kinRelationship: str(row.kin_relationship),
    documents: (row.documents as Record<string, string | null>) ?? {},
    status: str(row.status) as ApplicationStatus,
    reviewNote: nullableStr(row.review_note),
    reviewedBy: nullableStr(row.reviewed_by),
    reviewedAt: nullableStr(row.reviewed_at),
    submittedAt: str(row.submitted_at),
    confirmationEmailSentAt: nullableStr(row.confirmation_email_sent_at),
    confirmationEmailError: nullableStr(row.confirmation_email_error),
  };
}

/*
  The signup form does not ask for vehicle colour.

  It is a post-approval detail — useful to a hub steward identifying a bike at a
  gate, not to a reviewer deciding whether to approve one — so `vehicleColour`
  is omitted here and added later from the profile editor. Requiring it at
  submission would put a field in the longest form in the app for the sake of a
  value nobody needs until the driver is already working.
*/
export type NewApplication = Omit<
  DriverApplication,
  | 'id'
  | 'vehicleColour'
  | 'status'
  | 'reviewNote'
  | 'reviewedBy'
  | 'reviewedAt'
  | 'submittedAt'
  // Set by the system after the fact, never by the client submitting the form.
  | 'confirmationEmailSentAt'
  | 'confirmationEmailError'
  /*
   * ⚠ Omitted so the form physically cannot send them.
   *
   *   Leaving them optional would let a future edit reintroduce a driver typing
   *   their guarantor's NIN — which is the whole thing this change removed.
   */
  | 'guarantorRelationship'
  | 'guarantorAddress'
  | 'guarantorNin'
>;

export async function submitApplication(application: NewApplication): Promise<DriverApplication> {
  const { data, error } = await supabase
    .from('driver_applications')
    .insert({
      user_id: application.userId,
      reference: application.reference,
      full_name: application.fullName,
      phone: application.phone,
      email: application.email,
      nin: application.nin,
      address: application.address,
      state: application.state,
      base_city: application.baseCity,
      vehicle_type: application.vehicleType,
      plate_number: application.plateNumber,
      license_id: application.licenseId,
      guarantor_name: application.guarantorName,
      guarantor_phone: application.guarantorPhone,
      guarantor_email: application.guarantorEmail,
      bank_name: application.bankName,
      account_number: application.accountNumber,
      account_name: application.accountName,
      kin_name: application.kinName,
      kin_phone: application.kinPhone,
      kin_relationship: application.kinRelationship,
      documents: application.documents,
      // Not sent: status, reviewed_by, reviewed_at. The insert policy refuses
      // anything but 'pending' anyway — this just makes the intent explicit.
    })
    .select()
    .single();

  if (error) throw error;
  return rowToApplication(data);
}

/** The signed-in user's own application, if they have one. */
export async function fetchMyApplication(userId: string): Promise<DriverApplication | null> {
  const { data, error } = await supabase
    .from('driver_applications')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data ? rowToApplication(data) : null;
}

/**
 * Every application, for the review queue.
 *
 * Returns nothing but the caller's own row for a non-admin — RLS decides, not
 * this function. Oldest first: a review queue worked newest-first leaves the
 * earliest applicants waiting longest, which is exactly backwards when you've
 * promised a 3–7 day turnaround.
 */
export async function fetchAllApplications(): Promise<DriverApplication[]> {
  const { data, error } = await supabase
    .from('driver_applications')
    .select('*')
    .order('submitted_at', { ascending: true });

  if (error) throw error;
  return (data ?? []).map(rowToApplication);
}

/**
 * An admin's decision.
 *
 * ⚠ The note is optional on an approval and required on a rejection, in the
 *   type rather than in a runtime check.
 *
 *   `review_note` is shown to the driver on their timeline and is the `reason`
 *   field of the rejection email. Both were written months ago and have been
 *   rendering an empty space ever since, because the one call site passed no
 *   note and nothing anywhere said it had to. A rejected driver was told they
 *   were unsuccessful and nothing else — which is the one thing they cannot act
 *   on. Splitting the union means a call site that forgets does not compile.
 */
export type ReviewDecision =
  | { status: 'approved' | 'under_review' | 'pending'; note?: string; reviewerId: string }
  | { status: 'rejected'; note: string; reviewerId: string };

/** Approve, reject, or move to under_review. Refused by RLS for non-admins. */
export async function reviewApplication(
  id: string,
  decision: ReviewDecision,
): Promise<DriverApplication> {
  const { data, error } = await supabase
    .from('driver_applications')
    .update({
      status: decision.status,
      review_note: decision.note ?? null,
      reviewed_by: decision.reviewerId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return rowToApplication(data);
}

/** Whether the signed-in account can see the review dashboard. */
export async function fetchIsAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', userId)
    .maybeSingle();

  // A missing profile is not an error worth surfacing — it just isn't an admin.
  if (error) return false;
  return Boolean(data?.is_admin);
}

/** Working days since submission, for flagging a queue that's slipping. */
export function workingDaysSince(iso: string, now: Date = new Date()): number {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return 0;

  let days = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);

  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay();
    // 0 Sunday, 6 Saturday.
    if (day !== 0 && day !== 6) days += 1;
  }

  return days;
}

export function isOverdue(application: DriverApplication, now: Date = new Date()): boolean {
  if (application.status === 'approved' || application.status === 'rejected') return false;

  /*
   * ⚠ An application held on a guarantor is not a backlog.
   *
   *   `isOverdue` feeds the "past N days" figure an ops team is judged on and
   *   staffs against. An application nobody at Package Relay is permitted to touch,
   *   ageing because a stranger has not opened an email, would inflate that
   *   number with work that does not exist — and hiring against it would fix
   *   nothing. The driver's own lever for this is `reinvite_guarantor`.
   */
  if (isWaitingOnGuarantor(application.status)) return false;

  return workingDaysSince(application.submittedAt, now) > REVIEW_WORKING_DAYS;
}

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  /*
   * ⚠ Says who it is waiting on, because that is the only useful thing about it.
   *
   *   "Pending" would put it beside applications an admin can pick up, and the
   *   first thing anybody seeing it needs to know is that they cannot.
   */
  pending_guarantor: 'Waiting on guarantor',
  ready_for_review: 'Pending review',
  pending: 'Pending review',
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Rejected',
};

/**
 * Live updates to one applicant's own row.
 *
 * The `filter` scopes the subscription to this user, but that is an efficiency
 * measure, not the security boundary — Row Level Security decides what the
 * websocket is allowed to deliver, so removing the filter would still not leak
 * anyone else's application.
 *
 * `onChange` receives the new row. Comparing against the previous status is the
 * caller's job: the same UPDATE fires for a review note as for an approval, and
 * announcing "approved!" twice is worse than announcing it late.
 *
 * Returns an unsubscribe function.
 */
/**
 * Live updates to *every* application, for the admin queue.
 *
 * ⚠ Added because a guarantor completing is not something an admin does.
 *
 *   Every other status change on this table is made by the admin looking at
 *   the screen, so a one-shot fetch was enough — you saw the result of your own
 *   click. `ready_for_review` arrives from a stranger clicking a link in an
 *   email, at no predictable moment. Without this the queue is only as current
 *   as the last page load, and an application can sit unseen for as long as
 *   somebody leaves the tab open.
 *
 * ⚠ Unfiltered, which is safe only because of who can subscribe.
 *
 *   Realtime respects row-level security, so this yields nothing to an account
 *   that cannot already select the table. The admin policy is the boundary; the
 *   absence of a filter here is not.
 */
export function subscribeToApplications(
  onChange: (application: DriverApplication) => void,
): () => void {
  const channel = supabase
    .channel('driver_applications:admin')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'driver_applications' },
      (payload) => {
        const row = payload.new as Row | null;
        /* DELETE payloads carry no `new`; nothing to report. */
        if (row && Object.keys(row).length > 0) onChange(rowToApplication(row));
      },
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

export function subscribeToMyApplication(
  userId: string,
  onChange: (application: DriverApplication) => void,
): () => void {
  const channel = supabase
    .channel(`driver_application:${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'driver_applications',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        const row = payload.new as Row | null;
        // DELETE payloads carry no `new`; nothing to report.
        if (row && Object.keys(row).length > 0) onChange(rowToApplication(row));
      },
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

/** What to say when a status changes. Null when the change isn't worth a toast. */
export function statusChangeMessage(
  previous: ApplicationStatus | null,
  next: ApplicationStatus,
): { title: string; message: string; tone: 'success' | 'info' } | null {
  // First load, or a change that isn't a change.
  if (previous === null || previous === next) return null;

  switch (next) {
    case 'approved':
      return {
        title: "You're approved to drive",
        message: 'You can now accept delivery jobs. Find Jobs is open to you.',
        tone: 'success',
      };
    case 'rejected':
      return {
        title: 'Application not approved',
        message: 'Your driver application was reviewed and not approved this time.',
        tone: 'info',
      };
    case 'under_review':
      return {
        title: 'Application under review',
        message: 'Someone is looking at your application now.',
        tone: 'info',
      };
    case 'ready_for_review':
      /*
       * ⚠ The one moment the driver learns their guarantor came through.
       *
       *   They asked somebody for a favour and then had no way of knowing
       *   whether it happened. This is the answer, and it is the only place
       *   they get it — the guarantor's own confirmation page is not something
       *   the driver ever sees.
       */
      return {
        title: 'Your guarantor confirmed',
        message: 'Your application is now with our team for review.',
        tone: 'success',
      };
    case 'pending_guarantor':
      /*
       * Not news: this is the state their application is created in, and the
       * screen they are looking at when it happens already says so.
       */
      return null;
    case 'pending':
      // Going back to pending is an admin correcting themselves; not news.
      return null;
  }
}

// ------------------------------------------------ payout account changes ----

export type PayoutChange = {
  id: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  previousBankName: string | null;
  previousAccountNumber: string | null;
  status: 'pending' | 'applied' | 'cancelled';
  requestedAt: string;
  effectiveAt: string;
};

/**
 * Changing where a driver's money goes.
 *
 * Deliberately slow. An attacker with a driver's password can change a payout
 * account in seconds and take the next transfer; a 48-hour window gives the real
 * driver two days to notice, and the *old* account keeps receiving transfers
 * throughout — so the theft window never opens at all.
 *
 * The rules are in `supabase/migrations/20250101000016_driver_identity.sql`. There is no client write
 * path to `payout_change_requests`: a driver who could write the row could set
 * `effective_at` to now and skip the wait entirely.
 */
export const PAYOUT_COOLING_HOURS = 48;

type PayoutRow = {
  id: string;
  bank_name: string;
  account_number: string;
  account_name: string;
  previous_bank_name: string | null;
  previous_account_number: string | null;
  status: string;
  requested_at: string;
  effective_at: string;
};

const toPayoutChange = (row: PayoutRow): PayoutChange => ({
  id: row.id,
  bankName: row.bank_name,
  accountNumber: row.account_number,
  accountName: row.account_name,
  previousBankName: row.previous_bank_name,
  previousAccountNumber: row.previous_account_number,
  status: row.status as PayoutChange['status'],
  requestedAt: row.requested_at,
  effectiveAt: row.effective_at,
});

export async function fetchPayoutChanges(): Promise<PayoutChange[]> {
  const { data, error } = await supabase
    .from('payout_change_requests')
    .select('*')
    .order('requested_at', { ascending: false });

  if (error || !data) return [];
  return (data as PayoutRow[]).map(toPayoutChange);
}

export async function requestPayoutChange(input: {
  bankName: string;
  accountNumber: string;
  accountName: string;
}): Promise<{ ok: true; effectiveAt: string } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('request_payout_change', {
    new_bank_name: input.bankName,
    new_account_number: input.accountNumber,
    new_account_name: input.accountName,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, effectiveAt: String(data) };
}

export async function cancelPayoutChange(id: string): Promise<boolean> {
  const { error } = await supabase.rpc('cancel_payout_change', { request_id: id });
  return !error;
}

/**
 * How long until a pending change takes effect.
 *
 * Rounded up, always. "In 1 hour" when 61 minutes remain is a small lie that
 * matters here: a driver watching a clock to know when their money moves should
 * never find it has not moved when the app said it would have.
 */
export function hoursUntil(effectiveAt: string, now: Date = new Date()): number {
  const remaining = Date.parse(effectiveAt) - now.getTime();
  return remaining > 0 ? Math.ceil(remaining / 3_600_000) : 0;
}

export function payoutChangeLabel(change: PayoutChange, now: Date = new Date()): string {
  if (change.status === 'applied') return 'Applied';
  if (change.status === 'cancelled') return 'Cancelled';

  const hours = hoursUntil(change.effectiveAt, now);
  if (hours === 0) return 'Applying shortly';
  if (hours === 1) return 'Takes effect in 1 hour';
  return `Takes effect in ${hours} hours`;
}

/**
 * Only the last four digits, everywhere a change is displayed.
 *
 * The driver knows their own account number; showing it in full adds nothing
 * and puts it on a screen that gets read over shoulders and screenshotted into
 * support chats.
 */
export function maskAccount(accountNumber: string | null): string {
  const digits = (accountNumber ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `••••${digits.slice(-4)}`;
}
