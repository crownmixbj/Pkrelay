import { errorMessage } from '@/lib/errors';
import { NIN_LENGTH } from '@/constants/driver-validation';
import { supabase } from '@/lib/supabase';
import { contentTypeFor, extensionOf, readFileBytes } from '@/lib/upload';

/**
 * Sender identity: one full check, then a face.
 *
 * ⚠ Everything here processes biometric data to identify a person, which the
 *   NDPA treats as sensitive personal data. `supabase/28_sender_identity.sql`
 *   carries the full note, including the fact that nothing deletes a reference
 *   photo and that this is LEGAL_REVIEW_REQUIRED.
 */

/**
 * ⚠ `flagged` and `rejected` are not two words for one thing.
 *
 *   `flagged` is a machine's doubt — an old NIMC photo, a dark room, a bad
 *   camera. It does not stop anybody, because refusing on that evidence locks
 *   real customers out with no recourse. `rejected` is a person's decision,
 *   reached with the slip and the face side by side, and it does stop them —
 *   until they submit again.
 *
 *   28_sender_identity.sql explains why the automated path deliberately has no
 *   `rejected`; 41 explains why the human one does.
 */
export type IdentityStatus = 'unverified' | 'pending' | 'verified' | 'flagged' | 'rejected';

export type SenderIdentity = {
  status: IdentityStatus;
  /** Whether there is a master photo to compare a new selfie against. */
  hasReference: boolean;
  /** Last four digits only. The full NIN never leaves the server. */
  ninLast4: string | null;
  confidence: number | null;
  environment: 'sandbox' | 'production' | null;
  checkedAt: string | null;
  /**
   * Why a reviewer refused it. Null unless somebody has been refused.
   *
   * ⚠ This is the sender's copy of the reason, and it is the reason the block
   *   is survivable. Without it the app can only say "no", and the only way to
   *   find out what to fix is to email support about a photo they cannot see.
   */
  reviewNote: string | null;
};

/**
 * What a sender is asked for on this shipment.
 *
 *   onboarding  NIN, NIN slip and a selfie. Once, on the first parcel.
 *   selfie      a selfie, compared against the master photo.
 *   capture     a selfie, with nothing to compare it to.
 *
 * ⚠ `capture` is the state that is easy to forget, and leaving it out is a bug
 *   I made in the SQL before the harness caught it. A flagged account has been
 *   through onboarding — so it must not be sent round again — but its selfie
 *   was never confirmed, so it was never promoted to reference. There is
 *   nothing to compare against until a human resolves the flag.
 */
export type VerificationPath = 'onboarding' | 'selfie' | 'capture';

export function verificationPath(identity: SenderIdentity | null): VerificationPath {
  if (!identity) return 'onboarding';

  /*
   * `pending` means they started and did not finish. Onboarding again is right:
   * treating it as done would skip the check for everyone who abandoned partway
   * through, which is the population most worth checking.
   *
   * `rejected` joins them, and must. A refusal is a refusal *of what they
   * submitted* — the slip, the NIN, the selfie. Sending them down the selfie
   * path would ask for the one thing that cannot fix it and would leave the
   * rejection standing afterwards.
   */
  if (
    identity.status === 'unverified' ||
    identity.status === 'pending' ||
    identity.status === 'rejected'
  ) {
    return 'onboarding';
  }

  return identity.hasReference ? 'selfie' : 'capture';
}

/** What the booking form tells the sender they are about to be asked for. */
export function pathExplanation(path: VerificationPath): string {
  switch (path) {
    case 'onboarding':
      return 'First parcel only: your NIN, a photo of your NIN slip, and a selfie. After this we only ask for the selfie.';
    case 'selfie':
      return 'A quick selfie, checked against the photo you gave when you joined.';
    case 'capture':
      return 'A quick selfie. Your details are still being reviewed, so this one is recorded rather than matched.';
  }
}

type IdentityRow = {
  status: string;
  review_note: string | null;
  nin: string | null;
  reference_path: string | null;
  confidence: number | string | null;
  environment: string | null;
  checked_at: string | null;
};

/**
 * This account's identity state.
 *
 * Returns null when there is no row — a sender who has never posted a parcel.
 * The NIN comes back only as its last four digits; RLS lets the owner read
 * their own row, and there is no reason for the whole number to sit in app
 * memory to render a masked string.
 */
export async function fetchSenderIdentity(): Promise<SenderIdentity | null> {
  const { data, error } = await supabase
    .from('sender_identity')
    .select('status, nin, reference_path, confidence, environment, checked_at, review_note')
    .maybeSingle();

  if (error || !data) return null;

  const row = data as IdentityRow;
  return {
    status: (row.status as IdentityStatus) ?? 'unverified',
    hasReference: row.reference_path !== null,
    ninLast4: row.nin ? row.nin.slice(-4) : null,
    confidence: row.confidence === null ? null : Number(row.confidence),
    environment: (row.environment as SenderIdentity['environment']) ?? null,
    checkedAt: row.checked_at,
    reviewNote: row.review_note,
  };
}

