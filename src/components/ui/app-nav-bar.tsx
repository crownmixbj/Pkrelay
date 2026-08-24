import { usePathname, useRouter } from 'expo-router';
import {
  House,
  Archive,
  BellRing,
  BookOpen,
  ChartColumn,
  ChevronDown,
  ClipboardCheck,
  Clock,
  Info,
  LayoutDashboard,
  LifeBuoy,
  Map,
  MapPinned,
  Menu,
  PackagePlus,
  FileWarning,
  Radar,
  Scale,
  UsersRound,
  ShieldCheck,
  Truck,
  LogOut,
  Smartphone,
  UserRound,
  Wallet,
  X,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HUB_SECTION_LABELS } from '@/constants/hubs';
import { FontSize, Elevation, Radius, Spacing, Typography, font } from '@/constants/theme';
import { AppStoreModal, detectStorePlatform, openStore } from '@/components/ui/app-store-modal';
import { useTheme } from '@/hooks/use-theme';
import { showDialog } from '@/components/ui/dialog';
import { showToast } from '@/components/ui/toast';
import { SettingsMenu } from '@/components/ui/settings-menu';
import { useSession } from '@/store/session';
import { useExperience } from '@/hooks/use-experience';
import { routeAllowed } from '@/lib/experience';

/** Deep navy for nav links at rest — 11.2:1 on the white capsule. */
const NavLinkColor = '#0B3C5D';

/**
 * Up to two letters for the avatar. A signed-in person seeing their own
 * initials is the clearest possible signal that the session is real — a generic
 * silhouette looks identical whether you're signed in or not.
 */
function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Layout tiers, measured rather than guessed.
 *
 * Rendering the type in Plus Jakarta Sans and adding up the capsule gives a
 * minimum width for each arrangement:
 *
 *   labelled links   997px   LOCI + seven words + role pill + avatar + menu
 *   icon-only links  671px   the same links as 34px circles
 *   drawer only      335px   logo and actions; the hamburger carries the links
 *
 * Measured against the *widest* role variant — "My Parcels" is 21px longer than
 * "My Jobs", so sizing to the driver label would overflow for senders.
 *
 * These move whenever a link is added. Adding "My Jobs" pushed the labelled row
 * from 877px to 997px, which silently invalidated the previous 900 breakpoint
 * and would have put the avatar back on the capsule's rounded edge between 900
 * and 997. Re-measure after any change to `NAV_LINKS`.
 *
 * The Hubs caret is the most recent change: a 15px chevron plus its padding and
 * the row gap costs 19px, which against the recorded 997px left only 4px of
 * slack under the old 1020 threshold. Both labelled tiers moved up 20px to put
 * the headroom back — 4px is not a margin, it is a rounding error waiting to
 * push the avatar onto the capsule's edge again.
 *
 * The caret is rendered only in the labelled tier, so the icon-only thresholds
 * are untouched.
 */
const LABEL_BREAKPOINT = 1040;
const ICON_LINK_BREAKPOINT = 690;

/**
 * The admin entry adds an eighth link, and "Applications" is a long word.
 *
 * Measured: seven labelled links need 997px, eight need 1119px — so an admin on
 * a 1024px laptop would overflow against the shared 1020 breakpoint. Rather
 * than push every user to icons early, the thresholds move only for the people
 * who actually have the extra link.
 */
const ADMIN_LABEL_BREAKPOINT = 1160;
const ADMIN_ICON_LINK_BREAKPOINT = 730;
/** Below this the capsule tightens its padding to survive a 320px phone. */
const TIGHT_BREAKPOINT = 400;

/**
 * `/corporate` and `/driver` exist and are routable but aren't nav links —
 * `/driver` is reached via the profile icon and from the Drivers screens.
 */
type NavHref =
  | '/'
  | '/about'
  | '/available-packages'
  | '/book'
  | '/driver'
  | '/driver-guidelines'
  | '/driver-signup'
  | '/driver-updates'
  | '/driver-wallet'
  | '/legal'
  | '/locations'
  | '/my-packages'
  | '/support'
  | '/tracking'
  | '/admin'
  | '/admin-logs'
  | '/admin-ops'
  | '/admin-users';

