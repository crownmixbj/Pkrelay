import { useRouter } from 'expo-router';
import { ShieldAlert } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { BANNER_MESSAGE, shouldShowVerifyBanner } from '@/lib/posting-gate';
import { fetchSenderIdentity, isVerificationAvailable } from '@/store/identity';
import { useSession } from '@/store/session';

/**
 * The standing prompt to verify, shown where somebody is about to send.
 *
 * ⚠ Non-blocking, and it disappears the moment it stops being true.
 *
 *   It appears only for accounts that have never submitted a NIN — see
 *   `shouldShowVerifyBanner`. Somebody waiting on a result, or flagged for
 *   review, is not shown an instruction they have already followed; a banner
 *   that cannot be acted on or dismissed is how people learn to ignore
 *   banners, including the ones that matter.
 *
 * ⚠ Renders nothing while the status is unknown.
 *
 *   The identity record is fetched, so there is a moment where this component
 *   knows nothing. Assuming "unverified" during it would flash a warning at
 *   verified senders on every screen load — the surest way to make the banner
 *   look like a bug.
 */
export function VerifyBanner() {
  const theme = useTheme();
  const router = useRouter();
  const { isAuthenticated } = useSession();

  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      setShow(false);
      return;
    }

    let cancelled = false;
    void fetchSenderIdentity().then((identity) => {
      if (!cancelled) setShow(shouldShowVerifyBanner(identity, isVerificationAvailable()));
    });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  if (!show) return null;

  return (
    <View
      style={[styles.banner, { backgroundColor: theme.warningSoft, borderColor: theme.warning }]}
      accessibilityRole="alert">
      <ShieldAlert color={theme.warning} size={18} />

      <Text style={[styles.message, { color: theme.text }]}>{BANNER_MESSAGE}</Text>

      <Pressable
        onPress={() => router.push('/(tabs)/profile')}
        accessibilityRole="button"
        accessibilityLabel="Verify now — opens your profile"
        style={({ pressed }) => [
          styles.action,
          { backgroundColor: theme.primary },
          pressed && styles.pressed,
        ]}>
        <Text style={[styles.actionLabel, { color: theme.primaryText }]}>Verify Now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    /*
     * Wraps on a narrow phone rather than squeezing the button to nothing —
     * the button is the point of the banner.
     */
    flexWrap: 'wrap',
  },
  message: {
    ...Typography.meta,
    flex: 1,
    minWidth: 180,
    lineHeight: 20,
  },
  action: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
  },
  actionLabel: {
    ...Typography.meta,
    ...font(700),
  },
  pressed: {
    opacity: 0.7,
  },
});
