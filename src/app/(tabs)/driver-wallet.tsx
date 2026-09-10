import { useRouter } from 'expo-router';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Clock,
  Info,
  PackageCheck,
  Wallet,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { showDialog } from '@/components/ui/dialog';
import { PayoutAccountCard } from '@/components/ui/payout-account';
import { EmptyState, screenPadding, ScreenHeader, SectionLabel } from '@/components/ui/screen';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { showToast } from '@/components/ui/toast';
import { FontSize, MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/store/session';
import {
  cancelPayout,
  canRequest,
  DEFAULT_SETTINGS,
  EMPTY_BALANCE,
  fetchActivity,
  fetchBalance,
  fetchOpenPayout,
  fetchWalletSettings,
  naira,
  payoutStatusLine,
  requestPayout,
  type Balance,
  type OpenPayout,
  type WalletEntry,
  type WalletSettings,
} from '@/store/wallet';

/**
 * Driver Wallet — what Package Relay owes, and where it is going.
 *
 * Every figure comes from `public.driver_earnings` and `public.payout_requests`
 * (`supabase/migrations/20250101000030_driver_wallet.sql`), so unlike the Expected earnings card this
 * screen is entitled to the word "balance". A parcel delivered writes one row at
 * the commission rate recorded on that row; nothing here is a sum of quoted
 * fares.
 *
 * ⚠ The one thing this screen must never imply is that Package Relay moves money.
 *
 *   Nothing in the app talks to a bank. `settle_payout` records that a person
 *   made a transfer. A wallet that shows a balance, a button and a tidy
 *   "Processing" chip reads exactly like an automated payout rail — so the
 *   transfer being manual is said in the schedule line, in the confirmation
 *   dialog, and on the pending row. Three places, because a driver who assumes
 *   otherwise will wait on money nobody has been told to send.
 */
export default function DriverWalletScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { viewerId, application, isApprovedDriver } = useSession();

  const [balance, setBalance] = useState<Balance>(EMPTY_BALANCE);
  const [open, setOpen] = useState<OpenPayout | null>(null);
  const [activity, setActivity] = useState<WalletEntry[]>([]);
  const [settings, setSettings] = useState<WalletSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  /*
   * One refresh for all four, rather than four effects.
   *
   * The balance and the open request are two views of the same fact — an open
   * request is *subtracted* from `available` — so loading them independently
   * would let the screen render a balance that already accounts for a request
   * it has not yet drawn. They land together or not at all.
   */
  const refresh = useCallback(async () => {
    if (!viewerId) return;

    const [nextBalance, nextOpen, nextActivity, nextSettings] = await Promise.all([
      fetchBalance(),
      fetchOpenPayout(),
      fetchActivity(),
      fetchWalletSettings(),
    ]);

    setBalance(nextBalance);
    setOpen(nextOpen);
    setActivity(nextActivity);
    setSettings(nextSettings);
    setLoading(false);
  }, [viewerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!viewerId) {
    return (
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[styles.container, screenPadding]}>
        <View style={styles.content}>
          <ScreenHeader
            brand={false}
            title="Driver Wallet"
            subtitle="What you have earned, and what has been paid out."
          />
          <SignedOutState
            title="Sign in to see your wallet"
            message="Your earnings and payouts are tied to your account."
            next="/driver-wallet"
          />
        </View>
        <Footer />
      </ScrollView>
    );
  }

  /*
   * An unapproved driver has no wallet, and saying so beats an empty one.
   *
   * `record_delivery_earning` only fires on a delivered parcel, and only an
   * approved driver can be offered one — so a zero balance here is not "you
   * have not earned yet", it is "you cannot earn yet". Those are different
   * sentences and the second one has a next step.
   */
  if (!isApprovedDriver) {
    return (
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[styles.container, screenPadding]}>
        <View style={styles.content}>
          <ScreenHeader
            brand={false}
            title="Driver Wallet"
            subtitle="What you have earned, and what has been paid out."
          />
          <EmptyState
            icon={(color, size) => <Wallet color={color} size={size} />}
            title="Nothing to pay out yet"
            message={
              application
                ? 'Your wallet opens when your application is approved and you deliver your first parcel.'
                : 'Only approved drivers earn on Package Relay. Apply to drive and your wallet starts with your first delivery.'
            }
          />
          <Button
            label={application ? 'Check your application' : 'Apply to drive'}
            onPress={() => router.navigate(application ? '/driver-updates' : '/driver-signup')}
            style={styles.emptyCta}
          />
        </View>
        <Footer />
      </ScrollView>
    );
  }

  const ready = canRequest(balance, open, settings.minimum);
  const scheduleLine = payoutStatusLine(balance, open, settings.holdHours, settings.minimum);

  /*
   * Confirmed before it is sent, and the confirmation names the account.
   *
   * `request_payout` snapshots the bank details onto the row at request time,
   * so the account shown here is the account the money goes to — including for
   * a driver mid-way through a 48-hour payout change, who is precisely the
   * person most likely to be surprised by which one it is.
   */
  const askToRequest = () => {
    showDialog(
      `Request ${naira(balance.available)}?`,
      `This goes to ${application?.bankName ?? 'your payout account'} ····${(application?.accountNumber ?? '').slice(-4)}.\n\nPackage Relay transfers it by hand — it is not instant, and you will see it here once someone has sent it.`,
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Request payout', onPress: () => void submit() },
      ],
    );
  };

  const submit = async () => {
    setBusy(true);
    const outcome = await requestPayout();
    setBusy(false);

    if (!outcome.ok) {
      /*
       * The server's sentence, verbatim.
       *
       * "You can withdraw up to ₦4,500", "The smallest payout is ₦1,000", "Add
       * a payout account before requesting money" — every one names the thing
       * to do next, and the balance on screen can be seconds stale, so the
       * refusal is often *more* current than what the driver is looking at.
       */
      showDialog('Could not request that payout', outcome.error);
      void refresh();
      return;
    }

    showToast('Payout requested', {
      message: 'Package Relay will transfer it to your account. You will see it here when it is done.',
      tone: 'info',
    });
    void refresh();
  };

  const withdraw = (payout: OpenPayout) => {
    showDialog(
      'Cancel this payout request?',
      `${naira(payout.amount)} goes back to your available balance. You can request it again at any time.`,
      [
        { text: 'Leave it', style: 'cancel' },
        {
          text: 'Cancel request',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              const outcome = await cancelPayout(payout.id);
              setBusy(false);

              if (!outcome.ok) {
                showDialog('Could not cancel', outcome.error);
                void refresh();
                return;
              }
              showToast('Request cancelled', { message: 'The money is back in your balance.' });
              void refresh();
            })();
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        <ScreenHeader
          brand={false}
          title="Driver Wallet"
          subtitle="What you have earned, and what has been paid out."
        />

        {/* ---------- The balance ---------- */}
        <Card style={styles.balanceCard}>
          <View style={styles.balanceHead}>
            <Wallet color={theme.primary} size={18} />
            <Text style={[styles.balanceLabel, { color: theme.textSecondary }]}>
              Available to withdraw
            </Text>
          </View>

          <Text style={[styles.balanceValue, { color: theme.text }]}>
            {loading ? '—' : naira(balance.available)}
          </Text>

          {/*
            The two figures behind the headline.

            Without them "Available" is a number a driver cannot check. Earned
            minus paid out minus held is the whole arithmetic, and showing it
            costs one row and answers the only question a smaller-than-expected
            balance ever raises.
          */}
          <View style={[styles.breakdown, { backgroundColor: theme.surfaceMuted }]}>
            <Figure label="Earned" value={naira(balance.earned)} />
            <View style={[styles.figureDivider, { backgroundColor: theme.border }]} />
            <Figure label="Paid out" value={naira(balance.paidOut)} />
            <View style={[styles.figureDivider, { backgroundColor: theme.border }]} />
            <Figure label="On hold" value={naira(balance.onHold)} />
          </View>

          <Button
            label={
              busy
                ? 'Requesting…'
                : open
                  ? `${naira(open.amount)} already requested`
                  : ready
                    ? `Request ${naira(balance.available)}`
                    : 'Request payout'
            }
            icon={(color, size) => <ArrowUpRight color={color} size={size} />}
            onPress={askToRequest}
            disabled={busy || loading || !ready}
          />
        </Card>

        {/* ---------- Schedule and hold ---------- */}
        <View style={[styles.schedule, { backgroundColor: theme.primarySoft }]}>
          <Clock color={theme.primaryOnSoft} size={16} />
          <View style={styles.scheduleText}>
            <Text style={[styles.scheduleTitle, { color: theme.primaryOnSoft }]}>
              Payout schedule
            </Text>
            <Text style={[styles.scheduleBody, { color: theme.primaryOnSoft }]}>
              {scheduleLine}
            </Text>
          </View>
        </View>

        {/*
          The pending request, with the way out.

          `cancel_payout_request` exists and a driver who requested the wrong
          amount has no other route to it — a wallet that can only ever add
          requests turns a fat-fingered tap into a support ticket.
        */}
        {open && (
          <View style={[styles.pending, { backgroundColor: theme.warningSoft }]}>
            <View style={styles.pendingHead}>
              <Clock color={theme.warningOnSoft} size={15} />
              <Text style={[styles.pendingLabel, { color: theme.warningOnSoft }]}>
                {naira(open.amount)} requested {relative(open.requestedAt)}
              </Text>
            </View>
            <Text style={[styles.pendingNote, { color: theme.warningOnSoft }]}>
              Waiting on Package Relay to make the transfer. It has already been taken out of your available
              balance, so it cannot be requested twice.
            </Text>
            <Button
              label="Cancel this request"
              variant="secondary"
              size="md"
              icon={(color, size) => <X color={color} size={size} />}
              onPress={() => withdraw(open)}
              disabled={busy}
            />
          </View>
        )}

        {/*
          ---------- Where it goes ----------

          The existing card, not a second bank form. It owns the 48-hour cooling
          window from `supabase/migrations/20250101000016_driver_identity.sql`, and a wallet screen with
          its own "Edit" writing straight to the account would be a way round the
          one control that stops a hijacked session redirecting the next payout.
        */}
        <SectionLabel>Payout method</SectionLabel>
        {application && (
          <PayoutAccountCard
            currentBank={application.bankName}
            currentAccount={application.accountNumber}
          />
        )}

        {/* ---------- History ---------- */}
        <SectionLabel>Recent transactions</SectionLabel>

        {activity.length === 0 ? (
          <EmptyState
            icon={(color, size) => <Banknote color={color} size={size} />}
            title={loading ? 'Loading…' : 'Nothing yet'}
            message="Deliveries you complete and payouts Package Relay sends both appear here."
          />
        ) : (
          <View style={styles.feed}>
            {activity.map((entry) => (
              <EntryRow key={`${entry.kind}-${entry.happenedAt}-${entry.label}`} entry={entry} />
            ))}
          </View>
        )}

        {/*
          The limit, stated at the bottom where somebody who has read the whole
          screen will meet it.
        */}
        <View style={[styles.footnote, { backgroundColor: theme.surfaceMuted }]}>
          <Info color={theme.textMuted} size={15} />
          <Text style={[styles.footnoteText, { color: theme.textSecondary }]}>
            Package Relay does not send money automatically. A payout marked paid means someone at Package Relay made
            the transfer and recorded it — if it says paid and your bank disagrees, contact support
            with the date.
          </Text>
        </View>
      </View>
      <Footer />
    </ScrollView>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.figure}>
      <Text style={[styles.figureValue, { color: theme.text }]}>{value}</Text>
      <Text style={[styles.figureLabel, { color: theme.textMuted }]}>{label}</Text>
    </View>
  );
}

