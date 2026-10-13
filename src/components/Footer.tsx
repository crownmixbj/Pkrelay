import { useRouter } from 'expo-router';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  cookiePreferencesAvailable,
  openCookiePreferences,
} from '@/components/ui/cookie-banner';
import { InvertedBand, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useExperience } from '@/hooks/use-experience';

/**
 * ⚠ These values moved to `InvertedBand` in the theme; this is now an alias.
 *
 *   The footer was the only inverted block on the site, so it owned the blue and
 *   the reasoning behind pure-white type. Two sections on the home page now have
 *   to be *the same colour as the footer* — a stated requirement, not a
 *   resemblance — so the token owns it and all three read it. The alias stays
 *   because this file's styles name it in a dozen places and renaming them would
 *   add nothing.
 */
const FooterColors = InvertedBand;

/** Every route the footer can reach. Anything without one has no screen yet. */
export type FooterRoute =
  '/corporate' | '/driver-guidelines' | '/driver-signup' | '/legal' | '/support';

type FooterLink = {
  label: string;
  /** Omitted when the destination doesn't exist — renders as plain text. */
  href?: FooterRoute;
};

/**
 * ⚠ Four of these used to be plain text, and had been for months.
 *
 *   Terms of Service, Privacy Policy, Legal Info and FAQs were written before
 *   the screens behind them existed, so they rendered as unpressable labels.
 *   The screens exist now — `/legal` carries the terms and the privacy notice,
 *   `/support` the contact routes, `/driver-guidelines` the FAQs — and a footer
 *   that lists a privacy policy while refusing to open one is worse than a
 *   footer that does not mention it. Legal links are the ones a person goes
 *   looking for precisely when they have stopped trusting the product.
 *
 *   Terms and Privacy both point at `/legal`, which holds both. Two labels for
 *   one page is honest here: people scan a footer for the exact phrase they
 *   have in mind, and `/legal` opens on the section either way.
 */
export const LINKS: FooterLink[] = [
  { label: 'Partner Sign-up', href: '/corporate' },
  { label: 'Become a Driver', href: '/driver-signup' },
  { label: 'Terms of Service', href: '/legal' },
  { label: 'Privacy Policy', href: '/legal' },
  { label: 'Support', href: '/support' },
  { label: 'FAQs', href: '/driver-guidelines' },
];

/**
 * lucide v1 ships no brand icons, so these are monograms rather than logos.
 * They only become pressable once real profile URLs are passed in.
 */
const SOCIALS = [
  { key: 'facebook', mark: 'f', label: 'Facebook' },
  { key: 'instagram', mark: 'ig', label: 'Instagram' },
  { key: 'youtube', mark: 'yt', label: 'YouTube' },
  { key: 'x', mark: '𝕏', label: 'X' },
  { key: 'linkedin', mark: 'in', label: 'LinkedIn' },
] as const;

export type SocialKey = (typeof SOCIALS)[number]['key'];

export type FooterProps = {
  /** Real profile URLs. Marks without one render as non-interactive. */
  socialUrls?: Partial<Record<SocialKey, string>>;
  /**
   * Whether to cancel the standard screen gutters and run edge to edge.
   *
   * ⚠ A prop rather than something worked out internally, unlike the web-only
   *   check below — because a component cannot see its parent's padding.
   *
   *   Almost every screen puts `screenPadding` on its scroll container, so a
   *   footer placed inside would sit in a `Spacing.four` gutter with a
   *   `Spacing.six` band of canvas beneath it: a floating blue slab rather than
   *   the base of the page. Defaulting to `true` makes the common case correct
   *   without anyone having to think about it.
   *
   *   The home page is the exception. Its padding lives on an inner `page` view
   *   and the footer is already outside it, so cancelling gutters that are not
   *   there would push the footer wider than the window and put a horizontal
   *   scrollbar on the marketing page.
   */
  bleed?: boolean;
};

