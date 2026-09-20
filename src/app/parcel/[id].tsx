import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import {
  Ban,
  Bike,
  CircleCheckBig,
  ClipboardList,
  House,
  MapPin,
  Milestone,
  Navigation,
  PackageCheck,
  PackageSearch,
  Phone,
  Receipt,
  ShieldAlert,
  Truck,
  UserCheck,
  UserRound,
  X,
} from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Badge, RoutePill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/screen';
import { Skeleton, SkeletonGroup, SkeletonText } from '@/components/ui/skeleton';
import { CancelAction } from '@/components/ui/cancel-action';
import { MapView, type MapMarker } from '@/components/ui/map-view';
import { StickyHeaderScreen } from '@/components/ui/sticky-header';
import { FontSize, MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { findParcel } from '@/lib/parcel-link';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { useSession } from '@/store/session';
import { useTheme } from '@/hooks/use-theme';
import {
  BOOKING_STAGES,
  estimateFee,
  formatBookingDate,
  formatNaira,
  handoverFeeLabel,
  routeLabel,
  stageIndex,
  statusLabel,
  statusTone,
  useBookings,
  type BookingStage,
} from '@/store/bookings';

const STAGE_ICONS: Record<BookingStage, typeof Truck> = {
  Booked: ClipboardList,
  Assigned: UserCheck,
  'Picked Up': PackageCheck,
  'In Transit': Truck,
  'Out for Delivery': Bike,
  Delivered: House,
  // Not a stage on the journey, but the map has to be total — a parcel a sender
  // called off still appears in their list and still needs an icon.
  Cancelled: Ban,
};

export default function ParcelDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { bookings, loading } = useBookings();
  const { isAuthenticated } = useSession();

  /**
   * The parcel, by whichever identifier the link carried.
   *
   * ⚠ Two kinds of link reach this screen, and this used to resolve only one.
   *
   *   Everything inside the app navigates with the row's uuid —
   *   `router.navigate(`/parcel/${booking.id}`)` in tracking, parcel-confirmed,
   *   the driver hub and the notification centre. The emails do not: every
   *   template in `notify-events/templates.ts` builds
   *   `/parcel/${encodeURIComponent(tracking_id)}`, because a tracking id is
   *   the thing a person can read out over the phone and a uuid is not.
   *
   *   `bookings.find((b) => b.id === id)` matched the first and silently missed
   *   the second, so every tracking link ever emailed landed on "Parcel not
   *   found" — permanently, not briefly.
   *
   *   Fixed here rather than by changing the emails, because emails already
   *   sent cannot be changed. A link in an August delivery notice has to keep
   *   working, so the screen is what learns to accept both.
   *
   * `getBooking` is the store's own tracking-id lookup — case-insensitive,
   * already written, already used by the tracking screen. Matching the string
   * again here would be a second implementation of one question.
   */
  const booking = useMemo(() => findParcel(bookings, id), [bookings, id]);

  /*
   * ⚠ Loading is checked before "not found", and that ordering is the fix for
   *   the flash.
   *
   *   `bookings` starts empty and fills after a round trip, so on every cold
   *   load — which is what a tracking link is — this screen rendered the
   *   not-found empty state first and swapped it for the parcel a moment later.
   *   The store has carried a `loading` flag the whole time, documented as
   *   "True during the first load, so screens can avoid flashing an empty
   *   state". This screen was not reading it.
   *
   *   The skeleton is shaped like the content it precedes, so the swap moves
   *   nothing. See `components/ui/skeleton.tsx`.
   */
  if (!booking && loading) {
    return <ParcelDetailSkeleton />;
  }

  /*
   * ⚠ Signed out is a different answer from not found, and a tracking link is
   *   the likeliest place to meet it.
   *
   *   `bookings` is emptied whenever there is no user, and RLS scopes the table
   *   to the sender and the assigned driver — so a sender who opens their
   *   delivery email on a laptop they have never signed in on resolves nothing
   *   at all. Telling them the parcel "may have been removed" is wrong and
   *   alarming about their own parcel, moments after we emailed them about it.
   *
   *   `next` carries them back here afterwards rather than to the home screen,
   *   which is the whole reason they followed the link.
   */
  if (!booking && !isAuthenticated) {
    return (
      <StickyHeaderScreen>
        <ScrollView
          style={{ backgroundColor: theme.background }}
          contentContainerStyle={styles.container}>
          <View style={styles.content}>
            <SignedOutState
              title="Sign in to track this parcel"
              message="Your parcels are tied to your account, so we need to know it is you before showing this one."
              next={`/parcel/${id ?? ''}`}
            />
          </View>
          <Footer />
        </ScrollView>
      </StickyHeaderScreen>
    );
  }

  if (!booking) {
    return (
      <StickyHeaderScreen>
        <ScrollView
          style={{ backgroundColor: theme.background }}
          contentContainerStyle={styles.container}>
          <View style={styles.content}>
            <EmptyState
              icon={(color, size) => <PackageSearch color={color} size={size} />}
              title="Parcel not found"
              message="This parcel may have been removed. Go back and pick another from the list."
            />
            <Button label="Go back" variant="secondary" onPress={() => router.back()} />
          </View>
          <Footer />
        </ScrollView>
      </StickyHeaderScreen>
    );
  }

  const isLocal = booking.deliveryType === 'local';
  const currentIndex = stageIndex(booking.status);
  const fee = estimateFee(booking);

  return (
    <StickyHeaderScreen>
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.container}>
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Badge label={statusLabel(booking)} tone={statusTone(booking)} />
              <Text style={[styles.title, { color: theme.text }]}>{booking.itemDescription}</Text>
              <Text style={[styles.trackingId, { color: theme.textMuted }]}>
                #{booking.trackingId} · {formatBookingDate(booking.createdAt)}
              </Text>
            </View>
            <Pressable
              onPress={() => router.back()}
              hitSlop={10}
              accessibilityLabel="Close"
              style={[styles.close, { backgroundColor: theme.surfaceMuted }]}>
              <X color={theme.textSecondary} size={18} />
            </Pressable>
          </View>

          <View style={styles.pillRow}>
            <RoutePill
              label={routeLabel(booking)}
              tone={isLocal ? 'success' : 'primary'}
              icon={(color) =>
                isLocal ? <MapPin color={color} size={13} /> : <Milestone color={color} size={13} />
              }
            />
            {booking.fragile && (
              <Badge
                label="Fragile"
                tone="warning"
                icon={(color) => <ShieldAlert color={color} size={11} />}
              />
            )}
          </View>

          {/* Journey */}
          <Card style={styles.card}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Journey</Text>
            <View style={styles.timeline}>
              {BOOKING_STAGES.map((stage, index) => {
                const isDone = index < currentIndex;
                const isActive = index === currentIndex;
                const Icon = isDone ? CircleCheckBig : STAGE_ICONS[stage];
                const color = isDone ? theme.success : isActive ? theme.primary : theme.textMuted;

                return (
                  <View key={stage} style={styles.timelineItem}>
                    <Icon color={color} size={18} />
                    <Text
                      style={[
                        styles.timelineText,
                        {
                          color: isActive
                            ? theme.text
                            : isDone
                              ? theme.textSecondary
                              : theme.textMuted,
                        },
                        isActive && styles.timelineTextActive,
                      ]}>
                      {stage}
                    </Text>
                  </View>
                );
              })}
            </View>
          </Card>

          {/* Route */}
          <Card style={styles.card}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Route</Text>

            {/*
              Only when there is something real to plot. A map that pins two
              city centres and calls them pickup and drop-off is worse than the
              addresses below it — for a local delivery both pins land on the
              same dot. No pin, no map.
            */}
            {(() => {
              const pins: MapMarker[] = [];
              if (booking.pickupLat !== null && booking.pickupLng !== null) {
                pins.push({
                  lat: booking.pickupLat,
                  lng: booking.pickupLng,
                  label: `Pickup — ${booking.pickupArea || booking.originCity}`,
                  tone: 'pickup',
                });
              }
              if (booking.dropoffLat !== null && booking.dropoffLng !== null) {
                pins.push({
                  lat: booking.dropoffLat,
                  lng: booking.dropoffLng,
                  label: `Drop-off — ${booking.dropoffArea || booking.destinationCity}`,
                  tone: 'dropoff',
                });
              }

              if (pins.length === 0) return null;

              return (
                <View style={styles.mapWrap}>
                  <MapView markers={pins} showRoute={pins.length > 1} height={200} />
                  {pins.length === 1 && (
                    <Text style={[styles.mapNote, { color: theme.textMuted }]}>
                      Only the {pins[0].tone === 'pickup' ? 'pickup' : 'drop-off'} point was pinned.
                    </Text>
                  )}
                </View>
              );
            })()}
            <Leg
              icon={<MapPin color={theme.primary} size={16} />}
              label="Pickup"
              value={`${booking.pickupAddress}, ${booking.pickupArea}, ${booking.originCity}`}
            />
            <Leg
              icon={<Navigation color={theme.success} size={16} />}
              label="Dropoff"
              value={`${booking.dropoffAddress}, ${booking.dropoffArea}, ${booking.destinationCity}`}
            />
          </Card>

          {/* People */}
          <Card style={styles.card}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Contacts</Text>
            <Leg
              icon={<UserRound color={theme.textMuted} size={16} />}
              label="Recipient"
              value={booking.recipientName}
            />
            <Leg
              icon={<Phone color={theme.textMuted} size={16} />}
              label="Recipient phone"
              value={booking.recipientPhone}
            />
            <Leg
              icon={<Phone color={theme.textMuted} size={16} />}
              label="Sender phone"
              value={booking.senderPhone}
            />
            <Leg
              icon={<Truck color={theme.textMuted} size={16} />}
              label="Driver"
              value={booking.driver ?? 'Not yet assigned'}
            />
          </Card>

          {/* Parcel and fee */}
          <Card style={styles.card}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Parcel</Text>
            <Leg label="Category" value={booking.category} />
            <Leg label="Weight" value={`${booking.weight} kg`} />
            <Leg
              label="Declared value"
              value={booking.declaredValue ? formatNaira(booking.declaredValue) : 'Not declared'}
            />
            {!!booking.notes && <Leg label="Notes" value={booking.notes} />}

            <View style={[styles.divider, { backgroundColor: theme.border }]} />

            <CostRow label="Base fare" value={fee.base} />
            <CostRow label="Weight" value={fee.weight} />
            <CostRow label="Insurance" value={fee.insurance} />
            {fee.handover > 0 && (
              <CostRow
                label={handoverFeeLabel(booking.pickupMode, booking.dropoffMode)}
                value={fee.handover}
              />
            )}

            <View style={[styles.divider, { backgroundColor: theme.border }]} />

            <View style={styles.totalRow}>
              <View style={styles.totalLabelRow}>
                <Receipt color={theme.primary} size={16} />
                <Text style={[styles.totalLabel, { color: theme.text }]}>Total</Text>
              </View>
              <Text style={[styles.totalValue, { color: theme.primary }]}>
                {formatNaira(booking.estimatedFee)}
              </Text>
            </View>
          </Card>

          {/*
            Calling it off lives here rather than on the list card: it is
            irreversible for a sender, and a destructive control one tap from a
            scrolling list is a control people hit by accident.
          */}
          <CancelAction booking={booking} />

          <Button label="Close" variant="secondary" onPress={() => router.back()} />
        </View>
        <Footer />
      </ScrollView>
    </StickyHeaderScreen>
  );
}

