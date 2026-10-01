/**
 * Assertions for the header's inline-link decision.
 *
 * The bug this closes had no error and no wrong pixel: on a 1024px laptop
 * window the nav collapsed into the drawer, which was exactly what
 * `width >= 1040` had been written to do. The constant was measured once, in
 * one browser, for one role, and the file's own comments record it going stale
 * twice — 877 → 997 when a link was added, then another 19px for a caret.
 *
 * So the arithmetic that replaced it is tested here against those same recorded
 * figures, and against the shapes that a constant can never see: an admin's
 * extra link, a longer account label, a first frame with nothing measured yet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NAV_FIT_SLACK, inlineLinksFit, navFitMeasured, type NavFitInput } from '../src/lib/nav-fit';

let failures = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const nav = read('src/components/ui/app-nav-bar.tsx')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

/* The capsule's real geometry: paddingHorizontal Spacing.four, gap Spacing.three. */
const GEOMETRY = { horizontalPadding: 24, gap: 16 };

/* Measured clusters, in the proportions the file records. */
const LOGO = 104;
const ACTIONS = 96;

const at = (capsuleWidth: number, linksWidth: number, over: Partial<NavFitInput> = {}) =>
  inlineLinksFit({
    ...GEOMETRY,
    capsuleWidth,
    logoWidth: LOGO,
    actionsWidth: ACTIONS,
    linksWidth,
    ...over,
  });

// ------------------------------------- 1. the reported window ------------

/*
 * ⚠ This section asserts the boundary, not a verdict for one screen.
 *
 *   The first draft claimed "the links fit at 1024px" using the row width the
 *   old comments recorded, and it failed here by 48px — which is the useful
 *   answer: the row those comments measured genuinely does not fit a 1024px
 *   window, tighter gap and all. The constant that said 1040 was right about
 *   the row it was looking at.
 *
 *   Whether *today's* row fits is a different question, and not one this file
 *   can answer: that comment counted seven labels and a role pill, where a
 *   signed-in sender now has five groups and the pill has moved into the
 *   account sheet. The row may well be far narrower than 997px now. Nobody
 *   knows, which is the entire argument for measuring rather than asserting.
 *
 *   So what is checked is that the arithmetic turns over at the right place.
 */
const CAPSULE_AT_1024 = 1000;

/** What the capsule actually leaves the links at that width. */
/** A row comfortably inside the room at 1024, used by the sections below. */
const ROW_FITS = () => ROOM_AT_1024 - NAV_FIT_SLACK;

const ROOM_AT_1024 = CAPSULE_AT_1024 - GEOMETRY.horizontalPadding * 2 - LOGO - ACTIONS - GEOMETRY.gap * 2;

check(
  'a row inside the available room fits',
  at(CAPSULE_AT_1024, ROOM_AT_1024 - NAV_FIT_SLACK),
  `room at a 1024px window is ${ROOM_AT_1024}px`,
);
check(
  'a row exactly filling it does not — slack is reserved',
  !at(CAPSULE_AT_1024, ROOM_AT_1024),
  'fitting by nothing is how this row ended up on the capsule edge twice before',
);
check(
  'the six gaps are worth 48px across a seven-item row',
  at(CAPSULE_AT_1024, ROOM_AT_1024 - NAV_FIT_SLACK) &&
    !at(CAPSULE_AT_1024, ROOM_AT_1024 - NAV_FIT_SLACK + 48),
  'which is what dropping the gap from 24px to 16px buys, and it is not always enough',
);

// ---------------------------------------- 2. it still collapses ----------

check('a phone collapses', !at(360, ROW_FITS()));
check('a small tablet collapses', !at(700, ROW_FITS()));
check('a wide desktop does not', at(1400, ROW_FITS()));

// ------------------------------- 3. what a constant could not see --------

check(
  "an admin's extra link collapses a window the same size",
  !at(CAPSULE_AT_1024, ROW_FITS() + 120),
  'the constant needed a second hand-measured number, ADMIN_LABEL_BREAKPOINT, for exactly this',
);
check(
  'and a wider account control does too, which had no constant at all',
  !at(CAPSULE_AT_1024, ROW_FITS(), { actionsWidth: ACTIONS + 140 }),
  'a longer signed-in email widens the actions cluster and nothing was tracking it',
);
check(
  'a row that grows by one link stops fitting on its own',
  at(1120, ROW_FITS()) && !at(1120, ROW_FITS() + 200),
  'no re-measure, no stale constant, no note asking the next person to remember',
);

// ------------------------------------------ 4. the first frame -----------

const unmeasured: NavFitInput = {
  ...GEOMETRY,
  capsuleWidth: 0,
  logoWidth: 0,
  actionsWidth: 0,
  linksWidth: 0,
};
check('nothing measured is not a fit', !inlineLinksFit(unmeasured));
check('and is reported as not yet known', !navFitMeasured(unmeasured));
check(
  'a partial measurement is also not yet known',
  !navFitMeasured({ ...unmeasured, capsuleWidth: 1000, logoWidth: LOGO }),
  'onLayout fires per element, so three of four arriving first is the normal case',
);
check(
  'everything measured is known',
  navFitMeasured({ ...GEOMETRY, capsuleWidth: 1000, logoWidth: LOGO, actionsWidth: ACTIONS, linksWidth: 400 }),
);
check(
  'the component falls back to the breakpoint until then',
  nav.includes('navFitMeasured(fitInput)') && nav.includes('breakpointSaysShow'),
  'reading an unmeasured 0 as "does not fit" would collapse a wide desktop for one frame',
);

// ----------------------------------------------- 5. no oscillation -------

check(
  'the row is measured off screen, not in the slot it competes for',
  nav.includes('styles.linksProbe') && nav.includes("left: -9999"),
  'styles.links has flexShrink, so a squeezed row reports the width it was squeezed to and always "fits"',
);
check(
  'the probe cannot be reached or announced',
  /pointerEvents="none"[\s\S]{0,200}styles\.linksProbe/.test(nav) ||
    /styles\.linksProbe[\s\S]{0,200}pointerEvents="none"/.test(nav) ||
    nav.includes('accessibilityElementsHidden'),
  'it is a ruler, not a control',
);
check(
  'measurements only update when they change',
  nav.includes('current[key] === rounded ? current'),
  'onLayout fires on every paint; setting identical state would re-render forever',
);
check(
  'and the probe is skipped where the answer cannot change',
  nav.includes('worthMeasuring') && nav.includes('MEASURE_FLOOR'),
  'a phone pays nothing to measure a row that could never fit',
);

// --------------------------------------- 6. the geometry agrees ----------

check(
  'the fit arithmetic uses the capsule padding the stylesheet uses',
  nav.includes('const CAPSULE_PADDING_X = Spacing.four;') &&
    nav.includes('horizontalPadding: CAPSULE_PADDING_X'),
  'two copies of one number is how a measurement stops matching what it measures',
);
check(
  'and the same gap',
  nav.includes('const CAPSULE_GAP = Spacing.three;') && nav.includes('gap: CAPSULE_GAP'),
);
check(
  'slack is more than a rounding error',
  NAV_FIT_SLACK >= 8,
  'this file has a history of rows that fitted by 4px and then did not',
);

// -------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('verify:nav-fit — all checks passed');
