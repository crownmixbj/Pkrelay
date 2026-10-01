import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Banknote,
  Download,
  Eye,
  RefreshCw,
  Search,
  TriangleAlert,
  Wallet,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { csvFilename, downloadCsv, toCsv, type CsvColumn } from '@/lib/csv';
import { errorMessage } from '@/lib/errors';
import { AdminError, AdminShell, Metric, adminStyles } from '@/components/ui/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipGroup } from '@/components/ui/chip';
import { ModerationDialog } from '@/components/ui/moderation-dialog';
import { SectionLabel } from '@/components/ui/screen';
import { showToast } from '@/components/ui/toast';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatNaira } from '@/store/bookings';
import {
  EMPTY_TOTALS,
  PAYMENT_CSV_COLUMNS,
  PAYOUT_STATE_LABELS,
  RANGE_KEYS,
  RANGE_LABELS,
  TRANSACTION_CSV_COLUMNS,
  fetchDriverLedger,
  fetchDriverPayouts,
  fetchFinanceTransactions,
  fetchPaymentTotals,
  fetchPayments,
  fromDateInput,
  resolveRange,
  revealPayoutAccount,
  settlePayout,
  syncPaymentWithGateway,
  toDateInput,
  type DateRange,
  type DriverLedgerEntry,
  type DriverPayoutRow,
  type FinanceTransaction,
  type PaymentRow,
  type PaymentStatusFilter,
  type PaymentTotals,
  type PayoutAccount,
  type PayoutState,
  type RangeKey,
} from '@/store/finance';

/**
 * Finance — the two directions the money moves.
 *
 * ⚠ One screen rather than two routes, because the two halves answer one
 *   question between them.
 *
 *   "Are we solvent this week" is inbound minus outbound, and an operator
 *   holding half of it in another tab is an operator doing arithmetic from
 *   memory. Sender ID Review and Hubs are separate routes because they are
 *   separate jobs on separate rhythms; these are one job.
 *
 * ⚠ Nothing on this screen is the control.
 *
 *   `AdminShell` hides it from a non-admin, which is a courtesy. What refuses
 *   the data is `is_admin()` inside every function in
 *   `20250101000058_admin_finance.sql`. Somebody who navigates here directly
 *   gets empty tables, not somebody else's bank details.
 */

type Section = 'inbound' | 'outbound';

const SECTIONS: readonly Section[] = ['inbound', 'outbound'] as const;

const SECTION_LABELS: Record<Section, string> = {
  inbound: 'Payments (Inbound)',
  outbound: 'Driver Payouts (Outbound)',
};

const PAYMENT_FILTERS: readonly PaymentStatusFilter[] = [
  'all',
  'success',
  'pending',
  'failed',
  'abandoned',
] as const;

const PAYMENT_FILTER_LABELS: Record<PaymentStatusFilter, string> = {
  all: 'All',
  success: 'Successful',
  pending: 'Pending',
  failed: 'Failed',
  abandoned: 'Abandoned',
};

const PAYOUT_FILTERS: readonly (PayoutState | 'all')[] = [
  'all',
  'pending',
  'ready',
  'holding',
  'paid',
] as const;

function parseSection(value: unknown): Section {
  return SECTIONS.includes(value as Section) ? (value as Section) : 'inbound';
}

export default function AdminFinanceScreen() {
  const params = useLocalSearchParams<{ section?: string }>();
  const router = useRouter();

  const [section, setSection] = useState<Section>(() => parseSection(params.section));

  useEffect(() => setSection(parseSection(params.section)), [params.section]);

  const choose = (next: Section) => {
    setSection(next);
    router.setParams({ section: next });
  };

  /*
    ⚠ The range is held here, above both tabs, rather than inside each.

      An operator who narrows Inbound to March and switches to Outbound is still
      asking about March. Two independent pickers means two states that silently
      disagree, and the disagreement shows up as two exports that do not
      reconcile — which is the one failure this screen exists to prevent.
  */
  const [rangeKey, setRangeKey] = useState<RangeKey>('30d');
  const [custom, setCustom] = useState<DateRange>({ from: null, to: null });

  /*
    Recomputed when the preset or the custom dates change, and not on every
    render: `resolveRange` reads the clock, so an unmemoised call would return a
    new object each time and restart every fetch below it in a loop.
  */
  const range = useMemo(() => resolveRange(rangeKey, custom), [rangeKey, custom]);

  return (
    <AdminShell
      title="Finance"
      subtitle="What senders have paid us, and what we owe drivers."
      next="/admin-finance">
      <View style={styles.tabs}>
        <ChipGroup
          options={SECTIONS as unknown as string[]}
          selected={section}
          onSelect={(value) => choose(value as Section)}
          renderLabel={(value) => SECTION_LABELS[value as Section]}
          scrollable
        />
      </View>

      <RangePicker
        rangeKey={rangeKey}
        custom={custom}
        onPreset={setRangeKey}
        onCustom={(next) => {
          setCustom(next);
          setRangeKey('custom');
        }}
      />

      {section === 'inbound' ? (
        <InboundPanel range={range} />
      ) : (
        <OutboundPanel range={range} />
      )}
    </AdminShell>
  );
}

