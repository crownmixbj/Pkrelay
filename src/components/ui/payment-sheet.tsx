import { X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';

import { FontSize, Radius, Spacing, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { PAYMENT_RETURN_PATH, type CheckoutSession } from '@/store/payments';

/**
 * The gateway's own checkout, shown without leaving the app.
 *
 * ⚠ Paystack's hosted page, in a WebView — not a card form of ours.
 *
 *   A card number that touches this codebase drags the whole of PCI DSS in
 *   with it. The hosted page means the number is typed into Paystack's origin,
 *   inside a browser view this app can see the URL of and nothing else. What
 *   crosses back is a reference, which is worth nothing on its own.
 *
 * ⚠ Three ways out, and the third is the one that gets forgotten.
 *
 *   `returned`   the gateway navigated to our callback: paid, declined, or
 *                cancelled at their end. Which of those it was is not decided
 *                here — the server is asked.
 *   `dismissed`  the sender closed the sheet. The charge may still have gone
 *                through in the second before they tapped, so this is also not
 *                a verdict, just a different reason to go and ask.
 *   `failed`     the page itself would not load. Nothing was charged.
 *
 *   Every one of them goes to the same `verifyParcelPayment`. The UI never
 *   concludes a payment succeeded on its own evidence.
 */

export type CheckoutOutcome = 'returned' | 'dismissed' | 'failed';

export type PaymentSheetProps = {
  /** Null closes the sheet. Non-null opens it on that checkout. */
  session: CheckoutSession | null;
  onOutcome: (outcome: CheckoutOutcome, session: CheckoutSession) => void;
};

/** True once a URL is the callback this app owns, whatever query it carries. */
export function isReturnUrl(url: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === PAYMENT_RETURN_PATH;
  } catch {
    /* Relative or malformed — a substring test is the honest fallback. */
    return url.includes(PAYMENT_RETURN_PATH);
  }
}

export function PaymentSheet({ session, onOutcome }: PaymentSheetProps) {
  const theme = useTheme();
  const [loading, setLoading] = useState(true);

  /*
   * ⚠ Guards against reporting twice.
   *
   *   `onNavigationStateChange` fires on start *and* on finish for the same
   *   URL, and the sender can tap Close while the callback is loading. Two
   *   outcomes for one checkout means two verifications and, on the web path,
   *   two navigations — so the first one wins and the rest are dropped.
   */
  const settled = useRef(false);

  useEffect(() => {
    settled.current = false;
    setLoading(true);
  }, [session?.reference]);

  const report = useCallback(
    (outcome: CheckoutOutcome) => {
      if (!session || settled.current) return;
      settled.current = true;
      onOutcome(outcome, session);
    },
    [onOutcome, session],
  );

  /*
   * ⚠ Web does not get a WebView. It gets the whole tab.
   *
   *   `react-native-webview` has no web implementation, and an iframe would be
   *   worse than none: Paystack sets `X-Frame-Options`, 3-D Secure steps
   *   redirect to a bank that does the same, and the sender would watch a
   *   blank rectangle. A full navigation is also what makes bank redirects and
   *   password managers work at all.
   *
   *   Nothing is lost by leaving the page: the parcel is already a row, the
   *   reference is already in the database, and `/payment-return` picks the
   *   thread back up on the way in.
   */
  useEffect(() => {
    if (Platform.OS !== 'web' || !session || typeof window === 'undefined') return;
    if (settled.current) return;

    settled.current = true;
    window.location.assign(session.authorizationUrl);
  }, [session]);

  if (!session) return null;

  if (Platform.OS === 'web') {
    /* A held moment while the browser leaves, so the screen is not blank. */
    return (
      <Modal visible transparent animationType="fade">
        <View style={[styles.backdrop, { backgroundColor: theme.background }]}>
          <ActivityIndicator color={theme.primary} />
          <Text style={[styles.leaving, { color: theme.textSecondary }]}>
            Taking you to the secure checkout…
          </Text>
        </View>
      </Modal>
    );
  }

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => report('dismissed')}>
      <View style={[styles.sheet, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <View style={styles.headerText}>
            <Text style={[styles.title, { color: theme.text }]}>Secure checkout</Text>
            <Text style={[styles.subtitle, { color: theme.textMuted }]} numberOfLines={1}>
              {session.trackingId
                ? `Parcel ${session.trackingId} · paid through Paystack`
                : 'Paid through Paystack'}
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close checkout"
            hitSlop={12}
            onPress={() => report('dismissed')}
            style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}>
            <X color={theme.textSecondary} size={20} />
          </Pressable>
        </View>

        <WebView
          source={{ uri: session.authorizationUrl }}
          style={[styles.web, { backgroundColor: theme.background }]}
          onLoadEnd={() => setLoading(false)}
          /*
           * ⚠ Both hooks, because they catch different moments.
           *
           *   `onShouldStartLoadWithRequest` sees the callback before the
           *   WebView spends a round trip fetching a page we are about to
           *   throw away; returning false there stops the navigation dead.
           *   `onNavigationStateChange` is the backstop for a redirect that
           *   arrives some other way — a form POST, a JS location change on
           *   iOS — which the first hook does not always see.
           */
          onShouldStartLoadWithRequest={(request): boolean => {
            if (isReturnUrl(request.url)) {
              report('returned');
              return false;
            }
            return true;
          }}
          onNavigationStateChange={(state: WebViewNavigation): void => {
            if (isReturnUrl(state.url)) report('returned');
          }}
          onError={() => report('failed')}
          onHttpError={() => report('failed')}
          /* The sender types a card number in here. Nothing else may be stored. */
          incognito
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          startInLoadingState={false}
        />

        {loading && (
          <View style={[styles.loading, { backgroundColor: theme.background }]} pointerEvents="none">
            <ActivityIndicator color={theme.primary} />
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...Typography.sectionTitle,
    fontSize: FontSize.subhead,
  },
  subtitle: {
    ...Typography.caption,
  },
  close: {
    padding: Spacing.one,
    borderRadius: Radius.sm,
  },
  web: {
    flex: 1,
  },
  loading: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    top: 64,
  },
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  leaving: {
    ...Typography.body,
  },
});
