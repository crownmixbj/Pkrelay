/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    // Base surfaces
    text: '#0F172A',
    background: '#F8FAFC',
    backgroundElement: '#F1F5F9',
    backgroundSelected: '#E2E8F0',
    textSecondary: '#334155',

    /** Elevated card / input surface sitting on `background`. */
    surface: '#FFFFFF',
    /** Recessed strip inside a card, e.g. a read-only value row. */
    surfaceMuted: '#F1F5F9',
    /** Top navigation bar. */
    navBackground: '#FFFFFF',
    navBorder: '#E2E8F0',
    /** Hairline card and input border. */
    border: '#E2E8F0',
    /** Slightly stronger border for inputs at rest. */
    borderStrong: '#CBD5E1',
    /**
     * Tertiary text: tracking IDs, placeholders, disabled labels.
     *
     * ⚠ #64748B until `verify:palette` was written, and it never cleared AA on
     *   anything but white — 4.34:1 on `surfaceMuted`, 4.31:1 on a band. Every
     *   placeholder inside an input (which is `surfaceMuted`) was under the
     *   floor. One step darker clears every surface in the system with room to
     *   spare and is visually indistinguishable from the old one.
     */
    textMuted: '#5B687E',
    shadow: '#0F172A',

    /**
     * Brand blue.
     *
     * ⚠ This was #0077B6, and it was failing AA on the page it sat on.
     *
     *   The old note reasoned from 4.87:1 *on white* — correct, and not the
     *   measurement that mattered, because the page ground was `PageCanvas`,
     *   a flat cyan. On that, #0077B6 measures **4.37:1**: every nav link,
     *   every "See all", every price in brand blue was under the floor. The
     *   number was right about a surface the text was never on.
     *
     *   #0B5FFF is both brighter and safer: 5.13:1 on white, 4.90:1 on the
     *   ground, 4.68:1 on `surfaceMuted`, and 5.13:1 the other way round for
     *   white labels on a primary fill. `verify:palette` now computes every
     *   one of these from the tokens rather than from a comment.
     */
    primary: '#0B5FFF',
    /** 7.80:1 under a white label — the pressed state is never the weak one. */
    primaryPressed: '#0A47C2',
    primaryText: '#FFFFFF',
    /**
     * Decorative only — never behind text, and never as a lone indicator.
     *
     * ⚠ And this is why primary buttons are a flat fill rather than a gradient.
     *
     *   A `primaryAccent → primary` gradient looks the part, but white on the
     *   bright end measures 3.20:1. A button whose label is legible at one end
     *   and not the other is worse than a flat one. Where a gradient is wanted,
     *   `primary → primaryPressed` is the accessible pair: 5.13:1 at its
     *   lightest point.
     */
    primaryAccent: '#4D8DFF',
    /** Tinted fill behind primary-toned pills and icon chips. */
    primarySoft: '#E4EDFF',
    primaryOnSoft: '#1D4ED8',

    // Status tones
    successSoft: '#DCFCE7',
    successOnSoft: '#15803D',
    success: '#16A34A',

    warningSoft: '#FEF3C7',
    warningOnSoft: '#B45309',
    warning: '#D97706',

    dangerSoft: '#FEE2E2',
    dangerOnSoft: '#B91C1C',
    danger: '#DC2626',

    neutralSoft: '#F1F5F9',
    neutralOnSoft: '#475569',
    neutral: '#94A3B8',
  },
  dark: {
    // Base surfaces
    text: '#f8fafc',
    background: '#0A111E',
    backgroundElement: '#1a2436',
    backgroundSelected: '#243044',
    textSecondary: '#94a3b8',

    surface: '#131c2b',
    surfaceMuted: '#1b2536',
    /** Floating capsule navigation bar. */
    navBackground: '#1E232A',
    navBorder: '#2f3540',
    border: '#243146',
    borderStrong: '#33455f',
    textMuted: '#64748b',
    shadow: '#000000',

    /**
     * Package Relay brand cyan. `primaryText` is deep navy rather than white: white on
     * #19A7CE measures 2.81:1, below the 4.5:1 WCAG AA floor. Navy gives 5.81:1
     * and keeps the fill exactly on-brand.
     */
    primary: '#19A7CE',
    // Pressed lightens rather than darkens: the label is navy, so a darker
    // fill would drop below AA (#1490b2 measures only 4.41:1).
    primaryPressed: '#3fb8da',
    primaryText: '#04232E',
    primaryAccent: '#19A7CE',
    primarySoft: '#0b3d4e',
    primaryOnSoft: '#7dd8f0',

    // Status tones — success is green so it reads apart from the cyan brand
    successSoft: '#14532d',
    successOnSoft: '#bbf7d0',
    success: '#22c55e',

    warningSoft: '#4a2f0a',
    warningOnSoft: '#fde68a',
    warning: '#fbbf24',

    dangerSoft: '#4c1d1d',
    dangerOnSoft: '#fecaca',
    danger: '#ef4444',

    neutralSoft: '#1e2637',
    neutralOnSoft: '#cbd5e1',
    neutral: '#64748b',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * The ground behind every screen.
 *
 * ⚠ This was a flat cyan (#E0F7FA), and that one line is most of why the app
 *   read as washed out rather than bright.
 *
 *   When the whole page is tinted there is nothing for a tint to stand out
 *   from: white cards read as holes punched in the ground rather than surfaces
 *   lifted off it, and the brand blue has no neutral to be brand-coloured
 *   against. It also pushed `primary` under AA — see the note on that token.
 *   Bright commercial apps do the opposite: a near-neutral ground, then colour
 *   spent deliberately on `Bands`, chips, tones and the primary action.
 *
 * ⚠ Derived rather than typed out, because the hero's wash has to match it.
 *
 *   `(tabs)/index.tsx` paints a gradient over the hero photograph in this
 *   colour so the page appears to come forward over the picture. Written as a
 *   second literal, the two drift and the wash turns into a visible grey veil.
 *   `verify:layout` asserts the wash equals `Colors.light.background`; this
 *   makes `PageCanvas` the same value by construction.
 */
export const PageCanvas = Colors.light.background;

/**
 * Tinted section bands — the replacement for tinting the whole page.
 *
 * A band is how a section says "I am a different thing from the one above me"
 * without the page having to be a colour. Used by the app-download block and
 * available to any full-width section that needs separating from its
 * neighbours.
 */
export const Bands = {
  /** Cool, brand-adjacent. The default, and currently the only one. */
  cool: '#EEF4FF',
} as const;

/*
 * ⚠ There was a `coolStrong: '#E4EDFF'` here and it lasted one test run.
 *
 *   Nothing used it, and `primary` on it measures 4.36:1 — so its first use
 *   would have been its first AA failure. A second band is easy to add once
 *   something needs one and the pairs are computed for it; an unused token
 *   that quietly fails is a trap with a nice name.
 */

/**
 * Hero block behind the headline when no photograph is set.
 *
 * ⚠ Was a warm cream (#FDF6F0), which is now the one warm surface in a cool
 *   system — on the new ground it reads as a stain rather than a choice.
 */
export const HeroSurface = Bands.cool;

/** Semantic tones used by badges and pills. Each maps to a `<tone>Soft` / `<tone>OnSoft` pair. */
export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

export const toneColors = (
  theme: (typeof Colors)['light'] | (typeof Colors)['dark'],
  tone: Tone,
): { background: string; foreground: string; solid: string } => {
  switch (tone) {
    case 'success':
      return {
        background: theme.successSoft,
        foreground: theme.successOnSoft,
        solid: theme.success,
      };
    case 'warning':
      return {
        background: theme.warningSoft,
        foreground: theme.warningOnSoft,
        solid: theme.warning,
      };
    case 'danger':
      return { background: theme.dangerSoft, foreground: theme.dangerOnSoft, solid: theme.danger };
    case 'neutral':
      return {
        background: theme.neutralSoft,
        foreground: theme.neutralOnSoft,
        solid: theme.neutral,
      };
    case 'primary':
    default:
      return {
        background: theme.primarySoft,
        foreground: theme.primaryOnSoft,
        solid: theme.primary,
      };
  }
};

/**
 * Only two families ship: the app face (see `AppFontFamily`) and a monospace
 * for code samples. The serif and rounded overrides are gone — nothing used
 * them, and a second display face works against a single type system.
 */
export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    mono: 'var(--font-mono)',
  },
});

