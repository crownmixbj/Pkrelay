import { usePathname, useRouter } from 'expo-router';
import { Clock, MapPin, Package, Truck } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { showDialog } from '@/components/ui/dialog';
import { showToast } from '@/components/ui/toast';
import { Elevation, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useExperience } from '@/hooks/use-experience';
import { useLiveRefresh } from '@/hooks/use-live-refresh';
import { useTheme } from '@/hooks/use-theme';
import { formatNaira } from '@/store/bookings';
import { OFFER_COOLDOWN_MINUTES, offerIsUrgent, secondsLeft } from '@/store/dispatch';
import {
  answerLiveOffer,
  refreshLiveOffers,
  resetLiveOffers,
  useLiveOffers,
  type LiveOffer,
} from '@/store/live-offers';
import { useSession } from '@/store/session';

/**
 * A trip offer, on whatever screen the driver happens to be.
 *
 * ⚠ Mounted once at the root, beside the toast and dialog hosts.
 *
 *   An offer is held five minutes within a city and ten between them. It used
 *   to appear only on Assigned Trip, so a driver checking their wallet or
 *   reading the FAQs watched it expire without knowing it existed. This pops
 *   up over every tab, and Assigned Trip still lists it underneath.
 *
 * ⚠ Live, not only polled. A Realtime subscription on the driver's own
 *   `dispatch_offers` rows (needs `20250101000077_dispatch_live.sql`) brings it
 *   up within a second; a 15-second poll covers a dropped socket and expiry.
 *
 * "Decide later" hides the pop-up for that one offer only. It is still on
 * Assigned Trip with its countdown, and the next offer pops up as normal.
 */
export function OfferPopup() {
  const { user, isAuthenticated, isApprovedDriver } = useSession();
  const experience = useExperience();
  const userId = user?.id ?? null;

  /*
   * Approved drivers only, and never in the sender phone app — a driver who has
   * switched to Sender is booking a parcel, not waiting for one.
   */
  const enabled =
    isAuthenticated && isApprovedDriver && !!userId && !!experience && experience !== 'sender';

  // A different account on this phone starts with a clean slate.
  useEffect(() => {
    resetLiveOffers();
  }, [userId]);

  useEffect(() => {
    if (enabled) void refreshLiveOffers();
  }, [enabled]);

  useLiveRefresh(refreshLiveOffers, {
    channel: `driver-offers:${userId ?? 'none'}`,
    tables: ['dispatch_offers'],
    filter: userId ? `driver_id=eq.${userId}` : undefined,
    intervalMs: 15_000,
    enabled,
  });

  const offers = useLiveOffers();
  const [later, setLater] = useState<Set<string>>(() => new Set());

  const current = useMemo(
    () => (enabled ? offers.find((offer) => !later.has(offer.id)) ?? null : null),
    [enabled, offers, later],
  );
  const waiting = useMemo(
    () => offers.filter((offer) => !later.has(offer.id)).length,
    [offers, later],
  );

  // A buzz when a new offer appears — the pop-up alone is silent.
  const lastBuzzed = useRef<string | null>(null);
  useEffect(() => {
    if (!current || current.id === lastBuzzed.current) return;
    lastBuzzed.current = current.id;
    if (Platform.OS !== 'web') Vibration.vibrate(400);
  }, [current]);

  if (!current) return null;

  return (
    <OfferModal
      key={current.id}
      offer={current}
      waiting={waiting}
      onLater={() => setLater((prev) => new Set(prev).add(current.id))}
    />
  );
}

