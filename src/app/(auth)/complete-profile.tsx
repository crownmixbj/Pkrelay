import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AuthShell } from '@/components/ui/auth-shell';
import { Button } from '@/components/ui/button';
import { ValidatedPhoneInput } from '@/components/ValidatedPhoneInput';
import { Spacing, Typography } from '@/constants/theme';
import { isValidNigerianPhone } from '@/utils/validation';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/store/session';

/**
 * The one thing Google cannot tell us.
 *
 * ⚠ Every email sign-up has a valid Nigerian number, and a server rule rests on
 *   that.
 *
 *   `guard_application_phone` in `16_driver_identity.sql` stops a driver
 *   applicant claiming a number that is not their account's — and it
 *   deliberately lets through accounts that have *no* number, because some
 *   predate the field. A Google account arrives with none, so without this
 *   screen every one of them would be an applicant free to type any phone they
 *   like. The lock would hold for every email signup and for no Google signup,
 *   and nothing anywhere would say so.
 *
 * ⚠ Unskippable, and that is a real cost taken deliberately.
 *
 *   A Skip would be taken by most people, which leaves the gap above with more
 *   code around it. The exit is Sign out, which `completionRedirect` keeps
 *   reachable — a gate with no way back is a trap, and somebody who picked the
 *   wrong Google account needs one.
 */
export default function CompleteProfileScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { user, savePhone, signOut } = useSession();

  const [phone, setPhone] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const valid = isValidNigerianPhone(phone);

  const handleSubmit = async () => {
    setSubmitted(true);
    if (!valid || pending) return;

    setPending(true);
    setFormError(null);

    const { error } = await savePhone(phone);
    setPending(false);

    if (error) {
      setFormError(error);
      return;
    }

    /*
     * `replace`, not `push`. This screen is finished for good — leaving it on
     * the stack means the back gesture returns to a form that will immediately
     * redirect away again.
     */
    router.replace('/');
  };

  return (
    <AuthShell
      title="One more thing"
      subtitle={
        user?.email
          ? `Signed in as ${user.email}. We need a phone number before you can send a parcel.`
          : 'We need a phone number before you can send a parcel.'
      }>
      <View style={styles.form}>
        <ValidatedPhoneInput value={phone} onChangeText={setPhone} showError={submitted} />

        {/*
          ⚠ Says who uses it, because "we need your number" invites the
            question and the honest answer is short.
        */}
        <Text style={[styles.why, { color: theme.textMuted }]}>
          Drivers call this number to arrange pickup, and it is the number your driver application
          would be checked against. Google does not share a phone number, so this is the one thing
          we have to ask you for.
        </Text>

        {!!formError && (
          <View style={[styles.formError, { backgroundColor: theme.dangerSoft }]}>
            <Text style={[styles.formErrorText, { color: theme.dangerOnSoft }]}>{formError}</Text>
          </View>
        )}

        <Button
          label={pending ? 'Saving…' : 'Continue'}
          onPress={handleSubmit}
          disabled={!valid || pending}
        />

        {/*
          ⚠ The way out.

            Somebody who signed in with the wrong Google account, or who does
            not want to give a number, must not be held on a form with nothing
            but a disabled button. `completionRedirect` keeps the auth routes
            reachable so this works.
        */}
        <Button
          label="Sign out instead"
          variant="secondary"
          onPress={() => void signOut()}
          disabled={pending}
        />
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  form: { gap: Spacing.three },
  why: { ...Typography.caption, lineHeight: 19 },
  formError: { padding: Spacing.three - 2, borderRadius: 10 },
  formErrorText: { ...Typography.caption },
});
