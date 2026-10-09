import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  Ban,
  Bike,
  Boxes,
  ClipboardList,
  Clock,
  FileText,
  House,
  MapPin,
  Milestone,
  PackageCheck,
  PackageOpen,
  PackageSearch,
  Radar,
  Route,
  Search,
  ShieldAlert,
  Truck,
  UserCheck,
  X,
} from 'lucide-react-native';
import { useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { AppDownload } from '@/components/ui/app-download';
import { Card } from '@/components/ui/card';
import { Footer } from '@/components/Footer';
import { HowItWorks } from '@/components/ui/how-it-works';
import { PulsingDot } from '@/components/ui/marquee';
import { SectionHeader } from '@/components/ui/section-header';
import { QuickQuote } from '@/components/ui/quick-quote';
import { VerifyBanner } from '@/components/ui/verify-banner';
import { RiderIllustration } from '@/components/ui/rider-illustration';
import { EmptyState } from '@/components/ui/screen';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { ServiceCategoryCard } from '@/components/ui/service-category-card';
import { formatStamp } from '@/lib/when';
import { serviceArtwork } from '@/constants/service-artwork';
import { servicePrefillParams } from '@/constants/services';
import { HERO_BACKGROUND } from '@/constants/hero-background';
import {
  Colors,
  FontSize,
  HeroSurface,
  PageMeasure,
  Radius,
  Spacing,
  PageCanvas,
  Typography,
  font,
  heroTitleSize,
  sectionGap,
  sectionHeadingType,
  type ServiceToneName,
} from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  filterBookings,
  formatNaira,
  isPendingPickup,
  parcelsForUser,
  sortByPickupUrgency,
  routeLabel,
  stageProgress,
  statusLabel,
  useBookings,
  type Booking,
  type BookingStage,
} from '@/store/bookings';
import { useSession } from '@/store/session';

/**
 * Glass section shared by How Package Relay Works and My Sent Packages.
 *
 * ⚠ `action` and `trackActive` were hand-picked blues and are now the brand's.
 *
 *   `action` was #005FC5, chosen when the brand blue was #0077B6 and too light
 *   to use here; `trackActive` was #2563EB for the same reason. The brand is
 *   #0B5FFF now — 4.90:1 on the ground, 5.13:1 on white — so the reason both
 *   existed is gone, and three near-identical blues one shade apart is how a
 *   palette stops being a palette.
 */
const GlassSection = {
  /**
   * The panel no longer paints its own gradient — the page is already cyan, and
   * a second fill drew a visible seam across the section boundary.
   */
  gradientFrom: 'transparent',
  gradientTo: 'transparent',
  /** Deep navy for headings: 11.04:1 on the ground, 11.55:1 on the frosted cards. */
  title: '#0B3C5D',
  action: Colors.light.primary,
  cardFill: 'rgba(255,255,255,0.6)',
  cardBorder: 'rgba(255,255,255,0.6)',
  /** Waiting on a driver. */
  badgePending: '#FFE082',
  /** Moving. */
  badgeActive: '#A5D6A7',
  badgeText: '#0F172A',
  routeFill: 'rgba(209,250,229,0.8)',
  routeText: '#064E3B',
  trackInactive: '#E2E8F0',
  trackActive: Colors.light.primary,
} as const;

/** py-12 — the vertical rhythm between major sections. */
const SectionGap = 48;

/**
 * The hero photograph, and the band of it the copy lives in.
 *
 * ⚠ The picture is composed, not just cropped — its left 45% is empty on
 *   purpose.
 *
 *   `New-hero-bg.jpeg` is 1024×572 and puts the handover on the right; the
 *   left is a blue-to-cream gradient with nothing in it. That band is the copy
 *   column, which is why the headline is no longer centred. Centred, it ran
 *   straight across the two men. Measured over the unwashed photo at a 1280
 *   window the left-hand column reads 15.2:1 for the headline (#0F172A) and
 *   8.8:1 for the eyebrow and subtitle (#334155), with nothing under 4.5:1 —
 *   so on a desktop the composition does the work and no scrim is needed.
 *
 * ⚠ Below `breakpoint` the copy spans the frame and those numbers invert.
 *
 *   `cover` on a portrait-ish box crops horizontally, so a phone sees the
 *   middle of the picture — a navy polo and a cardboard box — under the whole
 *   text block. Unwashed, 18% of the headline's area falls under 4.5:1 and the
 *   worst pixel is 1.0:1, which is black on black. `HeroScrim.narrow` is what
 *   answers that.
 */
const Hero = {
  /** Above this the copy fits beside the scene; below it, it covers the scene. */
  breakpoint: 900,
  /** Any wider and the last line of the headline reaches the first man. */
  copyMaxWidth: 560,
  /**
   * ⚠ A height floor that is really a crop guard.
   *
   *   The hero is as tall as its copy needs, so on a 2560px window the box is
   *   nearly 10:1 and `cover` keeps a tenth of the picture: two pairs of hands
   *   and no faces. Holding the box at 3:1 or squarer keeps the heads and the
   *   parcel in frame. Capped, because past a point a hero is just a wall.
   */
  maxAspect: 3,
  minHeightCap: 620,
  /**
   * Where `cover` crops from.
   *
   * `top: 38%` on both: the faces sit in the picture's top third, so a centred
   * vertical crop takes the tops of their heads first.
   *
   * ⚠ The horizontal anchor is the whole narrow-screen strategy.
   *
   *   A box narrower than 1.79:1 crops horizontally, and `50%` hands a phone
   *   the middle of the picture — a navy polo and a cardboard box — directly
   *   under the text. `0%` leads with the empty band the photograph was built
   *   with instead, so the copy keeps its clean ground and the handover comes
   *   back into frame as the viewport widens. It is the same composition
   *   decision as the copy column, applied to the part of the picture a narrow
   *   screen can afford to show.
   */
  crop: {
    wide: { top: '38%', left: '50%' },
    narrow: { top: '38%', left: '0%' },
  },
  /**
   * The subtitle is the one line that reaches the far edge — the longest run
   * of the lightest colour. Capping its measure is what lets the wash below
   * stay light enough to see the photograph through.
   */
  subtitleMaxWidth: 460,
} as const;

