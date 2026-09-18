import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Camera, Check, IdCard, ImageIcon, RefreshCw } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import {
  PREVIEW_ASPECT,
  PREVIEW_MAX_HEIGHT,
  PREVIEW_MAX_WIDTH,
  WebcamPreview,
  useWebcam,
} from '@/components/ui/webcam-capture';
import { DOCUMENT_LABELS, type DocumentKind } from '@/constants/guarantor';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { uploadGuarantorDocument } from '@/store/guarantor';

/**
 * One of the guarantor's two files: attach it, upload it, show that it landed.
 *
 * ⚠ This is not `LiveSelfieCard`, and it cannot be.
 *
 *   That card banks a photo through `start_capture_session`, which raises "Not
 *   signed in" — every capture path in the app assumes an account, and the whole
 *   point of the guarantor is that there is not one. So this card goes through
 *   `guarantor-portal` with the invitation token instead, and the two components
 *   have no code in common beyond the pickers they both open.
 *
 * ⚠ Uploaded on capture, not on submit.
 *
 *   Both files have to exist before `complete_guarantor_verification` will
 *   accept anything — it counts the rows rather than trusting the form. If the
 *   upload waited for the submit button, a failed upload would arrive as an
 *   error on an action the guarantor believed had already succeeded, at the one
 *   moment they think they have finished. Here a refusal appears next to the
 *   button that has to be pressed again.
 *
 * ⚠ The camera only, for the live photo.
 *
 *   Its entire value is that it was taken at the moment the declaration was
 *   signed, by the person holding the device. `launchImageLibraryAsync` must
 *   never appear on that path — `verify-guarantor-portal` asserts that the
 *   gallery is reachable for the ID and not for the photo.
 */
