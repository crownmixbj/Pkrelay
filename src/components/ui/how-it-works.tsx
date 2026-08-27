import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { PROCESS_STEPS, type ProcessStep } from '@/constants/how-it-works-steps';
import { STEP_ILLUSTRATIONS, STEP_ILLUSTRATION_HEIGHT } from '@/constants/step-illustrations';
import { FontSize, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Palette for the glass treatment. Local rather than themed: these only exist
 * inside the cyan section, and nothing else in the app uses them.
 */
const Glass = {
  /** Thin teal rule around the whole 3-step block. */
  panelBorder: 'rgba(94,234,212,0.5)',
  /** Warm card fill — 90% over the cyan gradient, so a little of it shows. */
  cardFill: 'rgba(255,253,247,0.9)',
  /** Border emphasis on hover. */
  cardBorderHover: 'rgba(13,148,136,0.45)',
  /** Dark tile behind each icon. */
  iconTile: '#0B3C5D',
  /** Bright icon on that tile — 5.76:1, comfortably legible. */
  iconGlyph: '#4FC3F7',
  /** Backdrop for the illustration slot. */
  illustrationFill: 'rgba(224,247,250,0.65)',
  /** Step numeral. */
  stepNumber: '#0B3C5D',
  /** Deep navy heading — 10.37:1 on the cyan canvas. */
  heading: '#0B3C5D',
  /** Keyboard focus ring — 4.66:1 against the card fill. */
  focusRing: '#0077B6',
} as const;

export function HowItWorks() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  // md breakpoint: three across needs room, below this it's a single column.
  const threeUp = width >= 720;

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>
        How <Text style={{ color: theme.primary }}>LOCI</Text> Works
      </Text>
      <Text style={[styles.subheading, { color: theme.textSecondary }]}>
        Three steps from your hands to theirs.
      </Text>

      {/* Teal-bordered panel holding the three cards. */}
      <View style={[styles.panel, !threeUp && styles.panelStacked]}>
        {PROCESS_STEPS.map((step, index) => (
          <StepCard key={step.key} index={index} step={step} horizontal={threeUp} />
        ))}
      </View>
    </View>
  );
}

