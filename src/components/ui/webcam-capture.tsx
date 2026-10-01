import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

/**
 * A selfie from a browser's own camera.
 *
 * The fallback for a sender on the web dashboard who does not have the Package Relay app
 * — without it, making the photo mandatory would mean anyone without the app
 * simply cannot post a parcel from a computer.
 *
 * Uses `getUserMedia` and a canvas directly rather than a library. This file is
 * the only place in the app that touches DOM APIs, and it is guarded on
 * `Platform.OS === 'web'` throughout: on native the hook returns a permanently
 * unsupported state and `WebcamPreview` renders nothing.
 */

/**
 * The shape the preview is framed to, as width ÷ height.
 *
 * ⚠ Portrait, and this is a requirement rather than a preference.
 *
 *   This photo is fed to a face-and-liveness check (`verify-liveness`, see
 *   docs/DOJAH.md) whose `failed` verdict — which blocks the parcel — includes
 *   "no face". A wide box clips the crown and the chin, and a strip of cheek is
 *   not a face: the sender frames themselves perfectly, the check sees nothing,
 *   and the refusal is the app's fault rather than theirs. It is also compared
 *   against the portrait on their NIN record, which is the same shape.
 *
 * ⚠ One constant, because three things have to agree: the preview box, the
 *   captured file and the `<Image>` that replaces the preview once a photo
 *   exists. When they disagreed the page jumped on capture and the file was
 *   framed differently from the picture the person had just approved.
 */
export const PREVIEW_ASPECT = 3 / 4;

/**
 * The tallest the preview box gets, matching the captured-photo preview beside
 * it. Tall enough that a head and shoulders is a head and shoulders rather than
 * a thumbnail — the check scores what it can see.
 */
export const PREVIEW_MAX_HEIGHT = 320;

/**
 * ⚠ The width the box is allowed, and the whole reason it stays portrait.
 *
 *   `width: 100%` with `aspect-ratio` *and* a max height does not give a
 *   portrait box: on a wide sheet the max height wins, the width stays at 100%,
 *   and the result is a letterbox — 1000×185 on a desktop, which is what
 *   reached a real sender and clipped their face top and bottom. Capping the
 *   width at exactly `height × aspect` is what makes the ratio hold at every
 *   width, and `margin: 0 auto` keeps it in the middle of the sheet.
 */
export const PREVIEW_MAX_WIDTH = Math.round(PREVIEW_MAX_HEIGHT * PREVIEW_ASPECT);

export type WebcamState = {
  supported: boolean;
  /** True only once the element has a frame — see the note on `bind`. */
  streaming: boolean;
  error: string | null;
  /**
   * Hand to the `<video>` as its `ref`.
   *
   * ⚠ A callback, not a `RefObject`, and that is the whole fix for the black
   *   preview.
   *
   *   Both callers mount the `<video>` only once their own state says the
   *   camera is open — `setWebcamOpen(true); void start()` — so whether the
   *   element exists by the time `getUserMedia` resolves is a race between a
   *   React commit and a permission prompt. It is usually won (the prompt is
   *   slow) and lost exactly when the permission is already granted, which is
   *   every visit after the first. A `RefObject` gives no way to notice the
   *   element arriving late; a callback ref is called the moment it mounts, so
   *   the stream is attached whichever order the two land in.
   */
  attachVideo: (element: HTMLVideoElement | null) => void;
  start: () => Promise<void>;
  stop: () => void;
  /** Grabs a frame as a data URL, or null if there is nothing to grab. */
  capture: () => string | null;
};

/**
 * ⚠ The remedy sentence belongs to the caller, because there are two callers
 *   and only one of them has a QR code.
 *
 *   Every message here ended "Use the QR code instead." That was written for the
 *   sender photo sheet, which renders one. The guarantor portal uses this same
 *   hook and has no QR handoff at all — it cannot have one, because a capture
 *   session is bound to an account and a guarantor has none. So a guarantor who
 *   blocked their camera was told to use a thing that does not exist on the page
 *   they are looking at, and had nothing to do next.
 */
