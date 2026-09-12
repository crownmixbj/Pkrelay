import { Apple, Play } from 'lucide-react-native';
import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { STORE_LINKS, type StorePlatform } from '@/components/ui/app-store-modal';
import { FontSize, Radius, Spacing, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * The two store badges that live at the right end of the web header.
 *
 * ⚠ These are *our* badges, not Apple's and Google's artwork.
 *
 *   Both stores ship official lock-ups (the Apple logo + "Download on the App
 *   Store", the four-colour triangle + "GET IT ON Google Play") and both
 *   trademark them: the marks may only be used as supplied, at their stated
 *   clear space and minimum sizes, and may not be redrawn — which is exactly
 *   what drawing the paths by hand here would be. So this is a house badge in
 *   the Package Relay navy: same shape language and the same wording, a
 *   generic glyph instead of a corporate mark.
 *
 *   When the apps are actually listed, swap the glyph for the downloaded
 *   assets (Apple: Marketing Resources → App Store badges; Google: Play brand
 *   guidelines) as SVG files rendered through `expo-image`, and keep the
 *   layout below as it is. See the note in `docs/DISTRIBUTION.md`.
 *
 * ⚠ Unlike the cookie banner and the old promo pill, nothing here is
 *   dismissible and nothing is conditional on session, role or scroll. The
 *   only thing that changes with width is how much of the badge is drawn.
 */

/**
 * Below this the two full badges (about 300px together) leave the ticker beside
 * them a sliver, so they drop to their glyphs. Not a phone/desktop split — it
 * is the width at which *this row* stops fitting, which is why the number lives
 * here rather than beside the nav bar's own breakpoints.
 */
export const BADGE_COMPACT_BREAKPOINT = 760;

/**
 * Navy rather than the stores' black, so the pair reads as part of the header
 * instead of two foreign stickers on it. Fixed across light and dark: a badge
 * that inverts with the theme stops being recognisable as a badge, and the
 * white lettering has to keep its contrast either way (#FFFFFF on #0F172A is
 * 17.9:1).
 */
const BADGE_FILL = '#0F172A';
const BADGE_PRESSED = '#1E293B';
/** Hairline lift so the fill separates from a dark page behind it. */
const BADGE_EDGE = 'rgba(255, 255, 255, 0.14)';
const BADGE_TEXT = '#FFFFFF';
const BADGE_TEXT_MUTED = 'rgba(255, 255, 255, 0.78)';

type Badge = {
  platform: StorePlatform;
  /** The small line. Deliberately the stores' own phrasing. */
  kicker: string;
  /** The large line. */
  name: string;
  icon: (color: string, size: number) => React.ReactNode;
};

const BADGES: Badge[] = [
  {
    platform: 'ios',
    kicker: 'Download on the',
    name: 'App Store',
    icon: (color, size) => <Apple color={color} size={size} />,
  },
  {
    platform: 'android',
    kicker: 'Get it on',
    name: 'Google Play',
    // Filled, because an outlined triangle at 18px reads as a play *button*
    // rather than a mark.
    icon: (color, size) => <Play color={color} fill={color} size={size} strokeWidth={1} />,
  },
];

/**
 * Opening the store.
 *
 * A new tab on the web, and the reason is the visitor rather than the link: a
 * desktop browser sent to a store page has left the site, and the thing they
 * were doing — a quote, a booking half filled in — is behind a back button they
 * may not use. `noopener` because `window.open` otherwise hands the store page a
 * live reference to ours.
 */
function openStoreListing(platform: StorePlatform) {
  const url = STORE_LINKS[platform];

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  // Native falls back to the same links. `openURL` rejects rather than throwing
  // when nothing can handle one, and an unhandled rejection is the only thing
  // that would be worse than the tap doing nothing.
  void Linking.openURL(url).catch(() => {});
}

export type StoreBadgesProps = {
  /**
   * Force the glyph-only form regardless of width. Used where the row is
   * narrower than the window, e.g. inside a card.
   */
  compact?: boolean;
};

export function StoreBadges({ compact }: StoreBadgesProps) {
  const { width } = useWindowDimensions();
  const collapsed = compact ?? width < BADGE_COMPACT_BREAKPOINT;

  return (
    <View style={styles.row}>
      {BADGES.map((badge) => (
        <StoreBadge key={badge.platform} badge={badge} collapsed={collapsed} />
      ))}
    </View>
  );
}

function StoreBadge({ badge, collapsed }: { badge: Badge; collapsed: boolean }) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={() => openStoreListing(badge.platform)}
      /*
       * A link, not a button: it leaves the site. Screen readers announce the
       * two differently, and "link" is the one that warns.
       */
      accessibilityRole="link"
      accessibilityLabel={`${badge.kicker} ${badge.name} — get the Package Relay app`}
      style={({ pressed }) => [
        styles.badge,
        collapsed ? styles.badgeCompact : styles.badgeFull,
        { backgroundColor: pressed ? BADGE_PRESSED : BADGE_FILL },
        pressed && styles.pressed,
      ]}>
      {badge.icon(theme.primaryAccent, collapsed ? 20 : 18)}

      {!collapsed && (
        <View style={styles.labels}>
          <Text style={styles.kicker} numberOfLines={1}>
            {badge.kicker}
          </Text>
          <Text style={styles.name} numberOfLines={1}>
            {badge.name}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    /*
     * Never squeezed. The ticker beside these takes `flex: 1` and will give up
     * its own width first; without this the badges are the thing that shrinks,
     * and a half-width badge is worse than a narrow ticker.
     */
    flexShrink: 0,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BADGE_EDGE,
    /** Matches the ticker pill beside it, so the row has one baseline. */
    height: 44,
  },
  badgeFull: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.three - 4,
  },
  badgeCompact: {
    width: 44,
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.9,
  },
  labels: {
    justifyContent: 'center',
  },
  kicker: {
    ...font(500),
    fontSize: FontSize.micro,
    lineHeight: 13,
    color: BADGE_TEXT_MUTED,
  },
  name: {
    ...font(700),
    fontSize: FontSize.subhead,
    lineHeight: 20,
    color: BADGE_TEXT,
    letterSpacing: 0.1,
  },
});
