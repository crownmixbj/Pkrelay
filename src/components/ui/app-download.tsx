import { Smartphone } from 'lucide-react-native';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { StoreBadges } from '@/components/ui/store-badges';
import { Elevation, Radius, Spacing, Typography } from '@/constants/theme';
import { useExperience } from '@/hooks/use-experience';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Download the Package Relay App" — the band under the hero.
 *
 * ⚠ It used to be two badges floating beside the live ticker.
 *
 *   That put the single strongest call to action on the site in the one strip
 *   the eye skips: the same row as a status ticker, above the fold but beside
 *   the navigation, at the size a header accessory can be. Every postal and
 *   courier site that converts on app installs does the same thing instead —
 *   one band, below the thing the visitor came for, with room for a heading
 *   that says what the app is *for*.
 *
 * ⚠ Web only, like the rest of the marketing chrome.
 *
 *   Telling somebody inside the Android app to download the Android app is the
 *   kind of thing that makes an app feel unfinished. Null rather than an empty
 *   View, so no layout space is reserved for it.
 */

/**
 * Above this the copy and the badges sit side by side; below it they stack and
 * centre. Chosen from the content rather than from a device: the badges are
 * about 340px and the sentence needs roughly 380px before it starts breaking
 * into ragged three-word lines.
 */
const SIDE_BY_SIDE_BREAKPOINT = 760;

export function AppDownload() {
  const theme = useTheme();
  const experience = useExperience();
  const { width } = useWindowDimensions();

  const sideBySide = width >= SIDE_BY_SIDE_BREAKPOINT;

  if (experience && experience !== 'web') return null;

  return (
    <View
      style={[
        styles.panel,
        sideBySide && styles.panelRow,
        {
          backgroundColor: theme.surface,
          borderColor: theme.border,
          shadowColor: theme.shadow,
        },
        Elevation.raised,
      ]}>
      <View style={[styles.copy, !sideBySide && styles.copyCentered]}>
        <View style={[styles.eyebrow, !sideBySide && styles.eyebrowCentered]}>
          <Smartphone color={theme.primary} size={14} />
          <Text style={[styles.eyebrowText, { color: theme.primary }]}>THE PACKAGE RELAY APP</Text>
        </View>

        <Text
          style={[styles.title, { color: theme.text }, !sideBySide && styles.centred]}
          /*
           * A heading on the web, not a paragraph that happens to be large.
           * react-native-web maps this to <h2>, which is what puts the section
           * in a screen reader's landmark list and in a search result's outline.
           */
          accessibilityRole="header">
          Download the Package Relay App
        </Text>

        <Text
          style={[styles.body, { color: theme.textSecondary }, !sideBySide && styles.centred]}>
          Post a parcel, follow it from pickup to handover, and get live status updates on
          your delivery. Free on iPhone and Android.
        </Text>
      </View>

      <View style={[styles.actions, !sideBySide && styles.actionsCentered]}>
        <StoreBadges />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.four,
    gap: Spacing.four,
  },
  panelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.five,
    paddingVertical: Spacing.four + Spacing.two,
    paddingHorizontal: Spacing.five,
  },
  /*
   * `flexShrink: 1` and no basis: the copy is the side that gives way, so the
   * badges keep their size at every width above the breakpoint instead of the
   * pair being squeezed until "Google Play" clips.
   */
  copy: {
    flexShrink: 1,
    gap: Spacing.two,
    maxWidth: 560,
  },
  copyCentered: {
    alignItems: 'center',
    maxWidth: 460,
    alignSelf: 'center',
  },
  eyebrow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  eyebrowCentered: {
    justifyContent: 'center',
  },
  eyebrowText: {
    ...Typography.micro,
    // Set uppercase in the string rather than by transform, so the source reads
    // the way the page does and a search for the words finds them.
    letterSpacing: 0.8,
  },
  title: {
    ...Typography.sectionHeading,
  },
  body: {
    ...Typography.body,
    lineHeight: 24,
  },
  centred: {
    textAlign: 'center',
  },
  actions: {
    gap: Spacing.two,
    flexShrink: 0,
  },
  actionsCentered: {
    alignItems: 'center',
  },
});
