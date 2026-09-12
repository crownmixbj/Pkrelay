import { useRouter } from 'expo-router';
import {
  Bell,
  BellOff,
  BadgeCheck,
  CircleAlert,
  Clock,
  PackageCheck,
  Truck,
  Wallet,
  type LucideIcon,
} from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/screen';
import { MaxContentWidth, Radius, Spacing, toneColors, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  badgeLabel,
  relativeTime,
  routeFor,
  toneFor,
  type AppNotification,
  type NotificationKind,
} from '@/store/notification-centre';

/**
 * The notification centre: a bell with a count, and the list behind it.
 *
 * ⚠ Unread is shown with a dot and a weight change, not colour alone.
 *
 *   WCAG 1.4.1. A tinted row is invisible to the ~8% of Nigerian male drivers
 *   with a colour vision deficiency, and unreadable in direct sun on a cheap
 *   screen — which is the actual viewing condition for most of this audience.
 */

function iconFor(kind: NotificationKind): LucideIcon {
  switch (kind) {
    case 'offer_received':
    case 'offer_expiring':
    case 'offer_expired':
    case 'job_assigned':
    case 'job_cancelled':
      return Truck;
    case 'pickup_reminder':
      return Clock;
    case 'parcel_status_changed':
    case 'delivery_completed':
    case 'parcel_cancelled':
    case 'parcel_booked':
      return PackageCheck;
    case 'earning_recorded':
    case 'payout_requested':
    case 'payout_paid':
    case 'payout_failed':
      return Wallet;
    case 'application_rejected':
    case 'sender_rejected':
    case 'identity_rejected':
    case 'document_rejected':
    case 'document_expired':
      return CircleAlert;
    default:
      return BadgeCheck;
  }
}

export function NotificationRow({
  notification,
  onOpen,
  now,
}: {
  notification: AppNotification;
  onOpen: (notification: AppNotification) => void;
  /** Injected so a test can pin "2 hours ago" without freezing the clock. */
  now?: Date;
}) {
  const theme = useTheme();
  const tone = toneFor(notification.kind);
  const { background, foreground } = toneColors(theme, tone);
  const Icon = iconFor(notification.kind);
  const unread = !notification.readAt;

  return (
    <Pressable
      onPress={() => onOpen(notification)}
      accessibilityRole="button"
      /*
       * ⚠ The label says "Unread" out loud.
       *
       *   A screen reader gets no dot and no font weight. Without this, a blind
       *   driver has no way to tell which notifications they have dealt with.
       */
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${notification.title}. ${notification.body}`}
      accessibilityHint="Opens the related screen"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={[styles.iconWrap, { backgroundColor: background }]}>
        <Icon color={foreground} size={18} />
      </View>

      <View style={styles.rowBody}>
        <View style={styles.titleLine}>
          <Text
            style={[styles.title, { color: theme.text }, unread && styles.titleUnread]}
            numberOfLines={2}>
            {notification.title}
          </Text>
          {unread && <View style={[styles.dot, { backgroundColor: theme.primary }]} />}
        </View>

        {!!notification.body && (
          <Text style={[styles.body, { color: theme.textSecondary }]} numberOfLines={3}>
            {notification.body}
          </Text>
        )}

        <Text style={[styles.time, { color: theme.textMuted }]}>
          {relativeTime(notification.createdAt, now)}
        </Text>
      </View>
    </Pressable>
  );
}

export function NotificationList({
  notifications,
  loading,
  onOpen,
  now,
}: {
  notifications: AppNotification[];
  loading: boolean;
  onOpen: (notification: AppNotification) => void;
  now?: Date;
}) {
  const theme = useTheme();

  if (loading) {
    return (
      <Card>
        <Text style={[styles.loading, { color: theme.textMuted }]}>Loading your notifications…</Text>
      </Card>
    );
  }

  if (notifications.length === 0) {
    return (
      <EmptyState
        icon={(color, size) => <BellOff color={color} size={size} />}
        title="Nothing yet"
        message="Job offers, parcel updates and payout confirmations will appear here."
      />
    );
  }

  return (
    <Card padded={false} style={styles.list}>
      {notifications.map((notification, index) => (
        <View key={notification.id}>
          {index > 0 && <View style={[styles.divider, { backgroundColor: theme.border }]} />}
          <NotificationRow notification={notification} onOpen={onOpen} now={now} />
        </View>
      ))}
    </Card>
  );
}

/**
 * The bell, with its count.
 *
 * ⚠ Takes `unread` rather than calling the hook itself.
 *
 *   A bell that subscribes independently is a second subscription and a second
 *   source of truth for one number — which is how a badge ends up showing 3
 *   above a list of 2. The screen owns the hook and passes the count down.
 */
export function NotificationBell({
  unread,
  onPress,
}: {
  unread: number;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  const label = badgeLabel(unread);

  return (
    <Pressable
      onPress={onPress ?? (() => router.navigate('/notifications'))}
      accessibilityRole="button"
      accessibilityLabel={
        unread > 0 ? `Notifications, ${unread} unread` : 'Notifications, none unread'
      }
      hitSlop={10}
      style={({ pressed }) => [styles.bell, pressed && styles.rowPressed]}>
      <Bell color={theme.text} size={20} />
      {!!label && (
        <View style={[styles.badge, { backgroundColor: theme.danger, borderColor: theme.surface }]}>
          <Text style={[styles.badgeText, { color: '#FFFFFF' }]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/** Where a row goes when tapped. Re-exported so screens do not import two modules. */
export { routeFor };

const styles = StyleSheet.create({
  list: {
    maxWidth: MaxContentWidth,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
    /*
     * 44pt is Apple's minimum touch target and roughly Android's 48dp. A row
     * this dense would otherwise be a 38pt tap for a single-line notification —
     * missable with a thumb, on a phone, on a motorbike.
     */
    minHeight: 44,
  },
  rowPressed: {
    opacity: 0.6,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: Spacing.one,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  title: {
    ...Typography.cardTitle,
    flex: 1,
  },
  titleUnread: {
    ...font(700),
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: Radius.pill,
    marginTop: 6,
  },
  body: {
    ...Typography.meta,
  },
  time: {
    ...Typography.caption,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: Spacing.three + 34 + Spacing.three,
  },
  loading: {
    ...Typography.meta,
  },
  bell: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: Radius.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    ...Typography.micro,
  },
});