export function useWebcam(options: { fallback?: string } = {}): WebcamState {
  /* Appended to each message, so no sentence here names a control it cannot see. */
  const fallback = options.fallback ? ` ${options.fallback}` : '';

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported =
    Platform.OS === 'web' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function';

  const stop = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    /*
     * Cleared, not just stopped. A `<video>` holding a dead stream keeps its
     * last frame on screen, so reopening the camera showed a frozen face for
     * the moment before the new stream arrived.
     */
    if (videoRef.current) videoRef.current.srcObject = null;

    setStreaming(false);
  };

  /*
   * A camera left running is a camera light left on.
   *
   * Without this the stream survives the sheet closing, and the browser keeps
   * showing the recording indicator on a page that is no longer asking for a
   * photo — which reasonably reads as the site spying on you.
   */
  useEffect(() => stop, []);

  /**
   * Point an element at the live stream and wait for it to have a picture.
   *
   * ⚠ `streaming` flips here rather than when `getUserMedia` resolves.
   *
   *   It used to be set as soon as the promise came back, which enabled "Take
   *   photo" while the element still had no frame: `capture()` read
   *   `videoWidth === 0`, returned null, and the button did nothing. Waiting
   *   for `loadedmetadata` means the control is live exactly when there is
   *   something to photograph.
   */
  const bind = useCallback((element: HTMLVideoElement, stream: MediaStream) => {
    if (element.srcObject !== stream) element.srcObject = stream;

    const ready = () => {
      if (element.videoWidth > 0) setStreaming(true);
    };

    element.addEventListener('loadedmetadata', ready);
    /* Already loaded: a stream re-attached to a warm element fires nothing. */
    ready();

    /*
     * ⚠ A rejected `play()` is not a camera failure.
     *
     *   It rejects with AbortError when the element is unmounted mid-load — the
     *   sheet being closed while the camera opens — and that used to land in
     *   the same catch as `getUserMedia`, so closing the sheet reported "No
     *   camera was available" on a machine whose camera was fine. `autoPlay` on
     *   the element does the real work; this is the belt to its braces.
     */
    void element.play().catch(() => {});
  }, []);

  const attachVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      videoRef.current = element;
      if (element && streamRef.current) bind(element, streamRef.current);
    },
    [bind],
  );

  const start = async () => {
    if (!supported) {
      /*
       * ⚠ Two reasons a browser has no `getUserMedia`, and only one is the
       *   browser's fault.
       *
       *   The other is the page not being on https — which is every LAN test of
       *   a dev build, `http://192.168.x.x:8081`. "This browser cannot open a
       *   camera" sent people looking at Chrome's settings for a problem that
       *   was in the address bar.
       */
      const insecure =
        Platform.OS === 'web' &&
        typeof window !== 'undefined' &&
        window.isSecureContext === false;

      setError(
        insecure
          ? `A camera needs a secure connection — open this page over https.${fallback}`
          : `This browser cannot open a camera.${fallback}`,
      );
      return;
    }

    setError(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        /*
         * ⚠ Asked for landscape, framed as portrait in CSS.
         *
         *   This asked for 720×960 — the 3:4 shape the preview draws. A phone
         *   camera can do that; a laptop webcam is a landscape sensor, and
         *   browsers satisfy an impossible portrait "ideal" by cropping the
         *   middle out of it. The result was the reported complaint: a preview
         *   zoomed so far in that the sender's head filled the frame, and no
         *   way to back off.
         *
         *   So the request is now the shape webcams actually are, and the
         *   portrait framing is done where it belongs — the preview box crops
         *   it with `object-fit: cover`, and `capture()` crops the same box out
         *   of the frame, so the file matches the picture that was approved.
         */
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch (thrown) {
      /*
       * The distinction matters: a refusal is something the sender can undo in
       * their browser settings, and "camera unavailable" is not.
       */
      const name = thrown instanceof Error ? thrown.name : '';
      setError(
        name === 'NotAllowedError'
          ? `Camera access was blocked. Allow it in your browser settings and try again.${fallback}`
          : name === 'NotReadableError'
            ? `Another app is using the camera. Close it and try again.${fallback}`
            : `No camera was available.${fallback}`,
      );
      setStreaming(false);
      return;
    }

    streamRef.current = stream;

    /*
     * ⚠ The camera can stop without us stopping it.
     *
     *   A laptop lid closing, a USB webcam unplugged, or another app taking the
     *   device ends the track. The element then holds a frozen frame while
     *   `streaming` still says yes, so "Take photo" stays lit over a picture
     *   that is seconds or minutes old.
     */
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        setError(`The camera stopped. Reconnect it and try again.${fallback}`);
        stop();
      });
    });

    /* Mounted already? Attach now. Mounted later? `attachVideo` does it. */
    if (videoRef.current) bind(videoRef.current, stream);
  };

  const capture = (): string | null => {
    const video = videoRef.current;
    if (!video || !streaming) return null;

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    /*
     * The same centre crop the preview box makes, so the file is the picture
     * they were looking at rather than the whole sensor behind it.
     *
     * ⚠ Measured from the element rather than assumed to be `PREVIEW_ASPECT`.
     *
     *   The box is `width: 100%` with `aspect-ratio` *and* a max height, and on
     *   a wide sheet the max height wins: the portrait ratio is what the box
     *   asks for, 418×260 is what it gets. Cropping to the constant would then
     *   save a portrait the sender never saw — the same what-you-see-isn't-what-
     *   you-get this crop exists to remove. The constant stays as the fallback
     *   for the frame before layout, where `clientWidth` is 0.
     */
    const framed =
      video.clientWidth > 0 && video.clientHeight > 0
        ? video.clientWidth / video.clientHeight
        : PREVIEW_ASPECT;

    const cropWidth = Math.min(width, height * framed);
    const cropHeight = Math.min(height, width / framed);
    const cropX = (width - cropWidth) / 2;
    const cropY = (height - cropHeight) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cropWidth);
    canvas.height = Math.round(cropHeight);

    const context = canvas.getContext('2d');
    if (!context) return null;

    /*
     * Un-mirror before writing the file.
     *
     * The preview is flipped because an unmirrored preview is disorienting to
     * look at, but the *stored* photo must not be — a mirrored face is subtly
     * wrong to anyone comparing it to a person later, which is the only reason
     * this photo exists.
     */
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(
      video,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    /*
     * 0.8 rather than 0.7: the file is scored by a face check and compared with
     * a NIN portrait, and JPEG artefacts around the eyes and mouth are exactly
     * what a liveness score is sensitive to. A 3:4 crop of a 720p frame at this
     * quality is still well under 100KB.
     */
    return canvas.toDataURL('image/jpeg', 0.8);
  };

  return { supported, streaming, error, attachVideo, start, stop, capture };
}