export function Footer({ socialUrls, bleed = true }: FooterProps) {
  const router = useRouter();
  const experience = useExperience();

  /*
   * ⚠ Web only, decided here rather than at each of the twenty call sites.
   *
   *   A phone navigates from the bottom tab bar, which is pinned to the base of
   *   the screen — so a footer would sit immediately above it, repeating links
   *   the bar already carries and pushing the bar's targets into a wall of
   *   brand blue. The header makes the same judgement in `sticky-header.tsx`.
   *
   *   Deciding it inside the component is what keeps the rule true: a screen
   *   added next year renders `<Footer />` without knowing there is a rule, and
   *   gets it right. A `Platform.OS === 'web' &&` at every call site is a rule
   *   that survives exactly as long as everyone remembers it.
   *
   *   Null rather than an empty View, so no layout space is reserved for it.
   */
  if (experience && experience !== 'web') return null;

  return (
    <View style={[styles.footer, bleed && styles.bleed]}>
      {/* Row 1 — links, wrapping and centred at any width. */}
      <View style={styles.links}>
        {LINKS.map((link) =>
          link.href ? (
            <Pressable
              key={link.label}
              onPress={() => router.navigate(link.href as FooterRoute)}
              accessibilityRole="link"
              hitSlop={6}
              style={({ pressed }) => (pressed ? styles.pressed : undefined)}>
              {({ hovered }: { hovered?: boolean }) => (
                <Text style={[styles.link, Platform.OS === 'web' && hovered && styles.linkHovered]}>
                  {link.label}
                </Text>
              )}
            </Pressable>
          ) : (
            // No screen behind it yet — shown, but not a dead tap target.
            <Text key={link.label} style={styles.link}>
              {link.label}
            </Text>
          ),
        )}

        {/*
          ⚠ An action, not a route, and a compliance requirement rather than a
            convenience.

            Withdrawing consent has to be as easy as giving it (GDPR Art. 7(3)).
            Without a way back to the preferences panel, "Accept all" is a
            one-way door and the implementation does not comply however correct
            the banner itself is. The footer is where people look for this, and
            it is on every screen.

            Hidden on native and whenever no optional category is live — see
            `cookiePreferencesAvailable`.
        */}
        {cookiePreferencesAvailable() && (
          <Pressable
            onPress={openCookiePreferences}
            accessibilityRole="button"
            hitSlop={6}
            style={({ pressed }) => (pressed ? styles.pressed : undefined)}>
            {({ hovered }: { hovered?: boolean }) => (
              <Text style={[styles.link, Platform.OS === 'web' && hovered && styles.linkHovered]}>
                Cookie Preferences
              </Text>
            )}
          </Pressable>
        )}
      </View>

      {/* Row 2 — socials. */}
      <View style={styles.socials}>
        {SOCIALS.map((social) => {
          const url = socialUrls?.[social.key];

          return url ? (
            <Pressable
              key={social.key}
              onPress={() => Linking.openURL(url)}
              accessibilityRole="link"
              accessibilityLabel={`Package Relay on ${social.label}`}>
              {({ pressed, hovered }: { pressed?: boolean; hovered?: boolean }) => (
                <View
                  style={[
                    styles.chip,
                    (pressed || (Platform.OS === 'web' && hovered)) && styles.chipActive,
                  ]}>
                  <Text style={styles.chipMark}>{social.mark}</Text>
                </View>
              )}
            </Pressable>
          ) : (
            <View key={social.key} accessibilityLabel={social.label} style={styles.chip}>
              <Text style={styles.chipMark}>{social.mark}</Text>
            </View>
          );
        })}
      </View>

      {/* Row 3 — copyright. */}
      <Text style={styles.copyright}>
        © 2026 LOCI Logistics Technologies Limited. All rights reserved.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    width: '100%',
    alignItems: 'center',
    backgroundColor: FooterColors.background,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.three,
  },
  /*
    Out through the screen's own gutters, and flush with its base.

    ⚠ `alignSelf: 'stretch'` is required, not cosmetic. Every screen's scroll
      container centres its children with `alignItems: 'center'`, which sizes
      this to its contents — a blue lozenge around six links. Stretch overrides
      the parent's cross-axis rule for this child alone.

    The numbers mirror `screenPadding` in `ui/screen.tsx`, which is the one
    place they are defined; the two screens that write their own padding use the
    same values. `marginTop` puts air between the page and its base, replacing
    the bottom padding being cancelled.
  */
  bleed: {
    alignSelf: 'stretch',
    width: 'auto',
    marginHorizontal: -Spacing.four,
    marginBottom: -Spacing.six,
    marginTop: Spacing.six,
  },
  links: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: Spacing.four,
    rowGap: Spacing.two + 2,
  },
  link: {
    ...Typography.body,
    ...font(500),
    color: FooterColors.text,
  },
  linkHovered: {
    textDecorationLine: 'underline',
  },
  socials: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  chip: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    backgroundColor: FooterColors.chip,
    borderColor: FooterColors.chipBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: FooterColors.chipActive,
  },
  chipMark: {
    ...Typography.badge,
    ...font(700),
    color: FooterColors.text,
  },
  copyright: {
    ...Typography.caption,
    textAlign: 'center',
    color: FooterColors.text,
    marginTop: Spacing.three,
  },
  pressed: {
    opacity: 0.7,
  },
});