/**
 * The wash over the photograph, in `Colors.light.background` so it reads as
 * the page coming forward rather than as a grey veil.
 *
 * ⚠ `wide` was 0.55 → 0.30 and that was measured too narrowly.

 * The numbers were taken at a 1232px box, where the copy sits over the very
 * lightest part of the gradient and anything down to no wash at all passes.
 * Swept across 320–3440px afterwards, the subtitle — the longest line in the
 * lightest colour — dropped to 1.5:1 at 900px and 2.95:1 at 1024px, where the
 * hero is narrow enough that a 400px column already reaches the first man.
 * 0.80 → 0.56 is the lightest pair that holds every element at 0% under 4.5:1
 * at every width in that sweep, with the narrow pair below.
 *
 * `narrow` never reaches zero, because below the breakpoint the text does reach
 * the far edge. Paired with the left-anchored crop and the capped subtitle
 * measure, these are the lightest alphas that hold 0% under 4.5:1 for every
 * element across the same sweep. The tail went 0.55 → 0.62 for the 500–700px
 * band, where the crop is wide enough to show the blurred figures behind the
 * handover and the end of the subtitle lands on them. A wash heavy enough to
 * work without the crop and the measure (0.94 → 0.70 flat across a centred
 * crop) also leaves the photograph a ghost, which is the version this
 * replaced.
 */
const HeroScrim = {
  wide: {
    colors: ['rgba(248,250,252,0.8)', 'rgba(248,250,252,0.56)', 'rgba(248,250,252,0)'],
    locations: [0, 0.5, 0.78],
  },
  narrow: {
    colors: ['rgba(248,250,252,0.93)', 'rgba(248,250,252,0.82)', 'rgba(248,250,252,0.62)'],
    locations: [0, 0.5, 1],
  },
} as const;

const STAGE_ICONS: Record<BookingStage, typeof Truck> = {
  Booked: ClipboardList,
  Assigned: UserCheck,
  'Picked Up': PackageCheck,
  'In Transit': Truck,
  'Out for Delivery': Bike,
  Delivered: House,
  // Not a stage on the journey, but the map has to be total — a parcel a sender
  // called off still appears in their list and still needs an icon.
  Cancelled: Ban,
};

type CategoryDef = {
  key: string;
  title: string;
  subtitle: string;
  tone: ServiceToneName;
  icon: (color: string, size: number) => React.ReactNode;
  /** Route to open, plus any params that pre-select a service on the form. */
  href: '/book' | '/driver' | '/rate-calculator';
  params?: Record<string, string>;
};

/**
 * The readability floor, moved here from the card's `minWidth`.
 *
 * The supplied artwork has its title baked in at about 7% of the image height,
 * so below this the title renders under ~11px and stops being legible. It now
 * decides how many columns there are, rather than fighting the flex line after
 * the fact.
 */
const MIN_CARD_WIDTH = 280;

/**
 * ⚠ One constant, used by the stylesheet *and* the column arithmetic.
 *
 *   Written twice, these drift — and a gap the maths disagrees with by four
 *   pixels is a row that overflows by twelve, which reads as a mysterious
 *   scrollbar rather than as a wrong number.
 */
const GRID_GAP = Spacing.three - 4;

const CATEGORIES: CategoryDef[] = [
  {
    key: 'send',
    title: 'Pickup & Drop',
    subtitle: 'Hub or doorstep within your city',
    tone: 'teal',
    icon: (color, size) => <PackageOpen color={color} size={size} />,
    href: '/book',
    params: servicePrefillParams('same-day-local'),
  },
  {
    key: 'interstate',
    title: 'Send a Package',
    subtitle: 'Ibadan, Lagos, Abuja',
    tone: 'azure',
    icon: (color, size) => <Route color={color} size={size} />,
    href: '/book',
    params: servicePrefillParams('interstate-express'),
  },
  {
    key: 'documents',
    title: 'Documents & Items',
    subtitle: 'Insured, tracked end to end',
    tone: 'gold',
    icon: (color, size) => <FileText color={color} size={size} />,
    href: '/book',
    params: servicePrefillParams('insured-parcels'),
  },
  {
    key: 'freight',
    title: 'Bulk & Inter-State',
    subtitle: 'Over 30 kg, by truck',
    tone: 'royal',
    icon: (color, size) => <Boxes color={color} size={size} />,
    href: '/driver',
  },
];