/**
 * Plus Jakarta Sans, one file per weight. React Native doesn't synthesise
 * weights from a single family on Android, so the family name has to change
 * with the weight — setting `fontWeight` alone would silently render Regular
 * everywhere. There's no CSS-style fallback list here either: `fontFamily`
 * takes one name, so the loader in _layout.tsx is what guarantees these exist.
 */
export const AppFontFamily = {
  400: 'PlusJakartaSans_400Regular',
  500: 'PlusJakartaSans_500Medium',
  600: 'PlusJakartaSans_600SemiBold',
  700: 'PlusJakartaSans_700Bold',
  800: 'PlusJakartaSans_800ExtraBold',
} as const;

export type AppFontWeight = keyof typeof AppFontFamily;

/**
 * Pairs the right file with its numeric weight. 900 clamps to 800, the heaviest
 * face bundled.
 */
export function font(weight: 400 | 500 | 600 | 700 | 800 | 900 = 400) {
  const resolved: AppFontWeight = weight >= 800 ? 800 : (weight as AppFontWeight);
  return {
    fontFamily: AppFontFamily[resolved],
    fontWeight: String(resolved) as `${AppFontWeight}`,
  };
}

/** Applied as the app-wide default via `Text` styles. */
export const BaseFont = font(400);

/**
 * Per-service palettes for the home cards.
 *
 * `accent` is the specified brand hue and carries the icon circle, arrow
 * button and pattern. `text` is a darkened variant used for the title and
 * subtitle, and `onAccent` is what sits on top of `accent` — several of the
 * specified hues are too light to carry white or their own text at AA:
 *
 *   #007FFF on its tint  3.53:1     white on #007FFF  3.83:1
 *   #DAA520 on its tint  2.07:1     white on #DAA520  2.24:1
 *   #4169E1 on its tint  4.34:1     white on #4169E1  4.85:1
 *
 * so the text variants are darkened to clear 4.5:1 while the fills keep the
 * exact hue asked for.
 */