function RangePicker({
  rangeKey,
  custom,
  onPreset,
  onCustom,
}: {
  rangeKey: RangeKey;
  custom: DateRange;
  onPreset: (key: RangeKey) => void;
  onCustom: (range: DateRange) => void;
}) {
  const theme = useTheme();

  return (
    <View style={styles.range}>
      <ChipGroup
        options={RANGE_KEYS as unknown as string[]}
        selected={rangeKey}
        onSelect={(value) => onPreset(value as RangeKey)}
        renderLabel={(value) => RANGE_LABELS[value as RangeKey]}
        scrollable
      />

      {rangeKey === 'custom' && (
        <View style={styles.customRange}>
          {/*
            ⚠ Two text inputs rather than a calendar.

              A date picker on web in Expo is either a native input this project
              does not wrap or a component it does not install, and the admin
              console is a desktop tool where people type dates faster than they
              click them. `YYYY-MM-DD` is unambiguous in a way `03/04/2026` is
              not — and this app serves a country that reads that as 3 April
              while half the tooling around it reads it as 4 March.
          */}
          <DateField
            label="From"
            value={toDateInput(custom.from)}
            onChange={(value) => onCustom({ ...custom, from: fromDateInput(value) })}
          />
          <DateField
            label="To (inclusive)"
            value={toDateInput(custom.to)}
            onChange={(value) => onCustom({ ...custom, to: fromDateInput(value) })}
          />
          <Text style={[styles.meta, { color: theme.textMuted }]}>
            Leave either blank for open-ended.
          </Text>
        </View>
      )}
    </View>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();
  /* Held locally so a half-typed date is not parsed away mid-keystroke. */
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <View style={styles.dateField}>
      <Text style={[styles.factLabel, { color: theme.textMuted }]}>{label}</Text>
      <TextInput
        value={draft}
        onChangeText={(next) => {
          setDraft(next);
          onChange(next);
        }}
        placeholder="YYYY-MM-DD"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={`${label} date, as YYYY-MM-DD`}
        style={[
          styles.dateInput,
          { color: theme.text, borderColor: theme.borderStrong, backgroundColor: theme.surface },
        ]}
      />
    </View>
  );
}

/**
 * The export button, and the one honest thing it has to say on a phone.
 *
 * Saving a file on native needs a share sheet this project does not install, so
 * rather than writing a file into a cache directory nothing can open and
 * reporting success, the button says where the export works.
 */
function ExportButton<Row>({
  rows,
  columns,
  prefix,
  range,
  label = 'Export CSV',
}: {
  rows: readonly Row[];
  columns: readonly CsvColumn<Row>[];
  prefix: string;
  range: DateRange;
  label?: string;
}) {
  return (
    <Button
      label={label}
      variant="secondary"
      size="md"
      disabled={rows.length === 0}
      icon={(color, size) => <Download color={color} size={size} />}
      onPress={() => {
        const outcome = downloadCsv(
          csvFilename(prefix, range.from, range.to),
          toCsv(rows, columns),
        );
        if (!outcome.ok) showToast('Export unavailable', { message: outcome.reason, tone: 'info' });
        else showToast(`${rows.length} row${rows.length === 1 ? '' : 's'} exported`);
      }}
    />
  );
}

/* ====================================================== inbound ========== */

