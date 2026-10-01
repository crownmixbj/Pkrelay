import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Camera, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScreenHeader, screenPadding } from '@/components/ui/screen';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { StickyHeaderScreen } from '@/components/ui/sticky-header';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  livenessBlocks,
  livenessLabel,
  readCaptureSession,
  runLivenessCheck,
  uploadCapturePhoto,
  type LivenessOutcome,
} from '@/store/capture-session';
import { useSession } from '@/store/session';

/**
 * The screen a QR code opens.
 *
 * ⚠ Nothing on this screen names a parcel or an application, and that is not
 *   vagueness — it is the only accurate option available to it.
 *
 *   `photo_capture_sessions` carries an owner and an expiry and nothing else, so
 *   the phone genuinely cannot know which of the two flows opened the browser
 *   tab. It said "Photo for your parcel", "You started a parcel in a browser"
 *   and "finish posting your parcel" throughout — and the driver application
 *   uses this same handoff, so an applicant photographing their face for a job
 *   was told about a parcel they were not posting, on a screen sitting beside a
 *   browser tab headed "Photo of you, to finish your application".
 *
 *   The fix that names it properly is a `purpose` column on the session, set by
 *   whichever screen opened it. That is a migration, a change to
 *   `start_capture_session`, and a read here. Worth doing; not worth guessing in
 *   the meantime, because a wrong noun is worse than no noun.
 *
 * ⚠ And the privacy notice no longer denies the identity check.
 *
 *   It read "It is a photo record, not an identity check." `sender-photo-sheet`
 *   withdrew that exact sentence for being "the most misleading kind of privacy
 *   copy — a specific, reassuring denial of the thing being done": both photos
 *   are now compared against the photo on the person's NIN record. The
 *   withdrawal never reached this screen, so the phone went on telling a driver
 *   applicant their face was not being matched against a government record at
 *   the moment they photographed it for exactly that.
 *
 * Reached only by deep link — `parcelmobile://capture/<session id>` — from a
 * code shown on the web dashboard. It exists to do one thing: take the photo
 * the browser cannot, and hand it back.
 *
 * The sender never navigates here on purpose, so the screen has to explain
 * itself from a standing start: what it is for, what happens next, and where to
 * go afterwards.
 *
 * Every rule that matters is in `supabase/migrations/20250101000013_capture_sessions.sql`. This screen
 * reads the session only to give a useful message — an expired code is a
 * sentence here rather than a failed upload thirty seconds later.
 */
