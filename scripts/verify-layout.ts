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

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — every native screen reserves the status bar exactly once, the build banner and\n' +
    '       the layouts never both claim it, on Post a Parcel the title, the delivery type\n' +
    '       and its rate scroll with the form as one block at the top of it, the driver\n' +
    '       identity and bell stay put while the hub scrolls under them, no route stretches\n' +
    '       its content across a desktop viewport, and the top header stays a plain block in\n' +
    '       normal flow — no scroll listener, no animated layout, nothing to stutter.',
);
