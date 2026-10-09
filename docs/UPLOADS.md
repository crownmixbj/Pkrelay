# Reading a photo, on three platforms

Every upload in this app goes through `readFileBytes` in `src/lib/upload.ts`.
That is deliberate: the same bug was written three times before it was written
once, and it has now been fixed three times in that one place. This file is the
record of what each fix was for, so the fourth version is not an accident.

## What a "uri" is, per platform

| platform | what the picker returns | what can read it |
|---|---|---|
| iOS / Android | `file://` or `content://` | the platform file APIs — `expo-file-system` |
| web | `blob:` from a picker, `data:` from the camera canvas | the `File` itself, or the browser's loader |

The word `uri` makes these look interchangeable. They are not, and every bug
below is a consequence of treating them as if they were.

## Three bugs, in order

### 1. `fetch(uri).blob()` — the original

Two failure modes on a real Android phone: `Response.prototype.blob` is
sometimes undefined (React Native's fetch is `whatwg-fetch`, which only defines
it when `Blob` and `FileReader` are globals at load time), and when it does
work, `blob.type` for a `file://` read is regularly `text/plain` — which gets a
perfectly good JPEG rejected by a bucket that allows images.

Replaced with `XMLHttpRequest` + `responseType = 'arraybuffer'`, and the content
type taken from the file *name*, which is the thing that actually knows.

### 2. XHR alone — a network client asked to open a local path

A driver taking their selfie got *"Could not read that file off this device."*
XHR on Android is backed by OkHttp, which speaks http and https; whether a
`file://` read works depends on which request handlers happen to be registered,
and `content://` — what the storage framework hands back — it cannot open at
all. The photo was on the device the whole time.

Fixed by reading through `expo-file-system` on native, with XHR kept as a
fallback.

### 3. The blob URL — a handle mistaken for a file

A sender on a **mobile browser** got:

```
Could not read that file off this device. (blob URI, web, local · 1.0.0 (—))
```

…for a photograph that was in memory the whole time.

`expo-image-picker` and `expo-document-picker` both return, on the web:

```ts
{ uri: URL.createObjectURL(file), file }   // ← two things, one of them reliable
```

A `blob:` URL is a **handle** into the document that created it. It dies with
that document, it dies the moment anything revokes it, and on a phone the
browser may drop the backing store under memory pressure while the page is
still alive. We were keeping the handle and throwing away the `File`.

## The fix

`rememberPickedFile(asset)` keeps the `File` behind the uri and returns the uri
unchanged, so a call site grows by one word:

```ts
setUri(rememberPickedFile(result.assets[0]));
```

`readFileBytes` then reads on the web in this order:

1. **the `Blob` the picker gave us** — no URL, no document, no network. The only
   rung a revoked or discarded object URL cannot defeat.
2. **a `data:` URI, decoded in place** — that is what `canvas.toDataURL` in
   `webcam-capture.tsx` produces, and it is already the bytes. Handing a
   multi-megabyte string to a network client to parse is work for nothing, and
   on a phone it is work for nothing twice, because the string is copied again
   to do it.
3. **`fetch`** — the browser's own loader, and the one specified to understand
   `blob:`.
4. **`XMLHttpRequest`** — what this file did for a year, kept because it works
   everywhere it ever worked.

The registry holds at most eight files and drops the oldest, and an entry is
released the moment it is read: holding a face in memory after it has been
uploaded is holding a face for no reason.

⚠ **The error message changed too.** *"Could not read that file off this
device"* sent a sender hunting through their gallery for a photo that was never
lost. A failed web read now says *"Could not read that photo from this browser.
Take it again."* and lists every rung it tried, so the next report says which
attempts failed rather than only that the last one did.

⚠ **`fileSizeOf` now answers on the web.** It returned null, so the size cap
simply did not exist in a browser: an over-size photo was accepted at the picker
and refused at submit, thirty fields later.

## What stops a fourth version

- `verify:web-upload` runs the real module against a fake browser: a remembered
  file read while **both** fetch and XHR are broken (the reported bug), a
  `data:` URI decoded with no network call, fetch-then-XHR fallback, the bounded
  registry, and the failure message. It executes rather than greps, because none
  of this was visible in the source.
- `verify:uploads` sweeps `src/` and fails if any file that opens a picker does
  not call `rememberPickedFile`, and checks the four rungs are still in that
  order inside `readFileBytesOnWeb`.

Both were confirmed by breaking the fix and watching the build go red.

## Call sites

Everything that opens a picker:

```
src/components/ui/sender-photo-sheet.tsx     the live selfie
src/components/ui/photo-picker.tsx           parcel photos
src/components/ui/guarantor-upload-card.tsx  guarantor ID and live photo
src/app/capture/[id].tsx                     the phone handoff capture page
src/app/(tabs)/driver-signup.tsx             licence, insurance, and the camera
```

`webcam-capture.tsx` is not in that list: it produces a `data:` URI from a
canvas and never goes near a picker.
