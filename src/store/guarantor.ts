import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { assertImageBytes, contentTypeFor, readFileBytes } from '@/lib/upload';
import {
  CONSENT_TEXT,
  SURETYSHIP_CLAUSE,
  type DocumentKind,
  MAX_DOCUMENT_BYTES,
} from '@/constants/guarantor';

/**
 * The guarantor's side, called by somebody with no account.
 *
 * ⚠ One RPC and one edge function, and the split between them is the design.
 *
 *   `open_guarantor_invitation` is granted to `anon` and is a read: it says who
 *   listed you and nothing else. Every *write* goes through the
 *   `guarantor-portal` edge function, which holds the service role. Nothing in
 *   this file can insert a row, upload an object or complete a verification
 *   using the anon key — see `20250101000051_guarantor_full_form.sql` for why
 *   that moved, and `39` for the token rules that make any of it defensible.
 */

/* Re-exported so a screen importing the form's copy and its calls has one import. */
export { CONSENT_TEXT, SURETYSHIP_CLAUSE };

const FUNCTION = 'guarantor-portal';

export type InvitationView =
  | {
      valid: true;
      driverName: string;
      guarantorName: string;
      /** The address the invitation was sent to, shown read-only on the form. */
      guarantorEmail: string;
      reference: string;
      expiresAt: string | null;
    }
  /**
   * ⚠ Three reasons, because the page says something different for each.
   *
   *   "Invalid" is a wrong or spent-by-probing link; "expired" is one that
   *   lapsed and can be re-sent by the driver; "completed" is one that already
   *   worked, and the person is probably re-reading the email. Collapsing them
   *   into "something went wrong" leaves all three with nothing to do next.
   */
  | { valid: false; reason: 'invalid' | 'expired' | 'completed' | 'unreachable' };

export async function openInvitation(token: string): Promise<InvitationView> {
  try {
    const { data, error } = await supabase.rpc('open_guarantor_invitation', { p_token: token });

    if (error) return { valid: false, reason: 'unreachable' };

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { valid: false, reason: 'invalid' };

    if (!row.valid) {
      const reason =
        row.reason === 'expired' || row.reason === 'completed' ? row.reason : 'invalid';
      return { valid: false, reason };
    }

    return {
      valid: true,
      driverName: String(row.driver_name ?? ''),
      guarantorName: String(row.guarantor_name ?? ''),
      guarantorEmail: String(row.guarantor_email ?? ''),
      reference: String(row.reference ?? ''),
      expiresAt: row.expires_at ?? null,
    };
  } catch {
    return { valid: false, reason: 'unreachable' };
  }
}

/* --------------------------------------------------------------- uploads -- */

export type UploadOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: string; message: string };

const UPLOAD_MESSAGES: Record<string, string> = {
  invalid: 'This link is not valid. Ask the driver to send you a new one.',
  expired: 'This link has expired. Ask the driver to send you a new one.',
  completed: 'This has already been completed. Nothing else is needed from you.',
  'bad-kind': 'We could not tell what that file was for. Please try again.',
  'bad-path': 'We could not tell what that file was for. Please try again.',
  'not-uploaded': 'That file did not reach us. Please try again.',
  'empty-file': 'That file came through empty. Please take it again.',
  'too-large': 'That image is too large. Please take it again — 6MB is the limit.',
  'not-a-photo': 'Your live photo has to be a photograph taken with the camera.',
  error: 'We could not upload that just now. Please try again.',
};

const uploadMessage = (reason: string) => UPLOAD_MESSAGES[reason] ?? UPLOAD_MESSAGES.error;

/**
 * Uploads one of the guarantor's two files.
 *
 * ⚠ Three steps, and none of them can be skipped by a client in a hurry.
 *
 *     1. The function is asked where this file may go. It re-checks the token
 *        and derives the path; nothing here chooses one.
 *     2. The bytes go straight to Storage on a signed URL scoped to that path.
 *        They never pass through the function, because a government ID
 *        photographed on a phone is several megabytes and base64 makes it
 *        worse.
 *     3. The function is told it landed — and asks Storage what actually
 *        arrived rather than believing this file about the size or the type.
 *
 * ⚠ The size is checked here as well as there, which is not redundant.
 *
 *   Refusing a 9MB photo before it is uploaded saves somebody on mobile data a
 *   minute of waiting to be told no. The function's own ceiling is what makes
 *   the rule true; this is what makes it kind.
 */
