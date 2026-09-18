import { supabase } from '@/lib/supabase';
import { verifyParcelPayment, type VerifyOutcome } from '@/store/payments';
import type { CsvColumn } from '@/lib/csv';

/**
 * The money, both directions, for the Admin area.
 *
 * Inbound is what senders paid through Paystack; outbound is what drivers are
 * owed and what has been sent. Everything here is a `security definer` function
 * that checks `is_admin()` server-side — see
 * `supabase/migrations/20250101000058_admin_finance.sql`. Nothing in this file
 * is the security boundary: a non-admin calling these gets empty lists from the
 * ledgers and an exception from the reveal, which is the behaviour the screen
 * is built on rather than a fallback it hopes for.
 *
 * ⚠ Kobo crosses the wire; naira is produced here, once.
 *
 *   `parcel_payments.amount_kobo` is the stored truth and the SQL sums it
 *   untouched. Converting in the components would put the ÷100 in every place
 *   an amount is rendered, and the one that forgets tells somebody they paid
 *   ₦280,000 for a ₦2,800 delivery.
 *
 *   Driver earnings are the other way round — 30 stores those in naira as
 *   `numeric` — so they are not converted at all. The two are deliberately
 *   named differently below so the difference cannot be read past.
 */

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const maybeText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

// ------------------------------------------------------------- date range --

export type RangeKey = 'today' | '7d' | '30d' | 'all' | 'custom';

export const RANGE_KEYS: readonly RangeKey[] = ['today', '7d', '30d', 'all', 'custom'] as const;

export const RANGE_LABELS: Record<RangeKey, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time',
  custom: 'Custom',
};

/** Null on either end means unbounded. `to` is exclusive. */
export type DateRange = { from: Date | null; to: Date | null };

/** Local midnight at the start of the day `date` falls in. */
function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/**
 * The range a preset means, resolved against a clock.
 *
 * ⚠ Local midnight, and an exclusive upper bound.
 *
 *   An operator in Lagos asking for "today" means the day they are having, not
 *   a UTC day that began at 1am. `Date` carries the offset, so bounding on
 *   local midnight and sending the instant is right in both places — the SQL
 *   compares `timestamptz` and never sees a date at all.
 *
 *   The upper bound is the *next* midnight and the SQL compares with `<`. An
 *   inclusive bound puts a charge made at exactly 00:00:00.000 into two
 *   adjacent monthly exports, which is the kind of thing found by an accountant
 *   rather than by a test.
 *
 * ⚠ `now` is a parameter so the assertions can pass one in.
 *
 *   A function that reads the clock itself can only be tested on the day it is
 *   run, which is how "last 30 days" quietly becomes 31 across a month boundary
 *   and nobody notices until a report is short.
 */
export function resolveRange(key: RangeKey, custom?: DateRange, now: Date = new Date()): DateRange {
  const tomorrow = addDays(startOfDay(now), 1);

  switch (key) {
    case 'today':
      return { from: startOfDay(now), to: tomorrow };
    case '7d':
      return { from: addDays(startOfDay(now), -6), to: tomorrow };
    case '30d':
      return { from: addDays(startOfDay(now), -29), to: tomorrow };
    case 'custom':
      return {
        from: custom?.from ? startOfDay(custom.from) : null,
        /* The custom picker takes an inclusive end date; the bound is the day after. */
        to: custom?.to ? addDays(startOfDay(custom.to), 1) : null,
      };
    case 'all':
    default:
      return { from: null, to: null };
  }
}