function InboundPanel({ range }: { range: DateRange }) {
  const theme = useTheme();

  const [totals, setTotals] = useState<PaymentTotals>(EMPTY_TOTALS);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [filter, setFilter] = useState<PaymentStatusFilter>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [summary, ledger] = await Promise.all([
        fetchPaymentTotals(range),
        fetchPayments(filter, query, range),
      ]);
      setTotals(summary);
      setRows(ledger);
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not load the payments ledger.'));
    } finally {
      setLoading(false);
    }
  }, [filter, query, range]);

  /*
   * ⚠ Debounced, because the search box is the filter.
   *
   *   Typing a tracking id is eleven characters and would be eleven round trips
   *   against a `security definer` function that joins three tables. The pause
   *   is short enough that a paste feels immediate and long enough that typing
   *   costs one query.
   */
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  return (
    <View>
      <View style={adminStyles.metrics}>
        <Metric label="Collected" value={formatNaira(totals.collected)} tone="success" />
        <Metric label="Last 7 days" value={formatNaira(totals.collectedLast7Days)} />
        <Metric label="Successful charges" value={totals.succeeded} />
        <Metric
          label="Awaiting payment"
          value={totals.parcelsAwaitingPayment}
          tone={totals.parcelsAwaitingPayment > 0 ? 'warning' : 'neutral'}
          hint="Parcels posted but not paid for. No driver can see these."
        />
        {/*
          ⚠ Shown only when there are some, and it is the one number on this
            screen that is a task rather than a statistic.

            A charge that settled against a parcel cancelled mid-checkout is
            money taken for a delivery that never happened. There is no refund
            path in this system — `settle_parcel_payment` records it and logs a
            warning — so until this tile existed the only way to find one was to
            think to grep `app_events`. A permanent zero would train people to
            stop reading it.
        */}
        {totals.refundsOwed > 0 && (
          <Metric
            label="Refunds owed"
            value={totals.refundsOwed}
            tone="danger"
            hint="Paid, then the parcel was cancelled. Refund by hand in Paystack."
          />
        )}
      </View>

      <View style={styles.sectionHead}>
        <SectionLabel>Charges</SectionLabel>
        <ExportButton
          rows={rows}
          columns={PAYMENT_CSV_COLUMNS}
          prefix="payments"
          range={range}
        />
      </View>

      <View style={styles.controls}>
        <View style={[styles.search, { borderColor: theme.borderStrong, backgroundColor: theme.surface }]}>
          <Search color={theme.textMuted} size={16} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Reference or tracking ID"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.searchInput, { color: theme.text }]}
            accessibilityLabel="Search payments by reference or tracking ID"
          />
        </View>

        <ChipGroup
          options={PAYMENT_FILTERS as unknown as string[]}
          selected={filter}
          onSelect={(value) => setFilter(value as PaymentStatusFilter)}
          renderLabel={(value) => PAYMENT_FILTER_LABELS[value as PaymentStatusFilter]}
          scrollable
        />
      </View>

      {!!error && <AdminError message={error} />}

      {loading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : rows.length === 0 ? (
        <Card>
          <Text style={[styles.empty, { color: theme.textSecondary }]}>
            {query.trim()
              ? `Nothing matches “${query.trim()}”.`
              : 'No charges yet. A parcel posted and paid for appears here within seconds.'}
          </Text>
        </Card>
      ) : (
        <View style={styles.list}>
          {rows.map((row) => (
            <PaymentCard key={row.id} row={row} onSynced={() => void load()} />
          ))}
        </View>
      )}
    </View>
  );
}

