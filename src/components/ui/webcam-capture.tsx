import { useEffect, useRef, useState } from 'react';
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
 * unsupported state and the component that uses it renders nothing.
 */

export type WebcamState = {
  supported: boolean;
  streaming: boolean;
  error: string | null;
  /** Attach to a `<video>` element. Null on native. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
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

  const start = async () => {
    if (!supported) {
      setError(`This browser cannot open a camera.${fallback}`);
      return;
    }

    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // `user` is the front camera on a laptop and on a phone browser.
        video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStreaming(true);
    } catch (thrown) {
      /*
       * The distinction matters: a refusal is something the sender can undo in
       * their browser settings, and "camera unavailable" is not.
       */
      const name = thrown instanceof Error ? thrown.name : '';
      setError(
        name === 'NotAllowedError'
          ? `Camera access was blocked. Allow it in your browser settings and try again.${fallback}`
          : `No camera was available.${fallback}`,
      );
      setStreaming(false);
    }
  };

  const capture = (): string | null => {
    const video = videoRef.current;
    if (!video || !streaming) return null;

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

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
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, width, height);

    return canvas.toDataURL('image/jpeg', 0.7);
  };

  return { supported, streaming, error, videoRef, start, stop, capture };
}
