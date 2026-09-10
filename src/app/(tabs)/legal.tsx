import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  CircleAlert,
  Database,
  Scale,
  Share2,
  TriangleAlert,
  UserCheck,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Card } from '@/components/ui/card';
import { ChipGroup } from '@/components/ui/chip';
import { screenPadding, ScreenHeader, SectionLabel } from '@/components/ui/screen';
import {
  DATA_COLLECTED,
  LEGAL_LAST_UPDATED,
  LEGAL_REVIEW_REQUIRED,
  LEGAL_SECTIONS,
  LEGAL_SECTION_LABELS,
  PROCESSORS,
  RETENTION_UNDECIDED,
  TERMS,
  TERMS_GAPS,
  YOUR_RIGHTS,
  parseLegalSection,
  type Clause,
  type LegalSection,
} from '@/constants/legal';
import { MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Terms of Service & Privacy Policy.
 *
 * Two documents, one screen, chosen with `?section=` so the nav item can open
 * either and a shared link lands on the right one.
 *
 * The privacy notice is real: it is a field-by-field account of what this app
 * stores, read from the SQL, and it is checked against the schema by
 * `scripts/verify-about.ts`. The terms are plain-English descriptions of how
 * the service behaves and are explicitly NOT a legal document — see the banner,
 * which stays up until `LEGAL_REVIEW_REQUIRED` is turned off by a human who is
 * qualified to turn it off.
 */
export default function LegalScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ section?: string }>();
  const [section, setSection] = useState<LegalSection>(() => parseLegalSection(params.section));

  // The URL leads, so choosing "Terms of Service & Privacy Policy" from the nav
  // while already here still moves the page.
  useEffect(() => setSection(parseLegalSection(params.section)), [params.section]);

  const choose = (next: LegalSection) => {
    setSection(next);
    router.setParams({ section: next });
  };

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        <ScreenHeader
          brand={false}
          title={LEGAL_SECTION_LABELS[section]}
          subtitle={`Last updated ${new Date(LEGAL_LAST_UPDATED).toLocaleDateString()}.`}
        />

        <View style={styles.tabs}>
          <ChipGroup
            options={LEGAL_SECTIONS as unknown as string[]}
            selected={section}
            onSelect={(value) => choose(value as LegalSection)}
            renderLabel={(value) => LEGAL_SECTION_LABELS[value as LegalSection]}
            scrollable
          />
        </View>

        {/*
          Unmissable, and deliberately at the top of both sections.

          A terms page that looks finished is worse than no terms page: a user
          assumes protections that do not exist, and the operator assumes a
          position they cannot defend. This says so in the user's own words
          rather than hiding it in a code comment.
        */}
        {LEGAL_REVIEW_REQUIRED && (
          <View style={[styles.banner, { backgroundColor: theme.warningSoft }]}>
            <TriangleAlert color={theme.warningOnSoft} size={17} />
            <View style={styles.bannerText}>
              <Text style={[styles.bannerTitle, { color: theme.warningOnSoft }]}>
                Draft — not reviewed by a lawyer
              </Text>
              <Text style={[styles.bannerBody, { color: theme.warningOnSoft }]}>
                This describes how Package Relay works today. It has not been through legal review and does
                not yet cover liability, insurance, refunds or disputes. It should not be relied on
                as a contract by anyone, in either direction.
              </Text>
            </View>
          </View>
        )}

        {section === 'terms' ? <Terms /> : <Privacy />}
      </View>
      <Footer />
    </ScrollView>
  );
}

function Terms() {
  const theme = useTheme();

  return (
    <>
      <SectionLabel>How Package Relay works</SectionLabel>
      <Card style={styles.card}>
        {TERMS.map((clause, index) => (
          <ClauseRow key={clause.key} clause={clause} first={index === 0} />
        ))}
      </Card>

      {/*
        The absence, listed.

        These are the clauses that decide what happens when a parcel is lost or
        a driver is hurt. Leaving them off a page that otherwise reads as
        complete would be the misleading part.
      */}
      {LEGAL_REVIEW_REQUIRED && (
        <>
          <SectionLabel>Not covered yet</SectionLabel>
          <Card style={[styles.card, styles.gapCard]}>
            <View style={styles.gapHeader}>
              <Scale color={theme.textMuted} size={17} />
              <Text style={[styles.gapIntro, { color: theme.textSecondary }]}>
                A lawyer still needs to write these. Until they exist, none of them should be
                assumed to work in anyone&apos;s favour.
              </Text>
            </View>
            {TERMS_GAPS.map((gap) => (
              <View key={gap} style={styles.gapRow}>
                <CircleAlert color={theme.warningOnSoft} size={14} />
                <Text style={[styles.gapText, { color: theme.textSecondary }]}>{gap}</Text>
              </View>
            ))}
          </Card>
        </>
      )}
    </>
  );
}

