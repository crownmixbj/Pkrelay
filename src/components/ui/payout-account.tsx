import { Banknote, Clock, ShieldCheck, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { showDialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { showToast } from '@/components/ui/toast';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  cancelPayoutChange,
  fetchPayoutChanges,
  maskAccount,
  payoutChangeLabel,
  requestPayoutChange,
  PAYOUT_COOLING_HOURS,
  type PayoutChange,
} from '@/store/driver-applications';

/**
 * Where a driver's money goes, and the wait before it moves.
 *
 * The 48 hours is not friction for its own sake. Someone who gets into a
 * driver's account can otherwise redirect the next payout in seconds and be
 * gone. A window means the real driver has two days to notice — and, the part
 * that makes it fair rather than merely cautious, **the old account keeps
 * receiving transfers the whole time**. Nobody misses a payment for a change
 * they did not ask for.
 *
 * The rule is in `supabase/migrations/20250101000016_driver_identity.sql` and enforced by a scheduled
 * sweep, not by this screen.
 */
export function PayoutAccountCard({
  currentBank,
  currentAccount,
}: {
  currentBank: string;
  currentAccount: string;
}) {
  const theme = useTheme();

  const [changes, setChanges] = useState<PayoutChange[]>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [bank, setBank] = useState('');
  const [account, setAccount] = useState('');
  const [name, setName] = useState('');

  const refresh = useCallback(async () => {
    setChanges(await fetchPayoutChanges());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = changes.find((change) => change.status === 'pending') ?? null;

  const submit = async () => {
    setBusy(true);
    const result = await requestPayoutChange({
      bankName: bank.trim(),
      accountNumber: account.trim(),
      accountName: name.trim(),
    });
    setBusy(false);

    if (!result.ok) {
      showDialog('Could not request that change', result.error);
      return;
    }

    setEditing(false);
    setBank('');
    setAccount('');
    setName('');
    showToast('Payout change requested', {
      message: `Your current account keeps receiving transfers for the next ${PAYOUT_COOLING_HOURS} hours.`,
      tone: 'info',
    });
    void refresh();
  };

  const stop = async (change: PayoutChange) => {
    setBusy(true);
    const ok = await cancelPayoutChange(change.id);
    setBusy(false);

    if (!ok) {
      showDialog('Could not cancel', 'Try again in a moment.');
      return;
    }
    showToast('Payout change cancelled', { message: 'Nothing has moved.', tone: 'info' });
    void refresh();
  };

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Banknote color={theme.primary} size={18} />
        <Text style={[styles.title, { color: theme.text }]}>Payout account</Text>
      </View>

      {/* ---------- What is live right now ---------- */}
      <View style={[styles.current, { backgroundColor: theme.surfaceMuted }]}>
        <View style={styles.currentRow}>
          <ShieldCheck color={theme.success} size={15} />
          <Text style={[styles.currentLabel, { color: theme.textSecondary }]}>
            Receiving transfers
          </Text>
        </View>
        <Text style={[styles.currentValue, { color: theme.text }]}>
          {currentBank} · {maskAccount(currentAccount)}
        </Text>
      </View>

      {/* ---------- A change in flight ---------- */}
      {pending ? (
        <View style={[styles.pending, { backgroundColor: theme.warningSoft }]}>
          <View style={styles.currentRow}>
            <Clock color={theme.warningOnSoft} size={15} />
            <Text style={[styles.pendingLabel, { color: theme.warningOnSoft }]}>
              {payoutChangeLabel(pending)}
            </Text>
          </View>

          <Text style={[styles.pendingValue, { color: theme.warningOnSoft }]}>
            Changing to {pending.bankName} · {maskAccount(pending.accountNumber)}
          </Text>

          {/*
            The reassurance, stated rather than implied.

            A driver seeing "payout change pending" reasonably worries their
            money is in limbo. It is not — this is the sentence that says so.
          */}
          <Text style={[styles.pendingNote, { color: theme.warningOnSoft }]}>
            Until then your current account keeps receiving everything. Nothing is paused.
          </Text>

          <Text style={[styles.pendingNote, { color: theme.warningOnSoft }]}>
            Didn&apos;t request this? Cancel it now and change your password.
          </Text>

          <Button
            label="Cancel this change"
            variant="secondary"
            size="md"
            icon={(color, size) => <X color={color} size={size} />}
            onPress={() => stop(pending)}
            disabled={busy}
          />
        </View>
      ) : editing ? (
        <View style={styles.form}>
          <Field label="Bank" placeholder="GTBank" value={bank} onChangeText={setBank} />
          <Field
            label="Account number"
            placeholder="0123456789"
            keyboardType="numeric"
            value={account}
            onChangeText={setAccount}
          />
          <Field
            label="Account name"
            placeholder="As it appears at the bank"
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
          />

          <Text style={[styles.note, { color: theme.textMuted }]}>
            For your security this takes {PAYOUT_COOLING_HOURS} hours to take effect. Your current
            account keeps receiving transfers until then, and you can cancel at any point.
          </Text>

          <Button
            label={busy ? 'Requesting…' : 'Request this change'}
            onPress={submit}
            disabled={busy}
          />
          <Button
            label="Never mind"
            variant="secondary"
            onPress={() => setEditing(false)}
            disabled={busy}
          />
        </View>
      ) : (
        <Button
          label="Change payout account"
          variant="secondary"
          size="md"
          onPress={() => setEditing(true)}
        />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.three - 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  title: { ...Typography.sectionTitle },
  current: { padding: Spacing.three - 4, borderRadius: Radius.md, gap: Spacing.half },
  currentRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one + 2 },
  currentLabel: { ...Typography.caption },
  currentValue: { ...Typography.meta, ...font(700) },
  pending: { padding: Spacing.three - 4, borderRadius: Radius.md, gap: Spacing.two },
  pendingLabel: { ...Typography.caption, ...font(700) },
  pendingValue: { ...Typography.meta, ...font(600) },
  pendingNote: { ...Typography.caption, lineHeight: 17 },
  form: { gap: Spacing.three - 2 },
  note: { ...Typography.caption, lineHeight: 17 },
});