export default function HomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { bookings } = useBookings();
  const { viewerId, role } = useSession();

  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const trackY = useRef(0);

  const { width } = useWindowDimensions();

  /*
   * ⚠ Explicit columns, because flex-wrap cannot express a grid.
   *
   *   The cards were `flex: 1` inside a wrapping row. A wrapped card is alone
   *   on its line, and `flex: 1` there means "fill the line" — which is why the
   *   fourth service stretched across the whole second row.
   *
   *   CSS Grid would fix it on the web and do nothing on iOS or Android: Yoga
   *   has no grid implementation, so the native builds would fall back to a
   *   plain column. Computing the width instead behaves identically everywhere,
   *   and gives exactly what was asked for — a card bound to its column, not to
   *   whatever space is left over.
   */
  const [gridWidth, setGridWidth] = useState(0);

  const columns = Math.max(1, Math.floor((gridWidth + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)));

  /*
   * ⚠ Zero until the first layout, and the card treats that as "not yet".
   *
   *   Rendering a 0-width card for one frame would flash an empty panel. The
   *   card falls back to filling its line until a real measurement arrives.
   */
  const cardWidth = gridWidth > 0 ? (gridWidth - GRID_GAP * (columns - 1)) / columns : null;

  /** text-4xl on phones, text-5xl from md up. */
  const headlineSize = heroTitleSize(width);
  const heroArtSize = width >= 1100 ? 220 : width >= 700 ? 180 : 120;

  /*
   * The hero box is the page minus its gutter — the hero is full-bleed and
   * carries its own padding inside that. See the `Hero` constant for why each
   * of these exists.
   */
  const heroBoxWidth = width - Spacing.four * 2;
  /*
   * ⚠ Half of the *measure*, not half of the window.
   *
   *   The copy is contained even though the photograph is not, so its room is
   *   whatever the measure leaves, not whatever the monitor does. Taking half
   *   the window put a 560px column in a 2512px band with the content below it
   *   starting 600px further right.
   */
  const heroContentWidth = Math.min(heroBoxWidth, PageMeasure) - Spacing.four * 2;
  const heroHasRoomBeside = width >= Hero.breakpoint;
  const heroCopyMax = heroHasRoomBeside
    ? Math.min(Hero.copyMaxWidth, Math.round(heroContentWidth / 2))
    : undefined;
  const heroMinHeight = heroHasRoomBeside
    ? Math.min(Hero.minHeightCap, Math.round(heroBoxWidth / Hero.maxAspect))
    : undefined;
  const heroScrim = heroHasRoomBeside ? HeroScrim.wide : HeroScrim.narrow;
  const heroCrop = heroHasRoomBeside ? Hero.crop.wide : Hero.crop.narrow;
  const gap = sectionGap(width);
  const headingType = sectionHeadingType(width);
  // Two cards side by side need room; below this they stack.
  const twoUpCards = width >= 560;

  /**
   * Only parcels this session is party to — posted by them, or being driven by
   * them. Other people's unclaimed jobs stay in the Available Jobs feed.
   */
  const myParcels = useMemo(
    () => (viewerId ? parcelsForUser(bookings, viewerId) : []),
    [bookings, viewerId],
  );

  // Filter, then order so anything waiting on a driver sits at the top.
  const results = useMemo(
    () => sortByPickupUrgency(filterBookings(myParcels, query)),
    [myParcels, query],
  );
  const isSearching = query.trim().length > 0;

  /** Only senders see this section, so the title no longer varies by role. */
  const sectionTitle = 'My Sent Packages';

  /**
   * The home screen is a preview: two cards, with the rest a tap away on
   * /my-packages. Searching bypasses the cap — hiding matches behind a "see
   * all" would make the tracking search look broken.
   */
  const HOME_PREVIEW_LIMIT = 2;
  const visible = isSearching ? results : results.slice(0, HOME_PREVIEW_LIMIT);

  /** Carries any typed city straight into the browse screen's filter. */
  /** The search input now lives in the hero, so this scrolls to the results. */
  const scrollToTracking = () => {
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ y: Math.max(trackY.current - 12, 0), animated: true }),
    );
  };

  const handleTrack = () => {
    Keyboard.dismiss();
    scrollToTracking();
  };

  return (
    // Root slate — every section blends into this, no hard cuts.
    <View style={[styles.flex, styles.root]}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}>
        <View style={styles.page}>
          {/* Header and live ticker live in (tabs)/_layout.tsx. */}

          {/* ---------- Hero ---------- */}
          {/* The cream fill only applies when there's no photo behind it. */}
          <View
            style={[
              styles.hero,
              !HERO_BACKGROUND && styles.heroFallbackSurface,
              !!heroMinHeight && { minHeight: heroMinHeight },
              { marginBottom: gap },
            ]}>
            {HERO_BACKGROUND ? (
              <>
                {/*
                  `cover` crops rather than squashing; `Hero.crop` says where it
                  crops from, and why.
                */}
                <Image
                  source={HERO_BACKGROUND}
                  style={styles.heroPhoto}
                  contentFit="cover"
                  contentPosition={heroCrop}
                  accessibilityIgnoresInvertColors
                />
                {/*
                  ⚠ There was deliberately no scrim here, and the photograph is
                    why there is one now.

                    The old illustration was pale everywhere, so navy type sat
                    on it unaided. This picture has a navy polo shirt and a grey
                    pavement in the middle of the frame, and on a phone that
                    middle is the entire background. The wash is sized to the
                    column rather than painted over the whole image — on a
                    desktop it has faded out before it reaches anybody's face.

                    On web `start`/`end` only set the gradient's angle, which is
                    all this needs: left to right.
                */}
                <LinearGradient
                  pointerEvents="none"
                  colors={heroScrim.colors}
                  locations={heroScrim.locations}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.heroScrim}
                />
              </>
            ) : (
              // No photo supplied yet — see HERO_BACKGROUND.
              <View style={styles.heroArt} pointerEvents="none">
                <RiderIllustration width={heroArtSize} height={heroArtSize * 0.9} />
              </View>
            )}

            {/*
              ⚠ The photograph breaks out of the measure; the words never do.

                This wrapper is `contentWrap` by another name — same cap, same
                centring, same gutter — so the headline starts on exactly the
                pixel the download band below it starts on. The hero box itself
                stays full-bleed, which is what keeps the picture a banner on a
                wide monitor instead of a card floating in the middle of one.
            */}
            <View style={styles.heroInner}>
              <View style={[styles.heroCopy, !!heroCopyMax && { maxWidth: heroCopyMax }]}>
                <Text style={[styles.heroEyebrow, { color: theme.textSecondary }]}>
                  Welcome to Package Relay
                </Text>
                <Text
                  style={[
                    styles.heroHeadline,
                    styles.heroHeadlineLeft,
                    { color: theme.text, fontSize: headlineSize },
                  ]}>
                  Delivering with{'\n'}
                  {/*
                    ⚠ primaryPressed, not primary, and the reason survived a
                      repaint.

                      When the brand was #0077B6 this was forced: that blue
                      measured 4.14:1 median over the photograph with 100% of
                      its area under AA. #0B5FFF clears it — 4.69:1 at its worst
                      pixel across every width swept — but only just, and over a
                      photograph "only just" moves whenever the crop does.
                      primaryPressed holds 7.12:1 at its worst and still reads
                      as the brand.
                  */}
                  <Text style={{ color: theme.primaryPressed }}>Excellence</Text>
                </Text>

                <Text
                  style={[
                    styles.heroSubtitle,
                    styles.heroSubtitleLeft,
                    { color: theme.textSecondary },
                  ]}>
                  Reliable local and inter-state delivery services across Nigeria. Fast. Affordable.
                  Insured.
                </Text>

                {/*
                  One action card, not two.

                  The second was "Available packages" — a city box and a Schedule
                  a journey button. It went because declaring a journey already
                  lives under Jobs & Drivers, and a second door to the same screen
                  on the landing page split the hero between a customer action and
                  a driver one. The people who arrive here are overwhelmingly
                  senders; drivers know where their tab is.

                  `heroCards` is left-aligned by `heroCopy` and its max width
                  drops from 620 to 340 — see the style. The card itself is
                  `flex: 1`, so without that it would have stretched to fill the
                  pair's width.
                */}
                <View style={[styles.heroCards, !twoUpCards && styles.heroCardsStacked]}>
                  <GlassCard>
                    <View style={styles.heroCardHeader}>
                      <Radar color={theme.primary} size={16} />
                      <Text style={[styles.heroCardTitle, { color: theme.text }]}>
                        Track a parcel
                      </Text>
                    </View>

                    <View
                      style={[
                        styles.searchBar,
                        {
                          backgroundColor: theme.surfaceMuted,
                          borderColor: theme.border,
                        },
                        focused && styles.searchBarFocused,
                      ]}>
                      <Search color={focused ? theme.primary : theme.textMuted} size={16} />
                      <TextInput
                        style={[styles.searchInput, { color: theme.text }]}
                        placeholder="#PKG-1234"
                        placeholderTextColor={theme.textMuted}
                        value={query}
                        onChangeText={setQuery}
                        onFocus={() => setFocused(true)}
                        onBlur={() => setFocused(false)}
                        onSubmitEditing={handleTrack}
                        autoCorrect={false}
                        returnKeyType="search"
                      />
                      {isSearching && (
                        <Pressable
                          onPress={() => setQuery('')}
                          hitSlop={10}
                          accessibilityLabel="Clear">
                          <X color={theme.textMuted} size={16} />
                        </Pressable>
                      )}
                    </View>

                    <Button
                      label="Track Parcel"
                      size="md"
                      icon={(color, size) => <Search color={color} size={size} />}
                      onPress={handleTrack}
                    />
                  </GlassCard>
                </View>
              </View>
            </View>
          </View>

          {/*
            Centred column below the hero: on a wide desktop viewport the
            sections would otherwise stretch to the full window width.
          */}
          <View style={styles.contentWrap}>
            {/*
              ⚠ Above the quote, where somebody is about to start.

                This is the screen people land on and the one they price a
                delivery from, so it is where a verification prompt has a
                chance of being read before the form rather than at the end of
                it. It renders nothing for anyone already verified or waiting
                on a check — see `shouldShowVerifyBanner`.
            */}
            <VerifyBanner />

            {/* ---------- Download the app ---------- */}
            {/*
              First thing under the hero, and deliberately ahead of the quote.

              It is the one section a visitor can act on without knowing
              anything about us yet, and the tracking card above it is what they
              came for — somebody who has just tracked a parcel is the person
              most likely to want the app that does it for them. It renders
              nothing at all on native, so this costs the phone app a null.
            */}
            <View style={styles.appDownload}>
              <AppDownload />
            </View>

            {/* ---------- Quick quote ---------- */}
            <View style={[styles.quote, { marginBottom: gap }]}>
              <QuickQuote onBook={(params) => router.navigate({ pathname: '/book', params })} />

              <View style={styles.quoteStrapline}>
                {/*
                  ⚠ A section header, not a card title.

                    This was `Typography.cardTitle` — 17px, the same style the
                    cards *underneath* it use, at every width up to 2560. The
                    page therefore had no visible step between "section" and
                    "the things in the section", which is the hierarchy a
                    visitor reads a landing page by. `AppDownload` and
                    `HowItWorks` were already on `sectionHeading`; this one had
                    been missed.
                */}
                <Text
                  style={[styles.straplineTitle, headingType]}
                  accessibilityRole="header">
                  We Deliver Packages Within City
                </Text>
                <Text style={[styles.straplineBody, { color: theme.textSecondary }]}>
                  Send envelopes, documents and packages across town in no time.
                </Text>
              </View>
            </View>

            {/* ---------- Service categories ---------- */}
            {/* Grey-blue panel: gives the tinted cards something to lift off. */}
            <View style={[styles.gridPanel, { marginBottom: gap }]}>
              {/*
                ⚠ Measured rather than guessed from the window.
                
                  This panel sits inside a max-width column with its own
                  padding, so the window width is not the width the cards get.
                  `onLayout` reports what is actually available, which is the
                  only number the column maths can be right about.
              */}
              <View
                style={styles.grid}
                onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)}>
                {CATEGORIES.map((category) => (
                  <ServiceCategoryCard
                    key={category.key}
                    width={cardWidth}
                    title={category.title}
                    subtitle={category.subtitle}
                    tone={category.tone}
                    icon={category.icon}
                    artwork={serviceArtwork(category.key)}
                    onPress={() =>
                      category.params
                        ? router.navigate({ pathname: category.href, params: category.params })
                        : router.navigate(category.href)
                    }
                  />
                ))}
              </View>
            </View>

            {/*
            One cyan panel behind both sections, so they read as a single
            glass surface rather than two stacked blocks.
          */}
            <LinearGradient
              colors={[GlassSection.gradientFrom, GlassSection.gradientTo]}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={[styles.glassSection, { marginBottom: gap }]}>
              {/* ---------- How it works ---------- */}
              <HowItWorks />

              {/*
                No driver feed here any more.

                It listed unassigned parcels with a Claim button, which is the
                marketplace this release removed — see the header of
                `available-packages.tsx`. A driver's work arrives as a timed
                offer on Assigned Trip; a second list of the same parcels with a
                first-come button would have let one driver claim a parcel
                another was reading a countdown on.
              */}

              {/* ---------- My sent packages (senders only) ---------- */}
              {role !== 'driver' && (
                <View
                  style={styles.trackSection}
                  onLayout={(event) => {
                    trackY.current = event.nativeEvent.layout.y;
                  }}>
                  <SectionHeader
                    titleColor={GlassSection.title}
                    actionColor={GlassSection.action}
                    title={isSearching ? `Results (${results.length})` : sectionTitle}
                    actionLabel={isSearching ? 'Clear' : 'See all →'}
                    onAction={
                      isSearching ? () => setQuery('') : () => router.navigate('/my-packages')
                    }
                    accessibilityLabel={isSearching ? 'Clear search' : 'See all of your packages'}
                  />

                  {!viewerId ? (
                    /*
                       Signed out: a prompt, not someone else's parcels. This
                       section used to render the seeded demo bookings against
                       a fallback identity, so a stranger saw recipient names
                       and phone numbers presented as their own.
                    */
                    <SignedOutState
                      title="Sign in to track your parcels"
                      message="Parcels you send appear here with live status, so you can follow them from pickup to delivery."
                      next="/"
                    />
                  ) : results.length === 0 ? (
                    <Card style={styles.emptyCard}>
                      <EmptyState
                        icon={(color, size) => <PackageSearch color={color} size={size} />}
                        title={isSearching ? 'No matches' : 'No active deliveries right now'}
                        message={
                          isSearching
                            ? `Nothing matches “${query.trim()}”. Try a different tracking ID, item, or route.`
                            : 'Parcels you send will appear here while they are on the move.'
                        }
                      />
                      {!isSearching && (
                        <Button
                          label="Book a Shipment"
                          size="md"
                          style={styles.emptyCta}
                          icon={(color, size) => <Milestone color={color} size={size} />}
                          onPress={() => router.navigate('/book')}
                        />
                      )}
                    </Card>
                  ) : (
                    <View style={styles.parcelGrid}>
                      {visible.map((booking) => (
                        <TrackingCard
                          key={booking.id}
                          booking={booking}
                          onPress={() =>
                            router.push({ pathname: '/parcel/[id]', params: { id: booking.id } })
                          }
                        />
                      ))}
                    </View>
                  )}
                </View>
              )}
            </LinearGradient>
          </View>
        </View>

        {/*
          Outside `page` so it ignores the horizontal padding and runs
          edge to edge — which is why it is the one caller that does not need
          `bleed`. See the prop's note in `Footer.tsx`.
        */}
        <Footer bleed={false} />
      </ScrollView>
    </View>
  );
}

