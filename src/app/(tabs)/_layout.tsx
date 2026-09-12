import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { BottomTabBar } from '@/components/ui/bottom-tab-bar';
import { StickyHeader } from '@/components/ui/sticky-header';
import { PageCanvas } from '@/constants/theme';
import { useTopInset } from '@/hooks/use-top-inset';

export default function TabLayout() {
  const topInset = useTopInset();

  return (
    /*
      The status bar is reserved here, once, for every tab screen.

      A native stack with `headerShown: false` hands the screen the whole
      window — including the strip under the notch and the dynamic island. Every
      screen in this group starts with a title, so every one of them was drawing
      that title behind the clock. Doing it per screen means the next screen
      added forgets, so it lives on the container they all share.

      See `useTopInset` for why this is 0 while the build banner is showing.
    */
    <View style={[styles.container, { backgroundColor: PageCanvas, paddingTop: topInset }]}>
      {/*
        Rendered above the navigator, so it survives route changes and stays put
        while screens scroll under it. Shared with screens outside this group —
        see `sticky-header.tsx`.
      */}
      <StickyHeader />

      {/*
        Single navbar: the capsule above carries every link. Expo Router's Tabs
        bar is hidden — Tabs is kept only for route grouping and screen
        lifecycle, with navigation driven from the capsule.
      */}
      <Tabs
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: PageCanvas },
          tabBarStyle: styles.hiddenTabBar,
        }}>
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="book" options={{ title: 'Send Parcel' }} />
        <Tabs.Screen name="available-packages" options={{ title: 'Setup Trip' }} />
        <Tabs.Screen name="driver" options={{ title: 'Assigned Trip' }} />
        <Tabs.Screen name="driver-wallet" options={{ title: 'Driver Wallet' }} />
        {/*
          Shared by senders and drivers, so it is deliberately absent from
          ROUTE_EXPERIENCES — unlisted routes are available to every experience,
          and both sides receive notifications.
        */}
        <Tabs.Screen name="notifications" options={{ title: 'Notifications' }} />
        <Tabs.Screen name="driver-signup" options={{ title: 'Drivers' }} />
        <Tabs.Screen name="locations" options={{ title: 'Hubs' }} />
        <Tabs.Screen name="about" options={{ title: 'About Us' }} />
        {/* Admin-only; the screen itself refuses non-admins. */}
        <Tabs.Screen name="admin" options={{ title: 'Applications' }} />
        {/* Reached only after posting a parcel — not a nav destination. */}
        <Tabs.Screen name="parcel-confirmed" options={{ title: 'Parcel Posted' }} />
        {/* Reached only after accepting a job — not a nav destination. */}
        <Tabs.Screen name="job-accepted" options={{ title: 'Order Accepted' }} />
      </Tabs>

      {/*
        The native tab bar. Renders nothing on web, where the capsule above
        carries navigation instead.

        Outside the navigator so it does not scroll with a screen, and below it
        in the tree so it paints on top.
      */}
      <BottomTabBar />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  hiddenTabBar: {
    display: 'none',
  },
});
