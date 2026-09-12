import { Apple, Check, Smartphone, X } from 'lucide-react-native';
import { Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { FontSize, Elevation, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Where "get the app" goes. The download section, the drawer's "Get the App"
 * item and the picker below all share these, so there is one place to correct
 * when the listings are real.
 *
 * ⚠ Neither link resolves yet, and they fail differently.
 *
 *   Android's URL is deterministic: it is the `android.package` from app.json
 *   and nothing else. It said `com.loci.app` while the package has always been
 *   `com.loci.parcel`, so it would have 404'd on the day of launch with nothing
 *   to point at the typo. Corrected here; if the package is ever changed, this
 *   has to change with it.
 *
 *   iOS cannot be derived at all — App Store Connect assigns the numeric id
 *   when the app record is created, so `id123456789` is a placeholder and is
 *   left obviously fake rather than plausibly wrong.
 */
export const STORE_LINKS = {
  android: 'https://play.google.com/store/apps/details?id=com.loci.parcel',
  ios: 'https://apps.apple.com/app/id123456789',
} as const;

export type StorePlatform = keyof typeof STORE_LINKS;

/**
 * Which store this device should go to, or null when we can't tell.
 *
 * On native, `Platform.OS` is authoritative. On web it only tells us "web", so
 * we read the user agent to catch someone browsing from a phone — that's the
 * case worth auto-redirecting. Desktop browsers fall through to null and get
 * the picker.
 */
export function detectStorePlatform(): StorePlatform | null {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';

  if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
    const ua = navigator.userAgent ?? '';
    if (/android/i.test(ua)) return 'android';
    if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  }

  return null;
}

export function openStore(platform: StorePlatform) {
  return Linking.openURL(STORE_LINKS[platform]);
}

export type AppStoreModalProps = {
  visible: boolean;
  onClose: () => void;
  /** Highlighted as "your device" when known. */
  detected: StorePlatform | null;
};

export function AppStoreModal({ visible, onClose, detected }: AppStoreModalProps) {
  const theme = useTheme();

  const choose = (platform: StorePlatform) => {
    onClose();
    openStore(platform);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={[
            styles.sheet,
            {
              backgroundColor: theme.surface,
              borderColor: theme.border,
              shadowColor: theme.shadow,
            },
            Elevation.raised,
          ]}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: theme.text }]}>Which device are you using?</Text>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                We&apos;ll take you to the right store to download the Package Relay app.
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityLabel="Close"
              style={[styles.close, { backgroundColor: theme.surfaceMuted }]}>
              <X color={theme.textSecondary} size={18} />
            </Pressable>
          </View>

          <StoreOption
            label="Android"
            sublabel="Google Play Store"
            recommended={detected === 'android'}
            icon={(color) => <Smartphone color={color} size={22} />}
            onPress={() => choose('android')}
          />
          <StoreOption
            label="iPhone or iPad"
            sublabel="Apple App Store"
            recommended={detected === 'ios'}
            icon={(color) => <Apple color={color} size={22} />}
            onPress={() => choose('ios')}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function StoreOption({
  label,
  sublabel,
  recommended,
  icon,
  onPress,
}: {
  label: string;
  sublabel: string;
  recommended: boolean;
  icon: (color: string) => React.ReactNode;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${sublabel}${recommended ? '. Detected as your device' : ''}`}
      style={({ pressed }) => [
        styles.option,
        {
          backgroundColor: recommended ? theme.primarySoft : theme.surfaceMuted,
          borderColor: recommended ? theme.primary : 'transparent',
        },
        pressed && styles.pressed,
      ]}>
      <View
        style={[
          styles.optionIcon,
          { backgroundColor: recommended ? theme.primary : theme.backgroundSelected },
        ]}>
        {icon(recommended ? theme.primaryText : theme.text)}
      </View>

      <View style={styles.optionText}>
        <Text
          style={[styles.optionLabel, { color: recommended ? theme.primaryOnSoft : theme.text }]}>
          {label}
        </Text>
        <Text style={[styles.optionSublabel, { color: theme.textMuted }]}>{sublabel}</Text>
      </View>

      {recommended && (
        <View style={styles.detectedBadge}>
          <Check color={theme.primary} size={14} />
          <Text style={[styles.detectedText, { color: theme.primary }]}>Your device</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.three,
    gap: Spacing.two + 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
    marginBottom: Spacing.one,
  },
  headerText: {
    flex: 1,
    gap: Spacing.one,
  },
  title: {
    ...Typography.sectionTitle,
    fontSize: FontSize.subhead,
  },
  subtitle: {
    ...Typography.meta,
    lineHeight: 18,
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 2,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  pressed: {
    opacity: 0.75,
  },
  optionIcon: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionText: {
    flex: 1,
    gap: Spacing.half,
  },
  optionLabel: {
    ...Typography.body,
    ...font(700),
  },
  optionSublabel: {
    ...Typography.meta,
  },
  detectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  detectedText: {
    fontSize: FontSize.micro,
    ...font(700),
  },
});
