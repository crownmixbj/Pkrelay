import {
  CircleAlert,
  CircleCheck,
  Hand,
  PackageSearch,
  Radio,
  TriangleAlert,
  UserRoundCheck,
} from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { showDialog } from '@/components/ui/dialog';
import { DriversWaiting } from '@/components/ui/drivers-waiting';
import { EmptyState, SectionLabel } from '@/components/ui/screen';
import { showToast } from '@/components/ui/toast';
import { FontSize, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useLiveRefresh } from '@/hooks/use-live-refresh';
import { useTheme } from '@/hooks/use-theme';
import { formatClock } from '@/lib/when';
import { formatNaira } from '@/store/bookings';
import {
  assignParcel,
  attemptsLabel,
  candidateDepartureLine,
  fetchCandidates,
  fetchDispatchHealth,
  fetchUnassignedParcels,
  modeBanner,
  offersGoingUnanswered,
  setDispatchMode,
  UNKNOWN_HEALTH,
  waitLabel,
  type Candidate,
  type DispatchHealth,
  type DispatchMode,
  type UnassignedParcel,
} from '@/store/dispatch-mode';

/**
 * Dispatch — automatic matching, or a person placing every parcel.
 *
 * ⚠ The queue below is shown in BOTH modes, and that is the design.
 *
 *   The obvious build is a toggle that reveals an assignment table when set to
 *   Manual. It would be wrong: automatic dispatch leaves parcels unassigned all
 *   the time — nobody going that way, every candidate inside their cooldown,
 *   the one match holding a lapsed licence — and those are exactly the parcels
 *   a human should be looking at. A screen that goes blank whenever the toggle
 *   says Auto is blank precisely when the automation is quietly failing.
 *
 * ⚠ The banner's loudness is tied to the actual backlog rather than to the mode.
 *
 *   Manual mode is not dangerous at 9am with an empty queue and is very
 *   dangerous at 9pm with ninety parcels in it. A banner that looked identical
 *   in both cases would be ignored in both.
 */
