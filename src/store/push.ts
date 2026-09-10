import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

/**
 * Push notifications, for dispatch offers.
 *
 * An offer is held for five minutes. Without this a driver only learns about it
 * by opening the app, which made Flash mode — a driver sitting waiting for local
 * work — mostly theoretical.
 *
 * The token is registered against the signed-in account and is the only thing
 * this module sends anywhere. Nothing here reads a parcel; the notification body
 * is built on the server, so a lock screen never shows a customer's name.
 */

/** Matches `channelId` in `supabase/functions/notify-offer/expo-push.ts`. */
export const DISPATCH_CHANNEL = 'dispatch';

/**
 * The EAS project a push token belongs to.
 *
 * Expo mints tokens per project, so this is not optional metadata — it is part
 * of the token's identity. Read from the manifest in both places rather than
 * inferred, because inference throws when it fails and every caller here
 * catches.
 */
const projectId = (): string | undefined =>
  Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;

/**
 * How a notification behaves when it lands while the app is open.
 *
 * Shown, not swallowed. A driver looking at the map is exactly the person who
 * should see a trip offer — the alternative is a silent badge they notice after
 * the hold expires.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export type PushRegistration =
  { ok: true; token: string } | { ok: false; reason: 'unsupported' | 'denied' | 'error' };

/**
 * Asks for permission, gets a token, and stores it against the account.
 *
 * ⚠ Only ever call this at a moment the driver would expect it — going online
 *   for Flash, or declaring a route. An app that asks for notifications on first
 *   launch, before anyone knows what it wants them for, gets refused; and on
 *   iOS a refusal is close to permanent, because the second prompt never
 *   appears and the driver has to find Settings.
 */
export async function registerForPush(): Promise<PushRegistration> {
  /*
   * Simulators and the web have no push tokens worth having. Expo's
   * `getExpoPushTokenAsync` throws on a simulator rather than returning
   * anything, so this is a guard rather than a nicety.
   */
  if (Platform.OS === 'web' || !Device.isDevice) {
    return { ok: false, reason: 'unsupported' };
  }

  try {
    /*
     * Android needs the channel to exist before the first notification, not
     * after. Created here rather than at launch so it lands with the
     * permission request — one place, one order.
     */
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(DISPATCH_CHANNEL, {
        name: 'Trip offers',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        // A driver muting Package Relay's other noise should still hear about work.
        sound: 'default',
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;

    if (!granted && existing.canAskAgain) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted;
    }

    if (!granted) return { ok: false, reason: 'denied' };

    /*
     * The project id is passed explicitly rather than inferred.
     *
     * `getExpoPushTokenAsync()` can usually work it out from the app config,
     * but when it cannot it *throws* — and this whole function catches, so the
     * result would be `{ ok: false, reason: 'error' }`: a driver told "could
     * not turn on alerts" with nothing anywhere saying why. Reading it from the
     * manifest makes that failure impossible rather than quiet.
     */
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: projectId() })).data;

    const { error } = await supabase.rpc('register_push_token', {
      push_token: token,
      device_platform: Platform.OS,
    });
    if (error) return { ok: false, reason: 'error' };

    return { ok: true, token };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * Whether this device is already registered, without prompting.
 *
 * Used to decide whether to show "turn on alerts" rather than to decide whether
 * to ask — calling `registerForPush` to find out would prompt as a side effect.
 */
export async function pushIsEnabled(): Promise<boolean> {
  if (Platform.OS === 'web' || !Device.isDevice) return false;
  try {
    return (await Notifications.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/** What to tell a driver when registration did not work. */
export function pushProblem(reason: 'unsupported' | 'denied' | 'error'): string {
  switch (reason) {
    case 'denied':
      return 'Notifications are turned off for Package Relay. Turn them on in your phone settings, or keep this screen open while you wait.';
    case 'unsupported':
      return 'This device cannot receive push notifications. Keep this screen open while you wait for a trip.';
    case 'error':
    default:
      return 'Could not turn on alerts. Keep this screen open while you wait for a trip.';
  }
}

/**
 * Forgets this device on sign-out.
 *
 * Without it the next person to sign in on a shared phone keeps receiving the
 * previous driver's offers — and `register_push_token` only moves a token when
 * somebody actually registers, which a signed-out device never does.
 */
export async function unregisterPush(): Promise<void> {
  if (Platform.OS === 'web' || !Device.isDevice) return;
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: projectId() })).data;
    await supabase.from('push_tokens').delete().eq('token', token);
  } catch {
    // Nothing to forget, or no network. The token expires on its own.
  }
}