/** `YYYY-MM-DD`, which is what the custom inputs take and show. */
export function toDateInput(date: Date | null): string {
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A typed `YYYY-MM-DD`, or null.
 *
 * ⚠ Parsed by parts rather than by `new Date(value)`.
 *
 *   `new Date('2026-03-01')` is parsed as UTC midnight, so in Lagos it is the
 *   1st and in Los Angeles it is the 28th of February. Building it from the
 *   numbers gives local midnight everywhere, which is what the rest of this
 *   file assumes.
 */
export function fromDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

// ----------------------------------------------------------------- inbound --

export type PaymentTotals = {
  /** Naira. Converted from the kobo the ledger sums. */
  collected: number;
  collectedLast7Days: number;
  succeeded: number;
  pending: number;
  failed: number;
  parcelsAwaitingPayment: number;
  /** Charges that settled against a parcel that was cancelled. */
  refundsOwed: number;
};

export const EMPTY_TOTALS: PaymentTotals = {
  collected: 0,
  collectedLast7Days: 0,
  succeeded: 0,
  pending: 0,
  failed: 0,
  parcelsAwaitingPayment: 0,
  refundsOwed: 0,
};

export type PaymentStatusFilter = 'all' | 'success' | 'pending' | 'failed' | 'abandoned';

export type PaymentRow = {
  id: string;
  reference: string;
  gatewayReference: string | null;
  provider: string;
  /** Naira. */
  amount: number;
  currency: string;
  status: string;
  /** 'card', 'bank transfer', 'ussd' — the method, never a card number. */
  channel: string | null;
  initializedAt: string | null;
  paidAt: string | null;
  failureReason: string | null;
  bookingId: string;
  trackingId: string;
  parcelStatus: string;
  parcelPaymentStatus: string;
  originCity: string;
  destinationCity: string;
  senderId: string;
  senderName: string;
  refundOwed: boolean;

  /**
   * How the fare divides, in naira.
   *
   * ⚠ `splitIsActual` is not decoration — read it before showing these.
   *
   *   A parcel's commission is computed at delivery, from the rate in force
   *   then, and stored on the earning row. At payment time there is no driver
   *   and no earning, so an undelivered parcel's split is a projection at
   *   today's rate: true enough to plan with, and a number that will change if
   *   the rate changes. The screen labels it rather than showing a forecast
   *   that reads like a liability.
   *
   * ⚠ `fare` is `estimated_fee`, which can differ from `amount`.
   *
   *   Settlement refuses an underpayment and accepts an overpayment. The
   *   driver's share is computed from the fare, so that is what these describe;
   *   `amount` is what the card was actually debited.
   */
  fare: number;
  commission: number;
  driverShare: number;
  commissionRate: number;
  splitIsActual: boolean;
};

export async function fetchPaymentTotals(range?: DateRange): Promise<PaymentTotals> {
  const { data, error } = await supabase.rpc('admin_payment_totals', {
    p_from: iso(range?.from ?? null),
    p_to: iso(range?.to ?? null),
  });
  if (error || !data) return EMPTY_TOTALS;

  const row = (data as Record<string, unknown>[])[0];
  if (!row) return EMPTY_TOTALS;

  return {
    collected: num(row.collected_kobo) / 100,
    collectedLast7Days: num(row.collected_7d_kobo) / 100,
    succeeded: num(row.payments_succeeded),
    pending: num(row.payments_pending),
    failed: num(row.payments_failed),
    parcelsAwaitingPayment: num(row.parcels_awaiting_payment),
    refundsOwed: num(row.refunds_owed),
  };
}

export async function fetchPayments(
  status: PaymentStatusFilter = 'all',
  query = '',
  range?: DateRange,
): Promise<PaymentRow[]> {
  const { data, error } = await supabase.rpc('admin_payments_ledger', {
    p_status: status === 'all' ? null : status,
    p_query: query.trim() || null,
    p_from: iso(range?.from ?? null),
    p_to: iso(range?.to ?? null),
    /*
      Higher than the screen shows, because this list is also what the CSV
      exports. A limit tuned for reading turns an export into a silently
      truncated one, which is the worst possible failure for a reconciliation
      file — it balances, against the wrong total.
    */
    p_limit: 1000,
  });
  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    id: text(row.id),
    reference: text(row.reference),
    gatewayReference: maybeText(row.gateway_reference),
    provider: text(row.provider),
    amount: num(row.amount_kobo) / 100,
    currency: text(row.currency) || 'NGN',
    status: text(row.status),
    channel: maybeText(row.channel),
    initializedAt: maybeText(row.initialized_at),
    paidAt: maybeText(row.paid_at),
    failureReason: maybeText(row.failure_reason),
    bookingId: text(row.booking_id),
    trackingId: text(row.tracking_id),
    parcelStatus: text(row.parcel_status),
    parcelPaymentStatus: text(row.parcel_payment_status),
    originCity: text(row.origin_city),
    destinationCity: text(row.destination_city),
    senderId: text(row.sender_id),
    senderName: text(row.sender_name),
    refundOwed: row.refund_owed === true,
    fare: num(row.fare),
    commission: num(row.commission),
    driverShare: num(row.driver_share),
    commissionRate: num(row.commission_rate),
    splitIsActual: row.split_is_actual === true,
  }));
}

// ---------------------------------------------------------------- outbound --

/**
 * Where a driver stands.
 *
 *   pending  they have asked to be paid and nobody has made the transfer yet
 *   ready    no request, and their balance has cleared the hold and the minimum
 *   holding  owed something, but it is too new or too small to withdraw
 *   paid     everything they have earned has been paid out
 *
 * ⚠ 'ready' is the one with no row behind it anywhere.
 *
 *   `payout_requests` records money a driver has *asked* for. A driver sitting
 *   on a withdrawable balance who has not asked has no row at all — so a screen
 *   built on that table alone would be empty on the day the platform owes the
 *   most. The state is derived in SQL for that reason.
 */
export type PayoutState = 'pending' | 'ready' | 'holding' | 'paid';