function OfferModal({
  offer,
  waiting,
  onLater,
}: {
  offer: LiveOffer;
  waiting: number;
  onLater: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const left = secondsLeft(offer, now);
  const urgent = offerIsUrgent(offer, now);
  const parcel = offer.parcel;

  const answer = async (accept: boolean) => {
    setBusy(true);
    const outcome = await answerLiveOffer(offer.id, accept);
    setBusy(false);

    if (outcome.status === 'accepted') {
      showToast('Trip accepted', { message: 'It is now your assigned trip.' });
      if (pathname !== '/driver') router.navigate('/driver');
      return;
    }
    if (outcome.status === 'declined') {
      showToast('Trip declined', {
        message: 'It has been passed to another driver.',
        tone: 'info',
      });
      return;
    }
    showDialog(
      accept ? 'Could not accept that trip' : 'Could not decline that trip',
      outcome.message ?? 'It expired or went to another driver.',
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onLater}>
      <View style={styles.backdrop}>
        <View
          accessibilityViewIsModal
          style={[
            styles.card,
            { backgroundColor: theme.surface, borderColor: theme.primary, shadowColor: theme.shadow },
            Elevation.raised,
          ]}>
          <View style={styles.head}>
            <View style={[styles.icon, { backgroundColor: theme.primarySoft }]}>
              <Truck color={theme.primaryOnSoft} size={20} />
            </View>
            <View style={styles.headText}>
              <Text style={[styles.title, { color: theme.text }]}>New trip offered to you</Text>
              {waiting > 1 && (
                <Text style={[styles.meta, { color: theme.textMuted }]}>
                  {waiting - 1} more waiting after this one
                </Text>
              )}
            </View>
            <Badge
              label={left > 0 ? `${Math.ceil(left / 60)} min left` : 'Expiring'}
              tone={urgent ? 'warning' : 'primary'}
            />
          </View>

          {parcel ? (
            <View style={[styles.parcel, { backgroundColor: theme.surfaceMuted }]}>
              <Row icon={<MapPin color={theme.textMuted} size={15} />}>
                <Text style={[styles.route, { color: theme.text }]}>
                  {parcel.originCity} → {parcel.destinationCity}
                </Text>
              </Row>
              <Row icon={<Package color={theme.textMuted} size={15} />}>
                <Text style={[styles.meta, { color: theme.textSecondary }]}>
                  #{parcel.trackingId} · {parcel.weight} kg · Fare {formatNaira(parcel.fare)}
                </Text>
              </Row>
            </View>
          ) : (
            <Text style={[styles.meta, { color: theme.textSecondary }]}>
              A parcel matched to one of your journeys.
            </Text>
          )}

          <Row icon={<Clock color={urgent ? theme.warningOnSoft : theme.textMuted} size={14} />}>
            <Text
              style={[
                styles.countdown,
                { color: urgent ? theme.warningOnSoft : theme.textMuted },
              ]}>
              {left > 0
                ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} to answer`
                : 'This offer has expired'}
            </Text>
          </Row>

          <Text style={[styles.body, { color: theme.textSecondary }]}>
            Accept and it becomes your assigned trip. Decline and it goes to another driver, and
            will not be offered to you again for at least {OFFER_COOLDOWN_MINUTES} minutes.
          </Text>

          <View style={styles.actions}>
            <Button
              label={busy ? 'Saving…' : 'Accept'}
              size="md"
              disabled={busy || left === 0}
              onPress={() => void answer(true)}
              style={styles.half}
            />
            <Button
              label="Decline"
              variant="secondary"
              size="md"
              disabled={busy}
              onPress={() => void answer(false)}
              style={styles.half}
            />
          </View>

          <Pressable
            onPress={onLater}
            disabled={busy}
            accessibilityRole="button"
            hitSlop={8}
            style={({ pressed }) => [styles.later, pressed && { opacity: 0.6 }]}>
            <Text style={[styles.laterText, { color: theme.primary }]}>
              Decide later — it stays on Assigned Trip
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      {icon}
      <View style={styles.rowText}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.three,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  card: {
    width: '100%',
    maxWidth: 440,
    gap: Spacing.two + 2,
    padding: Spacing.three + 2,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two + 2 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1, gap: 2 },
  title: { ...Typography.sectionTitle },
  parcel: { gap: Spacing.one + 2, padding: Spacing.two + 2, borderRadius: Radius.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  rowText: { flex: 1 },
  route: { ...Typography.meta, ...font(700) },
  meta: { ...Typography.caption },
  countdown: { ...Typography.caption, ...font(600) },
  body: { ...Typography.caption, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.one },
  half: { flex: 1 },
  later: { alignSelf: 'center', paddingVertical: Spacing.one },
  laterText: { ...Typography.caption, ...font(700) },
});
