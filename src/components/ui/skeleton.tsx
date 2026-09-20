import { useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Placeholder blocks for content that is on its way.
 *
 * ⚠ A skeleton is only an improvement if it stands where the content will.
 *
 *   The point is that nothing moves when the real thing arrives. A generic
 *   spinner in the middle of the screen is replaced by a layout, which is a
 *   second visual event — the flash it was meant to remove, moved later. So
 *   callers build a skeleton shaped like the screen, out of these blocks, at
 *   the sizes the real elements occupy.
 *
 * ⚠ It is announced as busy rather than read out.
 *
 *   Without `accessibilityElementsHidden` a screen reader walks a dozen empty
 *   views and says nothing useful twelve times. The wrapper carries the one
 *   message that matters.
 */

/** How long one full dim-and-back takes. */
const PULSE_MS = 900;

/**
 * Whether to animate at all.
 *
 * Follows `marquee.tsx`, which asks the same question the same way. A pulsing
 * rectangle is exactly the kind of repeating motion "Reduce Motion" is set to
 * stop, and a static block loses nothing — it still holds the space.
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduced(enabled);
      })
      .catch(() => {
        /* Unavailable on this platform: assume motion is fine. */
      });

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      if (!cancelled) setReduced(enabled);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return reduced;
}

export type SkeletonProps = {
  width?: ViewStyle['width'];
  height?: number;
  radius?: number;
  style?: ViewStyle;
};

export function Skeleton({ width = '100%', height = 14, radius = Radius.sm, style }: SkeletonProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (reduced) {
      pulse.value = 1;
      return;
    }
    /*
     * Opacity rather than a moving highlight gradient.
     *
     * A sweeping shimmer needs a gradient the width of the block and repaints
     * on every frame across a dozen of them. On the low-end Android these
     * parcels are mostly read on, that is the difference between a smooth
     * placeholder and a janky one — which would be worse than the flash.
     *
     * 0.45 rather than 0 at the trough: a block that disappears entirely reads
     * as flickering rather than loading.
     */
    pulse.value = withRepeat(
      withTiming(0.45, { duration: PULSE_MS, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [reduced, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: theme.surfaceMuted },
        animatedStyle,
        style,
      ]}
    />
  );
}

/** A paragraph's worth of lines, the last one short so it reads as text. */
export function SkeletonText({ lines = 3, height = 12 }: { lines?: number; height?: number }) {
  return (
    <View style={styles.lines}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          height={height}
          width={index === lines - 1 ? '60%' : '100%'}
        />
      ))}
    </View>
  );
}

/**
 * Wraps a skeleton so assistive technology hears one thing instead of twelve.
 *
 * `busy` is what a screen reader announces; everything inside is hidden from
 * it. Both props are needed — `accessibilityElementsHidden` is iOS and
 * `importantForAccessibility` is Android, and using one leaves the other
 * reading out empty boxes.
 */
export function SkeletonGroup({
  label = 'Loading',
  children,
  style,
}: {
  label?: string;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={style}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  lines: {
    gap: Spacing.two,
  },
});
