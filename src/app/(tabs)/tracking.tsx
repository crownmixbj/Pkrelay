import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Circle,
  CircleCheck,
  CircleDot,
  FileWarning,
  MapPin,
  Navigation,
  PackageSearch,
  Search,
  Truck,
} from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Image } from 'expo-image';

import { Footer } from '@/components/Footer';
import { Badge, RoutePill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MapView, type MapMarker } from '@/components/ui/map-view';
import { EmptyState, screenPadding, ScreenHeader, SectionLabel } from '@/components/ui/screen';
import { MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  BOOKING_STAGES,
  formatNaira,
  routeLabel,
  stageIndex,
  statusLabel,
  statusTone,
  useBookings,
  type Booking,
  type BookingStage,
} from '@/store/bookings';
import { signedProofUrl } from '@/store/delivery';
import { useSession } from '@/store/session';

/**
 * Tracking / Proof of Delivery.
 *
 * Look a parcel up by the tracking ID printed on its booking confirmation.
 *
 * ⚠ Two limits worth knowing before reading the code:
 *
 *   1. This searches parcels *your account can see*. Row Level Security is what
 *      decides that, and it is the right decision — a tracking ID is a short
 *      guessable string, and a public lookup would hand a stranger a recipient's
 *      name, phone number and home address. The consequence is that a recipient
 *      without an account cannot track their own delivery. That is a real gap,
 *      and the screen says so rather than pretending the ID was simply wrong.
 *
 *   2. Proof of delivery is only as good as what the driver captured. The panel
 *      below shows the record that exists — who took it, when, and the photo if
 *      there is one — and says plainly when a parcel was marked delivered
 *      without any of it. A green tick against no evidence would be a false
 *      empty state, which is worse than an honest one.
 */
