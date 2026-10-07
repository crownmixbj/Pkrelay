import {
  PackageCheck,
  PackageSearch,
  CircleCheck,
  TriangleAlert,
  UserRound,
  UserRoundMinus,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { AdminError, Metric, adminStyles } from '@/components/ui/admin-shell';
import { AdminParcelDrawer } from '@/components/ui/admin-parcel-drawer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { showDialog } from '@/components/ui/dialog';
import { showToast } from '@/components/ui/toast';
import { SectionLabel } from '@/components/ui/screen';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  EMPTY_IN_FLIGHT,
  fetchParcelsInFlight,
  recordDelivery,
  releaseParcel,
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
  /** The parcel an operator is closing by hand, or null. */
  const [closing, setClosing] = useState<ParcelInFlight | null>(null);
  const [releasing, setReleasing] = useState<ParcelInFlight | null>(null);

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
                <ParcelRow
                  key={parcel.id}
                  parcel={parcel}
                  onOpen={() => setOpenId(parcel.id)}
                  onRelease={() => setReleasing(parcel)}
                />
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
                <ParcelRow
                  key={parcel.id}
                  parcel={parcel}
                  onOpen={() => setOpenId(parcel.id)}
                  onRecordDelivery={() => setClosing(parcel)}
                />
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

      <ReleaseParcelSheet
        parcel={releasing}
        onClose={() => setReleasing(null)}
        onReleased={() => {
          setReleasing(null);
          void load();
        }}
      />

      <RecordDeliverySheet
        parcel={closing}
        onClose={() => setClosing(null)}
        onRecorded={() => {
          setClosing(null);
          void load();
        }}
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
function ParcelRow({
  parcel,
  onOpen,
  onRecordDelivery,
  onRelease,
}: {
  parcel: ParcelInFlight;
  onOpen: () => void;
  /** Only passed for a collected parcel — there is nothing to close before that. */
  onRecordDelivery?: () => void;
  /** Only on an uncollected parcel — after that there is nothing to take back. */
  onRelease?: () => void;
}) {
  const theme = useTheme();

  const tone = stallTone(parcel.minutesSinceMove);
  const stalled = tone === 'danger';

  /*
   * ⚠ A Card with buttons, not a tappable card with a button inside it.
   *
   *   The first version wrapped the whole row in a Pressable and stopped
   *   propagation on the action — which `verify-layout.ts` rejects by name: a
   *   Button inside a Pressable that is itself a button is invalid DOM on web,
   *   and a tap on the inner control fires the outer one too. The dispatch queue
   *   below already settled this shape; this follows it.
   */
  return (
    <View>
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

        <View style={styles.rowActions}>
          <Button
            label="Open parcel"
            variant="secondary"
            size="md"
            onPress={onOpen}
          />
          {/*
            Only on an uncollected parcel, and it is the mirror of the one
            below: before collection the parcel can go back on the board,
            after it the only way out is recording the delivery.
          */}
          {!!onRelease && (
            <Button
              label="Take off driver"
              variant="secondary"
              size="md"
              icon={(color, size) => <UserRoundMinus color={color} size={size} />}
              onPress={onRelease}
            />
          )}
          {/* Only on a collected parcel — there is nothing to close before that. */}
          {!!onRecordDelivery && (
            <Button
              label="Record delivery"
              variant="secondary"
              size="md"
              icon={(color, size) => <CircleCheck color={color} size={size} />}
              onPress={onRecordDelivery}
            />
          )}
        </View>
      </Card>
    </View>
  );
}

/**
 * Closing a delivery the driver never recorded.
 *
 * ⚠ The consequences are listed before the button, because every one of them
 *   reaches somebody outside this screen: the sender is emailed that their
 *   parcel arrived, and the driver is paid for it. An operator who thought they
 *   were tidying a list has just told a customer their parcel is at its
 *   destination.
 */
function RecordDeliverySheet({
  parcel,
  onClose,
  onRecorded,
}: {
  parcel: ParcelInFlight | null;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const theme = useTheme();

  const [receivedBy, setReceivedBy] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!parcel) {
      setReceivedBy('');
      setReason('');
    }
  }, [parcel]);

  const submit = async () => {
    if (!parcel) return;

    setBusy(true);
    const outcome = await recordDelivery(parcel.id, receivedBy.trim(), reason.trim());
    setBusy(false);

    if (!outcome.ok) {
      /*
       * Verbatim. The server's refusals here each tell the operator what to do
       * instead — "that parcel has not been collected yet", "say how you know it
       * arrived" — and a generic failure would throw all of that away.
       */
      showDialog('Could not record that delivery', outcome.error);
      return;
    }

    showToast(`#${parcel.trackingId} marked delivered`, {
      message: 'The sender has been emailed and the driver has been credited.',
    });
    onRecorded();
  };

  return (
    <BottomSheet visible={!!parcel} onClose={onClose}>
      <View style={styles.sheet}>
        <Text style={[styles.sheetTitle, { color: theme.text }]}>
          Record delivery — #{parcel?.trackingId}
        </Text>
        <Text style={[styles.route, { color: theme.textSecondary }]}>
          {parcel?.originCity} → {parcel?.destinationCity} · carried by {parcel?.driverName}
        </Text>

        <Field
          label="Who received it"
          value={receivedBy}
          onChangeText={setReceivedBy}
          placeholder="Ngozi at reception"
          hint="The person who actually took it — often not the named recipient."
        />

        <Field
          label="How you know it arrived"
          value={reason}
          onChangeText={setReason}
          multiline
          numberOfLines={3}
          placeholder="Driver confirmed by phone; recipient called to say it came yesterday."
          hint="Recorded against your account, with your name on the parcel."
        />

        <View style={[styles.consequences, { backgroundColor: theme.warningSoft }]}>
          <Text style={[styles.consequenceText, { color: theme.warningOnSoft }]}>
            Marking this delivered will:
          </Text>
          <Text style={[styles.consequenceText, { color: theme.warningOnSoft }]}>
            · email the sender that their parcel arrived
          </Text>
          <Text style={[styles.consequenceText, { color: theme.warningOnSoft }]}>
            · credit {parcel ? formatNaira(parcel.estimatedFee) : 'the fare'} to the driver, less
            commission
          </Text>
          <Text style={[styles.consequenceText, { color: theme.warningOnSoft }]}>
            · record on the parcel that you closed it, not the driver
          </Text>
        </View>

        <View style={styles.sheetActions}>
          <Button
            label={busy ? 'Recording…' : 'Record delivery'}
            size="md"
            disabled={busy || receivedBy.trim().length < 2 || reason.trim().length < 4}
            icon={(color, size) => <CircleCheck color={color} size={size} />}
            onPress={() => void submit()}
          />
          <Button label="Cancel" variant="secondary" size="md" onPress={onClose} />
        </View>
      </View>
    </BottomSheet>
  );
}

