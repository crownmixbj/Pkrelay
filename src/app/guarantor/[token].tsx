import { useLocalSearchParams } from 'expo-router';
import { BadgeCheck, ShieldAlert, ShieldCheck } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { screenPadding } from '@/components/ui/screen';
import { NIN_LENGTH } from '@/constants/driver-validation';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  CONSENT_TEXT,
  completeVerification,
  openInvitation,
  type InvitationView,
} from '@/store/guarantor';

/**
 * The guarantor portal — the only screen in LOCI meant for somebody with no
 * account.
 *
 * ⚠ It is opened by a stranger who was not expecting it.
 *
 *   They received an unsolicited email naming somebody, asking for a national
 *   identifier. The most reasonable thing for them to do is close the tab. So
 *   this page's first job is not to collect a NIN — it is to be legible: who
 *   listed them, what LOCI is, what happens if they do nothing, and what the
 *   number is for. The form is below all of that, not above it.
 *
 * ⚠ Outside `(tabs)`, so there is no app chrome.
 *
 *   No bottom tabs, no nav bar, no prompt to sign in. Every one of those would
 *   invite a person who has no business here into the rest of the app, and
 *   would make a single-purpose page look like a product they had joined.
 */
export default function GuarantorPortal() {
  const theme = useTheme();
  const { token } = useLocalSearchParams<{ token: string }>();

  const [view, setView] = useState<InvitationView | null>(null);
  const [nin, setNin] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setView({ valid: false, reason: 'invalid' });
      return;
    }

    let cancelled = false;
    void openInvitation(String(token)).then((next) => {
      if (!cancelled) setView(next);
    });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async () => {
    setError(null);

    /*
     * ⚠ Checked here and again in the database.
     *
     *   This is a courtesy — it saves a round trip for a mistyped number. The
     *   authority is `complete_guarantor_verification`, because this page is
     *   reachable by anyone and its checks can simply be skipped.
     */
    if (nin.replace(/\D/g, '').length !== NIN_LENGTH) {
      setError(`A NIN is ${NIN_LENGTH} digits.`);
      return;
    }
    if (!agreed) {
      setError('Please tick the box to confirm you agree.');
      return;
    }

    setSaving(true);
    const outcome = await completeVerification(String(token), nin);
    setSaving(false);

    if (!outcome.ok) {
      setError(outcome.message);
      /* A spent or lapsed link should stop showing a form that cannot work. */
      if (outcome.reason === 'expired' || outcome.reason === 'completed') {
        setView({ valid: false, reason: outcome.reason });
      }
      return;
    }

    setDone(true);
  };

  return (
    <ScrollView contentContainerStyle={[styles.screen, screenPadding]}>
      <View style={styles.content}>
        <Text style={[styles.brand, { color: theme.primary }]}>LOCI</Text>

        {view === null && (
          <View style={styles.centre}>
            <ActivityIndicator color={theme.primary} />
          </View>
        )}

        {view?.valid === false && <Unusable reason={view.reason} />}

        {done && (
          <Card style={styles.card}>
            <View style={styles.row}>
              <BadgeCheck color={theme.success} size={22} />
              <Text style={[styles.title, { color: theme.text }]}>Thank you</Text>
            </View>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              Your verification is complete and their application has moved on for review. Nothing
              else is needed from you, and you can close this page.
            </Text>
          </Card>
        )}

        {view?.valid === true && !done && (
          <>
            <Card style={styles.card}>
              <View style={styles.row}>
                <ShieldCheck color={theme.primary} size={22} />
                <Text style={[styles.title, { color: theme.text }]}>
                  You have been listed as a guarantor
                </Text>
              </View>

              <Text style={[styles.body, { color: theme.textSecondary }]}>
                Hello {view.guarantorName || 'there'}. {view.driverName} has applied to drive with
                LOCI and named you as their guarantor.
              </Text>

              {/*
                ⚠ What it means, before what is asked for.

                  Somebody agreeing to stand as a guarantor should know what
                  they are agreeing to. Putting the NIN field first and the
                  explanation underneath would be collecting a national
                  identifier from a person who does not yet know why.
              */}
              <Text style={[styles.body, { color: theme.textSecondary }]}>
                Being a guarantor means you know this person and are willing to vouch for them. We
                ask for your NIN so we can confirm you are a real person — it is checked once and we
                keep only the last four digits on file.
              </Text>

              <Text style={[styles.body, { color: theme.textMuted }]}>
                If you were not expecting this, or you do not know {view.driverName}, close this
                page. Nothing happens without you.
              </Text>
            </Card>

            <Card style={styles.card}>
              <Field
                label="Your NIN"
                placeholder="12345678901"
                value={nin}
                onChangeText={(text) => setNin(text.replace(/\D/g, '').slice(0, NIN_LENGTH))}
                keyboardType="number-pad"
                maxLength={NIN_LENGTH}
                hint={`${NIN_LENGTH} digits. Yours, not the driver's.`}
              />

              <Pressable
                onPress={() => setAgreed((was) => !was)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: agreed }}
                style={styles.consent}>
                <View
                  style={[
                    styles.box,
                    { borderColor: agreed ? theme.primary : theme.border },
                    agreed && { backgroundColor: theme.primary },
                  ]}>
                  {agreed && <BadgeCheck color={theme.primaryText} size={14} />}
                </View>
                {/*
                  ⚠ The same string that is stored with the submission.

                    `CONSENT_TEXT` is rendered here and written to the row, so
                    what was agreed to and what is on file cannot drift apart.
                */}
                <Text style={[styles.consentText, { color: theme.textSecondary }]}>
                  {CONSENT_TEXT}
                </Text>
              </Pressable>

              {!!error && <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>}

              <Button
                label={saving ? 'Submitting…' : 'Confirm and verify'}
                onPress={() => void submit()}
                disabled={saving}
              />
            </Card>
          </>
        )}
      </View>

      {/*
        ⚠ Kept, where the first instinct was to strip it.

          This page has no app chrome on purpose — no tabs, no nav — because a
          stranger doing somebody a favour is not a user to be onboarded. The
          footer looked like more of the same and was nearly exempted.

          It stays for one link: Privacy Policy. This page asks a person with no
          account for their national identifier, which makes them a data subject
          under the NDPA and gives them a right to read what happens to it. A
          route to that notice is not decoration. The marketing links beside it
          are a small price.
      */}
      <Footer />
    </ScrollView>
  );
}

