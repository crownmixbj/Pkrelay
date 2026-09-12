/**
 * Assertions for screen chrome: safe areas, and what stays put when you scroll.
 *
 * Both of these are invisible in a simulator with no notch and on every web
 * browser, which is exactly why they reached a tester's phone. A title drawn
 * under the dynamic island is not a crash and produces no warning — it just
 * looks broken, and only on hardware.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Comments stripped: these files explain the rules they enforce. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Collapses the line breaks Prettier introduces inside JSX. */
const flat = (source: string) => source.replace(/\s+/g, ' ');

const book = read('src/app/(tabs)/book.tsx');
const bookCode = code(book);
const tabsLayout = code(read('src/app/(tabs)/_layout.tsx'));
const stickyHeader = code(read('src/components/ui/sticky-header.tsx'));
const banner = code(read('src/components/ui/build-banner.tsx'));
const topInset = read('src/hooks/use-top-inset.ts');

// -------------------------------------------------------------- safe areas ---

check(
  'the tabs layout reserves the status bar',
  flat(tabsLayout).includes('paddingTop: topInset'),
  'without it every tab screen draws its title under the notch — a native stack with headerShown:false owns the whole window',
);

check(
  'screens outside the tabs group reserve it too',
  flat(stickyHeader).includes('paddingTop: topInset'),
  'parcel detail and the auth screens sit outside (tabs) and inherit nothing from it',
);

/*
 * Exactly one wrapper per route, or the gap is applied twice.
 *
 * `StickyHeaderScreen` is for routes outside the tabs group. If a screen inside
 * (tabs) ever adopted it, that screen would be padded by both.
 */
const tabScreens = [
  'book',
  'my-packages',
  'available-packages',
  'driver',
  'locations',
  'about',
  'tracking',
  'admin',
];

for (const screen of tabScreens) {
  let source: string;
  try {
    source = read(`src/app/(tabs)/${screen}.tsx`);
  } catch {
    continue;
  }

  check(
    `${screen} does not stack a second safe-area wrapper`,
    !code(source).includes('StickyHeaderScreen'),
    'the tabs layout already reserves the inset for it, so this would double the gap',
  );
}

/*
 * The banner and the layouts must not both claim the strip.
 *
 * When the build banner renders it is the topmost thing in the tree, so it
 * takes the inset and the layouts give theirs up. This is the coupling that
 * makes a disconnected build look right rather than showing the gap twice.
 */
check(
  'the build banner carries the inset itself',
  flat(banner).includes('paddingTop: insets.top'),
  'it is the topmost element when it renders',
);
check(
  'and the shared hook yields to it',
  flat(topInset).includes('return backendConfigured ? insets.top : 0;'),
  'otherwise a disconnected build reserves the status bar twice',
);
check(
  'the yield is driven by a build-time constant, not state',
  topInset.includes("from '@/lib/build-info'") && !/useState|useEffect/.test(topInset),
  'a runtime toggle here would re-layout every screen mid-session',
);

// ---------------------------------------------------- Post a Parcel chrome ---

/*
 * ⚠ These assertions used to require the opposite, and the reversal is the
 *   point rather than a regression.
 *
 *   The title, the delivery type and the rate were pinned: a sibling of the
 *   ScrollView, which is the only arrangement that keeps a block still in React
 *   Native. The reasoning was sound — the delivery type is not a form field, it
 *   sets the price and decides which questions appear, so scrolling it away
 *   leaves somebody filling in a form with no sign of which of the two it is.
 *
 *   What it cost was about 140px of every screen, permanently, on the longest
 *   form in the app. On a phone that is a third of the space available to
 *   answer the questions underneath it. The block scrolls now.
 *
 *   What is still worth guarding is what has not changed: there is exactly one
 *   delivery-type control, the rate stays beside it, and both sit at the top of
 *   the page rather than somewhere in the middle of the form.
 */