export const PAYOUT_STATE_LABELS: Record<PayoutState, string> = {
  pending: 'Pending',
  ready: 'Ready',
  holding: 'Holding',
  paid: 'Paid',
};

export type DriverPayoutRow = {
  driverId: string;
  driverName: string;
  deliveries: number;
  /** Naira throughout — 30 stores driver money as naira, not kobo. */
  gross: number;
  commission: number;
  netEarned: number;
  paidOut: number;
  onHold: number;
  available: number;
  state: PayoutState;
  openRequestId: string | null;
  openRequestAmount: number | null;
  openRequestedAt: string | null;
  openBankName: string | null;
  /** Last four digits. The full number is `revealPayoutAccount`. */
  openAccountHint: string | null;
  openAccountName: string | null;
  lastPaidAt: string | null;
  drivingBanned: boolean;
};

export async function fetchDriverPayouts(
  state: PayoutState | 'all' = 'all',
): Promise<DriverPayoutRow[]> {
  const { data, error } = await supabase.rpc('admin_payout_ledger', {
    p_state: state === 'all' ? null : state,
    p_limit: 200,
  });
  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    driverId: text(row.driver_id),
    driverName: text(row.driver_name),
    deliveries: num(row.deliveries),
    gross: num(row.gross),
    commission: num(row.commission),
    netEarned: num(row.net_earned),
    paidOut: num(row.paid_out),
    onHold: num(row.on_hold),
    available: num(row.available),
    state: (text(row.state) || 'holding') as PayoutState,
    openRequestId: maybeText(row.open_request_id),
    openRequestAmount: row.open_request_amount == null ? null : num(row.open_request_amount),
    openRequestedAt: maybeText(row.open_requested_at),
    openBankName: maybeText(row.open_bank_name),
    openAccountHint: maybeText(row.open_account_hint),
    openAccountName: maybeText(row.open_account_name),
    lastPaidAt: maybeText(row.last_paid_at),
    drivingBanned: row.driving_banned === true,
  }));
}

export type DriverLedgerEntry = {
  kind: 'earning' | 'payout';
  happenedAt: string | null;
  amount: number;
  label: string;
  status: string;
  reference: string;
};

export async function fetchDriverLedger(driverId: string): Promise<DriverLedgerEntry[]> {
  const { data, error } = await supabase.rpc('admin_driver_ledger', {
    p_driver: driverId,
    p_limit: 50,
  });
  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    kind: text(row.kind) === 'payout' ? 'payout' : 'earning',
    happenedAt: maybeText(row.happened_at),
    amount: num(row.amount),
    label: text(row.label),
    status: text(row.status),
    reference: text(row.reference),
  }));
}

export type PayoutAccount = {
  bankName: string;
  accountNumber: string;
  accountName: string;
  amount: number;
};

/**
 * The account to transfer to — and a line in the audit log naming who asked.
 *
 * Deliberately a second call, exactly as `revealParcelContacts` is. The list
 * shows four digits; the full number is needed once, by the person actually
 * making the payment, and that moment is worth recording.
 */
export async function revealPayoutAccount(
  requestId: string,
  reason?: string,
): Promise<PayoutAccount | null> {
  const { data, error } = await supabase.rpc('admin_reveal_payout_account', {
    request_id: requestId,
    reason: reason?.trim() || null,
  });
  if (error || !data) return null;

  const row = (data as Record<string, unknown>[])[0];
  if (!row) return null;

  return {
    bankName: text(row.bank_name),
    accountNumber: text(row.account_number),
    accountName: text(row.account_name),
    amount: num(row.amount),
  };
}

/**
 * Records that a human made the transfer. It does not make one.
 *
 * ⚠ The reference is required by this app, not by the database.
 *
 *   `settle_payout` takes the note as optional and stores it as `reference`.
 *   A settled payout with nothing recorded is one nobody can match against a
 *   bank statement six weeks later when a driver says the money never arrived,
 *   so the dialog insists. Marking one failed takes a reason for the same
 *   reason, and that one the driver can be told.
 */
export async function settlePayout(
  requestId: string,
  outcome: 'paid' | 'failed',
  note: string,
): Promise<void> {
  const { error } = await supabase.rpc('settle_payout', {
    request_id: requestId,
    outcome,
    note: note.trim(),
  });
  if (error) throw error;
}

// --------------------------------------------------- the outbound timeline --

/**
 * Every earning and payout in a window, across all drivers.
 *
 * ⚠ This is what the date range drives on the Outbound tab, and the balances
 *   above it are deliberately left alone.
 *
 *   "Available in March" is not a quantity — a balance is what a driver could
 *   withdraw *today*. Recomputing one over a window produces a number that
 *   looks authoritative, means nothing, and is the one somebody would pay
 *   against. The transactions are the thing a date range can honestly filter,
 *   and the thing reconciliation actually wants.
 */
