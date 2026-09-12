/**
 * Turning a `notifications` row into an Expo message.
 *
 * ⚠ The title and body are NOT written here. They are read from the row.
 *
 *   The database wrote them at trigger time, which is what makes the push and
 *   the inbox entry say the same thing — and what stops an old notification
 *   silently rewriting itself after the next release. This file decides only
 *   how the message is *delivered*: which Android channel, how loudly, how long
 *   it stays worth showing, and what the tap resolves to.
 *
 * No Deno globals, so this can be bundled and tested under node.
 */

import type { ExpoMessage } from '../_shared/expo-push.ts';

export type NotificationRow = {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
};

/**
 * Android notification channels.
 *
 * ⚠ Four channels, not one, and this is the whole reason to care.
 *
 *   Android 8+ lets a person mute a *channel*. With everything on one channel,
 *   a driver who mutes the app to stop payout chatter also stops hearing about
 *   work — and neither they nor you can tell that happened. Splitting these
 *   means "stop telling me about my wallet" is a thing they can actually
 *   express.
 *
 *   These names must exist on the client too: `setNotificationChannelAsync` in
 *   the app has to declare the same four ids, or Android quietly files the
 *   message under a default channel and the split does nothing.
 */
export const CHANNELS = {
  dispatch: 'dispatch',
  delivery: 'delivery',
  wallet: 'wallet',
  account: 'account',
} as const;

type Delivery = {
  channelId: string;
  priority: 'high' | 'normal';
  interruptionLevel: 'timeSensitive' | 'active' | 'passive';
  /** Seconds. After this Expo stops trying, because it has stopped mattering. */
  ttl: number;
  /** Where the app should go when tapped. */
  route: string;
};

const HOUR = 3600;
const DAY = 24 * HOUR;

/*
 * ⚠ `timeSensitive` is spent carefully.
 *
 *   It is the one iOS level that breaks through Focus and scheduled summaries.
 *   Used for everything it stops meaning anything, and Apple's review notes say
 *   so. Here it is reserved for the three things a driver is losing money or
 *   wasting a journey by not seeing now: a job assigned, a job cancelled, and a
 *   pickup that has not happened.
 *
 *   A ttl shorter than a day is the same idea: a "parcel picked up" notice that
 *   arrives tomorrow morning is noise, so it expires instead.
 */
