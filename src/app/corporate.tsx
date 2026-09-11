import { useRouter } from 'expo-router';
import {
  Building2,
  CalendarClock,
  FileSpreadsheet,
  Mail,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react-native';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FontSize, MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatNaira, PRICING } from '@/store/bookings';

const FEATURES = [
  {
    key: 'volume',
    title: 'Volume pricing',
    body: `Accounts shipping more than 50 parcels a month move off the standard ${formatNaira(PRICING.base.local)} local base fare onto negotiated rates, billed monthly rather than per booking.`,
    icon: (color: string, size: number) => <FileSpreadsheet color={color} size={size} />,
  },
  {
    key: 'scheduled',
    title: 'Scheduled collections',
    body: 'Book a standing pickup window — daily, weekly, or on set weekdays — and a rider arrives without anyone raising a request.',
    icon: (color: string, size: number) => <CalendarClock color={color} size={size} />,
  },
  {
    key: 'team',
    title: 'Team accounts',
    body: 'Multiple senders under one billing account, each with their own tracking view, plus a consolidated monthly statement.',
    icon: (color: string, size: number) => <Users color={color} size={size} />,
  },
  {
    key: 'cover',
    title: 'Higher cover limits',
    body: `Declared-value cover above the standard ${formatNaira(10_000_000)} ceiling, arranged per account with a bespoke policy.`,
    icon: (color: string, size: number) => <ShieldCheck color={color} size={size} />,
  },
];

export default function CorporateScreen() {
  const theme = useTheme();
  const router = useRouter();

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}>
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Badge label="For business" tone="primary" />
            <Text style={[styles.title, { color: theme.text }]}>Corporate Delivery</Text>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              Bulk and scheduled shipping for teams that send every day.
            </Text>
          </View>
          <Pressable
            onPress={() => router.back()}
            hitSlop={10}
            accessibilityLabel="Close"
            style={[styles.close, { backgroundColor: theme.surfaceMuted }]}>
            <X color={theme.textSecondary} size={18} />
          </Pressable>
        </View>

        <View style={styles.list}>
          {FEATURES.map((feature) => (
            <Card key={feature.key} style={styles.card}>
              <View style={[styles.iconBubble, { backgroundColor: theme.primarySoft }]}>
                {feature.icon(theme.primaryOnSoft, 20)}
              </View>
              <View style={styles.cardText}>
                <Text style={[styles.cardTitle, { color: theme.text }]}>{feature.title}</Text>
                <Text style={[styles.cardBody, { color: theme.textSecondary }]}>
                  {feature.body}
                </Text>
              </View>
            </Card>
          ))}
        </View>

        <Card style={[styles.ctaCard, { borderColor: theme.primary }]}>
          <Building2 color={theme.primary} size={22} />
          <Text style={[styles.ctaTitle, { color: theme.text }]}>Talk to us</Text>
          <Text style={[styles.ctaBody, { color: theme.textSecondary }]}>
            Tell us roughly how much you ship and where, and we&apos;ll come back with a rate.
          </Text>
          <Button
            label="Email the business team"
            icon={(color, size) => <Mail color={color} size={size} />}
            onPress={() => Linking.openURL('mailto:business@pkrelay.ng?subject=Corporate%20Delivery')}
          />
          <Button label="Close" variant="secondary" onPress={() => router.back()} />
        </Card>
      </View>
      <Footer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
    padding: Spacing.four,
    paddingTop: Spacing.five,
    paddingBottom: Spacing.six,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  headerText: {
    flex: 1,
    gap: Spacing.two - 2,
  },
  title: {
    ...Typography.screenTitle,
    fontSize: FontSize.title,
  },
  subtitle: {
    ...Typography.screenSubtitle,
  },
  close: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    gap: Spacing.three - 4,
  },
  card: {
    flexDirection: 'row',
    gap: Spacing.three - 2,
    alignItems: 'flex-start',
  },
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardText: {
    flex: 1,
    gap: Spacing.half,
  },
  cardTitle: {
    ...Typography.body,
    ...font(700),
  },
  cardBody: {
    ...Typography.meta,
    lineHeight: 19,
  },
  ctaCard: {
    borderWidth: 1,
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  ctaTitle: {
    ...Typography.sectionTitle,
  },
  ctaBody: {
    ...Typography.body,
    marginBottom: Spacing.two - 2,
  },
});