// ------------------------------------------------------------- validation --

/**
 * Whether a string could be a NIN.
 *
 * Eleven digits, and that is genuinely all that can be checked offline: NIMC
 * publishes no check digit, so any eleven digits are structurally valid. The
 * only real check is the one the provider does, which is why this refuses
 * nothing beyond an obvious typo.
 */
export function ninError(raw: string): string | null {
  const digits = normalizeNin(raw);

  if (digits.length === 0) return `Enter your ${NIN_LENGTH}-digit NIN.`;
  if (digits.length !== NIN_LENGTH) {
    return `A NIN is ${NIN_LENGTH} digits — you have ${digits.length}.`;
  }

  return null;
}

/** Digits only, which is how it is stored and sent. */
export const normalizeNin = (raw: string): string => raw.replace(/\D/g, '');

/**
 * What the field is allowed to hold while somebody is typing.
 *
 * ⚠ The cap belongs on the *input*, not only on the validator.
 *
 *   This field shipped with `maxLength={14}` and no digit mask, so a sender
 *   could type fourteen characters — or paste a number with spaces in it — and
 *   learn on submit that a NIN is eleven digits. `ninError` was correct all
 *   along and it was the wrong place to find out: the person had already
 *   finished the form.
 *
 *   Masking here makes "more than eleven" structurally impossible rather than
 *   merely refused. Fewer than eleven is still possible mid-typing, which is
 *   exactly right — a field that complained on the third keystroke would be
 *   shouting at somebody who has not finished.
 *
 *   The driver signup form has done this since it shipped; this is the sender
 *   path catching up, and `NIN_LENGTH` is shared so the two cannot drift.
 */
export const maskNinInput = (raw: string): string => normalizeNin(raw).slice(0, NIN_LENGTH);

/** For display: `•••• •••• 8901`. The full number is never rendered. */
export function maskNin(last4: string | null): string {
  return last4 ? `•••• •••• ${last4}` : 'Not on file';
}

// -------------------------------------------------------------- the flow ---

export type OnboardingInput = {
  nin: string;
  /** Local URI of the NIN slip photo or PDF. */
  slipUri: string;
  /** The capture session holding the live selfie. */
  sessionId: string;
};

/**
 * What came back, and what to say about it.
 *
 * ⚠ Every one of these sentences used to promise the parcel went ahead, and
 *   `42_verified_senders_only.sql` made all of them false.
 *
 *   They were written when a check outcome gated nothing: a flag or an outage
 *   was recorded and the shipment continued, so "your parcel is not held up"
 *   was both reassuring and true. Since 42 only a verified sender may post, so
 *   the two non-verified outcomes were telling somebody the opposite of what
 *   the database was about to do to them.
 *
 *   That is the worst class of copy bug in this app — not wrong in a way that
 *   looks wrong, but reassuring in a way that sends somebody off to fill in a
 *   booking form that cannot succeed.
 */
export type IdentityOutcome =
  | { ok: true; status: 'verified' | 'flagged' | 'unavailable'; message: string }
  | { ok: false; error: string };

/**
 * ⚠ One place, so the two ways of reaching each outcome cannot drift.
 *
 *   `unavailable` is returned from two branches — a transport failure and a
 *   response the function did not understand — and they had duplicate literals.
 *   Editing one and not the other is how half a fix ships.
 */
export const OUTCOME_MESSAGES: Record<'verified' | 'flagged' | 'unavailable', string> = {
  verified: 'Identity confirmed. You can send parcels now.',

  /*
   * ⚠ Does not say the photo failed, and does not promise a result time.
   *
   *   A mismatch is as often an old NIMC photo or a dark room as a fraud, and
   *   no person has looked yet — so this says what happens next rather than
   *   passing off a machine's guess as a verdict.
   */
  flagged:
    'Your ID has been saved and needs a person to check it. We will email you when that is done — you can send parcels once it is approved.',

  /*
   * ⚠ "Could not check" is not a failure the sender caused, and the sentence
   *   should not read like one.
   *
   *   This is what a sender sees when `verify-identity` is not deployed, which
   *   today is everybody. Their submission is stored and queued; nothing about
   *   it is wrong.
   */
  unavailable:
    'Your ID has been saved. The automatic check could not run, so a person will review it — we will email you when it is approved.',
};

/**
 * Uploads the slip, records the NIN, then asks the server to run the check.
 *
 * The upload and the record happen before the provider is called, so a Dojah
 * outage never costs the sender their typing. `begin_identity_check` is
 * idempotent per account — re-running it replaces the slip and clears any old
 * verdict.
 */
