import { useRouter } from 'expo-router';
import { CheckCheck } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { NotificationList } from '@/components/ui/notification-centre';
import { screenPadding, ScreenHeader } from '@/components/ui/screen';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useNotificationCentre } from '@/hooks/use-notification-centre';
import { routeFor, type AppNotification } from '@/store/notification-centre';
import { useSession } from '@/store/session';

/**
 * Everything Package Relay has told this account.
 *
 * ⚠ Opening a notification marks it read and navigates in one tap.
 *
 *   A separate "mark as read" control is the pattern people never use, which
 *   leaves a badge that only ever grows until it stops meaning anything. If
 *   somebody has read the thing, the badge should reflect that without being
 *   asked.
 */
export default function NotificationsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { isAuthenticated } = useSession();
  const { notifications, unread, loading, refresh, open, readAll } = useNotificationCentre();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const onOpen = useCallback(
    (notification: AppNotification) => {
      open(notification.id);
      router.navigate(routeFor(notification) as never);
    },
    [open, router],
  );

  if (!isAuthenticated) {
    return (
      <ScrollView contentContainerStyle={[screenPadding, { backgroundColor: theme.background }]}>
        <ScreenHeader
          title="Notifications"
          subtitle="Job offers, parcel updates and payout confirmations."
        />
        <SignedOutState
          title="Sign in to see your notifications"
          message="Your notifications are tied to your account, so there is nothing to show while you are signed out."
          next="/notifications"
        />
        <Footer />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={[screenPadding, { backgroundColor: theme.background }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <ScreenHeader
        title="Notifications"
        subtitle={
          unread > 0
            ? `${unread} unread. Tap one to open what it is about.`
            : 'Job offers, parcel updates and payout confirmations.'
        }
      />

      {unread > 0 && (
        <View style={styles.actions}>
          <Button
            label="Mark all as read"
            variant="secondary"
            onPress={() => void readAll()}
            icon={(color: string) => <CheckCheck color={color} size={16} />}
          />
        </View>
      )}

      <NotificationList notifications={notifications} loading={loading} onOpen={onOpen} />

      <Footer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: Spacing.three,
    maxWidth: MaxContentWidth,
  },
});