const DELIVERY: Record<string, Delivery> = {
  // --- 2. dispatch -------------------------------------------------------
  offer_received: { channelId: CHANNELS.dispatch, priority: 'high', interruptionLevel: 'timeSensitive', ttl: 10 * 60, route: 'offer' },
  offer_expiring: { channelId: CHANNELS.dispatch, priority: 'high', interruptionLevel: 'timeSensitive', ttl: 5 * 60, route: 'offer' },
  offer_expired:  { channelId: CHANNELS.dispatch, priority: 'normal', interruptionLevel: 'passive', ttl: HOUR, route: 'jobs' },
  job_assigned:   { channelId: CHANNELS.dispatch, priority: 'high', interruptionLevel: 'timeSensitive', ttl: 6 * HOUR, route: 'job' },

  // --- 3. pickup and transit ---------------------------------------------
  pickup_reminder:       { channelId: CHANNELS.dispatch, priority: 'high', interruptionLevel: 'timeSensitive', ttl: 2 * HOUR, route: 'job' },
  job_cancelled:         { channelId: CHANNELS.dispatch, priority: 'high', interruptionLevel: 'timeSensitive', ttl: 6 * HOUR, route: 'jobs' },
  parcel_status_changed: { channelId: CHANNELS.delivery, priority: 'normal', interruptionLevel: 'active', ttl: 12 * HOUR, route: 'parcel' },
  message_received:      { channelId: CHANNELS.delivery, priority: 'high', interruptionLevel: 'active', ttl: DAY, route: 'parcel' },

  // --- 4. completion and payouts -----------------------------------------
  delivery_completed: { channelId: CHANNELS.delivery, priority: 'normal', interruptionLevel: 'active', ttl: DAY, route: 'parcel' },
  parcel_cancelled:   { channelId: CHANNELS.delivery, priority: 'high', interruptionLevel: 'active', ttl: DAY, route: 'parcel' },
  earning_recorded:   { channelId: CHANNELS.wallet, priority: 'normal', interruptionLevel: 'passive', ttl: DAY, route: 'wallet' },
  payout_requested:   { channelId: CHANNELS.wallet, priority: 'normal', interruptionLevel: 'passive', ttl: DAY, route: 'wallet' },
  payout_paid:        { channelId: CHANNELS.wallet, priority: 'normal', interruptionLevel: 'active', ttl: 3 * DAY, route: 'wallet' },
  payout_failed:      { channelId: CHANNELS.wallet, priority: 'high', interruptionLevel: 'active', ttl: 3 * DAY, route: 'wallet' },

  // --- 1. onboarding ------------------------------------------------------
  application_approved:       { channelId: CHANNELS.account, priority: 'high', interruptionLevel: 'active', ttl: 7 * DAY, route: 'account' },
  application_rejected:       { channelId: CHANNELS.account, priority: 'normal', interruptionLevel: 'active', ttl: 7 * DAY, route: 'account' },
  application_under_review:   { channelId: CHANNELS.account, priority: 'normal', interruptionLevel: 'passive', ttl: 3 * DAY, route: 'account' },
  email_confirmation_pending: { channelId: CHANNELS.account, priority: 'normal', interruptionLevel: 'active', ttl: 3 * DAY, route: 'account' },
  sender_verified:            { channelId: CHANNELS.account, priority: 'normal', interruptionLevel: 'active', ttl: 3 * DAY, route: 'account' },
  sender_rejected:            { channelId: CHANNELS.account, priority: 'high', interruptionLevel: 'active', ttl: 7 * DAY, route: 'account' },
};

/*
 * ⚠ An unknown kind is delivered quietly rather than dropped.
 *
 *   A kind added to the database's check constraint but not to this table would
 *   otherwise stop reaching phones with no error anywhere — the class of bug
 *   that gets found by a driver complaint months later. A dull notification is
 *   a visible bug; a missing one is not.
 */
const FALLBACK: Delivery = {
  channelId: CHANNELS.account,
  priority: 'normal',
  interruptionLevel: 'active',
  ttl: DAY,
  route: 'inbox',
};

export function deliveryFor(kind: string): Delivery {
  return DELIVERY[kind] ?? FALLBACK;
}

/** Only ids and short scalars survive into `data` — see the note in 49. */
const ALLOWED_DATA_KEYS = [
  'booking_id',
  'offer_id',
  'payout_id',
  'application_id',
  'tracking_id',
  'status',
  'expires_at',
];

export function buildMessage(token: string, row: NotificationRow): ExpoMessage {
  const delivery = deliveryFor(row.kind);

  const data: Record<string, string> = {
    notificationId: row.id,
    kind: row.kind,
    route: delivery.route,
  };

  /*
   * ⚠ Allow-listed, not copied wholesale.
   *
   *   `metadata` is a jsonb column, so a future trigger can put anything in it.
   *   This payload goes to Expo — a third party — and renders on a lock screen.
   *   An allow-list means adding a sender's phone number to the metadata for
   *   the tracking screen cannot silently ship it to Expo as well.
   */
  for (const key of ALLOWED_DATA_KEYS) {
    const value = row.metadata?.[key];
    if (value !== undefined && value !== null && typeof value !== 'object') {
      data[key] = String(value);
    }
  }

  return {
    to: token,
    title: row.title,
    body: row.body,
    data,
    sound: 'default',
    channelId: delivery.channelId,
    priority: delivery.priority,
    interruptionLevel: delivery.interruptionLevel,
    ttl: delivery.ttl,
  };
}