/**
 * Hero visual: the photograph, with a cyan-tinted overlay to sit it in the
 * theme. Falls back to the vector illustration if the image fails to load —
 * offline, blocked, or a dead URL.
 */
/**
 * Frosted panel for the hero search cards. `BlurView` does the real blur on
 * iOS, Android and web; the translucent fill and hairline highlight on top of
 * it are what actually read as glass, and they still carry the card if the
 * platform can't blur.
 */
function GlassCard({ children }: { children: React.ReactNode }) {
  const theme = useTheme();

  return (
    // Shadow and clip can't share a view: `overflow: 'hidden'` crops the shadow
    // on iOS. Outer view casts it, inner one clips the blur to the radius.
    <View style={[styles.heroCard, { shadowColor: theme.shadow }]}>
      <BlurView intensity={60} tint="light" style={styles.heroCardBlur}>
        <View style={styles.heroCardInner}>{children}</View>
      </BlurView>
    </View>
  );
}

function TrackingCard({ booking, onPress }: { booking: Booking; onPress: () => void }) {
  const theme = useTheme();
  const isLocal = booking.deliveryType === 'local';
  const progress = stageProgress(booking.status);
  const StageIcon = STAGE_ICONS[booking.status] ?? Truck;
  const isDelivered = booking.status === 'Delivered';
  const isPending = isPendingPickup(booking);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${booking.itemDescription}, ${booking.trackingId}, ${statusLabel(booking)}${
        isPending ? ', waiting for a driver' : ''
      }. View details`}
      style={({ pressed }) => [styles.gridItem, pressed && styles.cardPressed]}>
      <BlurView intensity={40} tint="light" style={styles.cardBlur}>
        <View style={[styles.card, isPending && styles.cardPending]}>
          <View style={styles.cardHeader}>
            <Text style={[styles.cardTitle, { color: GlassSection.title }]} numberOfLines={2}>
              {booking.itemDescription}
            </Text>

            {/*
              Amber while it waits for a driver, green once it's moving — but
              those two fills are only 1.27:1 apart, and 1.65:1 under red-green
              deficiency, so the colour is decoration. The leading glyph is what
              actually separates the states: a clock when waiting, the stage's
              own icon once it's moving.
            */}
            <View
              style={[
                styles.statusBadge,
                {
                  backgroundColor: isPending ? GlassSection.badgePending : GlassSection.badgeActive,
                },
              ]}>
              {isPending ? (
                <Clock color={GlassSection.badgeText} size={11} />
              ) : (
                <StageIcon color={GlassSection.badgeText} size={11} />
              )}
              <Text style={[styles.statusBadgeText, { color: GlassSection.badgeText }]}>
                {isPending ? 'Awaiting driver' : statusLabel(booking)}
              </Text>
            </View>
          </View>

          <View style={styles.cardMetaRow}>
            <Text style={[styles.trackingId, { color: theme.textSecondary }]}>
              {/* Posted when, in Lagos time — the card otherwise said only what
                  and where, never when, so two parcels of the same thing were
                  indistinguishable. */}
              #{booking.trackingId} · {formatStamp(booking.createdAt)}
            </Text>
            {booking.fragile && (
              <ShieldAlert color={theme.warning} size={14} accessibilityLabel="Fragile" />
            )}
          </View>

          <View style={[styles.routePill, { backgroundColor: GlassSection.routeFill }]}>
            {isLocal ? (
              <MapPin color={GlassSection.routeText} size={11} />
            ) : (
              <Milestone color={GlassSection.routeText} size={11} />
            )}
            {/* `routeLabel` already prefixes "Local: " / "Inter-State: " — adding
                it again here is what produced "Local: Local: Challenge → Ring Road". */}
            <Text style={[styles.routePillText, { color: GlassSection.routeText }]}>
              {routeLabel(booking)}
            </Text>
          </View>

          <View style={styles.progressBlock}>
            <View
              style={[styles.track, { backgroundColor: GlassSection.trackInactive }]}
              accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: progress.total, now: progress.step }}>
              {progress.fraction > 0 && (
                <View
                  style={[
                    styles.trackFill,
                    {
                      width: `${Math.round(progress.fraction * 100)}%`,
                      backgroundColor: isDelivered ? theme.success : GlassSection.trackActive,
                      shadowColor: isDelivered ? theme.success : GlassSection.trackActive,
                    },
                  ]}
                />
              )}
            </View>

            <View style={styles.statusRow}>
              {isPending ? (
                <PulsingDot color={theme.warning} />
              ) : (
                <StageIcon color={isDelivered ? theme.success : theme.primary} size={13} />
              )}
              <Text
                style={[
                  styles.statusText,
                  {
                    color: isPending ? theme.warning : isDelivered ? theme.success : theme.primary,
                  },
                ]}
                numberOfLines={1}>
                {statusLabel(booking)}
              </Text>
              <Text style={[styles.stepText, { color: theme.textSecondary }]}>
                {progress.step}/{progress.total}
              </Text>
            </View>
          </View>

          <View style={styles.cardFooter}>
            <Text style={[styles.footerMeta, { color: theme.textSecondary }]} numberOfLines={1}>
              {booking.recipientName}
            </Text>
            <Text style={[styles.footerFee, { color: GlassSection.title }]}>
              {formatNaira(booking.estimatedFee)}
            </Text>
          </View>
        </View>
      </BlurView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  /** Unified cyan canvas — every section sits on this, no white break lines. */
  root: {
    backgroundColor: PageCanvas,
  },
  scrollContent: {
    // No bottom padding: the footer is the page's base and runs to the edge.
    paddingBottom: 0,
  },
  /** max-w-7xl, centred, with its own gutter. */
  /**
   * ⚠ One shape, used three times, and that is the point.
   *
   *   `contentWrap`, `heroInner` and the nav capsule's own wrapper are all
   *   "cap at the measure, centre, then gutter as padding". Spelled the same
   *   way in all three places, they put the wordmark, the hero headline and
   *   every band below it on one left edge at every width. Written differently
   *   in any one of them, they do not — which is what this page looked like
   *   before, and only on a monitor wide enough for the cap to engage.
   */
  contentWrap: {
    width: '100%',
    maxWidth: PageMeasure,
    alignSelf: 'center',
    paddingHorizontal: Spacing.four,
  },
  page: {
    // Full-bleed: no maxWidth, so the layout fills wide web viewports.
    width: '100%',
    flex: 1,
    paddingHorizontal: Spacing.four,
    // The nav bar already clears the status bar, so only breathing room here.
    paddingTop: Spacing.three,
  },
  pressed: {
    opacity: 0.8,
  },
  // Every top-level section carries the same 32px bottom margin and no top
  // margin, so the vertical rhythm can't drift as blocks get reordered.

  // Hero
  hero: {
    width: '100%',
    marginBottom: SectionGap,
    // The gutter moved to `heroInner` — this box is deliberately full-bleed.
    // Halved from Spacing.five (32) to keep the banner compact.
    paddingVertical: Spacing.four,
    borderRadius: 24,
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
    /* The copy is a column against the left edge, not a centred block. */
    alignItems: 'flex-start',
  },
  heroFallbackSurface: {
    backgroundColor: HeroSurface,
  },
  heroPhoto: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  /**
   * Sits between the photo and the copy. Same box as `heroPhoto`, so it washes
   * the crop rather than the asset — a gradient sized to the image would move
   * independently of the text once `cover` started cropping.
   */
  heroScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  heroArt: {
    position: 'absolute',
    right: -16,
    bottom: -12,
    opacity: 0.85,
  },
  /**
   * ⚠ `heroCenter` until the photograph changed.
   *
   *   Centred copy over the old illustration was fine — it was pale across its
   *   whole width. The picture that replaced it keeps its left 45% empty and
   *   puts two people in the right, so centred text crossed the subject and
   *   needed a wash over the part of the image worth looking at. Against the
   *   left edge it sits in the band the photograph leaves for it.
   */
  /** `contentWrap`'s shape, inside a box that stays full-bleed. */
  heroInner: {
    width: '100%',
    maxWidth: PageMeasure,
    alignSelf: 'center',
    paddingHorizontal: Spacing.four,
  },
  heroCopy: {
    alignItems: 'flex-start',
    justifyContent: 'center',
    // Halved from Spacing.six (64) — the cards carry the height now.
    paddingVertical: Spacing.four,
    width: '100%',
  },
  heroCards: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.three - 4,
    width: '100%',
    /*
      ⚠ 620 while this held two cards; 340 now it holds one.

        `heroCard` is `flex: 1`, so a single child fills whatever this allows —
        leaving 620 would have stretched one small search box and a button
        across the full width of the hero. 340 is roughly what each card
        occupied when there were two, so the remaining one keeps its proportions
        instead of inheriting the pair's.
    */
    maxWidth: 340,
    // Cards are the last thing in the hero — the container's padding closes it.
    marginTop: Spacing.four,
  },
  heroCardsStacked: {
    flexDirection: 'column',
  },
  /** Casts the shadow. Deliberately no `overflow` — that would crop it. */
  heroCard: {
    flex: 1,
    borderRadius: Radius.xl,
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    ...Platform.select({ android: { elevation: 6 }, default: {} }),
  },
  /**
   * The blur host. `overflow: hidden` is what clips the blur to the rounded
   * corners — without it BlurView paints a square behind the radius.
   */
  heroCardBlur: {
    borderRadius: Radius.xl,
    overflow: 'hidden',
  },
  /** Tint, hairline highlight and padding sit inside the blur, not on it. */
  heroCardInner: {
    gap: Spacing.two + 2,
    padding: 20,
    borderRadius: Radius.xl,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderColor: 'rgba(255,255,255,0.7)',
  },
  heroCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two - 2,
  },
  heroCardTitle: {
    ...Typography.cardTitle,
  },
  heroEyebrow: {
    ...Typography.caption,
    ...font(600),
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: Spacing.two - 2,
    textAlign: 'left',
  },
  /**
   * #0F172A across the copy column: a median 16.7:1 over the washed photo and
   * 15.2:1 over the bare one, with 0% of either under 4.5:1 at every width
   * measured. The weight is `Typography.heroTitle` (800) — at 48px that is what
   * makes it read as a headline over a photograph rather than as large text on
   * it. The accent word is the exception; see the render.
   */
  heroHeadline: {
    ...Typography.heroTitle,
    letterSpacing: -1,
    lineHeight: undefined,
  },
  heroHeadlineLeft: {
    textAlign: 'left',
    maxWidth: 720,
  },
  heroSubtitle: {
    ...Typography.body,
    lineHeight: 23,
    marginTop: Spacing.three,
    /*
      ⚠ 460, down from 560, and it is a contrast number as much as a measure.

        This is the longest line in the hero and the lightest colour in it. On a
        phone it is the only element that reaches the far edge of the frame, so
        it alone decided how heavy the wash had to be. Holding it to 460 let the
        wash drop from 0.94–0.70 to 0.93–0.55 — the difference between a
        photograph you can see and a ghost behind the text.
    */
    maxWidth: Hero.subtitleMaxWidth,
  },
  heroSubtitleLeft: {
    textAlign: 'left',
  },

  /**
   * Extra breathing room above the standard 48px section gap. The hero ends in
   * two frosted cards, so at 48 the quote read as a third card in that cluster
   * rather than the start of the page proper.
   */
  /**
   * The band's own spacing, rather than a margin on the component.
   *
   * Everything in this column sets its gaps from here, so a section that
   * carried its own would be the one nobody could line up with the rest.
   */
  appDownload: {
    marginTop: Spacing.five,
  },
  quote: {
    marginTop: Spacing.five,
    marginBottom: SectionGap,
  },
  quoteStrapline: {
    alignItems: 'center',
    gap: Spacing.one,
    marginTop: Spacing.four,
    paddingHorizontal: Spacing.three,
  },
  straplineTitle: {
    ...Typography.sectionHeading,
    textAlign: 'center',
    color: GlassSection.title,
  },
  /**
   * Measured against the real Plus Jakarta Sans metrics, not eyeballed.
   *
   * - `maxWidth` was 420 while the sentence renders at 443px in Medium, so it
   *   wrapped and stranded "time." alone on line two. 480 clears it with slack
   *   and still lands at 62 characters — inside the 45–75 comfortable range.
   * - `lineHeight` was 19, tighter than the 20 that `Typography.meta` already
   *   sets and only 1.36× the font size. 21 is 1.5×, which is where body copy
   *   stops feeling cramped when it does wrap on narrower viewports.
   * - Weight 500 rather than 400: this sits on the tinted canvas rather than a
   *   white card, where Regular goes slightly thin.
   */
  straplineBody: {
    ...Typography.meta,
    ...font(500),
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: 480,
  },

  // Category grid
  /** No fill: the cards carry themselves on the cyan canvas now. */
  gridPanel: {
    marginBottom: SectionGap,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    /* Same constant the column width is derived from — see `GRID_GAP`. */
    gap: GRID_GAP,
  },

  // Tracking
  trackSection: {
    marginBottom: Spacing.five,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    height: 48,
    paddingHorizontal: Spacing.three - 2,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  /**
   * The pill around it draws the only border. On web the input would otherwise
   * paint its own 1px frame plus the browser's focus ring inside that pill.
   */
  /**
   * Focus cue, deliberately quiet: the border tints without thickening, so the
   * pill doesn't gain a heavy blue outline or shift the layout by a pixel.
   */
  searchBarFocused: {
    borderColor: 'rgba(0,119,182,0.45)',
  },
  searchInput: {
    flex: 1,
    ...Typography.body,
    borderWidth: 0,
    /*
      `outlineWidth: 0` rather than `outlineStyle: 'none'` — RN 0.86 types the
      latter as solid | dotted | dashed only. Both suppress the browser ring on
      web; this one is a no-op on native rather than a type error.
    */
    outlineWidth: 0,
  },
  /** Blur host — clipped to the radius; the fill and border sit inside it. */
  cardBlur: {
    /*
     * `flex: 1` here meant flexBasis 0, which tells the layout "ignore my
     * content when measuring". The card's own height then stopped contributing
     * to the tile, leaving the height to come from somewhere other than the
     * text inside it. `flexBasis: 'auto'` keeps the stretch-to-tallest-sibling
     * behaviour while letting the content set the natural height.
     */
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    borderRadius: Radius.xl,
    overflow: 'hidden',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: Spacing.half + 1,
  },
  statusBadgeText: {
    fontSize: FontSize.micro,
    ...font(700),
  },
  cardMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  routePill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.one + 2,
    paddingHorizontal: Spacing.three - 4,
    paddingVertical: Spacing.one + 1,
    borderRadius: Radius.pill,
  },
  routePillText: {
    fontSize: FontSize.caption,
    ...font(600),
  },
  /** 6px track — `1.5` in the reference. */
  track: {
    height: 6,
    borderRadius: Radius.pill,
    overflow: 'visible',
  },
  trackFill: {
    height: 6,
    borderRadius: Radius.pill,
    // Glow at the leading edge rather than a separate dot.
    shadowOpacity: 0.5,
    shadowRadius: 4,
    shadowOffset: { width: 2, height: 0 },
    ...Platform.select({ android: { elevation: 2 }, default: {} }),
  },
  glassSection: {
    borderRadius: Radius.xl + 4,
    padding: Spacing.three,
    marginBottom: SectionGap,
  },
  emptyCard: {
    gap: Spacing.three,
  },
  /** Keeps the CTA from stretching the full card width on wide viewports. */
  emptyCta: {
    alignSelf: 'center',
    minWidth: 220,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.four,
    marginBottom: Spacing.three - 2,
  },
  listTitle: {
    ...Typography.sectionTitle,
  },
  clearLink: {
    ...Typography.caption,
    ...font(700),
  },
  parcelGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three - 4,
    /*
     * Yoga defaults `alignContent` to flex-start; CSS defaults it to stretch,
     * and react-native-web doesn't override that. So on web a wrapping row
     * stretches its lines to fill any spare height in the container — which is
     * how a single card ended up as a tall grey slab. Pinning it to flex-start
     * makes web match native.
     */
    alignContent: 'flex-start',
    // `alignItems` stays at its default of stretch, so two cards sharing a row
    // still match heights. It's the *line* that must not stretch, not the items.
  },
  gridItem: {
    /*
     * These are ROW measurements: `flexBasis` sizes along the main axis, so on
     * a row it means "47% wide". The grid used to flip to `flexDirection:
     * 'column'` on a narrow screen, at which point the very same 47% started
     * meaning 47% *tall* — and `flexGrow: 1` stretched it from there. That is
     * the grey slab: a card given nearly half the list's height regardless of
     * what was written inside it.
     *
     * The grid now stays a wrapping row at every width. `minWidth` already
     * forces one card per line once the viewport is too narrow for two, so the
     * column variant bought nothing and cost this.
     */
    flexGrow: 1,
    flexBasis: '47%',
    minWidth: 150,
    maxWidth: '100%',
  },
  cardPressed: {
    opacity: 0.75,
  },
  /** Amber ring + glow so a waiting parcel is visible at a glance. */
  cardPending: {
    borderWidth: 1,
    ...Platform.select({
      ios: {
        shadowOpacity: 0.4,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 6 },
      default: {},
    }),
  },

  // Compact tracking card
  card: {
    // Same reason as `cardBlur` — grow to fill a stretched tile, but measure
    // from content rather than from zero.
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    backgroundColor: GlassSection.cardFill,
    borderWidth: 1,
    borderColor: GlassSection.cardBorder,
    borderRadius: Radius.xl,
    gap: Spacing.two - 2,
    padding: Spacing.three - 4,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.one + 2,
  },
  cardTitle: {
    flex: 1,
    ...Typography.cardTitle,
  },
  trackingId: {
    ...Typography.caption,
  },
  compactPill: {
    marginTop: Spacing.half,
  },
  progressBlock: {
    gap: Spacing.one + 2,
    marginTop: Spacing.half,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  statusText: {
    flex: 1,
    ...Typography.label,
    ...font(700),
  },
  stepText: {
    ...Typography.caption,
    ...font(600),
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginTop: Spacing.half,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.one + 2,
  },
  footerMeta: {
    flex: 1,
    ...Typography.caption,
  },
  footerFee: {
    ...Typography.badge,
    ...font(700),
  },
});
