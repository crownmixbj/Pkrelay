import { useRouter } from 'expo-router';
import {
  Banknote,
  BellRing,
  Box,
  CalendarDays,
  Car,
  ClipboardList,
  FileText,
  IdCard,
  Mail,
  MapPin,
  Milestone,
  Navigation,
  PackageSearch,
  Phone,
  Route,
  ShieldAlert,
  Truck,
  Weight,
} from 'lucide-react-native';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Badge, RoutePill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, screenPadding, ScreenHeader, SectionLabel } from '@/components/ui/screen';
import { FontSize, MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  formatNaira,
  isCarrier,
  pickupWindow,
  routeLabel,
  handoverLabel,
  sizeBand,
  statusLabel,
  statusTone,
  useBookings,
  type Booking,
} from '@/store/bookings';
import { DriverHub } from '@/components/ui/driver-hub';
import { SignedOutState } from '@/components/ui/signed-out-state';
import {
  REVIEW_WORKING_DAYS,
  STATUS_LABELS,
  type DriverApplication,
} from '@/store/driver-applications';
import { useSession } from '@/store/session';
import { useExperience } from '@/hooks/use-experience';

/**
 * The Driver Portal.
 *
 * Everything a driver needs about themselves in one place: who we have them
 * down as, where their application stands, and the deliveries they are
 * carrying. Browsing and claiming new jobs stays on /available-packages — that
 * screen is open to anyone, and this one is not.
 *
 * The order is deliberate. Identity and application status sit above the job
 * list because for most people opening this screen the answer they want is
 * "am I approved yet?", and an unapproved driver has no jobs to show at all.
 */
