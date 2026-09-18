import { useLocalSearchParams, useRouter } from 'expo-router';
import { CircleAlert, CircleCheck } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { screenPadding } from '@/components/ui/screen';
import { FontSize, MaxContentWidth, Spacing, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useBookings } from '@/store/bookings';
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
 * ⚠ 'unknown' is retried, not reported.
 *
 *   Paystack redirects the browser and posts the webhook at roughly the same
 *   moment, and the verify call can land while the charge is still settling.
 *   Telling somebody their payment failed one second before it succeeds is the
 *   worst outcome available here — they pay twice. So an inconclusive answer
 *   is asked again, a few times, a second apart, before anything is said.
 */

/** How many times to ask, and how long to leave between asks. */
const ATTEMPTS = 5;
const GAP_MS = 1500;

type Phase = 'checking' | 'paid' | 'failed' | 'unknown' | 'no-reference';

export default function PaymentReturnScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { refresh } = useBookings();

  /*
   * Paystack sends both, and they hold the same value. `reference` is ours,
   * from the callback URL we built; `trxref` is theirs, appended on the way
   * back. Reading ours first and falling back keeps working if they ever stop
   * echoing the query string we sent.
   */
  const params = useLocalSearchParams<{ reference?: string; trxref?: string }>();
  const reference = (params.reference ?? params.trxref ?? '').trim();

  const [phase, setPhase] = useState<Phase>(reference ? 'checking' : 'no-reference');
  const [message, setMessage] = useState<string | null>(null);

  /* Strict Mode mounts effects twice in development; this makes the second a no-op. */
  const started = useRef(false);

  const toShipments = useCallback(() => {
    router.replace({ pathname: '/my-packages', params: { section: 'active' } });
  }, [router]);

  useEffect(() => {
    if (!reference || started.current) return;
    started.current = true;

    let cancelled = false;

    const run = async () => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const outcome = await verifyParcelPayment(reference);
        if (cancelled) return;

        if (outcome.status === 'success') {
          /*
           * The list is refreshed *before* navigating, not after.
           *
           * The store holds a copy of this parcel from before the payment —
           * `payment_status` still 'pending' on it — and the shipments screen
           * reads the store, not the server. Arriving first and refreshing
           * second is a parcel that appears, then flickers as it changes
           * state. Refreshing first means it is right when it is first seen.
           */
          await refresh();
          if (cancelled) return;

          setPhase('paid');
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
      setMessage(
        'We have not had confirmation from the bank yet. Your parcel will start moving on its ' +
          'own as soon as it arrives — nothing else is needed from you.',
      );
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [reference, refresh, toShipments]);

  return (
    /*
      A scroller with the house footer, rather than a bare centred View.

      ⚠ This is a page somebody can be left on.

        On the happy path it lasts two seconds and redirects. On a declined card
        or an unconfirmed charge it is where the sender stays, having just come
        back from a bank — and a dead end with no way to anything else is the
        worst possible place to strand them. `verify-footer` says every page
        carries the footer; this is a page.
    */
    <ScrollView
      contentContainerStyle={[styles.container, screenPadding]}
      style={{ backgroundColor: theme.background }}
      showsVerticalScrollIndicator={false}>
      <View style={styles.content}>
        {phase === 'checking' && (
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
  action: {
    marginTop: Spacing.two,
    minWidth: 220,
  },
});
