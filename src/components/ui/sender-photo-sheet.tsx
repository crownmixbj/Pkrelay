import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Camera, Check, Info, RefreshCw, Smartphone } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { QrCode } from '@/components/ui/qr-code';
import { useWebcam } from '@/components/ui/webcam-capture';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { captureInstruction, captureLink } from '@/constants/links';
import {
  livenessBlocks,
  livenessLabel,
  runLivenessCheck,
  startCaptureSession,
  uploadCapturePhoto,
  watchCaptureSession,
  type LivenessOutcome,
} from '@/store/capture-session';

/**
 * The photo every parcel carries, and the two ways of taking it.
 *
 * ⚠ This is a photograph, not a face check. Nothing compares it to an ID, to a
 *   previous photo, or to a liveness signal — a printed picture held to the lens
 *   passes. Saying otherwise to a sender would be a false claim, and a worse one
 *   to anyone relying on it in a dispute. What it buys is deterrence and a
 *   record, which is worth having and is a different sentence.
 *
 * ⚠ LEGAL_REVIEW_REQUIRED — the photo is now required, not optional, so consent
 *   is no longer the lawful basis it rests on. The NDPA says consent is not
 *   "freely given" where a service is conditional on it. The copy below states a
 *   legitimate interest instead (driver safety, prohibited items), which is a
 *   position that has to be documented and reviewed rather than asserted in a
 *   component. See `docs/PRIVACY-NOTES.md`.
 *
 * Two capture paths, because the platforms differ in what they can do:
 *
 *   native  the camera, directly. One tap.
 *   web     a QR code that hands the job to the phone, because a laptop is not
 *           where anyone wants to take a photo of their face — with the
 *           browser's own camera underneath for senders without the app, who
 *           would otherwise be unable to post a parcel at all.
 */
/**
 * Who is being photographed, and why.
 *
 * The mechanism is identical — session, QR handoff, webcam fallback, liveness —
 * but the reason differs, and copy written for a parcel sender read as nonsense
 * on a driver application. One component with two strings beats two components
 * that drift.
 */
export type PhotoPurpose = 'sender' | 'driver';

const PURPOSE_COPY: Record<PhotoPurpose, { title: string; body: string; why: string }> = {
  sender: {
    title: 'Photo of you, before you post',
    body: 'Every Package Relay parcel carries a photo of the person who sent it. It is stored privately, visible only to you and to Package Relay staff — never to the driver.',
    /*
      ⚠ This used to end "It is a photo record, not an identity check — Package Relay
        does not match your face against any document or database."

        True when it was written, and false now: the sender photo is compared
        with the photo on the NIN record, exactly as the driver's is. Leaving
        the old sentence in place would have been the most misleading kind of
        privacy copy — a specific, reassuring denial of the thing being done.
    */
    why: 'Drivers carry parcels from strangers. A record of who posted each one protects them and deters prohibited items. Your photo is also compared with the one on your NIN record.',
  },
  driver: {
    title: 'Photo of you, to finish your application',
    body: 'Package Relay checks this against the photo held on your NIN record. It is stored privately and seen only by you and Package Relay staff.',
    /*
      The driver copy says the opposite of the sender copy, and has to.
      This one *is* an identity check, and telling a driver it is not would be
      false — they are handing over a face to be matched against a government
      record.
    */
    why: 'This is an identity check: your selfie is compared with the photo on your NIN record. If it does not match, your application is still reviewed by a person — NIN photos can be years old.',
  },
};

