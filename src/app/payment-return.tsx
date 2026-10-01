import { useLocalSearchParams, useRouter, type ErrorBoundaryProps } from 'expo-router';
import { CircleAlert, CircleCheck } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { screenPadding } from '@/components/ui/screen';
import { FontSize, MaxContentWidth, Spacing, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/store/session';
import { verifyParcelPayment } from '@/store/payments';

/**
 * Where Paystack sends a web sender back to, and the only screen in the app
 * whose job is to wait.
 *
 * ⚠ It exists because the web checkout is a full navigation, not a modal.
 *
 *   On native the sender never leaves: the WebView closes and `book.tsx` is
 *   still mounted with everything it knows. On web the tab went to Paystack
 *   and came back to a freshly booted app that knows nothing except what is in
 *   this URL. This route is that thread being picked back up.
 *
 * ⚠ It is a cold start, and that is the thing this screen keeps getting wrong.
 *
 *   Every other screen in the app is reached from inside a running session.
 *   This one is reached by an external redirect into a browser tab that has
 *   just booted: no store is warm, no session is restored yet, and the first
 *   render happens before any of it. Two of the bugs below came from treating
 *   it like an ordinary screen. It now assumes nothing except its own URL.
 */

/**
 * One value out of a query parameter, whatever shape the router gives it.
 *
 * ⚠ This route received `reference` twice, every single time.
 *
 *   `callbackUrl` used to build `…/payment-return?reference=X`, and Paystack
 *   then appends its own `trxref=X&reference=X` to whatever callback it was
 *   given. The result is `?reference=X&trxref=X&reference=X` — two `reference`
 *   keys — and expo-router represents a repeated key as an array.
 *
 *   `callbackUrl` no longer adds one (Paystack supplies both), so the duplicate
 *   is gone at the source. This stays because the source is a third party: a
 *   provider that decides to echo a parameter twice must not be able to blank
 *   this page again.
 */
function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? '').trim();
  return (value ?? '').trim();
}

/** How many times to ask, and how long to leave between asks. */
const ATTEMPTS = 5;
const GAP_MS = 1500;

type Phase = 'waiting-for-session' | 'checking' | 'paid' | 'failed' | 'unknown' | 'no-reference';

export default function PaymentReturnScreen() {
  const theme = useTheme();
  const router = useRouter();

  /*
   * ⚠ The session has to be restored before the first verify call, and this is
   *   the bug that made a successful payment look like a failed one.
   *
   *   `payments-verify` authenticates with the caller's JWT. Supabase restores
   *   that session from storage *asynchronously* — on native from AsyncStorage,
   *   on web from localStorage — and this screen's effect used to fire on mount,
   *   before it finished. The call went out unauthenticated, the function
   *   answered 401 "Not signed in", the store read that as 'unknown', and the
   *   retry loop spent seven and a half seconds re-asking with the same missing
   *   token before giving up on a charge that had gone through.
   *
   *   Nothing about it was visible: 'unknown' is the deliberately soft outcome,
   *   so it printed "Still waiting on the bank" — which reads as Paystack being
   *   slow rather than as this app not having asked properly.
   */
  const { status } = useSession();
  const sessionReady = status !== 'loading';

  /*
   * ⚠ No `useBookings()` here any more, on purpose.
   *
   *   This screen used to refresh the bookings store before navigating, which
   *   made a page reached by an external redirect depend on a provider chain
   *   several layers up. It no longer needs to: `BookingsProvider` subscribes
   *   to its own rows over Realtime and refreshes when the app becomes active,
   *   so the shipments list is right whether or not anything on this screen
   *   runs at all. One screen being the only thing keeping a list honest was
   *   the second bug.
   */

  /*
   * Paystack sends both, and they hold the same value. `reference` is ours,
   * from the callback URL we built; `trxref` is theirs, appended on the way
   * back. Reading ours first and falling back keeps working if they ever stop
   * echoing the query string we sent.
   */
  const params = useLocalSearchParams<{
    /*
      ⚠ `string | string[]`, and the array case is the normal one here.

        `useLocalSearchParams` hands back an array whenever a key appears more
        than once in the query string — and on this route it always did. Typing
        these as plain strings was a lie the compiler believed and the browser
        did not: `.trim()` on an array is `A.trim is not a function`, which is
        what a sender saw after paying.
    */
    reference?: string | string[];
    trxref?: string | string[];
  }>();

  const reference = firstParam(params.reference) || firstParam(params.trxref);

  const [phase, setPhase] = useState<Phase>(() => {
    if (!reference) return 'no-reference';
    return 'waiting-for-session';
  });
  const [message, setMessage] = useState<string | null>(null);

  /* Strict Mode mounts effects twice in development; this makes the second a no-op. */
  const started = useRef(false);

  const toShipments = useCallback(() => {
    router.replace({ pathname: '/my-packages', params: { section: 'active' } });
  }, [router]);

  useEffect(() => {
    if (!reference || !sessionReady || started.current) return;
    started.current = true;

    let cancelled = false;

    const run = async () => {
      setPhase('checking');
      let lastError: string | null = null;

      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const outcome = await verifyParcelPayment(reference);
        if (cancelled) return;

        lastError = outcome.error;

        if (outcome.status === 'success') {
          setPhase('paid');
          /*
           * Straight to the list. It refreshes itself now — see the note above
           * on `useBookings` — so there is nothing to await before leaving.
           */
          toShipments();
          return;
        }

        if (outcome.status === 'failed') {
          setPhase('failed');
          setMessage(outcome.error ?? 'That payment did not go through.');
          return;
        }

        /* Inconclusive. Give the webhook a moment and ask again. */
        if (attempt < ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, GAP_MS));
        }
      }

      if (cancelled) return;
      setPhase('unknown');
      /*
        The server's sentence when there is one, and ours when there is not.

        ⚠ A generic "waiting on the bank" over the top of a real error is how
          the 401 above stayed invisible for a whole release. If the function
          told us something, the sender reads that.
      */
      setMessage(
        lastError ??
          'We have not had confirmation from the bank yet. Your parcel will start moving on ' +
            'its own as soon as it arrives — nothing else is needed from you, and your ' +
            'shipments list will update itself.',
      );
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [reference, sessionReady, toShipments]);

  const waiting = phase === 'waiting-for-session' || phase === 'checking';

  return (
    /*
      A scroller with the house footer, rather than a bare centred View.

      ⚠ This is a page somebody can be left on.

        On the happy path it lasts two seconds and redirects. On a declined card
        or an unconfirmed charge it is where the sender stays, having just come
        back from a bank — and a dead end with no way to anything else is the
        worst possible place to strand them.
    */
    <ScrollView
      contentContainerStyle={[styles.container, screenPadding]}
      style={{ backgroundColor: theme.background }}
      showsVerticalScrollIndicator={false}>
      <View style={styles.content}>
        {waiting && (
          <>
            <ActivityIndicator color={theme.primary} size="large" />
            <Text style={[styles.title, { color: theme.text }]}>Confirming your payment</Text>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              This takes a few seconds. Please don&apos;t close this page.
            </Text>
          </>
        )}

        {phase === 'paid' && (
          <>
            <CircleCheck color={theme.success} size={40} />
            <Text style={[styles.title, { color: theme.text }]}>Payment confirmed</Text>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              Taking you to your shipments.
            </Text>
          </>
        )}

        {(phase === 'failed' || phase === 'unknown' || phase === 'no-reference') && (
          <>
            <CircleAlert color={theme.warning} size={40} />
            <Text style={[styles.title, { color: theme.text }]}>
              {phase === 'failed' ? 'That payment did not complete' : 'Still waiting on the bank'}
            </Text>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              {message ??
                'We could not find a payment to confirm. Your parcel is still on your shipments ' +
                  'list and can be paid for from there.'}
            </Text>
            <Button label="Go to my shipments" onPress={toShipments} style={styles.action} />
          </>
        )}
      </View>

      <Footer />
    </ScrollView>
  );
}

