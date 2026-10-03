import { useRouter, type Href } from 'expo-router';
import { useCallback } from 'react';

/**
 * A back control that always does something.
 *
 * ⚠ `router.back()` on an empty history stack is not a harmless no-op.
 *
 *   React Navigation dispatches GO_BACK up the navigator tree, and when no
 *   navigator can handle it a development build prints
 *
 *     The action 'GO_BACK' was not handled by any navigator.
 *
 *   over the screen as a toast. Every route in this app is directly
 *   addressable, and most of them are reached that way by somebody: a parcel
 *   link in a delivery email, a bookmarked /sign-up, a shared /corporate URL,
 *   a hard reload of /rate-calculator, a push notification opening
 *   /parcel/<id> from a cold start. In all of those the stack holds exactly
 *   one entry, so the back arrow the screen draws is a control that cannot
 *   work — a toast in development, and in production a control that silently
 *   refuses, which is the worse of the two because nothing says why.
 *
 * ⚠ The fallback replaces rather than pushes.
 *
 *   The screen being dismissed must not survive in history. Pushing home on
 *   top of it leaves the browser's own back button pointing at the page the
 *   person just closed, so closing a parcel and pressing back reopens it.
 *
 * ⚠ `canGoBack()` and not a try/catch around `back()`.
 *
 *   GO_BACK is dispatched, not thrown — the toast comes from the navigator
 *   reporting an unhandled action, so there is nothing for a catch to catch.
 *   Asking first is the only way to know.
 *
 * Every back and close control in the app routes through this, so the rule
 * lives in one place. `scripts/verify-layout.ts` sweeps the tree for a bare
 * `router.back()` to keep it that way.
 */
export function useGoBack(fallback: Href = '/'): () => void {
  const router = useRouter();

  return useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace(fallback);
  }, [router, fallback]);
}
