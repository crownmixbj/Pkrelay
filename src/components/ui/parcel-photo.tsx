import { Image } from 'expo-image';
import { ImageOff, Maximize2, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { signedParcelPhotoUrl } from '@/store/parcel-photos';

/**
 * The sender's photo of the parcel, for the driver deciding whether it fits.
 *
 * Signed on demand (an hour-long URL from the private `parcel-photo` bucket);
 * storage policy 84 decides who may open it — the sender, admins, the driver
 * carrying the parcel, and a driver holding a live offer for it. Anyone else
 * gets "Photo not available" rather than an error.
 *
 * Tap to see it full screen, where the size of the box is easier to judge.
 */
export function ParcelPhoto({
  path,
  height = 160,
  label = 'Parcel photo from the sender',
}: {
  path: string | null | undefined;
  height?: number;
  label?: string;
}) {
  const theme = useTheme();
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>(path ? 'loading' : 'missing');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setState('missing');
      setUrl(null);
      return;
    }
    setState('loading');
    void signedParcelPhotoUrl(path).then((signed) => {
      if (cancelled) return;
      setUrl(signed);
      setState(signed ? 'ready' : 'missing');
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (state !== 'ready' || !url) {
    return (
      <View
        style={[
          styles.placeholder,
          { height: Math.min(height, 72), backgroundColor: theme.surfaceMuted },
        ]}>
        {state === 'loading' ? (
          <ActivityIndicator color={theme.primary} />
        ) : (
          <>
            <ImageOff color={theme.textMuted} size={16} />
            <Text style={[styles.placeholderText, { color: theme.textMuted }]}>
              {path ? 'Photo not available' : 'The sender did not add a photo'}
            </Text>
          </>
        )}
      </View>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="imagebutton"
        accessibilityLabel={`${label}. Tap to enlarge`}
        style={({ pressed }) => [styles.frame, { height }, pressed && { opacity: 0.85 }]}>
        <Image source={{ uri: url }} style={styles.fill} contentFit="cover" transition={150} />
        <View style={styles.badge}>
          <Maximize2 color="#FFFFFF" size={12} />
          <Text style={styles.badgeText}>Parcel photo</Text>
        </View>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={styles.backdrop}
          onPress={() => setOpen(false)}
          accessibilityLabel="Close photo">
          <Image source={{ uri: url }} style={styles.full} contentFit="contain" />
          <View style={styles.close}>
            <X color="#FFFFFF" size={20} />
          </View>
          <Text style={styles.caption}>{label}</Text>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', borderRadius: Radius.md, overflow: 'hidden', backgroundColor: '#0F172A' },
  fill: { width: '100%', height: '100%' },
  badge: {
    position: 'absolute',
    left: Spacing.two,
    bottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.two,
    paddingVertical: 3,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(15,23,42,0.7)',
  },
  badgeText: { color: '#FFFFFF', ...Typography.caption, ...font(600), fontSize: 11 },
  placeholder: {
    width: '100%',
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one + 2,
  },
  placeholderText: { ...Typography.caption, ...font(600) },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.three,
  },
  full: { width: '100%', height: '80%' },
  close: {
    position: 'absolute',
    top: Spacing.five,
    right: Spacing.three,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  caption: { color: '#FFFFFF', ...Typography.caption, marginTop: Spacing.two },
});