function StepCard({
  index,
  step,
  horizontal,
}: {
  index: number;
  step: ProcessStep;
  horizontal: boolean;
}) {
  const theme = useTheme();
  const router = useRouter();
  const illustration = STEP_ILLUSTRATIONS[step.key];

  /**
   * `focused` isn't in RN's Pressable style-callback types (only `hovered`
   * is), so keyboard focus is tracked explicitly.
   */
  const [focused, setFocused] = useState(false);

  // Staggered entrance so the steps read in order rather than all at once.
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 420,
      delay: index * 140,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [index, progress]);

  const animatedStyle = {
    opacity: progress,
    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
  };

  return (
    <Animated.View style={[horizontal && styles.cardRow, animatedStyle]}>
      <Pressable
        onPress={() =>
          router.push({ pathname: '/how-it-works/[step]', params: { step: step.key } })
        }
        accessibilityRole="link"
        accessibilityLabel={`Step ${index + 1}. ${step.title}. ${step.body}. Read more`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={({ pressed, hovered }) => [
          styles.card,
          // Fill the stretched wrapper, so the three cards end on one line.
          horizontal && styles.cardFilled,
          // `hovered` is web-only; on native this branch never runs.
          hovered && styles.cardHovered,
          focused && styles.cardFocused,
          pressed && styles.cardPressed,
        ]}>
        {/*
          Fixed-height image box with the art letterboxed inside it. `contain`
          rather than `cover`: these are wide illustrations with figures near
          the edges, and cropping to fill would cut them off. The three crops
          differ in aspect by ~4%, which contain absorbs invisibly.
        */}
        <View style={styles.illustration}>
          {illustration ? (
            <Image
              source={illustration}
              style={styles.illustrationImage}
              contentFit="contain"
              accessibilityIgnoresInvertColors
            />
          ) : (
            <View style={styles.iconTile}>{step.icon(Glass.iconGlyph, 26)}</View>
          )}
        </View>

        <View style={styles.caption}>
          <Text style={styles.stepNumber}>{step.number}</Text>
          <Text
            style={[
              styles.stepTitle,
              // Two lines reserved across, so the bodies share a baseline.
              horizontal && styles.stepTitleReserved,
              { color: theme.text },
            ]}>
            {step.title}
          </Text>
          <Text style={[styles.stepBody, { color: theme.textSecondary }]}>{step.body}</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: Spacing.five,
  },
  heading: {
    ...Typography.sectionHeading,
    textAlign: 'center',
    color: Glass.heading,
  },
  subheading: {
    ...Typography.body,
    textAlign: 'center',
    marginTop: Spacing.one,
    marginBottom: Spacing.four,
  },
  panel: {
    flexDirection: 'row',
    gap: Spacing.three - 4,
    padding: Spacing.three,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Glass.panelBorder,
  },
  panelStacked: {
    flexDirection: 'column',
  },
  cardRow: {
    flex: 1,
  },
  /**
   * ⚠ The wrapper stretching is not the card stretching.
   *
   *   `cardRow` gives each wrapper an equal share of the row and the panel's
   *   default `align-items: stretch` makes them all the height of the tallest.
   *   The Pressable inside sizes to its own content, though — so three cards
   *   with two, two and three lines of body text ended on three different
   *   lines, inside three wrappers that were already the same height. The
   *   ragged edge was the card, not the column.
   */
  cardFilled: {
    flex: 1,
  },
  card: {
    // No `overflow: hidden` here — the image box clips itself, and combining
    // overflow with a shadow crops the shadow on iOS.
    padding: Spacing.three - 4,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: Glass.cardFill,
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    ...Platform.select({
      web: { transitionDuration: '200ms', cursor: 'pointer' },
      android: { elevation: 1 },
      default: {},
    }),
  },

  /** Lift, border emphasis and a softer, wider shadow. */
  cardHovered: {
    transform: [{ translateY: -4 }],
    borderColor: Glass.cardBorderHover,
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    ...Platform.select({ android: { elevation: 5 }, default: {} }),
  },
  /**
   * Keyboard focus. These behave as links, so tabbing to one has to be visible
   * — hover alone leaves keyboard users with no indication of where they are.
   */
  cardFocused: {
    borderColor: Glass.focusRing,
    ...Platform.select({
      web: { outlineWidth: 2, outlineColor: Glass.focusRing, outlineOffset: 2 },
      default: {},
    }),
  },
  cardPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.99 }],
  },
  illustration: {
    height: STEP_ILLUSTRATION_HEIGHT,
    borderRadius: Radius.md,
    backgroundColor: Glass.illustrationFill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  illustrationImage: {
    width: '100%',
    height: '100%',
  },
  iconTile: {
    width: 56,
    height: 56,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Glass.iconTile,
  },
  /** Text block under the image. Tight gaps so it reads as one unit. */
  caption: {
    paddingTop: Spacing.three - 4,
    paddingHorizontal: Spacing.one,
    gap: Spacing.one,
  },
  /**
   * An eyebrow rather than the old 22px numeral — the title now sits directly
   * underneath as real text, and a display-sized number above it costs a line
   * of card height for no extra meaning.
   */
  stepNumber: {
    fontSize: FontSize.caption,
    ...font(800),
    letterSpacing: 1,
    color: Glass.stepNumber,
    opacity: 0.7,
  },
  stepTitle: {
    ...Typography.cardTitle,
    ...font(700),
  },
  /**
   * ⚠ Room for a second line whether or not this title needs one.
   *
   *   The three titles are 31, 36 and 42 characters, so at most widths two of
   *   them fit on one line and the third wraps — which pushed that card's body
   *   text a line lower than its neighbours' and read as a card sitting too
   *   low. Reserving the line makes the bodies share a baseline for any copy,
   *   rather than for today's copy at today's breakpoint.
   *
   *   Two lines of `cardTitle`: 17px at a 1.5 ratio is a 26px line.
   *
   *   Only when the cards are side by side. Stacked, each one is full width,
   *   every title fits on one line, and a reserved second would be three gaps
   *   of white space aligning nothing with nothing.
   */
  stepTitleReserved: {
    minHeight: Typography.cardTitle.lineHeight * 2,
  },
  stepBody: {
    ...Typography.caption,
  },
});
