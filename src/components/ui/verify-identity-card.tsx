import { ShieldQuestion } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { IdentityOnboarding } from '@/components/ui/identity-onboarding';
import { LiveSelfieCard } from '@/components/ui/live-selfie-card';
import { showToast } from '@/components/ui/toast';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  maskNin,
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
 * ⚠ This card is now the only way to send a parcel at all.
 *
 *   It used to be optional: a sender who never opened it could still post, and
 *   their per-parcel selfie was recorded rather than matched. `42_verified_
 *   senders_only.sql` ended that — the database refuses a booking from anyone
 *   who is not verified. So this is no longer "the way to become verified", it
 *   is the front door.
 *
 * ⚠ There is no Submit button, and that confused somebody, correctly.
 *
 *   Taking the selfie *is* the submit: `onCaptured` runs the whole thing. That
 *   is deliberate — a separate button would let a person capture a face,
 *   wander off, and leave a live photo sitting in a form. What was missing was
 *   the receipt. The form gave no sign anything had been sent, and on reload it
 *   asked again from scratch, which reads exactly like a submission that was
 *   lost.
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
  /*
   * ⚠ Whether the note is good news, so the card does not paint it green.
   *
   *   Only a confirmed identity is good news now. Everything else is "saved,
   *   waiting" — which is fine, and is not a tick.
   */
  const [noteIsGood, setNoteIsGood] = useState(true);
  /** Set the moment a submission lands, so the form can become a receipt. */
  const [justSubmitted, setJustSubmitted] = useState(false);
  /** Set when somebody deliberately chooses to replace what they already sent. */
  const [resubmitting, setResubmitting] = useState(false);

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
   * ⚠ Somebody waiting on a review is shown a receipt, not a blank form.
   *
   *   `verificationPath` returns `onboarding` for `pending`, because that used
   *   to mean "started and abandoned". It now also means "submitted, waiting
   *   for a person" — and showing that person the empty form again is worse
   *   than merely confusing: filling it in calls `begin_identity_check`, which
   *   clears the review and puts them at the *back* of the queue. The app would
   *   be inviting them to undo their own progress.
   *
   *   A NIN on file is what distinguishes the two. Somebody who abandoned
   *   halfway has none, and still gets the form.
   */
  const submitted =
    !resubmitting &&
    (justSubmitted || (identity?.ninLast4 !== null && identity?.ninLast4 !== undefined));

  if (submitted && identity?.status !== 'rejected') {
    return (
      <View
        style={[
          styles.receipt,
          { backgroundColor: theme.surfaceMuted, borderColor: theme.border },
        ]}>
        <View style={styles.receiptHead}>
          <ShieldQuestion color={theme.warningOnSoft} size={18} />
          <Text style={[styles.receiptTitle, { color: theme.text }]}>
            Your ID is with us and waiting to be checked
          </Text>
        </View>

        <Text style={[styles.intro, { color: theme.textSecondary }]}>
          {note.length > 0
            ? note
            : `We have your NIN (${maskNin(identity?.ninLast4 ?? null)}), a photo of your slip and your selfie. A person reviews it and we will email you — you can send parcels once it is approved.`}
        </Text>

        {/*
          ⚠ Resubmitting is offered, and made deliberate.

            It is the only way out if they photographed the wrong slip, so it
            cannot be hidden. But it costs them their place in the queue, so it
            says so rather than sitting there looking like the obvious next
            step.
        */}
        <Pressable
          onPress={() => {
            setJustSubmitted(false);
            setSession(null);
            setNote('');
            setNoteIsGood(true);
            setResubmitting(true);
          }}
          accessibilityRole="button"
          style={({ pressed }) => [styles.again, pressed && styles.pressed]}>
          <Text style={[styles.againText, { color: theme.primary }]}>
            Submitted the wrong details? Start again — this puts you back at the end of the queue.
          </Text>
        </Pressable>
      </View>
    );
  }

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
       * Said plainly and left recoverable. Nothing was stored, so the only
       * honest thing is to report it and let them try again.
       */
      setNote(outcome.error);
      setNoteIsGood(false);
      return;
    }

    setNote(outcome.message);
    /*
     * ⚠ Only 'verified' is a tick.
     *
     *   'flagged' and 'unavailable' both mean stored-and-waiting, which is a
     *   perfectly good outcome and is not the same as done. Colouring them
     *   green under a heading saying "checked" is what made a failed check read
     *   as a success.
     */
    setNoteIsGood(outcome.status === 'verified');
    setJustSubmitted(true);
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
        noteIsGood={noteIsGood}
        onCaptured={onCaptured}
        onCleared={() => {
          setSession(null);
          setNote('');
          setNoteIsGood(true);
        }}
        gate={gate}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  receipt: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  receiptHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  receiptTitle: { ...Typography.body, ...font(700), flex: 1 },
  again: { paddingTop: Spacing.one },
  againText: { ...Typography.caption, lineHeight: 18 },
  pressed: { opacity: 0.6 },
  block: {
    gap: Spacing.three,
  },
  intro: {
    ...Typography.caption,
    lineHeight: 18,
  },
});
