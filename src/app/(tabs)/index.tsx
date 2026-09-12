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
import { serviceArtwork } from '@/constants/service-artwork';
import { servicePrefillParams } from '@/constants/services';
import { HERO_BACKGROUND } from '@/constants/hero-background';
import {
  FontSize,
  HeroSurface,
  Radius,
  Spacing,
  PageCanvas,
  Typography,
  font,
  heroTitleSize,
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
 * Cyan glass section shared by How Package Relay Works and My Sent Packages.
 *
 * `action` is #005FC5 rather than the specified #007FFF: measured on this
 * gradient that blue reads 2.93:1, well under AA, where #005FC5 clears it at
 * 4.66:1 and still scans as the same primary blue.
 */
const GlassSection = {
  /**
   * The panel no longer paints its own gradient — the page is already cyan, and
   * a second fill drew a visible seam across the section boundary.
   */
  gradientFrom: 'transparent',
  gradientTo: 'transparent',
  /** Deep navy for headings: 10.37:1 on the canvas, 11.08:1 on the frosted cards. */
  title: '#0B3C5D',
  action: '#005FC5',
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
  trackActive: '#2563EB',
} as const;

/** py-12 — the vertical rhythm between major sections. */
const SectionGap = 48;

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
          <View style={[styles.hero, !HERO_BACKGROUND && styles.heroFallbackSurface]}>
            {HERO_BACKGROUND ? (
              /*
                No overlay, no scrim, no text shadow: the illustration is light
                enough to carry the navy type on its own. `cover` / `center`
                crops rather than squashing. See the note on `heroHeadline`.
              */
              <Image
                source={HERO_BACKGROUND}
                style={styles.heroPhoto}
                contentFit="cover"
                contentPosition="center"
                accessibilityIgnoresInvertColors
              />
            ) : (
              // No photo supplied yet — see HERO_BACKGROUND.
              <View style={styles.heroArt} pointerEvents="none">
                <RiderIllustration width={heroArtSize} height={heroArtSize * 0.9} />
              </View>
            )}

            <View style={styles.heroCenter}>
              <Text style={[styles.heroEyebrow, { color: theme.textSecondary }]}>
                Welcome to Package Relay
              </Text>
              <Text
                style={[
                  styles.heroHeadline,
                  styles.heroHeadlineCentered,
                  { color: theme.text, fontSize: headlineSize },
                ]}>
                Delivering with{'\n'}
                {/*
                  #0077B6 measures 4.39:1 median over this illustration — 97% of
                  the area is under AA. theme.primaryPressed (#005E92) takes it
                  to 6.28:1 if you'd rather not lose the accent.
                */}
                <Text style={{ color: theme.primary }}>Excellence</Text>
              </Text>

              <Text
                style={[
                  styles.heroSubtitle,
                  styles.heroSubtitleCentered,
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

                `heroCards` is centred by `heroCenter` and its max width drops
                from 620 to 340 — see the style. The card itself is `flex: 1`,
                so without that it would have stretched to fill the pair's
                width.
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
            <View style={styles.quote}>
              <QuickQuote onBook={(params) => router.navigate({ pathname: '/book', params })} />

              <View style={styles.quoteStrapline}>
                <Text style={styles.straplineTitle}>We Deliver Packages Within City</Text>
                <Text style={[styles.straplineBody, { color: theme.textSecondary }]}>
                  Send envelopes, documents and packages across town in no time.
                </Text>
              </View>
            </View>

            {/* ---------- Service categories ---------- */}
            {/* Grey-blue panel: gives the tinted cards something to lift off. */}
            <View style={styles.gridPanel}>
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
              style={styles.glassSection}>
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
              #{booking.trackingId}
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
  contentWrap: {
    width: '100%',
    maxWidth: 1280,
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
    paddingHorizontal: Spacing.four,
    // Halved from Spacing.five (32) to keep the banner compact.
    paddingVertical: Spacing.four,
    borderRadius: 24,
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
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
  heroArt: {
    position: 'absolute',
    right: -16,
    bottom: -12,
    opacity: 0.85,
  },
  heroCenter: {
    alignItems: 'center',
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
    textAlign: 'center',
  },
  /**
   * Measured against the illustration across the text block: #0F172A sits at a
   * median 16.1:1 and only 2.7% of the area falls under 4.5:1, so it needs no
   * scrim. The accent word is the exception — see the render.
   */
  heroHeadline: {
    ...Typography.heroTitle,
    letterSpacing: -1,
    lineHeight: undefined,
  },
  heroHeadlineCentered: {
    textAlign: 'center',
    maxWidth: 720,
  },
  heroSubtitle: {
    ...Typography.body,
    lineHeight: 23,
    marginTop: Spacing.three,
    maxWidth: 560,
  },
  heroSubtitleCentered: {
    textAlign: 'center',
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
    ...Typography.cardTitle,
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