export function GuarantorUploadCard({
  token,
  kind,
  hint,
  uploaded,
  onUploaded,
  onCleared,
  disabled,
}: {
  token: string;
  kind: DocumentKind;
  hint: string;
  /** True once the server has confirmed the object landed. */
  uploaded: boolean;
  onUploaded: () => void;
  onCleared: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const isWeb = Platform.OS === 'web';
  const live = kind === 'live_photo';

  /*
   * ⚠ No QR code here, so nothing may mention one.
   *
   *   The sender's sheet hands the camera to a phone through a capture session,
   *   and a capture session is bound to an account. A guarantor has no account
   *   and never will, so that handoff cannot exist on this page. What a guarantor
   *   does have is the link itself, in an inbox they can open on a phone — which
   *   is a real remedy and the only one this page can offer.
   */
  const webcam = useWebcam({
    fallback: 'You can also open this link on your phone, where the camera is easier.',
  });
  const { error: webcamError, streaming, start, stop, capture } = webcam;

  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [webcamOpen, setWebcamOpen] = useState(false);

  /** Uploads a local uri, and only reports success once the server confirms. */
  const send = async (uri: string) => {
    setBusy(true);
    setError('');
    try {
      const outcome = await uploadGuarantorDocument(token, kind, uri);
      if (!outcome.ok) {
        setError(outcome.message);
        /*
         * The preview is cleared on failure. Leaving the image on screen under
         * an error message is the shape that makes people press Submit anyway.
         */
        setPreview('');
        onCleared();
        return;
      }
      setPreview(uri);
      onUploaded();
    } finally {
      setBusy(false);
    }
  };

  const fromCamera = async () => {
    setError('');
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError('Allow camera access to take this photo.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        /*
         * ⚠ Not `allowsEditing` for either file.
         *
         *   Cropping an ID cuts off the part a reviewer needs, and a croppable
         *   live photo is a live photo somebody can compose. Quality is dropped
         *   instead, which is what keeps it inside the 6MB ceiling.
         */
        quality: 0.6,
        cameraType: live ? ImagePicker.CameraType.front : ImagePicker.CameraType.back,
      });

      if (!result.canceled && result.assets[0]?.uri) await send(result.assets[0].uri);
    } catch {
      setError('Something went wrong opening the camera.');
    }
  };

  const fromGallery = async () => {
    setError('');
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.6,
      });
      if (!result.canceled && result.assets[0]?.uri) await send(result.assets[0].uri);
    } catch {
      setError('Something went wrong opening your files.');
    }
  };

  const openWebcam = async () => {
    setError('');
    setWebcamOpen(true);
    await start();
  };

  const takeWebcamPhoto = async () => {
    const frame = capture();
    if (!frame) {
      setError('The camera has not started yet. Give it a moment and try again.');
      return;
    }
    stop();
    setWebcamOpen(false);
    /* A data: URL, which `readFileBytes` reads over XHR on the web. */
    await send(frame);
  };

  const retake = () => {
    setPreview('');
    onCleared();
    if (live && isWeb) void openWebcam();
    else if (live) void fromCamera();
  };

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: uploaded ? theme.successSoft : theme.surface,
          borderColor: uploaded ? theme.success : theme.borderStrong,
        },
      ]}>
      <View style={styles.head}>
        {uploaded ? (
          <Check color={theme.successOnSoft} size={18} />
        ) : live ? (
          <Camera color={theme.primary} size={18} />
        ) : (
          <IdCard color={theme.primary} size={18} />
        )}
        <Text style={[styles.title, { color: uploaded ? theme.successOnSoft : theme.text }]}>
          {/* The label carries the state, so it is never colour alone. */}
          {uploaded ? `${DOCUMENT_LABELS[kind]} — received` : DOCUMENT_LABELS[kind]}
        </Text>
        {!uploaded && (
          <View style={[styles.required, { backgroundColor: theme.primarySoft }]}>
            <Text style={[styles.requiredText, { color: theme.primaryOnSoft }]}>Required</Text>
          </View>
        )}
      </View>

      {!uploaded && <Text style={[styles.body, { color: theme.textSecondary }]}>{hint}</Text>}

      {/* ---------- the preview, the live camera, or nothing ---------- */}
      {preview.length > 0 ? (
        <Image
          source={{ uri: preview }}
          style={live ? styles.previewPortrait : styles.preview}
          contentFit="cover"
          accessibilityIgnoresInvertColors
          accessibilityLabel={DOCUMENT_LABELS[kind]}
        />
      ) : webcamOpen && isWeb ? (
        /* The same framed preview the sender photo sheet mounts. */
        <WebcamPreview webcam={webcam} />
      ) : null}

      {(error.length > 0 || (webcamOpen && webcamError)) && (
        <Text style={[styles.error, { color: theme.danger }]}>{error || webcamError}</Text>
      )}

      {/* ---------- the controls ---------- */}
      {busy ? (
        <View style={styles.busy}>
          <ActivityIndicator color={theme.primary} />
          <Text style={[styles.busyText, { color: theme.textSecondary }]}>Uploading…</Text>
        </View>
      ) : uploaded ? (
        <Button
          label={live ? 'Retake photo' : 'Replace'}
          variant="secondary"
          icon={(color, size) => <RefreshCw color={color} size={size} />}
          onPress={live ? retake : () => (isWeb ? void fromGallery() : void fromCamera())}
          disabled={disabled}
        />
      ) : live ? (
        isWeb ? (
          webcamOpen ? (
            <Button
              label="Take photo"
              icon={(color, size) => <Camera color={color} size={size} />}
              onPress={() => void takeWebcamPhoto()}
              disabled={!streaming || disabled}
            />
          ) : (
            <Button
              label="Open camera"
              icon={(color, size) => <Camera color={color} size={size} />}
              onPress={() => void openWebcam()}
              disabled={disabled}
            />
          )
        ) : (
          <Button
            label="Take live photo"
            icon={(color, size) => <Camera color={color} size={size} />}
            onPress={() => void fromCamera()}
            disabled={disabled}
          />
        )
      ) : (
        /*
          The ID has two ways in and the photo has one. Somebody photographing a
          card they are holding wants the camera; somebody who scanned it last
          year already has the file.
        */
        <View style={styles.actions}>
          {!isWeb && (
            <PickerButton
              icon={<Camera color={theme.primary} size={18} />}
              label="Take photo"
              disabled={Boolean(disabled)}
              onPress={() => void fromCamera()}
            />
          )}
          <PickerButton
            icon={<ImageIcon color={theme.primary} size={18} />}
            label={isWeb ? 'Choose a file' : 'From gallery'}
            disabled={Boolean(disabled)}
            onPress={() => void fromGallery()}
          />
        </View>
      )}
    </View>
  );
}

function PickerButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.pickerButton,
        { backgroundColor: theme.surfaceMuted, borderColor: theme.border },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}>
      {icon}
      <Text style={[styles.pickerLabel, { color: theme.primary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: 1,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  title: {
    ...Typography.meta,
    ...font(700),
    flex: 1,
  },
  required: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  requiredText: {
    ...Typography.caption,
    ...font(700),
    fontSize: 11,
    letterSpacing: 0.3,
  },
  body: {
    ...Typography.caption,
    lineHeight: 18,
  },
  /** An ID card is a landscape document; a full-width strip is the right shape. */
  preview: {
    width: '100%',
    height: 180,
    borderRadius: Radius.md,
  },
  /**
   * The live photo is a face, so it takes the same portrait box the camera
   * preview uses — nothing moves when the photo is taken, and the shape is the
   * one the face check is given.
   */
  previewPortrait: {
    width: '100%',
    maxWidth: PREVIEW_MAX_WIDTH,
    alignSelf: 'center',
    aspectRatio: PREVIEW_ASPECT,
    maxHeight: PREVIEW_MAX_HEIGHT,
    borderRadius: Radius.md,
  },
  error: {
    ...Typography.caption,
    lineHeight: 18,
  },
  busy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three - 2,
  },
  busyText: {
    ...Typography.caption,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  pickerButton: {
    flex: 1,
    minWidth: 140,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three - 2,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  pickerLabel: {
    ...Typography.body,
    ...font(600),
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
});
