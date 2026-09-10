import { useLocalSearchParams, useRouter } from 'expo-router';
import { MailCheck } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { AuthFooterLink, AuthShell } from '@/components/ui/auth-shell';
import { Button } from '@/components/ui/button';
import { ValidatedEmailInput } from '@/components/ValidatedEmailInput';
import { Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/store/session';
import { isValidEmail } from '@/utils/validation';

/** Matches the confirmation resend — long enough to clear a double tap. */
const RESEND_COOLDOWN_SECONDS = 45;

/**
 * Password reset request.
 *
 * The success state is deliberately identical whether or not the address has an
 * account. Saying "no account with that email" would turn this form into a way
 * of testing which addresses are registered on Package Relay, which is the standard
 * account-enumeration hole. The person who genuinely owns the address gets the
 * email; everyone else learns nothing.
 */
export default function ForgotPasswordScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { requestPasswordReset } = useSession();
  const { email: prefill } = useLocalSearchParams<{ email?: string }>();

  const [email, setEmail] = useState(prefill ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleSubmit = async () => {
    setSubmitted(true);
    setError(null);
    if (!isValidEmail(email) || pending || cooldown > 0) return;

    setPending(true);
    let result;
    try {
      result = await requestPasswordReset(email);
    } catch (thrown) {
      result = { error: errorMessage(thrown, 'Something went wrong.') };
    } finally {
      setPending(false);
    }

    if (result.error) {
      setError(result.error);
      return;
    }

    setSent(true);
    setCooldown(RESEND_COOLDOWN_SECONDS);
  };

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle={`If an account exists for ${email.trim().toLowerCase()}, we've sent a link to reset the password. It expires in an hour.`}
        onBack={() => router.replace('/sign-in')}
        footer={
          <AuthFooterLink
            prompt="Remembered it?"
            action="Back to sign in"
            onPress={() => router.replace('/sign-in')}
          />
        }>
        <View style={styles.form}>
          <View style={[styles.icon, { backgroundColor: theme.successSoft }]}>
            <MailCheck color={theme.success} size={28} />
          </View>

          <Text style={[styles.note, { color: theme.textMuted }]}>
            Nothing after a minute or two? Check your spam folder — and make sure you typed the
            address you registered with.
          </Text>

          <Button
            label={cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend the link'}
            variant="secondary"
            disabled={cooldown > 0 || pending}
            onPress={handleSubmit}
          />
        </View>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter the email address on your account and we'll send you a link to set a new password."
      onBack={() => router.replace('/sign-in')}
      footer={
        <AuthFooterLink
          prompt="Remembered it?"
          action="Back to sign in"
          onPress={() => router.replace('/sign-in')}
        />
      }>
      <View style={styles.form}>
        <ValidatedEmailInput value={email} onChangeText={setEmail} showError={submitted} />

        {!!error && (
          <View style={[styles.formError, { backgroundColor: theme.dangerSoft }]}>
            <Text style={[styles.formErrorText, { color: theme.dangerOnSoft }]}>{error}</Text>
          </View>
        )}

        <Button
          label={pending ? 'Sending…' : 'Send reset link'}
          onPress={handleSubmit}
          disabled={pending}
        />
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: Spacing.three,
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  note: {
    ...Typography.meta,
    lineHeight: 19,
  },
  formError: {
    padding: Spacing.three - 4,
    borderRadius: Spacing.two,
  },
  formErrorText: {
    ...Typography.meta,
    lineHeight: 19,
    ...font(400),
  },
});
