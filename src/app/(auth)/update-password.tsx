import { useRouter } from 'expo-router';
import { KeyRound, MailWarning } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { AuthShell } from '@/components/ui/auth-shell';
import { Button } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/password-field';
import { showToast } from '@/components/ui/toast';
import { MIN_PASSWORD_LENGTH } from '@/constants/auth-validation';
import { Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { errorMessage } from '@/lib/errors';
import { parseConfirmationParams } from '@/lib/email-confirmation';
import { useSession } from '@/store/session';

/**
 * Where a password-reset link lands, and the only way out of a recovery session.
 *
 * ⚠ The screen is the gate, not a courtesy.
 *
 *   Supabase answers a reset link with an ordinary session, so by the time
 *   anybody reaches here they are already "signed in" as far as `status` is
 *   concerned — on nothing stronger than access to an inbox. `recovering` is
 *   what marks that session as unfinished, `recoveryRedirect` is what holds
 *   them here, and setting a password is what clears both. Sign-out is the
 *   other exit, and it is offered below on purpose: a person who did not ask
 *   for this email needs a door that is not "choose a new password".
 *
 * The waiting branch mirrors `/confirm` for the same reason it exists there —
 * `detectSessionInUrl` does the exchange, it takes a moment, and it can fail.
 */

/** Matches `/confirm`: long enough for a slow exchange, short enough to not stall. */
const EXCHANGE_TIMEOUT_MS = 6_000;

export default function UpdatePasswordScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { status, user, recovering, updatePassword, signOut } = useSession();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /*
   * Read once, from the URL the browser was opened with — same as `/confirm`.
   * Native has no URL bar; the router puts the same parameters on the route.
   */
  const params = useMemo(() => {
    const href = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.href : '';
    return parseConfirmationParams(href);
  }, []);

  /*
   * ⚠ Nothing is claimed while a code is still in flight.
   *
   *   A recovery URL carries a code that `supabase-js` exchanges on its own.
   *   Until that lands there is no session and no `recovering` flag, which is
   *   indistinguishable from an expired link — and telling somebody their link
   *   is dead while it is still working is the one answer they cannot act on.
   */
  const [exchangeTimedOut, setExchangeTimedOut] = useState(false);

  useEffect(() => {
    if (!params.code || recovering || status === 'loading') return;

    const timer = setTimeout(() => setExchangeTimedOut(true), EXCHANGE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [params.code, recovering, status]);

  const tooShort = password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmation.length > 0 && confirmation !== password;

  const handleSubmit = async () => {
    setSubmitted(true);
    setFormError(null);
    if (tooShort || password !== confirmation || pending) return;

    setPending(true);
    let result;
    try {
      result = await updatePassword(password);
    } catch (thrown) {
      result = { error: errorMessage(thrown, 'Something went wrong.') };
    } finally {
      setPending(false);
    }

    if (result.error) {
      setFormError(result.error);
      return;
    }

    /*
      Said out loud, and said here rather than on the destination.

      The gate lifts the instant `updatePassword` resolves, so the redirect
      below fires immediately — without the toast the only evidence of a
      successful reset would be the app quietly appearing, which is how people
      end up going back to their inbox to click the link a second time.
    */
    showToast('Password updated', {
      message: 'You are signed in with your new password.',
      tone: 'success',
    });
    router.replace('/');
  };

  /* ---------- the exchange is still running ---------- */
  if (status === 'loading' || (params.code && !recovering && !exchangeTimedOut)) {
    return (
      <AuthShell title="Checking your link" subtitle="One moment.">
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      </AuthShell>
    );
  }

  /* ---------- no session to change a password on ---------- */
  if (!recovering && status !== 'signedIn') {
    const expired = params.errorCode === 'otp_expired' || Boolean(params.code);

    return (
      <AuthShell
        title={expired ? 'That link has expired' : 'That link did not work'}
        subtitle={
          expired
            ? 'Reset links are good for one hour, and can only be used once. Ask for a fresh one and open it on this device.'
            : (params.errorDescription ??
              'Ask for a fresh reset link and open it on this device.')
        }
        onBack={() => router.replace('/sign-in')}>
        <View style={styles.form}>
          <View style={[styles.icon, { backgroundColor: theme.warningSoft }]}>
            <MailWarning color={theme.warningOnSoft} size={28} />
          </View>

          <Button
            label="Ask for a new link"
            onPress={() =>
              router.replace({
                pathname: '/forgot-password',
                /*
                  The address rides the URL precisely so this hand-off can
                  prefill it. Somebody whose link expired overnight should not
                  have to remember which of their addresses they registered.
                */
                params: params.email ? { email: params.email } : undefined,
              })
            }
          />

          <Button
            label="Back to sign in"
            variant="secondary"
            onPress={() => router.replace('/sign-in')}
          />
        </View>
      </AuthShell>
    );
  }

  /* ---------- set the password ---------- */
  return (
    <AuthShell
      title="Choose a new password"
      subtitle={
        user?.email
          ? `Setting the password for ${user.email}. You will stay signed in on this device.`
          : 'Setting a new password. You will stay signed in on this device.'
      }
      onBack={() => router.replace('/sign-in')}>
      <View style={styles.form}>
        <View style={[styles.icon, { backgroundColor: theme.successSoft }]}>
          <KeyRound color={theme.success} size={28} />
        </View>

        <PasswordField
          label="New password"
          placeholder="At least 8 characters"
          value={password}
          onChangeText={setPassword}
          error={submitted && tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters` : undefined}
          hint="Longer is stronger — a short phrase beats a scrambled word."
          showStrength
          autoComplete="new-password"
          textContentType="newPassword"
        />

        <PasswordField
          label="Confirm new password"
          placeholder="Type it again"
          value={confirmation}
          onChangeText={setConfirmation}
          error={
            mismatch || (submitted && confirmation !== password) ? 'Both entries must match' : undefined
          }
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
          label={pending ? 'Saving…' : 'Set new password'}
          onPress={handleSubmit}
          disabled={pending}
        />

        {/*
          ⚠ The other door, and it has to be here.

            Somebody who did not ask for this email — a forwarded message, a
            shared inbox — is now holding a live session they never wanted.
            Without this the only way off the screen is to choose a password on
            an account that may not be theirs, which is the worst of the
            available outcomes.
        */}
        {recovering && (
          <Button
            label={leaving ? 'Signing out…' : "I didn't ask for this — sign out"}
            variant="secondary"
            disabled={leaving}
            onPress={async () => {
              setLeaving(true);
              await signOut();
              setLeaving(false);
              router.replace('/sign-in');
            }}
          />
        )}

        <Text style={[styles.note, { color: theme.textMuted }]}>
          Setting a new password does not sign you out anywhere else. If you think someone else has
          had access to the account, sign out on your other devices afterwards.
        </Text>
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  loading: {
    paddingVertical: Spacing.six,
  },
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
