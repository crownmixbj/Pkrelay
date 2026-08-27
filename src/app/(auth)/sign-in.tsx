import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { AuthFooterLink, AuthShell } from '@/components/ui/auth-shell';
import { GoogleSignIn } from '@/components/ui/google-sign-in';
import { Button } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/password-field';
import { ValidatedEmailInput } from '@/components/ValidatedEmailInput';
import { Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { MIN_PASSWORD_LENGTH } from '@/constants/auth-validation';
import { useSession } from '@/store/session';
import { isValidEmail } from '@/utils/validation';

export default function SignInScreen() {
  const theme = useTheme();
  const router = useRouter();

  const { signIn } = useSession();
  /**
   * `next` is set by the auth gate so we can return the user to what they were
   * doing; `email` is set when sign-up sent them here because the address was
   * already registered. Read before the state below, which seeds from it.
   */
  const { next, email: prefillEmail } = useLocalSearchParams<{ next?: string; email?: string }>();

  const [email, setEmail] = useState(prefillEmail ?? '');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /*
   * Email only. Accounts are created against an email address, and phone
   * sign-in would need an SMS provider configured in Supabase — the old
   * "Email or Phone Number" field advertised a route that always failed.
   */
  const passwordError =
    submitted && password.length < MIN_PASSWORD_LENGTH
      ? `At least ${MIN_PASSWORD_LENGTH} characters`
      : undefined;

  const handleSubmit = async () => {
    setSubmitted(true);
    setFormError(null);

    if (!isValidEmail(email) || password.length < MIN_PASSWORD_LENGTH || pending) return;

    setPending(true);
    let result;
    try {
      result = await signIn({ email, password });
    } catch (thrown) {
      result = { error: errorMessage(thrown, 'Something went wrong.') };
    } finally {
      setPending(false);
    }

    if (result.error) {
      setFormError(result.error);
      return;
    }

    router.replace((next as '/') ?? '/');
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to track parcels you've sent and jobs you're carrying."
      footer={
        <AuthFooterLink
          prompt="New to LOCI?"
          action="Create an account"
          onPress={() => router.replace({ pathname: '/sign-up', params: next ? { next } : {} })}
        />
      }>
      <View style={styles.form}>
        <ValidatedEmailInput value={email} onChangeText={setEmail} showError={submitted} />

        <PasswordField
          placeholder="Your password"
          value={password}
          onChangeText={setPassword}
          error={passwordError}
          autoComplete="current-password"
          textContentType="password"
          onSubmitEditing={handleSubmit}
          returnKeyType="go"
          accessory={
            <Pressable
              onPress={() =>
                router.push({
                  pathname: '/forgot-password',
                  params: email.trim() ? { email: email.trim().toLowerCase() } : {},
                })
              }
              accessibilityRole="link"
              accessibilityLabel="Forgot your password?"
              hitSlop={8}
              style={({ pressed }) => pressed && styles.pressed}>
              <Text style={[styles.forgot, { color: theme.primary }]}>Forgot password?</Text>
            </Pressable>
          }
        />

        {!!formError && (
          <View style={[styles.formError, { backgroundColor: theme.dangerSoft }]}>
            <Text style={[styles.formErrorText, { color: theme.dangerOnSoft }]}>{formError}</Text>
          </View>
        )}

        <Button
          label={pending ? 'Signing in…' : 'Sign In'}
          onPress={handleSubmit}
          disabled={pending}
        />

        <GoogleSignIn disabled={pending} />
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: Spacing.three,
  },
  forgot: {
    ...Typography.meta,
    ...font(700),
  },
  formError: {
    padding: Spacing.three - 4,
    borderRadius: Spacing.two,
  },
  formErrorText: {
    ...Typography.meta,
    lineHeight: 19,
  },
  pressed: {
    opacity: 0.7,
  },
});
