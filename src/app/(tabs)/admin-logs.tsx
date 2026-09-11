import { CircleAlert, CircleCheck, FileWarning, TriangleAlert } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { AdminError, AdminShell } from '@/components/ui/admin-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipGroup } from '@/components/ui/chip';
import { EmptyState } from '@/components/ui/screen';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fetchEvents, type AppEvent, type EventLevel } from '@/store/admin';
import { useSession } from '@/store/session';

const LEVELS = ['all', 'error', 'warning', 'info'] as const;
type Filter = (typeof LEVELS)[number];

const LEVEL_LABELS: Record<Filter, string> = {
  all: 'All',
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
};

/**
 * System Logs & Errors.
 *
 * Reads `public.app_events`, which is insert-only for clients and readable only
 * by an admin — see `supabase/migrations/20250101000007_admin.sql`. A log the app could read back is a
 * log an attacker could read back, and error text is often the most revealing
 * string in a system.
 *
 * The table is new, so it starts empty. That is worth saying on screen: an
 * empty error log and a broken error log look identical, and someone should not
 * have to guess which they are looking at.
 */
export default function AdminLogsScreen() {
  const theme = useTheme();
  const { isAdmin } = useSession();

  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await fetchEvents({ level: filter === 'all' ? 'all' : (filter as EventLevel) }));
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not load the log.'));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    void load();
  }, [isAdmin, load]);

  return (
    <AdminShell
      title="System Logs & Errors"
      subtitle="What the app recorded going wrong, newest first."
      next="/admin-logs">
      {!!error && <AdminError message={error} />}

      <View style={styles.filters}>
        <ChipGroup
          options={LEVELS as unknown as string[]}
          selected={filter}
          onSelect={(value) => setFilter(value as Filter)}
          renderLabel={(value) => LEVEL_LABELS[value as Filter]}
          scrollable
        />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : events.length === 0 ? (
        <Card style={styles.emptyCard}>
          <EmptyState
            icon={(color, size) => <CircleCheck color={color} size={size} />}
            title={filter === 'all' ? 'Nothing logged' : `No ${LEVEL_LABELS[filter].toLowerCase()}`}
            message="Either nothing has gone wrong, or nothing has called logEvent yet."
          />
          {/*
            The distinction matters. An empty log reads as "all is well", and
            for a table added five minutes ago that reading is wrong. Naming the
            function to call turns a dead end into a next step.
          */}
          <View style={[styles.hint, { backgroundColor: theme.primarySoft }]}>
            <Text style={[styles.hintText, { color: theme.primaryOnSoft }]}>
              This log fills only where the app calls <Text style={font(700)}>logEvent()</Text> from{' '}
              <Text style={font(700)}>store/admin.ts</Text>. It is wired up but not yet called from
              the places worth watching — failed uploads, refused claims, auth errors.
            </Text>
          </View>
        </Card>
      ) : (
        <Card style={styles.list}>
          {events.map((event, index) => (
            <EventRow key={event.id} event={event} first={index === 0} />
          ))}
        </Card>
      )}

      <Button label="Refresh" variant="secondary" size="md" onPress={() => void load()} />

      <Text style={[styles.footnote, { color: theme.textMuted }]}>
        Events are kept indefinitely — there is no cleanup job yet. Add one before this table gets
        large; a month of history is usually enough for an error log.
      </Text>
    </AdminShell>
  );
}

function EventRow({ event, first }: { event: AppEvent; first: boolean }) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);

  const color =
    event.level === 'error'
      ? theme.danger
      : event.level === 'warning'
        ? theme.warningOnSoft
        : theme.textMuted;

  const hasContext = Object.keys(event.context).length > 0;

  return (
    <View
      style={[
        styles.event,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
      ]}>
      <View style={styles.eventHead}>
        {event.level === 'error' ? (
          <CircleAlert color={color} size={16} />
        ) : event.level === 'warning' ? (
          <TriangleAlert color={color} size={16} />
        ) : (
          <FileWarning color={color} size={16} />
        )}
        <Text style={[styles.area, { color: theme.text }]}>{event.area}</Text>
        <Text style={[styles.when, { color: theme.textMuted }]}>
          {new Date(event.createdAt).toLocaleString()}
        </Text>
      </View>

      <Text style={[styles.message, { color: theme.textSecondary }]}>{event.message}</Text>

      {hasContext && (
        <Pressable
          onPress={() => setExpanded((value) => !value)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={6}>
          <Text style={[styles.toggle, { color: theme.primary }]}>
            {expanded ? 'Hide details' : 'Show details'}
          </Text>
        </Pressable>
      )}

      {expanded && hasContext && (
        <View style={[styles.context, { backgroundColor: theme.surfaceMuted }]}>
          <Text style={[styles.contextText, { color: theme.textSecondary }]}>
            {JSON.stringify(event.context, null, 2)}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  filters: {
    marginBottom: Spacing.three,
  },
  loading: {
    marginVertical: Spacing.six,
  },
  emptyCard: {
    gap: Spacing.three,
    marginBottom: Spacing.three,
  },
  hint: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
  },
  hintText: {
    ...Typography.caption,
    lineHeight: 19,
  },
  list: {
    gap: 0,
    marginBottom: Spacing.three,
  },
  event: {
    gap: Spacing.one,
    paddingVertical: Spacing.three - 2,
  },
  eventHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  area: {
    ...Typography.meta,
    ...font(700),
    flex: 1,
  },
  when: {
    ...Typography.caption,
  },
  message: {
    ...Typography.caption,
    lineHeight: 19,
  },
  toggle: {
    ...Typography.caption,
    ...font(700),
    paddingTop: Spacing.half,
  },
  context: {
    padding: Spacing.two,
    borderRadius: Radius.sm,
  },
  contextText: {
    ...Typography.caption,
    // Monospace so keys line up; JSON in a proportional face is unreadable.
    fontFamily: 'monospace',
    lineHeight: 17,
  },
  footnote: {
    ...Typography.caption,
    lineHeight: 18,
    marginTop: Spacing.three,
  },
});
