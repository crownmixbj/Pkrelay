import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useSession } from '@/store/session';
import {
  fetchNotifications,
  markAllRead,
  markRead,
  mergeNotification,
  subscribeToNotifications,
  unreadCount,
  type AppNotification,
} from '@/store/notification-centre';

/**
 * The notification inbox, live.
 *
 * One subscription per signed-in account, owned here rather than by a screen,
 * so the bell in the header and the list on the notifications tab read the same
 * state instead of each opening a channel and each being separately stale.
 *
 * ⚠ Three things refresh this, and all three are load-bearing.
 *
 *   1. mount              the initial read
 *   2. `resubscribed`     the socket came back — see the note on InboxEvent
 *   3. app foregrounded   iOS suspends the socket on background without always
 *                         reporting a disconnect, so a phone that was in a
 *                         pocket can resume with a channel that is nominally
 *                         subscribed and has missed everything.
 *
 *   Dropping any of them leaves the same symptom: an inbox that is right when
 *   you watch it and wrong whenever you look away, which is the only time it
 *   matters.
 */
export type NotificationCentre = {
  notifications: AppNotification[];
  unread: number;
  /** True only for the first load, so the list does not flash on a refresh. */
  loading: boolean;
  refresh: () => Promise<void>;
  open: (id: string) => void;
  readAll: () => Promise<void>;
};

export function useNotificationCentre(): NotificationCentre {
  const { viewerId } = useSession();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);

  /*
   * ⚠ Guards every setState against a viewer who has since changed.
   *
   *   Signing out mid-request would otherwise resolve the previous account's
   *   fetch into the new state — one person's notifications rendered under
   *   another person's session. `viewerId` is captured per effect run and
   *   compared on arrival rather than read from a closure that may be stale.
   */
  const activeViewer = useRef<string | null>(null);

  const load = useCallback(async (viewer: string) => {
    const rows = await fetchNotifications();
    if (activeViewer.current !== viewer) return;
    setNotifications(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    activeViewer.current = viewerId;

    if (!viewerId) {
      /* Signed out holds nothing. The inbox is personal data. */
      setNotifications([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    void load(viewerId);

    const unsubscribe = subscribeToNotifications(viewerId, (event) => {
      if (activeViewer.current !== viewerId) return;

      if (event.type === 'resubscribed') {
        void load(viewerId);
        return;
      }

      setNotifications((current) => mergeNotification(current, event.notification));
    });

    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') void load(viewerId);
    };
    const appState = AppState.addEventListener('change', onAppStateChange);

    return () => {
      unsubscribe();
      appState.remove();
    };
  }, [viewerId, load]);

  const refresh = useCallback(async () => {
    if (viewerId) await load(viewerId);
  }, [viewerId, load]);

  /**
   * Marks one read.
   *
   * ⚠ Optimistic, and it reverts.
   *
   *   Waiting for the round trip makes tapping a notification feel broken on a
   *   Nigerian mobile connection. But an optimistic update that silently keeps
   *   a failed write is worse than a slow one: the badge clears, the row greys
   *   out, and the next launch brings it all back with no explanation. So the
   *   row is restored exactly as it was if the RPC does not confirm.
   */
  const open = useCallback((id: string) => {
    let previous: AppNotification | undefined;

    setNotifications((current) => {
      previous = current.find((item) => item.id === id);
      if (!previous || previous.readAt) return current;
      return current.map((item) =>
        item.id === id ? { ...item, readAt: new Date().toISOString() } : item,
      );
    });

    void (async () => {
      if (!previous || previous.readAt) return;
      const ok = await markRead(id);
      if (ok) return;
      setNotifications((current) =>
        current.map((item) => (item.id === id ? { ...item, readAt: null } : item)),
      );
    })();
  }, []);

  const readAll = useCallback(async () => {
    const snapshot = notifications;
    const stamp = new Date().toISOString();
    setNotifications((current) =>
      current.map((item) => (item.readAt ? item : { ...item, readAt: stamp })),
    );

    const changed = await markAllRead();
    /* Same contract as `open`: a refused write puts the badge back. */
    if (changed === null) setNotifications(snapshot);
  }, [notifications]);

  return {
    notifications,
    unread: unreadCount(notifications),
    loading,
    refresh,
    open,
    readAll,
  };
}