/**
 * The live preview, framed.
 *
 * ⚠ One component because there were two copies of this markup, and both were
 *   wrong in the same way.
 *
 *   The `<video>` carried `width: 100%`, `maxHeight: 260` and `object-fit:
 *   cover` with no height and no box. Until the stream's metadata arrives a
 *   `<video>` has no intrinsic size, so CSS gives it the 300×150 default: the
 *   page rendered a squat grey letterbox, then jumped to a different shape the
 *   moment the camera warmed up — and `object-fit` had no box to fit, so it did
 *   nothing until then. The wrapper below owns the shape from the first frame
 *   to the last, and matches the captured-photo preview it is swapped for, so
 *   nothing on the page moves when the picture is taken.
 *
 * Renders nothing on native, where none of these elements exist.
 */
export function WebcamPreview({ webcam }: { webcam: WebcamState }) {
  if (Platform.OS !== 'web') return null;

  return (
    <div
      style={{
        width: '100%',
        /* Portrait at every width — see the note on PREVIEW_MAX_WIDTH. */
        maxWidth: PREVIEW_MAX_WIDTH,
        margin: '0 auto',
        aspectRatio: `${PREVIEW_ASPECT}`,
        maxHeight: PREVIEW_MAX_HEIGHT,
        borderRadius: 12,
        /* The crop happens here, so the video never paints outside the corners. */
        overflow: 'hidden',
        background: '#E2E8F0',
      }}>
      <video
        ref={webcam.attachVideo}
        /* `autoPlay` starts the frames; `muted` is what lets autoplay run at
           all under browser policy; `playsInline` stops iOS Safari taking the
           preview fullscreen. All three are required, none is decoration. */
        autoPlay
        muted
        playsInline
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'center',
          /* Mirrored preview only — `capture()` un-flips before saving. */
          transform: 'scaleX(-1)',
        }}
      />
    </div>
  );
}
