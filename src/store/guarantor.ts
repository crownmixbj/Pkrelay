import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

/**
 * The guarantor's side, called by somebody with no account.
 *
 * ⚠ Every function here is reachable anonymously, and that is deliberate.
 *
 *   The guarantor will not sign up to confirm somebody else's job application,
 *   so the two RPCs below are granted to `anon`. The token is the entire
 *   credential — see `39_guarantor_verification.sql` for the rules that make
 *   that defensible.
 */

export type InvitationView =
  | { valid: true; driverName: string; guarantorName: string; expiresAt: string | null }
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
      expiresAt: row.expires_at ?? null,
    };
  } catch {
    return { valid: false, reason: 'unreachable' };
  }
}

/**
 * The exact wording the guarantor agrees to.
 *
 * ⚠ Kept as a constant and stored with the submission, not merely displayed.
 *
 *   "They ticked a box" is not a record of anything. If this is ever disputed,
 *   what survives has to be the sentence that was on screen — so the same
 *   string is rendered and written, and changing it changes both at once.
 */
export const CONSENT_TEXT =
  'I confirm that I agree to act as a guarantor for this driver on LOCI, that the ' +
  'National Identification Number I have entered is my own, and that LOCI may verify ' +
  'it with NIMC for this purpose.';

export type CompleteReason =
  'invalid' | 'expired' | 'completed' | 'bad-nin' | 'no-consent' | 'error';

export type CompleteOutcome = { ok: true } | { ok: false; reason: CompleteReason; message: string };

const MESSAGES: Record<CompleteReason, string> = {
  invalid: 'This link is not valid. Ask the driver to send you a new one.',
  expired: 'This link has expired. Ask the driver to send you a new one.',
  completed: 'This has already been completed. Nothing else is needed from you.',
  'bad-nin': 'A NIN is 11 digits. Please check and try again.',
  'no-consent': 'Please tick the box to confirm you agree.',
  error: 'We could not save that just now. Please try again.',
};

/** Narrows whatever the database said into a reason this file knows about. */
function toReason(value: unknown): CompleteReason {
  return typeof value === 'string' && value in MESSAGES ? (value as CompleteReason) : 'error';
}

export async function completeVerification(token: string, nin: string): Promise<CompleteOutcome> {
  try {
    const { data, error } = await supabase.rpc('complete_guarantor_verification', {
      p_token: token,
      p_nin: nin,
      p_consent_text: CONSENT_TEXT,
      /*
       * ⚠ The IP is not sent from here.
       *
       *   A client-supplied address is worth nothing in a dispute — it is
       *   whatever the client says it is. The column exists for a server-side
       *   caller to fill; sending a self-reported value would put something
       *   that looks like evidence next to something that is not.
       */
      p_ip: null,
    });

    if (error) return { ok: false, reason: 'error', message: MESSAGES.error };

    const row = Array.isArray(data) ? data[0] : data;
    if (row?.ok) return { ok: true };

    const reason = toReason(row?.reason);
    return { ok: false, reason, message: MESSAGES[reason] };
  } catch (thrown) {
    return { ok: false, reason: 'error', message: errorMessage(thrown, MESSAGES.error) };
  }
}

/* ------------------------------------------------------- the driver's side -- */

export type GuarantorState = {
  state: 'waiting' | 'expired' | 'completed';
  guarantorEmail: string;
  expiresAt: string | null;
};

/** What the driver may know: whether their guarantor has done it. Never the token. */
export async function fetchGuarantorState(): Promise<GuarantorState | null> {
  const { data, error } = await supabase.rpc('my_guarantor_status');
  if (error) return null;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;

  return {
    state: row.state,
    guarantorEmail: String(row.guarantor_email ?? ''),
    expiresAt: row.expires_at ?? null,
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