/**
 * ⚠ Each reason gets its own next step, because each has a different one.
 *
 *   An expired link can be re-sent by the driver; a completed one needs
 *   nothing; an invalid one probably means the URL was truncated by a mail
 *   client, which is common and fixable by opening it again from the email.
 */
function Unusable({ reason }: { reason: 'invalid' | 'expired' | 'completed' | 'unreachable' }) {
  const theme = useTheme();

  const copy = {
    completed: {
      title: 'Already done',
      body: 'This verification has already been completed. Nothing else is needed from you.',
    },
    expired: {
      title: 'This link has expired',
      body: 'Links are valid for seven days. Ask the driver to send you a new one from their LOCI application.',
    },
    invalid: {
      title: 'This link is not valid',
      body: 'Some mail apps shorten long links. Try opening it again directly from the email, or ask the driver to send a new one.',
    },
    unreachable: {
      title: 'We could not reach LOCI',
      body: 'Something is wrong at our end, not yours. Please try again in a few minutes.',
    },
  }[reason];

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <ShieldAlert color={theme.warning} size={22} />
        <Text style={[styles.title, { color: theme.text }]}>{copy.title}</Text>
      </View>
      <Text style={[styles.body, { color: theme.textSecondary }]}>{copy.body}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    maxWidth: 520,
    gap: Spacing.three,
  },
  brand: {
    ...Typography.label,
    ...font(800),
    letterSpacing: 2.4,
    marginBottom: Spacing.two,
  },
  centre: {
    paddingVertical: Spacing.six,
    alignItems: 'center',
  },
  card: {
    gap: Spacing.three,
  },
  row: {
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
  consent: {
    flexDirection: 'row',
    gap: Spacing.two,
    alignItems: 'flex-start',
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: Radius.sm,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  consentText: {
    ...Typography.caption,
    flex: 1,
    lineHeight: 18,
  },
  error: {
    ...Typography.caption,
  },
});