export async function uploadGuarantorDocument(
  token: string,
  kind: DocumentKind,
  uri: string,
): Promise<UploadOutcome> {
  try {
    const file = await readFileBytes(uri, contentTypeFor(uri));

    /* A live photo must be an image; an ID may legitimately be a PDF scan. */
    if (kind === 'live_photo') assertImageBytes(file, 'photo');

    if (file.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      return { ok: false, reason: 'too-large', message: uploadMessage('too-large') };
    }

    const { data: slot, error: slotError } = await supabase.functions.invoke(FUNCTION, {
      body: { action: 'upload-url', token, kind },
    });

    if (slotError) return { ok: false, reason: 'error', message: uploadMessage('error') };
    if (!slot?.ok) {
      const reason = String(slot?.reason ?? 'error');
      return { ok: false, reason, message: uploadMessage(reason) };
    }

    const path = String(slot.path);

    const { error: storageError } = await supabase.storage
      .from('guarantor-identity')
      .uploadToSignedUrl(path, String(slot.uploadToken), file.bytes, {
        contentType: file.contentType,
        /*
         * ⚠ No `upsert` here, and not because a retake does not need one.
         *
         *   It does — the path is the same on every attempt. But `upsert` passed
         *   to `uploadToSignedUrl` has no effect whatsoever: the permission is
         *   baked into the token when the URL is signed, which happens in
         *   `guarantor-portal`. Passing it here would read like the thing that
         *   makes retakes work, and it would be the wrong place to look when
         *   they stopped.
         */
      });

    if (storageError) {
      return {
        ok: false,
        reason: 'error',
        message: errorMessage(storageError, uploadMessage('error')),
      };
    }

    const { data: confirmed, error: confirmError } = await supabase.functions.invoke(FUNCTION, {
      body: { action: 'confirm-upload', token, kind, path },
    });

    if (confirmError) return { ok: false, reason: 'error', message: uploadMessage('error') };
    if (!confirmed?.ok) {
      const reason = String(confirmed?.reason ?? 'error');
      return { ok: false, reason, message: uploadMessage(reason) };
    }

    return { ok: true, path };
  } catch (thrown) {
    return { ok: false, reason: 'error', message: errorMessage(thrown, uploadMessage('error')) };
  }
}

/* ------------------------------------------------------------ submission -- */

/**
 * Everything the guarantor typed.
 *
 * ⚠ `consentText` and `declarationText` are in here rather than added by the
 *   server.
 *
 *   The row stores the wording that was on the screen, which is only true if it
 *   travels with the submission. A server that filled in its own current
 *   wording would produce a record of somebody agreeing to a paragraph they may
 *   never have seen.
 */
export type GuarantorSubmission = {
  nin: string;
  fullName: string;
  whatsappPhone: string;
  email: string;
  residentialAddress: string;
  relationship: string;
  knownDuration: string;
  employmentStatus: string;
  companyName: string;
  jobTitle: string;
  signatureName: string;
  consentText: string;
  declarationText: string;
};

export type CompleteReason =
  | 'invalid'
  | 'expired'
  | 'completed'
  | 'bad-nin'
  | 'bad-name'
  | 'bad-phone'
  | 'bad-email'
  | 'bad-address'
  | 'bad-relationship'
  | 'bad-duration'
  | 'bad-employment'
  | 'bad-employer'
  | 'no-consent'
  | 'no-declaration'
  | 'signature-mismatch'
  | 'missing-documents'
  | 'error';

export type CompleteOutcome = { ok: true } | { ok: false; reason: CompleteReason; message: string };

const MESSAGES: Record<CompleteReason, string> = {
  invalid: 'This link is not valid. Ask the driver to send you a new one.',
  expired: 'This link has expired. Ask the driver to send you a new one.',
  completed: 'This has already been completed. Nothing else is needed from you.',
  'bad-nin': 'A NIN is 11 digits. Please check and try again.',
  'bad-name': 'Please enter your first and last name.',
  'bad-phone': 'Please enter the WhatsApp number you can be reached on.',
  'bad-email': 'Please enter a valid email address.',
  'bad-address': 'Please enter your full residential address.',
  'bad-relationship': 'Please say how you know this person.',
  'bad-duration': 'Please say how long you have known them.',
  'bad-employment': 'Please choose your employment status.',
  'bad-employer': 'Please give your employer and your job title.',
  'no-consent': 'Please tick the box to confirm you agree.',
  'no-declaration': 'Please read and accept the guarantor declaration.',
  /*
   * ⚠ Named plainly, because the cause is never obvious from the form.
   *
   *   The signature has to be the same name entered above. Somebody who typed
   *   "Bisi" there and "Bisi Olawale" here gets a refusal that would otherwise
   *   look like a bug in the button.
   */
  'signature-mismatch': 'Sign with the same full name you entered above.',
  'missing-documents': 'Please attach your ID and take your live photo first.',
  error: 'We could not save that just now. Please try again.',
};

