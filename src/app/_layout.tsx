import { useFonts } from 'expo-font';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import Head from 'expo-router/head';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { BuildBanner } from '@/components/ui/build-banner';
import { CookieBanner } from '@/components/ui/cookie-banner';
import { NotificationRouter } from '@/components/ui/notification-router';
import { DialogHost } from '@/components/ui/dialog';
import { ToastHost } from '@/components/ui/toast';
import { SITE_DESCRIPTION, SITE_TITLE } from '@/constants/site';
import { Colors } from '@/constants/theme';
import { BookingsProvider } from '@/store/bookings';
import { HubsProvider } from '@/store/hubs';
import { ExperienceRouter } from '@/components/ui/experience-router';
import { NotificationsProvider } from '@/store/notifications';
import { configureNotificationHandler } from '@/store/push';
import { SessionProvider } from '@/store/session';

SplashScreen.preventAutoHideAsync();

/*
 * How a notification behaves while the app is open.
 *
 * Set at module scope, before any screen mounts — `expo-notifications` wants the
 * handler registered before a notification can arrive, and a notification that
 * lands during startup is exactly the one a driver most needs to see.
 */
configureNotificationHandler();

/** The app is pinned to light — see hooks/use-theme.ts. */
const navigationTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: Colors.light.background,
    card: Colors.light.surface,
    border: Colors.light.border,
    text: Colors.light.text,
    primary: Colors.light.primary,
  },
};

/**
 * How long the app will wait for type before giving up on it.
 *
 * ⚠ This number exists because the app shipped a white page to paying
 *   customers, and this file is where it came from.
 *
 *   The gate below used to be `!fontsLoaded && !fontError`, on the reasoning —
 *   still correct — that rendering in a fallback face and reflowing is worse
 *   than a held splash. It assumed those two states are exhaustive. They are
 *   not: a font request that resolves *but does not decode* leaves `useFonts`
 *   waiting for a promise that will never settle either way, and this component
 *   returns an empty, background-coloured View for ever.
 *
 *   That is precisely what a blank page is. No exception, so no error boundary
 *   catches it; nothing in the console but a decode warning; and it bites
 *   hardest on `/payment-return`, the one route reached by a cold document load
 *   from an external redirect, where nothing is in the browser's font cache yet.
 *   A sender was charged, redirected back, and shown nothing at all.
 *
 *   The comment above the effect already said "shipping the system font beats a
 *   permanently stuck splash screen". This is that sentence made true.
 */
const FONT_DEADLINE_MS = 2500;

export default function RootLayout() {
  /*
   * ⚠ Loaded from `assets/fonts/`, not from the `@expo-google-fonts` package.
   *
   *   Importing the package emits the files to
   *   `assets/node_modules/@expo-google-fonts/…` in the web export — and
   *   Cloudflare Pages silently refuses to upload any path containing a
   *   `node_modules` segment. All five fonts 404, `_redirects` turns each 404
   *   into `200 text/html` (the SPA fallback doing its job), and the browser
   *   receives `<!DOCTYPE html>` where a TTF should be. Every FontFace ends in
   *   `status: "error"` and nothing anywhere says so.
   *
   *   Copying the five faces into the repo removes the `node_modules` segment
   *   from the emitted path, which is the whole fix. It costs 480KB in git and
   *   buys fonts that actually deploy.
   */
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_400Regular: require('../../assets/fonts/PlusJakartaSans_400Regular.ttf'),
    PlusJakartaSans_500Medium: require('../../assets/fonts/PlusJakartaSans_500Medium.ttf'),
    PlusJakartaSans_600SemiBold: require('../../assets/fonts/PlusJakartaSans_600SemiBold.ttf'),
    PlusJakartaSans_700Bold: require('../../assets/fonts/PlusJakartaSans_700Bold.ttf'),
    PlusJakartaSans_800ExtraBold: require('../../assets/fonts/PlusJakartaSans_800ExtraBold.ttf'),
  });

  /*
   * The deadline, as state rather than a ref, because the render has to change
   * when it passes.
   */
  const [waitedLongEnough, setWaitedLongEnough] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setWaitedLongEnough(true), FONT_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, []);

  const ready = fontsLoaded || Boolean(fontError) || waitedLongEnough;

  // Hold the splash until the type is ready, so nothing renders in the fallback
  // face and then reflows. A font error — or the deadline above — still
  // releases it: shipping the system font beats a permanently stuck splash.
  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync();
    }
  }, [ready]);

  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: Colors.light.background }} />;
  }

  return (
    <ThemeProvider value={navigationTheme}>
      {/*
        The tab title and the description a search result shows.

        Here rather than in `+html.tsx` because `expo-router/head` is what
        renders the `<title>` on the web, and it injects at the top of the head
        — an element declared in the shell as well would be the second one and
        lose. Declared once, at the root, so every route inherits it; a screen
        that wants its own can mount its own `Head` and win by being deeper.

        The share-card tags live in the shell instead: they never vary by route,
        and a crawler that does not run JavaScript has to find them in the
        pre-rendered HTML.
      */}
      <Head>
        <title>{SITE_TITLE}</title>
        <meta name="description" content={SITE_DESCRIPTION} />
      </Head>

      <StatusBar style="dark" />
      <AnimatedSplashOverlay />
      {/* Session first: the bookings store stamps ownership from it. */}
      <SessionProvider>
        <NotificationsProvider>
          <BookingsProvider>
            <HubsProvider>
              {/*
                The banner is a sibling of the navigator, not a screen: a build
                with no database is wrong on every route, including the modals,
                and a warning you can navigate away from is not a warning.
                It renders null on a configured build, so this costs nothing in
                a real release.
              */}
              <View style={{ flex: 1 }}>
                <BuildBanner />
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: Colors.light.background },
                  }}>
                  <Stack.Screen name="(tabs)" />
                  <Stack.Screen
                    name="rate-calculator"
                    options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                  />
                  <Stack.Screen
                    name="corporate"
                    options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                  />
                </Stack>
              </View>

              {/*
                Inside the providers, outside the Stack: it needs the session
                and the router, and it must survive every navigation it causes.
              */}
              <ExperienceRouter />

              {/*
                Opens the trip a driver tapped, rather than dropping them on
                whatever screen the app happened to be on. A notification that
                does not take you to the thing it is about is a notification
                people stop tapping.
              */}
              <NotificationRouter />

              {/*
                Outside the Stack so it survives navigation, and last so it
                paints over the tab bar rather than under it.

                ⚠ Mounted on every platform and gated inside the component
                  rather than wrapped in a Platform check here.

                  The test is not only "is this web" — it is also whether any
                  optional category is live, whether an answer is on file, and
                  whether that answer is still fresh. Putting one third of it
                  here and the rest in the component is how the two drift. It
                  renders null on native and on an answered browser, which costs
                  a mounted component and nothing else.
              */}
              <CookieBanner />

              {/* Outside the Stack so these survive navigation. */}
              <DialogHost />
              <ToastHost />
            </HubsProvider>
          </BookingsProvider>
        </NotificationsProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
