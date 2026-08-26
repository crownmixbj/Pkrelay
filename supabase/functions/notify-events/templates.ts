/**
 * Every transactional email LOCI sends, as pure functions.
 *
 * No network, no Deno APIs, no secrets — so `scripts/verify-emails.ts` can
 * render all of them and assert on the output. An email template that is only
 * exercised by sending one is a template nobody checks.
 *
 * ⚠ Two rules hold across all of them.
 *
 *   Every interpolated value is escaped, because every one of them is
 *   user-entered somewhere upstream. And every one has a text part, because a
 *   multipart email without one is scored as spam and some recipients never see
 *   the HTML at all.
 *
 * ⚠ And one thing is absent from all of them.
 *
 *   No NIN, no full phone number, no bank account, no link to private storage.
 *   An email is forwarded, left open on a shared screen, and synced to
 *   somebody's cloud backup. It carries what somebody needs to know and a link
 *   to the app for anything that has to be protected.
 */
import {
  ROW,
  escapeHtml,
  firstName,
  headerSafe,
  layout,
  naira,
  whenReadable,
} from '../_shared/email.ts';

export type EmailKind =
  | 'guarantor_invitation'
  | 'sender_verification_submitted'
  | 'driver_application_approved'
  | 'driver_application_rejected'
  | 'sender_verified'
  | 'sender_verification_rejected'
  | 'delivery_completed'
  | 'parcel_cancelled'
  | 'parcel_status_changed'
  | 'driver_offer'
  | 'driver_job_cancelled'
  | 'payout_paid';

export type Rendered = { subject: string; html: string; text: string };

export type Payload = Record<string, unknown>;

const str = (payload: Payload, key: string): string => {
  const value = payload[key];
  return typeof value === 'string' ? value : value == null ? '' : String(value);
};

