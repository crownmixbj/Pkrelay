import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, ArrowRight, CircleCheckBig, PackageSearch } from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, screenPadding } from '@/components/ui/screen';
import { findStep, PROCESS_STEPS } from '@/constants/how-it-works-steps';
import { PageCanvas, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const Detail = {
  heading: '#0B3C5D',
} as const;

/**
 * Expanded explanation of one process step. Content comes from
 * `PROCESS_STEPS`, the same source the home-screen cards read, so the summary
 * and this page always describe the same thing.
 *
 * Deliberately text-only: the step artwork in `STEP_ILLUSTRATIONS` belongs to
 * the home-screen preview cards and is not rendered here. The art has the step
 * title baked into it, so repeating it above a page that already prints that
 * title just says the same thing twice.
 */
export default function StepDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { step: slug } = useLocalSearchParams<{ step: string }>();

  const step = findStep(slug);

  // A hand-typed or stale URL shouldn't crash the route.
  if (!step) {
    return (
      <ScrollView contentContainerStyle={[screenPadding, styles.canvas]}>
        <Card style={styles.emptyCard}>
          <EmptyState
            icon={(color, size) => <PackageSearch color={color} size={size} />}
            title="Step not found"
            message="That step doesn't exist. Head back to see how Package Relay works."
          />
          <Button label="Back to Home" size="md" onPress={() => router.navigate('/')} />
        </Card>
        <Footer />
      </ScrollView>
    );
  }

  const position = PROCESS_STEPS.findIndex((s) => s.key === step.key);
  const next = PROCESS_STEPS[position + 1];

  return (
    <ScrollView contentContainerStyle={[screenPadding, styles.canvas]}>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        hitSlop={8}
        style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
        <ArrowLeft color={theme.text} size={20} />
        <Text style={[styles.backLabel, { color: theme.textSecondary }]}>How Package Relay Works</Text>
      </Pressable>

      <Text style={styles.stepNumber}>
        Step {step.number} of {String(PROCESS_STEPS.length).padStart(2, '0')}
      </Text>
      <Text style={styles.title}>{step.title}</Text>
      <Text style={[styles.detail, { color: theme.textSecondary }]}>{step.detail}</Text>

      <Text style={styles.sectionLabel}>What you get</Text>
      <View style={styles.benefits}>
        {step.benefits.map((benefit) => (
          <Card key={benefit.title} style={styles.benefitCard}>
            <View style={styles.benefitHeader}>
              <CircleCheckBig color={theme.success} size={18} />
              <Text style={[styles.benefitTitle, { color: theme.text }]}>{benefit.title}</Text>
            </View>
            <Text style={[styles.benefitBody, { color: theme.textSecondary }]}>{benefit.body}</Text>
          </Card>
        ))}
      </View>

      <Button
        label={step.cta.label}
        style={styles.cta}
        icon={(color, size) => <ArrowRight color={color} size={size} />}
        onPress={() => router.navigate(step.cta.href)}
      />

      {next && (
        <Pressable
          onPress={() =>
            router.replace({ pathname: '/how-it-works/[step]', params: { step: next.key } })
          }
          accessibilityRole="link"
          style={({ pressed }) => [styles.nextRow, pressed && styles.pressed]}>
          <Text style={[styles.nextLabel, { color: theme.primary }]}>Next: {next.title} →</Text>
        </Pressable>
      )}
      <Footer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  canvas: {
    backgroundColor: PageCanvas,
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  backLabel: {
    ...Typography.body,
    ...font(600),
  },
  stepNumber: {
    ...Typography.label,
    ...font(700),
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: Detail.heading,
    opacity: 0.7,
  },
  title: {
    ...Typography.screenTitle,
    color: Detail.heading,
    marginTop: Spacing.one,
  },
  detail: {
    ...Typography.body,
    lineHeight: 22,
    marginTop: Spacing.three,
  },
  sectionLabel: {
    ...Typography.sectionHeading,
    color: Detail.heading,
    marginTop: Spacing.five,
    marginBottom: Spacing.three,
  },
  benefits: {
    gap: Spacing.three - 4,
  },
  benefitCard: {
    gap: Spacing.two,
  },
  benefitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  benefitTitle: {
    flex: 1,
    ...Typography.cardTitle,
  },
  benefitBody: {
    ...Typography.caption,
  },
  cta: {
    marginTop: Spacing.five,
  },
  nextRow: {
    alignItems: 'center',
    paddingVertical: Spacing.four,
  },
  nextLabel: {
    ...Typography.body,
    ...font(700),
  },
  emptyCard: {
    gap: Spacing.three,
  },
  pressed: {
    opacity: 0.7,
  },
});
