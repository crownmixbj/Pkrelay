import { useRouter } from 'expo-router';
import { MessageCircle } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Booking } from '@/store/bookings';
import { chatIsOpen, chatRole, useUnreadMessages } from '@/store/parcel-messages';
import { useSession } from '@/store/session';

/**
 * "Message sender" / "Message driver", with an unread count.
 *
 * Renders nothing unless the viewer is the sender or the driver on a parcel
 * whose chat is open (a driver has it and it is not yet delivered). Every
 * screen that shows a live job can drop this in without repeating that rule.
 */
export function ParcelChatButton({
  booking,
  size = 'md',
  style,
}: {
  booking: Pick<Booking, 'id' | 'driverId' | 'senderId' | 'status' | 'driver'>;
  size?: 'md' | 'lg';
  style?: React.ComponentProps<typeof Button>['style'];
}) {
  const theme = useTheme();
  const router = useRouter();
  const { user } = useSession();
  const role = chatRole(booking, user?.id);
  const unread = useUnreadMessages(booking, user?.id);

  if (!role || !chatIsOpen(booking)) return null;

  const label = role === 'driver' ? 'Message sender' : 'Message driver';

  return (
    <View style={styles.wrap}>
      <Button
        label={unread > 0 ? `${label} (${unread} new)` : label}
        variant={unread > 0 ? 'primary' : 'secondary'}
        size={size}
        icon={(color, iconSize) => <MessageCircle color={color} size={iconSize} />}
        onPress={() => router.navigate(`/messages/${booking.id}` as never)}
        accessibilityLabel={
          unread > 0 ? `${label}, ${unread} unread message${unread === 1 ? '' : 's'}` : label
        }
        style={style}
      />
      {unread > 0 && (
        <View style={[styles.dot, { backgroundColor: theme.danger }]}>
          <Text style={styles.dotText}>{unread > 9 ? '9+' : unread}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  dot: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotText: { color: '#FFFFFF', fontSize: 11, ...font(700) },
});
