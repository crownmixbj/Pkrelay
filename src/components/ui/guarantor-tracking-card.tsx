import { BadgeCheck, Clock, Mail, RefreshCw, Send, ShieldAlert } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { isValidEmail } from '@/utils/validation';
import {
  fetchGuarantorState,
  reinviteGuarantor,
  type GuarantorState,
} from '@/store/guarantor';

/**
 * Where the driver's guarantor invitation stands.
 *
 * ⚠ The address is shown in full, and that is the point of the card.
 *
 *   A driver typed their guarantor's email into a long form on a phone. The
 *   commonest reason a guarantor never answers is that the address is wrong by
 *   one character, and until now the dashboard said "Waiting on guarantor" and
 *   nothing else — so the one fault the driver could actually fix was the one
 *   thing they could not see. Masking it would be privacy theatre: it is their
 *   own guarantor, and they typed it.
 *
 * ⚠ Two timestamps, because they are two different facts.
 *
 *   "Invitation created" is when the link was minted. "Email sent" is when the
 *   provider accepted it, and it is null while the row is still in the outbox.
 *   Showing the first as though it were the second is how a driver comes to
 *   believe an email went out an hour ago when nothing has left the building —
 *   and then blames their guarantor for it.
 *
 * ⚠ It never shows the link, and there is nothing to reveal.
 *
 *   The token exists once, in the guarantor's inbox. A driver who could see it
 *   could complete their own guarantor check, which is the entire fraud this
 *   feature exists to prevent.
 */
