/**
 * Talking to the Expo push service, and reading what it says back.
 *
 * ⚠ This is the generic transport only — batching, sending, and interpreting
 *   tickets. Nothing here knows what a notification is about.
 *
 * ⚠ Duplicated, knowingly, from `notify-offer/expo-push.ts`.
 *
 *   That file works, has never been changed since 24, and is on the dispatch
 *   path. Editing it in the same change that introduces a new sender means a
 *   mistake here is also an offer outage. The two should be one file, and the
 *   time to do that is when `notify-offer` is folded into the notification
 *   spine — not now. If you fix a ticket-handling bug, fix it in both until
 *   then.
 *
 * No Deno globals, so this can be bundled and tested under node — the same
 * shape as `verify-liveness/dojah.ts`.
 *
 * ⚠ An Expo push token is a bearer credential. Anyone holding one can send a
 *   notification to that device with no key of their own. Nothing here logs a
 *   token, and nothing returns one to a caller.
 */

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** How many messages Expo accepts in one request. */
export const EXPO_BATCH_SIZE = 100;

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound: 'default';
  channelId: string;
  priority: 'high' | 'normal';
  interruptionLevel: 'timeSensitive' | 'active' | 'passive';
  ttl: number;
};

export type SendOutcome = {
  sent: number;
  /** Tokens Expo says will never work again. The caller deletes these. */
  deadTokens: string[];
  failed: number;
  /** Why it failed, when Expo or the transport said. Never contains a token. */
  error: string | null;
};

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

/**
 * Reads Expo's per-message tickets.
 *
 * ⚠ The response is 200 even when every message in it failed.
 *
 *   The status code says nothing useful; the tickets do. `DeviceNotRegistered`
 *   is the one that means "stop sending to this" — everything else is transient
 *   or ours to fix.
 */
export function interpretTickets(tokens: string[], payload: unknown): SendOutcome {
  const tickets = (payload as { data?: ExpoTicket[] })?.data;

  if (!Array.isArray(tickets)) {
    return { sent: 0, deadTokens: [], failed: tokens.length, error: 'Expo returned no tickets' };
  }

  const outcome: SendOutcome = { sent: 0, deadTokens: [], failed: 0, error: null };
  const reasons = new Set<string>();

  tickets.forEach((ticket, index) => {
    if (ticket?.status === 'ok') {
      outcome.sent += 1;
      return;
    }

    outcome.failed += 1;
    if (ticket?.details?.error) reasons.add(ticket.details.error);
    else if (ticket?.message) reasons.add(ticket.message);

    if (ticket?.details?.error === 'DeviceNotRegistered' && tokens[index]) {
      outcome.deadTokens.push(tokens[index]);
    }
  });

  /*
   * ⚠ The reason is recorded even when some messages succeeded.
   *
   *   A driver with a phone and a tablet where only the tablet took the message
   *   is not a success, and `pushed_at` set with no error would say it was.
   */
  if (reasons.size > 0) outcome.error = [...reasons].join(', ');

  return outcome;
}

/**
 * Sends one batch.
 *
 * `fetchImpl` is injected so the whole path is testable without a network.
 * Failures are reported, never thrown: the caller has a delivery record to
 * write either way, and an exception here would leave it unwritten.
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
  } catch (thrown) {
    return {
      sent: 0,
      deadTokens: [],
      failed: tokens.length,
      error: `Could not reach Expo: ${thrown instanceof Error ? thrown.message : 'unknown'}`,
    };
  }

  if (!response.ok) {
    return {
      sent: 0,
      deadTokens: [],
      failed: tokens.length,
      error: `Expo returned ${response.status}`,
    };
  }

  try {
    return interpretTickets(tokens, await response.json());
  } catch {
    return { sent: 0, deadTokens: [], failed: tokens.length, error: 'Expo returned unreadable JSON' };
  }
}
