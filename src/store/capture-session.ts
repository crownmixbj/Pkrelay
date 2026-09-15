import { errorMessage } from '@/lib/errors';
import { buildLabel } from '@/lib/build-info';
import { supabase } from '@/lib/supabase';
import { assertImageBytes, contentTypeFor, extensionOf, readFileBytes } from '@/lib/upload';

/**
 * Handing the camera from a browser to a phone.
 *
 * The sender photo is taken before the parcel is posted, so on the web there is
 * no booking row to attach it to and no camera worth using. A capture session
 * bridges both: the browser opens one, shows its id in a QR code, and waits;
 * the phone opens the deep link, takes the photo, and writes the path back.
 *
 * The rules live in `supabase/migrations/20250101000013_capture_sessions.sql`. The session is bound to
 * one account, expires in ten minutes, and can be spent on one parcel — so the
 * id in the QR code is not enough on its own for someone who photographs it off
 * a screen.
 */

/*
 * The link itself lives in `constants/links.ts`, because whether it can be an
 * https universal link depends on configuration rather than on this store.
 */
export { captureLink } from '@/constants/links';

export type CaptureSession = {
  id: string;
  photoPath: string | null;
  completedAt: string | null;
  expiresAt: string;
};

type SessionRow = {
  id: string;
  photo_path: string | null;
  completed_at: string | null;
  expires_at: string;
};

const toSession = (row: SessionRow): CaptureSession => ({
  id: row.id,
  photoPath: row.photo_path,
  completedAt: row.completed_at,
  expiresAt: row.expires_at,
});

/** Opens a session and returns its id. Expires any the caller left open. */
export async function startCaptureSession(): Promise<string> {
  const { data, error } = await supabase.rpc('start_capture_session');
  if (error) throw error;
  return String(data);
}

export async function readCaptureSession(sessionId: string): Promise<CaptureSession | null> {
  const { data, error } = await supabase
    .from('photo_capture_sessions')
    .select('id, photo_path, completed_at, expires_at')
    .eq('id', sessionId)
    .maybeSingle();

  if (error || !data) return null;
  return toSession(data as SessionRow);
}

/**
 * Watches a session until the phone completes it.
 *
 * Realtime first, with a slow poll underneath. The poll is not redundant: a
 * Realtime subscription that fails to establish — a proxy that blocks
 * websockets, a laptop that slept — fails silently, and the sender would sit in
 * front of a QR code they had already scanned. Five seconds is slow enough to
 * be cheap and fast enough that nobody reaches for the reload button.
 *
 * Returns a function that stops both.
 */
export function watchCaptureSession(
  sessionId: string,
  onComplete: (session: CaptureSession) => void,
): () => void {
  let stopped = false;

  const finish = (session: CaptureSession) => {
    if (stopped || !session.completedAt) return;
    stopped = true;
    onComplete(session);
  };

  const channel = supabase
    .channel(`capture:${sessionId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'photo_capture_sessions',
        filter: `id=eq.${sessionId}`,
      },
      (payload) => finish(toSession(payload.new as SessionRow)),
    )
    .subscribe();

  const timer = setInterval(() => {
    if (stopped) return;
    void readCaptureSession(sessionId).then((session) => {
      if (session) finish(session);
    });
  }, 5000);

  return () => {
    stopped = true;
    clearInterval(timer);
    void supabase.removeChannel(channel);
  };
}

/**
 * Records the upload against the session.
 *
 * Only the file name is sent. The server builds the full path from the session
 * id, so a caller cannot point a session at an object belonging to a different
 * one.
 */
export async function completeCaptureSession(sessionId: string, fileName: string): Promise<void> {
  const { error } = await supabase.rpc('complete_capture_session', {
    session_id: sessionId,
    file_name: fileName,
  });
  if (error) throw error;
}

/** Spends the session on a posted parcel. Single use, enforced server-side. */
/**
 * ⚠ No longer on the posting path, and kept deliberately.
 *
 *   `20250101000044_selfie_with_the_parcel.sql` attaches the selfie inside the booking
 *   insert, because doing it afterwards meant a second call whose failure the
 *   booking form swallowed — producing parcels with no record of who posted
 *   them. Nothing in the app calls this now.
 *
 *   It stays because `consume_capture_session` is still granted in the
 *   database and is the only way to attach a photo to a parcel that already
 *   exists, which is what a support repair would need. Deleting the wrapper
 *   would not remove that function; it would only make it harder to reach.
 */
export async function consumeCaptureSession(sessionId: string, bookingId: string): Promise<void> {
  const { error } = await supabase.rpc('consume_capture_session', {
    session_id: sessionId,
    booking_id: bookingId,
  });
  if (error) throw error;
}

/**
 * Uploads a photo against a session rather than a booking.
 *
 * The file name is generated here and passed to `completeCaptureSession`
 * unchanged, so the object and the recorded path cannot disagree.
 */
export async function uploadCapturePhoto(
  sessionId: string,
  uri: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    /*
     * ⚠ This was `fetch(uri).blob()`, and it failed on a real phone with:
     *
     *       mime type text/plain is not supported
     *
     *   Both the extension and the content type were taken from `blob.type`,
     *   which for a `file://` read is whatever React Native's file handler put
     *   in the response header — regularly `text/plain`. So a perfectly good
     *   JPEG was uploaded as a text file, the `sender-photo` bucket refused it,
     *   and the sender was told their photo did not upload.
     *
     *   The name knows what the file is; the header does not. See
     *   `src/lib/upload.ts`.
     */
    const { bytes, contentType } = assertImageBytes(
      await readFileBytes(uri, contentTypeFor(uri)),
      'selfie',
    );

    const fileName = `${Date.now()}.${extensionOf(uri)}`;

    const { error } = await supabase.storage
      .from('sender-photo')
      .upload(`${sessionId}/${fileName}`, bytes, {
        contentType,
        upsert: false,
      });

    /*
     * The build label rides along on a storage failure.
     *
     * Twice now a fix has been reported as still broken because the phone was
     * running an older bundle — there is no EAS Update on this project, so
     * every JS change needs a new binary. A screenshot that says which build it
     * came from answers that in one glance instead of a round trip.
     */
    if (error) return { ok: false, error: `${error.message} (${buildLabel()})` };

    await completeCaptureSession(sessionId, fileName);
    return { ok: true };
  } catch (thrown) {
    return { ok: false, error: errorMessage(thrown, 'Upload failed') };
  }
}

