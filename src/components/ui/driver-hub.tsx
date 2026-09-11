import { useRouter } from 'expo-router';
import {
  Bell,
  Camera,
  ClipboardList,
  MapPin,
  Navigation,
  PackageSearch,
  Phone,
  ShieldAlert,
  Truck,
  Zap,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { Badge } from '@/components/ui/badge';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { CancelAction } from '@/components/ui/cancel-action';
import { DispatchOffers } from '@/components/ui/dispatch-offers';
import { DriverSummaryCard } from '@/components/ui/driver-summary-card';
import { EarningsSheet } from '@/components/ui/earnings-sheet';
import { OperatingModeCard } from '@/components/ui/operating-mode-card';
import { PinnedHeaderScreen } from '@/components/ui/sticky-header';
import { Card } from '@/components/ui/card';
import { showDialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { MapView, type MapMarker } from '@/components/ui/map-view';
import { PhotoPicker } from '@/components/ui/photo-picker';
import { EmptyState, screenPadding } from '@/components/ui/screen';
import { showToast } from '@/components/ui/toast';
import { Elevation, FontSize, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { dialUrl, navigationUrl } from '@/lib/handoff';
import { isSupabaseConfigured } from '@/lib/supabase';
import {
  formatNaira,
  isCarrier,
  routeEndpoints,
  stageIndex,
  statusLabel,
  statusTone,
  useBookings,
  type Booking,
  type City,
} from '@/store/bookings';
import {
  activeLeg,
  advanceBooking,
  advanceLabel,
  driverAlerts,
  isFinalStep,
  nextStage,
  uploadProof,
} from '@/store/delivery';
import {
  activeFlashShift,
  endFlashShift,
  fetchJourneys,
  fetchLiveOffers,
  fetchMissedOffers,
  matchStatus,
  modeAction,
  respondToOffer,
  scheduledJourneys,
  startFlashShift,
  type DispatchOffer,
  type Journey,
  type OperatingMode,
} from '@/store/dispatch';
import { earningsSummary } from '@/store/earnings';
import { pushIsEnabled, pushProblem, registerForPush } from '@/store/push';
import { useSession } from '@/store/session';

/**
 * The Driver Hub — the native driver home.
 *
 * A driver mid-shift is holding a phone in one hand and a parcel in the other.
 * They are not reading a dashboard; they are answering one question at a time:
 * where next, who do I call, and what do I press when it is done. So this screen
 * puts a map and exactly one job at the top, and everything else below the fold.
 *
 * The web Driver Portal (`/driver` on a desktop) stays as it is — it is where
 * you check your application, your details and your history, which is desk work.
 * This is the version for someone on a bike.
 */
export function DriverHub() {
  const theme = useTheme();
  const router = useRouter();
  const { bookings, refresh } = useBookings();
  const { viewerId, user, application, isApprovedDriver } = useSession();

  const [alertsOpen, setAlertsOpen] = useState(false);
  const [completing, setCompleting] = useState<Booking | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const myJobs = useMemo(
    () => (viewerId ? bookings.filter((booking) => isCarrier(booking, viewerId)) : []),
    [bookings, viewerId],
  );

  const active = useMemo(() => myJobs.filter((job) => job.status !== 'Delivered'), [myJobs]);

  /*
   * The one job the screen is about.
   *
   * The furthest along, not the newest: a parcel already out for delivery is
   * the one in the driver's hands right now, and showing them a job they
   * accepted five minutes ago instead would be the wrong parcel on the map.
   */
  const current = useMemo(() => mostAdvanced(active), [active]);

  /*
   * "In your hands" — the parcels physically in the vehicle.
   *
   * Distinct from the job list: a job that is Assigned is a promise, a job that
   * is Picked Up is cargo. A driver reconciling their bike at the end of a run
   * needs the second list, and nothing else in the app showed it.
   */
  const inventory = useMemo(
    () => active.filter((job) => job.status !== 'Assigned' && job.status !== 'Booked'),
    [active],
  );

  const upNext = useMemo(
    () => active.filter((job) => job.id !== current?.id),
    [active, current?.id],
  );

  const alerts = useMemo(() => driverAlerts(myJobs), [myJobs]);

  /*
   * The dashboard summary, mirroring the web portal's top row.
   *
   * Offers and journeys are fetched here rather than in the card so the card
   * stays a pure render — it is the piece most likely to be reused on another
   * screen, and a component that fetches cannot be.
   */
  const [offers, setOffers] = useState<DispatchOffer[]>([]);
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [missed, setMissed] = useState<DispatchOffer[]>([]);

  /*
   * Whether this phone can actually be reached.
   *
   * Read, never assumed. Push being deployed is a fact about the backend;
   * whether a notification arrives is a fact about this handset — the permission
   * may have been refused, or it may be a simulator. The copy below follows the
   * handset, so a driver is never told they will be alerted on a device that
   * cannot alert them.
   *
   * `pushIsEnabled` checks the permission without requesting it, so reading this
   * on mount cannot cause a prompt.
   */
  const [alertsOn, setAlertsOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void pushIsEnabled().then((enabled) => {
      if (!cancelled) setAlertsOn(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Fetched on mount and then on a poll, not once.
   *
   * An offer arrives from a background sweep — a parcel posted, another driver
   * declining, the expiry cron rolling one over — so nothing the driver does on
   * this screen would cause a refetch. Fetching once meant an offer only
   * appeared if they happened to reopen the tab, which for a five-minute hold is
   * most of the hold gone.
   *
   * Fifteen seconds is a twentieth of the shortest window: soon enough that the
   * countdown a driver sees is close to the one the database is running, cheap
   * enough at this size that it does not need Realtime to be reasonable.
   *
   * Still needed now that push is deployed. A notification tells a driver an
   * offer exists; it does not keep the screen they are already looking at up to
   * date, and it never arrives at all on a phone where the permission was
   * refused. The poll is what makes this screen correct in both cases.
   */
  const OFFER_POLL_MS = 15_000;

  useEffect(() => {
    if (!viewerId) return;

    let cancelled = false;

    const load = async () => {
      const [live, declared, gone] = await Promise.all([
        fetchLiveOffers(),
        fetchJourneys(),
        fetchMissedOffers(),
      ]);
      if (cancelled) return;
      setOffers(live);
      setJourneys(declared);
      setMissed(gone);
    };

    void load();
    const timer = setInterval(() => void load(), OFFER_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [viewerId]);

  /*
   * Quoted fares on parcels held and delivered — gross, and not a balance.
   *
   * The ledger in `supabase/migrations/20250101000030_driver_wallet.sql` is the balance, and it is
   * deliberately a different number: net of commission, delivered parcels only,
   * less a security hold. The card says "Expected" for that reason, and the
   * sheet it opens links to the Wallet.
   */
  /*
   * Delivered plus in progress, and the breakdown behind it.
   *
   * Derived from one function so the headline and the history cannot disagree.
   * They would have: the card summed every job while the count next to it was
   * delivered-only, so a history listing completed parcels alone would have
   * totalled less than the number the driver tapped, with nothing explaining
   * the gap.
   */
  const earnings = useMemo(() => earningsSummary(bookings, viewerId), [bookings, viewerId]);
  const expectedEarnings = earnings.total;

  const [earningsOpen, setEarningsOpen] = useState(false);

  /*
   * The mode, and everything that follows from it.
   *
   * Held on the screen rather than in the session store: it describes what the
   * driver is doing in this sitting, and a driver who opens the app tomorrow
   * should start from what is actually live — an open flash shift, or their
   * declared routes — rather than from a preference they set once.
   */
  const flashShift = useMemo(() => activeFlashShift(journeys), [journeys]);
  const openRoutes = useMemo(() => scheduledJourneys(journeys).length, [journeys]);

  const [pickedMode, setPickedMode] = useState<OperatingMode | null>(null);
  const mode: OperatingMode = pickedMode ?? (flashShift ? 'flash' : 'scheduled');

  const [busyMode, setBusyMode] = useState(false);

  const action = useMemo(
    () => modeAction({ mode, onlineFlash: Boolean(flashShift), openRoutes, alertsOn }),
    [mode, flashShift, openRoutes, alertsOn],
  );

  const reloadDispatch = useCallback(async () => {
    const [live, declared, gone] = await Promise.all([
      fetchLiveOffers(),
      fetchJourneys(),
      fetchMissedOffers(),
    ]);
    setOffers(live);
    setJourneys(declared);
    setMissed(gone);
  }, []);

  /*
   * Switching to Scheduled ends a live flash shift.
   *
   * Leaving it open would keep offering local jobs to somebody who has just
   * said they are doing something else — and the first they would know is a
   * parcel they did not expect.
   */
  const changeMode = useCallback(
    async (next: OperatingMode) => {
      setPickedMode(next);
      if (next === 'scheduled' && flashShift) {
        setBusyMode(true);
        await endFlashShift();
        await reloadDispatch();
        setBusyMode(false);
      }
    },
    [flashShift, reloadDispatch],
  );

  const primaryAction = useCallback(async () => {
    if (mode === 'scheduled') {
      router.navigate('/available-packages');
      return;
    }

    setBusyMode(true);
    if (flashShift) {
      await endFlashShift();
      showToast('Offline', { message: 'No more local jobs will be offered.', tone: 'info' });
    } else {
      /*
       * The city comes from the approved application, not from a picker.
       *
       * It is the city Package Relay vetted this driver to work in, and a driver who
       * could type any city could go online somewhere they have never been.
       */
      const city = application?.baseCity;
      if (!city) {
        showDialog(
          'No city on your application',
          'Flash jobs are offered in the city on your approved driver application. Contact support if that is wrong.',
        );
        setBusyMode(false);
        return;
      }

      const started = await startFlashShift(city as City);
      if (started) {
        /*
         * Ask for notifications *here*, not at launch.
         *
         * This is the first moment a driver has a reason to want them: they
         * have just said they are waiting for work. Asking on first launch, in
         * front of somebody who has not yet seen what the app does, gets
         * refused — and on iOS a refusal is close to permanent, because the
         * prompt never comes back.
         */
        const push = await registerForPush();
        showToast('Online for local jobs', {
          message: push.ok
            ? `Parcels inside ${city} will be offered to you.`
            : `Parcels inside ${city} will be offered to you. ${pushProblem(push.reason)}`,
        });
      } else {
        showDialog('Could not go online', 'Check your connection and driver approval.');
      }
    }

    await reloadDispatch();
    setBusyMode(false);
  }, [mode, flashShift, application?.baseCity, reloadDispatch, router]);

  /*
   * Answering an offer, from the screen the offer now lives on.
   *
   * Accepting has to reload two things: dispatch, so the card goes away, and
   * bookings, so the parcel it became appears as the assigned trip immediately
   * below. Reloading only dispatch would leave the driver on "Nothing on your
   * bike" a second after accepting a trip.
   */
  const [busyOffer, setBusyOffer] = useState(false);

  const answerOffer = useCallback(
    async (offer: DispatchOffer, accept: boolean) => {
      setBusyOffer(true);
      const outcome = await respondToOffer(offer.id, accept);
      setBusyOffer(false);

      if (outcome === 'gone') {
        showToast('That trip is no longer available', {
          message: 'It expired or went to another driver.',
          tone: 'info',
        });
      } else if (outcome === 'accepted') {
        showToast('Trip accepted', { message: 'It is now your assigned trip.' });
      }

      await Promise.all([reloadDispatch(), refresh()]);
    },
    [reloadDispatch, refresh],
  );

  const match = useMemo(
    () =>
      matchStatus({
        liveOffers: offers.length,
        activeJobs: active.length,
        openJourneys: journeys.filter((journey) => journey.status === 'open').length,
      }),
    [offers.length, active.length, journeys],
  );

  /** Empty for anything posted after the booking form dropped its map pickers. */
  const pins = useMemo(() => markersFor(current), [current]);

  const initials = (application?.fullName ?? user?.name ?? 'Driver')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  /** Moves a job on one stage, or opens the completion sheet on the last one. */
  const advance = async (job: Booking) => {
    if (isFinalStep(job.status)) {
      setCompleting(job);
      return;
    }

    setBusyId(job.id);
    try {
      const to = await advanceBooking({ bookingId: job.id });
      await refresh();

      /*
       * Name the handover when it happens.
       *
       * Confirming pickup silently swaps who the call button reaches. A driver
       * who dialled the sender a minute ago has no reason to expect the same
       * button now rings somebody else, and finding out by calling the wrong
       * person is a poor way to learn it.
       *
       * `activeLeg` is given `to` — the stage the server just returned — rather
       * than reading the job, which still holds the old stage until the refetch
       * lands.
       */
      const nowReaching = activeLeg(job, to);
      const switched = activeLeg(job).role !== nowReaching.role;

      showToast(`#${job.trackingId} is now ${to}`, {
        tone: 'success',
        message: switched
          ? `Calls now reach the ${nowReaching.role}, ${nowReaching.name}.`
          : undefined,
      });
    } catch (thrown) {
      showDialog('That did not go through', errorMessage(thrown, 'Try again in a moment.'));
    } finally {
      setBusyId(null);
    }
  };

  /*
   * Both of these follow the leg, not the parcel.
   *
   * Navigation used to send the driver to the drop-off whatever the stage, so
   * an Assigned job routed them across the city to an address holding nothing.
   * It is the same defect as the call button and it was worse, because a wrong
   * phone call wastes a minute and a wrong route wastes a trip.
   */
  const openNavigation = (job: Booking) => {
    const leg = activeLeg(job);
    void Linking.openURL(
      navigationUrl({ lat: leg.lat, lng: leg.lng, address: leg.navigationAddress }),
    );
  };

  const callCounterparty = (job: Booking) => {
    const leg = activeLeg(job);
    const url = dialUrl(leg.phone);
    if (!url) {
      showDialog(
        'No number on file',
        `This parcel has no usable ${leg.role} phone number. Contact support rather than leaving the parcel.`,
      );
      return;
    }
    void Linking.openURL(url);
  };

  /*
   * The header is a sibling of the scroller, not its first child.
   *
   * It used to be the first row inside the ScrollView, so the driver's name,
   * their city and the notification bell all scrolled away the moment they
   * looked at anything. The bell is the worst of those to lose: it is the only
   * indication that something needs attention, and it vanished exactly when a
   * driver started reading the screen it was warning them about.
   */
  const header = (
    <View style={[styles.header, { backgroundColor: theme.navBackground }]}>
      <View style={[styles.avatar, { backgroundColor: theme.primarySoft }]}>
        <Text style={[styles.avatarText, { color: theme.primaryOnSoft }]}>{initials || 'D'}</Text>
      </View>

      <View style={styles.headerText}>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Assigned Trip</Text>
        <Text style={[styles.headerMeta, { color: theme.textMuted }]} numberOfLines={1}>
          {application?.fullName ?? user?.name ?? 'Driver'}
          {application?.baseCity ? ` · ${application.baseCity}` : ''}
        </Text>
      </View>

      {/*
            The bell counts real work, not messages.

            See `driverAlerts` — every item is derived from a booking row, so it
            cannot show a notification for something that did not happen. The
            trade-off is that it has no "read" state: the count falls when the
            work is done, not when it has been looked at.
          */}
      <Pressable
        onPress={() => setAlertsOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={
          alerts.length ? `${alerts.length} things need attention` : 'Nothing needs attention'
        }
        style={({ pressed }) => [styles.bell, pressed && styles.pressed]}>
        <Bell color={theme.textSecondary} size={22} />
        {alerts.length > 0 && (
          <View style={[styles.badgeDot, { backgroundColor: theme.danger }]}>
            <Text style={styles.badgeDotText}>{alerts.length}</Text>
          </View>
        )}
      </Pressable>
    </View>
  );

  return (
    <>
      <PinnedHeaderScreen header={header}>
        {/*
          `flex: 1`, not `flexGrow`.

          The scroller has to be a fixed-height box that clips, so its content
          scrolls inside it. A growing box would size itself to its content and
          push the header off the top — which is what it did as the ScrollView's
          first child, and would do again from here.
        */}
        <ScrollView
          style={[styles.flex, { backgroundColor: theme.background }]}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}>
          {!isApprovedDriver && (
            <View style={[styles.gate, { backgroundColor: theme.warningSoft }]}>
              <ShieldAlert color={theme.warningOnSoft} size={16} />
              <Text style={[styles.gateText, { color: theme.warningOnSoft }]}>
                {application
                  ? 'You can browse jobs, but claiming and updating a delivery unlocks when an admin approves your application.'
                  : 'Apply to drive before you can claim a delivery. Browsing stays open.'}
              </Text>
            </View>
          )}

          {/*
          ---------- The map ----------

          Only when the parcel actually carries pins, which now means only
          parcels posted before the booking form's map pickers were removed.
          Senders describe addresses in words instead, because a pin dropped on
          an OpenStreetMap tile in a Nigerian city is regularly off by a street
          and was being trusted over the address typed beside it.

          An empty map is worse than no map: it reads as "we do not know where
          this is". Where there are no pins the address on the job card is the
          real information, and Open Navigation still works from it.
        */}
          {pins.length > 0 && (
            <View style={styles.mapWrap}>
              <MapView markers={pins} showRoute height={220} />
              <Text style={[styles.mapNote, { color: theme.textMuted }]}>
                Pinned by the sender. Not your live position — nothing in the app reports that.
              </Text>
            </View>
          )}

          <View style={styles.body}>
            {/* ---------- The summary, mirroring the web portal ---------- */}
            <DriverSummaryCard
              expectedEarnings={expectedEarnings}
              deliveredCount={earnings.delivered.count}
              match={match}
              application={application}
              isApprovedDriver={isApprovedDriver}
              onOpenEarnings={() => setEarningsOpen(true)}
            />

            {/* ---------- Scheduled or Flash ---------- */}
            <OperatingModeCard
              mode={mode}
              onChange={changeMode}
              status={
                flashShift
                  ? `Online in ${flashShift.originCity} until ${new Date(
                      flashShift.departsBefore,
                    ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : undefined
              }
            />

            {/*
            ---------- Trips waiting on an answer ----------

            Above the current job, because it is the only thing on this screen
            with a deadline. A driver already carrying a parcel can still be
            offered another, and burying that under the job in hand costs them
            the offer.
          */}
            <DispatchOffers offers={offers} busy={busyOffer} onAnswer={answerOffer} />

            {/*
            Work that reached this driver and expired unseen.

            Only when there is nothing live — during an offer the countdown is
            the only thing that should be competing for attention. It is a plain
            line rather than a warning card because the driver did nothing
            wrong: Package Relay could not reach them. What follows it depends on whether
            this phone can be reached now — telling somebody with notifications
            refused that the next one will find them would be the same false
            reassurance in the opposite direction.
          */}
            {offers.length === 0 && missed.length > 0 && (
              <Text style={[styles.missed, { color: theme.textMuted }]}>
                {missed.length === 1
                  ? '1 trip was offered to you recently and expired before you saw it.'
                  : `${missed.length} trips were offered to you recently and expired before you saw them.`}{' '}
                {alertsOn
                  ? 'The next one will reach you as a notification.'
                  : 'Notifications are off on this phone, so offers only appear while this screen is open.'}
              </Text>
            )}

            {/* ---------- The current job ---------- */}
            {current ? (
              <CurrentJob
                job={current}
                busy={busyId === current.id}
                canAct={isApprovedDriver}
                onAdvance={() => advance(current)}
                onNavigate={() => openNavigation(current)}
                onCall={() => callCounterparty(current)}
                onOpen={() => router.navigate(`/parcel/${current.id}` as '/')}
              />
            ) : offers.length > 0 ? null : (
              <View style={styles.emptyWrap}>
                {/*
                Both the message and the button follow the mode. A driver in
                Flash being told to "tell Package Relay where you are going" would be
                being asked for the one thing Flash exists to avoid.

                And neither appears at all while an offer is pending. "Nothing
                on your bike" above a live countdown contradicts itself, and
                "Schedule another journey" invites the driver away from the one
                decision that expires in five minutes.
              */}
                <EmptyState
                  icon={(color, size) =>
                    mode === 'flash' ? (
                      <Zap color={color} size={size} />
                    ) : (
                      <ClipboardList color={color} size={size} />
                    )
                  }
                  title={action.title}
                  message={action.message}
                />
                <Button
                  label={busyMode ? 'Working…' : action.button}
                  icon={(color, size) =>
                    mode === 'flash' ? (
                      <Zap color={color} size={size} />
                    ) : (
                      <PackageSearch color={color} size={size} />
                    )
                  }
                  onPress={primaryAction}
                  disabled={busyMode}
                />
              </View>
            )}

            {/* ---------- In your hands ---------- */}
            {inventory.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>
                  In your hands ({inventory.length})
                </Text>
                <Text style={[styles.sectionNote, { color: theme.textMuted }]}>
                  Parcels you have collected and not yet handed over.
                </Text>
                <View style={styles.list}>
                  {inventory.map((job) => (
                    <MiniJob
                      key={job.id}
                      job={job}
                      onPress={() => router.navigate(`/parcel/${job.id}` as '/')}
                    />
                  ))}
                </View>
              </View>
            )}

            {/* ---------- Up next ---------- */}
            {upNext.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>
                  Up next ({upNext.length})
                </Text>
                <View style={styles.list}>
                  {upNext.map((job) => (
                    <MiniJob
                      key={job.id}
                      job={job}
                      onPress={() => router.navigate(`/parcel/${job.id}` as '/')}
                    />
                  ))}
                </View>
              </View>
            )}

            {active.length > 0 && (
              <Button
                label="Schedule another journey"
                variant="secondary"
                icon={(color, size) => <PackageSearch color={color} size={size} />}
                onPress={() => router.navigate('/available-packages')}
                style={styles.footerCta}
              />
            )}

            <Button
              label="Your driver profile"
              variant="secondary"
              icon={(color, size) => <Truck color={color} size={size} />}
              onPress={() => router.navigate('/driver-updates')}
            />
          </View>
        </ScrollView>
      </PinnedHeaderScreen>

      <EarningsSheet
        visible={earningsOpen}
        onClose={() => setEarningsOpen(false)}
        summary={earnings}
      />

      <AlertsSheet
        open={alertsOpen}
        onClose={() => setAlertsOpen(false)}
        alerts={alerts}
        onGo={(href) => {
          setAlertsOpen(false);
          router.navigate(href as '/');
        }}
      />

      <CompletionSheet
        job={completing}
        onClose={() => setCompleting(null)}
        onDone={async () => {
          setCompleting(null);
          await refresh();
        }}
      />
    </>
  );
}

// ------------------------------------------------------------ the pieces ----

/**
 * The furthest-along active job.
 *
 * Ties break on the older acceptance, so two parcels at the same stage resolve
 * to the one that has been waiting longest rather than flipping between renders.
 */
function mostAdvanced(jobs: Booking[]): Booking | null {
  if (jobs.length === 0) return null;

  const rank = (job: Booking) => stageIndex(job.status);

  return [...jobs].sort((a, b) => {
    const byStage = rank(b) - rank(a);
    if (byStage !== 0) return byStage;
    return (a.acceptedAt ?? '').localeCompare(b.acceptedAt ?? '');
  })[0];
}

function markersFor(job: Booking | null): MapMarker[] {
  if (!job) return [];

  const markers: MapMarker[] = [];
  if (job.pickupLat !== null && job.pickupLng !== null) {
    markers.push({
      lat: job.pickupLat,
      lng: job.pickupLng,
      label: `Pickup: ${job.pickupAddress}`,
      tone: 'pickup',
    });
  }
  if (job.dropoffLat !== null && job.dropoffLng !== null) {
    markers.push({
      lat: job.dropoffLat,
      lng: job.dropoffLng,
      label: `Drop-off: ${job.dropoffAddress}`,
      tone: 'dropoff',
    });
  }
  return markers;
}

function CurrentJob({
  job,
  busy,
  canAct,
  onAdvance,
  onNavigate,
  onCall,
  onOpen,
}: {
  job: Booking;
  busy: boolean;
  canAct: boolean;
  onAdvance: () => void;
  onNavigate: () => void;
  onCall: () => void;
  onOpen: () => void;
}) {
  const theme = useTheme();
  const label = advanceLabel(job.status);
  const next = nextStage(job.status);

  /*
   * Derived here rather than passed in, so the card cannot be handed a leg that
   * disagrees with the job it is rendering.
   */
  const leg = activeLeg(job);

  return (
    <Card style={styles.currentCard}>
      <View style={styles.currentHeader}>
        <View style={styles.currentHeaderText}>
          <Text style={[styles.currentLabel, { color: theme.textMuted }]}>Current job</Text>
          <Text style={[styles.currentId, { color: theme.text }]}>#{job.trackingId}</Text>
        </View>
        <Badge label={statusLabel(job)} tone={statusTone(job)} />
      </View>

      <Text style={[styles.currentItem, { color: theme.text }]} numberOfLines={2}>
        {job.itemDescription}
      </Text>
      <Text style={[styles.currentRoute, { color: theme.textSecondary }]}>
        {routeEndpoints(job)}
      </Text>

      {/*
        The end of the trip the driver is on, not always the far end.

        Before collection this reads the pickup contact and the pickup address;
        after it, the recipient and the drop-off. It used to always show the
        recipient, which put a drop-off address on screen for a parcel still
        sitting with the sender.
      */}
      <View style={[styles.recipientRow, { backgroundColor: theme.surfaceMuted }]}>
        <MapPin color={theme.primary} size={15} />
        <View style={styles.legText}>
          <Text style={[styles.recipientText, { color: theme.textSecondary }]}>
            {leg.name} · {leg.address}
          </Text>
          <Text style={[styles.legHint, { color: theme.textMuted }]}>{leg.hint}</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Button
          label="Open Navigation"
          icon={(color, size) => <Navigation color={color} size={size} />}
          onPress={onNavigate}
        />
        <View style={styles.actionRow}>
          <Button
            label={leg.callLabel}
            variant="secondary"
            size="md"
            icon={(color, size) => <Phone color={color} size={size} />}
            onPress={onCall}
            style={styles.actionHalf}
            accessibilityLabel={`${leg.callLabel}, ${leg.name}`}
          />
          <Button
            label="Parcel details"
            variant="secondary"
            size="md"
            icon={(color, size) => <ClipboardList color={color} size={size} />}
            onPress={onOpen}
            style={styles.actionHalf}
          />
        </View>
      </View>

      <View style={[styles.divider, { backgroundColor: theme.border }]} />

      {/*
        The one control that changes the world.

        Disabled rather than hidden when the driver is not approved, because a
        missing button reads as a broken app while a disabled one with a reason
        under it reads as a rule.
      */}
      {label && next ? (
        <>
          <Button
            label={busy ? 'Saving…' : label}
            icon={(color, size) =>
              isFinalStep(job.status) ? (
                <Camera color={color} size={size} />
              ) : (
                <Truck color={color} size={size} />
              )
            }
            onPress={onAdvance}
            disabled={busy || !canAct}
          />
          <Text style={[styles.advanceNote, { color: theme.textMuted }]}>
            {canAct
              ? `Moves this parcel to ${next}. Stages only go forward.`
              : 'Available once your driver application is approved.'}
          </Text>
        </>
      ) : (
        <Text style={[styles.advanceNote, { color: theme.textMuted }]}>
          Nothing to update on this parcel.
        </Text>
      )}

      {/*
        Releasing the job, only while the parcel is still with the sender.
        `CancelAction` renders nothing once it has been collected — at that
        point the driver is holding someone else's property.
      */}
      <CancelAction booking={job} />

      <View style={[styles.payoutRow, { backgroundColor: theme.surfaceMuted }]}>
        <Text style={[styles.payoutLabel, { color: theme.textSecondary }]}>Payout on delivery</Text>
        <Text style={[styles.payoutValue, { color: theme.primary }]}>
          {formatNaira(job.estimatedFee)}
        </Text>
      </View>
    </Card>
  );
}

function MiniJob({ job, onPress }: { job: Booking; onPress: () => void }) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${job.trackingId}, ${statusLabel(job)}`}
      style={({ pressed }) => [
        styles.mini,
        { backgroundColor: theme.surface, borderColor: theme.border },
        pressed && styles.pressed,
      ]}>
      <View style={styles.miniText}>
        <Text style={[styles.miniId, { color: theme.text }]}>#{job.trackingId}</Text>
        <Text style={[styles.miniRoute, { color: theme.textMuted }]} numberOfLines={1}>
          {routeEndpoints(job)}
        </Text>
      </View>
      <Badge label={statusLabel(job)} tone={statusTone(job)} />
    </Pressable>
  );
}

function AlertsSheet({
  open,
  onClose,
  alerts,
  onGo,
}: {
  open: boolean;
  onClose: () => void;
  alerts: ReturnType<typeof driverAlerts>;
  onGo: (href: string) => void;
}) {
  const theme = useTheme();

  return (
    <BottomSheet visible={open} onClose={onClose} maxHeight="60%">
      <Text style={[styles.sheetTitle, { color: theme.text }]}>Needs your attention</Text>

      {alerts.length === 0 ? (
        <Text style={[styles.sheetBody, { color: theme.textMuted }]}>
          Nothing outstanding. This list is built from your jobs, so it empties when the work is
          done rather than when you have read it.
        </Text>
      ) : (
        <View style={styles.list}>
          {alerts.map((alert) => (
            <Pressable
              key={alert.key}
              onPress={() => alert.href && onGo(alert.href)}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.alertRow,
                {
                  backgroundColor:
                    alert.tone === 'warning' ? theme.warningSoft : theme.backgroundElement,
                },
                pressed && styles.pressed,
              ]}>
              <Text
                style={[
                  styles.alertTitle,
                  { color: alert.tone === 'warning' ? theme.warningOnSoft : theme.text },
                ]}>
                {alert.title}
              </Text>
              <Text
                style={[
                  styles.alertDetail,
                  { color: alert.tone === 'warning' ? theme.warningOnSoft : theme.textMuted },
                ]}>
                {alert.detail}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </BottomSheet>
  );
}

/**
 * Completing a delivery.
 *
 * A name is required because the server requires it — see `advance_booking`.
 * The photo is optional here and enforced nowhere, which is a deliberate
 * limitation rather than an oversight: a driver in a compound with no signal
 * still has to be able to close the job, and blocking them would push them to
 * mark it delivered later from somewhere with better reception, which is worse
 * evidence than no photo.
 */
function CompletionSheet({
  job,
  onClose,
  onDone,
}: {
  job: Booking | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const theme = useTheme();
  const [receivedBy, setReceivedBy] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    setReceivedBy('');
    setNote('');
    setPhoto('');
    setError('');
    onClose();
  };

  const submit = async () => {
    if (!job) return;

    const name = receivedBy.trim();
    if (name.length < 2) {
      setError('Write the name of whoever took the parcel.');
      return;
    }

    setBusy(true);
    setError('');

    try {
      /*
       * Upload first, then record.
       *
       * The other order would write a proof_path pointing at an object that
       * failed to upload — a delivery that claims evidence it does not have is
       * worse than one that admits it has none.
       */
      let path: string | undefined;
      if (photo && isSupabaseConfigured) {
        const result = await uploadProof(job.id, photo);
        if (!result.ok) {
          setError(`The photo did not upload: ${result.error}`);
          setBusy(false);
          return;
        }
        path = result.path;
      }

      await advanceBooking({
        bookingId: job.id,
        receivedBy: name,
        proofPath: path,
        note: note.trim() || undefined,
      });

      showToast(`#${job.trackingId} delivered`, {
        message: path ? `Received by ${name}, photo attached.` : `Received by ${name}.`,
      });

      setReceivedBy('');
      setNote('');
      setPhoto('');
      await onDone();
    } catch (thrown) {
      setError(errorMessage(thrown, 'That did not go through.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet visible={job !== null} onClose={close}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetScroll}>
        <Text style={[styles.sheetTitle, { color: theme.text }]}>Complete this delivery</Text>
        <Text style={[styles.sheetBody, { color: theme.textMuted }]}>
          {job ? `#${job.trackingId} · ${job.recipientName}` : ''}
        </Text>

        <Field
          label="Who received it"
          placeholder="Full name of the person at the door"
          value={receivedBy}
          onChangeText={setReceivedBy}
          autoCapitalize="words"
          hint="Often not the named recipient — a receptionist, a spouse, a neighbour. Write who actually took it."
        />

        <PhotoPicker
          label="Proof photo"
          hint="The parcel with the person or the door. Stored privately and visible only to you, the sender and an admin."
          value={photo}
          onChange={setPhoto}
        />

        {photo && !isSupabaseConfigured && (
          <Text style={[styles.warn, { color: theme.warningOnSoft }]}>
            Storage is not configured in this build, so the photo will not be saved. The delivery
            will still be recorded.
          </Text>
        )}

        <Field
          label="Note (optional)"
          placeholder="Anything worth recording about the handover"
          value={note}
          onChangeText={setNote}
          multiline
        />

        {error.length > 0 && <Text style={[styles.warn, { color: theme.danger }]}>{error}</Text>}

        <Button
          label={busy ? 'Recording…' : 'Mark delivered'}
          onPress={submit}
          disabled={busy}
          icon={(color, size) => <Camera color={color} size={size} />}
        />
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingBottom: Spacing.six,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three - 4,
    ...(Elevation.raised ?? {}),
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: FontSize.small,
    ...font(800),
    letterSpacing: 0.5,
  },
  headerText: {
    flex: 1,
    gap: 1,
  },
  headerTitle: {
    fontSize: FontSize.subhead,
    ...font(800),
    letterSpacing: -0.2,
  },
  headerMeta: {
    ...Typography.caption,
  },
  bell: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /**
   * The count sits in the badge rather than being a bare dot, so the state is
   * carried by a number and not by colour alone (WCAG 1.4.1).
   */
  badgeDot: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeDotText: {
    color: '#FFFFFF',
    fontSize: FontSize.micro - 1,
    ...font(800),
  },
  gate: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    marginHorizontal: Spacing.three,
    marginTop: Spacing.three - 4,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
  },
  gateText: {
    flex: 1,
    ...Typography.caption,
    lineHeight: 18,
  },
  mapWrap: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three - 4,
    gap: Spacing.two,
  },
  mapNote: {
    ...Typography.caption,
    lineHeight: 17,
  },
  body: {
    ...screenPadding,
    paddingTop: Spacing.three,
    gap: Spacing.three,
  },
  currentCard: {
    gap: Spacing.two + 2,
  },
  currentHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  currentHeaderText: {
    flex: 1,
    gap: Spacing.half,
  },
  currentLabel: {
    ...Typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  currentId: {
    ...Typography.sectionTitle,
  },
  currentItem: {
    ...Typography.cardTitle,
  },
  currentRoute: {
    ...Typography.meta,
    lineHeight: 19,
  },
  recipientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.two + 2,
    borderRadius: Radius.sm,
  },
  recipientText: {
    flex: 1,
    ...Typography.meta,
  },
  actions: {
    gap: Spacing.two,
  },
  actionRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionHalf: {
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  advanceNote: {
    ...Typography.caption,
    lineHeight: 17,
  },
  payoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three - 2,
    paddingVertical: Spacing.two + 2,
    borderRadius: Radius.sm,
  },
  payoutLabel: {
    ...Typography.meta,
  },
  payoutValue: {
    fontSize: FontSize.subhead,
    ...font(700),
  },
  missed: { ...Typography.caption, lineHeight: 18 },
  legText: { flex: 1, gap: 2 },
  legHint: { ...Typography.caption },
  emptyWrap: {
    gap: Spacing.three,
  },
  section: {
    gap: Spacing.two,
  },
  sectionTitle: {
    ...Typography.sectionTitle,
  },
  sectionNote: {
    ...Typography.caption,
  },
  list: {
    gap: Spacing.two,
  },
  mini: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  miniText: {
    flex: 1,
    gap: Spacing.half,
  },
  miniId: {
    ...Typography.meta,
    ...font(700),
  },
  miniRoute: {
    ...Typography.caption,
  },
  footerCta: {
    marginTop: Spacing.two,
  },
  sheetScroll: {
    gap: Spacing.three,
  },
  sheetTitle: {
    ...Typography.sectionTitle,
  },
  sheetBody: {
    ...Typography.meta,
    lineHeight: 20,
  },
  alertRow: {
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    gap: Spacing.half,
  },
  alertTitle: {
    ...Typography.meta,
    ...font(700),
  },
  alertDetail: {
    ...Typography.caption,
  },
  warn: {
    ...Typography.caption,
    lineHeight: 17,
  },
  pressed: {
    opacity: 0.6,
  },
});

/*
 * Not built, and named rather than quietly missing:
 *
 *   Turn-by-turn navigation. Handed to Google Maps — see `src/lib/handoff.ts`.
 *   Liveness / face verification. Needs a vendor and a privacy notice.
 *   An online/offline toggle. There is no dispatcher to be online *for* yet, so
 *     a switch that changed nothing would be theatre.
 */
