import { PackageCheck, PackageSearch, TriangleAlert, UserRound } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { AdminError, Metric, adminStyles } from '@/components/ui/admin-shell';
import { AdminParcelDrawer } from '@/components/ui/admin-parcel-drawer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SectionLabel } from '@/components/ui/screen';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  EMPTY_IN_FLIGHT,
  fetchParcelsInFlight,
  stallTone,
  waitedLabel,
  type InFlightTotals,
  type ParcelInFlight,
} from '@/store/admin';
import { formatNaira } from '@/store/bookings';

/**
 * In transit — what has been collected from the sender, and what has not.
 *
 * ⚠ The two groups are the point. One list of "parcels with a driver" hides the
 *   failure that matters.
 *
 *   A parcel claimed three days ago and never collected looks, in every existing
 *   view, exactly like one collected an hour ago: both have a driver, neither is
 *   delivered. But nothing happens when a collection does not happen — there is
 *   no event, no notification, no row anywhere — so the only way it surfaces is
 *   if somebody is looking for it. This screen is somebody looking for it.
 *
 * ⚠ Collected is the pickup timestamp, not the status. See `ParcelInFlight`.
 *
 * ⚠ Read-only, deliberately. 10 lets only the carrying driver advance a parcel,
 *   so that the record of who handled it is never ambiguous; an admin override
 *   here would be a different act needing its own audit trail, not a button on
 *   a monitoring board.
 */