const num = (payload: Payload, key: string): number => {
  const value = payload[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Where the app lives, for links. Null when this deployment has no web URL. */
export type Context = {
  appUrl: string | null;
  supportEmail: string | null;
};

const support = (context: Context) =>
  context.supportEmail
    ? `Questions? Reply to this email or write to ${context.supportEmail}.`
    : 'Questions? Reply to this email.';

const link = (context: Context, path: string): string | null =>
  context.appUrl ? `${context.appUrl}${path}` : null;

/* ------------------------------------------------------ 1. the lifecycle -- */

function applicationApproved(payload: Payload, context: Context): Rendered {
  const name = firstName(str(payload, 'full_name'));
  const city = str(payload, 'base_city');
  const reference = str(payload, 'reference');
  const url = link(context, '/driver');

  const text = [
    `Hi ${name},`,
    '',
    'Your LOCI driver application has been approved. You can start accepting deliveries now.',
    '',
    `Reference: ${reference}`,
    city ? `Operating city: ${city}` : '',
    '',
    'What to do next',
    '1. Open the app and switch to Driver mode on your profile.',
    '2. Set up a trip so we know where you are heading.',
    '3. Offers for parcels along your route will arrive by push and by email.',
    '',
    url ? `Open your driver hub: ${url}` : '',
    '',
    support(context),
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    subject: headerSafe(`You're approved to drive with LOCI — ${reference}`),
    text,
    html: layout({
      heading: 'You are approved',
      intro: `Hi ${name}, your driver application has been approved. You can start accepting deliveries now.`,
      bodyHtml: [ROW('Reference', reference), city ? ROW('Operating city', city) : ''].join(''),
      cta: url ? { label: 'Open your driver hub', url } : null,
      footerNote: support(context),
    }),
  };
}

/**
 * ⚠ The hardest one to write, and the one most worth writing carefully.
 *
 *   A rejection is read by somebody who wanted the work. It does three things:
 *   says the decision plainly rather than burying it, gives the reason when one
 *   was recorded, and says honestly that there is not one when there is not —
 *   rather than implying a reason exists that support cannot then produce.
 */
function applicationRejected(payload: Payload, context: Context): Rendered {
  const name = firstName(str(payload, 'full_name'));
  const reference = str(payload, 'reference');
  const reason = str(payload, 'reason').trim();

  const text = [
    `Hi ${name},`,
    '',
    'We have reviewed your LOCI driver application, and we are not able to approve it this time.',
    '',
    `Reference: ${reference}`,
    '',
    reason
      ? `Reason given: ${reason}`
      : 'No specific reason was recorded against your application. If you would like more detail, reply to this email quoting the reference above and we will look into it.',
    '',
    'You are welcome to apply again if your circumstances change — a new vehicle, updated documents, or a different operating city.',
    '',
    support(context),
    '',
    'LOCI',
  ].join('\n');

  return {
    subject: headerSafe(`Your LOCI driver application — ${reference}`),
    text,
    html: layout({
      heading: 'About your driver application',
      intro: `Hi ${name}, we have reviewed your application and we are not able to approve it this time.`,
      bodyHtml: [
        ROW('Reference', reference),
        ROW('Reason', reason || 'Not recorded — reply and we will look into it'),
      ].join(''),
      cta: null,
      footerNote: `You can apply again if your circumstances change. ${support(context)}`,
    }),
  };
}

/**
 * ⚠ Sent when the documents arrive, not when a verdict does.
 *
 *   Its whole job is to close the loop on an action somebody just took: they
 *   typed a government ID number and photographed a document, and silence
 *   afterwards is where people start wondering whether it worked. It promises
 *   a second email rather than a time, because how long a check takes is not
 *   something this system can honestly commit to.
 */
/**
 * The one email in this system that goes to somebody who is not a LOCI user.
 *
 * ⚠ It has to explain itself from nothing.
 *
 *   Every other template here lands in an inbox that was expecting it. This
 *   one arrives unsolicited, from a company the reader may never have heard
 *   of, asking for a national identifier. If it reads like a phishing attempt
 *   it will be treated as one — correctly — so it names who listed them, what
 *   is being asked, and what happens if they do nothing.
 *
 * ⚠ The token is in the link and nowhere else.
 *
 *   Not in the subject, not in the body text, not as a code to type. A subject
 *   line is logged by more systems than a URL path, and shows in notification
 *   previews on a lock screen.
 */
function guarantorInvitation(payload: Payload, context: Context): Rendered {
  const guarantor = firstName(str(payload, 'guarantor_name'));
  const driver = str(payload, 'driver_name');
  const token = str(payload, 'token');
  const expires = whenReadable(str(payload, 'expires_at'));

  const url = token && context.appUrl ? `${context.appUrl}/guarantor/${token}` : null;

  const text = [
    `Hello ${guarantor},`,
    '',
    `${driver} has listed you as a guarantor on LOCI. Please click the secure link below to review the terms and complete your verification.`,
    '',
    url ? url : 'Open the LOCI app to complete your guarantor verification.',
    '',
    expires ? `This link expires on ${expires}.` : '',
    '',
    'What this involves: confirming you are willing to stand as their guarantor, and entering your own NIN so we can verify who you are. It takes about a minute.',
    '',
    `If you were not expecting this, or you do not know ${driver}, you can ignore this email — nothing happens without you.`,
    '',
    support(context),
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    /* Exactly the subject asked for. */
    subject: headerSafe(`Action Required: Guarantor Verification for ${driver}`),
    text,
    html: layout({
      heading: 'You have been listed as a guarantor',
      intro: `Hello ${guarantor}, ${driver} has listed you as a guarantor on LOCI. Please use the secure link below to review the terms and complete your verification.`,
      bodyHtml: [
        ROW('Driver', driver || 'Not named'),
        expires ? ROW('Link expires', expires) : '',
      ].join(''),
      cta: url ? { label: 'Review and verify', url } : null,
      footerNote: `If you were not expecting this, you can ignore it — nothing happens without you. ${support(context)}`,
    }),
  };
}

function verificationSubmitted(payload: Payload, context: Context): Rendered {
  const at = whenReadable(str(payload, 'submitted_at'));
  const url = link(context, '/profile');

  const text = [
    'Hi there,',
    '',
    'We have your NIN and the photo of your slip. Your verification is under review.',
    at ? `Submitted: ${at}` : '',
    '',
    'You do not need to do anything else. We will email you again as soon as the check is done.',
    '',
    'You can keep using LOCI in the meantime.',
    '',
    url ? `See your profile: ${url}` : '',
    '',
    support(context),
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    subject: headerSafe('Your NIN verification is under review'),
    text,
    html: layout({
      heading: 'Your NIN verification is under review',
      intro:
        'We have your NIN and the photo of your slip. You do not need to do anything else — we will email you again as soon as the check is done.',
      bodyHtml: at ? ROW('Submitted', at) : '',
      cta: url ? { label: 'See your profile', url } : null,
      footerNote: `You can keep using LOCI in the meantime. ${support(context)}`,
    }),
  };
}

function senderVerified(payload: Payload, context: Context): Rendered {
  const at = whenReadable(str(payload, 'verified_at'));
  const url = link(context, '/profile');

  const text = [
    'Hi there,',
    '',
    'Your identity has been verified. Nothing else is needed from you.',
    at ? `Verified: ${at}` : '',
    '',
    'From now on, posting a parcel only asks for a quick selfie — we check it against the photo you gave when you verified.',
    '',
    url ? `See your profile: ${url}` : '',
    '',
    support(context),
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    subject: headerSafe('Your LOCI identity is verified'),
    text,
    html: layout({
      heading: 'Identity verified',
      intro:
        'Your identity has been verified. Posting a parcel now only asks for a quick selfie, checked against the photo you gave.',
      bodyHtml: at ? ROW('Verified', at) : '',
      cta: url ? { label: 'See your profile', url } : null,
      footerNote: support(context),
    }),
  };
}

/**
 * ⚠ A refusal that is also an instruction, because the sender can fix this.
 *
 *   Unlike a driver rejection, which may be final, this one almost always is
 *   not: the usual cause is a blurry slip or a dark selfie. So the reason leads
 *   and the way back in is the call to action, rather than an apology followed
 *   by a dead end.
 *
 *   The reason is not optional here the way it is on a driver rejection —
 *   `sender_identity_rejection_has_reason` makes an empty one impossible to
 *   store. The fallback line exists for a payload that arrives malformed
 *   anyway, and says plainly that nothing was recorded rather than inventing a
 *   cause the sender would then argue with support about.
 */
function senderRejected(payload: Payload, context: Context): Rendered {
  const reason = str(payload, 'reason').trim();
  const url = link(context, '/profile');

  const text = [
    'Hi there,',
    '',
    'We looked at the ID you submitted, and we are not able to accept it as it is.',
    '',
    reason
      ? `What we found: ${reason}`
      : 'No specific reason was recorded. Reply to this email and we will look into it.',
    '',
    'You can submit again from your profile — most of the time it only takes a clearer photo.',
    url ? `Submit again: ${url}` : '',
    '',
    'Until then, you will not be able to post a parcel.',
    '',
    support(context),
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    subject: headerSafe('Your LOCI ID check needs another look'),
    text,
    html: layout({
      heading: 'We could not accept that ID',
      intro:
        'We looked at the ID you submitted and we are not able to accept it as it is. You can submit again — most of the time it only takes a clearer photo.',
      bodyHtml: ROW('What we found', reason || 'Not recorded — reply and we will look into it'),
      cta: url ? { label: 'Submit again', url } : null,
      footerNote: `Until you do, you will not be able to post a parcel. ${support(context)}`,
    }),
  };
}

/* --------------------------------------------------- 2. parcels, senders -- */

/**
 * ⚠ A summary, and never the word "receipt".
 *
 *   The brief asked for a payment receipt. LOCI has no payment provider, no
 *   charge record and no paid state on a booking — so this email can honestly
 *   say what the delivery cost, and cannot honestly say it was paid. A document
 *   headed "Receipt" is one somebody may hand to an accountant, an insurer or a
 *   court, and this system never witnessed the money.
 *
 * ⚠ The proof photo is linked to, not attached and not signed.
 *
 *   It lives in a private bucket and shows a doorway, often a person. A signed
 *   URL is readable by anyone the email reaches, for as long as it lives. The
 *   link goes to the parcel screen, behind the sign-in the sender already has.
 */
function deliveryCompleted(payload: Payload, context: Context): Rendered {
  const tracking = str(payload, 'tracking_id');
  const at = whenReadable(str(payload, 'delivered_at'));
  const recipient = str(payload, 'recipient_name');
  const driver = str(payload, 'driver_name');
  const fare = naira(num(payload, 'fare'));
  const hasProof = payload.has_proof === true;
  const url = link(context, `/parcel/${encodeURIComponent(tracking)}`);

  const text = [
    'Hi there,',
    '',
    `Your parcel ${tracking} has been delivered.`,
    '',
    at ? `Delivered: ${at}` : '',
    recipient ? `Received by: ${recipient}` : '',
    driver ? `Driver: ${driver}` : '',
    `Delivery charge: ${fare}`,
    '',
    hasProof
      ? 'A proof-of-delivery photo was taken. Open the parcel in the app to see it — it is kept behind your sign-in rather than sent by email.'
      : '',
    url ? `See this delivery: ${url}` : '',
    '',
    'This is a summary of what this delivery cost, not a payment receipt.',
    '',
    support(context),
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    subject: headerSafe(`Delivered — ${tracking}`),
    text,
    html: layout({
      heading: 'Your parcel was delivered',
      intro: `Parcel ${tracking} has arrived.`,
      bodyHtml: [
        at ? ROW('Delivered', at) : '',
        recipient ? ROW('Received by', recipient) : '',
        driver ? ROW('Driver', driver) : '',
        ROW('Delivery charge', fare),
        hasProof ? ROW('Proof of delivery', 'Photo taken — open the parcel to see it') : '',
      ].join(''),
      cta: url ? { label: 'See this delivery', url } : null,
      footerNote: `A summary of what this delivery cost, not a payment receipt. ${support(context)}`,
    }),
  };
}

function parcelCancelled(payload: Payload, context: Context): Rendered {
  const tracking = str(payload, 'tracking_id');
  const at = whenReadable(str(payload, 'cancelled_at'));
  const reason = str(payload, 'reason').trim();
  const by = str(payload, 'cancelled_by');
  const url = link(context, `/parcel/${encodeURIComponent(tracking)}`);

  const byLabel =
    by === 'driver' ? 'Cancelled by the driver' : by === 'sender' ? 'Cancelled by you' : '';

  const text = [
    'Hi there,',
    '',
    `Your parcel ${tracking} has been cancelled.`,
    '',
    at ? `Cancelled: ${at}` : '',
    byLabel,
    reason ? `Reason: ${reason}` : '',
    '',
    'Nothing further will happen with this parcel. If you still need it delivered, post it again from the app.',
    '',
    url ? `See this parcel: ${url}` : '',
    '',
    support(context),
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    subject: headerSafe(`Cancelled — ${tracking}`),
    text,
    html: layout({
      heading: 'Your parcel was cancelled',
      intro: `Parcel ${tracking} has been cancelled. Nothing further will happen with it.`,
      bodyHtml: [
        at ? ROW('Cancelled', at) : '',
        byLabel ? ROW('Cancelled by', by === 'driver' ? 'The driver' : 'You') : '',
        reason ? ROW('Reason', reason) : '',
      ].join(''),
      cta: url ? { label: 'See this parcel', url } : null,
      footerNote: support(context),
    }),
  };
}

/**
 * ⚠ The one that risks being noise.
 *
 *   A parcel passes through several stages, and an email at each is how people
 *   learn to filter your domain — after which they miss the delivery one too.
 *   The copy is deliberately short and the subject carries the stage, so it
 *   threads and can be muted without muting everything LOCI sends.
 */
function parcelStatusChanged(payload: Payload, context: Context): Rendered {
  const tracking = str(payload, 'tracking_id');
  const status = str(payload, 'status');
  const at = whenReadable(str(payload, 'changed_at'));
  const url = link(context, `/parcel/${encodeURIComponent(tracking)}`);

  const text = [
    'Hi there,',
    '',
    `Parcel ${tracking} is now: ${status}.`,
    at ? `Updated: ${at}` : '',
    '',
    url ? `Track it: ${url}` : '',
    '',
    support(context),
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    subject: headerSafe(`${tracking} — ${status}`),
    text,
    html: layout({
      heading: `Parcel ${tracking}`,
      intro: `Its status is now ${status}.`,
      bodyHtml: [ROW('Status', status), at ? ROW('Updated', at) : ''].join(''),
      cta: url ? { label: 'Track this parcel', url } : null,
      footerNote: support(context),
    }),
  };
}

/* ---------------------------------------------------- 3. jobs, drivers --- */

/**
 * ⚠ Sent alongside the push, not instead of it.
 *
 *   An offer expires. A driver whose phone is charging in another room misses
 *   the push and loses the job to the rotation, so this is a second chance at
 *   the same moment rather than a duplicate. The expiry is stated, because an
 *   offer email read an hour late is worse than useless if it does not say so.
 */
function driverOffer(payload: Payload, context: Context): Rendered {
  const tracking = str(payload, 'tracking_id');
  const route = str(payload, 'route');
  const fare = naira(num(payload, 'fare'));
  const expires = whenReadable(str(payload, 'expires_at'));
  const url = link(context, '/driver');

  const text = [
    'Hi there,',
    '',
    'A parcel on your route is available.',
    '',
    `Parcel: ${tracking}`,
    route ? `Route: ${route}` : '',
    `Delivery charge: ${fare}`,
    expires ? `This offer expires: ${expires}` : '',
    '',
    'Offers rotate to the next driver when they expire, so open the app to accept.',
    '',
    url ? `Open your driver hub: ${url}` : '',
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    subject: headerSafe(`New delivery offer — ${route || tracking}`),
    text,
    html: layout({
      heading: 'A parcel on your route',
      intro: 'This offer is yours until it expires, then it rotates to the next driver.',
      bodyHtml: [
        ROW('Parcel', tracking),
        route ? ROW('Route', route) : '',
        ROW('Delivery charge', fare),
        expires ? ROW('Expires', expires) : '',
      ].join(''),
      cta: url ? { label: 'Accept in the app', url } : null,
      footerNote: 'You receive these because you are an approved LOCI driver with an active trip.',
    }),
  };
}

function driverJobCancelled(payload: Payload, context: Context): Rendered {
  const tracking = str(payload, 'tracking_id');
  const route = str(payload, 'route');
  const at = whenReadable(str(payload, 'cancelled_at'));
  const url = link(context, '/driver');

  const text = [
    'Hi there,',
    '',
    `The parcel you accepted, ${tracking}, has been cancelled. Do not collect it.`,
    '',
    route ? `Route: ${route}` : '',
    at ? `Cancelled: ${at}` : '',
    '',
    'Your trip is unaffected and you are free for other offers.',
    '',
    url ? `Open your driver hub: ${url}` : '',
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    subject: headerSafe(`Cancelled — ${tracking}`),
    text,
    html: layout({
      heading: 'A job you accepted was cancelled',
      /* The instruction first: a driver reading this on the road needs the
         action, not the explanation. */
      intro: `Parcel ${tracking} has been cancelled. Do not collect it.`,
      bodyHtml: [route ? ROW('Route', route) : '', at ? ROW('Cancelled', at) : ''].join(''),
      cta: url ? { label: 'Open your driver hub', url } : null,
      footerNote: 'Your trip is unaffected and you are free for other offers.',
    }),
  };
}

/* ----------------------------------------------------------- 4. money ---- */

function payoutPaid(payload: Payload, context: Context): Rendered {
  const amount = naira(num(payload, 'amount'));
  const at = whenReadable(str(payload, 'paid_at'));
  const hint = str(payload, 'account_hint');
  const url = link(context, '/driver-wallet');

  const text = [
    'Hi there,',
    '',
    `${amount} has been sent to your bank account.`,
    '',
    at ? `Processed: ${at}` : '',
    hint ? `Account ending: ${hint}` : '',
    '',
    'Bank transfers usually land the same day. If it has not arrived within one working day, reply to this email.',
    '',
    url ? `See your wallet: ${url}` : '',
    '',
    'LOCI',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    subject: headerSafe(`Payout sent — ${amount}`),
    text,
    html: layout({
      heading: 'Your payout is on its way',
      intro: `${amount} has been sent to your bank account.`,
      bodyHtml: [
        ROW('Amount', amount),
        at ? ROW('Processed', at) : '',
        /* Four digits: enough to recognise the account, not enough to use it. */
        hint ? ROW('Account ending', hint) : '',
      ].join(''),
      cta: url ? { label: 'See your wallet', url } : null,
      footerNote:
        'Bank transfers usually land the same day. If it has not arrived within one working day, reply to this email.',
    }),
  };
}

const TEMPLATES: Record<EmailKind, (payload: Payload, context: Context) => Rendered> = {
  guarantor_invitation: guarantorInvitation,
  sender_verification_submitted: verificationSubmitted,
  driver_application_approved: applicationApproved,
  driver_application_rejected: applicationRejected,
  sender_verified: senderVerified,
  sender_verification_rejected: senderRejected,
  delivery_completed: deliveryCompleted,
  parcel_cancelled: parcelCancelled,
  parcel_status_changed: parcelStatusChanged,
  driver_offer: driverOffer,
  driver_job_cancelled: driverJobCancelled,
  payout_paid: payoutPaid,
};

export function isEmailKind(value: string): value is EmailKind {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

/**
 * Renders one email, or returns null for a kind nothing knows about.
 *
 * ⚠ Null rather than a fallback template.
 *
 *   A generic "something happened" email sent to a customer because a migration
 *   added a `kind` this file has not caught up with is worse than no email: it
 *   is unexplainable to the person who receives it and invisible to us, because
 *   it looks like a success.
 */
export function render(kind: string, payload: Payload, context: Context): Rendered | null {
  if (!isEmailKind(kind)) return null;
  return TEMPLATES[kind](payload, context);
}

/** Exported for the tests, which assert every kind has a template. */
export const EMAIL_KINDS = Object.keys(TEMPLATES) as EmailKind[];

/** Re-exported so tests can check escaping without reaching into `_shared`. */
export { escapeHtml };