const scrollStart = bookCode.indexOf('ref={scrollRef}');
const scrollBlock = bookCode.slice(scrollStart);

check(
  'the title, the delivery type and the rate all scroll with the form',
  /Post a Parcel/.test(scrollBlock) &&
    scrollBlock.includes('<SegmentedControl') &&
    scrollBlock.includes('PRICING.base.local'),
  'pinned, they spend a third of a phone screen on chrome above the questions',
);
check(
  'and nothing is left pinned above the scroller',
  !/Post a Parcel|<SegmentedControl/.test(
    bookCode.slice(bookCode.indexOf('<KeyboardAvoidingView'), scrollStart),
  ),
  'half in and half out is the arrangement that looks like a bug rather than a decision',
);

check(
  'there is exactly one delivery type control',
  (bookCode.match(/<SegmentedControl/g) ?? []).length === 1,
  'two would disagree the moment one was tapped',
);
check(
  'the rate travels with the selector',
  (() => {
    const selector = scrollBlock.indexOf('<SegmentedControl');
    const rate = scrollBlock.indexOf('PRICING.base.local');
    return rate > selector && rate - selector < 900;
  })(),
  'somebody choosing between the two pills is choosing on price',
);
check(
  'the block is the first thing on the page, above the step indicator',
  scrollBlock.indexOf('<SegmentedControl') < scrollBlock.indexOf('<WizardProgress'),
  'a delivery type found halfway down the form is one people answer around',
);
check(
  'the title is not a full ScreenHeader',
  !bookCode.includes('<ScreenHeader'),
  'a 28px title with 24px of margin is for a page you arrive at and read, not the top of a form',
);

check(
  'the ScrollView is bounded',
  flat(bookCode).includes('<ScrollView ref={scrollRef} style={styles.flex}'),
  'without flex:1 it sizes to its content rather than the window',
);
check(
  'the page does not reuse screenPadding',
  !bookCode.includes('screenPadding'),
  'this screen sets its own; the shared constant is sized for pages with a ScreenHeader',
);

/*
 * Scroll-to-first-error still has something to scroll.
 *
 * The offset is measured with onLayout relative to the ScrollView's content, so
 * moving two blocks out of it changes the number — but it is measured at
 * runtime, so it re-derives itself. What would break it is the ref or the
 * measurement being dropped in the refactor.
 */
check(
  'the error scroll still targets a card inside the ScrollView',
  scrollBlock.includes('itemCardY.current = event.nativeEvent.layout.y'),
  'the measured card has to be inside the container being scrolled',
);
check(
  'and the ScrollView still holds the ref it scrolls',
  scrollBlock.includes('ref={scrollRef}') && bookCode.includes('scrollRef.current?.scrollTo'),
);

// --------------------------------------------- the header that stays put ---

const hub = read('src/components/ui/driver-hub.tsx');
const sticky = read('src/components/ui/sticky-header.tsx');
const hubCode = code(hub);

