import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { readFileBytes } from '@/lib/upload';

/**
 * Uploads for driver application documents.
 *
 * Files live in a PRIVATE bucket at `<user_id>/<document_key>.<ext>`. That path
 * is not a convention the client is trusted to follow — the storage policies in
 * `20250101000005_storage_and_alerts.sql` compare the first segment to `auth.uid()`, so an
 * upload aimed at somebody else's folder is refused by Postgres.
 *
 * Nothing here produces a public URL. Reading is done through short-lived signed
 * URLs, because a public link to a driver's licence would outlive any session
 * that created it.
 */
export const DOCUMENTS_BUCKET = 'driver-documents';

/** Matches the bucket's `file_size_limit`, so the client fails fast. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  /*
    `heif` alongside `heic`, because `lib/upload.ts` has always known both and
    the bucket refused one of them. See 20250101000035_heif_uploads.sql.
  */
  heif: 'image/heif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** The bucket rejects anything else, so it's worth saying so before uploading. */
export const ACCEPTED_EXTENSIONS = Object.keys(MIME_BY_EXTENSION);

function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match ? match[1].toLowerCase() : '';
}

export function mimeFor(fileName: string): string | null {
  return MIME_BY_EXTENSION[extensionOf(fileName)] ?? null;
}

/**
 * The storage path for one document.
 *
 * Keyed on the document slot rather than the original filename, so re-uploading
 * a licence replaces the old one instead of leaving two files where a reviewer
 * has to guess which is current.
 */
export function documentPath(userId: string, key: string, fileName: string): string {
  const extension = extensionOf(fileName) || 'bin';
  return `${userId}/${key}.${extension}`;
}

export type UploadResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Uploads one local file.
 *
 * React Native has no `File`. `src/lib/upload.ts` explains how a local URI is
 * read into bytes, and why it is not done with `fetch().blob()`. On web the
 * picker hands back a blob URL, which the same reader handles unchanged.
 */
export async function uploadDocument(args: {
  userId: string;
  key: string;
  fileName: string;
  uri: string;
}): Promise<UploadResult> {
  const { userId, key, fileName, uri } = args;

  const contentType = mimeFor(fileName);
  if (!contentType) {
    return {
      ok: false,
      error: `${fileName} isn't an accepted format. Use ${ACCEPTED_EXTENSIONS.join(', ')}.`,
    };
  }

  /*
   * ⚠ This was `fetch(uri).blob()` too.
   *
   *   The content type here was already correct — the picker reports it, so
   *   this one never hit the text/plain rejection. What it shared with the
   *   other two is the read: `Response.prototype.blob` is undefined on some
   *   builds, which surfaces as "undefined is not a function" and no clue why.
   *   See `src/lib/upload.ts`.
   */
  let bytes: ArrayBuffer;
  try {
    // The picker's own content type wins; it knows better than an extension.
    ({ bytes } = await readFileBytes(uri, contentType));
  } catch (thrown) {
    return {
      ok: false,
      error: errorMessage(thrown, `Could not read ${fileName}.`),
    };
  }

  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      error: `${fileName} is larger than ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB.`,
    };
  }

  const path = documentPath(userId, key, fileName);

  const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).upload(path, bytes, {
    contentType,
    // Replace rather than fail: a second attempt at the same slot is a
    // correction, not a conflict.
    upsert: true,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, path };
}

/**
 * A temporary URL a reviewer can open.
 *
 * One hour is long enough to work through a queue and short enough that a URL
 * pasted into a message or left in a browser history stops working. Deliberately
 * not `getPublicUrl`, which would never expire.
 */
export async function signedDocumentUrl(path: string, expiresInSeconds = 3600) {
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
}
