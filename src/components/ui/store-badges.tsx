import { Apple, Play } from 'lucide-react-native';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { STORE_LINKS, type StorePlatform } from '@/components/ui/app-store-modal';
import { FontSize, Radius, Spacing, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * The two store badges. Presentation only — where they sit is `app-download.tsx`.
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
 */

/**
 * Navy rather than the stores' black, so the pair reads as part of the page
 * instead of two foreign stickers on it. Fixed across light and dark: a badge
 * that inverts with the theme stops being recognisable as a badge, and the
 * white lettering has to keep its contrast either way (#FFFFFF on #0F172A is
 * 17.9:1).
 */
const BADGE_FILL = '#0F172A';
const BADGE_PRESSED = '#1E293B';
/** Hairline lift so the fill separates from a dark panel behind it. */
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

export function StoreBadges() {
  return (
    <View style={styles.row}>
      {BADGES.map((badge) => (
        <StoreBadge key={badge.platform} badge={badge} />
      ))}
    </View>
  );
}

function StoreBadge({ badge }: { badge: Badge }) {
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
        { backgroundColor: pressed ? BADGE_PRESSED : BADGE_FILL },
        pressed && styles.pressed,
      ]}>
      {badge.icon(theme.primaryAccent, 20)}

      <View style={styles.labels}>
        <Text style={styles.kicker} numberOfLines={1}>
          {badge.kicker}
        </Text>
        <Text style={styles.name} numberOfLines={1}>
          {badge.name}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    /*
     * Centred so a wrapped second badge sits under the first rather than
     * ragged-left inside a centred column. In the side-by-side layout the row
     * hugs its content, so this changes nothing there.
     */
    justifyContent: 'center',
    gap: Spacing.two + 4,
    /*
     * Wrapping is the whole phone story: the pair is about 340px, so on a
     * 360px browser they sit side by side and on anything narrower the second
     * badge drops to its own line at full size. Shrinking them instead would
     * clip "Google Play", and a badge with a clipped store name is worse than
     * a badge on the next line.
     */
    flexWrap: 'wrap',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BADGE_EDGE,
    /** 52 rather than 44: this is a section CTA now, not a header accessory. */
    height: 52,
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
    lineHeight: 14,
    color: BADGE_TEXT_MUTED,
  },
  name: {
    ...font(700),
    fontSize: FontSize.subhead,
    lineHeight: 22,
    color: BADGE_TEXT,
    letterSpacing: 0.1,
  },
});
