import {
  isAwaitingReview,
  isWaitingOnGuarantor,
  REVIEW_WORKING_DAYS,
  workingDaysSince,
  type DriverApplication,
} from '@/store/driver-applications';

/**
 * The history of one driver application, built from what the row records.
 *
 * Every entry here is derived from a real column — `submitted_at`,
 * `confirmation_email_sent_at`, `reviewed_at`, `status`. Nothing is invented to
 * make the timeline look fuller. That restraint is the point: a fabricated
 * "we emailed you" line on a page whose whole job is telling someone what we
 * sent them would be the worst possible place to be wrong.
 */
export type TimelineTone = 'done' | 'current' | 'pending' | 'failed';

export type TimelineEntry = {
  key: string;
  title: string;
  detail: string;
  /** ISO timestamp, or null when the event has not happened. */
  at: string | null;
  tone: TimelineTone;
  /** True for the email rows, so the UI can group them under Notifications. */
  notification?: boolean;
};

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleDateString()} at ${date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/**
 * The review steps.
 *
 * `under_review` is not given its own row when the application is still
 * pending: showing "Document review — in progress" for something nobody has
 * opened yet is exactly the kind of reassuring fiction that makes a status page
 * worthless.
 */
export function reviewTimeline(
  application: DriverApplication,
  now: Date = new Date(),
): TimelineEntry[] {
  const { status } = application;
  const decided = status === 'approved' || status === 'rejected';
  const onGuarantor = isWaitingOnGuarantor(status);
  const waiting = workingDaysSince(application.submittedAt, now);

  /*
   * ⚠ Belt-and-braces, and honestly labelled as such.
   *
   *   What actually keeps "chase us" away from a driver waiting on a guarantor
   *   is the branch order below: the guarantor case is tested before the
   *   overdue case and returns different copy. Removing this line changes
   *   nothing today — proved by mutating it and watching the suite stay green.
   *
   *   It stays because the branches below are copy, and copy gets reordered.
   *   The claim it guards against is a real one: telling somebody LOCI is past
   *   the seven working days it promised, when the clock has not started and
   *   support can do nothing, points them away from the one thing that would
   *   help. The clock starts when the queue takes it.
   */
  const overdue = !decided && !onGuarantor && waiting > REVIEW_WORKING_DAYS;

  const entries: TimelineEntry[] = [
    {
      key: 'submitted',
      title: 'Application received',
      detail: `Reference ${application.reference}`,
      at: application.submittedAt,
      tone: 'done',
    },
  ];

  /*
   * ⚠ A step of its own, and only for applications that actually have one.
   *
   *   The driver asked somebody for a favour and otherwise has no way to know
   *   whether it happened. Folding it into "Document review" would leave them
   *   watching a bar that is not moving for a reason nothing on screen explains.
   *
   *   But it is skipped entirely when there is no guarantor email, because
   *   applications submitted before guarantor verification existed never had an
   *   invitation. Showing them "Guarantor confirmed" would be this file
   *   inventing an event that never happened — the exact thing its own header
   *   says makes a status page worthless.
   */
  if (application.guarantorEmail) {
    entries.push({
      key: 'guarantor',
      title: onGuarantor ? 'Waiting on your guarantor' : 'Guarantor confirmed',
      detail: onGuarantor
        ? 'We have emailed them a link to confirm and verify themselves. Nothing else is needed from you — you can re-send it if they did not get it.'
        : 'They confirmed and verified themselves.',
      at: null,
      tone: onGuarantor ? 'current' : 'done',
    });
  }

  entries.push({
    key: 'review',
    title: onGuarantor
      ? 'Document review'
      : isAwaitingReview(status)
        ? 'Waiting for a reviewer'
        : 'Document review',
    detail: decided
      ? 'Your documents were checked.'
      : onGuarantor
        ? `Starts once your guarantor confirms. We aim to decide within ${REVIEW_WORKING_DAYS} working days after that.`
        : overdue
          ? `${waiting} working days so far — past the ${REVIEW_WORKING_DAYS} we promised. Chase us if you have not heard.`
          : `${waiting} working day${waiting === 1 ? '' : 's'} so far. We aim to decide within ${REVIEW_WORKING_DAYS}.`,
    at: null,
    /* Not started yet while a guarantor is outstanding. */
    tone: decided ? 'done' : onGuarantor ? 'pending' : 'current',
  });

  if (decided) {
    entries.push({
      key: 'decision',
      title: status === 'approved' ? 'Approved' : 'Not approved',
      detail:
        application.reviewNote ??
        (status === 'approved'
          ? 'You can accept delivery jobs from the Find Open Jobs board.'
          : 'Your application was reviewed and not approved this time.'),
      at: application.reviewedAt,
      tone: status === 'approved' ? 'done' : 'failed',
    });
  } else {
    entries.push({
      key: 'decision',
      title: 'Decision',
      detail: 'You will see the outcome here as soon as a reviewer records it.',
      at: null,
      tone: 'pending',
    });
  }

  return entries;
}

/**
 * The emails we actually attempted, and what became of them.
 *
 * Three states, and the difference between them matters to whoever reads this:
 *
 *   sent          the provider accepted it — check spam if it is not in the inbox
 *   failed        it never left, and support needs to know
 *   not attempted no mail provider is configured, so nothing was ever tried
 *
 * The third is not a failure and must not be shown as one, but it must not be
 * shown as a success either.
 */
export function notificationTimeline(application: DriverApplication): TimelineEntry[] {
  const { confirmationEmailSentAt, confirmationEmailError } = application;

  const confirmation: TimelineEntry = confirmationEmailError
    ? {
        key: 'confirmation-email',
        title: 'Confirmation email could not be sent',
        detail: `We could not deliver it to ${application.email}. Your application is safe — this only affected the email.`,
        at: null,
        tone: 'failed',
        notification: true,
      }
    : confirmationEmailSentAt
      ? {
          key: 'confirmation-email',
          title: 'Confirmation email sent',
          detail: `Sent to ${application.email}. Check your spam folder if you cannot find it.`,
          at: confirmationEmailSentAt,
          tone: 'done',
          notification: true,
        }
      : {
          key: 'confirmation-email',
          title: 'Confirmation email not sent',
          detail: 'Email notifications are not switched on for this project yet.',
          at: null,
          tone: 'pending',
          notification: true,
        };

  return [confirmation];
}

/**
 * Whether the app can currently email a decision.
 *
 * It cannot: only the on-submit confirmation is wired up. The Updates screen
 * says so rather than letting someone sit waiting for a message that no code
 * sends — the same failure the confirmation email itself was built to fix.
 */
export const DECISION_EMAILS_ENABLED = false;

export { formatWhen };