export function ParcelsInFlight() {
  const theme = useTheme();

  const [rows, setRows] = useState<ParcelInFlight[] | null>(null);
  const [totals, setTotals] = useState<InFlightTotals>(EMPTY_IN_FLIGHT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await fetchParcelsInFlight();

    if (result === null) {
      setRows(null);
      setTotals(EMPTY_IN_FLIGHT);
      setError(
        'The in-flight board could not be read. Parcels are still moving — what is missing is the answer, not the parcels.',
      );
    } else {
      setRows(result.rows);
      setTotals(result.totals);
      setError(null);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const awaiting = (rows ?? []).filter((row) => !row.collected);
  const moving = (rows ?? []).filter((row) => row.collected);

  return (
    <View style={styles.wrap}>
      <View style={adminStyles.metrics}>
        <Metric
          label="Awaiting collection"
          value={totals.awaitingCollection}
          tone={totals.awaitingCollection > 0 ? 'warning' : 'neutral'}
          hint="Claimed by a driver, not yet picked up."
        />
        <Metric
          label="Collected, moving"
          value={totals.collected}
          tone="primary"
          hint="Taken from the sender and on the way."
        />
        <Metric
          label="No move in 24h"
          value={totals.stalled}
          tone={totals.stalled > 0 ? 'danger' : 'success'}
          hint="At any stage. Somebody should ring the driver."
        />
        <Metric label="In flight" value={totals.inFlight} />
      </View>

      {!!error && <AdminError message={error} />}

      {loading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : rows === null ? null : (
        <>
          {/* ------------------------------------- claimed, not collected -- */}
          <SectionLabel>Awaiting collection from the sender</SectionLabel>
          {awaiting.length === 0 ? (
            <Card style={styles.empty}>
              <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
                Every claimed parcel has been collected. A driver who claims one and does not pick
                it up appears here.
              </Text>
            </Card>
          ) : (
            <View style={styles.list}>
              {awaiting.map((parcel) => (
                <ParcelRow key={parcel.id} parcel={parcel} onOpen={() => setOpenId(parcel.id)} />
              ))}
            </View>
          )}

          {/* --------------------------------------------- collected, moving */}
          <SectionLabel>Collected and in transit</SectionLabel>
          {moving.length === 0 ? (
            <Card style={styles.empty}>
              <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
                Nothing is on the road right now.
              </Text>
            </Card>
          ) : (
            <View style={styles.list}>
              {moving.map((parcel) => (
                <ParcelRow key={parcel.id} parcel={parcel} onOpen={() => setOpenId(parcel.id)} />
              ))}
            </View>
          )}
        </>
      )}

      <Button label="Refresh" variant="secondary" size="md" onPress={() => void load()} />

      {/*
        The existing drawer, opened on one parcel.

        Everything an operator needs next — the photographs, the timings, the
        audited "show contact details" reveal — is already in it, and a second
        one would be a second place for that reveal to drift.
      */}
      <AdminParcelDrawer
        scope={null}
        focusId={openId}
        title="Parcel"
        onClose={() => setOpenId(null)}
      />
    </View>
  );
}

/**
 * One parcel on the board.
 *
 * ⚠ The elapsed time leads, because it is the only field that ranks the rows. An
 *   operator scanning twenty of these reads the first column and the colour, and
 *   nothing else.
 */
function ParcelRow({ parcel, onOpen }: { parcel: ParcelInFlight; onOpen: () => void }) {
  const theme = useTheme();

  const tone = stallTone(parcel.minutesSinceMove);
  const stalled = tone === 'danger';

  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${parcel.trackingId}, ${parcel.status}. Open the parcel.`}
      style={({ pressed }) => [styles.slot, pressed && { opacity: 0.7 }]}>
      <Card style={styles.card}>
        <View style={styles.head}>
          <View style={styles.headText}>
            <Text style={[styles.tracking, { color: theme.text }]}>#{parcel.trackingId}</Text>
            <Text style={[styles.route, { color: theme.textSecondary }]} numberOfLines={1}>
              {parcel.originCity} → {parcel.destinationCity} · {parcel.weight} kg ·{' '}
              {formatNaira(parcel.estimatedFee)}
            </Text>
          </View>
          <View style={styles.headRight}>
            <Badge label={parcel.status} tone={parcel.collected ? 'primary' : 'neutral'} />
            <Badge label={waitedLabel(parcel.minutesSinceMove / 60)} tone={tone} />
          </View>
        </View>

        <View style={styles.facts}>
          <View style={styles.fact}>
            <UserRound color={theme.textMuted} size={13} />
            <Text style={[styles.factText, { color: theme.textSecondary }]} numberOfLines={1}>
              {parcel.driverName}
            </Text>
          </View>

          {parcel.collected ? (
            <View style={styles.fact}>
              <PackageCheck color={theme.primary} size={13} />
              <Text style={[styles.factText, { color: theme.textSecondary }]}>
                Collected {waitedLabel(minutesSince(parcel.pickedUpAt) / 60)} ago
              </Text>
            </View>
          ) : (
            <View style={styles.fact}>
              <PackageSearch color={theme.warningOnSoft} size={13} />
              <Text style={[styles.factText, { color: theme.warningOnSoft }]}>
                Claimed {waitedLabel(parcel.minutesSinceClaim / 60)} ago · never collected
              </Text>
            </View>
          )}
        </View>

        {/*
          Said out loud rather than left to the colour of a badge.

          A day without a move is not a slow delivery, it is a parcel nobody is
          carrying — and the person who can tell you which is the driver, by
          phone. Colour alone gets read as decoration.
        */}
        {stalled && (
          <View style={[styles.alert, { backgroundColor: theme.dangerSoft }]}>
            <TriangleAlert color={theme.dangerOnSoft} size={14} />
            <Text style={[styles.alertText, { color: theme.dangerOnSoft }]}>
              {parcel.collected
                ? 'No movement for over a day since it was collected. Ring the driver.'
                : 'Claimed over a day ago and still not collected. The sender is waiting on somebody who has not come.'}
            </Text>
          </View>
        )}
      </Card>
    </Pressable>
  );
}

/** Minutes since a timestamp, or 0 when there isn't one. */
function minutesSince(timestamp: string | null): number {
  if (!timestamp) return 0;
  const ms = Date.now() - Date.parse(timestamp);
  return Number.isFinite(ms) && ms > 0 ? ms / 60_000 : 0;
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: Spacing.three,
    gap: Spacing.two,
  },
  loading: {
    marginVertical: Spacing.six,
  },
  list: {
    gap: Spacing.two + 2,
    marginBottom: Spacing.three,
  },
  empty: {
    marginBottom: Spacing.three,
  },
  emptyText: {
    ...Typography.meta,
    lineHeight: 20,
  },
  slot: {
    cursor: 'pointer',
  },
  card: {
    gap: Spacing.two,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  headText: {
    flex: 1,
    gap: Spacing.half,
  },
  headRight: {
    alignItems: 'flex-end',
    gap: Spacing.one,
  },
  tracking: {
    ...Typography.meta,
    ...font(700),
  },
  route: {
    ...Typography.caption,
  },
  facts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  fact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    flexShrink: 1,
  },
  factText: {
    ...Typography.caption,
  },
  alert: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.one + 2,
    padding: Spacing.two,
    borderRadius: Radius.md,
  },
  alertText: {
    ...Typography.caption,
    flex: 1,
    lineHeight: 18,
  },
});
