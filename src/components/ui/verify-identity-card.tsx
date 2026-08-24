import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { IdentityOnboarding } from '@/components/ui/identity-onboarding';
import { LiveSelfieCard } from '@/components/ui/live-selfie-card';
import { showToast } from '@/components/ui/toast';
import { Spacing, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  ninError,
  submitOnboarding,
  verificationPath,
  type SenderIdentity,
} from '@/store/identity';

/**
 * Verifying a sender's identity, on their profile rather than mid-booking.
 *
 * ⚠ Moved here from the booking form, and the move is the point.
 *
 *   The NIN and slip used to be step two of Post a Parcel, asked of everybody
 *   posting their first parcel. That put a government ID check in the middle of
 *   somebody trying to send a package — the highest-intent moment in the app
 *   and the worst possible place to interrupt. It belongs to the account, so it
 *   now lives with the account.
 *
 * ⚠ The selfie is not optional here, even though the NIN fields look like a form.
 *
 *   `submitOnboarding` does not merely store a number. It matches the slip
 *   against a live photograph and, on a match, promotes that photograph to the
 *   account's master reference — which is what every later parcel's selfie is
 *   compared against. Without the selfie there is nothing to match and nothing
 *   to compare against later, so the whole check would be a text field that
 *   files a number nobody has confirmed belongs to the person typing it.
 *
 * ⚠ Nothing here blocks anything.
 *
 *   A sender who never opens this can still post parcels; their per-parcel
 *   selfie is recorded rather than matched. That is deliberate — see
 *   `book.tsx`. This card is the way to become verified, not a gate.
 */
export function VerifyIdentityCard({
  identity,
  onVerified,
}: {
  identity: SenderIdentity | null;
  /** Called once the check has run, so the profile can re-read the record. */
  onVerified: () => void;
}) {
  const theme = useTheme();

  const [nin, setNin] = useState('');
  const [slipUri, setSlipUri] = useState('');
  const [errors, setErrors] = useState<{ nin?: string; slip?: string }>({});
  const [session, setSession] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const path = verificationPath(identity);

  /*
   * ⚠ Only when there is something to do.
   *
   *   `onboarding` means unverified or half-finished. Anyone past that has
   *   either a verified record — shown by the badge and the NIN row above — or
   *   a flagged one, which is a support conversation rather than a form to
   *   fill in again.
   */
  if (path !== 'onboarding') return null;

  /*
   * ⚠ The NIN and slip are checked before the camera opens, not after.
   *
   *   `submitOnboarding` runs inside `onCaptured`, so a missing NIN would only
   *   surface *after* somebody had photographed their own face — work thrown
   *   away for a validation error that was knowable beforehand. The gate is
   *   where that gets caught.
   */
  const gate = (proceed: () => void) => {
    const next: { nin?: string; slip?: string } = {};

    const badNin = ninError(nin);
    if (badNin) next.nin = badNin;
    if (!slipUri) next.slip = 'Add a photo of your NIN slip.';

    setErrors(next);
    if (Object.keys(next).length > 0) {
      showToast('Add your NIN first', {
        message: 'Your NIN and a photo of the slip are needed before the selfie.',
      });
      return;
    }

    proceed();
  };

  const onCaptured = async (sessionId: string) => {
    setSession(sessionId);

    const outcome = await submitOnboarding({ nin, slipUri, sessionId });

    if (!outcome.ok) {
      /*
       * Said plainly and left recoverable. Unlike the booking form — where a
       * failed check must never look like a failed shipment — there is no
       * parcel riding on this, so the honest thing is to report it and let
       * them try again.
       */
      setNote(outcome.error);
      return;
    }

    setNote(outcome.message);
    onVerified();
  };

  return (
    <View style={styles.block}>
      <Text style={[styles.intro, { color: theme.textMuted }]}>
        {/*
          Says why it is being asked, once. The booking form used to carry this
          explanation at the moment somebody was trying to send something.
        */}
        Verifying once here means every parcel you send afterwards needs only a quick selfie.
      </Text>

      <IdentityOnboarding
        path={path}
        identity={identity}
        nin={nin}
        onNin={(next) => {
          setNin(next);
          setErrors((was) => ({ ...was, nin: undefined }));
        }}
        ninError={errors.nin}
        slipUri={slipUri}
        onSlip={(next) => {
          setSlipUri(next);
          setErrors((was) => ({ ...was, slip: undefined }));
        }}
        slipError={errors.slip}
      />

      <LiveSelfieCard
        purpose="sender"
        captured={session}
        note={note}
        onCaptured={onCaptured}
        onCleared={() => {
          setSession(null);
          setNote('');
        }}
        gate={gate}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: Spacing.three,
  },
  intro: {
    ...Typography.caption,
    lineHeight: 18,
  },
});