/**
 * One line of the merged feed.
 *
 * Earnings and payouts share a row shape on purpose — they are the same
 * timeline, and splitting them into two lists is how a driver ends up unable to
 * see that the ₦4,000 they earned on Tuesday is the ₦4,000 that left on
 * Wednesday. The sign and the arrow carry the direction; colour does not do it
 * alone.
 */
function EntryRow({ entry }: { entry: WalletEntry }) {
  const theme = useTheme();
  const credit = entry.amount >= 0;

  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <View
        style={[
          styles.rowIcon,
          { backgroundColor: credit ? theme.successSoft : theme.surfaceMuted },
        ]}>
        {credit ? (
          <PackageCheck color={theme.successOnSoft} size={16} />
        ) : (
          <ArrowDownLeft color={theme.textSecondary} size={16} />
        )}
      </View>

      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: theme.text }]} numberOfLines={1}>
          {entry.label}
        </Text>
        <Text style={[styles.rowMeta, { color: theme.textMuted }]}>{when(entry.happenedAt)}</Text>
      </View>

      <View style={styles.rowRight}>
        <Text style={[styles.rowAmount, { color: credit ? theme.success : theme.text }]}>
          {credit ? '+' : '−'}
          {naira(Math.abs(entry.amount))}
        </Text>
        {/*
          Status only where it says something. Every earning row reads "earned",
          which is already what a green credit means — a chip on all of them is
          noise that makes the one that says "failed" harder to spot.
        */}
        {entry.status !== 'earned' && (
          <Badge
            label={payoutStatusLabel(entry.status)}
            tone={
              entry.status === 'paid' ? 'success' : entry.status === 'failed' ? 'danger' : 'warning'
            }
          />
        )}
      </View>
    </View>
  );
}