/**
 * Whether verifying is currently possible at all.
 *
 * ⚠ Optimistic until something proves otherwise, and it can only be proved by
 *   somebody trying.
 *
 *   There is no free probe here: `verify-identity` needs a capture session, so
 *   asking "are you up?" means running a real check on a real face. So this
 *   starts true, and one failed submission for an infrastructure reason flips
 *   it — meaning the first sender to hit an undeployed function is stopped
 *   once, fails, and is then let through along with everybody after them.
 *
 *   That is the right way round. The alternative — assume unavailable until
 *   proven otherwise — would leave the gate permanently open and the feature
 *   inert on a healthy deployment.
 */
let verificationReachable = true;

/** False once a submission has failed for reasons that are not the person's. */
/*
 * ⚠ No longer read by the posting gate, deliberately.
 *
 *   This existed so a Dojah outage would open the gate rather than close it —
 *   the argument being that a third-party outage must not become a total
 *   outage of the product. `42_verified_senders_only.sql` ends that: an outage
 *   is exactly when an unverified account would slip through. The flag is kept
 *   because the onboarding flow still uses it to tell a sender their
 *   submission failed for reasons that are not theirs, but nothing decides who
 *   may post from it.
 */
export function isVerificationAvailable(): boolean {
  return verificationReachable;
}

/**
 * Records that verification could not be reached.
 *
 * ⚠ Only for transport failures, never for a refusal.
 *
 *   A rejected NIN, a bad slip, an invalid number — those mean the check
 *   worked. Treating them as an outage would open the gate for exactly the
 *   people it exists to stop.
 */
export function noteVerificationUnavailable(): void {
  verificationReachable = false;
}

/** Called when a check completes, however it went. */
export function noteVerificationReachable(): void {
  verificationReachable = true;
}

export async function submitOnboarding(input: OnboardingInput): Promise<IdentityOutcome> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return { ok: false, error: 'Sign in first.' };

  const nin = normalizeNin(input.nin);
  const invalid = ninError(nin);
  if (invalid) return { ok: false, error: invalid };

  // `<user_id>/…` — storage RLS and `begin_identity_check` both require it.
  const slipPath = `${userId}/slip-${Date.now()}.${extensionOf(input.slipUri)}`;

  try {
    const { bytes, contentType } = await readFileBytes(
      input.slipUri,
      contentTypeFor(input.slipUri),
    );

    const upload = await supabase.storage
      .from('sender-identity')
      .upload(slipPath, bytes, { contentType, upsert: false });

    if (upload.error) return { ok: false, error: upload.error.message };
  } catch (thrown) {
    return {
      ok: false,
      error: errorMessage(thrown, 'Could not read that file.'),
    };
  }

  const begun = await supabase.rpc('begin_identity_check', {
    sender_nin: nin,
    sender_slip_path: slipPath,
  });
  if (begun.error) {
    /*
     * `begin_identity_check` is the app's own database function. It failing is
     * a deployment problem — a migration not run, a policy wrong — never
     * something the sender did, so the gate should not hold them for it.
     */
    noteVerificationUnavailable();
    return { ok: false, error: begun.error.message };
  }

  return runIdentityCheck(input.sessionId);
}

/**
 * Asks the server to verify a captured selfie.
 *
 * Only the session id goes over the wire, in either mode. The image is read
 * server-side from a private bucket, so a client cannot substitute a photo for
 * one it did not capture, and no face travels through app memory it does not
 * need to.
 *
 * ⚠ Never returns `{ ok: false }` for a mismatch.
 *
 *   A failed match is an *outcome*, not an error: the parcel still posts and
 *   the account is flagged for a human. Returning an error here would put a
 *   red banner in front of a sender for a decision nobody has made, and callers
 *   would reasonably block the shipment on it.
 */
export async function runIdentityCheck(sessionId: string): Promise<IdentityOutcome> {
  /*
   * `subject: 'sender'` is what tells the function to read the NIN from
   * `sender_identity` and write the verdict back there. Without it the call is
   * treated as a driver application — which is what happened before the
   * function knew there were two kinds of subject, and meant every sender check
   * came back 'unavailable'.
   */
  const { data, error } = await supabase.functions.invoke('verify-identity', {
    body: { session_id: sessionId, subject: 'sender' },
  });

  /*
   * A transport failure is 'unavailable', not a refusal.
   *
   * Dojah being unreachable says nothing about the sender. The selfie is
   * already stored, so the check can be re-run later without asking them for
   * anything again.
   */
  if (error) {
    /* The function is not deployed, or is unreachable. Nobody can verify. */
    noteVerificationUnavailable();
    return { ok: true, status: 'unavailable', message: OUTCOME_MESSAGES.unavailable };
  }

  const status = (data as { status?: string } | null)?.status;

  /* It answered, whatever it said — so verification is working. */
  noteVerificationReachable();

  if (status === 'verified') {
    return { ok: true, status: 'verified', message: OUTCOME_MESSAGES.verified };
  }
  if (status === 'flagged') {
    return { ok: true, status: 'flagged', message: OUTCOME_MESSAGES.flagged };
  }

  return { ok: true, status: 'unavailable', message: OUTCOME_MESSAGES.unavailable };
}
