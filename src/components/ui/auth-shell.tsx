import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { Footer } from '@/components/Footer';
import { StickyHeaderScreen } from '@/components/ui/sticky-header';
import { Elevation, PageCanvas, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Shared frame for sign-in, sign-up and verify-email.
 *
 * The auth screens previously had no width constraint at all, so on a desktop
 * browser the inputs stretched the full 2000px of the window. A password box a
 * metre wide isn't just ugly — a form whose fields are far wider than their
 * content reads as unfinished, and the eye has to travel from a left-aligned
 * label to a right-hand caret.
 *
 * 420px is the width the field content actually needs: an email address at 16px
 * is around 250px, and the widest button label here fits comfortably. Every
 * mainstream auth page lands within 360–480 for the same reason.
 */
const CARD_WIDTH = 420;

/** Below this the card drops its chrome and becomes the page, as on a phone. */
const CARD_BREAKPOINT = 520;

export type AuthShellProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  /** Rendered under the card, outside its border — "New to Package Relay?" and similar. */
  footer?: React.ReactNode;
  /** Where the back arrow goes. Defaults to `router.back()`. */
  onBack?: () => void;
};

export function AuthShell({ title, subtitle, children, footer, onBack }: AuthShellProps) {
  const theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();

  /*
   * On a phone the card's border and shadow would just be a rectangle drawn
   * around the whole screen, so it flattens into the page instead.
   */
  const framed = width >= CARD_BREAKPOINT;

  return (
    /*
     * The app header sits above the form here, same as everywhere else, so the
     * brand and navigation don't vanish when someone lands on sign-in. That
     * makes the card's own PKRELAY wordmark a second brand mark stacked directly
     * under the first, so it's gone — the header carries the brand now.
     */
    <StickyHeaderScreen>
      <KeyboardAvoidingView
        style={[styles.flex, { backgroundColor: PageCanvas }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.scroll, framed && styles.scrollFramed]}
          keyboardShouldPersistTaps="handled">
          <View style={styles.column}>
            <Pressable
              onPress={onBack ?? (() => router.back())}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              hitSlop={10}
              style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
              <ArrowLeft color={theme.textSecondary} size={20} />
            </Pressable>

            <View
              style={[
                styles.card,
                framed && [
                  styles.cardFramed,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    shadowColor: theme.shadow,
                  },
                  Elevation.raised,
                ],
              ]}>
              <View style={styles.heading}>
                <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
                {!!subtitle && (
                  <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{subtitle}</Text>
                )}
              </View>

              {children}
            </View>

            {!!footer && <View style={styles.footer}>{footer}</View>}
          </View>
          <Footer />
        </ScrollView>
      </KeyboardAvoidingView>
    </StickyHeaderScreen>
  );
}

/** "New to Package Relay? Create an account" — one consistent shape for both screens. */
export function AuthFooterLink({
  prompt,
  action,
  onPress,
}: {
  prompt: string;
  action: string;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <View style={styles.footerRow}>
      <Text style={[styles.footerText, { color: theme.textSecondary }]}>{prompt} </Text>
      <Pressable
        onPress={onPress}
        accessibilityRole="link"
        accessibilityLabel={action}
        hitSlop={8}
        style={({ pressed }) => pressed && styles.pressed}>
        <Text style={[styles.footerLink, { color: theme.primary }]}>{action}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    padding: Spacing.four,
    // The sticky header already supplies the top breathing room.
    paddingTop: Spacing.three,
  },
  /** Centres the card vertically once there's room for it to float. */
  scrollFramed: {
    justifyContent: 'center',
    paddingVertical: Spacing.six,
  },
  column: {
    width: '100%',
    maxWidth: CARD_WIDTH,
    alignSelf: 'center',
    gap: Spacing.three,
  },
  back: {
    alignSelf: 'flex-start',
    padding: Spacing.one,
    marginLeft: -Spacing.one,
  },
  card: {
    gap: Spacing.three,
  },
  cardFramed: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.four,
  },
  heading: {
    gap: Spacing.one + 2,
  },
  title: {
    ...Typography.screenTitle,
  },
  subtitle: {
    ...Typography.body,
    lineHeight: 22,
  },
  footer: {
    alignItems: 'center',
  },
  footerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerText: {
    ...Typography.body,
  },
  footerLink: {
    ...Typography.body,
    ...font(700),
  },
  pressed: {
    opacity: 0.7,
  },
});
