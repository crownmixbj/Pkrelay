import {
  CircleAlert,
  Clock,
  PackageCheck,
  PackageSearch,
  Phone,
  TriangleAlert,
  UserRoundCheck,
  UsersRound,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { showDialog } from '@/components/ui/dialog';
import { EmptyState, SectionLabel } from '@/components/ui/screen';
import { showToast } from '@/components/ui/toast';
import { FontSize, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatNaira } from '@/store/bookings';
import {
  assignParcel,
  fetchDriverAvailability,
  fetchParcelsForDriver,
  fetchWaitingDrivers,
  shiftLabel,
  waitLabel,
  type DriverAvailability,
  type ParcelForDriver,
  type WaitingDriver,
} from '@/store/dispatch-mode';

/**
 * Drivers on shift with nothing to carry.
 *
 * ⚠ The inverse of the queue below it, and the pair is the point.
 *
 *   "Why has this parcel not moved" and "why is this driver idle" are the same
 *   failure seen from the two ends, and an operator holding one of them in
 *   another tab is doing the matching in their head. Nine parcels waiting above
 *   four drivers waiting is a sentence; either half alone is a number.
 *
 * ⚠ What this list means depends on the mode, and the copy says so.
 *
 *   In manual mode it is the work queue — nobody is being offered anything, so
 *   every driver on shift sits here until somebody places a parcel. In
 *   automatic mode a driver only reaches this list if the matcher could not
 *   place them, so a row with parcels available next to it is the automation
 *   failing, not an idle driver.
 *
 * ⚠ Nothing here is the security boundary. `is_admin()` inside
 *   `admin_waiting_drivers` is — see `20250101000070_driver_availability.sql`.
 *   A non-admin reaching this component sees an empty list.
 */
export function DriversWaiting({
  mode,
  onAssigned,
}: {
  /** Drives the copy only. Null while the dispatch mode is unknown. */
  mode: 'auto' | 'manual' | null;
  /** Called after a successful assignment, so the parcel queue reloads too. */
  onAssigned: () => void;
}) {
  const theme = useTheme();

  const [tiles, setTiles] = useState<DriverAvailability | null>(null);
  const [drivers, setDrivers] = useState<WaitingDriver[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [giving, setGiving] = useState<WaitingDriver | null>(null);

  const refresh = useCallback(async () => {
    const [counts, waiting] = await Promise.all([
      fetchDriverAvailability(),
      fetchWaitingDrivers(),
    ]);
    setTiles(counts);
    setDrivers(waiting);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * Null means the call failed; an empty array means nobody is waiting. The
   * difference is the whole reason this component does not render "0 waiting"
   * on a query that never returned — the same mistake the dispatch banner was
   * built to stop making.
   */
  const unavailable = drivers === null;

  return (
    <View style={styles.wrap}>
      <SectionLabel>Drivers waiting for work</SectionLabel>

      <Card style={styles.card}>
        <View style={styles.head}>
          <UsersRound color={theme.primary} size={18} />
          <Text style={[styles.title, { color: theme.text }]}>
            {unavailable
              ? 'Driver availability unavailable'
              : `${tiles?.waiting ?? 0} on shift, nothing in hand`}
          </Text>
        </View>

        {unavailable ? (
          <View style={[styles.banner, { backgroundColor: theme.dangerSoft }]}>
            <CircleAlert color={theme.dangerOnSoft} size={16} />
            <Text style={[styles.bannerText, { color: theme.dangerOnSoft }]}>
              This list could not be read. Drivers may well be waiting — what is missing is the
              answer, not the drivers.
            </Text>
          </View>
        ) : (
          <>
            {/*
              Four of these five numbers are about drivers who are NOT in the
              list, which is the question somebody asks the moment it is shorter
              than they expected.
            */}
            <View style={[styles.stats, { backgroundColor: theme.surfaceMuted }]}>
              <Stat label="Waiting" value={String(tiles?.waiting ?? 0)} tone="primary" />
              <View style={[styles.statRule, { backgroundColor: theme.border }]} />
              <Stat label="Deciding" value={String(tiles?.withOffer ?? 0)} />
              <View style={[styles.statRule, { backgroundColor: theme.border }]} />
              <Stat label="Carrying" value={String(tiles?.carrying ?? 0)} />
              <View style={[styles.statRule, { backgroundColor: theme.border }]} />
              <Stat label="Off shift" value={String(tiles?.offShift ?? 0)} />
            </View>

            {/*
              Shown only when there are some. A driver on shift whose document
              has expired is the one number here that is somebody's job today:
              they think they are working, the matcher will not use them, and
              hand assignment refuses them too.
            */}
            {!!tiles?.blocked && tiles.blocked > 0 && (
              <View style={[styles.banner, { backgroundColor: theme.warningSoft }]}>
                <TriangleAlert color={theme.warningOnSoft} size={16} />
                <Text style={[styles.bannerText, { color: theme.warningOnSoft }]}>
                  {tiles.blocked} driver{tiles.blocked === 1 ? ' is' : 's are'} on shift with an
                  expired document and cannot be given anything — by the matcher or by hand. They
                  are not in the list below.
                </Text>
              </View>
            )}
          </>
        )}
      </Card>

      {loading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : unavailable ? null : drivers.length === 0 ? (
        <EmptyState
          icon={(color, size) => <UsersRound color={color} size={size} />}
          title="Nobody is waiting"
          message={
            (tiles?.offShift ?? 0) > 0
              ? `No driver is on shift with free hands. ${tiles?.offShift} approved driver(s) have not declared one today.`
              : 'Every driver on shift is deciding on an offer or already carrying something.'
          }
        />
      ) : (
        <View style={styles.list}>
          {drivers.map((driver) => (
            <DriverRow
              key={driver.journeyId}
              driver={driver}
              mode={mode}
              onGive={() => setGiving(driver)}
            />
          ))}
        </View>
      )}

      <GiveParcelSheet
        driver={giving}
        onClose={() => setGiving(null)}
        onAssigned={() => {
          setGiving(null);
          void refresh();
          onAssigned();
        }}
      />
    </View>
  );
}

/**
 * One driver, and whether anything exists for them to take.
 *
 * ⚠ `matchingParcels` is the field that decides how the row reads.
 *
 *   None available is a driver nobody can help right now — informational. Some
 *   available is either a parcel waiting to be placed (manual mode) or the
 *   matcher failing to place it (auto), and both are somebody's next action.
 */
function DriverRow({
  driver,
  mode,
  onGive,
}: {
  driver: WaitingDriver;
  mode: 'auto' | 'manual' | null;
  onGive: () => void;
}) {
  const theme = useTheme();

  const hasWork = driver.matchingParcels > 0;

  return (
    <Card style={styles.driver}>
      <View style={styles.driverHead}>
        <View style={styles.driverText}>
          <Text style={[styles.name, { color: theme.text }]}>{driver.fullName}</Text>
          <Text style={[styles.shift, { color: theme.textSecondary }]}>
            {shiftLabel(driver)} · {driver.vehicleType} · {driver.capacityKg} kg free
          </Text>
        </View>
        {/*
          How long they have been sitting there, toned like the parcel queue's
          wait badge so the two lists read on the same scale.
        */}
        <Badge
          label={waitLabel(driver.waitingMinutes)}
          tone={
            driver.waitingMinutes >= 120
              ? 'danger'
              : driver.waitingMinutes >= 45
                ? 'warning'
                : 'neutral'
          }
        />
      </View>

      <View style={styles.tags}>
        <Badge
          label={driver.mode === 'flash' ? 'Flash shift' : 'Scheduled route'}
          tone="neutral"
          uppercase={false}
        />
        {driver.leavesInMinutes <= 60 && (
          <Badge
            label={`Leaves in ${waitLabel(Math.max(driver.leavesInMinutes, 0))}`}
            tone="warning"
            uppercase={false}
          />
        )}
        {driver.inCooldown && (
          /*
            Why the matcher is skipping them, said plainly. Without this the
            operator sees an idle driver beside a matching parcel and concludes
            dispatch is broken — it is working exactly as 23 intended.
          */
          <Badge label="In cooldown after a decline" tone="neutral" uppercase={false} />
        )}
        {driver.deliveredToday > 0 && (
          <Badge
            label={`${driver.deliveredToday} delivered today`}
            tone="success"
            uppercase={false}
          />
        )}
      </View>

      <View style={styles.availability}>
        {hasWork ? (
          <>
            <PackageSearch color={theme.warningOnSoft} size={14} />
            <Text style={[styles.availabilityText, { color: theme.warningOnSoft }]}>
              {driver.matchingParcels} parcel{driver.matchingParcels === 1 ? '' : 's'} they could
              take
              {mode === 'auto'
                ? ' — automatic matching has not placed them, so something is holding it up.'
                : '.'}
            </Text>
          </>
        ) : (
          <>
            <PackageCheck color={theme.textMuted} size={14} />
            <Text style={[styles.availabilityText, { color: theme.textMuted }]}>
              Nothing waiting on their route.
            </Text>
          </>
        )}
      </View>

      <View style={styles.driverActions}>
        <Button
          label="Give them a parcel"
          variant={hasWork ? 'primary' : 'secondary'}
          size="md"
          icon={(color, size) => <UserRoundCheck color={color} size={size} />}
          onPress={onGive}
        />
        {/*
          The number, selectable rather than a tel: link.

          This screen is used on a laptop far more than on a phone, where a
          `tel:` does nothing but open a dialog about handlers. Selectable text
          can be copied into whatever the operator actually dials.
        */}
        {!!driver.phone && (
          <View style={styles.phone}>
            <Phone color={theme.textMuted} size={13} />
            <Text selectable style={[styles.phoneText, { color: theme.textSecondary }]}>
              {driver.phone}
            </Text>
          </View>
        )}
      </View>
    </Card>
  );
}

/**
 * The parcels one driver could be given.
 *
 * ⚠ Off-route parcels are listed, marked, and assignable — `assignable_drivers`
 *   made the same call in the other direction and for the same reason. The
 *   operator is the one who knows the driver is standing in the hub with an
 *   undeclared route; a list that hid everything the matcher would skip would
 *   be a slower copy of the matcher.
 */
function GiveParcelSheet({
  driver,
  onClose,
  onAssigned,
}: {
  driver: WaitingDriver | null;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const theme = useTheme();

  const [parcels, setParcels] = useState<ParcelForDriver[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!driver) {
      setParcels(null);
      return;
    }

    let cancelled = false;
    void fetchParcelsForDriver(driver.driverId).then((rows) => {
      if (!cancelled) setParcels(rows);
    });

    return () => {
      cancelled = true;
    };
  }, [driver]);

  const give = async (parcel: ParcelForDriver) => {
    if (!driver) return;

    setBusy(parcel.id);
    const outcome = await assignParcel(parcel.id, driver.driverId);
    setBusy(null);

    if (!outcome.ok) {
      /*
       * The server's message, verbatim. Its four refusals are each written for
       * the person reading them — "that parcel already has a driver", "an
       * expired document" — and a generic failure would throw away the only
       * part that says what to do instead.
       */
      showDialog('Could not assign that parcel', outcome.error);
      return;
    }

    showToast(`#${parcel.trackingId} assigned`, {
      message: `${driver.fullName} has been notified and the sender has been told.`,
    });
    onAssigned();
  };

  return (
    <BottomSheet visible={!!driver} onClose={onClose}>
      <View style={styles.sheet}>
        <Text style={[styles.sheetTitle, { color: theme.text }]}>
          Give {driver?.fullName} a parcel
        </Text>
        {!!driver && (
          <Text style={[styles.shift, { color: theme.textSecondary }]}>
            {shiftLabel(driver)} · {driver.capacityKg} kg free · waiting{' '}
            {waitLabel(driver.waitingMinutes)}
          </Text>
        )}

        {parcels === null ? (
          <ActivityIndicator color={theme.primary} style={styles.loading} />
        ) : parcels.length === 0 ? (
          <EmptyState
            icon={(color, size) => <PackageSearch color={color} size={size} />}
            title="No parcel to give"
            message="Nothing is waiting for a driver at all — not on their route, and not anywhere else."
          />
        ) : (
          <View style={styles.list}>
            {parcels.map((parcel) => (
              <Pressable
                key={parcel.id}
                onPress={() => void give(parcel)}
                disabled={busy !== null}
                accessibilityRole="button"
                accessibilityLabel={`Assign ${parcel.trackingId}. ${parcel.note}.`}
                style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
                <Card
                  style={[
                    styles.parcel,
                    parcel.routeMatches && { borderColor: theme.primary, borderWidth: 1 },
                  ]}>
                  <View style={styles.driverHead}>
                    <View style={styles.driverText}>
                      <Text style={[styles.name, { color: theme.text }]}>
                        #{parcel.trackingId}
                      </Text>
                      <Text style={[styles.shift, { color: theme.textSecondary }]}>
                        {parcel.originCity} → {parcel.destinationCity} · {parcel.weight} kg ·{' '}
                        {formatNaira(parcel.estimatedFee)}
                      </Text>
                    </View>
                    <View style={styles.parcelRight}>
                      <Badge
                        label={waitLabel(parcel.waitingMinutes)}
                        tone={
                          parcel.waitingMinutes >= 60
                            ? 'danger'
                            : parcel.waitingMinutes >= 20
                              ? 'warning'
                              : 'neutral'
                        }
                      />
                      {busy === parcel.id && <ActivityIndicator color={theme.primary} />}
                    </View>
                  </View>

                  <View style={styles.availability}>
                    <Clock
                      color={parcel.routeMatches ? theme.primary : theme.textMuted}
                      size={13}
                    />
                    <Text
                      style={[
                        styles.availabilityText,
                        { color: parcel.routeMatches ? theme.primary : theme.textMuted },
                      ]}>
                      {parcel.note}
                      {parcel.offersMade > 0 &&
                        ` · offered to ${parcel.offersMade} driver${parcel.offersMade === 1 ? '' : 's'} already`}
                    </Text>
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        )}

        <Button label="Close" variant="secondary" size="md" onPress={onClose} />
      </View>
    </BottomSheet>
  );
}

/** A number with a label, in the tile row. Matches the dispatch card's. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'primary' }) {
  const theme = useTheme();

  return (
    <View style={styles.stat}>
      <Text
        style={[styles.statValue, { color: tone === 'primary' ? theme.primary : theme.text }]}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: Spacing.two,
    marginBottom: Spacing.four,
  },
  card: {
    gap: Spacing.three - 2,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  title: {
    ...Typography.meta,
    ...font(700),
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
  },
  bannerText: {
    ...Typography.caption,
    flex: 1,
    lineHeight: 18,
  },
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    paddingVertical: Spacing.two,
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: 1,
  },
  statValue: {
    fontSize: FontSize.subhead,
    ...font(800),
  },
  statLabel: {
    ...Typography.caption,
  },
  statRule: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  loading: {
    marginVertical: Spacing.four,
  },
  list: {
    gap: Spacing.two + 2,
  },
  driver: {
    gap: Spacing.two,
  },
  driverHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  driverText: {
    flex: 1,
    gap: Spacing.half,
  },
  name: {
    ...Typography.meta,
    ...font(700),
  },
  shift: {
    ...Typography.caption,
    lineHeight: 18,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one + 2,
  },
  availability: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.one,
  },
  availabilityText: {
    ...Typography.caption,
    flex: 1,
    lineHeight: 18,
  },
  driverActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two + 2,
  },
  phone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  phoneText: {
    ...Typography.caption,
    ...font(600),
  },
  sheet: {
    gap: Spacing.three - 2,
  },
  sheetTitle: {
    fontSize: FontSize.subhead,
    ...font(800),
  },
  parcel: {
    gap: Spacing.two,
  },
  parcelRight: {
    alignItems: 'flex-end',
    gap: Spacing.one,
  },
});