export const ServiceTones = {
  /*
   * ⚠ Every `text` here moved one step darker, and none of them were new bugs.
   *
   *   Measured against their own card fills the originals ran 4.31:1 to
   *   4.43:1 — all four under AA, all four shipped, none noticed, because the
   *   numbers had never been computed. `azure.accent` was worse: white on
   *   #007FFF is 3.83:1, on a badge that carries an icon. The fills and the
   *   character of each tone are unchanged; only the ink on them moved.
   */
  teal: {
    accent: '#008080',
    text: '#026B6B',
    onAccent: '#FFFFFF',
    backgroundFrom: '#EDF7F5',
    backgroundTo: '#FFFDF6',
  },
  azure: {
    /* The brand blue itself — azure was always a second name for it. */
    accent: '#0B5FFF',
    text: '#0062C7',
    onAccent: '#FFFFFF',
    backgroundFrom: '#E8F1FF',
    backgroundTo: '#F8FBFF',
  },
  gold: {
    accent: '#DAA520',
    text: '#7E5D0C',
    onAccent: '#3D2E06',
    backgroundFrom: '#FBF1DC',
    backgroundTo: '#FFFCF4',
  },
  royal: {
    accent: '#4169E1',
    text: '#3457C4',
    onAccent: '#FFFFFF',
    backgroundFrom: '#EAEFFC',
    backgroundTo: '#F8FAFE',
  },
} as const;

export type ServiceToneName = keyof typeof ServiceTones;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;