/** Home matches exactly; the rest match their prefix. */
function matchesHref(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/' || pathname === '/index';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Whether a link should read as current.
 *
 * A grouped link owns several routes: "Jobs & Drivers" must stay underlined on
 * the portal, the updates page and the guidelines, not only on the one page its
 * label happens to point at. Without `also`, four of the five destinations
 * behind that dropdown would leave the nav showing nothing as selected.
 */
function isActive(pathname: string, link: Pick<NavLink, 'href' | 'also'>): boolean {
  if (matchesHref(pathname, link.href)) return true;
  return (link.also ?? []).some((href) => matchesHref(pathname, href));
}

/**
 * A child of a nav link.
 *
 * Two shapes, because the two dropdowns differ in kind. Hubs is one screen with
 * three views, so its children carry a `section` query parameter. Jobs &
 * Drivers groups four genuinely separate screens, so its children carry an
 * `href`. Forcing either into the other's shape would mean a fake route or a
 * screen doing four unrelated jobs.
 */
type NavChild = {
  key: string;
  label: string;
  /*
    No `description`.

    Every child used to carry one and the submenu rendered it under the label.
    Removed rather than left unrendered: a field that is still populated but no
    longer shown is an invitation to put it back, and the eleven strings it held
    were the least useful text in the app — "Browse open deliveries by route"
    under a link named Schedule My Journey.

    The *parent* keeps its description, which the drawer still renders under
    each group heading. That one earns its place: "Find work, apply to drive,
    track your application" is the only thing telling you what four unrelated
    screens have in common.
  */
  icon: (color: string, size: number) => React.ReactNode;
  href: NavHref;
  /**
   * Opens a specific view of `href`, as `?section=`.
   *
   * A plain string rather than a union of every screen's sections: the value is
   * a query parameter, and each screen already validates it with its own
   * `parse…Section` that falls back safely. Enumerating them here would mean
   * this file had to know about every screen's internals.
   */
  section?: string;
};

type NavLink = {
  key: string;
  label: string;
  href: NavHref;
  icon: (color: string, size: number) => React.ReactNode;
  description: string;
  children?: NavChild[];
  /**
   * Extra path prefixes this link owns, for the active state only.
   *
   * Deliberately looser than `NavHref`: `/parcel` is a dynamic route
   * (`/parcel/[id]`) that nothing navigates to by that bare path, so it is not
   * a valid push target — but a parcel detail page still belongs to Shipments
   * and should keep it underlined.
   */
  also?: string[];
};

/**
 * Labels follow the landing-page naming; each maps onto a screen that actually
 * exists rather than a dead link.
 */
const NAV_LINKS: NavLink[] = [
  {
    key: 'home',
    label: 'Home',
    href: '/',
    icon: (color, size) => <House color={color} size={size} />,
    description: 'Track parcels and browse services',
  },
  {
    /*
      "Drivers" and "Find Jobs" used to be two top-level entries that led to
      halves of the same job: one to apply, one to work. Someone mid-application
      had no reason to know which of the two held their status, and an approved
      driver had to remember that their accepted deliveries lived under a third
      label entirely. One entry, four destinations.
    */
    key: 'jobs-drivers',
    label: 'Driver',
    /*
      The parent now goes to the application screen, not the job board.

      It used to point at `/available-packages` on the reasoning that browsing
      open work is what people arrive wanting. That stopped being true when
      Setup Trip moved inside the Driver Dashboard: the board is now a driver's
      working tool rather than a shop window, and the one page that is useful to
      somebody who is *not* yet a driver is the one that explains how to become
      one.
    */
    href: '/driver-updates',
    icon: (color, size) => <Truck color={color} size={size} />,
    description: 'Apply to drive, track your application, and manage your work',
    also: ['/driver', '/driver-signup', '/driver-updates', '/driver-guidelines', '/driver-wallet'],
    /*
      ⚠ Four entries, and two deliberate omissions.

        Setup Trip (`/available-packages`) and Assigned Trip (`/driver`) used to
        sit here and no longer do. Both are things a driver does *while
        working*, and neither means anything to the signed-out visitor this menu
        is mostly shown to — a public navigation bar advertising a job board you
        cannot use is a menu that mostly leads to refusals.

        Neither is orphaned. The Driver Dashboard carries both, it is the second
        entry below, and the native tab bar still has them. `verify-navigation`
        asserts every route keeps a way in, which is the check that would have
        caught this had I got it wrong.

      The order is the driver's own arc: apply, work, get paid, look things up.
    */
    children: [
      {
        key: 'updates',
        label: 'Be a Driver / Update',
        href: '/driver-updates',
        icon: (color, size) => <BellRing color={color} size={size} />,
      },
      {
        key: 'dashboard',
        label: 'Driver Dashboard',
        href: '/driver',
        icon: (color, size) => <LayoutDashboard color={color} size={size} />,
      },
      {
        key: 'wallet',
        label: 'Driver Wallet / Payouts',
        href: '/driver-wallet',
        icon: (color, size) => <Wallet color={color} size={size} />,
      },
      {
        key: 'guidelines',
        label: 'Driver Guidelines & FAQs',
        href: '/driver-guidelines',
        icon: (color, size) => <BookOpen color={color} size={size} />,
      },
    ],
  },
  {
    /*
      Everything sender-side, the way Jobs & Drivers holds everything
      driver-side.

      "My Parcels" was a separate top-level entry until this grouped it. Keeping
      both would have put /my-packages in the nav twice — once on its own and
      once as two of the four children here — which is the duplication the
      driver merge already removed.
    */
    key: 'shipments',
    label: 'Shipments',
    // Sending is what people arrive wanting, and it is the only one of the four
    // that is worth anything before you have posted a parcel.
    href: '/book',
    icon: (color, size) => <PackagePlus color={color} size={size} />,
    description: 'Send a parcel, track it, and see what you have sent',
    // `/parcel` covers the detail screen at `/parcel/[id]`.
    also: ['/my-packages', '/tracking', '/parcel'],
    children: [
      {
        key: 'new',
        label: 'New Shipment',
        href: '/book',
        icon: (color, size) => <PackagePlus color={color} size={size} />,
      },
      {
        key: 'active',
        label: 'Active / In-Transit Parcels',
        href: '/my-packages',
        section: 'active',
        icon: (color, size) => <Truck color={color} size={size} />,
      },
      {
        key: 'history',
        label: 'Shipment History / Archives',
        href: '/my-packages',
        section: 'history',
        icon: (color, size) => <Archive color={color} size={size} />,
      },
      {
        key: 'tracking',
        label: 'Tracking / Proof of Delivery',
        href: '/tracking',
        icon: (color, size) => <Radar color={color} size={size} />,
      },
    ],
  },
  {
    key: 'locations',
    label: 'Hubs',
    href: '/locations',
    icon: (color, size) => <MapPinned color={color} size={size} />,
    description: 'Drop-off and collection points',
    children: [
      {
        key: 'locations',
        label: HUB_SECTION_LABELS.locations,
        href: '/locations',
        section: 'locations',
        icon: (color, size) => <MapPinned color={color} size={size} />,
      },
      {
        key: 'map',
        label: HUB_SECTION_LABELS.map,
        href: '/locations',
        section: 'map',
        icon: (color, size) => <Map color={color} size={size} />,
      },
      {
        key: 'hours',
        label: HUB_SECTION_LABELS.hours,
        href: '/locations',
        section: 'hours',
        icon: (color, size) => <Clock color={color} size={size} />,
      },
    ],
  },
  {
    /*
      Filtered out for everyone but admins. Hiding it is a courtesy, not the
      control — every screen behind it refuses non-admins, and the RLS policies
      and `security definer` functions in `07_admin.sql` refuse the data.

      This was a single "Applications" entry pointing at the review queue. That
      queue is now one of five, so it moved inside rather than sitting in the
      nav twice.
    */
    key: 'admin',
    label: 'Admin',
    href: '/admin',
    icon: (color, size) => <ShieldCheck color={color} size={size} />,
    description: 'Run the platform',
    also: ['/admin-users', '/admin-ops', '/admin-logs'],
    children: [
      {
        key: 'overview',
        label: 'Dashboard Overview',
        href: '/admin',
        section: 'overview',
        icon: (color, size) => <ChartColumn color={color} size={size} />,
      },
      {
        key: 'review',
        label: 'Driver & App Review',
        href: '/admin',
        section: 'review',
        icon: (color, size) => <ClipboardCheck color={color} size={size} />,
      },
      {
        key: 'users',
        label: 'User & Role Mgmt.',
        href: '/admin-users',
        icon: (color, size) => <UsersRound color={color} size={size} />,
      },
      {
        key: 'ops',
        label: 'Hubs & Operations',
        href: '/admin-ops',
        icon: (color, size) => <MapPinned color={color} size={size} />,
      },
      {
        key: 'logs',
        label: 'System Logs & Errors',
        href: '/admin-logs',
        icon: (color, size) => <FileWarning color={color} size={size} />,
      },
    ],
  },
  {
    key: 'about',
    label: 'About Us',
    href: '/about',
    icon: (color, size) => <Info color={color} size={size} />,
    description: 'Our mission, support, and the legal bits',
    also: ['/support', '/legal'],
    children: [
      {
        key: 'about',
        label: 'About LOCI',
        href: '/about',
        icon: (color, size) => <Info color={color} size={size} />,
      },
      {
        key: 'support',
        label: 'Support / Contact Us',
        href: '/support',
        icon: (color, size) => <LifeBuoy color={color} size={size} />,
      },
      {
        key: 'legal',
        label: 'Terms of Service & Privacy Policy',
        href: '/legal',
        icon: (color, size) => <Scale color={color} size={size} />,
      },
    ],
  },
];

export function AppNavBar() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [storeModalOpen, setStoreModalOpen] = useState(false);
  /** Key of the link whose submenu is showing, or null. Only ever one at a time. */
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { user, isAuthenticated, isAdmin, signOut } = useSession();
  const experience = useExperience();
  // Labels need room; below that the links drop to icons, and below *that* they
  // leave the capsule entirely — the drawer already lists every one of them, so
  // nothing becomes unreachable.
  /**
   * The links this interface has, with their children filtered the same way.
   *
   * Both the nav and the route guard read `routeAllowed`, so a link can never
   * offer a destination the guard would immediately bounce someone off — the
   * two would otherwise drift, and the symptom is a menu item that flashes a
   * screen and returns.
   *
   * A group whose children are all filtered out is dropped entirely rather than
   * left as a heading that opens an empty menu.
   */
  const navLinks = useMemo(() => {
    if (!experience) return [];

    return NAV_LINKS.filter((link) => link.key !== 'admin' || isAdmin)
      .map((link) => ({
        ...link,
        children: link.children?.filter((child) => routeAllowed(child.href, experience)),
      }))
      .filter((link) => {
        if (link.children) return link.children.length > 0;
        return routeAllowed(link.href, experience);
      });
  }, [experience, isAdmin]);

  /*
   * A submenu left open across a navigation would hang over the new page with
   * no obvious way to dismiss it — `router.push` does not unmount the nav bar.
   */
  useEffect(() => setOpenSubmenu(null), [pathname]);

  const showLabels = width >= (isAdmin ? ADMIN_LABEL_BREAKPOINT : LABEL_BREAKPOINT);
  const showInlineLinks = width >= (isAdmin ? ADMIN_ICON_LINK_BREAKPOINT : ICON_LINK_BREAKPOINT);
  const tight = width < TIGHT_BREAKPOINT;

  /**
   * On a phone we already know the store, so skip the picker. Desktop web
   * can't be detected reliably, so ask.
   */
  const handleGetApp = () => {
    setMenuOpen(false);
    const detected = detectStorePlatform();
    if (detected) {
      openStore(detected);
      return;
    }
    setStoreModalOpen(true);
  };

  /**
   * Now that the header renders on the auth screens too, "go to sign in" has to
   * cope with already being there — otherwise tapping the avatar on /sign-in
   * pushes a second copy onto the stack and the back gesture walks through
   * duplicates.
   */
  const goToSignIn = () => {
    if (pathname === '/sign-in') return;
    router.push('/sign-in');
  };

  /** Auth lives outside the tab group, so it closes the drawer on the way. */
  const openAuth = () => {
    setMenuOpen(false);
    goToSignIn();
  };

  /**
   * Signing out is worth confirming: it clears the driver registration and
   * drops back to Sender, so an accidental tap costs more than a re-login.
   */
  const handleSignOut = () => {
    setMenuOpen(false);
    showDialog(
      'Sign out of LOCI?',
      `You are signed in as ${user?.email ?? user?.name ?? 'this account'}. You'll need your password to sign back in.`,
      [
        { text: 'Stay signed in', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            void signOut();
            showToast('Signed out', { message: 'You can browse LOCI without an account.' });
            router.replace('/');
          },
        },
      ],
    );
  };

  /**
   * Tapping the avatar. Names the account first — on a shared device, "which
   * account am I in?" is the question people actually have — then offers the
   * two things they came for.
   */
  /*
   * The avatar opens the same sheet as the gear.
   *
   * It used to raise its own dialog offering "My Jobs" and "Sign out" — which
   * is now three quarters of the settings sheet, and a second copy that would
   * drift. Two entry points to one panel is fine; two panels claiming to be the
   * account is not.
   */
  const openAccountMenu = () => setSettingsOpen(true);

  const go = (href: NavHref) => {
    setMenuOpen(false);
    router.push(href);
  };

  /**
   * A submenu entry. Either a route of its own, or a section of one.
   *
   * The `?section=` form matters for Hubs: pushing `/locations` while already on
   * `/locations` is a no-op, so without the parameter the submenu would appear
   * dead to anyone already on that screen.
   */
  const goToChild = (child: NavChild) => {
    setMenuOpen(false);
    setOpenSubmenu(null);
    router.push((child.section ? `${child.href}?section=${child.section}` : child.href) as NavHref);
  };

  return (
    <>
      <View
        style={[
          styles.wrapper,
          tight && styles.wrapperTight,
          { paddingTop: insets.top + Spacing.two + 4 },
        ]}>
        <View
          style={[
            styles.capsule,
            tight && styles.capsuleTight,
            {
              backgroundColor: theme.navBackground,
              borderColor: theme.navBorder,
              shadowColor: theme.shadow,
            },
            Elevation.raised,
          ]}>
          {/* Logo */}
          <Pressable
            onPress={() => router.push('/')}
            accessibilityRole="button"
            accessibilityLabel="LOCI, go to home"
            style={({ pressed }) => [styles.logo, pressed && styles.pressed]}>
            <Text style={[styles.logoText, { color: theme.primary }]}>LOCI</Text>
          </Pressable>

          {/*
            Dropped entirely on a phone. Six 34px circles plus the logo and the
            actions need 617px; forcing them into 360px is what shoved the
            avatar and hamburger off the end of the capsule.
          */}
          <View
            style={[
              styles.links,
              !showLabels && styles.linksCompact,
              !showInlineLinks && styles.linksHidden,
            ]}>
            {showInlineLinks &&
              navLinks.map((link, index) => (
                <NavLinkItem
                  key={link.key}
                  link={link}
                  active={isActive(pathname, link)}
                  showLabels={showLabels}
                  // The rightmost link's menu opens leftwards; see `alignEnd`.
                  alignEnd={index >= navLinks.length - 2}
                  submenuOpen={openSubmenu === link.key}
                  onSubmenuChange={(open) => setOpenSubmenu(open ? link.key : null)}
                  onPress={() => go(link.href)}
                  onSelectChild={goToChild}
                />
              ))}
          </View>

          <View style={[styles.actions, tight && styles.actionsTight]}>
            {/*
              Settings.

              The Sender/Driver segmented control used to live here. It moved
              into this sheet: switching interface belongs to the account rather
              than to the page, and two controls doing the same thing is how
              they end up disagreeing.
            */}
            {/*
              ⚠ The settings gear was here, and is gone.

                It opened the account sheet. So does the avatar below, when
                signed in — and when signed out the avatar goes straight to
                sign-in, which is the only thing that sheet offers a stranger.
                Two controls onto one destination, sitting side by side, is a
                choice the reader has to make for no benefit.

                A previous pass hid it on the profile screen only, on the
                reasoning that removing it globally would strip role switching
                and sign out from everywhere else. That was wrong: the avatar
                already reaches both, so nothing was ever behind the gear alone.
            */}
            {/*
              The account control. It used to push /sign-in unconditionally,
              which meant a signed-in person tapping their own avatar was handed
              a login form — and left the only way out of the app buried in the
              drawer. Now it shows who you are and offers the way out.
            */}
            <Pressable
              onPress={isAuthenticated ? openAccountMenu : goToSignIn}
              accessibilityRole="button"
              accessibilityLabel={
                isAuthenticated
                  ? `Account: ${user?.email ?? user?.name}. Open account options`
                  : 'Sign in or create an account'
              }
              hitSlop={6}
              style={({ pressed }) => [
                styles.iconCircle,
                {
                  backgroundColor: isAuthenticated ? theme.primary : theme.surfaceMuted,
                },
                pressed && styles.pressed,
              ]}>
              {isAuthenticated ? (
                <Text style={[styles.avatarInitials, { color: theme.primaryText }]}>
                  {initials(user?.name)}
                </Text>
              ) : (
                <UserRound color={theme.text} size={16} />
              )}
            </Pressable>

            <Pressable
              onPress={() => setMenuOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Open menu"
              hitSlop={8}
              style={({ pressed }) => [styles.actionIcon, pressed && styles.pressed]}>
              <Menu color={theme.text} size={20} />
            </Pressable>
          </View>
        </View>
      </View>

      <SideMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onNavigate={go}
        onNavigateChild={goToChild}
        onGetApp={handleGetApp}
        onAuth={openAuth}
        onSignOut={handleSignOut}
        user={user}
        isAuthenticated={isAuthenticated}
        links={navLinks}
      />

      <SettingsMenu open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <AppStoreModal
        visible={storeModalOpen}
        onClose={() => setStoreModalOpen(false)}
        detected={detectStorePlatform()}
      />
    </>
  );
}