export function SenderPhotoSheet({
  visible,
  onCancel,
  onDone,
  busy,
  purpose = 'sender',
  confirmLabel = 'Use this photo',
}: {
  visible: boolean;
  onCancel: () => void;
  purpose?: PhotoPurpose;
  /**
   * What pressing the accept button does, in the caller's words.
   *
   * ⚠ This was hard-coded to "Post parcel", and the driver application used
   *   the same sheet — so an applicant finishing a job application was asked to
   *   press a button offering to post a parcel. A label that describes an
   *   action the caller is not taking is worse than a vague one.
   */
  confirmLabel?: string;
  /**
   * Either a local image uri (native, or the browser camera) or a completed
   * capture session id (the phone took it). Never null — the photo is required.
   */
  onDone: (result: { uri: string } | { sessionId: string }) => void;
  busy?: boolean;
}) {
  const theme = useTheme();
  const isWeb = Platform.OS === 'web';

  const [uri, setUri] = useState('');
  const [error, setError] = useState('');

  // Web only: the handoff session, and whether the phone has finished with it.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const [liveness, setLiveness] = useState<LivenessOutcome | null>(null);
  const [webcamOpen, setWebcamOpen] = useState(false);

  const webcam = useWebcam();
  const stopWatching = useRef<(() => void) | null>(null);

  /*
   * A session per opening of this sheet.
   *
   * Reusing one across opens would leave a live code behind every time the
   * sender backed out, and `start_capture_session` expires the account's other
   * open sessions precisely so that does not happen.
   */
  useEffect(() => {
    if (!visible || !isWeb) return;

    let cancelled = false;

    void startCaptureSession()
      .then((id) => {
        if (cancelled) return;
        setSessionId(id);
        stopWatching.current = watchCaptureSession(id, () => {
          setHandedOff(true);
          /*
            Read back the verdict the phone already recorded.

            The server returns the stored result rather than re-running the
            check, so this costs nothing and cannot disagree with what the
            sender was told on the phone.
          */
          void runLivenessCheck(id).then(setLiveness);
        });
      })
      .catch(() => {
        if (!cancelled) setError('Could not start the photo step. Check your connection.');
      });

    return () => {
      cancelled = true;
      stopWatching.current?.();
      stopWatching.current = null;
    };
  }, [visible, isWeb]);

  // Reset when the sheet closes, so reopening does not show a stale photo.
  useEffect(() => {
    if (visible) return;
    setUri('');
    setError('');
    setSessionId(null);
    setHandedOff(false);
    setWebcamOpen(false);
    webcam.stop();
    // `webcam` is a fresh object each render; only `visible` should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const captureNative = async () => {
    setError('');

    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError(
        'Package Relay needs the camera to take this photo. Allow camera access in your settings to post a parcel.',
      );
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      cameraType: ImagePicker.CameraType.front,
      allowsEditing: false,
      quality: 0.6,
    });

    if (result.canceled || !result.assets[0]) return;
    setUri(result.assets[0].uri);
  };

  const captureWebcam = () => {
    const shot = webcam.capture();
    if (!shot) {
      setError('The camera did not return a frame. Try again.');
      return;
    }
    setUri(shot);
    webcam.stop();
    setWebcamOpen(false);
  };

  return (
    <BottomSheet visible={visible} onClose={onCancel}>
      {/* A View, not a ScrollView — BottomSheet already scrolls. */}
      <View style={styles.sheet}>
        <Text style={[styles.title, { color: theme.text }]}>{PURPOSE_COPY[purpose].title}</Text>

        <Text style={[styles.body, { color: theme.textSecondary }]}>
          {PURPOSE_COPY[purpose].body}
        </Text>

        {/*
          Why it is required, in the sender's terms.

          "Security" on its own explains nothing and reads as boilerplate. The
          two concrete reasons are the ones that would be given to a regulator,
          so they are the ones given here.
        */}
        <View style={[styles.notice, { backgroundColor: theme.primarySoft }]}>
          <Info color={theme.primaryOnSoft} size={16} />
          <View style={styles.noticeText}>
            <Text style={[styles.noticeTitle, { color: theme.primaryOnSoft }]}>
              {purpose === 'driver' ? 'Required to apply' : 'Required to post a parcel'}
            </Text>
            <Text style={[styles.noticeBody, { color: theme.primaryOnSoft }]}>
              {PURPOSE_COPY[purpose].why}
            </Text>
          </View>
        </View>

        {/* ---------- what has been captured, if anything ---------- */}
        {handedOff ? (
          <View style={[styles.done, { backgroundColor: theme.successSoft }]}>
            <Check color={theme.successOnSoft} size={18} />
            <View style={styles.doneBody}>
              <Text style={[styles.doneText, { color: theme.successOnSoft }]}>
                Photo received from your phone.
              </Text>
              {liveness && (
                <Text style={[styles.doneNote, { color: theme.successOnSoft }]}>
                  {livenessLabel(liveness)}
                </Text>
              )}
            </View>
          </View>
        ) : uri ? (
          <Image source={{ uri }} style={styles.preview} contentFit="cover" />
        ) : webcamOpen && isWeb ? (
          /*
            A raw <video> element, only reachable on web.
            react-native-web renders unknown intrinsics straight through.
          */
          <video
            ref={webcam.videoRef}
            playsInline
            muted
            style={{
              width: '100%',
              maxHeight: 260,
              borderRadius: 12,
              objectFit: 'cover',
              // Mirrored preview only — `capture()` un-flips before saving.
              transform: 'scaleX(-1)',
              background: '#E2E8F0',
            }}
          />
        ) : isWeb ? (
          <WebHandoff sessionId={sessionId} />
        ) : (
          <View style={[styles.placeholder, { backgroundColor: theme.surfaceMuted }]}>
            <Camera color={theme.textMuted} size={28} />
          </View>
        )}

        {(error.length > 0 || webcam.error) && (
          <Text style={[styles.error, { color: theme.danger }]}>{error || webcam.error}</Text>
        )}

        {/* ---------- the controls ---------- */}
        {handedOff ? (
          <Button
            label={busy ? 'Checking…' : confirmLabel}
            onPress={() => sessionId && onDone({ sessionId })}
            disabled={busy || !sessionId}
          />
        ) : uri ? (
          <>
            <Button
              label={busy ? 'Checking…' : confirmLabel}
              onPress={() => onDone({ uri })}
              disabled={busy}
            />
            <Button
              label="Retake"
              variant="secondary"
              icon={(color, size) => <RefreshCw color={color} size={size} />}
              onPress={() => {
                setUri('');
                if (isWeb) {
                  setWebcamOpen(true);
                  void webcam.start();
                } else {
                  void captureNative();
                }
              }}
              disabled={busy}
            />
          </>
        ) : isWeb ? (
          webcamOpen ? (
            <>
              <Button
                label="Take photo"
                icon={(color, size) => <Camera color={color} size={size} />}
                onPress={captureWebcam}
                disabled={!webcam.streaming}
              />
              <Button
                label="Back to the QR code"
                variant="secondary"
                onPress={() => {
                  webcam.stop();
                  setWebcamOpen(false);
                }}
              />
            </>
          ) : (
            /*
              The fallback, present but quieter than the QR above it.

              The phone is the intended route: it has the better camera, and it
              keeps face images off shared desktops. But a first-time sender on
              a laptop has no Package Relay account habit and no reason to have installed
              anything — and with the photo required, no fallback means no
              parcel at all. So it stays, as a link rather than a button, which
              is the difference between an alternative and an equal option.
            */
            <Pressable
              onPress={() => {
                setWebcamOpen(true);
                void webcam.start();
              }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.fallback, pressed && styles.pressed]}>
              <Camera color={theme.textMuted} size={14} />
              <Text style={[styles.fallbackText, { color: theme.textMuted }]}>
                Don&apos;t have the app? Use this computer&apos;s camera instead
              </Text>
            </Pressable>
          )
        ) : (
          <Button
            label="Take photo"
            icon={(color, size) => <Camera color={color} size={size} />}
            onPress={captureNative}
            disabled={busy}
          />
        )}

        {/*
          Backing out abandons the parcel; it does not post it without a photo.
          Worded so nobody presses it expecting the second thing.
        */}
        <Button label="Back to the form" variant="secondary" onPress={onCancel} disabled={busy} />
      </View>
    </BottomSheet>
  );
}

