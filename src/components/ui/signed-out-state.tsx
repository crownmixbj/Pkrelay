import { useRouter } from 'expo-router';
import { LockKeyhole } from 'lucide-react-native';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Radius, Spacing, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/store/session';

/**
 * Shown where a personal feed would be, when nobody is signed in.
 *
 * Both doors, every time. Someone landing here is as likely to be new as
 * returning, and a screen offering only "Sign in" makes a first-time visitor
 * hunt for the sign-up link. `next` carries them back here afterwards.
 *
 * ⚠ It asks the session whether anybody is signed in *yet*, rather than
 *   trusting the caller to have asked.
 *
 *   `status` passes through 'loading' on every launch while the stored session
 *   is restored, and during that moment `isAuthenticated` is false — truthfully,
 *   because nobody is signed in *as far as the client knows*. Nine screens
 *   branched on `!isAuthenticated` alone, so on the web, where restoring means
 *   reading storage and then refreshing the token over the network, every
 *   reload painted this card for a few hundred milliseconds before the real
 *   page replaced it. A signed-in person watching their own app flash the
 *   sign-in screen at them does not read it as a loading state; they read it as
 *   having been signed out.
 *
 *   Putting the check here rather than in the nine callers is the same decision
 *   `AdminShell` made for the same three states: one place to get it right, and
 *   a screen added next year cannot reintroduce it.
 */
export function SignedOutState({
  title,
  message,
  next,
}: {
  title: string;
  message: string;
  next: string;
}) {
  const theme = useTheme();
  const router = useRouter();
  const { status } = useSession();

  /*
    Still restoring. A spinner in the same slot, so the page does not resize
    under the reader when the answer arrives.
  */
  if (status === 'loading') {
    return (
      <Card style={styles.card}>
        <ActivityIndicator color={theme.primary} />
      </Card>
    );
  }

  return (
    <Card style={styles.card}>
      <View style={[styles.icon, { backgroundColor: theme.primarySoft }]}>
        <LockKeyhole color={theme.primaryOnSoft} size={24} />
      </View>

      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.message, { color: theme.textSecondary }]}>{message}</Text>

      <View style={styles.actions}>
        <Button
          label="Sign in"
          size="md"
          style={styles.action}
          onPress={() => router.push({ pathname: '/sign-in', params: { next } })}
        />
        <Button
          label="Create an account"
          variant="secondary"
          size="md"
          style={styles.action}
          onPress={() => router.push({ pathname: '/sign-up', params: { next } })}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingVertical: Spacing.five,
  },
  icon: {
    width: 52,
    height: 52,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.one,
  },
  title: {
    ...Typography.sectionTitle,
    textAlign: 'center',
  },
  message: {
    ...Typography.body,
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: 420,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  action: {
    flexGrow: 1,
    flexBasis: 150,
  },
});
