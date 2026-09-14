import { Stack } from 'expo-router';

import { Colors } from '@/constants/theme';

/**
 * Auth lives outside `(tabs)` so it has no nav bar — sign-in shouldn't offer
 * links back into the app until there's a session.
 */
export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Colors.light.background },
        animation: 'slide_from_right',
      }}>
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="sign-up" />
      <Stack.Screen name="verify-email" />
      <Stack.Screen name="confirm" />
      <Stack.Screen name="forgot-password" />
      <Stack.Screen name="update-password" />
    </Stack>
  );
}
