import { useLocalSearchParams } from 'expo-router';
import {
  BadgeCheck,
  Briefcase,
  FileSignature,
  MapPin,
  ShieldAlert,
  ShieldCheck,
  User,
} from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { ValidatedPhoneInput } from '@/components/ValidatedPhoneInput';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dropdown } from '@/components/ui/dropdown';
import { Field } from '@/components/ui/field';
import { AddressLookup } from '@/components/ui/address-lookup';
import { GuarantorUploadCard } from '@/components/ui/guarantor-upload-card';
import { screenPadding } from '@/components/ui/screen';
import {
  CONSENT_TEXT,
  EMPLOYMENT_STATUSES,
  GUARANTOR_LINK_DAYS,
  GUARANTOR_PRIVACY_NOTE,
  KNOWN_DURATIONS,
  SURETYSHIP_CLAUSE,
  needsEmployer,
} from '@/constants/guarantor';
import { GUARANTOR_RELATIONSHIPS, NIN_LENGTH } from '@/constants/driver-validation';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { isValidEmail, isValidNigerianPhone, nigerianPhoneError } from '@/utils/validation';
import { completeVerification, openInvitation, type InvitationView } from '@/store/guarantor';

/**
 * The guarantor portal — the only screen in Package Relay meant for somebody with no
 * account.
 *
 * ⚠ It is opened by a stranger who was not expecting it.
 *
 *   They received an unsolicited email naming somebody, asking for a national
 *   identifier, a photograph of their ID, their face, and a signature under a
 *   liability clause. The most reasonable thing for them to do is close the tab.
 *   So this page's first job is not to collect anything — it is to be legible:
 *   who listed them, what Package Relay is, what happens if they do nothing, and
 *   what each thing is for. The form is below all of that, not above it.
 *
 * ⚠ The order of the sections is the order of trust, not the order of the table.
 *
 *   Who they are, then what they do, then their identity documents, and the
 *   liability clause last — because the clause is the part a reasonable person
 *   might refuse, and asking for a face before they have read it means holding a
 *   photograph of somebody who then said no. Each section is a card, so somebody
 *   on a phone can see where they are in it.
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

  /*
   * ⚠ The "no token at all" case is the initial state, not an effect.
   *
   *   Setting it inside the effect is a setState in an effect body, which
   *   cascades a render for a value that was knowable before the first one —
   *   there is no token in the URL, and no amount of waiting will produce one.
   */
  const [view, setView] = useState<InvitationView | null>(() =>
    token ? null : { valid: false, reason: 'invalid' },
  );
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* The guarantor's own details. */
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('+234');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [relationship, setRelationship] = useState('');
  const [duration, setDuration] = useState('');

  /* Professional background. */
  const [employment, setEmployment] = useState('');
  const [company, setCompany] = useState('');
  const [jobTitle, setJobTitle] = useState('');

  /* Identity. */
  const [nin, setNin] = useState('');
  const [idUploaded, setIdUploaded] = useState(false);
  const [photoUploaded, setPhotoUploaded] = useState(false);

  /* The two agreements, and the signature. */
  const [agreedConsent, setAgreedConsent] = useState(false);
  const [agreedClause, setAgreedClause] = useState(false);
  const [signature, setSignature] = useState('');

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    void openInvitation(String(token)).then((next) => {
      if (cancelled) return;
      setView(next);
      /*
       * ⚠ Pre-filled, not locked.
       *
       *   The address the invitation went to is almost always the guarantor's
       *   own, so pre-filling saves typing. Locking it would be wrong: a driver
       *   who used a work address, or a shared family inbox, would force the
       *   guarantor to file a contact address that is not theirs. Both values are
       *   kept — a mismatch is something an admin should see, and is one of the
       *   more useful signals on the review screen.
       */
      if (next.valid) setEmail(next.guarantorEmail);
    });

    return () => {
      cancelled = true;
    };
  }, [token]);

  /**
   * ⚠ Checked here and again in the database, and the database is the authority.
   *
   *   This is a courtesy — it saves a round trip and it can point at the field
   *   that is wrong, which a server refusal cannot. The page is reachable by
   *   anyone and every check on it can simply be skipped, so
   *   `complete_guarantor_verification` repeats all of them.
   */
  const problem = useMemo((): string | null => {
    if (fullName.trim().split(/\s+/).length < 2) return 'Enter your first and last name.';
    if (!isValidNigerianPhone(phone)) {
      return nigerianPhoneError(phone) ?? 'Enter a valid Nigerian WhatsApp number.';
    }
    if (!isValidEmail(email)) return 'Enter a valid email address.';
    if (address.trim().length < 10) return 'Enter your full residential address.';
    if (!relationship) return 'Choose how you know this person.';
    if (!duration) return 'Choose how long you have known them.';
    if (!employment) return 'Choose your employment status.';
    if (needsEmployer(employment) && company.trim().length === 0) {
      return 'Enter the name of your employer or business.';
    }
    if (needsEmployer(employment) && jobTitle.trim().length === 0) return 'Enter your job title.';
    if (nin.replace(/\D/g, '').length !== NIN_LENGTH) return `A NIN is ${NIN_LENGTH} digits.`;
    if (!idUploaded) return 'Attach a photo of your government ID.';
    if (!photoUploaded) return 'Take your live photo.';
    if (!agreedConsent) return 'Tick the box to confirm your NIN is your own.';
    if (!agreedClause) return 'Read and accept the guarantor declaration.';
    /*
     * ⚠ Compared the same way the database compares it — case and spacing
     *   ignored — so a submission this page accepts is never refused there for a
     *   reason this page could have explained.
     */
    const tidy = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
    if (tidy(signature) !== tidy(fullName)) {
      return 'Sign with the same full name you entered above.';
    }
    return null;
  }, [
    fullName,
    phone,
    email,
    address,
    relationship,
    duration,
    employment,
    company,
    jobTitle,
    nin,
    idUploaded,
    photoUploaded,
    agreedConsent,
    agreedClause,
    signature,
  ]);

  const submit = async () => {
    setError(null);

    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    const outcome = await completeVerification(String(token), {
      nin,
      fullName: fullName.trim(),
      whatsappPhone: phone.trim(),
      email: email.trim(),
      residentialAddress: address.trim(),
      relationship,
      knownDuration: duration,
      employmentStatus: employment,
      companyName: needsEmployer(employment) ? company.trim() : '',
      jobTitle: needsEmployer(employment) ? jobTitle.trim() : '',
      signatureName: signature.trim(),
      /*
       * ⚠ The wording travels with the submission.
       *
       *   Both strings are stored in the row, so what was on the screen and what
       *   is on file cannot drift apart. A server filling in its own current
       *   wording would produce a record of somebody agreeing to a paragraph
       *   they may never have seen.
       */
      consentText: CONSENT_TEXT,
      declarationText: SURETYSHIP_CLAUSE,
    });
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
        <Text style={[styles.brand, { color: theme.primary }]}>PKRELAY</Text>

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
            <Text style={[styles.body, { color: theme.textMuted }]}>
              Keep this in mind: you have agreed to stand as this person&apos;s guarantor. If you
              change your mind, write to us and we will tell them their application needs a
              different guarantor.
            </Text>
          </Card>
        )}

        {view?.valid === true && !done && (
          <>
            {/* ---------- 1. what this is, before anything is asked ---------- */}
            <Card style={styles.card}>
              <View style={styles.row}>
                <ShieldCheck color={theme.primary} size={22} />
                <Text style={[styles.title, { color: theme.text }]}>
                  You have been listed as a guarantor
                </Text>
              </View>

              <Text style={[styles.body, { color: theme.textSecondary }]}>
                Hello {view.guarantorName || 'there'}. {view.driverName} has applied to drive with
                Package Relay and named you as their guarantor.
              </Text>

              {/*
                ⚠ The applicant's details, read-only, and there are only two.

                  A guarantor needs to know who they are vouching for and have
                  something to quote if they telephone us. They do not need this
                  person's phone number, address or NIN, and
                  `open_guarantor_invitation` deliberately does not return them —
                  whoever opened this link may not be the guarantor at all.
              */}
              <View style={[styles.applicant, { backgroundColor: theme.surfaceMuted }]}>
                <ReadOnly label="Applicant" value={view.driverName} />
                <ReadOnly label="Application reference" value={view.reference || '—'} />
                <ReadOnly
                  label="Invitation sent to"
                  value={view.guarantorEmail || '—'}
                />
              </View>

              <Text style={[styles.body, { color: theme.textSecondary }]}>
                Being a guarantor means you know this person and are willing to vouch for them. We
                ask for your NIN and a photo of your ID so we can confirm you are a real person — we
                keep only the last four digits of the NIN where staff can see it.
              </Text>

              <Text style={[styles.body, { color: theme.textMuted }]}>
                {GUARANTOR_PRIVACY_NOTE}
              </Text>

              <Text style={[styles.body, { color: theme.textMuted }]}>
                If you were not expecting this, or you do not know {view.driverName}, close this
                page. Nothing happens without you.
              </Text>
            </Card>

            {/* ---------- 2. who they are ---------- */}
            <Card style={styles.card}>
              <SectionTitle icon={<User color={theme.primary} size={18} />} label="Your details" />

              <Field
                label="Your full name"
                placeholder="As it appears on your ID"
                value={fullName}
                onChangeText={setFullName}
                autoCapitalize="words"
                hint="First and last name."
              />

              {/*
                ⚠ `ValidatedPhoneInput`, not a plain `Field`.

                  A plain field accepted `+2348123663667334434343434343` — twenty-four
                  digits, which is not a phone number anywhere on earth. The submit
                  check would have caught it, but only after the guarantor had filled
                  in a NIN, photographed an ID and taken a live photo, and the refusal
                  named a field they had long scrolled past. The mask is the fix: it
                  rewrites every keystroke to `+234` plus at most ten national digits,
                  so a number that is too long cannot be typed in the first place, and
                  `maxLength` stops the keyboard rather than explaining afterwards.

                ⚠ WhatsApp, said explicitly, because that is where a recovery
                  conversation will actually happen. A number that is not on it is a
                  number nobody will reach — so the hint overrides the component's
                  default rather than inheriting the generic one.
              */}
              <ValidatedPhoneInput
                label="WhatsApp phone number"
                value={phone}
                onChangeText={setPhone}
                hint="Your local number — we add +234. We only use it if there is ever a dispute about a parcel."
              />

              <Field
                label="Your email address"
                placeholder="you@example.com"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                hint="Change it if this is not the address you use."
              />

              {/*
                ⚠ `AddressLookup`, not `AddressField`, and not a plain `Field`.

                  A plain field made the guarantor type an address from memory
                  into a box with no help at all — on a phone, as a favour, for
                  somebody else's job application. `AddressField` would be worse
                  than nothing: it resolves what you type down to one of 37
                  Package Relay cities because a quote is priced per city, and
                  reducing "14 Bode Thomas, Surulere" to "Lagos" destroys the
                  only part of an address that a person standing at the door
                  needs. `AddressLookup` keeps the address and adds the
                  suggestions.

                  It works here without an account: `places-lookup` authenticates
                  with whatever key the client holds and checks no caller, so the
                  anon key the portal already uses is enough.

                  ⚠ Typing freely still works. Suggestions are an accelerator,
                    never a gate — Nigerian addresses are routinely absent from
                    Google, and a guarantor whose street is a new estate or
                    "behind the second gate" must still be able to submit.
              */}
              <AddressLookup
                label="Residential address"
                icon={(color, size) => <MapPin color={color} size={size} />}
                placeholder="14 Awolowo Road, Ikoyi, Lagos"
                value={address}
                onChange={(next) => setAddress(next.address)}
                multiline
                hint="Start typing and pick your street, or type it in full."
              />

              <Dropdown
                label="How do you know them?"
                placeholder="Choose one"
                options={GUARANTOR_RELATIONSHIPS}
                selected={relationship as (typeof GUARANTOR_RELATIONSHIPS)[number]}
                onSelect={(value) => setRelationship(value)}
              />

              <Dropdown
                label="How long have you known them?"
                placeholder="Choose one"
                options={KNOWN_DURATIONS}
                selected={duration as (typeof KNOWN_DURATIONS)[number]}
                onSelect={(value) => setDuration(value)}
              />
            </Card>

            {/* ---------- 3. what they do ---------- */}
            <Card style={styles.card}>
              <SectionTitle
                icon={<Briefcase color={theme.primary} size={18} />}
                label="Your work"
              />

              <Dropdown
                label="Employment status"
                placeholder="Choose one"
                options={EMPLOYMENT_STATUSES}
                selected={employment as (typeof EMPLOYMENT_STATUSES)[number]}
                onSelect={(value) => setEmployment(value)}
              />

              {/*
                ⚠ Only asked of people who have an employer.

                  Requiring a company name of everybody makes a retired guarantor
                  type something untrue into a form that is about to ask them to
                  sign it. `complete_guarantor_verification` applies the same rule,
                  because the client is not the authority on its own validation.
              */}
              {needsEmployer(employment) && (
                <>
                  <Field
                    label="Employer or business name"
                    value={company}
                    onChangeText={setCompany}
                    autoCapitalize="words"
                  />
                  <Field
                    label="Your job title"
                    value={jobTitle}
                    onChangeText={setJobTitle}
                    autoCapitalize="words"
                  />
                </>
              )}
            </Card>

            {/* ---------- 4. proving they are a real person ---------- */}
            <Card style={styles.card}>
              <SectionTitle
                icon={<ShieldCheck color={theme.primary} size={18} />}
                label="Confirming your identity"
              />

              <Field
                label="Your NIN"
                placeholder="12345678901"
                value={nin}
                onChangeText={(text) => setNin(text.replace(/\D/g, '').slice(0, NIN_LENGTH))}
                keyboardType="number-pad"
                maxLength={NIN_LENGTH}
                hint={`${NIN_LENGTH} digits. Yours, not the driver's.`}
              />

              <GuarantorUploadCard
                token={String(token)}
                kind="government_id"
                hint="Your NIN slip or NIN card only — the number on it must match the NIN you entered above. Make sure the name, number and photo are readable."
                uploaded={idUploaded}
                onUploaded={() => setIdUploaded(true)}
                onCleared={() => setIdUploaded(false)}
                disabled={saving}
              />

              <GuarantorUploadCard
                token={String(token)}
                kind="live_photo"
                hint="Taken now, with your camera — a saved picture cannot be used. It shows that the person agreeing to this is the person holding the ID."
                uploaded={photoUploaded}
                onUploaded={() => setPhotoUploaded(true)}
                onCleared={() => setPhotoUploaded(false)}
                disabled={saving}
              />
            </Card>

            {/* ---------- 5. the part they might refuse, last ---------- */}
            <Card style={styles.card}>
              <SectionTitle
                icon={<FileSignature color={theme.primary} size={18} />}
                label="Guarantor declaration"
              />

              {/*
                ⚠ The clause is shown in full, not summarised, and not behind a
                  link.

                  It is the only part of this page that creates an obligation. A
                  summary with "see full terms" is how people come to sign
                  something they have not read, and the wording stored in the row
                  is this exact string — so the screen and the record are the same
                  sentence by construction.
              */}
              <View style={[styles.clause, { backgroundColor: theme.surfaceMuted }]}>
                <Text style={[styles.clauseText, { color: theme.text }]}>{SURETYSHIP_CLAUSE}</Text>
              </View>

              <CheckRow
                checked={agreedConsent}
                onToggle={() => setAgreedConsent((was) => !was)}
                label={CONSENT_TEXT}
              />

              <CheckRow
                checked={agreedClause}
                onToggle={() => setAgreedClause((was) => !was)}
                label="I have read the declaration above and I accept it."
              />

              <Field
                label="Type your full name to sign"
                placeholder={fullName || 'Your full name'}
                value={signature}
                onChangeText={setSignature}
                autoCapitalize="words"
                hint="It has to match the name you entered above."
              />

              {/*
                ⚠ The timestamp is shown, and it is not the one that is stored.

                  The row is stamped by the database at the moment it is written.
                  This line exists so the person signing knows a time is being
                  recorded — a signature with an invisible date is the kind of
                  thing people are right to be uneasy about. It says "will be
                  recorded" rather than presenting itself as the record.
              */}
              <Text style={[styles.stamp, { color: theme.textMuted }]}>
                Signed {new Date().toLocaleString()} — the exact time is recorded with your
                submission.
              </Text>

              {!!error && <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>}

              {/*
                ⚠ Enabled, and it explains the refusal.

                  A disabled Submit on a form this long leaves somebody hunting
                  for what is missing. Pressing it names the first thing that is
                  not right, in the order the form asks for it.
              */}
              <Button
                label={saving ? 'Submitting…' : 'Sign and submit'}
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
          account for their national identifier, their ID and their photograph,
          which makes them a data subject under the NDPA and gives them a right to
          read what happens to it. A route to that notice is not decoration.
      */}
      <Footer />
    </ScrollView>
  );
}

function SectionTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      {icon}
      <Text style={[styles.sectionTitle, { color: theme.text }]}>{label}</Text>
    </View>
  );
}

/** An applicant detail the guarantor may read and may not change. */
function ReadOnly({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.readOnly}>
      <Text style={[styles.readOnlyLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.readOnlyValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

/** A tick box whose label is the wording that gets stored. */
function CheckRow({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      style={styles.consent}>
      <View
        style={[
          styles.box,
          { borderColor: checked ? theme.primary : theme.border },
          checked && { backgroundColor: theme.primary },
        ]}>
        {checked && <BadgeCheck color={theme.primaryText} size={14} />}
      </View>
      <Text style={[styles.consentText, { color: theme.textSecondary }]}>{label}</Text>
    </Pressable>
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
      body: `Links are valid for ${GUARANTOR_LINK_DAYS} days. Ask the driver to send you a new one from their Package Relay application.`,
    },
    invalid: {
      title: 'This link is not valid',
      body: 'Some mail apps shorten long links. Try opening it again directly from the email, or ask the driver to send a new one.',
    },
    unreachable: {
      title: 'We could not reach Package Relay',
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
  sectionTitle: {
    ...Typography.cardTitle,
    ...font(700),
    flex: 1,
  },
  body: {
    ...Typography.meta,
    lineHeight: 21,
  },
  applicant: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.md,
  },
  readOnly: {
    gap: 2,
  },
  readOnlyLabel: {
    ...Typography.caption,
    ...font(600),
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  readOnlyValue: {
    ...Typography.body,
    ...font(600),
  },
  clause: {
    padding: Spacing.three,
    borderRadius: Radius.md,
  },
  clauseText: {
    ...Typography.caption,
    lineHeight: 19,
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
  stamp: {
    ...Typography.caption,
  },
  error: {
    ...Typography.caption,
  },
});
