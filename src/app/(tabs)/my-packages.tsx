import { useLocalSearchParams, useRouter } from 'expo-router';
import { CircleCheck, CreditCard, PackageSearch } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { RoutePill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipGroup } from '@/components/ui/chip';
import { ProgressBar } from '@/components/ui/progress-bar';
import { EmptyState, screenPadding, ScreenHeader } from '@/components/ui/screen';
import { MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  formatNaira,
  isAwaitingPayment,
  isCarrier,
  parcelsForUser,
  sortByPickupUrgency,
  routeLabel,
  stageProgress,
  statusLabel,
  statusTone,
  useBookings,
  type Booking,
} from '@/store/bookings';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { useSession } from '@/store/session';
import { showDialog } from '@/components/ui/dialog';
import { PaymentSheet, type CheckoutOutcome } from '@/components/ui/payment-sheet';
import {
  initializeParcelPayment,
  verifyParcelPayment,
  type CheckoutSession,
} from '@/store/payments';

/**
 * Two of the four Shipments views: Active / In-Transit, and History / Archives.
 *
 * One screen rather than two routes — they are the same list under one
 * ownership rule (parcels you posted, plus ones you are driving) split by a
 * single predicate. Two screens would mean two copies of that rule, and an
 * ownership rule that exists twice is one that will eventually disagree with
 * itself about who may see a recipient's phone number.
 *
 * `?section=` chooses which, so the nav can open either directly.
 */
type Section = 'active' | 'history';

const SECTIONS: readonly Section[] = ['active', 'history'] as const;

const SECTION_LABELS: Record<Section, string> = {
  active: 'Active / In-Transit',
  history: 'History / Archives',
};

/** Anything unrecognised falls back to what is still moving. */
function parseSection(value: unknown): Section {
  return SECTIONS.includes(value as Section) ? (value as Section) : 'active';
}

