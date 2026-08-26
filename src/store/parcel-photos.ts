import { assertImageBytes, contentTypeFor, extensionOf, readFileBytes } from '@/lib/upload';
import { buildLabel } from '@/lib/build-info';
import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { maskNin } from '@/store/identity';

/**
 * The two photographs a parcel carries, and who may look at them.
 *
 * ⚠ They are not the same kind of thing, and this file keeps them apart.
 *
 *   The parcel photo is a box on a table. It answers an operational question —
 *   what condition was this in when it was handed over — and staff read it the
 *   way they read a weight or an address.
 *
 *   The sender photo is a human face: sensitive personal data under the NDPA,
 *   and the sender is told it is "stored privately, visible only to you and to
 *   LOCI staff". Reaching it — and the NIN slip beside it — goes through
 *   `admin_reveal_sender_identity`, which writes a line naming who looked in the
 *   same transaction that returns the paths. Same shape as the contact reveal in
 *   `17_admin_parcel_detail.sql`.
 *
 *   Putting the parcel behind the reveal too would be worse, not safer: staff
 *   would type something into a reason box several times a day to see a
 *   cardboard box, and an audit trail full of "checking" is not evidence of
 *   anything.
 */

const BUCKET = 'parcel-photo';

/** An hour: long enough to work a queue, short enough that a pasted URL dies. */
const SIGNED_URL_SECONDS = 3600;

export type UploadOutcome = { ok: true; path: string } | { ok: false; error: string };

/**
 * Uploads the photo taken on the booking form, after the parcel exists.
 *
 * ⚠ After, not before, and that ordering is forced rather than chosen.
 *
 *   The storage policy checks the object's folder against a booking whose
 *   sender is the caller, so there has to *be* a booking. It also means the
 *   photo cannot be orphaned: no row, no upload.
 *
 * The caller decides what a failure means. It should not mean the parcel fails
 * — by the time this runs the parcel is posted and has a tracking id.
 */
export async function uploadParcelPhoto(bookingId: string, uri: string): Promise<UploadOutcome> {
  try {
    const { bytes, contentType } = assertImageBytes(
      await readFileBytes(uri, contentTypeFor(uri)),
      'parcel photo',
    );

    const fileName = `${Date.now()}.${extensionOf(uri)}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(`${bookingId}/${fileName}`, bytes, { contentType, upsert: false });

    /*
     * The build label rides along, as it does on the capture upload. Twice a
     * fix has been reported as still broken because the phone was running an
     * older bundle, and there is no EAS Update on this project.
     */
    if (error) return { ok: false, error: `${error.message} (${buildLabel()})` };

    /*
     * The path is derived server-side from the booking id and a sanitised file
     * name — this call passes the name only. A client that could name the whole
     * path could point a booking at another parcel's photograph.
     */
    const attached = await supabase.rpc('attach_parcel_photo', {
      booking_id: bookingId,
      file_name: fileName,
    });
    if (attached.error) return { ok: false, error: attached.error.message };

    return { ok: true, path: `${bookingId}/${fileName}` };
  } catch (thrown) {
    return { ok: false, error: errorMessage(thrown, 'Could not upload the parcel photo.') };
  }
}

/** A temporary URL for an object in the parcel bucket. Null if it cannot be signed. */
export async function signedParcelPhotoUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS);

  return error ? null : (data?.signedUrl ?? null);
}

export type SenderIdentity = {
  /** Signed URL for the selfie taken when this parcel was posted. */
  selfieUrl: string | null;
  /** Signed URL for the NIN slip, which may be a PDF rather than an image. */
  slipUrl: string | null;
  /** True when the slip is a PDF: it opens rather than renders. */
  slipIsPdf: boolean;
  /** `•••• •••• 8901`, or null when no NIN is on file. */
  ninMasked: string | null;
  status: string | null;
};

export type RevealOutcome = { ok: true; identity: SenderIdentity } | { ok: false; error: string };

type RevealRow = {
  selfie_path: string | null;
  slip_path: string | null;
  nin_last4: string | null;
  identity_status: string | null;
};

/**
 * Asks for everything the sender uploaded about themselves, on the record.
 *
 * ⚠ One call for the selfie and the slip, not one each.
 *
 *   An operator answering "is the person in this photo the person on this
 *   document" is performing a single act of looking. Two reveals would mean two
 *   reason boxes and two log lines for it, and a reason box somebody fills in
 *   twice to answer one question is a reason box they stop reading.
 *
 * Never throws for an absent photo. A parcel with no selfie, or a sender who
 * never onboarded, is an answer — and the audit line is written either way,
 * because asking to see a face that turns out not to exist is still asking.
 */
export async function revealSenderIdentity(
  bookingId: string,
  reason: string,
): Promise<RevealOutcome> {
  const { data, error } = await supabase.rpc('admin_reveal_sender_identity', {
    booking_id: bookingId,
    reason,
  });

  if (error) return { ok: false, error: error.message };
  return signRevealed(data as RevealRow[] | null);
}

/**
 * The same reveal, for a sender who has no parcel.
 *
 * ⚠ Which is the ordinary case in the identity review queue.
 *
 *   `revealSenderIdentity` is keyed on a booking, because it was written for
 *   the admin parcel drawer. The account most likely to be sitting in the
 *   review queue is one that has just verified from their profile and has never
 *   posted anything — so the booking-keyed reveal returns nothing for exactly
 *   the people a reviewer needs to look at.
 *
 *   It is the same door, not a second one: `admin_reveal_identity_for_user`
 *   writes the same 'privacy' line, into the same table, naming the same actor,
 *   carrying the same reason. One act of looking, one record of it.
 */
export async function revealIdentityForUser(
  userId: string,
  reason: string,
): Promise<RevealOutcome> {
  const { data, error } = await supabase.rpc('admin_reveal_identity_for_user', {
    target: userId,
    reason,
  });

  if (error) return { ok: false, error: error.message };
  return signRevealed(data as RevealRow[] | null);
}

/**
 * Turns storage paths into short-lived URLs.
 *
 * ⚠ Shared, so the two reveals cannot drift on which bucket holds what.
 *
 *   The selfie lives in `sender-photo` and the slip in `sender-identity` —
 *   different lifetimes, different retention decisions, and a pairing that is
 *   easy to write backwards. Getting it wrong produces a null URL rather than
 *   an error, which is to say a blank square where a face should be and nothing
 *   anywhere saying why.
 */
async function signRevealed(rows: RevealRow[] | null): Promise<RevealOutcome> {
  const row = rows?.[0];
  if (!row) {
    return {
      ok: true,
      identity: { selfieUrl: null, slipUrl: null, slipIsPdf: false, ninMasked: null, status: null },
    };
  }

  const [selfieUrl, slipUrl] = await Promise.all([
    row.selfie_path ? signedUrl('sender-photo', row.selfie_path) : null,
    row.slip_path ? signedUrl('sender-identity', row.slip_path) : null,
  ]);

  return {
    ok: true,
    identity: {
      selfieUrl,
      slipUrl,
      slipIsPdf: extensionOf(row.slip_path ?? '') === 'pdf',
      ninMasked: row.nin_last4 ? maskNin(row.nin_last4) : null,
      status: row.identity_status,
    },
  };
}

async function signedUrl(bucket: string, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_SECONDS);

  return error ? null : (data?.signedUrl ?? null);
}