// ------------------------------------------------------------- liveness ----

export type LivenessVerdict = 'passed' | 'failed' | 'unavailable';

export type LivenessOutcome = {
  status: LivenessVerdict;
  probability: number | null;
  /** 'sandbox' means a mock service answered. Never a real verification. */
  environment: 'sandbox' | 'production' | null;
  message: string;
};

/**
 * Asks the server to run the liveness check on a photo already uploaded.
 *
 * Only the session id goes over the wire. The image is fetched server-side from
 * the private bucket, so a client cannot upload one photo and submit a
 * different one for checking — and the Dojah secret stays where a client can
 * never read it.
 *
 * Never throws. Every failure path resolves to 'unavailable', because the two
 * things this can report — "not a live person" and "the provider is down" —
 * must not be confused: one is about the sender, the other is about us, and
 * only the first should ever stop somebody posting a parcel.
 */
export async function runLivenessCheck(sessionId: string): Promise<LivenessOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke('verify-liveness', {
      body: { session_id: sessionId },
    });

    if (error) {
      return {
        status: 'unavailable',
        probability: null,
        environment: null,
        message: 'The liveness check could not run.',
      };
    }

    const payload = (data ?? {}) as Partial<LivenessOutcome>;
    return {
      status: payload.status ?? 'unavailable',
      probability: typeof payload.probability === 'number' ? payload.probability : null,
      environment: payload.environment ?? null,
      message: payload.message ?? '',
    };
  } catch {
    return {
      status: 'unavailable',
      probability: null,
      environment: null,
      message: 'The liveness check could not run.',
    };
  }
}

/**
 * Whether a verdict should stop someone posting.
 *
 * Only an outright failure does. 'unavailable' lets the parcel through with the
 * reason recorded against it — an outage at a third party is not grounds to
 * refuse every parcel in the country, and the alternative is that a lapsed
 * Dojah wallet silently takes Package Relay offline.
 */
export function livenessBlocks(outcome: LivenessOutcome): boolean {
  return outcome.status === 'failed';
}

/**
 * What to tell the sender.
 *
 * A sandbox pass is called out explicitly. Dojah's own documentation says mock
 * results must never be used to make a live trust decision, and the surest way
 * to end up doing exactly that is to render a sandbox "passed" identically to a
 * real one.
 */
