import { useLocalSearchParams, useRouter } from 'expo-router';
import { UserRound } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { AuthFooterLink, AuthShell } from '@/components/ui/auth-shell';
import { GoogleSignIn } from '@/components/ui/google-sign-in';
import { Button } from '@/components/ui/button';
import { showDialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { PasswordField } from '@/components/ui/password-field';
import { ValidatedEmailInput } from '@/components/ValidatedEmailInput';
import { ValidatedPhoneInput } from '@/components/ValidatedPhoneInput';
import { Spacing, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { isValidEmail, isValidNigerianPhone } from '@/utils/validation';
import { MIN_PASSWORD_LENGTH } from '@/constants/auth-validation';
import { useSession } from '@/store/session';

export default function SignUpScreen() {
  const theme = useTheme();
  const router = useRouter();

  const { signUp } = useSession();
  /**
   * Where to land after signing up. Set by the auth gate, so someone who tried
   * to post a parcel is returned to the form rather than the home screen.
   */
  const { next } = useLocalSearchParams<{ next?: string }>();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  /** Whatever the server said went wrong — wrong shape, offline, rate limited. */
  const [formError, setFormError] = useState<string | null>(null);

  const nameError = submitted && name.trim().length < 2 ? 'Enter your full name' : undefined;
  const passwordError =
    submitted && password.length < MIN_PASSWORD_LENGTH
      ? `At least ${MIN_PASSWORD_LENGTH} characters`
      : undefined;

  const valid =
    name.trim().length >= 2 &&
    isValidEmail(email) &&
    isValidNigerianPhone(phone) &&
    password.length >= MIN_PASSWORD_LENGTH;

  const handleSubmit = async () => {
    setSubmitted(true);
    setFormError(null);
    if (!valid || pending) return;

    setPending(true);
    let result;
    try {
      result = await signUp({ email, password, name, phone });
    } catch (thrown) {
      // The store already traps its own errors; this is the last line of
      // defence so the button can never be left disabled with no explanation.
      result = { error: errorMessage(thrown, 'Something went wrong.') };
    } finally {
      setPending(false);
    }

    /*
     * Already registered. A dialog rather than the red banner: this isn't the
     * user getting something wrong, it's a fork in the road, and the useful
     * response is to offer the road they probably wanted. Note it can arrive
     * with `error: null` — see the obfuscated-duplicate case in the store.
     */
    if (result.emailTaken) {
      showDialog(
        'That email is already registered',
        `An account already exists for ${email.trim().toLowerCase()}. Sign in with your password, or use a different email address.`,
        [
          { text: 'Use another email', style: 'cancel' },
          {
            text: 'Sign in instead',
            onPress: () =>
              router.replace({
                pathname: '/sign-in',
                params: { email: email.trim().toLowerCase(), ...(next ? { next } : {}) },
              }),
          },
        ],
      );
      return;
    }

    if (result.error) {
      setFormError(result.error);
      return;
    }

    // With email confirmation on there is no session yet, so the next screen
    // explains what to do rather than claiming success.
    if (result.needsEmailConfirmation) {
      router.replace({
        pathname: '/verify-email',
        params: { email: email.trim().toLowerCase() },
      });
      return;
    }

    router.replace((next as '/') ?? '/');
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="Send parcels across Nigeria, or sign up and start carrying jobs."
      footer={
        <AuthFooterLink
          prompt="Already have an account?"
          action="Sign in"
          onPress={() => router.replace({ pathname: '/sign-in', params: next ? { next } : {} })}
        />
      }>
      <View style={styles.form}>
        <Field
          label="Full name"
          icon={(color, size) => <UserRound color={color} size={size} />}
          placeholder="Ada Obi"
          value={name}
          onChangeText={setName}
          error={nameError}
          autoComplete="name"
          textContentType="name"
        />

        <ValidatedEmailInput value={email} onChangeText={setEmail} showError={submitted} />

        <ValidatedPhoneInput value={phone} onChangeText={setPhone} showError={submitted} />

        <PasswordField
          placeholder="At least 8 characters"
          value={password}
          onChangeText={setPassword}
          error={passwordError}
          hint="Longer is stronger — a short phrase beats a scrambled word."
          showStrength
          autoComplete="new-password"
          textContentType="newPassword"
          onSubmitEditing={handleSubmit}
          returnKeyType="go"
        />

        {!!formError && (
          <View style={[styles.formError, { backgroundColor: theme.dangerSoft }]}>
            <Text style={[styles.formErrorText, { color: theme.dangerOnSoft }]}>{formError}</Text>
          </View>
        )}

        <Button
          label={pending ? 'Creating account…' : 'Create Account'}
          onPress={handleSubmit}
          disabled={!valid || pending}
        />

        <GoogleSignIn disabled={pending} />

        <Text style={[styles.legal, { color: theme.textMuted }]}>
          By creating an account you agree to LOCI&apos;s terms of service and privacy policy.
        </Text>
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: Spacing.three,
  },
  formError: {
    padding: Spacing.three - 4,
    borderRadius: Spacing.two,
  },
  formErrorText: {
    ...Typography.meta,
    lineHeight: 19,
  },
  legal: {
    ...Typography.caption,
    lineHeight: 17,
    textAlign: 'center',
  },
});