/**
 * The two measures this site lines up on, and the difference between them.
 *
 * ⚠ `PageMeasure` is the one everything *chrome* and *marketing* shares.
 *
 *   The navigation capsule, the live ticker, the home hero's copy and every
 *   band below it all cap here and centre. Before this existed they did not:
 *   on a 2560px window the ticker ran edge to edge at x=0, the nav and the hero
 *   sat at x=24, and the content below was a 1232px column centred at x=664 —
 *   four different left edges, so the wordmark, the headline and the body text
 *   never lined up with each other. Nothing about that is visible on a laptop,
 *   because below about 1328px the cap never engages and all four collapse onto
 *   the same edge. It is only wrong on the machines people demo on.
 *
 *   Full-bleed *media* may still break out of it — the hero photograph does,
 *   deliberately — but no text does.
 *
 * ⚠ `MaxContentWidth` is narrower on purpose, and is not a competing opinion.
 *
 *   It is the reading measure for app routes: forms, lists, a parcel's detail.
 *   A booking form 1280px wide is a worse form, so those screens centre at 800
 *   inside a header that caps at 1280. That is the normal arrangement — chrome
 *   wider than content — rather than a second system.
 */
export const PageMeasure = 1280;
export const MaxContentWidth = 800;

/** Corner radii. `pill` is deliberately huge so it always fully rounds. */
export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

/** Type scale. Pair `title`/`sectionTitle` with muted `caption`/`meta` for hierarchy. */
/**
 * One scale for the whole app. Sizes follow the Tailwind steps the design
 * references — 4xl/5xl hero, 2xl section headers, base card titles, sm for
 * supporting text, buttons and badges — so nothing sets its own font size.
 */
/**
 * The type scale.
 *
 * One ramp, seven steps, and every token below sits on one of them. Before
 * this, seven of the twelve tokens were all 14px — `body`, `caption`, `meta`,
 * `label`, `badge`, `button` and `screenSubtitle` rendered identically — so a
 * footnote was the same size as the sentence it footnoted. The names promised
 * an order the values did not have.
 *
 * The steps are the widely used mobile ramp rather than a bespoke curve:
 *
 *     display   32   the largest thing on a screen that is not the hero
 *     title     28   screen titles
 *     heading   22   section headers within a screen
 *     subhead   17   card titles, sub-headers
 *     body      16   default reading size
 *     small     14   secondary text: metadata, labels, button faces
 *     caption   12   footnotes, hints, timestamps
 *     micro     11   the floor — overlines and dense badges only
 *
 * 16 for body is deliberate. It is the size below which mobile body text stops
 * being comfortable, and the browser default that people's zoom settings are
 * calibrated against. Nothing goes below `micro`: 9px and 10px text existed in
 * this app and is unreadable on a phone in daylight.
 */
export const FontSize = {
  display: 32,
  title: 28,
  heading: 22,
  subhead: 17,
  body: 16,
  small: 14,
  caption: 12,
  micro: 11,
} as const;

export type FontSizeStep = keyof typeof FontSize;

/**
 * Line height from size, rather than typed out per token.
 *
 * Large text needs proportionally *less* leading than small text — a 32px
 * heading at 1.5 looks like two separate lines, and 12px at 1.2 is cramped. The
 * ratio therefore tightens as the size grows, which is what typesetting has
 * always done and what a flat multiplier gets wrong at both ends.
 */
export function lineHeightFor(size: number): number {
  const ratio = size >= 28 ? 1.2 : size >= 20 ? 1.3 : size >= 16 ? 1.5 : 1.45;
  return Math.round(size * ratio);
}