function Privacy() {
  const theme = useTheme();

  return (
    <>
      <SectionLabel>What we collect, and why</SectionLabel>
      <Card style={styles.card}>
        {DATA_COLLECTED.map((item, index) => (
          <View
            key={item.key}
            style={[
              styles.dataRow,
              index > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.border,
              },
            ]}>
            <Database color={theme.primary} size={16} style={styles.dataIcon} />
            <View style={styles.dataText}>
              <Text style={[styles.dataWhat, { color: theme.text }]}>{item.what}</Text>
              <Text style={[styles.dataLine, { color: theme.textSecondary }]}>
                <Text style={font(700)}>Why: </Text>
                {item.why}
              </Text>
              <Text style={[styles.dataLine, { color: theme.textSecondary }]}>
                <Text style={font(700)}>Who can see it: </Text>
                {item.who}
              </Text>
            </View>
          </View>
        ))}
      </Card>

      <SectionLabel>Who else receives it</SectionLabel>
      <Card style={styles.card}>
        {PROCESSORS.map((processor, index) => (
          <View
            key={processor.key}
            style={[
              styles.dataRow,
              index > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.border,
              },
            ]}>
            <Share2 color={theme.primary} size={16} style={styles.dataIcon} />
            <View style={styles.dataText}>
              <Text style={[styles.dataWhat, { color: theme.text }]}>{processor.name}</Text>
              <Text style={[styles.dataLine, { color: theme.textSecondary }]}>
                {processor.purpose}
              </Text>
              <Text style={[styles.dataLine, { color: theme.textSecondary }]}>
                <Text style={font(700)}>Shared: </Text>
                {processor.shares}
              </Text>
            </View>
          </View>
        ))}
      </Card>

      <SectionLabel>Your rights</SectionLabel>
      <Card style={styles.card}>
        {YOUR_RIGHTS.map((right, index) => (
          <View
            key={right.key}
            style={[
              styles.dataRow,
              index > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.border,
              },
            ]}>
            <UserCheck color={theme.primary} size={16} style={styles.dataIcon} />
            <View style={styles.dataText}>
              <Text style={[styles.dataWhat, { color: theme.text }]}>{right.title}</Text>
              <Text style={[styles.dataLine, { color: theme.textSecondary }]}>{right.body}</Text>
            </View>
          </View>
        ))}
        <Text style={[styles.rightsFootnote, { color: theme.textMuted }]}>
          Exercise any of these by writing to privacy@pkrelay.ng. Under the NDPR we must answer within
          30 days.
        </Text>
      </Card>

      {/*
        Retention is the one thing a privacy notice cannot honestly hand-wave,
        and there is no policy yet. "As long as necessary" is the standard
        evasion; saying nothing at all while holding NINs is worse.
      */}
      {RETENTION_UNDECIDED && (
        <View style={[styles.banner, { backgroundColor: theme.dangerSoft }]}>
          <TriangleAlert color={theme.dangerOnSoft} size={17} />
          <View style={styles.bannerText}>
            <Text style={[styles.bannerTitle, { color: theme.dangerOnSoft }]}>
              No retention policy yet
            </Text>
            <Text style={[styles.bannerBody, { color: theme.dangerOnSoft }]}>
              We have not decided how long rejected driver applications are kept. That matters:
              those records contain a NIN and a bank account number, and holding them indefinitely
              is a real risk under the NDPR. This notice will say the actual period once one is set.
            </Text>
          </View>
        </View>
      )}
    </>
  );
}

function ClauseRow({ clause, first }: { clause: Clause; first: boolean }) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.clause,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
      ]}>
      <Text style={[styles.clauseTitle, { color: theme.text }]}>{clause.title}</Text>
      <Text style={[styles.clauseBody, { color: theme.textSecondary }]}>{clause.body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  tabs: {
    marginTop: Spacing.three,
    marginBottom: Spacing.three,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.md,
    marginBottom: Spacing.four,
  },
  bannerText: {
    flex: 1,
    gap: Spacing.half,
  },
  bannerTitle: {
    ...Typography.meta,
    ...font(700),
  },
  bannerBody: {
    ...Typography.caption,
    lineHeight: 19,
  },
  card: {
    gap: 0,
    marginBottom: Spacing.three,
  },
  clause: {
    gap: Spacing.half,
    paddingVertical: Spacing.three - 2,
  },
  clauseTitle: {
    ...Typography.meta,
    ...font(700),
  },
  clauseBody: {
    ...Typography.caption,
    lineHeight: 20,
  },
  gapCard: {
    gap: Spacing.two,
  },
  gapHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    paddingBottom: Spacing.one,
  },
  gapIntro: {
    ...Typography.caption,
    flex: 1,
    lineHeight: 19,
  },
  gapRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  gapText: {
    ...Typography.caption,
    flex: 1,
    lineHeight: 19,
  },
  dataRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two + 2,
    paddingVertical: Spacing.three - 2,
  },
  dataIcon: {
    marginTop: 2,
  },
  dataText: {
    flex: 1,
    gap: Spacing.one,
  },
  dataWhat: {
    ...Typography.meta,
    ...font(700),
    lineHeight: 20,
  },
  dataLine: {
    ...Typography.caption,
    lineHeight: 19,
  },
  rightsFootnote: {
    ...Typography.caption,
    lineHeight: 18,
    paddingTop: Spacing.three - 2,
  },
});