export function livenessLabel(outcome: LivenessOutcome): string {
  if (outcome.status === 'passed') {
    return outcome.environment === 'sandbox'
      ? 'Liveness check passed (test mode — not a real verification)'
      : 'Liveness check passed';
  }
  if (outcome.status === 'failed') return outcome.message || 'The photo did not pass.';

  /*
   * ⚠ This said "Liveness check unavailable — your parcel will be posted
   *   without it", and it was wrong twice over.
   *
   *   It appeared under a heading reading "Live photo captured and checked",
   *   which is the card and the note contradicting each other in the same box.
   *   Nothing failed: the photograph was taken, uploaded and stored. The only
   *   thing that did not happen is an automatic check at a third party.
   *
   *   And it named a parcel. This label is rendered for a driver *application*
   *   too — `sender-photo-sheet` takes a `purpose`, and the phone-handoff screen
   *   uses it for both — so an applicant photographing their face for a job was
   *   told about a parcel they were not posting.
   *
   *   The replacement says what is true in both places: the automatic check did
   *   not run, and a person takes it from here.
   *
   * ⚠ It does not repeat that the photo arrived, because the line above it
   *   already does.
   *
   *   This renders as the second line of a card whose heading is "Photo received
   *   from your phone." / "Live photo captured." An intervening draft opened
   *   with "Your photo was saved", which said the same thing twice in two
   *   sentences — the heading is the receipt, this line is what happens next.
   */
  return 'Liveness check unavailable — a team member will review it manually instead.';
}

// ------------------------------------------------------ identity matching ---

export type IdentityVerdict = 'matched' | 'mismatch' | 'unavailable';

export type IdentityOutcome = {
  status: IdentityVerdict;
  confidence: number | null;
  environment: 'sandbox' | 'production' | null;
  message: string;
};

/**
 * Matches a captured selfie against the photo held for a NIN.
 *
 * ⚠ Sensitive personal data — this establishes *who someone is*, not merely
 *   that they are alive. See `docs/PRIVACY-NOTES.md`.
 *
 * The NIN goes to the server, which passes it to Dojah; matching against a
 * government record necessarily means naming the record. Nothing here logs it.
 *
 * Never throws, and never blocks. A mismatch is recorded against the
 * application for a human to look at — NIN photos can be a decade old, and a
 * client that refused to submit on this number would lock out real drivers
 * whose only offence is having aged.
 */
export async function runIdentityCheck(sessionId: string, nin: string): Promise<IdentityOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke('verify-identity', {
      body: { session_id: sessionId, nin },
    });

    if (error) {
      return {
        status: 'unavailable',
        confidence: null,
        environment: null,
        message: 'The identity check could not run.',
      };
    }

    const payload = (data ?? {}) as Partial<IdentityOutcome>;
    return {
      status: payload.status ?? 'unavailable',
      confidence: typeof payload.confidence === 'number' ? payload.confidence : null,
      environment: payload.environment ?? null,
      message: payload.message ?? '',
    };
  } catch {
    return {
      status: 'unavailable',
      confidence: null,
      environment: null,
      message: 'The identity check could not run.',
    };
  }
}

/**
 * Copies the verdict from the session onto the application just created.
 *
 * ⚠ Without this the verdict is lost, and silently.
 *
 *   `verify-identity` runs while the applicant is still on page three, so there
 *   is no application row for it to write to yet — it records the answer on the
 *   capture session instead. This is the call that brings it across, and it is
 *   the reason a reviewer sees a check result rather than four nulls.
 *
 * Never throws. A failure here costs the reviewer a data point on an
 * application that has already been submitted; raising would show the applicant
 * an error about work that succeeded.
 */
export async function attachIdentityResult(
  applicationId: string,
  sessionId: string,
): Promise<void> {
  await supabase.rpc('attach_identity_result', {
    application_id: applicationId,
    session_id: sessionId,
  });
}

/**
 * What the applicant is told.
 *
 * A mismatch is deliberately not phrased as an accusation or a rejection. The
 * application is going to a human either way, and someone whose NIMC photo is
 * ten years old has done nothing wrong.
 */
export function identityLabel(outcome: IdentityOutcome): string {
  if (outcome.status === 'matched') {
    return outcome.environment === 'sandbox'
      ? 'Identity matched (test mode — not a real verification)'
      : 'Identity matched against your NIN record';
  }
  /*
   * ⚠ Neither sentence claims the application has been sent, and both used to.
   *
   *   They read "Your application has still been sent" — written when the photo
   *   was taken *inside* the submit handler, where it was true. `LiveSelfieCard`
   *   moved the capture above the confirmation checkbox, so this note now
   *   appears while the applicant is still filling the form. It told them their
   *   application was in, next to a button that had not been pressed — and, on
   *   the submission that failed on a not-null constraint, directly above a
   *   dialog saying it could not be submitted.
   *
   *   What was worth keeping is the reason the sentence existed: somebody whose
   *   face did not match a government photo needs to know it is not a rejection.
   *   That part is said without asserting anything about a row that may not
   *   exist yet.
   */
  if (outcome.status === 'mismatch') {
    return 'Your selfie did not match the photo on your NIN record. That does not stop your application — a person will review it.';
  }
  return 'Your photo was saved. The identity check could not run, so a person will review it instead.';
}