function payoutStatusLabel(status: string): string {
  if (status === 'requested') return 'Processing';
  if (status === 'paid') return 'Sent';
  if (status === 'failed') return 'Failed';
  return status;
}

/** "14 Aug, 09:12" — a date somebody can match against a bank statement. */
function when(iso: string): string {
  const date = new Date(iso);
  return (
    date.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    }) + `, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  );
}

/** "2 hours ago" — how long a driver has been waiting, which is the question. */
function relative(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    // Same as every other screen: without it the `alignItems: 'center'` above
    // has nothing to centre against and the card stretches across a desktop.
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.three,
  },
  emptyCta: {
    marginTop: Spacing.four,
  },
  balanceCard: {
    gap: Spacing.three - 2,
  },
  balanceHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  balanceLabel: {
    ...Typography.caption,
  },
  balanceValue: {
    fontSize: FontSize.display,
    ...font(800),
    letterSpacing: -0.5,
  },
  breakdown: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.two + 2,
    borderRadius: Radius.md,
  },
  figure: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.half,
  },
  figureValue: {
    ...Typography.meta,
    ...font(700),
  },
  figureLabel: {
    ...Typography.caption,
  },
  figureDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  schedule: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
  },
  scheduleText: {
    flex: 1,
    gap: Spacing.half,
  },
  scheduleTitle: {
    ...Typography.meta,
    ...font(700),
  },
  scheduleBody: {
    ...Typography.caption,
    lineHeight: 18,
  },
  pending: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    gap: Spacing.two,
  },
  pendingHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  pendingLabel: {
    ...Typography.meta,
    ...font(700),
  },
  pendingNote: {
    ...Typography.caption,
    lineHeight: 17,
  },
  feed: {
    gap: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingVertical: Spacing.three - 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
  rowLabel: {
    ...Typography.meta,
    ...font(600),
  },
  rowMeta: {
    ...Typography.caption,
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: Spacing.half,
  },
  rowAmount: {
    ...Typography.meta,
    ...font(700),
  },
  footnote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    marginTop: Spacing.two,
  },
  footnoteText: {
    flex: 1,
    ...Typography.caption,
    lineHeight: 18,
  },
});
