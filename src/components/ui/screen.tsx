import { ArrowLeft } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Shared content padding so all three tabs line up exactly. Navigation sits at
 * the top now, so the bottom only needs breathing room, not tab-bar clearance.
 */
export const screenPadding = {
  paddingHorizontal: Spacing.four,
  paddingTop: Spacing.four,
  paddingBottom: Spacing.six,
};

export function ScreenHeader({
  title,
  subtitle,
  /** Shows the LOCI wordmark above the title. */
  brand = true,
  /**
   * Renders a back arrow to the left of the title, on the same line.
   *
   * ⚠ Opt-in, because most screens here are top-level tabs.
   *
   *   A back arrow on a tab either does nothing or reverses a tab switch,
   *   which is not what the arrow means. It belongs on screens somebody
   *   arrives at from somewhere else — the profile, opened from the account
   *   menu, is one.
   */
  onBack,
}: {
  title: string;
  subtitle?: string;
  brand?: boolean;
  onBack?: () => void;
}) {
  const theme = useTheme();

  return (
    <View style={styles.header}>
      {brand && <Text style={[styles.brand, { color: theme.primary }]}>LOCI</Text>}

      {/*
        ⚠ The arrow and the title share a row and are centred against each
          other, rather than the title being centred in the screen.

          Centring a title across the full width leaves it visually off-centre
          the moment anything sits on one side and not the other, and it drifts
          as the title's length changes. Aligning it to the arrow keeps the two
          reading as one unit at every width.
      */}
      {onBack ? (
        <View style={styles.titleRow}>
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={10}
            style={({ pressed }) => [
              styles.back,
              { backgroundColor: theme.surfaceMuted },
              pressed && styles.backPressed,
            ]}>
            <ArrowLeft color={theme.text} size={18} />
          </Pressable>
          <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
            {title}
          </Text>
        </View>
      ) : (
        <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      )}

      {!!subtitle && (
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{subtitle}</Text>
      )}
    </View>
  );
}

export function SectionLabel({ children }: { children: string }) {
  const theme = useTheme();
  return <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>{children}</Text>;
}

export function EmptyState({
  icon,
  title,
  message,
}: {
  icon?: (color: string, size: number) => React.ReactNode;
  title: string;
  message: string;
}) {
  const theme = useTheme();

  return (
    <View style={styles.empty}>
      {icon?.(theme.textMuted, 40)}
      <Text style={[styles.emptyTitle, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.emptyMessage, { color: theme.textSecondary }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: Spacing.one + 2,
    marginBottom: Spacing.four,
    maxWidth: MaxContentWidth,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  back: {
    width: 34,
    height: 34,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backPressed: {
    opacity: 0.6,
  },
  brand: {
    ...Typography.label,
    ...font(800),
    letterSpacing: 2.4,
    marginBottom: Spacing.half,
  },
  title: {
    ...Typography.screenTitle,
  },
  subtitle: {
    ...Typography.screenSubtitle,
  },
  sectionLabel: {
    ...Typography.label,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: Spacing.two,
  },
  empty: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.six,
    paddingHorizontal: Spacing.three,
  },
  emptyTitle: {
    ...Typography.sectionTitle,
    marginTop: Spacing.one,
  },
  emptyMessage: {
    ...Typography.body,
    textAlign: 'center',
  },
});