export default function DriverScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { bookings } = useBookings();
  const { viewerId, application, isApprovedDriver } = useSession();
  const experience = useExperience();

  const myJobs = useMemo(
    () => (viewerId ? bookings.filter((booking) => isCarrier(booking, viewerId)) : []),
    [bookings, viewerId],
  );

  const active = useMemo(() => myJobs.filter((b) => b.status !== 'Delivered'), [myJobs]);
  const completed = useMemo(() => myJobs.filter((b) => b.status === 'Delivered'), [myJobs]);

  /*
   * Two screens behind one route.
   *
   * On a phone this is the Driver Hub: a map, the current job, and the three
   * things you press while standing next to a gate. On the web dashboard it
   * stays the portal below — details, application status, full history — which
   * is what you want at a desk and unusable one-handed.
   *
   * Same href either way, so the tab bar, the nav bar and every existing link
   * keep working without knowing which one they lead to.
   */
  if (experience === 'driver') return <DriverHub />;

  if (!viewerId) {
    return (
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[styles.container, screenPadding]}>
        <View style={styles.content}>
          <ScreenHeader
            brand={false}
            title="Driver Portal"
            subtitle="Your details, your application, and the deliveries you're carrying."
          />
          <SignedOutState
            title="Sign in to open your portal"
            message="Your application and accepted deliveries are tied to your account. Browsing open jobs needs no account — claiming one does."
            next="/driver"
          />
        </View>
        <Footer />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        <ScreenHeader
          brand={false}
          title="Driver Portal"
          subtitle={
            application
              ? `${STATUS_LABELS[application.status]} · ${application.reference}`
              : "You haven't applied to drive yet."
          }
        />

        {/* ---------- Who we have you down as ---------- */}
        {application ? (
          <DriverIdentity application={application} />
        ) : (
          <ApplyPrompt onApply={() => router.navigate('/driver-signup')} />
        )}

        {/*
          The approval gate, stated once and plainly.

          An unapproved driver browsing Find Jobs meets a greyed-out Accept
          button with no explanation on that screen — this is where the reason
          lives, next to the status it depends on.
        */}
        {application && !isApprovedDriver && (
          <View style={[styles.gateNotice, { backgroundColor: theme.warningSoft }]}>
            <ShieldAlert color={theme.warningOnSoft} size={16} />
            <View style={styles.gateText}>
              <Text style={[styles.gateTitle, { color: theme.warningOnSoft }]}>
                You can&apos;t accept jobs yet
              </Text>
              <Text style={[styles.gateBody, { color: theme.warningOnSoft }]}>
                Claiming a delivery unlocks when an admin approves your application. You can browse
                open jobs in the meantime.
              </Text>
            </View>
          </View>
        )}

        {/*
          ---------- Money is not on this page, and neither is a link to it ----

          Three things about money used to live here: the payout account card
          (the Wallet renders the same component), an "Expected payout" total
          that was a *different number* from the wallet balance — gross, and
          counting parcels still moving — and then a button to the Wallet.

          All three are gone. The split is by subject: this screen is who Package Relay
          has you down as and what you are carrying; the Wallet is every
          question about money, including which account it lands in.

          ⚠ No signpost here on purpose, which is only safe because navigation
            carries one on every surface: "Driver Wallet / Payouts" in the Jobs
            & Drivers dropdown on web, and a Wallet tab in the bottom bar on a
            driver's phone. `verify-wallet` asserts both, and those assertions
            are load-bearing now rather than merely tidy — deleting either one
            would leave the wallet with no route to it at all.
        */}
        {/*
          ---------- the two entries that left the nav ----------

          Setup Trip and this dashboard used to be items in the public "Driver"
          dropdown. They are a driver's working tools rather than public
          navigation, so they moved here — which makes this page the one place a
          driver manages their work, and makes the removal safe: without these
          links `/available-packages` would be reachable on web from nothing at
          all.
        */}
        {/*
          ⚠ Primary, and high on the page, because it is the whole job.

            This was a quiet secondary button, and the *loud* one — "Schedule a
            journey" — sat at the bottom of the empty state, below a full screen
            of nothing. On a laptop it was under the fold, which meant the one
            action that makes a driver's phone ring was the one action they had
            to go looking for. Declaring a trip is not a secondary act on this
            screen; it is the only thing here a driver does rather than reads.
        */}
        {isApprovedDriver && (
          <Button
            label="Setup Trip"
            size="md"
            icon={(color, size) => <PackageSearch color={color} size={size} />}
            onPress={() => router.navigate('/available-packages')}
            style={styles.workCta}
          />
        )}

        {application && (
          <Button
            label="Application status & updates"
            variant="secondary"
            size="md"
            icon={(color, size) => <BellRing color={color} size={size} />}
            onPress={() => router.navigate('/driver-updates')}
            style={styles.updatesCta}
          />
        )}

        {/* ---------- What you're carrying ---------- */}
        <SectionLabel>Your deliveries</SectionLabel>

        {/*
          Counts, not money.

          The third cell here was "Expected payout" — gross quoted fares across
          every parcel, delivered or not. The Wallet's headline is net of
          commission, delivered only, and less a security hold, so the two were
          never going to match, and showing both a click apart invited a driver
          to treat the larger one as their balance. One money figure, in the
          place that owns money.
        */}
        {myJobs.length > 0 && (
          <Card style={styles.summary}>
            <Stat label="Active" value={String(active.length)} />
            <View style={[styles.statDivider, { backgroundColor: theme.border }]} />
            <Stat label="Delivered" value={String(completed.length)} />
          </Card>
        )}

        {myJobs.length === 0 ? (
          /*
            ⚠ No button under here any more, and its absence is the point.

              The empty state used to end in a primary "Schedule a journey".
              Two problems with it. It was the second copy of the button now
              sitting above "Your deliveries", so moving that one up would have
              left a driver two identical calls to action a screen apart. And it
              was shown to *everybody*, including someone who has never applied
              — the loudest control on their screen, pointing at a planner that
              answers "scheduling unlocks when you are approved". Their next
              step is the application card at the top, and this was competing
              with it.

              The message still names the fix, so nobody is left wondering what
              to do; the control that does it is above, where an approved driver
              will already have passed it.
          */
          <View style={styles.emptyWrap}>
            <EmptyState
              icon={(color, size) => <ClipboardList color={color} size={size} />}
              title="No jobs yet"
              message="You haven't carried anything yet. Use Setup Trip to tell Package Relay the journeys you are making, and parcels going the same way are offered to you automatically."
            />
          </View>
        ) : (
          <>
            {active.length > 0 && (
              <View style={styles.section}>
                <SectionLabel>{`In progress (${active.length})`}</SectionLabel>
                <View style={styles.list}>
                  {active.map((booking) => (
                    <JobCard key={booking.id} booking={booking} />
                  ))}
                </View>
              </View>
            )}

            {completed.length > 0 && (
              <View style={styles.section}>
                <SectionLabel>{`Delivered (${completed.length})`}</SectionLabel>
                <View style={styles.list}>
                  {completed.map((booking) => (
                    <JobCard key={booking.id} booking={booking} />
                  ))}
                </View>
              </View>
            )}

            <Button
              label="Schedule another journey"
              variant="secondary"
              icon={(color, size) => <PackageSearch color={color} size={size} />}
              onPress={() => router.navigate('/available-packages')}
              style={styles.cta}
            />
          </>
        )}
      </View>
      <Footer />
    </ScrollView>
  );
}

