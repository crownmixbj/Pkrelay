/**
 * Talking to the Expo push service, and reading what it says back.
 *
 * No Deno globals, so it can be bundled and tested under node — the same shape
 * as `verify-liveness/dojah.ts`.
 *
 * ⚠ An Expo push token is a bearer credential. Anyone holding one can send a
 *   notification to that device with no key of their own. That is why
 *   `push_tokens` is readable only by its owner, and why nothing here logs a
 *   token.
 */

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** How many messages Expo accepts in one request. */
export const EXPO_BATCH_SIZE = 100;

export type OfferPayload = {
  /** The offer being announced — not the parcel. See `data` in buildMessage. */
  offerId: string;
  bookingId: string;
  originCity: string;
  destinationCity: string;
  weight: number;
  fee: number;
  isLocal: boolean;
  expiresAt: string;
};

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound: 'default';
  /**
   * Android channel. Without one, Android 8+ drops the notification into a
   * default channel the user cannot tune separately — and a driver who mutes
   * Package Relay to stop marketing would also stop hearing about work.
   */
  channelId: string;
  priority: 'high';
  /** iOS 15+ delivery prominence. Ignored by Android and by older iOS. */
  interruptionLevel: 'timeSensitive';
  /**
   * Expires with the offer. A notification that arrives after the hold has
   * lapsed sends a driver to a trip that is already someone else's.
   */
  ttl: number;
};

const naira = (amount: number) => `₦${Math.round(amount).toLocaleString('en-NG')}`;

/**
 * Builds the message.
 *
 * ⚠ Nothing here names the sender, the recipient, or an address. This renders
 *   on a lock screen — the least private surface in the system — and a parcel's
 *   route and fee are enough for a driver to decide whether to open the app.
 */
export function buildMessage(token: string, offer: OfferPayload, now = new Date()): ExpoMessage {
  const minutes = Math.max(0, Math.floor((Date.parse(offer.expiresAt) - now.getTime()) / 60_000));

  const route = offer.isLocal
    ? `Local job in ${offer.originCity}`
    : `${offer.originCity} → ${offer.destinationCity}`;

  return {
    to: token,
    title: offer.isLocal ? 'Local trip offered' : 'Trip offered',
    /*
     * Facts, then the ask.
     *
     * A driver reading this on a lock screen is deciding whether to pick the
     * phone up. Route, weight and fee are what that decision needs; the closing
     * sentence is what to do about it. "5 min to accept" alone states a
     * deadline without naming an action.
     */
    body: `${route} · ${offer.weight} kg · ${naira(offer.fee)}. ${
      minutes > 0 ? `Open Package Relay to accept — ${minutes} min left.` : 'Expiring now.'
    }`,
    /*
     * Ids only in the data payload, for the same reason as the body. The app
     * fetches the detail itself once opened, behind the driver's own session.
     *
     * `offerId` is what the tap handler routes on: a booking can carry several
     * offers over its life, and the one being answered has to be the one that
     * rang.
     */
    data: {
      type: 'dispatch_offer',
      offerId: offer.offerId,
      bookingId: offer.bookingId,
      expiresAt: offer.expiresAt,
    },
    sound: 'default',
    channelId: 'dispatch',
    priority: 'high',
    /*
     * iOS 15+ only. Time Sensitive is the one interruption level that breaks
     * through Focus and scheduled summaries, which is where an offer with a
     * five-minute hold would otherwise sit until it had already expired.
     *
     * It needs the Time Sensitive Notifications capability on the build; without
     * it Apple downgrades this to `active` rather than rejecting the push, so
     * the failure mode is a quiet notification rather than none.
     */
    interruptionLevel: 'timeSensitive',
    ttl: Math.max(60, minutes * 60),
  };
}

export function chunk<T>(items: T[], size = EXPO_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type ExpoTicket = {
  status?: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
};

export type SendOutcome = {
  sent: number;
  /**
   * Tokens Expo says will never work again. The caller deletes these — a device
   * that has uninstalled the app keeps its token forever otherwise, and every
   * future offer pays to send to nobody.
   */
  deadTokens: string[];
  failed: number;
};

/**
 * Reads Expo's per-message tickets.
 *
 * The response is 200 even when individual messages failed, so the status code
 * says nothing useful — the tickets do. `DeviceNotRegistered` is the one that
 * means "stop sending to this"; everything else is transient or ours to fix.
 */
export function interpretTickets(tokens: string[], payload: unknown): SendOutcome {
  const tickets = (payload as { data?: ExpoTicket[] })?.data;

  if (!Array.isArray(tickets)) {
    return { sent: 0, deadTokens: [], failed: tokens.length };
  }

  const outcome: SendOutcome = { sent: 0, deadTokens: [], failed: 0 };

  tickets.forEach((ticket, index) => {
    if (ticket?.status === 'ok') {
      outcome.sent += 1;
      return;
    }

    outcome.failed += 1;
    if (ticket?.details?.error === 'DeviceNotRegistered' && tokens[index]) {
      outcome.deadTokens.push(tokens[index]);
    }
  });

  return outcome;
}

/**
 * Sends one batch.
 *
 * `fetchImpl` is injected so the whole path is testable without a network.
 * Failures are reported, never thrown: a driver not being notified must not
 * roll back the offer that exists for them.
 */
export async function sendBatch(
  messages: ExpoMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
  const tokens = messages.map((message) => message.to);

  let response: Response;
  try {
    response = await fetchImpl(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Expo asks for this; without it large batches are rejected.
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(messages),
    });
  } catch {
    return { sent: 0, deadTokens: [], failed: tokens.length };
  }

  if (!response.ok) {
    return { sent: 0, deadTokens: [], failed: tokens.length };
  }

  try {
    return interpretTickets(tokens, await response.json());
  } catch {
    return { sent: 0, deadTokens: [], failed: tokens.length };
  }
}
