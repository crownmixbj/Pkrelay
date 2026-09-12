import type { RealtimeChannel } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

/**
 * The in-app notification inbox.
 *
 * Reads `public.notifications` (`supabase/migrations/20250101000049_notifications.sql`),
 * which is the same table the push notifications are sent from — so what a
 * driver sees in the app and what buzzed their phone are one row, not two
 * systems that can disagree about what happened.
 *
 * ⚠ Nothing here writes a notification, and nothing should.
 *
 *   The table has no insert policy at all: every row is written by a
 *   `security definer` trigger in 50. A client that could insert could write
 *   itself "You have been paid" — and, worse, make the platform push it.
 *   Marking something read is the only write a client gets, and it goes through
 *   `mark_notification_read`, which touches `read_at` and nothing else.
 *
 * ⚠ Not to be confused with `@/store/notifications.tsx`.
 *
 *   That is a dead in-memory email/SMS outbox from before the server existed.
 *   Its provider is still mounted in `app/_layout.tsx` but `useNotifications`
 *   is called by nothing. It is superseded by `email_outbox` in 38 and should
 *   go; this file is not it.
 */

/** Mirrors the `kind` check constraint in 49. Keep the two in step. */
export type NotificationKind =
  // onboarding and account verification
  | 'email_confirmation_pending'
  | 'email_confirmed'
  | 'application_submitted'
  | 'application_under_review'
  | 'application_approved'
  | 'application_rejected'
  | 'guarantor_pending'
  | 'guarantor_completed'
  | 'document_expiring'
  | 'document_expired'
  | 'document_rejected'
  | 'identity_verified'
  | 'identity_rejected'
  // job matching and dispatch
  | 'offer_received'
  | 'offer_expiring'
  | 'offer_expired'
  | 'job_assigned'
  // pickup and transit
  | 'pickup_reminder'
  | 'parcel_status_changed'
  | 'job_cancelled'
  | 'message_received'
  // completion and payouts
  | 'delivery_completed'
  | 'earning_recorded'
  | 'payout_requested'
  | 'payout_paid'
  | 'payout_failed'
  // sender side
  | 'parcel_booked'
  | 'parcel_cancelled'
  | 'sender_verification_submitted'
  | 'sender_verified'
  | 'sender_rejected';

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  /** Null while unread. The timestamp is when it was first opened. */
  readAt: string | null;
  createdAt: string;
};

/**
 * How many the inbox holds.
 *
 * ⚠ The badge counts unread rows *in this page*, not a separate query.
 *
 *   `unread_notification_count()` exists in 49 and is deliberately not used
 *   here. Two sources for one number is how a badge says 3 above a list showing
 *   2 — the classic notification bug, and the one people screenshot. Derived
 *   from what is actually loaded, they cannot disagree. Past this cap the badge
 *   says "50+", which is honest; the RPC is what to reach for when this grows a
 *   "load older" button.
 */
export const INBOX_PAGE_SIZE = 50;

type Row = {
  id: string;
  kind: string;
  title: string;
  body: string;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
};

const SELECT = 'id, kind, title, body, metadata, read_at, created_at';

function rowToNotification(row: Row): AppNotification {
  return {
    id: String(row.id),
    kind: row.kind as NotificationKind,
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    metadata: row.metadata ?? {},
    readAt: row.read_at,
    createdAt: String(row.created_at),
  };
}

/**
 * The newest page of this account's notifications.
 *
 * No `user_id` filter: the select policy already scopes the table to
 * `auth.uid()`, and unlike `payout_requests` there is no admin branch in that
 * policy for an extra row to arrive through.
 */
export async function fetchNotifications(limit = INBOX_PAGE_SIZE): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select(SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return (data as Row[]).map(rowToNotification);
}

export type InboxEvent =
  | { type: 'insert'; notification: AppNotification }
  | { type: 'update'; notification: AppNotification }
  /**
   * The channel (re)connected.
   *
   * ⚠ This is the event that makes the inbox correct rather than
   *   approximately correct.
   *
   *   A phone that was asleep, changed network, or sat in the background misses
   *   every INSERT while the socket is down, and Realtime does not replay them.
   *   Without a refetch on resubscribe, the driver's inbox is silently missing
   *   exactly the notifications that arrived while they were not looking —
   *   which is all of the ones that matter.
   */
  | { type: 'resubscribed' };

/**
 * Watches this account's rows.
 *
 * ⚠ The `filter` below is a convenience, not a boundary.
 *
 *   Realtime evaluates the select policy per subscriber, so the RLS policy is
 *   what stops one driver seeing another's inbox. The filter just spares the
 *   server sending rows this client would discard.
 */