/**
 * The details on file, read back to the driver.
 *
 * Read-only on purpose. These fields were verified during review — a licence
 * number or a plate that could be edited after approval would make the review
 * meaningless. Changing them has to go back through a human.
 */
function DriverIdentity({ application }: { application: DriverApplication }) {
  const theme = useTheme();

  const tone =
    application.status === 'approved'
      ? 'success'
      : application.status === 'rejected'
        ? 'danger'
        : application.status === 'under_review'
          ? 'primary'
          : 'warning';

  return (
    <Card style={styles.identity}>
      <View style={styles.identityHeader}>
        <View style={[styles.avatar, { backgroundColor: theme.primarySoft }]}>
          <Text style={[styles.avatarText, { color: theme.primaryOnSoft }]}>
            {application.fullName
              .trim()
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0])
              .join('')
              .toUpperCase()}
          </Text>
        </View>
        <View style={styles.identityHeaderText}>
          <Text style={[styles.identityName, { color: theme.text }]}>{application.fullName}</Text>
          <Text style={[styles.identityMeta, { color: theme.textMuted }]}>
            {application.baseCity ?? application.state} · {application.reference}
          </Text>
        </View>
        <Badge label={STATUS_LABELS[application.status]} tone={tone} />
      </View>

      <View style={[styles.divider, { backgroundColor: theme.border }]} />

      <View style={styles.identityGrid}>
        <Field icon={<Phone color={theme.textMuted} size={14} />} label="Phone">
          {application.phone}
        </Field>
        <Field icon={<Mail color={theme.textMuted} size={14} />} label="Email">
          {application.email}
        </Field>
        <Field icon={<Car color={theme.textMuted} size={14} />} label="Vehicle">
          {application.vehicleType} · {application.plateNumber}
        </Field>
        <Field icon={<IdCard color={theme.textMuted} size={14} />} label="Licence">
          {application.licenseId}
        </Field>
        <Field icon={<MapPin color={theme.textMuted} size={14} />} label="Operating in">
          {application.baseCity ?? application.state}
        </Field>
        <Field icon={<CalendarDays color={theme.textMuted} size={14} />} label="Applied">
          {new Date(application.submittedAt).toLocaleDateString()}
        </Field>
      </View>

      {/*
        This used to say "email support", and had done since before
        `update_driver_profile` existed. It is now wrong: an approved driver can
        change their plate, vehicle and address themselves on Be a Driver /
        Updates, and identity fields there send the account back for review.
        Copy that tells someone to email support for a job the app does is the
        kind of stale sentence that makes people distrust the rest of the page.
      */}
      <Text style={[styles.identityFootnote, { color: theme.textMuted }]}>
        Checked during review, so they are read-only here. Vehicle, plate and address can be changed
        under Be a Driver / Updates; changing your name, NIN or licence there sends your account
        back for review.
      </Text>
    </Card>
  );
}

