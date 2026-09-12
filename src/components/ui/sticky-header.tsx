import { StyleSheet, View } from 'react-native';

import { LiveTicker } from '@/components/LiveTicker';
import { Navbar } from '@/components/Navbar';
import { StoreBadges } from '@/components/ui/store-badges';
import { PageCanvas, Spacing } from '@/constants/theme';
import { useExperience } from '@/hooks/use-experience';
import { useTopInset } from '@/hooks/use-top-inset';

/**
 * The top of the app: brand capsule plus the live delivery ticker.
 *
 * Extracted from the tabs layout so screens outside that group can mount the
 * same header instead of losing the navigation entirely. It is a *sibling* of
 * the scrolling content rather than the first row inside it, which is what lets
 * it stay put while a screen scrolls under it — React Native has no concept of
 * `position: sticky`.
 *
 * ⚠ Nothing here is positioned, animated, or driven by scrolling, and that is a
 *   decision rather than an omission.
 *
 *   This briefly hid itself on scroll down and reappeared on scroll up. The
 *   motion was real and so was the space it freed, but the way it freed the
 *   space was to animate `marginTop` — a layout property — for 200ms every time
 *   the direction changed. Every one of those frames reflowed the whole screen
 *   below, which on the driver application is the largest tree in the app, and
 *   the result was a header that saved 140px by making the scroll it saved them
 *   for stutter.
 *
 *   The two goals turned out to be the same goal: reclaiming the space *is* the
 *   layout work. A transform would have run on the compositor and been
 *   perfectly smooth, but it moves pixels and leaves the box, so the header
 *   would have vanished and left an empty band — the space still spent, now on
 *   nothing. Given the choice between a smooth scroll and 140px, the scroll is
 *   worth more: it is felt on every screen, all the time, by everybody.
 *
 *   `verify-layout` asserts this file stays free of scroll listeners and
 *   animated layout, so the idea cannot quietly come back.
 */
export function StickyHeader() {
  const experience = useExperience();

  /*
   * Desktop furniture, hidden on a phone.
   *
   * The capsule collapses to a hamburger at phone widths, which buries every
   * destination a tap deeper on the device where taps cost most — the bottom
   * tab bar carries navigation there instead. The ticker goes with it: a
   * scrolling marquee above a booking form is noise when the screen is 390px
   * wide and the form is the reason you opened the app.
   *
   * Null rather than an empty View, so no layout space is reserved for it.
   */
  if (experience && experience !== 'web') return null;

  return (
    <View style={styles.header}>
      <Navbar />
      {/*
        One row: the ticker takes what is left, the store badges keep their
        width. They are siblings rather than the badges living inside the nav
        capsule, because the capsule already collapses its links into a
        hamburger at 1040px — anything added to it is the next thing to be
        collapsed, and these are meant never to disappear.
      */}
      <View style={styles.topRow}>
        <View style={styles.ticker}>
          <LiveTicker />
        </View>
        <StoreBadges />
      </View>
    </View>
  );
}

/**
 * Convenience wrapper: the header above, the screen below, filling the rest.
 *
 * Anything passed as `children` must do its own scrolling — that's the point.
 * The header is outside the scroll container, so it can't scroll away.
 */
export function StickyHeaderScreen({ children }: { children: React.ReactNode }) {
  /*
   * The same status-bar reservation the tabs layout makes.
   *
   * These screens — parcel detail, sign-in, sign-up — sit outside the (tabs)
   * group, so they do not inherit it. No screen uses both wrappers, so there is
   * no route where the inset is applied twice.
   */
  const topInset = useTopInset();

  return (
    <View style={[styles.screen, { paddingTop: topInset }]}>
      <StickyHeader />
      {children}
    </View>
  );
}

/**
 * A screen whose own header stays put while its body scrolls under it.
 *
 * Distinct from `StickyHeaderScreen` above, which mounts the *web* chrome — the
 * brand capsule and ticker — and renders nothing at all on a phone. This is for
 * a screen's own header: the driver's avatar, name, city and notification bell,
 * the block that should never leave the top of a phone screen.
 *
 * ⚠ The arrangement is the whole implementation, and it is not decoration.
 *
 *   React Native has no `position: sticky`. The only way to keep a block still
 *   while content moves under it is to make it a *sibling* of the scroll
 *   container rather than its first child, inside a column flex parent that
 *   fills the screen. The scroller then takes `flex: 1` — the remaining space —
 *   and clips its own content instead of pushing the header up and away.
 *
 *   Get any one of those three wrong and it still renders: the header simply
 *   scrolls off, which looks like a design choice rather than a bug.
 *
 * ⚠ No safe-area inset here. The `(tabs)` layout reserves the status bar once
 *   for every screen inside it, and `verify-layout` asserts nothing reserves it
 *   twice — a second inset would push this header down by the height of the
 *   notch.
 *
 * `children` must do its own scrolling. That is the point.
 */
export function PinnedHeaderScreen({
  header,
  children,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.pinnedScreen}>
      {/*
        Above the body on both platforms.

        Android draws by elevation rather than document order, so a header with
        a shadow but no `zIndex` is painted *under* the content sliding beneath
        it — the shadow lands on top of nothing and the content covers the bell.
      */}
      <View style={styles.pinnedHeader}>{header}</View>

      <View style={styles.pinnedBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: PageCanvas,
  },
  pinnedScreen: {
    flex: 1,
    // Stated rather than relied on. It is the default, and it is also the thing
    // that makes the arrangement work, so it should be visible to whoever reads
    // this next.
    flexDirection: 'column',
  },
  pinnedHeader: { zIndex: 10 },
  /*
    `flex: 1` and nothing else.
    
    This takes the space the header did not, and — because it is a fixed-height
    box rather than a growing one — the scroller inside it clips at that height
    instead of growing to fit its content and shunting the header off the top.
  */
  pinnedBody: { flex: 1 },
  /**
   * The high z-index keeps the drawer and dropdowns above screen content, and
   * the canvas fill stops anything showing through behind the ticker as content
   * passes underneath.
   */
  header: {
    zIndex: 50,
    backgroundColor: PageCanvas,
    paddingBottom: Spacing.two,
  },
  /**
   * Explicitly *below* the navbar.
   *
   * The two are siblings, so without a z-index each they stack in document
   * order and this row — being second — covered any open nav dropdown. Stated
   * on both sides rather than only on the navbar, so the ordering is visible
   * from whichever file someone opens first.
   *
   * It sits on the row rather than on the ticker now that the badges share it:
   * a z-index on one child of the pair would lift that child alone.
   */
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
    marginTop: Spacing.two,
    zIndex: 1,
  },
  /**
   * The ticker yields, the badges do not.
   *
   * `flex: 1` here and `flexShrink: 0` on the badges is the whole responsive
   * behaviour of this row: as the window narrows the marquee gets shorter —
   * which costs nothing, it already scrolls — until the badges themselves drop
   * to their glyphs at their own breakpoint. `minWidth: 0` because a flex child
   * whose content overflows otherwise refuses to shrink below it, and a
   * marquee's content is wider than any window.
   */
  ticker: {
    flex: 1,
    minWidth: 0,
  },
});