/**
 * What the sender sees if this screen throws.
 *
 * ⚠ Exported because a white page is the worst failure this route can have, and
 *   it is the one it had.
 *
 *   Expo Router renders a route's exported `ErrorBoundary` in place of the
 *   route when its render throws. Without one, an exception anywhere in the
 *   tree above unmounts the whole app and leaves an empty document — which is
 *   what a sender saw, one second after being charged, with no indication that
 *   their money was safe or where their parcel had gone.
 *
 * ⚠ It says the money is safe, and that is true rather than reassuring.
 *
 *   Nothing on this screen moves money. The charge was completed at Paystack
 *   before the redirect, and it is settled by the webhook — server to server,
 *   with no part for this browser to play. A crash here loses a progress
 *   indicator, not a payment, and the sender is owed that sentence rather than
 *   being left to guess.
 *
 * ⚠ The error text is shown, not hidden behind "something went wrong".
 *
 *   This page is reached perhaps once per sender. A generic apology produces a
 *   support ticket with nothing in it; the actual message produces one that can
 *   be fixed. It carries no personal data — it is a stack from our own bundle.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <PaymentReturnFallback error={error} retry={retry} />;
}

function PaymentReturnFallback({ error, retry }: ErrorBoundaryProps) {
  const theme = useTheme();
  const router = useRouter();

  return (
    <ScrollView
      contentContainerStyle={[styles.container, screenPadding]}
      style={{ backgroundColor: theme.background }}
      showsVerticalScrollIndicator={false}>
      <View style={styles.content}>
        <CircleAlert color={theme.warning} size={40} />
        <Text style={[styles.title, { color: theme.text }]}>
          We could not show your payment result
        </Text>
        <Text style={[styles.body, { color: theme.textSecondary }]}>
          Your payment is safe. Anything you were charged is confirmed with the bank and your
          parcel updates on its own — this page is only the receipt screen, and it is the part
          that failed.
        </Text>
        <Text selectable style={[styles.detail, { color: theme.textMuted }]}>
          {error?.message ?? 'Unknown error'}
        </Text>
        <Button label="Go to my shipments" onPress={() => router.replace('/my-packages')} />
        <Button label="Try this page again" variant="secondary" onPress={() => void retry()} />
      </View>

      <Footer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth / 2,
    alignItems: 'center',
    gap: Spacing.three,
  },
  title: {
    ...Typography.sectionTitle,
    fontSize: FontSize.heading,
    textAlign: 'center',
  },
  body: {
    ...Typography.body,
    textAlign: 'center',
  },
  detail: {
    ...Typography.caption,
    textAlign: 'center',
  },
  action: {
    marginTop: Spacing.two,
    minWidth: 220,
  },
});
