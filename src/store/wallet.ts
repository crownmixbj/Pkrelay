import { supabase } from '@/lib/supabase';

/**
 * The driver's money.
 *
 * ⚠ Every figure here comes from `public.driver_earnings` and
 *   `public.payout_requests` (`supabase/migrations/20250101000030_driver_wallet.sql`) — a real ledger,
 *   not a sum of quoted fares. That distinction is the reason this module
 *   exists: `earnings.ts` deliberately labels its totals "Expected" because it
 *   has no ledger behind it. This one does, so it may say "balance".
 *
 * ⚠ What it still cannot say is that money *moved*. Nothing in Package Relay talks to a
 *   bank. A payout marked `paid` means a person recorded making a transfer.
 */

export type Balance = {
  /** Every net earning, ever. */
  earned: number;
  /** Requested or paid — money that has left or is about to. */
  paidOut: number;
  /** Earned too recently to withdraw yet. */
  onHold: number;
  /** What a payout can be requested against. Never negative. */
  available: number;
};

export const EMPTY_BALANCE: Balance = { earned: 0, paidOut: 0, onHold: 0, available: 0 };

export async function fetchBalance(): Promise<Balance> {
  const { data, error } = await supabase.rpc('driver_balance');

  if (error || !data) return EMPTY_BALANCE;

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) return EMPTY_BALANCE;

  return {
    earned: Number(row.earned ?? 0),
    paidOut: Number(row.paid_out ?? 0),
    onHold: Number(row.on_hold ?? 0),
    available: Number(row.available ?? 0),
  };
}

export type WalletEntry = {
  kind: 'earning' | 'payout';
  /** Positive for an earning, negative for a payout. */
  amount: number;
  label: string;
  status: string;
  happenedAt: string;
};

export async function fetchActivity(limit = 40): Promise<WalletEntry[]> {
  const { data, error } = await supabase.rpc('my_wallet_activity', { limit_rows: limit });

  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    kind: row.kind === 'payout' ? 'payout' : 'earning',
    amount: Number(row.amount ?? 0),
    label: String(row.label ?? ''),
    status: String(row.status ?? ''),
    happenedAt: String(row.happened_at),
  }));
}

export type OpenPayout = {
  id: string;
  amount: number;
  requestedAt: string;
};

/**
 * The one unsettled request, if there is one. At most one can exist.
 *
 * ⚠ Filtered by `driver_id` even though RLS already scopes the table.
 *
 *   It does not scope it to *one row* for an admin: `read own payouts` also
 *   admits `is_admin()`, so an admin who drives would match every open request
 *   on the platform and `maybeSingle` would throw. Relying on the policy to do
 *   the filtering works right up until the person looking is staff.
 */
export async function fetchOpenPayout(): Promise<OpenPayout | null> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from('payout_requests')
    .select('id, amount, requested_at')
    .eq('driver_id', userId)
    .eq('status', 'requested')
    .maybeSingle();

  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    amount: Number(row.amount ?? 0),
    requestedAt: String(row.requested_at),
  };
}

export type PayoutOutcome = { ok: true; id: string } | { ok: false; error: string };

/**
 * Asks to be paid.
 *
 * `amount` omitted means the whole available balance, which is what the button
 * does. The server checks the amount against `available` again — the client
 * copy of the balance is a render, not an authority, and it can be seconds
 * stale by the time somebody taps.
 *
 * ⚠ Server messages pass through verbatim. "You can withdraw up to ₦6,000",
 *   "The smallest payout is ₦1,000", "You already have a payout waiting" — each
 *   names the thing to do next, which a generic failure would throw away.
 */
export async function requestPayout(amount?: number): Promise<PayoutOutcome> {
  const { data, error } = await supabase.rpc('request_payout', {
    amount: amount ?? null,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, id: String(data) };
}

export async function cancelPayout(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc('cancel_payout_request', { request_id: id });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/*
 * ⚠ There is deliberately no `fetchPayoutAccount` here.
 *
 *   An earlier draft had one, reading `active_payout_account` so the wallet
 *   could render its own "Payout method" panel. It was dead within the hour and
 *   it was the same mistake the screens had: `payout-account.tsx` already owns
 *   the account, including the 48-hour cooling window that is the only control
 *   stopping a hijacked session redirecting the next payout.
 *
 *   A second reader is how a second writer arrives. Anything about the bank
 *   account goes through that component.
 */

export type WalletSettings = {
  /** How long after delivery an earning becomes withdrawable. */
  holdHours: number;
  /** The smallest payout worth making. */
  minimum: number;
};

/**
 * The two numbers the screen has to say out loud.
 *
 * ⚠ Fetched, not hard-coded, and this is the whole reason the pair exists as a
 *   type rather than as two constants.
 *
 *   Both live in `private.app_settings` and are meant to be changed without a
 *   release — that is the point of putting them there. A client constant would
 *   be right on the day it was written and silently wrong the first time
 *   someone raised the minimum, and the failure is a screen confidently telling
 *   a driver they need ₦1,000 while the server refuses under ₦2,000.
 *
 * The fallbacks below match the SQL defaults and are only reached when both
 * calls fail. They are a last resort for a screen that must still render a
 * sentence, not a second source of truth.
 */
export const DEFAULT_SETTINGS: WalletSettings = { holdHours: 24, minimum: 1000 };

export async function fetchWalletSettings(): Promise<WalletSettings> {
  const [hold, minimum] = await Promise.all([
    supabase.rpc('payout_hold_hours'),
    supabase.rpc('minimum_payout'),
  ]);

  return {
    holdHours: hold.error ? DEFAULT_SETTINGS.holdHours : Number(hold.data),
    minimum: minimum.error ? DEFAULT_SETTINGS.minimum : Number(minimum.data),
  };
}

// ------------------------------------------------------------- formatting --

export const naira = (amount: number): string => `₦${Math.round(amount).toLocaleString('en-NG')}`;

/**
 * What the payout schedule line says.
 *
 * Pure, so the sentence a driver reads about their own money is tested rather
 * than eyeballed. Every branch is a different reason they cannot withdraw, and
 * "Request payout" being greyed out with no explanation is the failure this
 * function exists to prevent.
 */
export function payoutStatusLine(
  balance: Balance,
  open: OpenPayout | null,
  holdHours: number,
  minimum: number,
): string {
  if (open) {
    return `${naira(open.amount)} is being processed. Package Relay transfers it to your account manually — you will see it here when it is done.`;
  }

  if (balance.onHold > 0 && balance.available <= 0) {
    return `${naira(balance.onHold)} is on a ${holdHours}-hour security hold. It becomes available once the delivery window has passed.`;
  }

  if (balance.available > 0 && balance.available < minimum) {
    return `You have ${naira(balance.available)}. The smallest payout is ${naira(minimum)}.`;
  }

  if (balance.available <= 0) {
    return 'Deliver a parcel and your earnings appear here.';
  }

  return balance.onHold > 0
    ? `${naira(balance.available)} ready now. ${naira(balance.onHold)} is still on a ${holdHours}-hour hold.`
    : `${naira(balance.available)} ready to withdraw.`;
}

/** Whether the button should do anything, and why not when it should not. */
export function canRequest(balance: Balance, open: OpenPayout | null, minimum: number): boolean {
  return !open && balance.available >= minimum && balance.available > 0;
}