/** The QR code and its instructions. Web only. */
function WebHandoff({ sessionId }: { sessionId: string | null }) {
  const theme = useTheme();

  if (!sessionId) {
    return (
      <View style={[styles.placeholder, { backgroundColor: theme.surfaceMuted }]}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  /*
   * The instruction comes from `captureInstruction`, not from this file.
   *
   * What the code can do depends on whether it encodes an https universal link
   * or the app's private scheme, and only the configuration knows which. Text
   * written here would have gone on saying "point your phone camera at it"
   * after that stopped being true — which it was, until the link type became
   * configurable.
   */
  const instruction = captureInstruction();

  return (
    <View style={styles.handoff}>
      <View style={[styles.qrFrame, { borderColor: theme.border }]}>
        <QrCode value={captureLink(sessionId)} size={196} color={theme.text} />
      </View>

      <View style={styles.handoffText}>
        <View style={styles.handoffRow}>
          <Smartphone color={theme.primary} size={16} />
          <Text style={[styles.handoffTitle, { color: theme.text }]}>{instruction.title}</Text>
        </View>
        <Text style={[styles.handoffBody, { color: theme.textSecondary }]}>{instruction.body}</Text>
        <Text style={[styles.handoffBody, { color: theme.textSecondary }]}>
          Once you have taken it, this page continues on its own — you do not need to come back and
          press anything.
        </Text>
        <Text style={[styles.handoffBody, { color: theme.textMuted }]}>
          The code works for ten minutes, on your account only.
        </Text>
      </View>
    </View>
  );
}

/**
 * Uploads whatever the sheet produced, against a session.
 *
 * Exported so the booking form does not need to know which of the two paths
 * produced the photo — a browser-camera data URL and a phone-captured session
 * both end up as one consumable session id.
 */
export async function resolveSenderPhoto(
  result: { uri: string } | { sessionId: string },
  startSession: () => Promise<string> = startCaptureSession,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  /*
   * A photo taken on the phone has already been checked there — see
   * `app/capture/[id].tsx`, which refuses to hand one back that failed. Running
   * the check again would be a second charge for the same image, and the server
   * refuses a repeat anyway.
   */
  if ('sessionId' in result) return { ok: true, sessionId: result.sessionId };

  const sessionId = await startSession();
  const stored = await uploadCapturePhoto(sessionId, result.uri);
  if (!stored.ok) return { ok: false, error: stored.error };

  /*
   * The browser-camera path checks here, because there is no phone screen to
   * check on. Same rule either way: a clear failure stops the parcel, an
   * unavailable provider does not.
   */
  const outcome = await runLivenessCheck(sessionId);
  if (livenessBlocks(outcome)) return { ok: false, error: outcome.message };

  return { ok: true, sessionId };
}

const styles = StyleSheet.create({
  sheet: {
    gap: Spacing.three,
  },
  title: {
    ...Typography.sectionTitle,
  },
  body: {
    ...Typography.meta,
    lineHeight: 20,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
  },
  noticeText: {
    flex: 1,
    gap: Spacing.half,
  },
  noticeTitle: {
    ...Typography.caption,
    ...font(700),
  },
  noticeBody: {
    ...Typography.caption,
    lineHeight: 18,
  },
  preview: {
    width: '100%',
    aspectRatio: 3 / 4,
    maxHeight: 260,
    borderRadius: Radius.md,
    backgroundColor: '#E2E8F0',
  },
  placeholder: {
    width: '100%',
    height: 140,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handoff: {
    gap: Spacing.three,
    alignItems: 'center',
  },
  qrFrame: {
    padding: Spacing.two + 2,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#FFFFFF',
  },
  handoffText: {
    gap: Spacing.two,
    width: '100%',
  },
  handoffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  handoffTitle: {
    ...Typography.meta,
    ...font(700),
    flex: 1,
  },
  handoffBody: {
    ...Typography.caption,
    lineHeight: 18,
  },
  done: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
  },
  doneBody: {
    flex: 1,
    gap: Spacing.half,
  },
  doneText: {
    ...Typography.meta,
    ...font(600),
  },
  doneNote: {
    ...Typography.caption,
    lineHeight: 17,
  },
  error: {
    ...Typography.caption,
    lineHeight: 18,
  },
  fallback: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    // 44px of target for a 14px label — the control is quiet, not small.
    paddingVertical: Spacing.three - 4,
  },
  fallbackText: {
    ...Typography.caption,
    textDecorationLine: 'underline',
  },
  pressed: {
    opacity: 0.6,
  },
});
