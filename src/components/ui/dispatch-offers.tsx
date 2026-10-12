import { Clock } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ParcelPhoto } from '@/components/ui/parcel-photo';
import { SectionLabel } from '@/components/ui/screen';
import { Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  OFFER_COOLDOWN_MINUTES,
  offerIsUrgent,
  secondsLeft,
  type DispatchOffer,
} from '@/store/dispatch';

/**
 * The trips waiting on an answer.
 *
 * This lives on the Assigned Trip screen — the driver's home — rather than on
 * the scheduling tab where it started. Scheduling is something a driver does
 * once and leaves; an offer is held five minutes within a city and ten between
 * them, so a card that only appears on a screen nobody has open is a countdown
 * running in an empty room.
 *
 * Presentational on purpose. It owns the clock, because the clock is part of
 * showing a countdown, but it does not fetch and it does not answer — both
 * belong to the screen, which knows what else has to be reloaded once an offer
 * is accepted.
 */
export function DispatchOffers({
  offers,
  busy,
  onAnswer,
}: {
  /*
   * `parcel` is optional so a plain DispatchOffer still renders; the shared
   * store (`@/store/live-offers`) supplies it with the route and photo.
   */
  offers: (DispatchOffer & {
    parcel?: {
      originCity: string;
      destinationCity: string;
      weight: number;
      photoPath: string | null;
    } | null;
  })[];
  busy: boolean;
  onAnswer: (offer: DispatchOffer, accept: boolean) => void;
}) {
  const theme = useTheme();

  /*
   * One interval for the whole list.
   *
   * A driver with three offers should not be running three timers, and the
   * countdown only has to be right to the second.
   */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (offers.length === 0) return;

    /*
     * Set once immediately, then tick.
     *
     * Without this first line a card mounted from a fresh fetch would show a
     * time computed when the screen mounted, which on a screen left open is
     * minutes stale — the driver would see "5 min left" on an offer that has
     * two, and lose it while trusting the number.
     */
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [offers.length]);

  if (offers.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <SectionLabel>
        {offers.length === 1 ? 'Offered to you' : `Offered to you (${offers.length})`}
      </SectionLabel>

      <View style={styles.list}>
        {offers.map((offer) => {
          const left = secondsLeft(offer, now);
          const urgent = offerIsUrgent(offer, now);

          return (
            <Card key={offer.id} style={[styles.offer, { borderColor: theme.primary }]}>
              <View style={styles.head}>
                <Text style={[styles.title, { color: theme.text }]}>A trip for you</Text>
                <Badge
                  label={left > 0 ? `${Math.ceil(left / 60)} min left` : 'Expiring'}
                  // Proportional to the window, not a flat minute — see
                  // `offerIsUrgent`. A ten-minute offer should not sit amber
                  // for its last tenth only.
                  tone={urgent ? 'warning' : 'primary'}
                />
              </View>

              {/*
                The seconds are spelled out under the badge rather than only
                rounded up in it. "1 min left" reads the same at 119 seconds and
                at 61, and the difference is whether the driver has time to
                think.
              */}
              <View style={styles.countdown}>
                <Clock color={urgent ? theme.warningOnSoft : theme.textMuted} size={14} />
                <Text
                  style={[
                    styles.countdownText,
                    { color: urgent ? theme.warningOnSoft : theme.textMuted },
                  ]}>
                  {left > 0
                    ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} to answer`
                    : 'This offer has expired'}
                </Text>
              </View>

              {!!offer.parcel && (
                <>
                  <Text style={[styles.route, { color: theme.text }]}>
                    {offer.parcel.originCity} → {offer.parcel.destinationCity} ·{' '}
                    {offer.parcel.weight} kg
                  </Text>
                  {/* The sender's photo, so the driver can judge the fit before accepting. */}
                  <ParcelPhoto path={offer.parcel.photoPath} height={140} />
                </>
              )}

              <Text style={[styles.body, { color: theme.textSecondary }]}>
                Matched to one of your journeys. Accept and it becomes your assigned trip. Decline
                and it goes straight to another driver — and it will not come back to you for at
                least {OFFER_COOLDOWN_MINUTES} minutes.
              </Text>

              <View style={styles.actions}>
                <Button
                  label="Accept"
                  size="md"
                  onPress={() => onAnswer(offer, true)}
                  /*
                   * An expired offer cannot be accepted, and the button says so
                   * rather than failing on the server. Decline stays live: the
                   * driver can clear a lapsed card off their screen.
                   */
                  disabled={busy || left === 0}
                  style={styles.half}
                />
                <Button
                  label="Decline"
                  variant="secondary"
                  size="md"
                  onPress={() => onAnswer(offer, false)}
                  disabled={busy}
                  style={styles.half}
                />
              </View>
            </Card>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.two },
  list: { gap: Spacing.two },
  // A live offer outranks everything else on the screen, so it carries a border
  // the other cards do not.
  offer: { gap: Spacing.two, borderWidth: 1.5 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  title: { ...Typography.cardTitle, flex: 1 },
  countdown: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  countdownText: { ...Typography.caption, ...font(600) },
  body: { ...Typography.caption, lineHeight: 18 },
  route: { ...Typography.meta, ...font(700) },
  actions: { flexDirection: 'row', gap: Spacing.two },
  half: { flex: 1 },
});
