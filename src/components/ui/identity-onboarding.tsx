import { BadgeCheck, IdCard, ShieldAlert, TriangleAlert } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { PhotoPicker } from '@/components/ui/photo-picker';
import { SectionLabel } from '@/components/ui/screen';
import { NIN_LENGTH } from '@/constants/driver-validation';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  maskNin,
  maskNinInput,
  pathExplanation,
  type SenderIdentity,
  type VerificationPath,
} from '@/store/identity';

/**
 * The identity block on Post a Parcel.
 *
 * Shows the whole onboarding form on a sender's first parcel and collapses to a
 * single reassuring line on every one after — which is the entire point of the
 * feature, so the collapsed state is the one to get right.
 *
 * ⚠ This asks for a government identifier and a face. Two things follow from
 *   that and both are visible below rather than buried in a policy page: the
 *   sender is told what happens to each item before they hand it over, and the
 *   NIN is never rendered back in full once stored.
 */
export function IdentityOnboarding({
  path,
  identity,
  nin,
  onNin,
  ninError,
  slipUri,
  onSlip,
  slipError,
}: {
  path: VerificationPath;
  identity: SenderIdentity | null;
  nin: string;
  onNin: (value: string) => void;
  ninError?: string;
  slipUri: string;
  onSlip: (uri: string) => void;
  slipError?: string;
}) {
  const theme = useTheme();

  /*
   * Everything except the first parcel: one line, no fields.
   *
   * A sender who has already onboarded should see that the thing they did once
   * is still doing its job, and then nothing else. Repeating the explanation on
   * every parcel would make a solved problem look like an ongoing one.
   */
  if (path !== 'onboarding') {
    const flagged = identity?.status === 'flagged';

    return (
      <View style={[styles.settled, { backgroundColor: theme.surfaceMuted }]}>
        {flagged ? (
          <TriangleAlert color={theme.warningOnSoft} size={16} />
        ) : (
          <BadgeCheck color={theme.success} size={16} />
        )}
        <Text style={[styles.settledText, { color: theme.textSecondary }]}>
          {flagged
            ? 'Your details are being reviewed. Your parcels still go out as normal.'
            : `Identity confirmed · NIN ${maskNin(identity?.ninLast4 ?? null)}`}
          {'\n'}
          <Text style={{ color: theme.textMuted }}>{pathExplanation(path)}</Text>
        </Text>
      </View>
    );
  }

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <IdCard color={theme.primary} size={18} />
        <Text style={[styles.title, { color: theme.text }]}>Verify your identity</Text>
      </View>

      <Text style={[styles.intro, { color: theme.textSecondary }]}>
        {pathExplanation('onboarding')}
      </Text>

      <SectionLabel>Your NIN</SectionLabel>
      <Field
        label="National Identification Number"
        icon={(color, size) => <IdCard color={color} size={size} />}
        placeholder="12345678901"
        keyboardType="number-pad"
        maxLength={NIN_LENGTH}
        value={nin}
        onChangeText={(text) => onNin(maskNinInput(text))}
        error={ninError}
      />
      {/*
        Said before they type it, not after.

        The NIN goes to Dojah — matching against a government record requires
        telling them which record — and somebody handing over a national
        identifier is entitled to know that before rather than in a policy page
        afterwards.
      */}
      <Text style={[styles.note, { color: theme.textMuted }]}>
        Used once, to check your NIN photo against your selfie. We store the last four digits.
      </Text>

      <SectionLabel>Your NIN slip</SectionLabel>
      <PhotoPicker
        label="Photo of your NIN slip"
        value={slipUri}
        onChange={onSlip}
        error={slipError}
      />
      <Text style={[styles.note, { color: theme.textMuted }]}>
        Kept in case something is ever disputed. Your selfie is matched against the NIMC record, not
        against this photo.
      </Text>

      <View style={[styles.privacy, { backgroundColor: theme.primarySoft }]}>
        <ShieldAlert color={theme.primaryOnSoft} size={16} />
        <Text style={[styles.privacyText, { color: theme.primaryOnSoft }]}>
          Your selfie is kept as your reference photo so later parcels only need a quick selfie. It
          is visible to you and to Package Relay staff reviewing an issue — never to a driver or a recipient.
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two },
  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  title: { ...Typography.sectionTitle },
  intro: { ...Typography.meta, lineHeight: 20 },
  note: { ...Typography.caption, lineHeight: 17 },
  privacy: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.two + 2,
    borderRadius: Radius.md,
  },
  privacyText: { ...Typography.caption, lineHeight: 17, flex: 1 },
  settled: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.two + 2,
    borderRadius: Radius.md,
  },
  settledText: { ...Typography.caption, lineHeight: 18, flex: 1, ...font(500) },
});