function Field({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();

  return (
    <View style={styles.field}>
      <View style={styles.fieldLabel}>
        {icon}
        <Text style={[styles.fieldLabelText, { color: theme.textMuted }]}>{label}</Text>
      </View>
      <Text style={[styles.fieldValue, { color: theme.text }]}>{children}</Text>
    </View>
  );
}

/** No application on file: the portal's only useful job is to start one. */
function ApplyPrompt({ onApply }: { onApply: () => void }) {
  const theme = useTheme();

  return (
    <Card style={styles.applyCard}>
      <View style={[styles.applyIcon, { backgroundColor: theme.primarySoft }]}>
        <Truck color={theme.primaryOnSoft} size={22} />
      </View>
      <Text style={[styles.applyTitle, { color: theme.text }]}>Drive with Package Relay</Text>
      <Text style={[styles.applyBody, { color: theme.textSecondary }]}>
        Anyone with an account can send a parcel. Carrying one needs an approved driver application
        — vehicle, licence, guarantor and payout details, reviewed within {REVIEW_WORKING_DAYS}{' '}
        working days.
      </Text>
      <Button
        label="Start your driver application"
        icon={(color, size) => <FileText color={color} size={size} />}
        onPress={onApply}
      />
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  const theme = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: accent ? theme.primary : theme.text }]}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: theme.textMuted }]}>{label}</Text>
    </View>
  );
}

function JobCard({ booking }: { booking: Booking }) {
  const theme = useTheme();
  const isLocal = booking.deliveryType === 'local';
  const isDelivered = booking.status === 'Delivered';

  return (
    <Card style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderText}>
          <Text style={[styles.itemName, { color: theme.text }]} numberOfLines={2}>
            {booking.itemDescription}
          </Text>
          <Text style={[styles.trackingId, { color: theme.textMuted }]}>#{booking.trackingId}</Text>
        </View>
        <Badge label={statusLabel(booking)} tone={statusTone(booking)} />
      </View>

      <RoutePill
        label={routeLabel(booking)}
        tone={isLocal ? 'success' : 'primary'}
        icon={(color) =>
          isLocal ? <MapPin color={color} size={11} /> : <Milestone color={color} size={11} />
        }
      />

      <View style={[styles.divider, { backgroundColor: theme.border }]} />

      <View style={styles.legs}>
        <View style={styles.leg}>
          <MapPin color={theme.primary} size={15} />
          <Text style={[styles.legText, { color: theme.textSecondary }]}>
            {booking.pickupAddress}, {booking.pickupArea}, {booking.originCity}
          </Text>
        </View>
        <View style={styles.leg}>
          <Navigation color={theme.success} size={15} />
          <Text style={[styles.legText, { color: theme.textSecondary }]}>
            {booking.dropoffAddress}, {booking.dropoffArea}, {booking.destinationCity}
          </Text>
        </View>
      </View>

      <View style={styles.metrics}>
        <Metric
          icon={<Weight color={theme.textMuted} size={13} />}
          value={`${booking.weight} kg`}
        />
        <Metric icon={<Box color={theme.textMuted} size={13} />} value={sizeBand(booking)} />
        <Metric icon={<Route color={theme.textMuted} size={13} />} value={handoverLabel(booking)} />
        <Metric icon={<Phone color={theme.textMuted} size={13} />} value={booking.recipientPhone} />
      </View>

      {!isDelivered && (
        <Text style={[styles.window, { color: theme.warningOnSoft }]}>{pickupWindow(booking)}</Text>
      )}

      <View style={[styles.payoutRow, { backgroundColor: theme.surfaceMuted }]}>
        <View style={styles.metric}>
          <Banknote color={theme.textMuted} size={15} />
          {/*
            "Fare", not "Earned".

            This is the gross amount the sender was quoted. The driver's actual
            credit for this parcel is that figure less commission, and it lives
            in `driver_earnings` — so a delivered card headed "Earned" with a
            bigger number than the wallet row for the same trip is the same
            contradiction as the old Expected total, one parcel at a time.
          */}
          <Text style={[styles.payoutLabel, { color: theme.textSecondary }]}>
            {isDelivered ? 'Fare' : 'Fare on delivery'}
          </Text>
        </View>
        <Text style={[styles.payoutValue, { color: isDelivered ? theme.success : theme.primary }]}>
          {formatNaira(booking.estimatedFee)}
        </Text>
      </View>
    </Card>
  );
}

