import { useRouter } from 'expo-router';
import { ArrowRight, TriangleAlert } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { AdminError, Metric, adminStyles } from '@/components/ui/admin-shell';
import { Button } from '@/components/ui/button';
import { SectionLabel } from '@/components/ui/screen';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { AdminParcelDrawer } from '@/components/ui/admin-parcel-drawer';
import { fetchOverview, type AdminOverview as Overview, type ParcelScope } from '@/store/admin';
import { REVIEW_WORKING_DAYS } from '@/store/driver-applications';

/**
 * Dashboard Overview.
 *
 * Every number comes from `admin_overview()`, a `security definer` function
 * that counts rows and returns integers. That shape is the point: "how many
 * parcels moved this week" is an operational question, and answering it does
 * not require an admin to be handed anyone's recipient address. There is
 * deliberately no admin read policy on `bookings`.
 *
 * Lives in `components/` rather than as its own route because the review queue
 * shares this screen — the overview's headline numbers *are* the queue's, and
 * two places computing "how many are waiting" would eventually disagree.
 */
export function AdminOverview({ onReview }: { onReview: () => void }) {
  const theme = useTheme();
  const router = useRouter();

  const [data, setData] = useState<Overview | null>(null);

  /** Null when the parcel drawer is closed. */
  const [drawer, setDrawer] = useState<{
    scope: ParcelScope;
    city?: string;
    title: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchOverview());
      setError(null);
    } catch (thrown) {
      /*
       * The most likely cause by far is that `20250101000007_admin.sql` has not been run,
       * and "function admin_overview does not exist" is not a message anyone
       * should have to decode.
       */
      const message = errorMessage(thrown, 'Could not load the overview.');
      setError(
        /does not exist|schema cache|404/i.test(message)
          ? 'The admin functions are missing. Run supabase/migrations/20250101000007_admin.sql in the SQL editor, then reload.'
          : message,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <ActivityIndicator color={theme.primary} style={styles.loading} />;
  }

  if (error) {
    return (
      <View style={styles.block}>
        <AdminError message={error} />
        <Button label="Try again" variant="secondary" size="md" onPress={() => void load()} />
      </View>
    );
  }

  if (!data) return null;

  const needsAttention = data.applicationsPending + data.applicationsUnderReview;

  return (
    <View style={styles.block}>
      {/*
        The one thing worth interrupting for.

        A queue with people waiting is the only state on this screen that is
        someone's problem right now, so it gets a banner and a way in rather
        than being one tile among twelve.
      */}
      {needsAttention > 0 && (
        <View style={[styles.alert, { backgroundColor: theme.warningSoft }]}>
          <TriangleAlert color={theme.warningOnSoft} size={18} />
          <View style={styles.alertText}>
            <Text style={[styles.alertTitle, { color: theme.warningOnSoft }]}>
              {needsAttention} application{needsAttention === 1 ? '' : 's'} waiting on you
            </Text>
            <Text style={[styles.alertBody, { color: theme.warningOnSoft }]}>
              The Drivers page promises a decision within {REVIEW_WORKING_DAYS} working days.
            </Text>
          </View>
          <Button
            label="Review"
            size="md"
            icon={(color, size) => <ArrowRight color={color} size={size} />}
            onPress={onReview}
          />
        </View>
      )}

      <SectionLabel>Applications</SectionLabel>
      <View style={adminStyles.metrics}>
        <Metric
          label="Awaiting review"
          value={data.applicationsPending}
          tone={data.applicationsPending > 0 ? 'warning' : 'neutral'}
        />
        <Metric label="In review" value={data.applicationsUnderReview} tone="primary" />
        <Metric label="Approved drivers" value={data.driversApproved} tone="success" />
        <Metric label="Rejected" value={data.applicationsRejected} />
      </View>

      <SectionLabel>Parcels</SectionLabel>
      <View style={adminStyles.metrics}>
        {/*
          Every parcel card opens the drawer.

          A number an operator cannot act on is a number they learn to ignore;
          the whole point of "14 unclaimed" is the question "which fourteen".
          The cards that are not about parcels — accounts, admins, errors — stay
          static, because there is no parcel list behind them.
        */}
        <ParcelMetric
          label="Booked in 7 days"
          value={data.parcelsLast7Days}
          tone="primary"
          onPress={() => setDrawer({ scope: 'all', title: 'All parcels' })}
        />
        {/*
          Unclaimed opens the drawer on a plain click, like every other parcel
          card.

          It used to toggle an inline destination list on click and open the
          drawer on a *long press*. On a desktop admin dashboard that is close
          to no affordance at all — there is no long press with a mouse beyond
          holding the button down and hoping — so the card read as the one that
          did not work. The destinations moved inside the drawer, where they are
          filter chips over the same list.
        */}
        <ParcelMetric
          label="Unclaimed"
          value={data.parcelsUnclaimed}
          tone={data.parcelsUnclaimed > 0 ? 'warning' : 'neutral'}
          onPress={() => setDrawer({ scope: 'unassigned', title: 'Unclaimed parcels' })}
        />
        <ParcelMetric
          label="In transit"
          value={data.parcelsInTransit}
          onPress={() => setDrawer({ scope: 'assigned', title: 'Parcels with a driver' })}
        />
        <ParcelMetric
          label="Delivered"
          value={data.parcelsDelivered}
          tone="success"
          onPress={() => setDrawer({ scope: 'all', title: 'All parcels' })}
        />
      </View>

      <SectionLabel>Platform</SectionLabel>
      <View style={adminStyles.metrics}>
        <Metric label="Accounts" value={data.users} />
        <Metric
          label="Admins"
          value={data.admins}
          tone={data.admins === 1 ? 'warning' : 'neutral'}
        />
        <Metric
          label="Errors, 24h"
          value={data.errorsLast24h}
          tone={data.errorsLast24h > 0 ? 'danger' : 'success'}
        />
        <Metric label="Parcels, all time" value={data.parcelsTotal} />
      </View>

      {/*
        One admin is a single point of failure: lose that password and nobody
        can approve a driver without database access. Worth saying once, where
        the number is.
      */}
      {data.admins === 1 && (
        <View style={[styles.note, { backgroundColor: theme.warningSoft }]}>
          <Text style={[styles.noteText, { color: theme.warningOnSoft }]}>
            You are the only administrator. If you lose access to this account, nobody can approve a
            driver without going into the database directly — promote a second person under User &
            Role Mgmt.
          </Text>
        </View>
      )}

      <Button
        label="Refresh"
        variant="secondary"
        size="md"
        onPress={() => void load()}
        style={styles.refresh}
      />

      <Button
        label="Open system logs"
        variant="secondary"
        size="md"
        onPress={() => router.navigate('/admin-logs')}
      />

      <AdminParcelDrawer
        scope={drawer?.scope ?? null}
        city={drawer?.city}
        title={drawer?.title ?? ''}
        onClose={() => setDrawer(null)}
      />
    </View>
  );
}

