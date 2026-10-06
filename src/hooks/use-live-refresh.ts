import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

/**
 * Keeps a screen's data current without anybody pressing reload.
 *
 * Three triggers, because no single one is enough on its own:
 *
 *   1. Realtime. A row changes in one of `tables` and the screen reloads within
 *      a second. This is what makes a newly booked parcel or a driver going on
 *      shift appear while the operator is looking.
 *
 *   2. A steady poll. Some of what a queue shows is not a row change at all —
 *      a wait badge ticking from 19 to 20 minutes, an offer expiring on the
 *      clock, the dispatch mode living in `private.app_settings`, which Realtime
 *      cannot see. The poll also covers a websocket that has quietly dropped,
 *      which is the failure nobody notices until the screen has been wrong for
 *      an hour.
 *
 *   3. Coming back. Returning to the tab (web) or the app (native) reloads at
 *      once rather than waiting for the next poll, so the first thing an
 *      operator sees after a coffee is not stale.
 *
 * ⚠ The payload is ignored on purpose. Realtime says *that* something changed;
 *   the screen then asks the same `security definer` RPCs it always asks. The
 *   numbers on screen therefore have exactly one source, and a realtime event
 *   can never paint a row the RPC would not have returned.
 *
 * ⚠ Bursts collapse into one reload. Assigning a parcel touches the booking,
 *   closes an offer and updates a journey — three events within milliseconds.
 *   They are debounced, and a reload that arrives while one is running is
 *   queued once rather than run in parallel.
 */
export function useLiveRefresh(
  refresh: () => Promise<void>,
  {
    channel,
    tables,
    filter,
    intervalMs = 20_000,
    debounceMs = 400,
    enabled = true,
  }: {
    /** Unique per screen; two screens sharing a name would share a channel. */
    channel: string;
    /** `public` tables to listen to. Each must be in the `supabase_realtime` publication. */
    tables: string[];
    /**
     * A Realtime row filter applied to every table, e.g. `driver_id=eq.<uuid>`.
     * RLS already limits what arrives; this just stops the server sending it.
     */
    filter?: string;
    intervalMs?: number;
    debounceMs?: number;
    enabled?: boolean;
  },
): { lastUpdated: Date | null; connected: boolean } {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [connected, setConnected] = useState(false);

  /* Latest `refresh`, so a new closure does not tear down the subscription. */
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const running = useRef(false);
  const queued = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async () => {
    if (running.current) {
      queued.current = true;
      return;
    }
    running.current = true;
    try {
      // A change that lands mid-reload gets exactly one more pass, not many.
      do {
        queued.current = false;
        await refreshRef.current();
        setLastUpdated(new Date());
      } while (queued.current);
    } finally {
      running.current = false;
    }
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void run();
    }, debounceMs);
  }, [run, debounceMs]);

  const tableKey = tables.join(',');

  // Realtime.
  useEffect(() => {
    if (!enabled) return;

    let live = supabase.channel(channel);
    for (const table of tableKey.split(',').filter(Boolean)) {
      live = live.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        schedule,
      );
    }
    live.subscribe((status) => {
      setConnected(status === 'SUBSCRIBED');
      // Anything missed while the socket was down is picked up on reconnect.
      if (status === 'SUBSCRIBED') schedule();
    });

    return () => {
      setConnected(false);
      void supabase.removeChannel(live);
    };
  }, [channel, tableKey, filter, enabled, schedule]);

  // The poll, paused while the tab is hidden — nobody is reading it.
  useEffect(() => {
    if (!enabled) return;

    const id = setInterval(() => {
      if (Platform.OS === 'web' && typeof document !== 'undefined' && document.hidden) return;
      void run();
    }, intervalMs);

    return () => clearInterval(id);
  }, [enabled, intervalMs, run]);

  // Coming back to the tab or the app.
  useEffect(() => {
    if (!enabled) return;

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const onVisible = () => {
        if (!document.hidden) schedule();
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => document.removeEventListener('visibilitychange', onVisible);
    }

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') schedule();
    });
    return () => sub.remove();
  }, [enabled, schedule]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { lastUpdated, connected };
}