export default function CaptureScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { viewerId } = useSession();

  const [state, setState] = useState<'checking' | 'ready' | 'invalid' | 'done'>('checking');
  const [liveness, setLiveness] = useState<LivenessOutcome | null>(null);
  const [uri, setUri] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const sessionId = typeof id === 'string' ? id : '';

  /*
   * Check the code before opening a camera.
   *
   * A stale QR left open in a browser tab is the common case, not the rare one.
   * Asking for the camera and *then* failing the upload wastes a permission
   * prompt and leaves the sender with no idea which part went wrong.
   *
   * The select is scoped by RLS to sessions this account owns, so a code
   * belonging to someone else reads as "not found" — which is the right answer
   * and does not confirm that the id exists.
   */
  useEffect(() => {
    if (!viewerId || !sessionId) return;

    let cancelled = false;
    void readCaptureSession(sessionId).then((session) => {
      if (cancelled) return;

      if (!session || Date.parse(session.expiresAt) <= Date.now()) {
        setState('invalid');
        return;
      }
      setState(session.completedAt ? 'done' : 'ready');
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId, viewerId]);

  /*
   * The web branch is the universal link's fallback, not an error.
   *
   * An https capture link opens the app when it is installed and this page when
   * it is not — which is the whole reason the link is https rather than a
   * private scheme. Somebody landing here has scanned the code on a phone with
   * no Package Relay on it, and the useful thing to tell them is how to finish, not that
   * something went wrong.
   *
   * The browser cannot complete a session: `uploadCapturePhoto` would work, but
   * the point of the handoff is that the capture happens on the phone's own
   * camera through the app. Sending them back to the desktop tab is the honest
   * route, because the browser camera fallback lives there.
   */
  if (Platform.OS === 'web') {
    return (
      <StickyHeaderScreen>
        <ScrollView contentContainerStyle={screenPadding}>
          <ScreenHeader brand={false} title="Photo of you" />
          <Card style={styles.card}>
            <View style={styles.row}>
              <ShieldAlert color={theme.warningOnSoft} size={20} />
              <Text style={[styles.cardTitle, { color: theme.text }]}>
                Open this in the Package Relay app
              </Text>
            </View>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              You scanned the code on a phone that does not have Package Relay installed. Install it and scan
              again, or go back to the computer where you started — there is a link under the code
              to use that computer&apos;s camera instead.
            </Text>
            <Text style={[styles.body, { color: theme.textMuted }]}>
              Either way, what you were doing in the browser is still there. Nothing has been lost.
            </Text>
          </Card>
        </ScrollView>
      </StickyHeaderScreen>
    );
  }

  if (!viewerId) {
    return (
      <StickyHeaderScreen>
        <ScrollView contentContainerStyle={screenPadding}>
          <ScreenHeader brand={false} title="Photo of you" />
          <SignedOutState
            title="Sign in to continue"
            message="This code belongs to your account. Sign in on this phone with the same account you used in the browser."
            next={`/capture/${sessionId}`}
          />
        </ScrollView>
      </StickyHeaderScreen>
    );
  }

  const capture = async () => {
    setError('');

    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Package Relay needs the camera to take this photo. Allow camera access in your settings.');
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

  const send = async () => {
    setBusy(true);
    setError('');

    const stored = await uploadCapturePhoto(sessionId, uri);
    if (!stored.ok) {
      setBusy(false);
      setError(stored.error);
      return;
    }

    /*
     * The check runs here, on the phone, before the browser is told anything.
     *
     * Doing it after the handoff would leave the sender staring at a desktop
     * that had accepted a photo their phone was about to reject — and they
     * would have to walk back to the phone to retake it. The retake button is
     * already in front of them at this moment; that is the moment to use it.
     */
    const outcome = await runLivenessCheck(sessionId);
    setBusy(false);
    setLiveness(outcome);

    if (livenessBlocks(outcome)) {
      setError(outcome.message);
      // Clear the photo so the only way forward is a fresh capture.
      setUri('');
      return;
    }

    setState('done');
  };

  return (
    <StickyHeaderScreen>
      <ScrollView contentContainerStyle={screenPadding}>
        <ScreenHeader brand={false} title="Photo of you" />

        {state === 'invalid' ? (
          <Card style={styles.card}>
            <View style={styles.row}>
              <ShieldAlert color={theme.warningOnSoft} size={20} />
              <Text style={[styles.cardTitle, { color: theme.text }]}>This code has expired</Text>
            </View>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              Codes last ten minutes and work only on the account that made them. Go back to the
              browser and reload the page for a new one.
            </Text>
            <Button label="Done" variant="secondary" onPress={() => router.replace('/')} />
          </Card>
        ) : state === 'done' ? (
          <Card style={styles.card}>
            <View style={styles.row}>
              <CheckCircle2 color={theme.success} size={20} />
              <Text style={[styles.cardTitle, { color: theme.text }]}>Photo sent</Text>
            </View>
            {/*
              The one instruction that matters. Without it people wait on this
              screen for something to happen, because nothing on the phone tells
              them the browser has already moved on.
            */}
            {liveness && (
              <View
                style={[
                  styles.notice,
                  {
                    backgroundColor:
                      liveness.status === 'passed' ? theme.successSoft : theme.warningSoft,
                  },
                ]}>
                <Text
                  style={[
                    styles.noticeText,
                    {
                      color:
                        liveness.status === 'passed' ? theme.successOnSoft : theme.warningOnSoft,
                    },
                  ]}>
                  {livenessLabel(liveness)}
                </Text>
              </View>
            )}

            <Text style={[styles.body, { color: theme.textSecondary }]}>
              Go back to the browser to finish. That page has already continued — you do not need
              to press anything else here.
            </Text>
            <Button label="Done" onPress={() => router.replace('/')} />
          </Card>
        ) : (
          <Card style={styles.card}>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              You started this in a browser. Take a photo of yourself here and it will appear on
              that page automatically.
            </Text>

            <View style={[styles.notice, { backgroundColor: theme.primarySoft }]}>
              <Text style={[styles.noticeText, { color: theme.primaryOnSoft }]}>
                Stored privately and seen only by you and Package Relay staff. It is compared with
                the photo held on your NIN record.
              </Text>
            </View>

            {uri ? (
              <Image source={{ uri }} style={styles.preview} contentFit="cover" />
            ) : (
              <View style={[styles.placeholder, { backgroundColor: theme.surfaceMuted }]}>
                <Camera color={theme.textMuted} size={28} />
              </View>
            )}

            {error.length > 0 && (
              <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>
            )}

            {uri ? (
              <>
                <Button
                  label={busy ? 'Checking…' : 'Send this photo'}
                  onPress={send}
                  disabled={busy}
                />
                <Button
                  label="Retake"
                  variant="secondary"
                  icon={(color, size) => <RefreshCw color={color} size={size} />}
                  onPress={() => {
                    setUri('');
                    void capture();
                  }}
                  disabled={busy}
                />
              </>
            ) : (
              <Button
                label="Take photo"
                icon={(color, size) => <Camera color={color} size={size} />}
                onPress={capture}
                disabled={state === 'checking'}
              />
            )}
          </Card>
        )}
      </ScrollView>
    </StickyHeaderScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.three,
    marginTop: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  cardTitle: {
    ...Typography.sectionTitle,
    flex: 1,
  },
  body: {
    ...Typography.meta,
    lineHeight: 20,
  },
  notice: {
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
  },
  noticeText: {
    ...Typography.caption,
    lineHeight: 18,
    ...font(600),
  },
  preview: {
    width: '100%',
    aspectRatio: 3 / 4,
    maxHeight: 300,
    borderRadius: Radius.md,
    backgroundColor: '#E2E8F0',
  },
  placeholder: {
    width: '100%',
    height: 160,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    ...Typography.caption,
    lineHeight: 18,
  },
});