function Metric({ icon, value }: { icon: React.ReactNode; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.metric}>
      {icon}
      <Text style={[styles.metricText, { color: theme.textSecondary }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    // Without a max width the `alignItems: 'center'` above has nothing to do:
    // the content is already as wide as the viewport. Same omission that left
    // Schedule My Journey stretching across a desktop.
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  identity: {
    gap: Spacing.three - 2,
    marginBottom: Spacing.three,
  },
  identityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: FontSize.body,
    ...font(800),
    letterSpacing: 0.5,
  },
  identityHeaderText: {
    flex: 1,
    gap: Spacing.half,
  },
  identityName: {
    ...Typography.sectionTitle,
  },
  identityMeta: {
    ...Typography.meta,
  },
  /**
   * Two columns on anything wider than a phone. `flexBasis: 160` with
   * `flexGrow` means one column below ~340px and two above, without a
   * breakpoint to keep in sync.
   */
  identityGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three - 2,
  },
  field: {
    flexGrow: 1,
    flexBasis: 160,
    gap: Spacing.half,
  },
  fieldLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  fieldLabelText: {
    ...Typography.caption,
  },
  fieldValue: {
    ...Typography.meta,
    ...font(600),
  },
  identityFootnote: {
    ...Typography.caption,
    lineHeight: 18,
  },
  applyCard: {
    gap: Spacing.two + 2,
    marginBottom: Spacing.three,
  },
  applyIcon: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyTitle: {
    ...Typography.sectionTitle,
  },
  applyBody: {
    ...Typography.meta,
    lineHeight: 21,
  },
  gateNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    marginBottom: Spacing.three,
  },
  gateText: {
    flex: 1,
    gap: Spacing.half,
  },
  gateTitle: {
    ...Typography.meta,
    ...font(700),
  },
  gateBody: {
    ...Typography.caption,
    lineHeight: 18,
  },
  /** Spacing above the two working-tool links. */
  workCta: {
    marginTop: Spacing.three,
  },
  updatesCta: {
    marginBottom: Spacing.four,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.three - 2,
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.half,
  },
  statValue: {
    fontSize: FontSize.subhead,
    ...font(700),
  },
  statLabel: {
    ...Typography.caption,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  emptyWrap: {
    gap: Spacing.three,
    marginTop: Spacing.four,
  },
  section: {
    marginTop: Spacing.four,
  },
  list: {
    gap: Spacing.three - 2,
  },
  card: {
    gap: Spacing.two + 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  cardHeaderText: {
    flex: 1,
    gap: Spacing.half,
  },
  itemName: {
    ...Typography.cardTitle,
  },
  trackingId: {
    ...Typography.caption,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  legs: {
    gap: Spacing.two,
  },
  leg: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  legText: {
    flex: 1,
    ...Typography.meta,
    lineHeight: 19,
  },
  metrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three - 4,
  },
  metric: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  metricText: {
    ...Typography.meta,
  },
  window: {
    ...Typography.meta,
    ...font(600),
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
  cta: {
    marginTop: Spacing.four,
  },
});