export function DispatchControl() {
  const theme = useTheme();

  const [health, setHealth] = useState<DispatchHealth>(UNKNOWN_HEALTH);
  /*
   * Null until something is known, and set on failure too.
   *
   * The panel used to fall back to `UNKNOWN_HEALTH` on any error — mode 'auto',
   * counts all zero — which renders as a green "Automatic matching is on.
   * Nothing is waiting." So a screen that had loaded nothing at all made a
   * confident claim that parcels were moving. This state is what lets it say "I
   * do not know" instead.
   */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [parcels, setParcels] = useState<UnassignedParcel[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [assigning, setAssigning] = useState<UnassignedParcel | null>(null);
  /*
   * Bumped on every reload so the drivers panel below reloads in step with the
   * parcel queue — one live subscription for the whole screen, not two racing.
   */
  const [version, setVersion] = useState(0);
  /*
   * Parcels already on screen. Null until the first load, so opening the page
   * does not announce every parcel already in the queue as "new".
   */
  const seen = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    const [nextHealth, nextParcels] = await Promise.all([
      fetchDispatchHealth(),
      fetchUnassignedParcels(),
    ]);

    if (nextHealth.ok) {
      setHealth(nextHealth.health);
      setUnavailable(null);
    } else {
      setUnavailable(nextHealth.error);
    }

    if (nextParcels) {
      const known = seen.current;
      if (known) {
        const arrived = nextParcels.filter((parcel) => !known.has(parcel.id));
        if (arrived.length === 1) {
          showToast('New parcel waiting', {
            message: `#${arrived[0].trackingId} · ${arrived[0].originCity} → ${arrived[0].destinationCity}`,
            tone: 'info',
          });
        } else if (arrived.length > 1) {
          showToast(`${arrived.length} new parcels waiting`, {
            message: 'They are at the bottom of the queue below.',
            tone: 'info',
          });
        }
      }
      seen.current = new Set(nextParcels.map((parcel) => parcel.id));
    }

    setParcels(nextParcels ?? []);
    setLoading(false);
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * ⚠ Live, without a reload.
   *
   *   A queue manager that has to be refreshed by hand is a snapshot, and the
   *   operator ends up acting on a parcel somebody else placed a minute ago.
   *   Bookings, offers and journeys are the three tables every number on this
   *   screen is computed from; `20250101000077_dispatch_live.sql` puts them in
   *   the realtime publication and lets admins receive booking events.
   */
  const { lastUpdated, connected } = useLiveRefresh(refresh, {
    channel: 'admin:dispatch',
    tables: ['bookings', 'dispatch_offers', 'driver_journeys'],
  });

  const banner = modeBanner(health);
  const bannerColors = {
    success: { bg: theme.successSoft, fg: theme.successOnSoft },
    warning: { bg: theme.warningSoft, fg: theme.warningOnSoft },
    danger: { bg: theme.dangerSoft, fg: theme.dangerOnSoft },
  }[banner.tone];

  /*
   * Switching into Manual is confirmed; switching back is not.
   *
   * Asymmetric on purpose. Turning automation off is the direction that can
   * quietly cost a night of unassigned parcels, so it names the consequence and
   * the current queue depth before it happens. Turning it back on is the safe
   * direction, and a confirmation on it would be a dialog people learn to
   * dismiss — which is how they end up dismissing the one that mattered.
   */
  const choose = (next: DispatchMode) => {
    if (next === health.mode) return;

    if (next === 'auto') {
      void apply(next);
      return;
    }

    showDialog(
      'Switch to manual assignment?',
      `Package Relay will stop offering parcels to drivers. Nothing already in progress is affected — live offers keep their countdowns and drivers carry on delivering — but every new parcel will wait for you.${
        health.unassigned > 0 ? `\n\n${health.unassigned} parcel(s) are already waiting.` : ''
      }`,
      [
        { text: 'Stay on automatic', style: 'cancel' },
        { text: 'Switch to manual', style: 'destructive', onPress: () => void apply(next) },
      ],
    );
  };

  const apply = async (next: DispatchMode) => {
    setSwitching(true);
    const outcome = await setDispatchMode(next);
    setSwitching(false);

    if (!outcome.ok) {
      showDialog('Could not change the mode', outcome.error);
      void refresh();
      return;
    }

    /*
     * The server's answer, not the requested one.
     *
     * Two admins can hold this screen at once, and the loser of that race must
     * not be shown their own choice reflected back at them.
     */
    showToast(
      outcome.mode === 'manual' ? 'Manual assignment on' : 'Automatic matching on',
      outcome.mode === 'manual'
        ? { message: 'New parcels will wait for you in the queue below.', tone: 'info' }
        : { message: 'Anything waiting has been offered to drivers.' },
    );
    void refresh();
  };

  return (
    <View style={styles.wrap}>
      {/* ------------------------------------------------- the switch ---- */}
      <Card style={styles.card}>
        <View style={styles.head}>
          <Radio color={theme.primary} size={18} />
          <Text style={[styles.title, { color: theme.text }]}>Dispatch</Text>
          <LiveIndicator connected={connected} lastUpdated={lastUpdated} />
        </View>

        <View style={[styles.segmented, { backgroundColor: theme.surfaceMuted }]}>
          <ModeButton
            label="Automatic matching"
            caption="Package Relay offers each parcel to the best driver"
            icon={(color) => <Radio color={color} size={16} />}
            active={!unavailable && health.mode === 'auto'}
            disabled={switching || unavailable !== null}
            onPress={() => choose('auto')}
          />
          <ModeButton
            label="Manual assignment"
            caption="You place every parcel yourself"
            icon={(color) => <Hand color={color} size={16} />}
            active={!unavailable && health.mode === 'manual'}
            disabled={switching || unavailable !== null}
            onPress={() => choose('manual')}
          />
        </View>

        {/*
          Neither mode is shown as active while the status is unknown.

          A toggle that stays lit on "Automatic" during an outage is asserting
          the one thing nobody can currently check. Both unlit, both inert, and
          the reason underneath.
        */}
        {unavailable ? (
          <View style={[styles.banner, { backgroundColor: theme.dangerSoft }]}>
            <CircleAlert color={theme.dangerOnSoft} size={16} />
            <View style={styles.bannerText}>
              <Text style={[styles.bannerTitle, { color: theme.dangerOnSoft }]}>
                Dispatch status unavailable
              </Text>
              <Text style={[styles.bannerBody, { color: theme.dangerOnSoft }]}>{unavailable}</Text>
              <Text style={[styles.bannerBody, { color: theme.dangerOnSoft }]}>
                Parcels are still being booked and drivers can still deliver. What this screen
                cannot tell you is whether they are being matched.
              </Text>
            </View>
          </View>
        ) : (
          <View style={[styles.banner, { backgroundColor: bannerColors.bg }]}>
            {banner.tone === 'success' ? (
              <CircleCheck color={bannerColors.fg} size={16} />
            ) : banner.tone === 'warning' ? (
              <TriangleAlert color={bannerColors.fg} size={16} />
            ) : (
              <CircleAlert color={bannerColors.fg} size={16} />
            )}
            <View style={styles.bannerText}>
              <Text style={[styles.bannerTitle, { color: bannerColors.fg }]}>{banner.title}</Text>
              <Text style={[styles.bannerBody, { color: bannerColors.fg }]}>{banner.body}</Text>
            </View>
          </View>
        )}

        {/*
          Em dashes rather than zeros when nothing is known.

          "0 Waiting" is a measurement. A screen that prints it without having
          measured anything is the same lie as the green banner, in smaller type.
        */}
        <View style={[styles.stats, { backgroundColor: theme.surfaceMuted }]}>
          <Stat label="Waiting" value={unavailable ? '—' : String(health.unassigned)} />
          <View style={[styles.statRule, { backgroundColor: theme.border }]} />
          <Stat label="Live offers" value={unavailable ? '—' : String(health.liveOffers)} />
          <View style={[styles.statRule, { backgroundColor: theme.border }]} />
          {/*
            Sidelined drivers belong next to the queue, not on a documents
            screen. "Nine parcels waiting" and "four drivers blocked by an
            expired document" is one story, and an operator seeing only the
            first half will go looking for a dispatch bug.
          */}
          <Stat label="Blocked drivers" value={unavailable ? '—' : String(health.blockedDrivers)} />
        </View>
      </Card>

      {/* ---------------------------------------- the other direction ---- */}
      {/*
        Above the parcel queue, deliberately.

        An operator placing parcels by hand works driver-first when there are
        drivers sitting idle — one driver, one journey, the parcels that fit it —
        and parcel-first only for the awkward ones nobody is going towards.
        Putting the people above the packages also means the first thing on
        screen is the thing that costs money while it waits.
      */}
      <DriversWaiting
        mode={unavailable ? null : health.mode}
        version={version}
        onAssigned={() => void refresh()}
      />

      {/* -------------------------------------------------- the queue ---- */}
      <SectionLabel>Waiting for a driver</SectionLabel>

      {parcels.length === 0 ? (
        <EmptyState
          icon={(color, size) => <PackageSearch color={color} size={size} />}
          title={loading ? 'Loading…' : unavailable ? 'Queue unavailable' : 'Nothing waiting'}
          message={
            unavailable
              ? 'The queue could not be read, so this list is empty because nothing loaded — not because nothing is waiting.'
              : health.mode === 'manual'
                ? 'Parcels booked from now on will appear here for you to assign.'
                : 'Every booked parcel has a driver or a live offer.'
          }
        />
      ) : (
        <View style={styles.queue}>
          {parcels.map((parcel) => (
            <Card key={parcel.id} style={styles.parcel}>
              <View style={styles.parcelHead}>
                <View style={styles.parcelText}>
                  <Text style={[styles.tracking, { color: theme.text }]}>#{parcel.trackingId}</Text>
                  <Text style={[styles.route, { color: theme.textSecondary }]}>
                    {parcel.originCity} → {parcel.destinationCity} · {parcel.weight} kg ·{' '}
                    {formatNaira(parcel.estimatedFee)}
                  </Text>
                </View>
                {/*
                  Waiting time is the tone, not the delivery type. An hour-old
                  parcel is the problem regardless of whether it is flash or
                  interstate.
                */}
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
              </View>

              {/*
                Attempts and drivers, counted separately.

                ⚠ This line used to read "Offered to N drivers already", where N
                  was the number of offer *rows*. PKG-483203 therefore announced
                  five drivers when the truth was seven offers to one, every one
                  a timeout. A parcel five drivers refused is a pricing or
                  routing problem; a parcel one driver never answered is a
                  notification problem, and the sentence pointed at the wrong one
                  for a day.
              */}
              {!!attemptsLabel(parcel.attempts) && (
                <Text style={[styles.attempts, { color: theme.textMuted }]}>
                  {attemptsLabel(parcel.attempts)}
                </Text>
              )}

              {offersGoingUnanswered(parcel.attempts) && (
                <View style={[styles.unanswered, { backgroundColor: theme.warningSoft }]}>
                  <TriangleAlert color={theme.warningOnSoft} size={14} />
                  <Text style={[styles.unansweredText, { color: theme.warningOnSoft }]}>
                    Nobody has refused this — the offers are expiring unanswered. Check the driver
                    is actually being notified before assuming the route is the problem.
                  </Text>
                </View>
              )}

              <Button
                label="Assign a driver"
                variant="secondary"
                size="md"
                icon={(color, size) => <UserRoundCheck color={color} size={size} />}
                onPress={() => setAssigning(parcel)}
              />
            </Card>
          ))}
        </View>
      )}

      <AssignSheet
        parcel={assigning}
        onClose={() => setAssigning(null)}
        onAssigned={() => {
          setAssigning(null);
          void refresh();
        }}
      />
    </View>
  );
}

/**
 * "Live" or "Updating every 20s", and when the screen last heard anything.
 *
 * Said out loud because a live screen and a frozen one look identical until
 * something changes — the operator needs to know which one they are trusting.
 */
function LiveIndicator({
  connected,
  lastUpdated,
}: {
  connected: boolean;
  lastUpdated: Date | null;
}) {
  const theme = useTheme();
  const color = connected ? theme.successOnSoft : theme.textMuted;
  /*
    ⚠ WAT, like every other time on this screen.

      `toLocaleTimeString` renders in the reader's own zone, which `verify:
      timestamps` forbids across `src/` — and the reason is this screen in
      particular. "Updated 14:03" beside "Leaves Today, 09:45 WAT" is two clocks
      in one card, and the operator has no way to tell which is which. Minute
      precision is enough for a line that refreshes every twenty seconds.
  */
  const time = lastUpdated ? formatClock(lastUpdated.toISOString()) : null;

  return (
    <View
      style={styles.live}
      accessibilityLabel={
        connected ? 'Live updates on' : 'Live updates reconnecting; refreshing every 20 seconds'
      }>
      <View style={[styles.liveDot, { backgroundColor: connected ? theme.success : theme.border }]} />
      <Text style={[styles.liveText, { color }]}>
        {connected ? 'Live' : 'Auto-refresh'}
        {time ? ` · ${time}` : ''}
      </Text>
    </View>
  );
}

function ModeButton({
  label,
  caption,
  icon,
  active,
  disabled,
  onPress,
}: {
  label: string;
  caption: string;
  icon: (color: string) => React.ReactNode;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const color = active ? theme.primaryText : theme.textSecondary;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      accessibilityLabel={`${label}. ${caption}`}
      style={({ pressed }) => [
        styles.mode,
        styles.tappable,
        active && { backgroundColor: theme.primary },
        pressed && styles.pressed,
      ]}>
      <View style={styles.modeHead}>
        {icon(color)}
        <Text style={[styles.modeLabel, { color }]}>{label}</Text>
      </View>
      {/*
        The caption stays on the inactive option too. It is what tells an
        operator what they are about to switch *to*, which is the only moment
        the description is actually load-bearing.
      */}
      <Text
        style={[styles.modeCaption, { color: active ? theme.primaryText : theme.textMuted }]}
        numberOfLines={2}>
        {caption}
      </Text>
    </Pressable>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: theme.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: theme.textMuted }]}>{label}</Text>
    </View>
  );
}

