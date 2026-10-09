import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Camera, ImageIcon, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { showDialog } from '@/components/ui/dialog';

import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { rememberPickedFile } from '@/lib/upload';

export type PhotoPickerProps = {
  label: string;
  hint?: string;
  /** Local URI, or '' when nothing is attached. */
  value: string;
  onChange: (uri: string) => void;
  /** Shown under the control, e.g. when a parent marks the field required. */
  error?: string;
};

/**
 * Optional single-photo attachment.
 *
 * Two ways in — camera and library — because they need different permissions
 * and a sender at a hub counter wants the camera while someone posting from
 * home usually already has the photo. On web there is no camera permission
 * model to speak of, so that button is hidden and the library button opens the
 * normal file dialog.
 *
 * The URI is local to the device. Nothing is uploaded, and it is not persisted
 * past the session — wire this to real storage before treating a photo as
 * evidence of a parcel's condition.
 */
export function PhotoPicker({ label, hint, value, onChange, error }: PhotoPickerProps) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const attached = value.length > 0;

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: true,
    quality: 0.7,
  };

  /** Permission denials are reported, never silently swallowed. */
  const run = async (source: 'camera' | 'library') => {
    if (busy) return;
    setBusy(true);
    try {
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          showDialog(
            'Camera access needed',
            'Allow camera access in your settings to take a photo of the parcel.',
          );
          return;
        }
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync(options)
          : await ImagePicker.launchImageLibraryAsync(options);

      // `canceled` covers the user backing out; assets is empty in that case.
      /* `rememberPickedFile` keeps the browser's File behind the uri. See upload.ts. */
      if (!result.canceled && result.assets[0]?.uri)
        onChange(rememberPickedFile(result.assets[0]));
    } catch {
      showDialog('Could not attach photo', 'Something went wrong opening the picker.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.block}>
      <Text style={[styles.label, { color: theme.textSecondary }]}>{label}</Text>

      {attached ? (
        <View style={[styles.preview, { borderColor: theme.success }]}>
          <Image
            source={{ uri: value }}
            style={styles.thumb}
            contentFit="cover"
            accessibilityIgnoresInvertColors
            accessibilityLabel="Attached photo of the parcel"
          />
          <Pressable
            onPress={() => onChange('')}
            accessibilityRole="button"
            accessibilityLabel="Remove the attached photo"
            hitSlop={8}
            style={({ pressed }) => [
              styles.remove,
              { backgroundColor: theme.surfaceMuted },
              pressed && styles.pressed,
            ]}>
            <Trash2 color={theme.danger} size={16} />
            <Text style={[styles.removeLabel, { color: theme.danger }]}>Remove</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.actions}>
          {/* No camera capture on web — the file dialog covers it. */}
          {Platform.OS !== 'web' && (
            <PickerButton
              icon={<Camera color={theme.primary} size={18} />}
              label="Take photo"
              disabled={busy}
              onPress={() => run('camera')}
            />
          )}
          <PickerButton
            icon={<ImageIcon color={theme.primary} size={18} />}
            label={Platform.OS === 'web' ? 'Choose a photo' : 'From gallery'}
            disabled={busy}
            onPress={() => run('library')}
          />
        </View>
      )}

      {!!hint && !error && <Text style={[styles.hint, { color: theme.textMuted }]}>{hint}</Text>}
      {!!error && <Text style={[styles.hint, { color: theme.danger }]}>{error}</Text>}
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
        styles.button,
        { backgroundColor: theme.surfaceMuted, borderColor: theme.border },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}>
      {icon}
      <Text style={[styles.buttonLabel, { color: theme.primary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: Spacing.two,
  },
  label: {
    ...Typography.label,
    ...font(600),
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  button: {
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
  buttonLabel: {
    ...Typography.body,
    ...font(600),
  },
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: Radius.sm,
  },
  remove: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.sm,
  },
  removeLabel: {
    ...Typography.caption,
    ...font(700),
  },
  hint: {
    ...Typography.caption,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
});