export const Typography = {
  /** Hero. Pair with `heroTitleSize(width)` for the 4xl → 5xl step-up. */
  heroTitle: { ...font(800), letterSpacing: -1, lineHeight: 44 },

  /** The biggest thing on a screen short of the hero. */
  display: {
    fontSize: FontSize.display,
    ...font(800),
    letterSpacing: -0.6,
    lineHeight: lineHeightFor(FontSize.display),
  },
  screenTitle: {
    fontSize: FontSize.title,
    ...font(700),
    letterSpacing: -0.5,
    lineHeight: lineHeightFor(FontSize.title),
  },
  /** Centred section headers: How Package Relay Works, My Sent Packages, Available Jobs. */
  sectionHeading: {
    fontSize: FontSize.heading,
    ...font(700),
    letterSpacing: -0.3,
    lineHeight: lineHeightFor(FontSize.heading),
  },
  /** Sub-headers inside a section — smaller than `sectionHeading` by design. */
  sectionTitle: {
    fontSize: FontSize.subhead,
    ...font(600),
    lineHeight: lineHeightFor(FontSize.subhead),
  },
  cardTitle: {
    fontSize: FontSize.subhead,
    ...font(600),
    lineHeight: lineHeightFor(FontSize.subhead),
  },

  body: { fontSize: FontSize.body, ...font(400), lineHeight: lineHeightFor(FontSize.body) },
  /**
   * The subtitle under a screen title. One step below body, because it is
   * supporting text — at the same size it competed with the content beneath it.
   */
  screenSubtitle: {
    fontSize: FontSize.small,
    ...font(400),
    lineHeight: lineHeightFor(FontSize.small),
  },

  /** Secondary text: values, names, metadata. */
  meta: { fontSize: FontSize.small, ...font(400), lineHeight: lineHeightFor(FontSize.small) },
  label: { fontSize: FontSize.small, ...font(600), letterSpacing: 0.1 },
  button: { fontSize: FontSize.small, ...font(600) },

  /** Footnotes, hints, timestamps. Genuinely smaller than `meta` now. */
  caption: {
    fontSize: FontSize.caption,
    ...font(400),
    lineHeight: lineHeightFor(FontSize.caption),
  },
  badge: { fontSize: FontSize.caption, ...font(600), letterSpacing: 0.2 },

  /** The floor. Overlines and dense chips only — never a sentence. */
  micro: { fontSize: FontSize.micro, ...font(600), letterSpacing: 0.3 },

  /**
   * The PKRELAY wordmark. Deliberately off the ramp.
   *
   * A logotype is a drawn mark that happens to be set in type — it is sized to
   * look right next to the nav controls, not to sit in a reading hierarchy.
   * Snapping it to `subhead` shrank it from 20 to 17 and made the brand smaller
   * than a card title, which is the sort of thing a scale gets wrong when
   * applied without looking.
   */
  wordmark: { fontSize: 20, ...font(800), letterSpacing: 1.6 },
} as const;

/**
 * text-4xl on phones, text-5xl from the md breakpoint, text-6xl once the page
 * has hit its measure.
 *
 * ⚠ The third step is the one that was missing.
 *
 *   This stopped at 48 and never grew again, so a 48px headline sat inside a
 *   2512px hero — the size of a section title on a billboard. The step is tied
 *   to `PageMeasure` rather than to a new breakpoint because that is the point
 *   where the copy stops growing with the window: past it the column is fixed,
 *   so the type is the only thing left that can hold the hero's scale.
 *
 *   60 rather than 64: "Delivering with" sets to roughly 470px at 60/800, and
 *   the hero's copy column caps at 560.
 */
export function heroTitleSize(width: number): number {
  if (width >= PageMeasure) return 60;
  return width >= 768 ? 48 : 36;
}

/**
 * Section headers, which step up once there is desktop room for them.
 *
 * ⚠ Returns the line height as well, and that is not a convenience.
 *
 *   Spreading `Typography.sectionHeading` and overriding only `fontSize` keeps
 *   the 22px line height underneath a 32px glyph, which clips descenders on web
 *   and looks like a font-loading bug rather than a spacing one. The two have to
 *   move together, so they are returned together.
 */
export function sectionHeadingType(width: number): { fontSize: number; lineHeight: number } {
  const fontSize = width >= 1024 ? FontSize.display : FontSize.heading;
  return { fontSize, lineHeight: lineHeightFor(fontSize) };
}

/**
 * The gap between top-level sections. Wider once the page is wide, because a
 * 48px gap that separates two bands on a laptop reads as one continuous block
 * when those bands are 1280px across and the hero above them is 620px tall.
 */
export function sectionGap(width: number): number {
  return width >= 1024 ? 72 : 48;
}

/**
 * Card elevation. iOS gets a soft ambient shadow; Android uses the native
 * elevation prop, which ignores shadowColor/Offset.
 */
export const Elevation = {
  card: Platform.select({
    ios: {
      shadowOpacity: 0.06,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
    android: { elevation: 2 },
    default: {},
  }),
  raised: Platform.select({
    ios: {
      shadowOpacity: 0.1,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 5 },
    default: {},
  }),
} as const;