/**
 * Picking a driver for one parcel.
 *
 * ⚠ Lists drivers the matcher would have skipped, marked and reasoned.
 *
 *   An operator is doing this because they know something the automation does
 *   not — the rider standing in the hub who has not declared a route, the one
 *   who declined by accident and is inside their cooldown. A list filtered to
 *   auto-eligible drivers would be a slower copy of the automation and useless
 *   for the case it exists to serve.
 *
 *   The single exception is an expired licence or insurance: shown, marked
 *   ineligible, and refused by `admin_assign_parcel` as well. That is a legal
 *   limit rather than a matching preference, and it should not be clickable.
 */
function AssignSheet({
  parcel,
  onClose,
  onAssigned,
}: {
  parcel: UnassignedParcel | null;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const theme = useTheme();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!parcel) return;
    setLoading(true);
    void fetchCandidates(parcel.id).then((rows) => {
      setCandidates(rows);
      setLoading(false);
    });
  }, [parcel]);

  const place = async (candidate: Candidate) => {
    if (!parcel) return;

    setBusy(true);
    const outcome = await assignParcel(parcel.id, candidate.driverId);
    setBusy(false);

    if (!outcome.ok) {
      showDialog('Could not assign that parcel', outcome.error);
      return;
    }

    showToast('Parcel assigned', {
      message: `#${parcel.trackingId} is now with ${candidate.fullName}.`,
    });
    onAssigned();
  };

  const confirm = (candidate: Candidate) => {
    if (!parcel) return;

    /*
      Confirmed because it is not reversible from this screen.

      `admin_assign_parcel` refuses a parcel that already has a driver, so
      undoing a misclick means going to the parcel drawer. Naming the driver and
      the parcel first is cheaper than that.
    */
    showDialog(
      `Give #${parcel.trackingId} to ${candidate.fullName}?`,
      `${candidate.note}.\n\nThey become the carrier immediately, and any live offer on this parcel is closed.`,
      [
        { text: 'Not this one', style: 'cancel' },
        { text: 'Assign', onPress: () => void place(candidate) },
      ],
    );
  };

  return (
    <BottomSheet visible={parcel !== null} onClose={onClose}>
      <View style={styles.sheet}>
        <Text style={[styles.sheetTitle, { color: theme.text }]}>Assign a driver</Text>
        {!!parcel && (
          <Text style={[styles.sheetSub, { color: theme.textSecondary }]}>
            #{parcel.trackingId} · {parcel.originCity} → {parcel.destinationCity} · {parcel.weight}{' '}
            kg
          </Text>
        )}

        {loading ? (
          <Text style={[styles.attempts, { color: theme.textMuted }]}>Loading drivers…</Text>
        ) : candidates.length === 0 ? (
          <EmptyState
            icon={(color, size) => <UserRoundCheck color={color} size={size} />}
            title="No approved drivers"
            message="Nobody has an approved application yet, so there is nobody to assign this to."
          />
        ) : (
          candidates.map((candidate) => (
            <Pressable
              key={candidate.driverId}
              onPress={() => confirm(candidate)}
              disabled={busy || !candidate.eligible}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || !candidate.eligible }}
              style={({ pressed }) => [
                styles.candidate,
                styles.tappable,
                { borderColor: theme.border, backgroundColor: theme.surface },
                candidate.routeMatches && { borderColor: theme.success },
                !candidate.eligible && { opacity: 0.55 },
                pressed && styles.pressed,
              ]}>
              <View style={styles.candidateText}>
                <Text style={[styles.candidateName, { color: theme.text }]}>
                  {candidate.fullName}
                </Text>
                <Text style={[styles.candidateMeta, { color: theme.textSecondary }]}>
                  {candidate.baseCity} · {candidate.vehicleType} · {candidate.activeParcels} active
                </Text>
                {/*
                  When they leave, and the reason this list is in this order.
                  `assignable_drivers` sorts on `next_departure` as of 75 — the
                  same preference `dispatch_booking` has applied since 26, which
                  this screen used to contradict by sorting on name.

                  Absent rather than "unknown" when no journey is live: the note
                  below already says "No journey declared", and a second line
                  saying it in other words is noise.
                */}
                {!!candidateDepartureLine(candidate) && (
                  <Text style={[styles.candidateMeta, { color: theme.textSecondary }]}>
                    {candidateDepartureLine(candidate)}
                  </Text>
                )}
                <Text
                  style={[
                    styles.candidateNote,
                    {
                      color: !candidate.eligible
                        ? theme.dangerOnSoft
                        : candidate.routeMatches
                          ? theme.successOnSoft
                          : theme.textMuted,
                    },
                  ]}>
                  {candidate.note}
                </Text>
              </View>

              <Badge
                label={
                  !candidate.eligible ? 'Blocked' : candidate.routeMatches ? 'Match' : 'Override'
                }
                tone={
                  !candidate.eligible ? 'danger' : candidate.routeMatches ? 'success' : 'neutral'
                }
              />
            </Pressable>
          ))
        )}

        <Button label="Close" variant="secondary" onPress={onClose} disabled={busy} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.three },
  card: { gap: Spacing.three - 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  title: { ...Typography.sectionTitle },
  live: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  liveText: { ...Typography.caption, ...font(600) },
  segmented: {
    flexDirection: 'row',
    gap: Spacing.one,
    padding: Spacing.one,
    borderRadius: Radius.md,
  },
  mode: {
    flex: 1,
    gap: Spacing.half,
    paddingVertical: Spacing.two + 2,
    paddingHorizontal: Spacing.two + 2,
    borderRadius: Radius.sm,
  },
  modeHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one + 2 },
  modeLabel: { ...Typography.meta, ...font(700), flex: 1 },
  modeCaption: { ...Typography.caption, lineHeight: 16 },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
  },
  bannerText: { flex: 1, gap: Spacing.half },
  bannerTitle: { ...Typography.meta, ...font(700) },
  bannerBody: { ...Typography.caption, lineHeight: 18 },
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.two + 2,
    borderRadius: Radius.md,
  },
  stat: { flex: 1, alignItems: 'center', gap: Spacing.half },
  statValue: { fontSize: FontSize.subhead, ...font(700) },
  statLabel: { ...Typography.caption },
  statRule: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  queue: { gap: Spacing.three - 2 },
  parcel: { gap: Spacing.two },
  parcelHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  parcelText: { flex: 1, gap: Spacing.half },
  tracking: { ...Typography.meta, ...font(700) },
  route: { ...Typography.caption },
  unanswered: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.one + 2,
    padding: Spacing.two,
    borderRadius: Radius.md,
  },
  unansweredText: {
    ...Typography.caption,
    flex: 1,
    lineHeight: 18,
  },
  attempts: { ...Typography.caption, lineHeight: 17 },
  sheet: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: Spacing.two + 2 },
  sheetTitle: { ...Typography.sectionTitle },
  sheetSub: { ...Typography.caption },
  candidate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  candidateText: { flex: 1, gap: Spacing.half },
  candidateName: { ...Typography.meta, ...font(700) },
  candidateMeta: { ...Typography.caption },
  candidateNote: { ...Typography.caption },
  tappable: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  pressed: { opacity: 0.6 },
});
