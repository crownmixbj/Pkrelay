import { useRouter } from 'expo-router';
import {
  ArrowRight,
  Building2,
  Clock,
  Handshake,
  MapPinned,
  PackageOpen,
  ShieldCheck,
  Sparkles,
  Store,
  Target,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react-native';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { screenPadding, SectionLabel } from '@/components/ui/screen';
import {
  HERO_SERVICES,
  SERVICES,
  servicePrefillParams,
  type ServiceId,
} from '@/constants/services';
import { FontSize, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { CITIES, formatNaira, PRICING } from '@/store/bookings';

/** Icon per service — the catalogue carries copy, this carries the visual. */
const SERVICE_ICONS: Record<ServiceId, typeof Zap> = {
  'same-day-local': Clock,
  'interstate-express': Zap,
  'insured-parcels': ShieldCheck,
};

const VALUES = [
  {
    key: 'reach',
    title: 'Nationwide reach',
    body: `Hubs and riders across ${CITIES.length} cities, from Ibadan and Lagos to Kano and Port Harcourt.`,
    icon: (color: string, size: number) => <MapPinned color={color} size={size} />,
  },
  {
    key: 'traders',
    title: 'Built for traders',
    body: 'Market sellers, online shops and offices move stock daily. Volume pricing keeps that affordable.',
    icon: (color: string, size: number) => <Store color={color} size={size} />,
  },
  {
    key: 'riders',
    title: 'Riders who earn well',
    body: 'Drivers say where they are going and Package Relay offers them parcels on that route. Every offer can be declined — nothing is assigned without a driver agreeing.',
    icon: (color: string, size: number) => <Users color={color} size={size} />,
  },
  {
    key: 'growth',
    title: 'Commerce that scales',
    body: 'Within a city on the day, between them on the next departure, so a small shop can promise what a big one does.',
    icon: (color: string, size: number) => <TrendingUp color={color} size={size} />,
  },
];

export default function AboutScreen() {
  const theme = useTheme();
  const router = useRouter();

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        {/* ---------- Hero ---------- */}
        <View style={styles.hero}>
          <Text style={[styles.heroTitle, { color: theme.text }]}>
            Why Choose <Text style={{ color: theme.primary }}>Package Relay</Text> Courier Network
          </Text>
          <Text style={[styles.heroBody, { color: theme.textSecondary }]}>
            Nigerian commerce runs on things arriving when they were promised. Package Relay exists to make
            that promise keepable — a rider network you can see, prices you can check before you
            book, and cover on every parcel that carries real value.
          </Text>
        </View>

        {/* ---------- Feature highlights ---------- */}
        <SectionLabel>What sets us apart</SectionLabel>
        <View style={styles.featureList}>
          {HERO_SERVICES.map((id) => (
            <FeatureCard
              key={id}
              id={id}
              onBook={() =>
                router.navigate({
                  pathname: '/book',
                  params: servicePrefillParams(id),
                })
              }
            />
          ))}
        </View>

        {/* ---------- Mission ---------- */}
        <Card style={[styles.missionCard, { borderColor: theme.primary }]}>
          <View style={styles.missionHeader}>
            <View style={[styles.missionIcon, { backgroundColor: theme.primarySoft }]}>
              <Target color={theme.primaryOnSoft} size={20} />
            </View>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Our Mission</Text>
          </View>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            To make sending something across town or across the country as ordinary as sending a
            message. That means no haggling at the roadside, no wondering where a parcel is for
            three days, and no discovering the price only after it&apos;s been collected.
          </Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            Every quote is itemised before you commit — base fare, weight, insurance and any
            doorstep leg shown separately, starting at {formatNaira(PRICING.base.local)} for a local
            run. What you see is what the rider sees.
          </Text>
        </Card>

        {/* ---------- Value grid ---------- */}
        <View style={styles.commerceHeader}>
          <Handshake color={theme.primary} size={20} />
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            How We Power Commerce across Nigeria
          </Text>
        </View>

        <View style={styles.valueGrid}>
          {VALUES.map((value) => (
            <Card key={value.key} style={styles.valueCard}>
              <View style={[styles.valueIcon, { backgroundColor: theme.primarySoft }]}>
                {value.icon(theme.primaryOnSoft, 18)}
              </View>
              <Text style={[styles.valueTitle, { color: theme.text }]}>{value.title}</Text>
              <Text style={[styles.valueBody, { color: theme.textMuted }]}>{value.body}</Text>
            </Card>
          ))}
        </View>

        {/* ---------- Closing CTA ---------- */}
        <Card style={[styles.ctaCard, { borderColor: theme.primary }]}>
          <Sparkles color={theme.primary} size={22} />
          <Text style={[styles.ctaTitle, { color: theme.text }]}>Ready to send something?</Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            Post a parcel in under a minute, or apply to ride with us.
          </Text>
          <Button
            label="Send a Package"
            icon={(color, size) => <PackageOpen color={color} size={size} />}
            onPress={() => router.navigate('/book')}
          />
          <Button
            label="Become a Driver"
            variant="secondary"
            icon={(color, size) => <Building2 color={color} size={size} />}
            onPress={() => router.push('/driver-signup')}
          />
        </Card>
      </View>
      <Footer />
    </ScrollView>
  );
}

function FeatureCard({ id, onBook }: { id: ServiceId; onBook: () => void }) {
  const theme = useTheme();
  const service = SERVICES[id];
  const Icon = SERVICE_ICONS[id];

  return (
    <Card style={styles.featureCard}>
      <View style={styles.featureHeader}>
        <View style={[styles.featureIcon, { backgroundColor: theme.primarySoft }]}>
          <Icon color={theme.primaryOnSoft} size={22} />
        </View>
        <View style={styles.featureHeaderText}>
          <Text style={[styles.featureTitle, { color: theme.text }]}>{service.title}</Text>
          <Text style={[styles.featureTagline, { color: theme.textSecondary }]}>
            {service.tagline}
          </Text>
        </View>
      </View>

      <View style={[styles.factRow, { backgroundColor: theme.surfaceMuted }]}>
        {service.facts.map((fact, index) => (
          <View key={fact.label} style={styles.fact}>
            {index > 0 && <View style={[styles.factRule, { backgroundColor: theme.border }]} />}
            <Text style={[styles.factValue, { color: theme.primary }]} numberOfLines={1}>
              {fact.value}
            </Text>
            <Text style={[styles.factLabel, { color: theme.textMuted }]} numberOfLines={1}>
              {fact.label}
            </Text>
          </View>
        ))}
      </View>

      {/* Lead section of the catalogue copy — the full detail is on the booking flow. */}
      <Text style={[styles.featureBody, { color: theme.textSecondary }]}>
        {service.sections[0].body}
      </Text>

      <Button
        label={service.ctaLabel}
        size="md"
        icon={(color, size) => <ArrowRight color={color} size={size} />}
        onPress={onBook}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    gap: Spacing.three,
  },
  hero: {
    alignItems: 'flex-start',
    gap: Spacing.two + 2,
    paddingVertical: Spacing.four,
  },
  heroTitle: {
    fontSize: FontSize.display,
    lineHeight: 39,
    ...font(800),
    letterSpacing: -0.8,
  },
  heroBody: {
    ...Typography.body,
    lineHeight: 23,
    maxWidth: 620,
  },
  sectionTitle: {
    ...Typography.sectionTitle,
    flex: 1,
  },
  body: {
    ...Typography.body,
    lineHeight: 22,
  },

  // Feature highlights
  featureList: {
    gap: Spacing.three - 2,
  },
  featureCard: {
    gap: Spacing.three - 2,
  },
  featureHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 2,
  },
  featureIcon: {
    width: 46,
    height: 46,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureHeaderText: {
    flex: 1,
    gap: Spacing.half,
  },
  featureTitle: {
    ...Typography.cardTitle,
    fontSize: FontSize.subhead,
  },
  featureTagline: {
    ...Typography.meta,
  },
  featureBody: {
    ...Typography.meta,
    lineHeight: 20,
  },
  factRow: {
    flexDirection: 'row',
    borderRadius: Radius.md,
    paddingVertical: Spacing.three - 4,
  },
  fact: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.half,
    paddingHorizontal: Spacing.one,
  },
  factRule: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
  },
  factValue: {
    ...Typography.body,
    ...font(800),
  },
  factLabel: {
    ...Typography.caption,
  },

  // Mission
  missionCard: {
    borderWidth: 1,
    gap: Spacing.two + 2,
    marginTop: Spacing.two,
  },
  missionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
  },
  missionIcon: {
    width: 42,
    height: 42,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Value grid
  commerceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  valueGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three - 4,
  },
  valueCard: {
    flexGrow: 1,
    flexBasis: '47%',
    minWidth: 190,
    gap: Spacing.two,
  },
  valueIcon: {
    width: 38,
    height: 38,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  valueTitle: {
    ...Typography.body,
    ...font(700),
  },
  valueBody: {
    ...Typography.meta,
    lineHeight: 19,
  },

  // Closing CTA
  ctaCard: {
    borderWidth: 1,
    gap: Spacing.two + 2,
    marginTop: Spacing.three,
  },
  ctaTitle: {
    ...Typography.sectionTitle,
  },
});
