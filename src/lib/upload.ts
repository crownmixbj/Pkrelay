import { File as FileSystemFile } from 'expo-file-system';
import { Platform } from 'react-native';

import { buildLabel } from '@/lib/build-info';
import { errorMessage } from '@/lib/errors';

/**
 * Reading a local file so Supabase Storage will accept it.
 *
 * ⚠ THIS EXISTS BECAUSE THE SAME BUG WAS WRITTEN THREE TIMES.
 *
 *   Every upload in this app started as `fetch(uri).blob()`, and that one line
 *   fails in two different ways on a real Android phone:
 *
 *     1. `Response.prototype.blob` is sometimes undefined. React Native's fetch
 *        is `whatwg-fetch`, which only defines `blob()` if `Blob` and
 *        `FileReader` are globals when the polyfill loads — they are installed
 *        lazily by `setUpXHR`, so it depends on module evaluation order.
 *        Hermes reports the result as "undefined is not a function", which is
 *        what the delivery proof upload showed.
 *
 *     2. When it *does* work, `blob.type` is whatever RN's file handler put in
 *        the response header, and for a `file://` read that is regularly
 *        `text/plain`. Passing it through as the content type gets the object
 *        rejected by a bucket that allows images:
 *
 *            mime type text/plain is not supported
 *
 *        which is what the sender's verification photo showed. The photo was
 *        fine; the label on it was not.
 *
 *   `XMLHttpRequest` with `responseType = 'arraybuffer'` is React Native core.
 *   It decodes natively and touches neither Blob nor FileReader, and the
 *   content type comes from the file *name*, which is the thing that actually
 *   knows what the file is.
 *
 * Fixing one caller and not the others is how this got written three times, so
 * every upload in the app now goes through here.
 */

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/**
 * The file extension on a URI or file name, lowercased, defaulting to jpg.
 *
 * Query strings and fragments are stripped first: a `blob:` or `content://`
 * URI can carry one, and `photo.jpg?w=100` would otherwise yield an extension
 * of `jpg?w=100` and a file stored under that name.
 */