function PaymentCard({ row, onSynced }: { row: PaymentRow; onSynced: () => void }) {
  const theme = useTheme();
  const [syncing, setSyncing] = useState(false);

  /*
    ⚠ Offered on anything not settled, including 'success'.

      The obvious rule is "only on pending charges". But the case this exists
      for is a *dropped webhook*: Paystack took the money and we never heard, so
      our row says pending while theirs says success — and the mirror case, a
      row marked success against a parcel still showing unpaid, is the same
      failure seen from the other end. Both are fixed by asking Paystack again,
      and the call is idempotent, so offering it too widely costs a round trip
      and never a double charge.
  */
  const settled = row.status === 'success' && row.parcelPaymentStatus !== 'pending';

  const sync = async () => {
    setSyncing(true);
    try {
      const verdict = await syncPaymentWithGateway(row.reference);

      if (verdict.status === 'success') {
        showToast('Paystack confirms this charge', {
          message: 'The parcel is paid and on the board.',
        });
      } else if (verdict.status === 'failed') {
        showToast('Paystack says this did not go through', {
          message: verdict.error ?? 'The attempt is now closed and the sender can retry.',
          tone: 'info',
        });
      } else {
        showToast('Paystack could not be reached', {
          message: verdict.error ?? 'Nothing has been changed. Try again shortly.',
          tone: 'info',
        });
      }

      onSynced();
    } finally {
      setSyncing(false);
    }
  };

  const tone =
    row.status === 'success' ? 'success' : row.status === 'pending' ? 'warning' : 'neutral';

  return (
    <Card style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.cardHeadText}>
          <Text style={[styles.cardTitle, { color: theme.text }]}>{row.trackingId || '—'}</Text>
          <Text style={[styles.meta, { color: theme.textMuted }]} numberOfLines={1}>
            {row.senderName || 'Unnamed sender'} · {row.originCity} → {row.destinationCity}
          </Text>
        </View>
        <View style={styles.cardHeadRight}>
          <Text style={[styles.amount, { color: theme.text }]}>{formatNaira(row.amount)}</Text>
          <Badge label={row.status} tone={tone} />
        </View>
      </View>

      {/*
        The reference, selectable and never truncated.

        It is the one string on this card somebody copies — into Paystack's
        dashboard, into a support reply, into a bank statement search. A
        reference shown as "pkr_m2x9…" is a reference nobody can use.
      */}
      <Text selectable style={[styles.reference, { color: theme.textSecondary }]}>
        {row.reference}
      </Text>

      <View style={styles.factRow}>
        <Fact label="Method" value={row.channel ? row.channel.replace(/_/g, ' ') : '—'} />
        <Fact label="Paid" value={row.paidAt ? new Date(row.paidAt).toLocaleString() : '—'} />
        <Fact label="Parcel" value={row.parcelStatus} />
        <Fact label="Fare status" value={row.parcelPaymentStatus} />
      </View>

      {/*
        The fee split.

        ⚠ Labelled, because half of these rows are a forecast.

          The commission is computed at delivery from the rate in force then and
          stored on the earning row. Before delivery there is no driver and no
          earning — only a fare and today's rate. Shown without the label, the
          same three numbers would read as a settled liability on a parcel
          nobody has carried yet, and they would change next quarter.
      */}
      <View style={[styles.split, { borderTopColor: theme.border }]}>
        <View style={styles.splitHead}>
          <Text style={[styles.factLabel, { color: theme.textMuted }]}>
            Fee breakdown · {Math.round(row.commissionRate * 100)}%
          </Text>
          <Badge
            label={row.splitIsActual ? 'Recorded' : 'Expected'}
            tone={row.splitIsActual ? 'success' : 'neutral'}
          />
        </View>

        <View style={styles.factRow}>
          <Fact label="Gross fare" value={formatNaira(row.fare)} />
          <Fact label="Platform cut" value={formatNaira(row.commission)} />
          <Fact label="Driver share" value={formatNaira(row.driverShare)} />
        </View>

        {!row.splitIsActual && (
          <Text style={[styles.meta, { color: theme.textMuted }]}>
            Projected at the current rate. The real split is recorded when the parcel is
            delivered.
          </Text>
        )}

        {/*
          ⚠ Named when it happens, because it is the row somebody must act on.

            Settlement refuses an underpayment and accepts an overpayment — a
            sender charged too much must not also be refused their parcel. The
            difference is real money and nothing else in the system mentions it.
        */}
        {Math.abs(row.amount - row.fare) >= 0.01 && row.status === 'success' && (
          <Text style={[styles.meta, { color: theme.warningOnSoft }]}>
            Charged {formatNaira(row.amount)} against a fare of {formatNaira(row.fare)} —{' '}
            {formatNaira(Math.abs(row.amount - row.fare))}{' '}
            {row.amount > row.fare ? 'over' : 'under'}.
          </Text>
        )}
      </View>

      {!!row.failureReason && (
        <Text style={[styles.meta, { color: theme.warningOnSoft }]}>{row.failureReason}</Text>
      )}

      <View style={styles.rowActions}>
        <Button
          label={syncing ? 'Checking Paystack…' : settled ? 'Re-check with Paystack' : 'Verify with Paystack'}
          variant="secondary"
          size="md"
          disabled={syncing}
          icon={(color, size) => <RefreshCw color={color} size={size} />}
          onPress={() => void sync()}
        />
      </View>

      {row.refundOwed && (
        <View style={[styles.flag, { backgroundColor: theme.dangerSoft }]}>
          <TriangleAlert color={theme.dangerOnSoft} size={14} />
          <Text style={[styles.flagText, { color: theme.dangerOnSoft }]}>
            Charged, then the parcel was cancelled. A refund is owed and nothing in Package Relay
            makes one — issue it in Paystack against this reference.
          </Text>
        </View>
      )}
    </Card>
  );
}

