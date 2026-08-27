import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { showDialog } from '@/components/ui/dialog';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/store/session';

/**
 * "Continue with Google", on both auth screens.
 *
 * ⚠ One label for signing up and signing in, because OAuth has no such
 *   distinction.
 *
 *   Google either recognises the address or it does not; the app finds out
 *   afterwards. A button labelled "Sign up with Google" on one screen and "Sign
 *   in with Google" on the other promises a difference that does not exist, and
 *   the person who signed up with Google and later lands on Sign in would be
 *   left wondering why their password does not work — they never had one.
 *
 * ⚠ Nothing here is a secret.
 *
 *   The client id lives in the Supabase project, not in this bundle, and the
 *   exchange happens between Supabase and Google. This button knows a provider
 *   name and a redirect URL.
 */
export function GoogleSignIn({ disabled }: { disabled?: boolean }) {
  const theme = useTheme();
  const { signInWithGoogle } = useSession();
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    const { error } = await signInWithGoogle();

    /*
     * ⚠ Busy stays on when the call succeeds on web.
     *
     *   The page is navigating to Google. Clearing it would flash the button
     *   back to life for the instant before the document is replaced, which
     *   reads as the tap not having worked and invites a second one.
     */
    if (error) {
      setBusy(false);
      showDialog('Could not continue with Google', error);
    }
  };

  return (
    <View style={styles.block}>
      <View style={styles.dividerRow}>
        <View style={[styles.rule, { backgroundColor: theme.border }]} />
        <Text style={[styles.dividerText, { color: theme.textMuted }]}>or</Text>
        <View style={[styles.rule, { backgroundColor: theme.border }]} />
      </View>

      <Pressable
        onPress={() => void start()}
        disabled={busy || disabled}
        accessibilityRole="button"
        accessibilityLabel="Continue with Google"
        accessibilityState={{ busy, disabled: busy || disabled }}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: theme.surface, borderColor: theme.borderStrong },
          (busy || disabled) && styles.disabled,
          pressed && styles.pressed,
        ]}>
        {busy ? (
          <ActivityIndicator color={theme.text} />
        ) : (
          <>
            {/*
              Google's mark, drawn rather than fetched.

              ⚠ A remote image here would be a third-party request on the sign-in
                screen, and a blank square whenever it failed. Four glyphs of
                text is not the official lockup, but it is honest about being a
                button rather than pretending to be a badge.
            */}
            <Text style={[styles.mark, { color: '#4285F4' }]}>G</Text>
            <Text style={[styles.label, { color: theme.text }]}>Continue with Google</Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: Spacing.three },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { ...Typography.caption },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three - 2,
    borderRadius: Radius.md,
    borderWidth: 1,
    minHeight: 48,
  },
  mark: { ...Typography.body, ...font(700) },
  label: { ...Typography.body, ...font(600) },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
});