export function extensionOf(nameOrUri: string): string {
  const clean = nameOrUri.trim().split(/[?#]/)[0];
  return (/\.([A-Za-z0-9]+)$/.exec(clean)?.[1] ?? 'jpg').toLowerCase();
}

/** The content type to store an object under, taken from its name. */
export function contentTypeFor(nameOrUri: string): string {
  return MIME[extensionOf(nameOrUri)] ?? 'image/jpeg';
}

/**
 * How big a local file is, without reading it.
 *
 * ⚠ For the case where the picker does not say.
 *
 *   `expo-document-picker` reports `size` for most providers and omits it for
 *   some — anything reached through a cloud provider in the Files app, and a few
 *   Android document providers. The form's own size check is written as
 *   `if (asset.size && asset.size > MAX)`, which is not a check at all when the
 *   size is missing: a 40 MB scan sails into the form and is refused at submit,
 *   after every other field has been filled in.
 *
 *   `info()` is a stat, not a read — it does not pull the bytes into memory,
 *   which is the whole reason this is worth having rather than measuring the
 *   file by loading it.
 *
 * Returns null when the size cannot be established: on the web, where the
 * filesystem module has no view of a `blob:` URL, and for any URI the platform
 * refuses to stat. A null is "unknown", never "empty" — callers must not treat
 * it as a pass or a fail on its own. `uploadDocument` measures the real bytes
 * before sending, which is the backstop.
 */
export async function fileSizeOf(uri: string): Promise<number | null> {
  if (Platform.OS === 'web') {
    /*
      The picker's own `size` is the usual answer on the web and the caller
      reaches for it first. This covers the rest: a file we were handed knows
      how big it is, and returning null meant the size cap simply did not exist
      in a browser — a photo over the limit was accepted here and refused at
      submit, thirty fields later.
    */
    return PICKED_BLOBS.get(uri)?.size ?? null;
  }

  try {
    const info = new FileSystemFile(uri).info();
    return typeof info.size === 'number' ? info.size : null;
  } catch {
    return null;
  }
}

export type FileBytes = { bytes: ArrayBuffer; contentType: string };

/**
 * Refuses anything that is not an image, before Storage has to.
 *
 * ⚠ This exists because "mime type text/plain is not supported" reached a real
 *   sender twice.
 *
 *   That message comes from Supabase Storage rejecting the bucket's allowed
 *   types — which means the app had already built a request, sent a photo, and
 *   learned what was wrong from a server that knows nothing about cameras. The
 *   sender was told their photo failed; the photo was fine.
 *
 *   Checking here turns a remote rejection into a local one that can name the
 *   type it was about to send, so the next occurrence is diagnosable from the
 *   screenshot alone rather than from another round trip.
 *
 * Not applied inside `readFileBytes` itself: driver documents are legitimately
 * PDFs. Only the photo callers use this.
 */
export function assertImageBytes(file: FileBytes, what = 'photo'): FileBytes {
  if (!file.contentType.startsWith('image/')) {
    throw new Error(
      `That ${what} came back as ${file.contentType}, which is not an image. ` +
        'Take it again, or pick it from your gallery.',
    );
  }
  return file;
}

/** The bit before the `:`, for error messages. `file`, `content`, `ph`, `blob`. */
function schemeOf(uri: string): string {
  return /^([a-z][a-z0-9+.-]*):/i.exec(uri.trim())?.[1]?.toLowerCase() ?? 'none';
}

/**
 * The `Blob` behind an object URL, where we were handed one.
 *
 * ⚠ This exists because a `blob:` URL is a *handle*, not a file.
 *
 *   `expo-image-picker` on the web returns `uri: URL.createObjectURL(file)` —
 *   and, on the same object, `file`, the real `File`. The URL is a pointer into
 *   the document that made it: it dies with that document, it dies when
 *   anything revokes it, and on a phone the browser may drop the backing store
 *   under memory pressure while the page is still alive. A sender in a mobile
 *   browser got
 *
 *       Could not read that file off this device. (blob URI, web, …)
 *
 *   on a photograph that was sitting in memory the whole time, because the only
 *   thing we kept was the pointer.
 *
 *   So: when a picker hands us the `File`, we keep the `File`. Reading it needs
 *   no URL, no network stack and no document — `Blob.arrayBuffer()` is the
 *   bytes themselves.
 *
 * ⚠ Bounded, because this holds photographs in memory.
 *
 *   Eight is more than any flow needs — the longest is the driver application,
 *   with a licence, an insurance document and a selfie — and the oldest entry
 *   is dropped rather than letting a long session accumulate megabytes of faces
 *   nobody is going to upload.
 */
const PICKED_BLOBS = new Map<string, Blob>();
const PICKED_LIMIT = 8;

/**
 * Remembers the file a picker returned, and gives back its uri unchanged.
 *
 * Written to be dropped into an existing call site:
 *
 *     setUri(rememberPickedFile(result.assets[0]));
 *
 * A no-op off the web, where `file` is never set and the uri is a real path the
 * file system can open.
 */
export function rememberPickedFile(asset: { uri: string; file?: Blob } | undefined): string {
  const uri = asset?.uri ?? '';
  if (Platform.OS !== 'web' || !asset?.file || !uri) return uri;

  if (PICKED_BLOBS.size >= PICKED_LIMIT) {
    const oldest = PICKED_BLOBS.keys().next().value;
    if (oldest !== undefined) PICKED_BLOBS.delete(oldest);
  }

  PICKED_BLOBS.set(uri, asset.file);
  return uri;
}

/** Decodes a `data:` URI without going near the network. */
function bytesFromDataUri(uri: string): ArrayBuffer | null {
  const comma = uri.indexOf(',');
  if (comma === -1) return null;

  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);

  try {
    if (!/;base64/i.test(meta)) {
      return new TextEncoder().encode(decodeURIComponent(payload)).buffer as ArrayBuffer;
    }

    const binary = atob(payload);
    const out = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) out[at] = binary.charCodeAt(at);
    return out.buffer;
  } catch {
    return null;
  }
}

/**
 * Reads a local file as bytes.
 *
 * `contentTypeHint` wins when the caller genuinely knows better — a document
 * picker reports the type the OS assigned, which beats guessing from an
 * extension the user may have typed.
 *
 * ⚠ The file system first, the network stack only as a fallback.
 *
 *   `readFileBytes` used to be XHR alone, and a driver taking their selfie on a
 *   real phone got "Could not read that file off this device." — which is this
 *   file's own words for `XMLHttpRequest.onerror`.
 *
 *   The reason is that XHR is a *network* client being asked to open a local
 *   path. On Android it is backed by OkHttp, which speaks http and https and
 *   nothing else; whether a `file://` read works at all depends on which
 *   request handlers happen to be registered, and `content://` — what the OS
 *   hands back for anything reached through the storage framework — it cannot
 *   open under any circumstances. The photo was on the device the whole time.
 *
 *   `expo-file-system` reads through the platform's own file APIs, so the
 *   scheme is its problem rather than ours. It is not a new dependency: `expo`
 *   depends on it directly, so it is already linked into every build this app
 *   has ever produced.
 *
 *   XHR stays for the web, where the two things a browser hands back — a
 *   `blob:` URL from the camera element and a `data:` URL — are exactly what it
 *   is good at, and what the file system module has no view of.
 */
