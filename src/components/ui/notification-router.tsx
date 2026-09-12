import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { routeFor, type NotificationKind } from '@/store/notification-centre';

/**
 * Takes a person to whatever they tapped.
 *
 * Renders nothing. It exists because a push notification that opens the app on
 * whatever screen it was last on is a notification people learn not to tap —
 * and a dispatch offer is held for five minutes, so the extra navigation is a
 * meaningful share of the time available to answer it.
 *
 * Two entry points, and both are needed:
 *
 *   cold start   the app was closed. `getLastNotificationResponseAsync` is the
 *                only way to learn what opened it.
 *   warm         the app was backgrounded. The listener fires instead.
 *
 * ⚠ Two payload shapes, because two senders are live.
 *
 *   `notify-offer` sends `{ type: 'dispatch_offer' }` and has since 19.
 *   `notify-push` sends `{ kind, notificationId, booking_id, … }` for every
 *   notification in the inbox. Offers deliberately still go through the old
 *   sender (see the header of 50), so both shapes arrive on real devices today
 *   and dropping either one silently breaks a tap.
 *
 * ⚠ The destination comes from `routeFor`, not from the payload's `route` hint.
 *
 *   `notify-push/message.ts` puts a `route` string in the payload and this
 *   ignores it. One mapping, in `@/store/notification-centre`, decides where a
 *   notification goes — so a push and the same row in the inbox cannot open
 *   different screens. The hint costs nothing and stays for a future web push
 *   client that has no bundle to read the mapping from.
 */
export function NotificationRouter() {
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS === 'web') return;

    let cancelled = false;

    const open = (response: Notifications.NotificationResponse | null) => {
      if (cancelled || !response) return;

      const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;

      /*
       * The legacy offer push.
       *
       * To Assigned Trip, not to the parcel and not to the planner. Not the
       * parcel detail either: by the time a driver taps, the offer may have
       * gone to somebody else, and landing on "not yours" is worse than landing
       * on the screen that shows what is actually waiting.
       */
      if (data.type === 'dispatch_offer') {
        router.navigate('/driver');
        return;
      }

      const kind = typeof data.kind === 'string' ? (data.kind as NotificationKind) : null;
      if (!kind) return;

      /*
       * `data` values are always strings — Expo stringifies the payload — which
       * is exactly what `routeFor` reads out of `metadata`, so the same
       * function serves both callers without a second shape.
       */
      router.navigate(routeFor({ kind, metadata: data }) as never);
    };

    void Notifications.getLastNotificationResponseAsync().then(open);
    const subscription = Notifications.addNotificationResponseReceivedListener(open);

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [router]);

  return null;
}