/**
 * One entry in the capsule: a link, or a menu that holds several.
 *
 * A parent **only opens its menu** — it does not navigate. It used to do both,
 * pointing at its own `href`, and every one of those four hrefs was the same
 * destination as the entry's *first child*: Jobs & Drivers → Schedule My Journey,
 * Shipments → New Shipment, Hubs → Drop-off / Pickup Locations, About Us →
 * About LOCI. So clicking a heading looked exactly like the app choosing item
 * one for you, which is what it was doing.
 *
 * That also collapses the caret into the label. Two controls made sense while
 * the heading led somewhere of its own; now it is one thing — a disclosure —
 * and splitting it would leave a second tab stop that does the same job.
 *
 * The menu is deliberately not hover-only. Hover does not exist on a phone, and
 * a menu that only opens on hover is unreachable by touch, keyboard or screen
 * reader — so hover is a web accelerator and the press is the real control.
 */
function NavLinkItem({
  link,
  active,
  showLabels,
  submenuOpen,
  onSubmenuChange,
  onPress,
  onSelectChild,
  alignEnd,
}: {
  link: NavLink;
  active: boolean;
  showLabels: boolean;
  /**
   * Opens the menu leftwards from the link's right edge.
   *
   * A 296px panel hanging right from one of the last links runs past the
   * capsule and off the viewport — there is only the role pill, the avatar and
   * the hamburger to its right. Anchoring the far end instead keeps it on
   * screen without needing to measure the viewport.
   */
  alignEnd: boolean;
  submenuOpen: boolean;
  onSubmenuChange: (open: boolean) => void;
  onPress: () => void;
  onSelectChild: (child: NavChild) => void;
}) {
  const theme = useTheme();

  /*
   * Closing on hover-out is delayed. The submenu sits a few pixels below the
   * link, and the pointer crosses that gap on the way down — closing instantly
   * means the menu vanishes underneath the cursor before it can be clicked.
   */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  useEffect(() => cancelClose, []);

  const hoverOpen = () => {
    if (Platform.OS !== 'web' || !link.children) return;
    cancelClose();
    onSubmenuChange(true);
  };

  const hoverClose = () => {
    if (Platform.OS !== 'web' || !link.children) return;
    cancelClose();
    closeTimer.current = setTimeout(() => onSubmenuChange(false), 220);
  };

  // Deep navy at rest, brand blue when active — both clear AA on the white
  // capsule, and navy reads far better than slate on a large display.
  //
  // The colour shift alone is NOT the indicator: navy and brand blue sit 2.37:1
  // apart, under the 3:1 needed to read as two different colours, and colour on
  // its own fails WCAG 1.4.1 regardless. The underline is what marks state.
  const color = active ? theme.primary : NavLinkColor;

  const hasChildren = Boolean(link.children);

  /*
   * A parent toggles; a leaf navigates.
   *
   * Toggling rather than only opening matters for the hover case on web: the
   * pointer has already opened the menu by the time a click lands, and a press
   * that could only open would be a dead click.
   */
  const handlePress = () => {
    if (!hasChildren) {
      onPress();
      return;
    }
    cancelClose();
    onSubmenuChange(!submenuOpen);
  };

  return (
    <View
      onPointerEnter={hoverOpen}
      onPointerLeave={hoverClose}
      // The raised z-index applies only while open, so a closed link never sits
      // above its neighbours and steal their taps.
      style={[styles.linkWrapper, submenuOpen && styles.linkWrapperOpen]}>
      <Pressable
        onPress={handlePress}
        accessibilityRole={hasChildren ? 'button' : 'link'}
        accessibilityLabel={link.label}
        /*
         * `expanded` for a menu, `selected` for a link. A screen reader
         * announcing "link, selected" for something that opens a menu is a
         * promise of navigation that does not happen.
         */
        accessibilityState={hasChildren ? { expanded: submenuOpen } : { selected: active }}
        style={({ pressed }) => [
          styles.link,
          !showLabels && styles.linkIconOnly,
          // Compact mode: the soft fill is 1.15:1 on white — all but invisible
          // on its own — so the ring carries the state.
          active &&
            !showLabels && {
              backgroundColor: theme.primarySoft,
              borderColor: theme.primary,
            },
          pressed && styles.pressed,
        ]}>
        {!showLabels && link.icon(color, 19)}
        {showLabels && (
          <View style={styles.linkLabel}>
            <View style={styles.linkTextRow}>
              <Text style={[styles.linkText, { color }]}>{link.label}</Text>
              {/*
                Inside the same control, not beside it. Rotating one chevron
                rather than swapping in an up-chevron keeps the direction
                honest mid-animation.
              */}
              {hasChildren && (
                <View style={submenuOpen ? styles.caretOpen : undefined}>
                  <ChevronDown color={color} size={15} />
                </View>
              )}
            </View>
            {/*
              Always rendered, transparent when inactive, so switching pages
              never nudges the row by 2px.
            */}
            <View
              style={[
                styles.underline,
                { backgroundColor: active ? theme.primary : 'transparent' },
              ]}
            />
          </View>
        )}
      </Pressable>

      {submenuOpen && link.children && (
        <View
          onPointerEnter={cancelClose}
          onPointerLeave={hoverClose}
          style={[
            styles.submenu,
            alignEnd ? styles.submenuEnd : styles.submenuStart,
            {
              backgroundColor: theme.navBackground,
              borderColor: theme.navBorder,
              shadowColor: theme.shadow,
            },
            Elevation.raised,
          ]}>
          {/*
            One line each: icon, label, nothing else.

            These rows carried a description under every label, which made a
            four-item menu eleven lines tall and turned a navigation control into
            something you read rather than scan. The descriptions were also the
            least useful text in the app — "Browse open deliveries by route" under
            a link called Schedule My Journey tells a driver nothing they had not
            already worked out from the label.

            A bare icon rather than the tinted chip, matching the drawer rows
            below. The chip was there to anchor two lines of text; against a
            single line it is a coloured square doing nothing.
          */}
          {link.children.map((child) => (
            <Pressable
              key={child.key}
              onPress={() => onSelectChild(child)}
              accessibilityRole="link"
              accessibilityLabel={child.label}
              style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                styles.submenuItem,
                (pressed || hovered) && { backgroundColor: theme.surfaceMuted },
              ]}>
              {child.icon(theme.textSecondary, 17)}
              <Text style={[styles.submenuLabel, { color: theme.text }]} numberOfLines={1}>
                {child.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function SideMenu({
  open,
  onClose,
  onNavigate,
  onNavigateChild,
  onGetApp,
  onAuth,
  onSignOut,
  user,
  isAuthenticated,
  links,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (href: NavHref) => void;
  onNavigateChild: (child: NavChild) => void;
  onGetApp: () => void;
  onAuth: () => void;
  onSignOut: () => void;
  user: { name: string; email: string | null } | null;
  isAuthenticated: boolean;
  /** Passed in so the drawer and the capsule can never list different links. */
  links: NavLink[];
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Read here rather than passed down, so the drawer and the capsule can never
  // disagree about which page is current.
  const pathname = usePathname();

  /**
   * Which group is open. One at a time.
   *
   * The children used to be permanently expanded, on the reasoning that the
   * drawer is the only route to them on a phone. That was right about the
   * requirement and wrong about the shape: eleven children between four groups
   * turned the drawer into a wall and pushed About Us and Admin below the fold,
   * so the last two entries were the hardest to reach rather than the easiest.
   *
   * An accordion keeps every group one tap from the top. Single-open rather
   * than multi-open for the same reason — two groups expanded is most of the
   * scroll back.
   */
  const [expanded, setExpanded] = useState<string | null>(null);

  /*
   * Opens on the group that owns the current page, so someone deep in the
   * driver screens sees those siblings without hunting for them. Recomputed
   * each time the drawer opens rather than once on mount, because the route
   * changes underneath a drawer that stays mounted.
   */
  useEffect(() => {
    if (!open) return;
    setExpanded(links.find((link) => link.children && isActive(pathname, link))?.key ?? null);
  }, [open, pathname, links]);

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close menu">
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={[
            styles.drawer,
            {
              backgroundColor: theme.navBackground,
              borderLeftColor: theme.navBorder,
              paddingTop: insets.top + Spacing.four,
              paddingBottom: insets.bottom + Spacing.four,
              shadowColor: theme.shadow,
            },
            Elevation.raised,
          ]}>
          <View style={styles.drawerHeader}>
            <Text style={[styles.logoText, { color: theme.primary }]}>LOCI</Text>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityLabel="Close"
              style={[styles.iconCircle, { backgroundColor: theme.surfaceMuted }]}>
              <X color={theme.textSecondary} size={18} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} style={styles.drawerScroll}>
            {links.map((link) => {
              const active = isActive(pathname, link);

              /*
               * A grouped entry is a heading here, not a link.
               *
               * Its `href` is the same destination as its first child, and the
               * children are listed immediately below — so making it pressable
               * would offer two controls that do the same thing, one of which
               * silently picks an option for you.
               */
              const grouped = Boolean(link.children);

              /*
               * Written out twice rather than swapping the component type.
               * `View` takes an object style and `Pressable` takes a function
               * of press state; a `Row = grouped ? View : Pressable` compiles
               * happily and then hands `View` a function it cannot call.
               */
              const rowContent = (
                <>
                  {/*
                    Left rule marking the current page. The tinted row alone is
                    1.15:1 against the drawer — the bar is what's actually
                    visible, and it means the state isn't carried by colour
                    alone.
                  */}
                  <View
                    style={[
                      styles.drawerActiveBar,
                      { backgroundColor: active ? theme.primary : 'transparent' },
                    ]}
                  />
                  <View style={[styles.drawerIcon, { backgroundColor: theme.primarySoft }]}>
                    {link.icon(theme.primaryOnSoft, 18)}
                  </View>
                  <View style={styles.drawerItemText}>
                    <Text
                      style={[
                        styles.drawerLabel,
                        { color: active ? theme.primary : theme.text },
                        active && font(700),
                      ]}>
                      {link.label}
                    </Text>
                    <Text style={[styles.drawerDescription, { color: theme.textMuted }]}>
                      {link.description}
                    </Text>
                  </View>
                </>
              );

              const isOpen = expanded === link.key;

              return (
                <View key={link.key}>
                  {grouped ? (
                    <Pressable
                      onPress={() => setExpanded(isOpen ? null : link.key)}
                      accessibilityRole="button"
                      accessibilityLabel={link.label}
                      accessibilityState={{ expanded: isOpen }}
                      style={({ pressed }) => [
                        styles.drawerItem,
                        { borderBottomColor: theme.navBorder },
                        active && { backgroundColor: theme.primarySoft },
                        pressed && { backgroundColor: theme.surfaceMuted },
                      ]}>
                      {rowContent}
                      {/*
                        Rotating one chevron rather than swapping glyphs, so the
                        direction stays honest mid-animation — same as the
                        capsule.
                      */}
                      <View style={isOpen ? styles.caretOpen : undefined}>
                        <ChevronDown color={theme.textMuted} size={18} />
                      </View>
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => onNavigate(link.href)}
                      accessibilityRole="link"
                      accessibilityState={{ selected: active }}
                      style={({ pressed }) => [
                        styles.drawerItem,
                        { borderBottomColor: theme.navBorder },
                        active && { backgroundColor: theme.primarySoft },
                        pressed && { backgroundColor: theme.surfaceMuted },
                      ]}>
                      {rowContent}
                    </Pressable>
                  )}

                  {/*
                    Only the open group's children. They are still the *only*
                    route to those screens on a phone — there is no hover, and
                    the capsule drops its caret below 1040px — which is why the
                    group containing the current page opens automatically.
                  */}
                  {isOpen &&
                    link.children?.map((child) => (
                      <Pressable
                        key={child.key}
                        onPress={() => onNavigateChild(child)}
                        accessibilityRole="link"
                        accessibilityLabel={`${link.label}: ${child.label}`}
                        style={({ pressed }) => [
                          styles.drawerChild,
                          { borderBottomColor: theme.navBorder },
                          pressed && { backgroundColor: theme.surfaceMuted },
                        ]}>
                        <View
                          style={[styles.drawerChildRule, { backgroundColor: theme.navBorder }]}
                        />
                        {child.icon(theme.textSecondary, 15)}
                        <Text style={[styles.drawerChildLabel, { color: theme.textSecondary }]}>
                          {child.label}
                        </Text>
                      </Pressable>
                    ))}
                </View>
              );
            })}

            {/*
              One row, two states. Showing "Sign In / Sign Up" to someone who is
              already signed in is the classic tell that a session isn't really
              wired up — so when it is, this names the account instead.
            */}
            <Pressable
              onPress={isAuthenticated ? onSignOut : onAuth}
              accessibilityRole="button"
              accessibilityLabel={
                isAuthenticated
                  ? `Signed in as ${user?.email ?? user?.name}. Sign out`
                  : 'Sign in or create an account'
              }
              style={({ pressed }) => [
                styles.drawerItem,
                { borderBottomColor: theme.navBorder },
                pressed && { backgroundColor: theme.surfaceMuted },
              ]}>
              <View
                style={[
                  styles.drawerIcon,
                  { backgroundColor: isAuthenticated ? theme.successSoft : theme.primarySoft },
                ]}>
                {isAuthenticated ? (
                  <LogOut color={theme.successOnSoft} size={18} />
                ) : (
                  <UserRound color={theme.primaryOnSoft} size={18} />
                )}
              </View>
              <View style={styles.drawerItemText}>
                <Text style={[styles.drawerLabel, { color: theme.text }]}>
                  {isAuthenticated ? 'Sign out' : 'Sign In / Sign Up'}
                </Text>
                <Text
                  style={[styles.drawerDescription, { color: theme.textMuted }]}
                  numberOfLines={1}>
                  {isAuthenticated
                    ? (user?.email ?? user?.name ?? 'Signed in')
                    : 'Access your parcels from any device'}
                </Text>
              </View>
            </Pressable>

            {/*
              Moved out of the announcement bar: the store picker is an
              occasional action, so it belongs in the menu rather than
              competing with the live ticker on every page load.
            */}
            <Pressable
              onPress={onGetApp}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.drawerItem,
                { borderBottomColor: theme.navBorder },
                pressed && { backgroundColor: theme.surfaceMuted },
              ]}>
              <View style={[styles.drawerIcon, { backgroundColor: theme.primarySoft }]}>
                <Smartphone color={theme.primaryOnSoft} size={18} />
              </View>
              <View style={styles.drawerItemText}>
                <Text style={[styles.drawerLabel, { color: theme.text }]}>Get the App</Text>
                <Text style={[styles.drawerDescription, { color: theme.textMuted }]}>
                  25% off your first booking in the LOCI app
                </Text>
              </View>
            </Pressable>
          </ScrollView>

          <View style={[styles.drawerFooter, { borderTopColor: theme.navBorder }]}>
            <View style={[styles.flagBadge, { backgroundColor: theme.surfaceMuted }]}>
              <Text style={styles.flag}>🇳🇬</Text>
              <Text style={[styles.flagText, { color: theme.textSecondary }]}>Nigeria · NGN</Text>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    // Side margins only — the capsule stretches to fill the rest of the width.
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.two,
    /*
     * Above the live ticker, which is the *next* sibling inside StickyHeader.
     *
     * Without this the two stack in document order and the ticker wins, so an
     * open dropdown was drawn behind the "No parcels moving right now" bar —
     * its first item half-hidden. The header's own `zIndex: 50` only settles
     * the header against the page below it; this settles the two pieces of the
     * header against each other.
     *
     * Kept low deliberately: it competes with `styles.ticker`, not with the
     * header, so a large number here would only invite the next person to
     * escalate.
     */
    zIndex: 2,
  },
  wrapperTight: {
    paddingHorizontal: Spacing.three,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    borderRadius: 50,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.three - 4,
    paddingHorizontal: Spacing.four,
    width: '100%',
    // No `overflow: 'hidden'` here, tempting as it is as a safety net: it crops
    // the capsule's own shadow on iOS. The breakpoints above are what keep the
    // row inside its bounds.
  },
  capsuleTight: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.one,
  },
  pressed: {
    opacity: 0.6,
  },
  logo: {
    paddingVertical: Spacing.half,
  },
  logoText: {
    ...Typography.wordmark,
  },
  links: {
    flexDirection: 'row',
    alignItems: 'center',
    // Uniform 24px between every item.
    gap: Spacing.four,
    flexShrink: 1,
  },
  linksCompact: {
    gap: Spacing.one + 2,
  },
  /** Phone widths: the drawer carries navigation, so the row takes no space. */
  linksHidden: {
    display: 'none',
  },
  hidden: {
    display: 'none',
  },
  /** Anchor for the submenu, which is positioned against this box. */
  linkWrapper: {
    position: 'relative',
  },
  linkWrapperOpen: {
    zIndex: 60,
  },
  link: {
    paddingVertical: Spacing.one,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  /** Label and chevron on one baseline, above the shared underline. */
  linkTextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  caretOpen: {
    transform: [{ rotate: '180deg' }],
  },
  submenu: {
    position: 'absolute',
    // Clear of the label and its underline, with a small gap the pointer can
    // cross — hence the close delay in `hoverClose`.
    top: '100%',
    marginTop: Spacing.two,
    /*
     * 280px, re-measured after the descriptions came out.
     *
     * "Terms of Service & Privacy Policy" still renders 219.5px at 14px
     * semi-bold — it is the longest label and it is what sets the floor. The
     * row now spends 28px on padding, 18px on a bare icon and 12px on the gap:
     * 277.5px. Anything narrower wraps that label, which is the two-line row
     * this change exists to remove.
     *
     * It was 296px when each row carried a 30px icon chip. Leaving it there
     * would have been harmless and wrong — a menu 16px wider than its content
     * for a reason that no longer exists.
     */
    minWidth: 280,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.one,
  },
  submenuStart: {
    left: -Spacing.two,
  },
  submenuEnd: {
    right: -Spacing.two,
  },
  submenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
    paddingVertical: Spacing.two + 2,
    paddingHorizontal: Spacing.three - 2,
    /*
     * 44px, explicitly, rather than hoping the padding adds up to it.
     *
     * A single line of 14px type plus 10px of padding each side is 41px, which
     * is under the minimum touch target — and the row used to clear it only
     * because it was two lines tall. Padding alone is the wrong lever here:
     * enough of it to reach 44 would make the menu feel loose, which is the
     * opposite of what this change is for.
     */
    minHeight: 44,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  submenuLabel: {
    flex: 1,
    fontSize: FontSize.small,
    ...font(600),
  },
  linkIconOnly: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 0,
    // Reserved on every icon link so the active ring doesn't resize the row.
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  /** Stacks the label over its underline and sizes the rule to the word. */
  linkLabel: {
    alignItems: 'stretch',
    gap: 5,
  },
  linkText: {
    fontSize: FontSize.body,
    // Semi-bold on every link, active or not — only the colour changes.
    ...font(600),
    textAlign: 'center',
  },
  /**
   * 2.5px rather than a hairline: at 1px this renders sub-pixel on a 2x/3x
   * screen and turns into a pale grey smear instead of a sharp brand-blue rule.
   * Square ends, full label width — reads as an underline, not a dash.
   */
  underline: {
    height: 2.5,
    borderRadius: 1.5,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    /*
     * Never compress. Under flexbox an <svg> in a squeezed row gets scaled on
     * its main axis, which is why the avatar came out as an oval and the
     * hamburger's rules collapsed together. The links shrink; these do not.
     */
    flexShrink: 0,
  },
  actionsTight: {
    gap: Spacing.one + 2,
  },
  /** Same reason: a fixed box the icon can't be squashed inside. */
  actionIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  /** Both roles visible at once; the active one is filled. */
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.pill,
    padding: 2,
    flexShrink: 0,
  },
  /**
   * 8px instead of 12px each side, reclaiming 16px across the pair. On a 320px
   * phone that is the difference between fitting and overflowing. The tap
   * target stays above 44px tall, so only the visual padding tightens.
   */
  segmentTight: {
    paddingHorizontal: Spacing.two,
  },
  segment: {
    paddingHorizontal: Spacing.two + 4,
    paddingVertical: Spacing.one + 1,
    borderRadius: Radius.pill,
    ...Platform.select({ web: { transitionDuration: '150ms', cursor: 'pointer' }, default: {} }),
  },
  segmentText: {
    fontSize: FontSize.caption,
    ...font(700),
  },
  avatarInitials: {
    fontSize: FontSize.caption,
    ...font(700),
    letterSpacing: 0.3,
  },
  iconCircle: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },

  // Drawer
  backdrop: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  drawer: {
    width: '82%',
    maxWidth: 340,
    height: '100%',
    borderLeftWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
  },
  drawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.four,
  },
  drawerScroll: {
    flex: 1,
  },
  drawerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 2,
    paddingVertical: Spacing.three - 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.sm,
  },
  /** Always present, transparent when inactive, so rows never shift. */
  drawerActiveBar: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 2,
    // Cancels the row's own gap so the bar sits flush against the edge.
    marginRight: -(Spacing.three - 2) + Spacing.two,
  },
  drawerChild: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two - 2,
    // Indented under its parent, so the relationship is visible without a
    // disclosure control.
    paddingLeft: Spacing.two,
    paddingVertical: Spacing.two - 1,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  drawerChildRule: {
    width: 2,
    height: 16,
    borderRadius: 1,
    marginRight: Spacing.two,
  },
  drawerChildLabel: {
    ...Typography.meta,
    ...font(600),
    flex: 1,
  },
  drawerIcon: {
    width: 38,
    height: 38,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerItemText: {
    flex: 1,
    gap: Spacing.half,
  },
  drawerLabel: {
    ...Typography.body,
    ...font(700),
  },
  drawerDescription: {
    ...Typography.meta,
  },
  drawerFooter: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.three,
  },
  flagBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radius.pill,
  },
  flag: {
    fontSize: FontSize.caption,
  },
  flagText: {
    fontSize: FontSize.micro,
    ...font(700),
  },
});