/** Narrows whatever the database said into a reason this file knows about. */
function toReason(value: unknown): CompleteReason {
  return typeof value === 'string' && value in MESSAGES ? (value as CompleteReason) : 'error';
}

export async function completeVerification(
  token: string,
  form: GuarantorSubmission,
): Promise<CompleteOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION, {
      body: {
        action: 'submit',
        token,
        /*
         * ⚠ Snake case, because this payload is read by SQL.
         *
         *   `complete_guarantor_verification` reads `p_payload->>'full_name'`.
         *   A camelCase key here is not a type error anywhere — it is a null in
         *   a column, or a refusal the form cannot explain.
         */
        payload: {
          nin: form.nin,
          full_name: form.fullName,
          whatsapp_phone: form.whatsappPhone,
          email: form.email,
          residential_address: form.residentialAddress,
          relationship: form.relationship,
          known_duration: form.knownDuration,
          employment_status: form.employmentStatus,
          company_name: form.companyName,
          job_title: form.jobTitle,
          signature_name: form.signatureName,
          consent_text: form.consentText,
          declaration_text: form.declarationText,
        },
        /*
         * ⚠ The IP and the user agent are not sent from here.
         *
         *   A client-supplied address is worth nothing in a dispute — it is
         *   whatever the client says it is. The edge function fills both from
         *   what it observed, which is the whole reason the write moved there.
         */
      },
    });

    if (error) return { ok: false, reason: 'error', message: MESSAGES.error };

    if (data?.ok) return { ok: true };

    const reason = toReason(data?.reason);
    return { ok: false, reason, message: MESSAGES[reason] };
  } catch (thrown) {
    return { ok: false, reason: 'error', message: errorMessage(thrown, MESSAGES.error) };
  }
}

/* ------------------------------------------------------- the driver's side -- */

export type GuarantorState = {
  state: 'waiting' | 'expired' | 'completed';
  guarantorName: string;
  /**
   * ⚠ Shown to the driver in full, on purpose.
   *
   *   It is the address they typed themselves, and a mistyped one is the single
   *   commonest reason a guarantor never answers. Masking it would hide the
   *   only thing on the card they can act on.
   */
  guarantorEmail: string;
  /** When the invitation was minted — the link's birthday. */
  invitedAt: string | null;
  /** When the provider accepted the email, or null while it is still queued. */
  emailSentAt: string | null;
  expiresAt: string | null;
  completedAt: string | null;
  /** How many invitations have been sent for this application. */
  invitations: number;
};

/** What the driver may know: whether their guarantor has done it. Never the token. */
export async function fetchGuarantorState(): Promise<GuarantorState | null> {
  const { data, error } = await supabase.rpc('my_guarantor_status');
  if (error) return null;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;

  return {
    state: row.state,
    guarantorName: String(row.guarantor_name ?? ''),
    guarantorEmail: String(row.guarantor_email ?? ''),
    invitedAt: row.invited_at ?? null,
    emailSentAt: row.email_sent_at ?? null,
    expiresAt: row.expires_at ?? null,
    completedAt: row.completed_at ?? null,
    invitations: Number(row.invitations ?? 1),
  };
}

/** Sends a fresh invitation, optionally to a corrected address. */
export async function reinviteGuarantor(email?: string): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await supabase.rpc('reinvite_guarantor', {
    p_email: email?.trim() || null,
  });

  if (error) return { ok: false, message: errorMessage(error, 'Could not send that just now.') };

  const row = Array.isArray(data) ? data[0] : data;
  if (row?.ok) return { ok: true, message: 'Invitation sent.' };

  const reasons: Record<string, string> = {
    'no-application': 'You have no application waiting on a guarantor.',
    'not-waiting': 'Your application is no longer waiting on your guarantor.',
    'no-email': 'Add your guarantor’s email address first.',
  };

  return { ok: false, message: reasons[String(row?.reason)] ?? 'Could not send that just now.' };
}