export default function MyPackagesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ section?: string; posted?: string }>();
  const { bookings, refresh } = useBookings();
  const { viewerId } = useSession();
  const theme = useTheme();

  const [section, setSection] = useState<Section>(() => parseSection(params.section));

  /*
    An unpaid parcel needs a way back to its checkout, and this is it.

    ⚠ The same sheet the booking form uses, not a second implementation.

      A sender who abandons a checkout has a real parcel sitting in this list
      with everything they typed on it. Without a button here, the only way to
      pay for it would be to fill the whole form in again — and they would,
      producing a duplicate parcel and eventually a duplicate charge.
  */
  const [checkout, setCheckout] = useState<CheckoutSession | null>(null);
  const [payingFor, setPayingFor] = useState<string | null>(null);

  // The URL leads: picking a section from the nav while already on this screen
  // changes the query string without remounting.
  useEffect(() => setSection(parseSection(params.section)), [params.section]);

  const choose = (next: Section) => {
    setSection(next);
    router.setParams({ section: next });
  };

  /*
    The tracking id of a parcel posted a moment ago, from the booking form.

    Read once into state rather than off the params on every render, because the
    banner is dismissed by clearing it — and a value still in the URL would put
    it straight back on the next render.
  */
  const [justPosted, setJustPosted] = useState<string | null>(
    typeof params.posted === 'string' && params.posted ? params.posted : null,
  );

  const startPayment = async (bookingId: string) => {
    setPayingFor(bookingId);
    const opened = await initializeParcelPayment(bookingId);
    setPayingFor(null);

    if (opened.ok) {
      setCheckout(opened.session);
      return;
    }

    if (opened.alreadyPaid) {
      /* Settled by a webhook while this list was stale. Catch the list up. */
      await refresh();
      return;
    }

    showDialog('Could not open the checkout', opened.error);
  };

  const finishPayment = async (outcome: CheckoutOutcome, session: CheckoutSession) => {
    setCheckout(null);

    if (outcome === 'failed') {
      showDialog('The checkout would not load', 'Nothing has been charged. Try again in a moment.');
      return;
    }

    const verdict = await verifyParcelPayment(session.reference);

    /*
      Refreshed on every outcome, not only on success.

      A failed attempt changes the payment row and nothing else, but a verdict
      of 'unknown' very often means the webhook settled it a second ago — and
      the only way this screen finds that out is by asking the server again.
    */
    await refresh();

    if (verdict.status === 'failed') {
      showDialog(
        'That payment did not go through',
        verdict.error ?? 'The bank declined it. You can try again.',
      );
    }
  };

  // Null viewer = signed out. `parcelsForUser` would match nothing anyway, but
  // an empty list reads as "you have no parcels" rather than "sign in first".
  const mine = useMemo(
    () => (viewerId ? parcelsForUser(bookings, viewerId) : []),
    [bookings, viewerId],
  );

  const active = useMemo(
    () => sortByPickupUrgency(mine.filter((b) => b.status !== 'Delivered')),
    [mine],
  );

  /*
    Counted separately, because "3 parcels still on the move" is a false
    sentence when one of the three has not been paid for and no driver can see
    it. The subtitle says both numbers or neither.
  */
  const awaitingPayment = useMemo(() => active.filter(isAwaitingPayment).length, [active]);
  /*
   * Newest first, unlike the active list.
   *
   * `sortByPickupUrgency` answers "what needs attention next", which is
   * meaningless for something already delivered — there, the question is "what
   * did I send recently", and that is reverse chronological.
   */
  const delivered = useMemo(
    () =>
      mine
        .filter((b) => b.status === 'Delivered')
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [mine],
  );

  if (!viewerId) {
    return (
      <ScrollView
        contentContainerStyle={[styles.container, screenPadding]}
        showsVerticalScrollIndicator={false}>
        <SignedOutState
          title="Sign in to see your parcels"
          message="Your sent parcels and the jobs you're carrying live on your account, so they follow you to any device."
          next="/my-packages"
        />
        <Footer />
      </ScrollView>
    );
  }

  return (
    <>
      {/*
        Outside the scroller on purpose. It is a Modal, so where it sits in the
        tree does not decide where it draws — and `verify-footer` is right to
        insist that nothing comes after the footer inside a ScrollView.
      */}
      <PaymentSheet session={checkout} onOutcome={finishPayment} />

      <ScrollView
        contentContainerStyle={[styles.container, screenPadding]}
        showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title={SECTION_LABELS[section]}
          subtitle={
            section === 'active'
              ? `${active.length} parcel${active.length === 1 ? '' : 's'} still on the move` +
                (awaitingPayment > 0 ? ` · ${awaitingPayment} awaiting payment` : '')
              : `${delivered.length} delivered parcel${delivered.length === 1 ? '' : 's'}`
          }
        />

        {/*
          The confirmation that used to be its own screen.

          ⚠ A banner here rather than a `/parcel-confirmed` stop on the way.

            The tracking id is the one thing a sender needs to keep, and the old
            flow gave it its own page — which was right while posting ended in a
            dialog. It ends here now, on the list the parcel is actually on, and
            an interstitial between paying and seeing the parcel would be a page
            whose only content is a number that is also on the card below it. The
            full confirmation is still a tap away for anyone who wants it.
        */}
        {!!justPosted && section === 'active' && (
          <Card style={[styles.postedBanner, { borderColor: theme.success }]}>
            <View style={styles.postedRow}>
              <CircleCheck color={theme.success} size={20} />
              <View style={styles.postedText}>
                <Text style={[styles.postedTitle, { color: theme.text }]}>
                  Parcel posted and paid for
                </Text>
                <Text style={[styles.postedBody, { color: theme.textSecondary }]}>
                  #{justPosted} is on the board. Drivers heading that way can claim it now.
                </Text>
              </View>
            </View>
            <View style={styles.postedActions}>
              <Button
                label="View confirmation"
                variant="secondary"
                size="md"
                onPress={() =>
                  router.push({ pathname: '/parcel-confirmed', params: { trackingId: justPosted } })
                }
              />
              <Button
                label="Dismiss"
                variant="secondary"
                size="md"
                onPress={() => setJustPosted(null)}
              />
            </View>
          </Card>
        )}

        <View style={styles.sectionTabs}>
          <ChipGroup
            options={SECTIONS as unknown as string[]}
            selected={section}
            onSelect={(value) => choose(value as Section)}
            renderLabel={(value) =>
              value === 'active' ? `Active (${active.length})` : `History (${delivered.length})`
            }
            scrollable
          />
        </View>

        {mine.length === 0 ? (
          <Card style={styles.emptyCard}>
            <EmptyState
              icon={(color, size) => <PackageSearch color={color} size={size} />}
              title="Nothing here yet"
              message="Parcels you send — and jobs you claim as a driver — collect here."
            />
            <Button
              label="Book a Shipment"
              size="md"
              style={styles.emptyCta}
              onPress={() => router.navigate('/book')}
            />
          </Card>
        ) : (
          <>
            {(section === 'active' ? active : delivered).length === 0 ? (
              <Card style={styles.emptyCard}>
                <EmptyState
                  icon={(color, size) => <PackageSearch color={color} size={size} />}
                  title={section === 'active' ? 'Nothing in transit' : 'Nothing delivered yet'}
                  message={
                    section === 'active'
                      ? 'Everything you have sent has arrived. Book another and it will show here while it travels.'
                      : 'Parcels move here once they are delivered, so you keep a record of what you sent and what it cost.'
                  }
                />
                <Button
                  label={section === 'active' ? 'Book a Shipment' : 'See what is in transit'}
                  size="md"
                  style={styles.emptyCta}
                  onPress={() => (section === 'active' ? router.navigate('/book') : choose('active'))}
                />
              </Card>
            ) : (
              <View style={styles.list}>
                {(section === 'active' ? active : delivered).map((booking) => (
                  <ParcelRow
                    key={booking.id}
                    booking={booking}
                    userId={viewerId}
                    busy={payingFor === booking.id}
                    onPay={() => void startPayment(booking.id)}
                    onPress={() =>
                      router.push({ pathname: '/parcel/[id]', params: { id: booking.id } })
                    }
                  />
                ))}
              </View>
            )}
          </>
        )}
        <Footer />
      </ScrollView>
    </>
  );
}