export default function TrackingScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const { bookings } = useBookings();
  const { viewerId } = useSession();

  const [query, setQuery] = useState(params.id ?? '');
  const [submitted, setSubmitted] = useState(params.id ?? '');

  useEffect(() => {
    if (!params.id) return;
    setQuery(params.id);
    setSubmitted(params.id);
  }, [params.id]);

  /*
   * Case- and whitespace-insensitive. A tracking ID gets read off a screen,
   * typed into a chat, and pasted back — "pkg-9821 " should not be a miss.
   */
  const normalised = submitted.trim().toUpperCase();

  const match = useMemo(
    () =>
      normalised.length === 0
        ? undefined
        : bookings.find((booking) => booking.trackingId.toUpperCase() === normalised),
    [bookings, normalised],
  );

  /** Recent parcels, so the common case needs no typing at all. */
  const recent = useMemo(
    () =>
      viewerId
        ? bookings
            .filter((b) => b.senderId === viewerId || b.driverId === viewerId)
            .slice()
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 4)
        : [],
    [bookings, viewerId],
  );

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        <ScreenHeader
          brand={false}
          title="Tracking / Proof of Delivery"
          subtitle="Enter the tracking ID from your booking confirmation, e.g. PKG-9821."
        />

        <View style={styles.searchRow}>
          <View
            style={[
              styles.inputWrap,
              { backgroundColor: theme.surfaceMuted, borderColor: theme.border },
            ]}>
            <Search color={theme.textMuted} size={17} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => setSubmitted(query)}
              placeholder="PKG-0000"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Tracking ID"
              style={[styles.input, { color: theme.text }]}
            />
          </View>
          <Button label="Track" size="md" onPress={() => setSubmitted(query)} />
        </View>

        {normalised.length === 0 ? (
          recent.length > 0 ? (
            <>
              <SectionLabel>Or pick a recent one</SectionLabel>
              <Card style={styles.recentCard}>
                {recent.map((booking, index) => (
                  <Pressable
                    key={booking.id}
                    onPress={() => {
                      setQuery(booking.trackingId);
                      setSubmitted(booking.trackingId);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Track ${booking.trackingId}, ${booking.itemDescription}`}
                    style={({ pressed }) => [
                      styles.recentRow,
                      index > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: theme.border,
                      },
                      pressed && { backgroundColor: theme.surfaceMuted },
                    ]}>
                    <View style={styles.recentText}>
                      <Text style={[styles.recentId, { color: theme.text }]}>
                        {booking.trackingId}
                      </Text>
                      <Text
                        style={[styles.recentItem, { color: theme.textMuted }]}
                        numberOfLines={1}>
                        {booking.itemDescription} · {routeLabel(booking)}
                      </Text>
                    </View>
                    <Badge label={statusLabel(booking)} tone={statusTone(booking)} />
                  </Pressable>
                ))}
              </Card>
            </>
          ) : (
            <EmptyState
              icon={(color, size) => <PackageSearch color={color} size={size} />}
              title="Nothing to track yet"
              message="Book a parcel and its tracking ID appears on the confirmation, and here."
            />
          )
        ) : match ? (
          <TrackedParcel booking={match} onOpen={() => router.push(`/parcel/${match.id}` as '/')} />
        ) : (
          <NotFound id={normalised} signedIn={Boolean(viewerId)} />
        )}
      </View>
      <Footer />
    </ScrollView>
  );
}

function TrackedParcel({ booking, onOpen }: { booking: Booking; onOpen: () => void }) {
  const theme = useTheme();
  const current = stageIndex(booking.status);

  const markers: MapMarker[] = [];
  if (booking.pickupLat !== null && booking.pickupLng !== null) {
    markers.push({
      lat: booking.pickupLat,
      lng: booking.pickupLng,
      label: `Pickup — ${booking.pickupArea}`,
      tone: 'pickup',
    });
  }
  if (booking.dropoffLat !== null && booking.dropoffLng !== null) {
    markers.push({
      lat: booking.dropoffLat,
      lng: booking.dropoffLng,
      label: `Drop-off — ${booking.dropoffArea}`,
      tone: 'dropoff',
    });
  }

  return (
    <>
      <Card style={styles.summary}>
        <View style={styles.summaryHead}>
          <View style={styles.summaryHeadText}>
            <Text style={[styles.trackingId, { color: theme.text }]}>{booking.trackingId}</Text>
            <Text style={[styles.item, { color: theme.textMuted }]}>{booking.itemDescription}</Text>
          </View>
          <Badge label={statusLabel(booking)} tone={statusTone(booking)} />
        </View>

        <RoutePill label={routeLabel(booking)} tone="primary" />

        <View style={styles.legs}>
          <View style={styles.leg}>
            <MapPin color={theme.primary} size={15} />
            <Text style={[styles.legText, { color: theme.textSecondary }]}>
              {booking.pickupAddress}, {booking.pickupArea}
            </Text>
          </View>
          <View style={styles.leg}>
            <Navigation color={theme.success} size={15} />
            <Text style={[styles.legText, { color: theme.textSecondary }]}>
              {booking.dropoffAddress}, {booking.dropoffArea}
            </Text>
          </View>
        </View>

        <View style={[styles.carrier, { backgroundColor: theme.surfaceMuted }]}>
          <Truck color={theme.textMuted} size={15} />
          <Text style={[styles.carrierText, { color: theme.textSecondary }]}>
            {/*
              Named, or explicitly not. "Awaiting a driver" is information;
              a blank space is a bug the reader has to interpret.
            */}
            {booking.driver ? `Carried by ${booking.driver}` : 'Awaiting a driver'}
          </Text>
          <Text style={[styles.fee, { color: theme.primary }]}>
            {formatNaira(booking.estimatedFee)}
          </Text>
        </View>
      </Card>

      <SectionLabel>Journey</SectionLabel>
      <Card style={styles.timeline}>
        {BOOKING_STAGES.map((stage, index) => (
          <StageRow
            key={stage}
            stage={stage}
            state={index < current ? 'done' : index === current ? 'current' : 'pending'}
            last={index === BOOKING_STAGES.length - 1}
            at={stageTimestamp(booking, stage)}
          />
        ))}
        {/*
          Only three of the six stages have a recorded time — booking,
          acceptance, and nothing else. Saying so stops the blank right-hand
          column reading as a rendering fault.
        */}
        <Text style={[styles.timelineNote, { color: theme.textMuted }]}>
          Only booking and driver acceptance are timestamped today. The stages in between are set by
          status, not by a recorded event.
        </Text>
      </Card>

      {markers.length > 0 && (
        <>
          <SectionLabel>Route</SectionLabel>
          <View style={styles.mapBlock}>
            <MapView markers={markers} showRoute height={260} />
            <Text style={[styles.mapNote, { color: theme.textMuted }]}>
              Pickup and drop-off as pinned by the sender. This is not the driver&apos;s live
              position — nothing in the app reports that.
            </Text>
          </View>
        </>
      )}

      <SectionLabel>Proof of delivery</SectionLabel>
      <ProofOfDelivery booking={booking} />

      <Button label="Open full parcel details" variant="secondary" onPress={onOpen} />
    </>
  );
}

/**
 * The timestamp for a stage, where one genuinely exists.
 *
 * Returns null everywhere else. The alternative — deriving a plausible time
 * from `createdAt` — would put invented delivery times in front of someone
 * trying to work out when their parcel actually moved.
 */
function stageTimestamp(booking: Booking, stage: BookingStage): string | null {
  if (stage === 'Booked') return booking.createdAt;
  if (stage === 'Assigned') return booking.acceptedAt;
  if (stage === 'Picked Up') return booking.pickedUpAt;
  if (stage === 'Delivered') return booking.deliveredAt;

  /*
   * In Transit and Out for Delivery still have no timestamp of their own.
   *
   * `advance_booking` stamps only the two that matter for a dispute. Adding two
   * more columns is cheap; inventing the times from `createdAt` to fill the gap
   * would not be, which is why these stay null and the row simply shows no time.
   */
  return null;
}

function StageRow({
  stage,
  state,
  last,
  at,
}: {
  stage: BookingStage;
  state: 'done' | 'current' | 'pending';
  last: boolean;
  at: string | null;
}) {
  const theme = useTheme();

  const color =
    state === 'done' ? theme.success : state === 'current' ? theme.primary : theme.textMuted;

  return (
    <View style={styles.stageRow}>
      <View style={styles.rail}>
        {state === 'done' ? (
          <CircleCheck color={color} size={17} />
        ) : state === 'current' ? (
          <CircleDot color={color} size={17} />
        ) : (
          <Circle color={color} size={17} />
        )}
        {!last && <View style={[styles.railLine, { backgroundColor: theme.border }]} />}
      </View>
      <View style={[styles.stageText, last && styles.stageTextLast]}>
        <Text
          style={[
            styles.stageLabel,
            { color: state === 'pending' ? theme.textMuted : theme.text },
            state === 'current' && font(700),
          ]}>
          {stage}
        </Text>
        {!!at && (
          <Text style={[styles.stageWhen, { color: theme.textMuted }]}>
            {new Date(at).toLocaleString()}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * The proof of delivery record, or an honest account of its absence.
 *
 * Three states, and they are genuinely different:
 *
 *   not delivered yet   nothing has happened, so nothing is shown
 *   delivered, evidenced  who took it, when, and the photo
 *   delivered, bare     marked Delivered with no name and no photo
 *
 * The third one is the important one. It happens for every parcel that predates
 * `supabase/migrations/20250101000010_delivery.sql`, and it will keep happening wherever a driver
 * completes a job without signal. Rendering those the same as a fully evidenced
 * delivery would be the exact false reassurance this panel used to warn about.
 */
function ProofOfDelivery({ booking }: { booking: Booking }) {
  const theme = useTheme();
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  const delivered = booking.status === 'Delivered';
  const hasRecord = Boolean(booking.deliveredAt || booking.receivedBy || booking.proofPath);

  /*
   * The bucket is private, so the photo needs a signed URL and the signature
   * expires. Fetched on demand rather than stored on the booking: a URL cached
   * in state outlives its signature and turns into a broken image.
   */
  useEffect(() => {
    let cancelled = false;

    if (!booking.proofPath) {
      setPhotoUrl(null);
      return;
    }

    void signedProofUrl(booking.proofPath).then((url) => {
      if (!cancelled) setPhotoUrl(url);
    });

    return () => {
      cancelled = true;
    };
  }, [booking.proofPath]);

  if (!delivered && !hasRecord) {
    return (
      <Card style={styles.podCard}>
        <View style={styles.podHead}>
          <FileWarning color={theme.textMuted} size={18} />
          <Text style={[styles.podTitle, { color: theme.text }]}>Not delivered yet</Text>
        </View>
        <Text style={[styles.podBody, { color: theme.textSecondary }]}>
          The driver records who received the parcel — and a photo where they can — at the moment of
          handover. Nothing has been captured for this one yet.
        </Text>
      </Card>
    );
  }

  if (!hasRecord) {
    return (
      <Card style={styles.podCard}>
        <View style={styles.podHead}>
          <FileWarning color={theme.warningOnSoft} size={18} />
          <Text style={[styles.podTitle, { color: theme.text }]}>
            Marked delivered, but not evidenced
          </Text>
        </View>
        <Text style={[styles.podBody, { color: theme.textSecondary }]}>
          This parcel is marked Delivered but carries no handover record. Parcels completed before
          proof of delivery was introduced look like this. If it is disputed, there is nothing here
          to settle it.
        </Text>
      </Card>
    );
  }

  return (
    <Card style={styles.podCard}>
      <View style={styles.podHead}>
        <CircleCheck color={theme.success} size={18} />
        <Text style={[styles.podTitle, { color: theme.text }]}>Handover recorded</Text>
      </View>

      <View style={styles.podFacts}>
        {!!booking.receivedBy && <PodFact label="Received by" value={booking.receivedBy} />}
        {!!booking.deliveredAt && (
          <PodFact label="Delivered at" value={new Date(booking.deliveredAt).toLocaleString()} />
        )}
        {!!booking.pickedUpAt && (
          <PodFact label="Collected at" value={new Date(booking.pickedUpAt).toLocaleString()} />
        )}
      </View>

      {!!booking.proofNote && (
        <Text style={[styles.podBody, { color: theme.textSecondary }]}>
          &ldquo;{booking.proofNote}&rdquo;
        </Text>
      )}

      {booking.proofPath ? (
        photoUrl ? (
          <Image
            source={{ uri: photoUrl }}
            style={styles.podPhoto}
            contentFit="cover"
            accessibilityLabel="Photo taken at handover"
          />
        ) : (
          <Text style={[styles.podHint, { color: theme.textMuted }]}>Loading the photo…</Text>
        )
      ) : (
        <Text style={[styles.podHint, { color: theme.textMuted }]}>
          No photo was captured at handover — the name above is the whole record.
        </Text>
      )}
    </Card>
  );
}

function PodFact({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.podFact}>
      <Text style={[styles.podFactLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.podFactValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

function NotFound({ id, signedIn }: { id: string; signedIn: boolean }) {
  const theme = useTheme();
  const router = useRouter();

  return (
    <Card style={styles.notFound}>
      <EmptyState
        icon={(color, size) => <PackageSearch color={color} size={size} />}
        title={`Nothing found for ${id}`}
        message={
          signedIn
            ? 'No parcel with that tracking ID is on your account. Check the ID on your booking confirmation — and note that you can only track parcels you sent or are carrying.'
            : 'Sign in to track a parcel. Tracking is tied to your account: a tracking ID is short enough to guess, so a public lookup would expose a recipient’s name, phone number and address to anyone.'
        }
      />
      {!signedIn && (
        <Button label="Sign in" onPress={() => router.push('/sign-in?next=/tracking' as '/')} />
      )}
      <Text style={[styles.notFoundNote, { color: theme.textMuted }]}>
        Are you the recipient rather than the sender? There is no way to track a delivery without an
        account yet — ask whoever sent it, and see Support if you need help.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
    marginBottom: Spacing.four,
  },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three - 2,
    height: 46,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    ...Typography.body,
    ...font(600),
    letterSpacing: 0.5,
    /*
     * No outline on web: the wrapper carries the border, and the browser's
     * default ring sits inside it at the wrong radius.
     *
     * `outlineWidth: 0` rather than `outlineStyle: 'none'` — RN types the
     * latter as solid/dotted/dashed only, so 'none' fails to compile. Same
     * fix as `field.tsx` and `password-field.tsx`.
     */
    outlineWidth: 0,
  },
  recentCard: {
    gap: 0,
    marginBottom: Spacing.three,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three - 2,
  },
  recentText: {
    flex: 1,
    gap: Spacing.half,
  },
  recentId: {
    ...Typography.meta,
    ...font(700),
    letterSpacing: 0.4,
  },
  recentItem: {
    ...Typography.caption,
  },
  summary: {
    gap: Spacing.two + 2,
    marginBottom: Spacing.three,
  },
  summaryHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  summaryHeadText: {
    flex: 1,
    gap: Spacing.half,
  },
  trackingId: {
    ...Typography.sectionTitle,
    letterSpacing: 0.5,
  },
  item: {
    ...Typography.meta,
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
    ...Typography.caption,
    flex: 1,
    lineHeight: 19,
  },
  carrier: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.two + 2,
    borderRadius: Radius.md,
  },
  carrierText: {
    ...Typography.caption,
    ...font(600),
    flex: 1,
  },
  fee: {
    ...Typography.meta,
    ...font(700),
  },
  timeline: {
    gap: 0,
    marginBottom: Spacing.three,
  },
  stageRow: {
    flexDirection: 'row',
    gap: Spacing.two + 2,
  },
  rail: {
    alignItems: 'center',
    width: 18,
  },
  railLine: {
    width: 2,
    flex: 1,
    marginVertical: 2,
    borderRadius: 1,
  },
  stageText: {
    flex: 1,
    gap: Spacing.half,
    paddingBottom: Spacing.three,
  },
  stageTextLast: {
    paddingBottom: 0,
  },
  stageLabel: {
    ...Typography.meta,
    ...font(600),
  },
  stageWhen: {
    ...Typography.caption,
  },
  timelineNote: {
    ...Typography.caption,
    lineHeight: 18,
    paddingTop: Spacing.three,
  },
  mapBlock: {
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  mapNote: {
    ...Typography.caption,
    lineHeight: 18,
  },
  podCard: {
    gap: Spacing.two + 2,
    marginBottom: Spacing.four,
  },
  podHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  podTitle: {
    ...Typography.meta,
    ...font(700),
    flex: 1,
  },
  podBody: {
    ...Typography.caption,
    lineHeight: 19,
  },
  podFacts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  podFact: {
    flexGrow: 1,
    flexBasis: 150,
    gap: Spacing.half,
  },
  podFactLabel: {
    ...Typography.caption,
  },
  podFactValue: {
    ...Typography.meta,
    ...font(600),
  },
  /**
   * 4:3, which is what a phone camera gives at the default aspect. Letting the
   * image set its own height makes the card jump as the signed URL resolves.
   */
  podPhoto: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: Radius.md,
    backgroundColor: '#E2E8F0',
  },
  podHint: {
    ...Typography.caption,
    lineHeight: 18,
  },
  notFound: {
    gap: Spacing.three,
  },
  notFoundNote: {
    ...Typography.caption,
    lineHeight: 18,
  },
});