export function subscribeToNotifications(
  userId: string,
  onEvent: (event: InboxEvent) => void,
): () => void {
  const channel: RealtimeChannel = supabase
    .channel(`notifications:${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      (payload) => {
        const row = payload.new as Row | null;
        if (row && row.id) onEvent({ type: 'insert', notification: rowToNotification(row) });
      },
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      (payload) => {
        /*
         * UPDATE matters because the same account can be signed in on two
         * devices. Reading something on the phone should clear the badge on the
         * tablet rather than leaving it showing a notification already dealt
         * with.
         */
        const row = payload.new as Row | null;
        if (row && row.id) onEvent({ type: 'update', notification: rowToNotification(row) });
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onEvent({ type: 'resubscribed' });
    });

  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Marks one read. Idempotent server-side — `read_at` keeps its first value. */
export async function markRead(id: string): Promise<boolean> {
  const { error } = await supabase.rpc('mark_notification_read', { p_id: id });
  return !error;
}

/** Marks everything read and returns how many changed, or null on failure. */
export async function markAllRead(): Promise<number | null> {
  const { data, error } = await supabase.rpc('mark_all_notifications_read');
  if (error) return null;
  return Number(data ?? 0);
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 *
 * Separated from the components so the wording and routing a driver
 * actually depends on can be tested without rendering a screen — the
 * same split `wallet.ts` uses for `payoutStatusLine`.
 * ------------------------------------------------------------------ */

/**
 * Where tapping a notification goes.
 *
 * ⚠ This is the single mapping, used by both the list and the push-tap router.
 *
 *   `notify-push/message.ts` also puts a `route` hint in the Expo payload, and
 *   for a while both decided destinations. Two mappings for one question drift:
 *   the push would open the wallet while the same row in the inbox opened the
 *   parcel. The hint is still sent — it costs nothing and a future web push
 *   client may want it — but nothing in this app reads it.
 *
 * A notification whose target no longer exists routes to the inbox rather than
 * to a screen that will say "not found". `notification-router.tsx` explains the
 * same reasoning for offers.
 */
export function routeFor(notification: Pick<AppNotification, 'kind' | 'metadata'>): string {
  const bookingId = notification.metadata?.booking_id;

  switch (notification.kind) {
    case 'offer_received':
    case 'offer_expiring':
    case 'offer_expired':
    case 'job_assigned':
    case 'pickup_reminder':
    case 'job_cancelled':
      /*
       * Assigned Trip, not the parcel detail. By the time somebody taps, the
       * job may have gone to another driver, and landing on "not yours" is
       * worse than landing on the screen that shows what is actually waiting.
       */
      return '/driver';

    case 'parcel_status_changed':
    case 'delivery_completed':
    case 'parcel_cancelled':
    case 'parcel_booked':
    case 'message_received':
      return typeof bookingId === 'string' && bookingId ? `/parcel/${bookingId}` : '/my-packages';

    case 'earning_recorded':
    case 'payout_requested':
    case 'payout_paid':
    case 'payout_failed':
      return '/driver-wallet';

    default:
      /* Everything onboarding-shaped: applications, documents, identity. */
      return '/driver-updates';
  }
}

export type NotificationTone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

/**
 * The colour a notification carries.
 *
 * ⚠ Tone follows consequence, not category.
 *
 *   A cancelled job and a completed delivery are both "job lifecycle" and must
 *   not look alike — one means stop driving, the other means well done. Danger
 *   is spent only on things that cost the person something.
 */
export function toneFor(kind: NotificationKind): NotificationTone {
  switch (kind) {
    case 'application_approved':
    case 'delivery_completed':
    case 'payout_paid':
    case 'earning_recorded':
    case 'sender_verified':
    case 'identity_verified':
    case 'guarantor_completed':
    case 'email_confirmed':
      return 'success';

    case 'application_rejected':
    case 'sender_rejected':
    case 'identity_rejected':
    case 'document_rejected':
    case 'document_expired':
    case 'payout_failed':
    case 'job_cancelled':
    case 'parcel_cancelled':
      return 'danger';

    case 'pickup_reminder':
    case 'document_expiring':
    case 'offer_expiring':
    case 'email_confirmation_pending':
    case 'guarantor_pending':
      return 'warning';

    case 'offer_received':
    case 'job_assigned':
    case 'message_received':
      return 'primary';

    default:
      return 'neutral';
  }
}

/**
 * "Just now", "12 min ago", "Yesterday", "3 Sep".
 *
 * `now` is injected so the output is testable rather than dependent on when the
 * suite happens to run.
 *
 * ⚠ A future timestamp reads as "Just now" rather than "in 3 minutes".
 *
 *   Device clocks drift, and `created_at` is the server's. A phone a minute
 *   fast would otherwise render every arriving notification as a scheduled
 *   event, which is both wrong and unsettling.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';

  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 60) return 'Just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;

  const date = new Date(then);
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** What the badge shows. Caps rather than lying about a number it cannot see. */
export function badgeLabel(unread: number, pageSize = INBOX_PAGE_SIZE): string {
  if (unread <= 0) return '';
  return unread >= pageSize ? `${pageSize}+` : String(unread);
}

/**
 * Merges a realtime row into the list.
 *
 * ⚠ Deduplicates by id, and that is not defensive coding.
 *
 *   A refetch triggered by `resubscribed` races the INSERT events that arrive
 *   immediately after it, so the same row genuinely arrives twice on a normal
 *   reconnect. Appending blindly shows the driver two identical offers.
 *
 * Newest first, matching the query's order, so an arriving notification lands
 * at the top where it is looked for.
 */
export function mergeNotification(
  list: AppNotification[],
  incoming: AppNotification,
): AppNotification[] {
  const without = list.filter((item) => item.id !== incoming.id);
  const merged = [incoming, ...without];
  merged.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return merged.slice(0, INBOX_PAGE_SIZE);
}

export function unreadCount(list: AppNotification[]): number {
  return list.reduce((total, item) => total + (item.readAt ? 0 : 1), 0);
}