function Leg({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.leg}>
      <View style={styles.legLabelRow}>
        {icon}
        <Text style={[styles.legLabel, { color: theme.textMuted }]}>{label}</Text>
      </View>
      <Text style={[styles.legValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

function CostRow({ label, value }: { label: string; value: number }) {
  const theme = useTheme();
  return (
    <View style={styles.costRow}>
      <Text style={[styles.costLabel, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.costValue, { color: theme.text }]}>{formatNaira(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mapWrap: {
    gap: Spacing.one,
    marginBottom: Spacing.two,
  },
  mapNote: {
    ...Typography.caption,
  },
  container: {
    flexGrow: 1,
    alignItems: 'center',
    padding: Spacing.four,
    paddingTop: Spacing.five,
    paddingBottom: Spacing.six,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  headerText: {
    flex: 1,
    gap: Spacing.two - 2,
  },
  title: {
    ...Typography.screenTitle,
    fontSize: FontSize.heading,
  },
  trackingId: {
    ...Typography.meta,
  },
  close: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  card: {
    gap: Spacing.three - 4,
  },
  sectionTitle: {
    ...Typography.sectionTitle,
    marginBottom: Spacing.one,
  },
  timeline: {
    gap: Spacing.two + 2,
  },
  timelineItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
  },
  timelineText: {
    ...Typography.body,
  },
  timelineTextActive: {
    ...font(600),
  },
  leg: {
    gap: Spacing.half,
  },
  legLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  legLabel: {
    ...Typography.caption,
  },
  legValue: {
    ...Typography.body,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Spacing.two - 2,
  },
  costRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  costLabel: {
    ...Typography.meta,
  },
  costValue: {
    ...Typography.meta,
    ...font(600),
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  totalLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two - 2,
  },
  totalLabel: {
    ...Typography.sectionTitle,
  },
  totalValue: {
    fontSize: FontSize.heading,
    ...font(700),
  },
});

/**
 * The parcel screen, one beat earlier.
 *
 * ⚠ It reuses the real screen's style keys rather than defining its own.
 *
 *   That is what makes the swap invisible: the badge, title, tracking line and
 *   pill row occupy the same box in both, so the real content replaces the
 *   placeholder without moving anything. A skeleton with its own spacing is a
 *   second layout, and swapping one layout for another is the flash again, half
 *   a second later.
 *
 *   The consequence is that this has to be edited when the header above is. It
 *   is directly beneath it for that reason.
 */
function ParcelDetailSkeleton() {
  const theme = useTheme();

  return (
    <StickyHeaderScreen>
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.container}>
        <SkeletonGroup label="Loading parcel" style={styles.content}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              {/* Badge, then title, then the tracking line. */}
              <Skeleton width={96} height={26} radius={Radius.pill} />
              <Skeleton width="80%" height={FontSize.heading} />
              <Skeleton width="55%" height={FontSize.small} />
            </View>
            {/* The close button's 34pt square, so the row keeps its height. */}
            <Skeleton width={34} height={34} radius={Radius.md} />
          </View>

          <View style={styles.pillRow}>
            <Skeleton width={150} height={26} radius={Radius.pill} />
            <Skeleton width={110} height={26} radius={Radius.pill} />
          </View>

          {/*
            One card's worth of body. Deliberately not the whole screen: a
            placeholder for content below the fold is motion nobody sees, and
            on a slow connection it is the part most likely to be wrong about
            what actually arrives.
          */}
          <Card>
            <View style={skeletonStyles.card}>
              <Skeleton width="40%" height={FontSize.small} />
              <SkeletonText lines={3} />
            </View>
          </Card>

          <Card>
            <View style={skeletonStyles.card}>
              <Skeleton width="35%" height={FontSize.small} />
              <SkeletonText lines={2} />
            </View>
          </Card>
        </SkeletonGroup>
      </ScrollView>
    </StickyHeaderScreen>
  );
}

const skeletonStyles = StyleSheet.create({
  card: {
    gap: Spacing.three,
  },
});