/**
 * Taking a parcel back off a driver who has not collected it.
 *
 * ⚠ The milder sibling of `RecordDeliverySheet`, and the copy says so.
 *
 *   Recording a delivery tells a customer their parcel arrived and pays
 *   somebody; this moves a parcel back to a list. The consequence worth naming
 *   is the one that is not obvious: this driver stops being offered this parcel
 *   by the matcher, for good. An operator who expected the automation to retry
 *   them would otherwise read the parcel sitting unassigned as dispatch being
 *   broken.
 */
function ReleaseParcelSheet({
  parcel,
  onClose,
  onReleased,
}: {
  parcel: ParcelInFlight | null;
  onClose: () => void;
  onReleased: () => void;
}) {
  const theme = useTheme();

  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!parcel) setReason('');
  }, [parcel]);

  const submit = async () => {
    if (!parcel) return;

    setBusy(true);
    const outcome = await releaseParcel(parcel.id, reason.trim());
    setBusy(false);

    if (!outcome.ok) {
      /* Verbatim — the refusal for a collected parcel names the right tool. */
      showDialog('Could not take that parcel back', outcome.error);
      return;
    }

    showToast(`#${parcel.trackingId} is back on the board`, {
      message: `${parcel.driverName ?? 'The driver'} no longer has it, and will not be offered it again.`,
    });
    onReleased();
  };

  return (
    <BottomSheet visible={!!parcel} onClose={onClose}>
      <View style={styles.sheet}>
        <Text style={[styles.sheetTitle, { color: theme.text }]}>
          Take #{parcel?.trackingId} off {parcel?.driverName ?? 'the driver'}
        </Text>
        <Text style={[styles.route, { color: theme.textSecondary }]}>
          {parcel?.originCity} → {parcel?.destinationCity} · claimed{' '}
          {waitedLabel((parcel?.minutesSinceClaim ?? 0) / 60)} ago, never collected
        </Text>

        <Field
          label="Why"
          value={reason}
          onChangeText={setReason}
          multiline
          numberOfLines={3}
          placeholder="Not answering their phone; sender waiting since this morning."
          hint="Recorded against your account. The driver is told nothing else, so this is the only record of why."
        />

        <View style={[styles.consequences, { backgroundColor: theme.warningSoft }]}>
          <Text style={[styles.consequenceText, { color: theme.warningOnSoft }]}>
            Taking it off them will:
          </Text>
          <Text style={[styles.consequenceText, { color: theme.warningOnSoft }]}>
            · put the parcel back on the open board for any driver to claim
          </Text>
          <Text style={[styles.consequenceText, { color: theme.warningOnSoft }]}>
            · stop the matcher offering this parcel to {parcel?.driverName ?? 'them'} again
          </Text>
          <Text style={[styles.consequenceText, { color: theme.warningOnSoft }]}>
            · leave the sender&apos;s parcel untouched — nothing is cancelled
          </Text>
        </View>

        <View style={styles.sheetActions}>
          <Button
            label={busy ? 'Taking it back…' : 'Take off driver'}
            size="md"
            disabled={busy || reason.trim().length < 4}
            icon={(color, size) => <UserRoundMinus color={color} size={size} />}
            onPress={() => void submit()}
          />
          <Button label="Leave it with them" variant="secondary" size="md" onPress={onClose} />
        </View>
      </View>
    </BottomSheet>
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
  rowActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
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
  sheet: {
    gap: Spacing.three - 2,
  },
  sheetTitle: {
    ...Typography.meta,
    ...font(800),
  },
  sheetActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  consequences: {
    gap: Spacing.half,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
  },
  consequenceText: {
    ...Typography.caption,
    lineHeight: 18,
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