/**
 * A stat card that opens the parcel drawer.
 *
 * Wraps `Metric` rather than replacing it, so a tappable card and a static one
 * are pixel-identical apart from the hint — the row would otherwise stop lining
 * up the moment one card became interactive.
 */
function ParcelMetric({
  label,
  value,
  tone,
  onPress,
}: {
  label: string;
  value: number;
  tone?: 'primary' | 'success' | 'warning' | 'neutral';
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}. Open the parcel list.`}
      style={({ pressed }) => [adminStyles.metricSlot, pressed && { opacity: 0.6 }]}>
      <Metric label={label} value={value} tone={tone} hint="Tap to open" nested />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  breakdown: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.md,
    marginBottom: Spacing.four,
    overflow: 'hidden',
  },
  breakdownLoading: {
    paddingVertical: Spacing.four,
    marginBottom: Spacing.four,
    alignItems: 'center',
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
  },
  breakdownCity: {
    ...Typography.meta,
    ...font(600),
    flex: 1,
  },
  breakdownFacts: {
    alignItems: 'flex-end',
    gap: 1,
  },
  breakdownCount: {
    ...Typography.meta,
    ...font(700),
  },
  breakdownMeta: {
    ...Typography.caption,
  },
  breakdownEmpty: {
    ...Typography.caption,
    padding: Spacing.three,
  },
  block: {
    marginTop: Spacing.three,
  },
  loading: {
    marginVertical: Spacing.six,
  },
  alert: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two + 2,
    padding: Spacing.three,
    borderRadius: Radius.md,
    marginBottom: Spacing.four,
  },
  alertText: {
    flex: 1,
    flexBasis: 200,
    gap: Spacing.half,
  },
  alertTitle: {
    ...Typography.meta,
    ...font(700),
  },
  alertBody: {
    ...Typography.caption,
    lineHeight: 18,
  },
  note: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    marginBottom: Spacing.four,
  },
  noteText: {
    ...Typography.caption,
    ...font(600),
    lineHeight: 19,
  },
  refresh: {
    marginBottom: Spacing.two,
  },
});