/* ===================================================== outbound ========== */

function OutboundPanel({ range }: { range: DateRange }) {
  const theme = useTheme();

  const [rows, setRows] = useState<DriverPayoutRow[]>([]);
  const [transactions, setTransactions] = useState<FinanceTransaction[]>([]);
  const [filter, setFilter] = useState<PayoutState | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [settling, setSettling] = useState<DriverPayoutRow | null>(null);

  const load = useCallback(async () => {
    try {
      /*
        ⚠ The balances are fetched without the range, and the transactions with
          it. That asymmetry is the design, not an oversight.

          A balance is an as-of-now figure — what a driver could withdraw today.
          "Available in March" is not a quantity; recomputing one over a window
          produces a number that looks authoritative and is the one somebody
          would pay against. The transactions are what a date range can honestly
          filter, and what reconciliation actually wants.
      */
      const [balances, feed] = await Promise.all([
        fetchDriverPayouts(filter),
        fetchFinanceTransactions(range),
      ]);
      setRows(balances);
      setTransactions(feed);
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not load the payout ledger.'));
    } finally {
      setLoading(false);
    }
  }, [filter, range]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Totals across whatever is on screen.
   *
   * ⚠ "Owed" is `available`, not `net_earned`.
   *
   *   What a driver has earned since they joined is not what we owe them today
   *   — most of it has been paid. Summing earnings would put a number on this
   *   screen that grows for ever and means nothing, and it is the number
   *   somebody would quote in a board meeting.
   */
  const summary = useMemo(
    () => ({
      owed: rows.reduce((total, row) => total + row.available, 0),
      pending: rows.filter((row) => row.state === 'pending').length,
      ready: rows.filter((row) => row.state === 'ready').length,
      fees: rows.reduce((total, row) => total + row.commission, 0),
    }),
    [rows],
  );

  return (
    <View>
      <View style={adminStyles.metrics}>
        <Metric
          label="Owed now"
          value={formatNaira(summary.owed)}
          tone={summary.owed > 0 ? 'warning' : 'neutral'}
          hint="Withdrawable balances across every driver."
        />
        <Metric
          label="Awaiting transfer"
          value={summary.pending}
          tone={summary.pending > 0 ? 'primary' : 'neutral'}
          hint="Requests somebody has to pay."
        />
        <Metric label="Ready to request" value={summary.ready} />
        <Metric
          label="Platform fees"
          value={formatNaira(summary.fees)}
          tone="success"
          hint="Our share of every delivery, all time."
        />
      </View>

      <View style={styles.sectionHead}>
        <SectionLabel>Drivers</SectionLabel>
        <Text style={[styles.meta, { color: theme.textMuted }]}>Balances are as of now</Text>
      </View>

      <View style={styles.controls}>
        <ChipGroup
          options={PAYOUT_FILTERS as unknown as string[]}
          selected={filter}
          onSelect={(value) => setFilter(value as PayoutState | 'all')}
          renderLabel={(value) =>
            value === 'all' ? 'All' : PAYOUT_STATE_LABELS[value as PayoutState]
          }
          scrollable
        />
      </View>

      {!!error && <AdminError message={error} />}

      {loading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : rows.length === 0 ? (
        <Card>
          <Text style={[styles.empty, { color: theme.textSecondary }]}>
            No driver has earned anything yet. A row appears the first time a parcel is
            delivered.
          </Text>
        </Card>
      ) : (
        <View style={styles.list}>
          {rows.map((row) => (
            <DriverCard
              key={row.driverId}
              row={row}
              open={expanded === row.driverId}
              onToggle={() => setExpanded(expanded === row.driverId ? null : row.driverId)}
              onSettle={() => setSettling(row)}
            />
          ))}
        </View>
      )}

      <TransactionsTable rows={transactions} range={range} loading={loading} />

      {settling?.openRequestId && (
        <ModerationDialog
          title={`Mark ${formatNaira(settling.openRequestAmount ?? 0)} as paid`}
          body={`Record that the transfer to ${settling.driverName || 'this driver'} has been made. This does not move any money — it records that somebody did.`}
          consequences={[
            'The request is closed and the amount leaves their available balance.',
            'The driver is emailed that their payout has been sent.',
            'The reference below is stored against the payout and shown to them.',
          ]}
          confirmLabel="Mark as paid"
          /*
            ⚠ Required, though `settle_payout` takes it as optional.

              A settled payout with nothing recorded is one nobody can match
              against a bank statement six weeks later when a driver says the
              money never arrived. The database allows it; this screen does not.
          */
          reasonRequired
          reasonLabel="Bank transfer reference"
          onConfirm={async (reference) => {
            await settlePayout(settling.openRequestId as string, 'paid', reference);
            showToast('Payout marked as paid', {
              message: `${formatNaira(settling.openRequestAmount ?? 0)} recorded against ${reference}.`,
            });
            await load();
          }}
          onClose={() => setSettling(null)}
        />
      )}
    </View>
  );
}

function DriverCard({
  row,
  open,
  onToggle,
  onSettle,
}: {
  row: DriverPayoutRow;
  open: boolean;
  onToggle: () => void;
  onSettle: () => void;
}) {
  const theme = useTheme();

  const tone =
    row.state === 'pending'
      ? 'primary'
      : row.state === 'ready'
        ? 'warning'
        : row.state === 'paid'
          ? 'success'
          : 'neutral';

  return (
    <Card style={styles.card}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${row.driverName || 'Driver'}. ${PAYOUT_STATE_LABELS[row.state]}. Show their earnings`}
        style={({ pressed }) => pressed && styles.pressed}>
        <View style={styles.cardHead}>
          <View style={styles.cardHeadText}>
            <Text style={[styles.cardTitle, { color: theme.text }]}>
              {row.driverName || 'Unnamed driver'}
            </Text>
            <Text style={[styles.meta, { color: theme.textMuted }]}>
              {row.deliveries} deliver{row.deliveries === 1 ? 'y' : 'ies'} ·{' '}
              {formatNaira(row.gross)} fares · {formatNaira(row.commission)} to us
            </Text>
          </View>
          <View style={styles.cardHeadRight}>
            <Text style={[styles.amount, { color: theme.text }]}>
              {formatNaira(row.available)}
            </Text>
            <Badge label={PAYOUT_STATE_LABELS[row.state]} tone={tone} />
          </View>
        </View>
      </Pressable>

      <View style={styles.factRow}>
        <Fact label="Earned" value={formatNaira(row.netEarned)} />
        <Fact label="Paid out" value={formatNaira(row.paidOut)} />
        <Fact label="On hold" value={formatNaira(row.onHold)} />
        <Fact
          label="Last paid"
          value={row.lastPaidAt ? new Date(row.lastPaidAt).toLocaleDateString() : '—'}
        />
      </View>

      {/*
        ⚠ Named where it is true, rather than left for somebody to wonder about.

          A banned driver keeps whatever they had already earned — the ban
          revokes driving, not wages — so their balance is still owed and still
          payable. Saying so stops a well-meaning operator withholding money
          they have no right to withhold.
      */}
      {row.drivingBanned && (
        <Text style={[styles.meta, { color: theme.warningOnSoft }]}>
          Driving is banned. Anything already earned is still owed.
        </Text>
      )}

      {row.openRequestId && (
        <OpenRequest row={row} onSettle={onSettle} />
      )}

      {open && <DriverHistory driverId={row.driverId} />}
    </Card>
  );
}

function OpenRequest({ row, onSettle }: { row: DriverPayoutRow; onSettle: () => void }) {
  const theme = useTheme();
  const [account, setAccount] = useState<PayoutAccount | null>(null);
  const [revealing, setRevealing] = useState(false);

  const reveal = async () => {
    setRevealing(true);
    try {
      const found = await revealPayoutAccount(row.openRequestId as string, 'making the transfer');
      if (found) setAccount(found);
      else showToast('Could not read that account', { tone: 'info' });
    } finally {
      setRevealing(false);
    }
  };

  return (
    <View style={[styles.request, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}>
      <Text style={[styles.requestTitle, { color: theme.text }]}>
        Requested {formatNaira(row.openRequestAmount ?? 0)}
        {row.openRequestedAt ? ` on ${new Date(row.openRequestedAt).toLocaleDateString()}` : ''}
      </Text>

      <Text style={[styles.meta, { color: theme.textSecondary }]}>
        {row.openBankName ?? '—'} ·{' '}
        {account ? account.accountNumber : `••••${row.openAccountHint ?? '····'}`} ·{' '}
        {row.openAccountName ?? '—'}
      </Text>

      <View style={styles.requestActions}>
        {/*
          ⚠ The full account number is a second call, and it is logged.

            The list shows four digits, which is enough to recognise an account
            and useless for moving money. Folding the whole number into the
            ledger would put every driver's account on screen every time
            somebody opened this tab; asking for it records who asked and when.
        */}
        {!account && (
          <Button
            label={revealing ? 'Revealing…' : 'Show account number'}
            variant="secondary"
            size="md"
            disabled={revealing}
            icon={(color, size) => <Eye color={color} size={size} />}
            onPress={() => void reveal()}
          />
        )}
        <Button
          label="Mark as paid"
          size="md"
          icon={(color, size) => <Banknote color={color} size={size} />}
          onPress={onSettle}
        />
      </View>
    </View>
  );
}

function DriverHistory({ driverId }: { driverId: string }) {
  const theme = useTheme();
  const [entries, setEntries] = useState<DriverLedgerEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    void fetchDriverLedger(driverId).then((found) => {
      if (live) setEntries(found);
    });
    return () => {
      live = false;
    };
  }, [driverId]);

  if (entries === null) {
    return <ActivityIndicator color={theme.primary} style={styles.loading} />;
  }

  if (entries.length === 0) {
    return <Text style={[styles.meta, { color: theme.textMuted }]}>Nothing recorded yet.</Text>;
  }

  return (
    <View style={[styles.history, { borderTopColor: theme.border }]}>
      {entries.map((entry, index) => (
        <View key={`${entry.kind}-${index}`} style={styles.historyRow}>
          <Wallet
            color={entry.kind === 'payout' ? theme.primary : theme.textMuted}
            size={14}
          />
          <View style={styles.historyText}>
            <Text style={[styles.historyLabel, { color: theme.text }]} numberOfLines={2}>
              {entry.label}
            </Text>
            <Text style={[styles.meta, { color: theme.textMuted }]}>
              {entry.happenedAt ? new Date(entry.happenedAt).toLocaleString() : '—'}
              {entry.reference ? ` · ${entry.reference}` : ''}
            </Text>
          </View>
          <Text style={[styles.historyAmount, { color: theme.text }]}>
            {entry.kind === 'payout' ? '−' : '+'}
            {formatNaira(entry.amount)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * What moved in the selected window, across every driver.
 *
 * ⚠ Amounts are signed, and the sign is load-bearing.
 *
 *   An earning is money owed to a driver; a payout is money sent to them.
 *   Showing both as positive gives a column whose total is roughly double the
 *   truth, and the first person to sum it in a spreadsheet would not notice.
 *   The net at the foot is the number that answers "what did this month cost".
 */
function TransactionsTable({
  rows,
  range,
  loading,
}: {
  rows: FinanceTransaction[];
  range: DateRange;
  loading: boolean;
}) {
  const theme = useTheme();

  const net = useMemo(() => rows.reduce((total, row) => total + row.amount, 0), [rows]);

  return (
    <View style={adminStyles.section}>
      <View style={styles.sectionHead}>
        <SectionLabel>Transactions in range</SectionLabel>
        <ExportButton
          rows={rows}
          columns={TRANSACTION_CSV_COLUMNS}
          prefix="payouts"
          range={range}
          label="Export CSV"
        />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : rows.length === 0 ? (
        <Card>
          <Text style={[styles.empty, { color: theme.textSecondary }]}>
            Nothing was earned or paid out in this range.
          </Text>
        </Card>
      ) : (
        <Card style={styles.card}>
          {rows.slice(0, 50).map((row, index) => (
            <View key={`${row.kind}-${index}`} style={styles.txnRow}>
              <View style={styles.txnText}>
                <Text style={[styles.historyLabel, { color: theme.text }]} numberOfLines={1}>
                  {row.driverName || 'Unnamed driver'}
                  {row.trackingId ? ` · ${row.trackingId}` : ''}
                </Text>
                <Text style={[styles.meta, { color: theme.textMuted }]} numberOfLines={1}>
                  {row.happenedAt ? new Date(row.happenedAt).toLocaleString() : '—'} ·{' '}
                  {row.kind === 'payout' ? `payout (${row.status})` : 'earning'}
                  {row.reference ? ` · ${row.reference}` : ''}
                </Text>
              </View>
              <Text
                style={[
                  styles.historyAmount,
                  { color: row.amount < 0 ? theme.textSecondary : theme.text },
                ]}>
                {row.amount < 0 ? '−' : '+'}
                {formatNaira(Math.abs(row.amount))}
              </Text>
            </View>
          ))}

          {rows.length > 50 && (
            <Text style={[styles.meta, { color: theme.textMuted }]}>
              Showing the 50 most recent of {rows.length}. The export has all of them.
            </Text>
          )}

          <View style={[styles.txnTotal, { borderTopColor: theme.border }]}>
            <Text style={[styles.historyLabel, { color: theme.textSecondary }]}>
              Net movement ({rows.length} transaction{rows.length === 1 ? '' : 's'})
            </Text>
            <Text style={[styles.amount, { color: theme.text }]}>
              {net < 0 ? '−' : ''}
              {formatNaira(Math.abs(net))}
            </Text>
          </View>
        </Card>
      )}
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  const theme = useTheme();
  return (
    <View style={styles.fact}>
      <Text style={[styles.factLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.factValue, { color: theme.text }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: {
    marginBottom: Spacing.three,
  },
  controls: {
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    height: 44,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: {
    flex: 1,
    ...Typography.body,
    /*
      `outlineWidth: 0`, not `outlineStyle: 'none'` — `field.tsx` hit this and
      left the note: RN's types only admit solid/dotted/dashed for the style,
      so 'none' fails typecheck while the width does the same job on web and is
      ignored on native. The wrapper's border is the field's only outline.
    */
    outlineWidth: 0,
  },
  loading: {
    marginVertical: Spacing.four,
  },
  empty: {
    ...Typography.body,
  },
  list: {
    gap: Spacing.two + 2,
    marginBottom: Spacing.four,
  },
  card: {
    gap: Spacing.two,
    borderRadius: Radius.lg,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  cardHeadText: {
    flex: 1,
    gap: Spacing.half,
  },
  cardHeadRight: {
    alignItems: 'flex-end',
    gap: Spacing.half,
  },
  cardTitle: {
    ...Typography.cardTitle,
  },
  amount: {
    ...Typography.body,
    ...font(700),
  },
  meta: {
    ...Typography.caption,
  },
  reference: {
    ...Typography.caption,
    ...font(500),
  },
  factRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  fact: {
    gap: 1,
    minWidth: 96,
  },
  factLabel: {
    ...Typography.micro,
  },
  factValue: {
    ...Typography.caption,
    ...font(600),
  },
  flag: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.two,
    borderRadius: Radius.sm,
  },
  flagText: {
    ...Typography.caption,
    flex: 1,
  },
  request: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  requestTitle: {
    ...Typography.label,
  },
  requestActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  history: {
    gap: Spacing.two,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  historyText: {
    flex: 1,
    gap: 1,
  },
  historyLabel: {
    ...Typography.caption,
    ...font(600),
  },
  historyAmount: {
    ...Typography.caption,
    ...font(700),
  },
  pressed: {
    opacity: 0.85,
  },
  range: {
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  customRange: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  dateField: {
    gap: Spacing.half,
  },
  dateInput: {
    minWidth: 150,
    height: 40,
    paddingHorizontal: Spacing.two,
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    ...Typography.caption,
    outlineWidth: 0,
  },
  sectionHead: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  split: {
    gap: Spacing.two,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  splitHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  rowActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  txnRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  txnText: {
    flex: 1,
    gap: 1,
  },
  txnTotal: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