export function GuarantorTrackingCard() {
  const theme = useTheme();

  const [state, setState] = useState<GuarantorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [correcting, setCorrecting] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');

  /*
   * ⚠ Applied from the promise's callback, not from the effect body.
   *
   *   `useEffect(() => { void load() })` where `load` sets state synchronously
   *   cascades a render before the first paint has settled. Everything here
   *   lands in a `.then`, which is what the effect is for: subscribing to an
   *   external system and setting state when it answers.
   */
  const apply = useCallback((next: GuarantorState | null) => {
    setState(next);
    setEmail(next?.guarantorEmail ?? '');
    setLoading(false);
  }, []);

  const load = useCallback(() => fetchGuarantorState().then(apply), [apply]);

  useEffect(() => {
    let cancelled = false;
    fetchGuarantorState().then((next) => {
      if (!cancelled) apply(next);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const resend = async (address?: string) => {
    setNote('');
    setEmailError('');

    if (address !== undefined && !isValidEmail(address)) {
      setEmailError('Enter a valid email address');
      return;
    }

    setSending(true);
    const outcome = await reinviteGuarantor(address);
    setSending(false);

    setNote(outcome.message);
    if (outcome.ok) {
      setCorrecting(false);
      /*
       * Re-read rather than patching local state. Re-inviting mints a new token
       * with a new expiry and retires the old one; guessing at the new values
       * here would leave the card showing an expiry that is no longer real.
       */
      await load();
    }
  };

  if (loading) {
    return (
      <Card style={styles.card}>
        <View style={styles.centre}>
          <ActivityIndicator color={theme.primary} />
        </View>
      </Card>
    );
  }

  /*
   * ⚠ Nothing, rather than an empty card.
   *
   *   `my_guarantor_status` answers with no row for an application that never
   *   had a guarantor email, and for an account with no application at all. A
   *   card headed "Guarantor" explaining that there is no guarantor is noise on
   *   a dashboard that already has a status badge.
   */
  if (!state) return null;

  const tone =
    state.state === 'completed' ? 'success' : state.state === 'expired' ? 'danger' : 'warning';

  const heading = {
    waiting: 'Waiting on your guarantor',
    completed: 'Guarantor verified',
    expired: 'The invitation expired',
  }[state.state];

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        {state.state === 'completed' ? (
          <BadgeCheck color={theme.success} size={20} />
        ) : state.state === 'expired' ? (
          <ShieldAlert color={theme.danger} size={20} />
        ) : (
          <Clock color={theme.warningOnSoft} size={20} />
        )}
        <Text style={[styles.title, { color: theme.text }]}>{heading}</Text>
        <Badge
          label={
            state.state === 'completed'
              ? 'Complete'
              : state.state === 'expired'
                ? 'Expired'
                : 'Pending submission'
          }
          tone={tone}
        />
      </View>

      {/* ---------- who, and where it went ---------- */}
      <View style={[styles.inviteBox, { backgroundColor: theme.surfaceMuted }]}>
        <View style={styles.inviteRow}>
          <Mail color={theme.textMuted} size={14} />
          <Text style={[styles.inviteLabel, { color: theme.textMuted }]}>Invitation sent to</Text>
        </View>
        {/*
          ⚠ Selectable, so a driver can copy the address out to check it.

            A misread address is the same failure as a mistyped one, and the
            character people get wrong is usually one they cannot tell apart at
            13px.
        */}
        <Text selectable style={[styles.inviteEmail, { color: theme.text }]}>
          {state.guarantorEmail}
        </Text>
        {state.guarantorName.length > 0 && (
          <Text style={[styles.inviteMeta, { color: theme.textSecondary }]}>
            Named as {state.guarantorName}
          </Text>
        )}

        <View style={[styles.divider, { backgroundColor: theme.border }]} />

        <Stamp label="Invitation created" when={state.invitedAt} />
        {/*
          ⚠ "Still queued" rather than a blank, and rather than a guess.

            A null `emailSentAt` means the outbox row has not been picked up yet.
            That is a real state with a real cause, and it is the one state where
            the right advice is "wait a minute", not "check the address".
        */}
        <Stamp
          label="Email dispatched"
          when={state.emailSentAt}
          fallback="Still queued — usually within a minute"
        />
        {state.state === 'completed' ? (
          <Stamp label="Guarantor submitted" when={state.completedAt} />
        ) : (
          <Stamp label="Link expires" when={state.expiresAt} />
        )}
        {state.invitations > 1 && (
          <Text style={[styles.inviteMeta, { color: theme.textSecondary }]}>
            {state.invitations} invitations sent for this application. Only the most recent link
            works.
          </Text>
        )}
      </View>

      {/* ---------- what to do about it ---------- */}
      {state.state === 'completed' ? (
        <Text style={[styles.body, { color: theme.textSecondary }]}>
          Your guarantor has completed their part, and your application is with our review team.
          Nothing else is needed from either of you.
        </Text>
      ) : (
        <>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            {state.state === 'expired'
              ? 'Links are valid for seven days. Send a new one — and if the address above is wrong, correct it first.'
              : 'Your guarantor fills this in themselves, through a private link. If the address above is wrong, correct it and send again — the old link stops working.'}
          </Text>

          {correcting ? (
            <>
              <Field
                label="Guarantor's email address"
                placeholder="guarantor@example.com"
                value={email}
                onChangeText={(text) => {
                  setEmail(text);
                  setEmailError('');
                }}
                error={emailError}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                hint="Sending to a new address retires the old link."
              />
              <View style={styles.actions}>
                <Button
                  label={sending ? 'Sending…' : 'Save and send'}
                  icon={(color, size) => <Send color={color} size={size} />}
                  onPress={() => void resend(email.trim())}
                  disabled={sending}
                  style={styles.action}
                />
                <Button
                  label="Cancel"
                  variant="secondary"
                  onPress={() => {
                    setCorrecting(false);
                    setEmail(state.guarantorEmail);
                    setEmailError('');
                  }}
                  disabled={sending}
                  style={styles.action}
                />
              </View>
            </>
          ) : (
            <View style={styles.actions}>
              <Button
                label={sending ? 'Sending…' : 'Send the link again'}
                icon={(color, size) => <RefreshCw color={color} size={size} />}
                onPress={() => void resend()}
                disabled={sending}
                style={styles.action}
              />
              <Button
                label="Wrong address?"
                variant="secondary"
                onPress={() => {
                  setNote('');
                  setCorrecting(true);
                }}
                disabled={sending}
                style={styles.action}
              />
            </View>
          )}
        </>
      )}

      {note.length > 0 && (
        <Text style={[styles.note, { color: theme.textSecondary }]}>{note}</Text>
      )}
    </Card>
  );
}

/**
 * One timestamp, or an honest sentence about why there isn't one.
 *
 * `toLocaleString` rather than a bespoke formatter: a driver reading this wants
 * their own device's idea of what "yesterday at 4pm" looks like.
 */
function Stamp({
  label,
  when,
  fallback = '—',
}: {
  label: string;
  when: string | null;
  fallback?: string;
}) {
  const theme = useTheme();

  return (
    <View style={styles.stamp}>
      <Text style={[styles.stampLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.stampValue, { color: when ? theme.text : theme.textMuted }]}>
        {when ? new Date(when).toLocaleString() : fallback}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.three,
  },
  centre: {
    paddingVertical: Spacing.four,
    alignItems: 'center',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  title: {
    ...Typography.cardTitle,
    ...font(700),
    flex: 1,
  },
  body: {
    ...Typography.meta,
    lineHeight: 21,
  },
  inviteBox: {
    gap: Spacing.one,
    padding: Spacing.three,
    borderRadius: Radius.md,
  },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  inviteLabel: {
    ...Typography.caption,
    ...font(600),
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  inviteEmail: {
    ...Typography.body,
    ...font(700),
  },
  inviteMeta: {
    ...Typography.caption,
    lineHeight: 18,
  },
  divider: {
    height: 1,
    marginVertical: Spacing.two,
  },
  stamp: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  stampLabel: {
    ...Typography.caption,
  },
  stampValue: {
    ...Typography.caption,
    ...font(600),
    flexShrink: 1,
    textAlign: 'right',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  action: {
    flex: 1,
    minWidth: 150,
  },
  note: {
    ...Typography.caption,
  },
});