export async function readFileBytes(uri: string, contentTypeHint?: string): Promise<FileBytes> {
  const contentType = contentTypeHint || contentTypeFor(uri) || 'application/octet-stream';

  if (Platform.OS !== 'web') {
    try {
      const bytes = await new FileSystemFile(uri).arrayBuffer();

      if (bytes.byteLength === 0) {
        throw new Error('That file came back empty — try again.');
      }

      return { bytes, contentType };
    } catch (thrown) {
      /*
       * Fall through to XHR rather than failing here.
       *
       * This path is new, and the old one worked for most people for months.
       * If there is a URI shape the file system module refuses and the network
       * stack accepts, the person holding the phone should not be the one who
       * finds out — they get the old behaviour, and the message below carries
       * both failures.
       */
      return readFileBytesOverXhr(uri, contentType).catch(() => {
        /*
         * `errorMessage`, not `thrown instanceof Error ? …`.
         *
         * The rejection here comes from a native module and may well be a plain
         * object; the ternary would turn its message into the fallback and
         * throw away the only description of what went wrong. `verify-admin`
         * refuses that shape anywhere in `src` for exactly this reason.
         */
        const reason = errorMessage(thrown, 'Could not read that file off this device.');
        throw new Error(`${reason} (${schemeOf(uri)} URI, ${Platform.OS}, ${buildLabel()})`);
      });
    }
  }

  return readFileBytesOnWeb(uri, contentType);
}

/**
 * The web read, in order of how much can go wrong.
 *
 * ⚠ Four ways, and the order is the whole point.
 *
 *   1. **The `Blob` the picker gave us.** No URL, no document, no network. The
 *      only one of these that cannot be defeated by a revoked or discarded
 *      object URL, which is the bug this ladder was built for.
 *   2. **A `data:` URI, decoded here.** That is what the browser camera
 *      produces — `canvas.toDataURL` in `webcam-capture.tsx` — and it is
 *      already the bytes. Handing a multi-megabyte string to a network client
 *      to parse is work for nothing, and on a phone it is work for nothing
 *      twice: the string is copied again to do it.
 *   3. **`fetch`.** The browser's own loader, and the one that is specified to
 *      understand `blob:`.
 *   4. **`XMLHttpRequest`.** What this file did for a year, kept because it
 *      works everywhere it ever worked.
 *
 *   The error carries every attempt, so the next report of this says which
 *   rungs were tried rather than only that the bottom one failed.
 */
async function readFileBytesOnWeb(uri: string, contentType: string): Promise<FileBytes> {
  const picked = PICKED_BLOBS.get(uri);
  if (picked) {
    const bytes = await picked.arrayBuffer();
    if (bytes.byteLength > 0) {
      /* Spent. Holding it after the upload is holding a face for no reason. */
      PICKED_BLOBS.delete(uri);
      return { bytes, contentType: picked.type || contentType };
    }
    PICKED_BLOBS.delete(uri);
  }

  if (uri.startsWith('data:')) {
    const bytes = bytesFromDataUri(uri);
    if (bytes && bytes.byteLength > 0) return { bytes, contentType };
  }

  const tried: string[] = [];

  if (typeof fetch === 'function') {
    try {
      const response = await fetch(uri);
      if (!response.ok) throw new Error(`status ${response.status}`);

      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error('empty');

      return { bytes, contentType };
    } catch (thrown) {
      tried.push(`fetch: ${errorMessage(thrown, 'failed')}`);
    }
  }

  try {
    return await readFileBytesOverXhr(uri, contentType);
  } catch (thrown) {
    tried.push(`xhr: ${errorMessage(thrown, 'failed')}`);
  }

  throw new Error(
    `Could not read that photo from this browser. Take it again. ` +
      `(${schemeOf(uri)} URI, web, ${buildLabel()}; ${tried.join('; ')})`,
  );
}

function readFileBytesOverXhr(uri: string, contentType: string): Promise<FileBytes> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.onload = () => {
      const bytes = request.response as ArrayBuffer | null;

      if (!bytes || bytes.byteLength === 0) {
        reject(new Error('That file came back empty — try again.'));
        return;
      }

      /*
       * The name decides the content type, never the response header.
       *
       * A `file://` read has no useful header, and the one RN invents is what
       * got a perfectly good JPEG rejected as text/plain. The caller has
       * already resolved it from the file name before we get here.
       */
      resolve({ bytes, contentType });
    };

    /*
      ⚠ Factual, and deliberately not addressed to anybody.

        This used to read "Could not read that file off this device", which is
        what a sender saw for a photograph that was in memory the whole time —
        and it sent them hunting through their gallery for a file that was never
        lost. Both callers wrap this: the native path prefers the file system's
        own error, and the web path lists it beside the other attempts under a
        sentence that does say what to do.
    */
    request.onerror = () =>
      reject(new Error(`the browser could not open that ${schemeOf(uri)} URL`));
    request.onabort = () => reject(new Error('Reading the file was interrupted.'));
    request.ontimeout = () => reject(new Error('Reading the file timed out.'));

    try {
      request.open('GET', uri, true);
      request.responseType = 'arraybuffer';
      request.send();
    } catch (thrown) {
      reject(thrown instanceof Error ? thrown : new Error('Could not open that file.'));
    }
  });
}