function ParcelRow({
  booking,
  userId,
  busy,
  onPay,
  onPress,
}: {
  booking: Booking;
  userId: string;
  busy: boolean;
  onPay: () => void;
  onPress: () => void;
}) {
  const theme = useTheme();
  const progress = stageProgress(booking.status);
  const carrying = isCarrier(booking, userId);
  /*
    Only the sender is ever shown this. A driver cannot see an unpaid parcel at
    all — the select policy in 20250101000056_parcel_payments.sql does not return
    one — so `carrying` is false here by construction; the test is written out
    anyway, because a card that offered to charge somebody for a parcel they are
    delivering would be a bad thing to leave to an invariant elsewhere.
  */
  const unpaid = isAwaitingPayment(booking) && !carrying;

  return (
    /*
      ⚠ The card is the Card, and the Pressable is inside it — not the other way
        round, which is how this was written and what it cost.

        Wrapping the whole Card in a Pressable put the Pay button *inside* a
        button. Two things follow, and only one of them is cosmetic:

          - react-native-web maps `accessibilityRole="button"` onto a real
            `<button>` element, so the DOM was `<button>` inside `<button>` —
            invalid HTML, and React says so on screen in development.
          - Tapping Pay also fired the card's own handler, so the checkout sheet
            opened behind a parcel detail screen nobody asked for.

        The fix is structural rather than a `stopPropagation`: the tappable
        region is the part of the card that means "open this parcel", and the
        payment block is a sibling of it.
    */
    <Card style={styles.card}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${booking.itemDescription}, ${booking.trackingId}. View details`}
        style={({ pressed }) => [styles.cardBody, pressed && styles.pressed]}>
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderText}>
            <Text style={[styles.itemName, { color: theme.text }]} numberOfLines={1}>
              {booking.itemDescription}
            </Text>
            <Text style={[styles.trackingId, { color: theme.textMuted }]}>
              #{booking.trackingId} · {carrying ? 'You are driving' : 'You sent this'}
            </Text>
          </View>
          <Text style={[styles.fee, { color: theme.text }]}>
            {formatNaira(booking.estimatedFee)}
          </Text>
        </View>

        <RoutePill label={routeLabel(booking)} tone={statusTone(booking)} />

        <ProgressBar
          fraction={progress.fraction}
          label={statusLabel(booking)}
          tone={statusTone(booking)}
        />

      </Pressable>

      {unpaid && (
        <View style={styles.unpaid}>
          <Text style={[styles.unpaidNote, { color: theme.warningOnSoft }]}>
            No driver can see this parcel until its fare is paid.
          </Text>
          <Button
            label={busy ? 'Opening checkout…' : `Pay ${formatNaira(booking.estimatedFee)}`}
            icon={(color, size) =>
              busy ? (
                <ActivityIndicator color={color} size="small" />
              ) : (
                <CreditCard color={color} size={size} />
              )
            }
            size="md"
            disabled={busy}
            onPress={onPay}
          />
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  /*
    The house container. Every full-page route centres at `MaxContentWidth`;
    this one had no constraint at all, so a desktop stretched a list of parcel
    cards edge to edge.
  */
  container: {
    flexGrow: 1,
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  list: {
    gap: Spacing.three - 4,
    marginBottom: Spacing.four,
  },
  card: {
    gap: Spacing.two + 2,
    borderRadius: Radius.lg,
  },
  /*
    The gap the Card used to give these three children directly. It moved with
    them when they moved inside the Pressable — a flex container only spaces its
    own children, and without this the header, the route pill and the progress
    bar collapse against each other.
  */
  cardBody: {
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
  fee: {
    ...Typography.body,
    ...font(700),
  },
  sectionTabs: {
    marginBottom: Spacing.three,
  },
  emptyCard: {
    gap: Spacing.three,
  },
  emptyCta: {
    alignSelf: 'center',
    minWidth: 220,
  },
  pressed: {
    opacity: 0.85,
  },
  postedBanner: {
    gap: Spacing.three,
    marginBottom: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: 1,
  },
  postedRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  postedText: {
    flex: 1,
    gap: Spacing.half,
  },
  postedTitle: {
    ...Typography.cardTitle,
  },
  postedBody: {
    ...Typography.caption,
  },
  postedActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  unpaid: {
    gap: Spacing.two,
    marginTop: Spacing.half,
  },
  unpaidNote: {
    ...Typography.caption,
  },
});
