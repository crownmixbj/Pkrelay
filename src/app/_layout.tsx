import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/plus-jakarta-sans';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import Head from 'expo-router/head';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
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

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });

  // Hold the splash until the type is ready, so nothing renders in the fallback
  // face and then reflows. A font error still releases it — shipping the
  // system font beats a permanently stuck splash screen.
  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
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