export type FinanceTransaction = {
  kind: 'earning' | 'payout';
  happenedAt: string | null;
  driverId: string;
  driverName: string;
  /** Signed: positive for an earning owed, negative for a payout sent. */
  amount: number;
  gross: number;
  commission: number;
  status: string;
  reference: string;
  trackingId: string;
};

export async function fetchFinanceTransactions(range?: DateRange): Promise<FinanceTransaction[]> {
  const { data, error } = await supabase.rpc('admin_finance_transactions', {
    p_from: iso(range?.from ?? null),
    p_to: iso(range?.to ?? null),
    p_limit: 5000,
  });
  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    kind: text(row.kind) === 'payout' ? 'payout' : 'earning',
    happenedAt: maybeText(row.happened_at),
    driverId: text(row.driver_id),
    driverName: text(row.driver_name),
    amount: num(row.amount),
    gross: num(row.gross),
    commission: num(row.commission),
    status: text(row.status),
    reference: text(row.reference),
    trackingId: text(row.tracking_id),
  }));
}

// -------------------------------------------------------- the manual sync --

/**
 * Asks Paystack again about a charge, on the sender's behalf.
 *
 * ⚠ The same `payments-verify` the sender's own checkout calls, not a new door.
 *
 *   That function was already the thing that re-asks the provider and settles
 *   through the idempotent RPC; 60 widens only *whose* reference a caller may
 *   name, and only for an admin, and logs it. Writing a second endpoint would
 *   have meant a second amount comparison, a second cancelled-parcel branch and
 *   a second chance for the two to disagree about what "settled" means.
 *
 * What this is for: a webhook Paystack sent and we missed — a deploy in flight,
 * a cold function, a key mid-rotation. The charge succeeded at the gateway and
 * the parcel is sitting unpaid and invisible to drivers, with the sender's own
 * retry window long gone.
 */
export async function syncPaymentWithGateway(reference: string): Promise<VerifyOutcome> {
  return verifyParcelPayment(reference);
}

// ------------------------------------------------------------- the exports --

/*
 * ⚠ Column sets, not a generic exporter.
 *
 *   A CSV whose columns are whatever the screen happened to render is one whose
 *   headers change when somebody reorders a card. These are the two shapes an
 *   accountant reconciles against, written down, and `verify:finance` asserts
 *   the amounts in them are bare numbers rather than "₦2,800.00" — a currency
 *   column formatted for reading is a column that does not add up.
 */

export const PAYMENT_CSV_COLUMNS: readonly CsvColumn<PaymentRow>[] = [
  { header: 'Paid at', value: (row) => row.paidAt ?? '' },
  { header: 'Initialized at', value: (row) => row.initializedAt ?? '' },
  { header: 'Reference', value: (row) => row.reference },
  { header: 'Gateway reference', value: (row) => row.gatewayReference ?? '' },
  { header: 'Status', value: (row) => row.status },
  { header: 'Method', value: (row) => row.channel ?? '' },
  { header: 'Amount (NGN)', value: (row) => row.amount },
  { header: 'Fare (NGN)', value: (row) => row.fare },
  { header: 'Platform commission (NGN)', value: (row) => row.commission },
  { header: 'Driver share (NGN)', value: (row) => row.driverShare },
  { header: 'Commission rate', value: (row) => row.commissionRate },
  /*
    Spelt out rather than a boolean, because this is the column that decides
    whether the two before it are facts. "TRUE"/"FALSE" in a spreadsheet is
    read past; "projected at current rate" is not.
  */
  {
    header: 'Split basis',
    value: (row) => (row.splitIsActual ? 'recorded at delivery' : 'projected at current rate'),
  },
  { header: 'Tracking ID', value: (row) => row.trackingId },
  { header: 'Parcel status', value: (row) => row.parcelStatus },
  { header: 'Route', value: (row) => `${row.originCity} to ${row.destinationCity}` },
  { header: 'Sender', value: (row) => row.senderName },
  { header: 'Refund owed', value: (row) => (row.refundOwed ? 'yes' : 'no') },
];

export const TRANSACTION_CSV_COLUMNS: readonly CsvColumn<FinanceTransaction>[] = [
  { header: 'Date', value: (row) => row.happenedAt ?? '' },
  { header: 'Type', value: (row) => row.kind },
  { header: 'Driver', value: (row) => row.driverName },
  { header: 'Amount (NGN)', value: (row) => row.amount },
  { header: 'Fare (NGN)', value: (row) => row.gross },
  { header: 'Platform commission (NGN)', value: (row) => row.commission },
  { header: 'Status', value: (row) => row.status },
  { header: 'Reference', value: (row) => row.reference },
  { header: 'Tracking ID', value: (row) => row.trackingId },
];
