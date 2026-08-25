import { Image } from 'expo-image';
import { ArrowUpRight } from 'lucide-react-native';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ImageSourcePropType } from 'react-native';

import {
  CityMapPattern,
  CratePattern,
  DocumentPattern,
  RouteNetworkPattern,
  type PatternProps,
} from '@/components/ui/service-patterns';
import { SERVICE_ARTWORK_ASPECT } from '@/constants/service-artwork';
import {
  Radius,
  ServiceTones,
  Spacing,
  Typography,
  font,
  type ServiceToneName,
} from '@/constants/theme';

/** Which pattern belongs to which palette. */
const PATTERNS: Record<ServiceToneName, (props: PatternProps) => React.ReactElement> = {
  teal: RouteNetworkPattern,
  azure: CityMapPattern,
  gold: DocumentPattern,
  royal: CratePattern,
};

export type ServiceCategoryCardProps = {
  title: string;
  subtitle: string;
  tone: ServiceToneName;
  icon: (color: string, size: number) => React.ReactNode;
  onPress: () => void;
  /**
   * Finished artwork for this service. When supplied it fills the card edge to
   * edge and replaces the fill, pattern, badges and copy — the image already
   * carries its own title. Omit it and the card renders its designed layout.
   */
  artwork?: ImageSourcePropType;
  /**
   * The column width this card occupies, measured by the container.
   *
   * ⚠ Null means "not measured yet", not "no width".
   *
   *   The parent measures its own box on first layout, so for one frame there
   *   is no number. Rendering a zero-width card then would flash an empty
   *   panel, so the card fills its line until a real measurement arrives — and
   *   with four cards that first frame looks like the old layout for about
   *   16ms, which is invisible and correct.
   */
  width?: number | null;
};

/**
 * A service tile, in one of two modes.
 *
 * With `artwork`, the card is the image: nothing is drawn over it, because the
 * supplied designs already include their own title and any overlay would sit on
 * top of it. Without artwork, it's the colour-coded layout — a soft fill, an SVG
 * pattern, then icon, copy and arrow.
 *
 * Both modes are the same Pressable with the same accessibility label, so the
 * whole tile is tappable either way and a screen reader hears the title and
 * subtitle even when they only exist inside the image.
 */
export function ServiceCategoryCard({
  title,
  subtitle,
  tone,
  icon,
  onPress,
  artwork,
  width,
}: ServiceCategoryCardProps) {
  /*
   * ⚠ A fixed width, or `flex: 1` — never both, and never `flex: 1` alone.
   *
   *   `flex: 1` inside a wrapping row is what stretched the fourth card across
   *   the second row: a wrapped item is the only thing on its line, and
   *   "take the remaining space" on a line of one is all of it. Once the
   *   container has measured itself the card is pinned to its column and
   *   `flexGrow: 0` keeps it there.
   */
  const size =
    typeof width === 'number' && width > 0 ? { width, flexGrow: 0, flexShrink: 0 } : { flex: 1 };
  const colors = ServiceTones[tone];
  const Pattern = PATTERNS[tone];

  // The image is the whole card, so everything the layout would have drawn is
  // skipped rather than stacked on top of artwork that already says it.
  if (artwork) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${subtitle}`}
        style={({ pressed, hovered }) => [
          styles.card,
          size,
          styles.cardArtwork,
          { shadowColor: colors.accent },
          hovered && styles.hovered,
          pressed && styles.pressed,
        ]}>
        <Image
          source={artwork}
          style={styles.fullBleed}
          contentFit="cover"
          accessibilityIgnoresInvertColors
        />
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      style={({ pressed, hovered }) => [
        styles.card,
        size,
        styles.cardLayout,
        { shadowColor: colors.accent },
        // `hovered` is web-only; on native this branch never runs.
        hovered && styles.hovered,
        pressed && styles.pressed,
      ]}>
      {/*
        Translucent white rather than the tone's own fill, so the cyan canvas
        reads through. The palette still drives the icon, arrow, copy and
        pattern, so the cards stay colour-coded.
      */}
      <View style={styles.fill} />

      {/* Above the fill, below everything readable. */}
      <View style={styles.pattern} pointerEvents="none">
        <Pattern color={colors.accent} width={PATTERN_SIZE} height={PATTERN_SIZE} />
      </View>

      <View style={styles.topRow}>
        <View style={[styles.iconBadge, { backgroundColor: colors.accent }]}>
          {icon(colors.onAccent, 20)}
        </View>
        <View
          style={[
            styles.arrowBadge,
            { backgroundColor: colors.accent, shadowColor: colors.accent },
          ]}>
          <ArrowUpRight color={colors.onAccent} size={15} />
        </View>
      </View>

      <View style={styles.text}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {title}
        </Text>
        <Text style={[styles.subtitle, { color: colors.text }]} numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

/** Oversized so the pattern bleeds past the card edges rather than tiling visibly. */
const PATTERN_SIZE = 200;

const styles = StyleSheet.create({
  card: {
    /*
     * ⚠ No `flex: 1`, and no `minWidth`. The container sizes these now.
     *
     *   `flex: 1` with `flexWrap` is what stretched the fourth card across the
     *   whole second row: a wrapped item is alone on its line, and `flex: 1`
     *   means "take what is left", which on a line of one is everything.
     *
     *   The parent computes a column width and passes it. That is what a grid
     *   does — decide the tracks once, centrally — and unlike CSS Grid it works
     *   on iOS and Android, where Yoga has no grid at all.
     *
     *   The readability floor that `minWidth: 280` protected has not gone: it
     *   is `MIN_CARD_WIDTH` in `index.tsx`, where it now decides how many
     *   columns there are rather than fighting the flex line afterwards.
     */
    borderRadius: Radius.xl + 4,
    borderWidth: 1,
    // teal-100 (#CCFBF1) measures 1.01:1 against the canvas — invisible. This
    // deeper teal keeps the outline readable without shouting.
    borderColor: 'rgba(13,148,136,0.25)',
    overflow: 'hidden',
    // Tinted shadow so each card lifts in its own colour off the grey-blue page.
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    ...Platform.select({
      web: { transitionDuration: '160ms', cursor: 'pointer' },
      android: { elevation: 3 },
      default: {},
    }),
  },
  /** The designed layout supplies its own padding and a floor on height. */
  cardLayout: {
    minHeight: 158,
    padding: Spacing.three - 2,
    justifyContent: 'space-between',
  },
  /** Artwork mode: no padding, and the card takes the image's shape. */
  cardArtwork: {
    aspectRatio: SERVICE_ARTWORK_ASPECT,
  },
  fullBleed: {
    width: '100%',
    height: '100%',
  },
  hovered: {
    transform: [{ translateY: -2 }],
    shadowOpacity: 0.26,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    ...Platform.select({ android: { elevation: 6 }, default: {} }),
  },
  pressed: {
    opacity: 0.92,
    transform: [{ scale: 0.98 }],
  },
  fill: {
    backgroundColor: 'rgba(255,255,255,0.7)',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  pattern: {
    position: 'absolute',
    right: -40,
    bottom: -40,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  iconBadge: {
    width: 38,
    height: 38,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowBadge: {
    width: 28,
    height: 28,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    ...Platform.select({ android: { elevation: 3 }, default: {} }),
  },
  text: {
    gap: Spacing.half,
    marginTop: Spacing.three,
  },
  title: {
    ...Typography.cardTitle,
    ...font(700),
  },
  subtitle: {
    ...Typography.caption,
    ...font(500),
  },
});
