import { useRouter } from 'expo-router';
import { ShieldAlert } from 'lucide-react-native';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, screenPadding, ScreenHeader } from '@/components/ui/screen';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { FontSize, MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/store/session';

/**
 * The frame every Admin screen sits in.
 *
 * Four screens needed the same three states — loading, signed out, signed in
 * but not an admin — and four copies of that is four chances to get the third
 * one subtly wrong. It is written once here.
 *
 * ⚠ This is not the security boundary. It hides a screen; the RLS policies and
 *   `security definer` functions in `supabase/migrations/20250101000007_admin.sql` are what refuse the
 *   data. A non-admin who reaches these routes directly sees the panel below,
 *   and would see empty lists even without it.
 */
export function AdminShell({
  title,
  subtitle,
  next,
  children,
}: {
  title: string;
  subtitle: string;
  /** Where to return after signing in. */
  next: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const router = useRouter();
  const { status, isAuthenticated, isAdmin } = useSession();

  if (status === 'loading') {
    return (
      <View style={[styles.loading, { backgroundColor: theme.background }]}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <Frame title={title} subtitle={subtitle}>
        <SignedOutState
          title="Sign in to continue"
          message="This area is only available to Package Relay administrators."
          next={next}
        />
      </Frame>
    );
  }

  /*
   * Deliberately vague for a signed-in non-admin.
   *
   * "You are not an admin" confirms that an admin tier exists and is worth
   * hunting for. "Not available on your account" tells the person what they
   * need to know — they cannot use this — and nothing else.
   */
  if (!isAdmin) {
    return (
      <Frame title={title} subtitle={subtitle}>
        <Card style={styles.deniedCard}>
          <EmptyState
            icon={(color, size) => <ShieldAlert color={color} size={size} />}
            title="Not available"
            message="This area isn't available on your account."
          />
          <Button label="Back to Package Relay" size="md" onPress={() => router.replace('/')} />
        </Card>
      </Frame>
    );
  }

  return (
    <Frame title={title} subtitle={subtitle}>
      {children}
    </Frame>
  );
}

function Frame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        <ScreenHeader brand={false} title={title} subtitle={subtitle} />
        {children}
      </View>
    </ScrollView>
  );
}

/** A single number with a label. Shared by the overview and the ops screen. */
export function Metric({
  label,
  value,
  tone = 'neutral',
  hint,
  nested = false,
}: {
  /**
   * True when this card is inside a `metricSlot` wrapper.
   *
   * The wrapper carries the flex; the card must not carry it too. A Pressable
   * lays its children out in a *column*, so `flexBasis: 150` on the card sets
   * its height rather than its width — a tappable card ends up 150px tall
   * beside static ones that size to their content, and the row stops lining up.
   */
  nested?: boolean;
  label: string;
  value: string | number;
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
  hint?: string;
}) {
  const theme = useTheme();

  const color =
    tone === 'primary'
      ? theme.primary
      : tone === 'success'
        ? theme.success
        : tone === 'warning'
          ? theme.warningOnSoft
          : tone === 'danger'
            ? theme.danger
            : theme.text;

  return (
    <Card style={[styles.metric, nested && styles.metricNested]}>
      <Text style={[styles.metricValue, { color }]}>{value}</Text>
      <Text style={[styles.metricLabel, { color: theme.textSecondary }]}>{label}</Text>
      {!!hint && <Text style={[styles.metricHint, { color: theme.textMuted }]}>{hint}</Text>}
    </Card>
  );
}

/** An error from a failed admin call, shown rather than swallowed. */
export function AdminError({ message }: { message: string }) {
  const theme = useTheme();

  return (
    <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
      <Text style={[styles.errorText, { color: theme.dangerOnSoft }]}>{message}</Text>
    </View>
  );
}

export const adminStyles = StyleSheet.create({
  /**
   * Wraps a Metric that is tappable.
   *
   * Two jobs. It carries the flex the Card would have carried, so a tappable
   * card lines up with the static ones beside it. And it sets `cursor:
   * 'pointer'` explicitly rather than trusting react-native-web to infer one:
   * a `Pressable` renders a plain `div`, and a card that does not change the
   * cursor reads as decoration no matter what handler is attached to it. On
   * native the property is ignored.
   */
  metricSlot: {
    flexGrow: 1,
    flexBasis: 150,
    cursor: 'pointer',
  },
  /** Wraps to as many columns as fit; one per row on a phone. */
  metrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two + 2,
    marginBottom: Spacing.four,
  },
  section: {
    marginBottom: Spacing.four,
  },
});

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deniedCard: {
    gap: Spacing.three,
    marginTop: Spacing.three,
  },
  metric: {
    flexGrow: 1,
    flexBasis: 150,
    gap: Spacing.half,
  },
  /** Inside a slot: the wrapper does the flexing, this just fills it. */
  metricNested: {
    flexGrow: 0,
    flexBasis: 'auto',
    width: '100%',
  },
  metricValue: {
    fontSize: FontSize.title,
    ...font(800),
  },
  metricLabel: {
    ...Typography.meta,
    ...font(600),
  },
  metricHint: {
    ...Typography.caption,
  },
  error: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    marginBottom: Spacing.three,
  },
  errorText: {
    ...Typography.meta,
    ...font(600),
  },
});
