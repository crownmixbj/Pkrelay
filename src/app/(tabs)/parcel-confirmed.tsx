import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Banknote,
  Bell,
  Check,
  CircleCheckBig,
  Clock,
  Copy,
  Image as ImageIcon,
  MapPin,
  Navigation,
  PackageOpen,
  PackagePlus,
  PackageSearch,
  Radar,
  StickyNote,
  UserRound,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { Footer } from '@/components/Footer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, screenPadding, SectionLabel } from '@/components/ui/screen';
import {
  FontSize,
  MaxContentWidth,
  PageCanvas,
  Radius,
  Spacing,
  Typography,
  font,
} from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  BOOKING_STAGES,
  estimateFee,
  formatNaira,
  handoverFeeLabel,
  dropoffSummaryLine,
  pickupSummaryLine,
  pickupWindow,
  routeLabel,
  stageIndex,
  useBookings,
  type Booking,
} from '@/store/bookings';

/**
 * Confirmation for a posted parcel.
 *
 * Reads the booking back out of the store by tracking ID rather than taking it
 * through navigation params: params survive a reload but a serialised booking
 * object wouldn't, and this way the screen always shows current state — if a
 * driver accepts while the sender is still looking at it, the status is right.
 */
export default function ParcelConfirmedScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { getBooking } = useBookings();
  const { trackingId } = useLocalSearchParams<{ trackingId: string }>();
  const [copied, setCopied] = useState(false);

  const booking = trackingId ? getBooking(trackingId) : undefined;
  // Four stage labels need roughly 150px each before they start truncating.
  const wideTracker = width >= 720;

  const fee = useMemo(
    () =>
      booking
        ? estimateFee({
            deliveryType: booking.deliveryType,
            weight: booking.weight,
            declaredValue: booking.declaredValue,
            pickupMode: booking.pickupMode,
            dropoffMode: booking.dropoffMode,
          })
        : null,
    [booking],
  );

  // A stale or hand-typed tracking ID shouldn't render a blank success screen.
  if (!booking || !fee) {
    return (
      <ScrollView contentContainerStyle={[screenPadding, styles.canvas]}>
        <View style={styles.content}>
          <Card style={styles.emptyCard}>
            <EmptyState
              icon={(color, size) => <PackageSearch color={color} size={size} />}
              title="Parcel not found"
              message="We couldn't find a parcel with that tracking number. It may have been posted on another device."
            />
            <Button label="Post a Parcel" size="md" onPress={() => router.replace('/book')} />
          </Card>
        </View>
        <Footer />
      </ScrollView>
    );
  }

  const copyTracking = async () => {
    // No clipboard dependency in this project, so share the number instead —
    // on web that still lands in the OS share sheet or a copy dialog.
    try {
      await Share.share({
        message: `Track my Package Relay parcel: #${booking.trackingId}`,
      });
      setCopied(true);
    } catch {
      // Sharing being dismissed isn't an error worth interrupting anyone for.
    }
  };

  return (
    <ScrollView contentContainerStyle={[screenPadding, styles.canvas]}>
      <View style={styles.content}>
        {/* ---------- Success header ---------- */}
        <View style={styles.hero}>
          <View style={[styles.heroIcon, { backgroundColor: theme.successSoft }]}>
            <CircleCheckBig color={theme.success} size={34} />
          </View>

          <Text style={[styles.heroTitle, { color: theme.text }]}>Parcel posted successfully</Text>
          <Text style={[styles.heroBody, { color: theme.textSecondary }]}>
            Your parcel is live on the jobs feed. Drivers travelling {routeLabel(booking)} can
            accept it now.
          </Text>

          {/* The one thing worth writing down, so it gets its own affordance. */}
          <View style={[styles.trackingPill, { backgroundColor: theme.primarySoft }]}>
            <Text style={[styles.trackingLabel, { color: theme.primaryOnSoft }]}>Tracking</Text>
            <Text
              style={[styles.trackingValue, { color: theme.primaryOnSoft }]}
              accessibilityLabel={`Tracking number ${booking.trackingId.split('').join(' ')}`}>
              #{booking.trackingId}
            </Text>
            <Pressable
              onPress={copyTracking}
              accessibilityRole="button"
              accessibilityLabel="Share tracking number"
              hitSlop={8}
              style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}>
              {copied ? (
                <Check color={theme.success} size={15} />
              ) : (
                <Copy color={theme.primaryOnSoft} size={15} />
              )}
            </Pressable>
          </View>
        </View>

        {/* ---------- Journey tracker ---------- */}
        <Card style={styles.card}>
          <SectionLabel>Journey</SectionLabel>
          <StageTracker booking={booking} wide={wideTracker} />
        </Card>

        {/* ---------- What happens next ---------- */}
        <View
          style={[
            styles.callout,
            { backgroundColor: theme.primarySoft, borderLeftColor: theme.primaryOnSoft },
          ]}>
          <Clock color={theme.primaryOnSoft} size={18} />
          <View style={styles.calloutText}>
            <Text style={[styles.calloutTitle, { color: theme.primaryOnSoft }]}>
              {pickupWindow(booking)}
            </Text>
            <Text style={[styles.calloutBody, { color: theme.primaryOnSoft }]}>
              A driver already covering this route claims the job from the open feed. You&apos;ll be
              notified the moment someone accepts, and their name will appear on your tracking card.
            </Text>
          </View>
        </View>

        {/* ---------- Order summary ---------- */}
        <Card style={styles.card}>
          <View style={styles.summaryHeader}>
            <SectionLabel>Order summary</SectionLabel>
            <Badge
              label={booking.deliveryType === 'local' ? 'Local' : 'Inter-State'}
              tone={booking.deliveryType === 'local' ? 'success' : 'primary'}
            />
          </View>

          {/*
            Same rows, same order and same wording as the Delivery summary on
            the booking form — a sender should recognise this as the thing they
            just confirmed, not a differently-phrased restatement of it.
          */}
          <SummaryRow
            icon={<PackageOpen color={theme.textMuted} size={15} />}
            label="Item"
            value={
              `${booking.itemDescription} · ${booking.category} · ${booking.weight} kg` +
              (booking.fragile ? ' · Fragile' : '')
            }
          />
          <SummaryRow
            icon={<Banknote color={theme.textMuted} size={15} />}
            label="Declared"
            value={
              booking.declaredValue > 0
                ? `${formatNaira(booking.declaredValue)} — insured`
                : 'Not declared — travels uninsured'
            }
          />
          <SummaryRow
            icon={<ImageIcon color={theme.textMuted} size={15} />}
            label="Photo"
            value={booking.itemPhotoUri ? 'Attached' : 'Not attached'}
          />
          <SummaryRow
            icon={<MapPin color={theme.textMuted} size={15} />}
            label="Pickup"
            value={pickupSummaryLine({
              mode: booking.pickupMode,
              address: booking.pickupAddress,
              // A hub pickup stores the hub name and street in `pickupAddress`,
              // so repeating the area would read "…, Ikeja, Ikeja, Lagos".
              area: booking.pickupMode === 'hub' ? '' : booking.pickupArea,
              city: booking.originCity,
            })}
          />
          {!!booking.pickupContactName && (
            <SummaryRow
              icon={<UserRound color={theme.textMuted} size={15} />}
              label={booking.pickupMode === 'hub' ? 'Dropping off' : 'Contact'}
              value={`${booking.pickupContactName} · ${booking.senderPhone}`}
            />
          )}
          <SummaryRow
            icon={<Navigation color={theme.textMuted} size={15} />}
            label="Dropoff"
            value={dropoffSummaryLine({
              mode: booking.dropoffMode,
              address: booking.dropoffAddress,
              area: booking.dropoffArea,
              city: booking.destinationCity,
            })}
          />
          <SummaryRow
            icon={<UserRound color={theme.textMuted} size={15} />}
            label="Recipient"
            value={`${booking.recipientName} · ${booking.recipientPhone}`}
          />
          {!!booking.notes && (
            <SummaryRow
              icon={<StickyNote color={theme.textMuted} size={15} />}
              label="Notes"
              value={booking.notes}
            />
          )}

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* Recomputed from the stored booking, so it can't disagree with the quote. */}
          <CostRow
            label={`Base fare · ${booking.deliveryType === 'local' ? 'Local' : 'Inter-State'}`}
            value={fee.base}
          />
          <CostRow label={`Weight · ${booking.weight} kg`} value={fee.weight} />
          {fee.insurance > 0 && (
            <CostRow label="Insurance · 1% of declared value" value={fee.insurance} />
          )}
          {fee.handover > 0 && (
            <CostRow
              label={handoverFeeLabel(booking.pickupMode, booking.dropoffMode)}
              value={fee.handover}
            />
          )}

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.totalRow}>
            <View style={styles.totalLabelRow}>
              <Banknote color={theme.primary} size={16} />
              <Text style={[styles.totalLabel, { color: theme.text }]}>Total</Text>
            </View>
            <Text style={[styles.totalValue, { color: theme.primary }]}>
              {formatNaira(booking.estimatedFee)}
            </Text>
          </View>
          <Text style={[styles.disclaimer, { color: theme.textMuted }]}>
            Payable on handover. The fare is fixed at the amount quoted above.
          </Text>
        </Card>

        {/* ---------- Actions ---------- */}
        <View style={[styles.actions, wideTracker && styles.actionsWide]}>
          <Button
            label="Track this parcel"
            style={styles.action}
            icon={(color, size) => <Radar color={color} size={size} />}
            onPress={() => router.navigate(`/parcel/${booking.id}`)}
          />
          <Button
            label="Post another parcel"
            variant="secondary"
            style={styles.action}
            icon={(color, size) => <PackagePlus color={color} size={size} />}
            onPress={() => router.replace('/book')}
          />
        </View>

        <Pressable
          onPress={() => router.navigate('/')}
          accessibilityRole="link"
          style={({ pressed }) => [styles.homeLink, pressed && styles.pressed]}>
          <Text style={[styles.homeLinkText, { color: theme.textSecondary }]}>Back to home</Text>
        </Pressable>

        <View style={styles.notice}>
          <Bell color={theme.textMuted} size={13} />
          <Text style={[styles.noticeText, { color: theme.textMuted }]}>
            Keep your tracking number. You&apos;ll need it to follow the parcel or raise a claim.
          </Text>
        </View>
      </View>
      <Footer />
    </ScrollView>
  );
}