check(
  'there is one wrapper for a screen whose own header stays put',
  sticky.includes('export function PinnedHeaderScreen'),
  'book.tsx assembled this inline; a second screen doing it again is how three variants appear',
);
check(
  'it fills the screen in a column',
  /pinnedScreen:\s*\{[\s\S]{0,400}?flex: 1,[\s\S]{0,400}?flexDirection: 'column'/.test(sticky),
  'the arrangement is the whole implementation — React Native has no position: sticky',
);
check(
  'the body takes the remaining space as a fixed box',
  /pinnedBody: \{ flex: 1 \}/.test(sticky),
  'flexGrow instead would size the body to its content and push the header off the top',
);
check(
  'the header is layered above the body',
  /pinnedHeader: \{ zIndex: 10 \}/.test(sticky),
  'Android paints by elevation rather than document order, so content slides over an unlayered header',
);
check(
  'and it reserves no safe-area inset of its own',
  !/useTopInset/.test(sticky.slice(sticky.indexOf('PinnedHeaderScreen'))),
  'the (tabs) layout reserves the status bar once; a second inset pushes the header down by a notch',
);

check(
  'the driver header is built as a sibling, not as the first row of the scroller',
  hubCode.includes('const header = (') &&
    hubCode.indexOf('const header = (') < hubCode.indexOf('<PinnedHeaderScreen'),
);
check('and it is handed to the wrapper', hubCode.includes('<PinnedHeaderScreen header={header}>'));
check(
  'the identity, the location and the bell are all in the pinned block',
  (() => {
    const from = hubCode.indexOf('const header = (');
    const to = hubCode.indexOf('return (', from);
    const block = hubCode.slice(from, to);
    return (
      block.includes('styles.avatar') &&
      block.includes('application?.baseCity') &&
      block.includes('<Bell ')
    );
  })(),
  'the bell is the worst of the three to lose: it is the only sign that something needs attention',
);
check(
  'nothing scrollable is inside the pinned block',
  (() => {
    const from = hubCode.indexOf('const header = (');
    const to = hubCode.indexOf('return (', from);
    return !hubCode.slice(from, to).includes('ScrollView');
  })(),
);
check(
  'the hub scroller is a fixed box, not a growing one',
  hubCode.includes('style={[styles.flex, { backgroundColor: theme.background }]}') &&
    /flex: \{ flex: 1 \}/.test(hubCode),
);

/*
 * A sweep, so this cannot quietly come back.
 *
 * The failure mode is invisible in source: a header rendered as the first child
 * of a ScrollView looks identical to one rendered beside it, and the difference
 * only shows on a phone once there is enough content to scroll.
 */
/*
 * ⚠ `book.tsx` was on this list and no longer is.
 *
 *   Its header is now deliberately inside the scroller — see the reversal noted
 *   at the top of this file. The Driver Hub's is not: that one is a phone
 *   screen whose bell is the only sign that something needs attention, and it
 *   has to stay on screen while the job list moves under it.
 */
const headerInsideScroller = ['src/components/ui/driver-hub.tsx'].filter((path) => {
  const source = code(read(path));
  /*
   * The JSX element, not the type.
   *
   * `useRef<ScrollView>(null)` is declared near the top of book.tsx and
   * contains the literal `<ScrollView`, so a plain indexOf finds it hundreds
   * of lines above the real element and reports a screen as broken when it is
   * not. Requiring whitespace after the name excludes `<ScrollView>`.
   */
  const scroller = source.search(/<ScrollView[\s\n]/);
  if (scroller === -1) return false;
  // The identity/title block must be declared before the scroller opens.
  const pinned = Math.max(source.indexOf('const header = ('), source.indexOf('styles.pinned'));
  return pinned === -1 || pinned > scroller;
});

check(
  'no screen with a pinned block renders it inside its scroller',
  headerInsideScroller.length === 0,
  `inside the scroller: ${headerInsideScroller.join(', ') || 'none'}`,
);

// ------------------------------------------ one reading width, everywhere --

/*
 * A form field the width of a desktop window is not a matter of taste.
 *
 * Line length and target size are the two things every desktop layout
 * convention agrees on, and an input that spans 1400px fails both. Every full
 * page in this app centres its content at `MaxContentWidth` — except when
 * somebody rewrites a screen and does not carry the container across, which is
 * exactly what happened to Schedule My Journey when the marketplace board was
 * stripped out of it.
 *
 * This sweeps the routes rather than naming them, so a new screen is covered
 * the day it is added rather than the day somebody notices.
 */
const DELIBERATE_FULL_BLEED: Record<string, string> = {
  '_layout.tsx': 'not a page — the route group shell',
  'index.tsx': 'the landing page, full-bleed by design at 1280 with its own inner widths',
  'about.tsx': 'marketing, with its own narrower measures per section',
};

const routes = readdirSync(join(ROOT, 'src/app/(tabs)'))
  .filter((name) => name.endsWith('.tsx'))
  .filter((name) => !(name in DELIBERATE_FULL_BLEED));

const unconstrained = routes.filter((name) => {
  const source = read(`src/app/(tabs)/${name}`);
  // Either the screen sets it, or it renders inside a shell that does.
  return !source.includes('MaxContentWidth') && !source.includes('AdminShell');
});

check(
  'every route constrains its content width',
  unconstrained.length === 0,
  `unconstrained: ${unconstrained.join(', ') || 'none'} — add the house container or list it as deliberate`,
);

check(
  'and centring is paired with a width to centre',
  routes.every((name) => {
    const source = read(`src/app/(tabs)/${name}`);
    if (!source.includes("alignItems: 'center'")) return true;
    return source.includes('maxWidth') || source.includes('AdminShell');
  }),
  'alignItems center on a full-width child does nothing, which is how two screens looked centred in the source and stretched in a browser',
);

// ------------------------------- the header stays out of the scroll path ---

/*
 * ⚠ A regression guard for a feature that was built, shipped and removed.
 *
 *   The header briefly hid itself on scroll down and returned on scroll up. It
 *   worked. It also animated `marginTop` — a layout property — for 200ms on
 *   every direction change, and every one of those frames reflowed the screen
 *   below it. On the driver application, the largest tree in the app, that read
 *   as stutter: a header that bought 140px by making the scrolling it bought
 *   them for worse.
 *
 *   The two halves could not be separated. Reclaiming the space *is* the layout
 *   work; a compositor-only transform moves the pixels and leaves the box, so
 *   the header disappears and the space stays spent on an empty band. Between a
 *   smooth scroll and 140px, the scroll wins — it is felt on every screen, all
 *   the time, by everybody.
 *
 *   The idea is an easy one to have twice, which is why these assertions exist
 *   rather than a note in a commit message.
 */
check(
  'the header does not listen to scrolling',
  !/addEventListener\(\s*'scroll'/.test(stickyHeader) && !/onScroll/.test(stickyHeader),
  'a scroll listener driving a component this close to the root is a re-render per frame',
);
check(
  'and animates no layout property',
  !/Animated/.test(stickyHeader),
  'margin, height, top and padding all reflow the subtree; on the driver form that is the stutter',
);
check(
  'it is a plain View in normal flow',
  flat(stickyHeader).includes('<View style={styles.header}>'),
  'the fix for the stutter was to stop doing anything, so this has to stay boring',
);
check(
  'nothing in the header stack is taken out of flow',
  [
    'src/components/ui/sticky-header.tsx',
    'src/components/ui/app-nav-bar.tsx',
    'src/components/LiveTicker.tsx',
    'src/components/ui/top-status-bar.tsx',
  ].every((path) => !/position:\s*'(fixed|sticky)'/.test(code(read(path)))),
  'React Native has no sticky, and a fixed header on web would overlap the content it sits above',
);

/*
 * The one exception, stated so it is not mistaken for a violation of the rule
 * above: overlays that must stay with the viewport rather than the page.
 */
check(
  'the toast is the only thing pinned over the page',
  /position: 'absolute'/.test(code(read('src/components/ui/toast.tsx'))),
  'a notification that scrolls away with the content is one nobody reads',
);

// ------------------------------------------ the service cards are a grid --

/*
 * ⚠ `flex: 1` inside `flexWrap` is the bug, and it only shows on the last row.
 *
 *   A wrapped item is alone on its line. `flex: 1` means "take the remaining
 *   space", and on a line of one that is the whole width — so the fourth
 *   service card stretched edge to edge under a row of three. Nothing looks
 *   wrong until the count and the viewport happen to wrap, which is why it
 *   survived review.
 *
 * ⚠ Solved by measuring, not by CSS Grid.
 *
 *   `display: grid` would fix the web and do nothing on iOS or Android — Yoga
 *   has no grid implementation, so the native builds would stack into a single
 *   column. Computing a column width behaves identically on all three.
 */
const homeScreen = code(read('src/app/(tabs)/index.tsx'));
const serviceCard = code(read('src/components/ui/service-category-card.tsx'));

check(
  'the card no longer claims the rest of the line',
  !/card: \{\s*flex: 1,/.test(serviceCard),
  'flex: 1 on a wrapped item is what stretched the fourth card across the second row',
);
check(
  'and pins itself to the width it is given',
  serviceCard.includes('{ width, flexGrow: 0, flexShrink: 0 }'),
  'a width without flexGrow: 0 is a width the line can still grow past',
);
/*
 * ⚠ And falls back to filling, rather than to zero.
 *
 *   The container has no measurement on the first frame. A zero-width card
 *   there is an empty panel that flashes; filling the line for one frame is
 *   invisible.
 */
check(
  'with a fallback for the frame before measurement',
  serviceCard.includes(': { flex: 1 }'),
  'a 0-width card on the first frame flashes an empty panel',
);

check(
  'the container measures itself rather than guessing from the window',
  homeScreen.includes('onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)}'),
  'the panel sits inside a max-width column with padding, so the window width is not its width',
);
check(
  'the column count comes from the readable minimum',
  homeScreen.includes('Math.floor((gridWidth + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP))'),
  '',
);
check(
  'and never drops below one column',
  homeScreen.includes('Math.max(1,'),
  'a container narrower than one card would otherwise divide by zero',
);

/*
 * ⚠ One gap constant, because two would drift.
 *
 *   The stylesheet's `gap` and the arithmetic that subtracts it must be the
 *   same number. Four pixels of disagreement across three columns is twelve
 *   pixels of overflow, which reads as a mysterious scrollbar rather than as a
 *   wrong constant.
 */
check(
  'the gap is defined once',
  (homeScreen.match(/const GRID_GAP =/g) ?? []).length === 1 &&
    homeScreen.includes('gap: GRID_GAP,'),
  'the stylesheet and the column maths must subtract the same number',
);
check(
  'and the column width subtracts it for every gap but the last',
  homeScreen.includes('(gridWidth - GRID_GAP * (columns - 1)) / columns'),
  'subtracting one gap per column overflows by exactly one gap',
);

/*
 * ⚠ No CSS Grid anywhere in this app.
 *
 *   It is tempting on the web and silently inert on native. If somebody
 *   reaches for it later this is where they find out why not.
 */
check(
  'no screen reaches for CSS Grid',
  !/display:\s*'grid'/.test(homeScreen) && !/display:\s*'grid'/.test(serviceCard),
  'Yoga has no grid implementation, so this would fix the web and flatten iOS and Android',
);

// ------------------------------------------ where the app download lives ---

/*
 * The store badges, and the header they are no longer in.
 *
 * ⚠ They started beside the live ticker and were moved deliberately.
 *
 *   The header strip is a status bar with a navigation capsule above it —
 *   above the fold, and the part of the page the eye crosses on its way to the
 *   content. The single strongest call to action on the site was sitting there
 *   at the size a header accessory can be, competing with a scrolling marquee.
 *   It is now a band under the hero with a heading that says what the app is
 *   for, which is what every postal and courier site does with the same CTA.
 *
 *   Both halves are asserted: that the header is clean, and that the section
 *   exists. Only checking the second is how the badges end up in both places.
 */
const download = code(read('src/components/ui/app-download.tsx'));
const badges = code(read('src/components/ui/store-badges.tsx'));

check(
  'the header carries no store badges',
  !stickyHeader.includes('StoreBadges'),
  'the download band below the hero is the one place these live',
);
check(
  'the home screen renders the download section',
  homeScreen.includes('<AppDownload />'),
  'nothing else mounts it, so without this the component is dead code',
);
check(
  'below the hero and above the quote',
  (() => {
    const hero = homeScreen.indexOf('styles.hero,');
    const band = homeScreen.indexOf('<AppDownload />');
    const quote = homeScreen.indexOf('<QuickQuote');
    return hero !== -1 && band > hero && quote > band;
  })(),
  'the tracking card is what the visitor came for; the app is the thing to offer next',
);
check(
  'and unconditionally, apart from the native null',
  !/\{[^}]*&&\s*<AppDownload/.test(homeScreen) && !/useState/.test(download),
  'unlike the cookie banner this is not dismissible and does not depend on session or scroll',
);
check(
  'the section is web-only',
  download.includes("experience !== 'web'") && download.includes('return null'),
  'telling somebody inside the Android app to download the Android app reads as unfinished',
);
check(
  'the heading is a heading',
  download.includes('accessibilityRole="header"') &&
    download.includes('Download the Package Relay App'),
  'react-native-web maps it to <h2>, which is what puts the section in a screen reader outline',
);

check(
  'both listings are reachable',
  /platform: 'ios'/.test(badges) && /platform: 'android'/.test(badges),
);
check(
  'the badges leave for the store in a new tab on the web',
  badges.includes("'_blank'") && badges.includes('noopener'),
  'a desktop visitor sent away mid-booking has to find their way back',
);
check(
  'and they wrap rather than shrink when the line runs out',
  /row:\s*\{[^}]*flexWrap: 'wrap'/s.test(badges) && !/badge:\s*\{[^}]*flexShrink: 1/s.test(badges),
  'a squeezed badge clips "Google Play"; a badge on the next line is merely a badge on the next line',
);

// --------------------------------- the nav has two tiers, not three --------

/*
 * ⚠ A row of unlabelled glyphs is a native pattern, not a web one.
 *
 *   Between 690px and the label breakpoint the links used to collapse into bare
 *   icons: a parcel, a pin, a truck, an "i". On a phone tab bar that works —
 *   five fixed destinations somebody learns once. In a web nav it is a row of
 *   guesses, with no hover text and no way to tell Shipments from Hubs. The
 *   drawer behind the hamburger is what a web app is expected to do, and it was
 *   already built.
 */
const navBar = code(read('src/components/ui/app-nav-bar.tsx'));

check(
  'there is no icon-only tier',
  !navBar.includes('linkIconOnly') && !navBar.includes('ICON_LINK_BREAKPOINT'),
  'a link that renders without its label is the pattern this removed',
);
check(
  'and no second flag that could reintroduce one',
  !navBar.includes('showInlineLinks'),
  'two flags differing by width is exactly how the middle tier existed',
);
/*
 * ⚠ The load-bearing one: a link renders with its label or not at all.
 *
 *   `showLabels &&` gating the map is what makes those two states the only two.
 *   A future edit that renders the row and hides the text inside would pass
 *   every check above and bring the glyphs straight back.
 */
check(
  'links render only where their labels fit',
  navBar.includes('{showLabels &&') && navBar.includes('!showLabels && styles.linksHidden'),
  'rendering the row and hiding the text inside it is the same bug wearing a different flag',
);
check(
  'and the link itself has no iconless branch left',
  !/\{!showLabels && link\.icon/.test(navBar),
  '',
);

/*
 * ⚠ Removing the middle tier is only safe because the drawer is unconditional.
 *
 *   Below the label breakpoint the hamburger is the *only* navigation. If it
 *   were itself behind a width test, a range of viewports would have no way to
 *   reach any page at all.
 */
const hamburgerAt = navBar.indexOf('accessibilityLabel="Open menu"');
check('the hamburger exists', hamburgerAt >= 0);

/*
 * ⚠ Asserted as a property of the whole actions row, not as a regex around the
 *   button.
 *
 *   My first version matched a specific `flag && <Pressable` shape and missed
 *   the obvious mutation — wrapping it as `{!showLabels && (` puts a paren and
 *   a newline between the two, and the pattern walked straight past.
 *
 *   The honest rule is simpler: nothing in this row depends on the label
 *   breakpoint. The avatar and the hamburger are present at every width, and
 *   the hamburger is the *only* navigation below it. `tight` appears here and
 *   is fine — it adjusts padding, not presence.
 */
const actionsAt = navBar.indexOf('styles.actions,');
const actionsRow = actionsAt >= 0 ? navBar.slice(actionsAt, navBar.indexOf('<SideMenu')) : '';

check('the actions row parsed', actionsRow.includes('Open menu'), 'the slice missed the hamburger');
check(
  'nothing in it is gated on the label breakpoint',
  actionsRow.length > 0 && !actionsRow.includes('showLabels'),
  'below that breakpoint the hamburger is the only way to reach any page',
);
check(
  'the drawer is handed every link the bar knows about',
  navBar.includes('links={navLinks}'),
  'a drawer showing a subset would hide pages that used to have an icon',
);
/*
 * And it shows them as words. A drawer of icons would be the same failure
 * moved behind a button.
 */
check(
  'and renders them with their labels',
  navBar.includes('{link.label}') && navBar.includes('{child.label}'),
  'including the children, which were only ever reachable from a submenu',
);

// ------------------------------- no empty string can reach a <View> --------

/*
 * ⚠ `cond && <JSX/>` renders the *value* of `cond` when it is falsy-but-not-false.
 *
 *   `'' && <Text/>` is `''`, not `false`. React renders that as a text node,
 *   and react-native-web refuses a text node inside a `<View>`:
 *
 *     Unexpected text node: . A text node cannot be a child of a <View>.
 *
 *   The reported node is the empty string, so the error names the offending
 *   text and the offending text is nothing — which is what made it hard to
 *   place. It appeared on the selfie card in the window between the photo
 *   being banked and the check answering, when `note` was `''`.
 *
 *   The rule below is textual and therefore blunt: these are the names this
 *   codebase gives to strings, and a bare `&&` guard on one of them is the
 *   shape of the bug. A boolean guard — `!!x`, `Boolean(x)`, `x.length > 0`,
 *   `x !== null` — is always available and always correct.
 */
const STRINGY = [
  'note',
  'error',
  'notice',
  'label',
  'joined',
  'hint',
  'message',
  'reason',
  'detail',
  'subtitle',
  'value',
  'query',
  'address',
];

/*
 * Walked explicitly rather than with `readdirSync(..., { recursive: true })` —
 * this project's Node types do not carry that option, and esbuild would have
 * bundled it happily while `tsc` refused. The suite passed alone and the
 * typecheck at the end of `verify` is what caught it.
 */
function tsxFilesUnder(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...tsxFilesUnder(path));
    else if (entry.name.endsWith('.tsx')) found.push(path);
  }

  return found;
}

const screenFiles = tsxFilesUnder('src');

const offenders: string[] = [];

for (const file of screenFiles) {
  const source = code(read(file));
  for (const name of STRINGY) {
    /*
     * `{name && ` opening a JSX expression. Anything already boolean-ised —
     * `!!note`, `note.length`, `note !== null` — does not match, because the
     * character before the name is `!`, or what follows is `.` or a comparison.
     */
    const pattern = new RegExp(`\\{\\s*${name}\\s*&&([\\s\\S]{0,60})`, 'g');

    for (const match of source.matchAll(pattern)) {
      /*
       * ⚠ A ternary is safe and this rule flagged one.
       *
       *   `{label && next ? <A/> : <B/>}` uses the `&&` as a *condition*, so
       *   the expression always evaluates to one branch or the other and no
       *   string is ever rendered. Only a bare `&&` guard — where the falsy
       *   value itself becomes the output — is the bug.
       *
       *   Detected by looking for a `?` before the first `<` or `(`, which is
       *   where a ternary's question mark sits and where a guard's JSX starts.
       *   Blunt, and deliberately so: a false negative here is a bug that
       *   ships, a false positive is a minute spent reading one line.
       */
      const head = match[1].split(/[<(]/)[0];
      if (head.includes('?')) continue;

      offenders.push(`${file}: {${name} && …}`);
    }
  }
}

check(
  'no JSX conditional is guarded on a bare string',
  offenders.length === 0,
  `${offenders.join('\n       ')}\n       an empty string is rendered, not skipped — use !!x or x.length > 0`,
);

/*
 * And the specific one that broke, pinned so a refactor cannot quietly undo it.
 */
const selfieCard = code(read('src/components/ui/live-selfie-card.tsx'));
check(
  'the selfie note is guarded on a boolean',
  selfieCard.includes("captured !== null && (note ?? '').length > 0"),
  'this rendered the empty note as a text node for the moment before the check answered',
);

// ------------------------------- three steps that end on the same line ------

/*
 * ⚠ A stretched wrapper is not a stretched card.
 *
 *   The three "How Package Relay Works" cards sit in wrappers with `flex: 1`, and the
 *   panel's default `align-items: stretch` makes every wrapper as tall as the
 *   tallest. The Pressable *inside* each wrapper still sizes to its own
 *   content, so three cards with two, two and three lines of body text ended on
 *   three different lines — inside three columns that were already identical.
 *   The ragged edge belonged to the card, not the column.
 */
const howItWorks = code(read('src/components/ui/how-it-works.tsx'));

check(
  'each card fills the column it was given',
  /cardFilled: \{\s*flex: 1,/.test(howItWorks) &&
    howItWorks.includes('horizontal && styles.cardFilled'),
  'without it the wrappers line up and the white boxes inside them do not',
);

/*
 * ⚠ And a title that wraps must not move the text under it.
 *
 *   The three titles are 31, 36 and 42 characters. At most widths two fit on
 *   one line and the third wraps, which pushed that card's body a line lower
 *   than its neighbours' — the misalignment somebody actually reported.
 *   Reserving the second line fixes it for any copy rather than for today's at
 *   today's breakpoint, which is why this is asserted as a reserved height and
 *   not as "the titles are short enough".
 */
check(
  'a wrapped title does not push its body down',
  /stepTitleReserved: \{\s*minHeight: Typography\.cardTitle\.lineHeight \* 2,/.test(howItWorks),
  'shortening the copy would fix this at one width and break it at the next',
);
check(
  'and the reservation is applied',
  howItWorks.includes('horizontal && styles.stepTitleReserved'),
  'a style nothing references is a comment',
);
/*
 * ⚠ Only across. Stacked, every card is full width, every title fits on one
 *   line, and a reserved second is three gaps of white space aligning nothing
 *   with nothing.
 */
check(
  'but not when the cards are stacked',
  !/styles\.stepTitleReserved(?!\s*[,\]])/.test(
    howItWorks.replace(/horizontal && styles\.stepTitleReserved/g, ''),
  ),
  'reserving a line nobody needs is white space pretending to be alignment',
);
/*
 * ⚠ Derived from the type scale, not typed as a number.
 *
 *   `minHeight: 52` would be right today and silently wrong the moment
 *   `FontSize.subhead` moves, leaving a reserved line that is a little too
 *   short or a little too tall — which looks like a rendering bug rather than a
 *   stale constant.
 */
check(
  'the reserved height follows the type scale',
  !/minHeight: \d+,/.test(howItWorks.slice(howItWorks.indexOf('stepTitleReserved'))),
  'a hardcoded line height is right until somebody changes the font size',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — every native screen reserves the status bar exactly once, the build banner and\n' +
    '       the layouts never both claim it, on Post a Parcel the title, the delivery type\n' +
    '       and its rate scroll with the form as one block at the top of it, the driver\n' +
    '       identity and bell stay put while the hub scrolls under them, no route stretches\n' +
    '       its content across a desktop viewport, the top header stays a plain block in\n' +
    '       normal flow — no scroll listener, no animated layout, nothing to stutter — and the\n' +
    '       app download is one band under the hero rather than two badges beside the ticker.',
);
