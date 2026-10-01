/**
 * Whether the header's links fit on one line.
 *
 * ⚠ This replaces a hand-measured number, and the number is why it exists.
 *
 *   `app-nav-bar.tsx` decided with `width >= 1040`, arrived at by measuring the
 *   row in a browser and writing the total down. Its own comments record that
 *   figure being invalidated twice — once when "My Jobs" was added (877 → 997)
 *   and once when the Hubs caret cost another 19px — each time silently, each
 *   time found by looking at it. The file asks the next person to "re-measure
 *   after any change to NAV_LINKS", which is a footgun with a note taped to it.
 *
 *   A constant cannot know that a role label is longer for senders than
 *   drivers, that an admin has an extra link, that a longer email widens the
 *   account control, or that someone's browser renders Plus Jakarta a hair
 *   wider. The browser already knows all of it. This asks the browser.
 *
 * Pure and importing nothing, so the arithmetic is tested directly rather than
 * by rendering a header — the same split `lib/parcel-link.ts` uses.
 */

export type NavFitInput = {
  /** The capsule's border-box width, from its own onLayout. */
  capsuleWidth: number;
  /** Its `paddingHorizontal`, which onLayout includes and the content cannot use. */
  horizontalPadding: number;
  /** The wordmark's laid-out width. */
  logoWidth: number;
  /** The account and menu cluster's laid-out width. */
  actionsWidth: number;
  /** The labelled link row's natural width, measured off-screen. */
  linksWidth: number;
  /** The capsule's own gap, which sits between each of the three clusters. */
  gap: number;
  /** Breathing room, so a fit is a fit rather than a coincidence. */
  slack?: number;
};

/**
 * ⚠ Twelve pixels, and it is not arbitrary.
 *
 *   The file's history is of rows that fitted by 4px and then did not. Sub-pixel
 *   text rounding, a scrollbar appearing mid-session, a font loading a fraction
 *   wider — any of them eats a margin that small, and the failure is the avatar
 *   pushed onto the capsule's rounded edge. Twelve is enough to absorb all
 *   three and small enough that nothing collapses which visibly had room.
 */
export const NAV_FIT_SLACK = 12;

/**
 * True when the labelled links can sit inline without crowding anything.
 *
 * ⚠ Returns false whenever a measurement is missing, and the caller must treat
 *   that as "not known yet" rather than as "no".
 *
 *   onLayout fires after the first paint, so on the very first frame every
 *   width here is 0. Reading that as a genuine "does not fit" would collapse
 *   the nav on a wide desktop for a frame and then expand it — the flash this
 *   session has spent its time removing. The caller holds the previous answer,
 *   or the old breakpoint, until all four have arrived.
 */
export function inlineLinksFit(input: NavFitInput): boolean {
  const { capsuleWidth, horizontalPadding, logoWidth, actionsWidth, linksWidth, gap } = input;
  const slack = input.slack ?? NAV_FIT_SLACK;

  if (capsuleWidth <= 0 || logoWidth <= 0 || actionsWidth <= 0 || linksWidth <= 0) {
    return false;
  }

  /* Three clusters, so two gaps between them. */
  const available = capsuleWidth - horizontalPadding * 2 - logoWidth - actionsWidth - gap * 2;
  return linksWidth + slack <= available;
}

/** Whether every measurement needed for a real answer has arrived. */
export function navFitMeasured(input: NavFitInput): boolean {
  return (
    input.capsuleWidth > 0 &&
    input.logoWidth > 0 &&
    input.actionsWidth > 0 &&
    input.linksWidth > 0
  );
}