/**
 * The six delivery stages, with the current one marked. Horizontal when there's
 * room, vertical on a phone — six labels never fit across a narrow screen.
 */
function StageTracker({ booking, wide }: { booking: Booking; wide: boolean }) {
  const theme = useTheme();
  const current = stageIndex(booking.status);

  return (
    <View style={[styles.tracker, wide && styles.trackerRow]}>
      {BOOKING_STAGES.map((stage, index) => {
        const done = index < current;
        const active = index === current;
        const tone = done ? theme.success : active ? theme.primary : theme.textMuted;
        const isLast = index === BOOKING_STAGES.length - 1;

        return (
          <View
            key={stage}
            style={[styles.trackerStep, wide && styles.trackerStepRow]}
            accessibilityLabel={`Stage ${index + 1} of ${BOOKING_STAGES.length}. ${stage}. ${
              done ? 'Done' : active ? 'Current' : 'Pending'
            }`}>
            <View style={[styles.markRow, wide && styles.markRowWide]}>
              {/* A glyph per state — colour alone can't distinguish them. */}
              <View
                style={[
                  styles.dot,
                  { borderColor: tone, backgroundColor: done || active ? tone : theme.surface },
                ]}>
                {done ? (
                  <Check color={theme.surface} size={12} />
                ) : active ? (
                  <View style={[styles.dotActive, { backgroundColor: theme.surface }]} />
                ) : null}
              </View>

              {!isLast && (
                <View
                  style={[
                    wide ? styles.barWide : styles.bar,
                    { backgroundColor: done ? theme.success : theme.border },
                  ]}
                />
              )}
            </View>

            <Text
              style={[
                styles.stageLabel,
                wide && styles.stageLabelWide,
                { color: active ? theme.text : theme.textSecondary },
                active && font(700),
              ]}
              numberOfLines={2}>
              {stage}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  const theme = useTheme();

  return (
    <View style={styles.summaryRow}>
      <View style={styles.summaryIcon}>{icon}</View>
      <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.summaryValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

function CostRow({ label, value }: { label: string; value: number }) {
  const theme = useTheme();

  return (
    <View style={styles.costRow}>
      <Text style={[styles.costLabel, { color: theme.textSecondary }]} numberOfLines={2}>
        {label}
      </Text>
      <Text style={[styles.costValue, { color: theme.text }]}>{formatNaira(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    backgroundColor: PageCanvas,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  hero: {
    alignItems: 'center',
    gap: Spacing.three - 4,
    paddingVertical: Spacing.five,
  },
  heroIcon: {
    width: 68,
    height: 68,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitle: {
    ...Typography.screenTitle,
    textAlign: 'center',
  },
  heroBody: {
    ...Typography.body,
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: 480,
  },
  trackingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.pill,
    marginTop: Spacing.two,
  },
  trackingLabel: {
    ...Typography.caption,
    ...font(600),
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    opacity: 0.8,
  },
  trackingValue: {
    fontSize: FontSize.body,
    ...font(800),
    letterSpacing: 0.4,
  },
  copyButton: {
    padding: Spacing.one,
  },
  card: {
    gap: Spacing.three - 4,
    marginBottom: Spacing.three,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  /** Vertical by default; `trackerRow` turns it horizontal when there's room. */
  tracker: {
    gap: Spacing.three - 6,
  },
  trackerRow: {
    flexDirection: 'row',
    gap: 0,
  },
  trackerStep: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
  },
  trackerStepRow: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  markRow: {
    alignItems: 'center',
  },
  markRowWide: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  dot: {
    width: 22,
    height: 22,
    borderRadius: Radius.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotActive: {
    width: 7,
    height: 7,
    borderRadius: Radius.pill,
  },
  bar: {
    width: 2,
    height: 14,
    marginTop: 2,
  },
  barWide: {
    flex: 1,
    height: 2,
    marginHorizontal: Spacing.one,
  },
  stageLabel: {
    flex: 1,
    ...Typography.caption,
  },
  stageLabelWide: {
    flex: 0,
    paddingRight: Spacing.two,
  },

  callout: {
    flexDirection: 'row',
    gap: Spacing.three - 4,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderLeftWidth: 3,
    marginBottom: Spacing.three,
  },
  calloutText: {
    flex: 1,
    gap: Spacing.one,
  },
  calloutTitle: {
    ...Typography.body,
    ...font(700),
  },
  calloutBody: {
    ...Typography.caption,
    lineHeight: 20,
  },

  summaryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two + 2,
  },
  summaryIcon: {
    width: 18,
    alignItems: 'center',
    paddingTop: 2,
  },
  summaryLabel: {
    ...Typography.caption,
    width: 84,
  },
  summaryValue: {
    flex: 1,
    ...Typography.caption,
    ...font(600),
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Spacing.one,
  },
  costRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  costLabel: {
    flex: 1,
    ...Typography.caption,
  },
  costValue: {
    ...Typography.caption,
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
    gap: Spacing.two,
  },
  totalLabel: {
    ...Typography.body,
    ...font(700),
  },
  totalValue: {
    fontSize: FontSize.subhead,
    ...font(800),
  },
  disclaimer: {
    ...Typography.meta,
  },

  actions: {
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  actionsWide: {
    flexDirection: 'row',
  },
  action: {
    flexGrow: 1,
    flexBasis: 200,
  },
  homeLink: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  homeLinkText: {
    ...Typography.body,
    ...font(600),
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  noticeText: {
    ...Typography.meta,
    flexShrink: 1,
  },
  emptyCard: {
    gap: Spacing.three,
    marginTop: Spacing.five,
  },
  pressed: {
    opacity: 0.7,
  },
});
