/**
 * Contrast assertions computed from the palette itself.
 *
 * ⚠ Every other colour decision in this codebase is recorded as a ratio in a
 *   comment, and a comment cannot be wrong at build time.
 *
 *   `primary` carried the note "#0077B6 (4.87:1)" for months. That was true,
 *   and it was a measurement against white. The page ground was `PageCanvas`,
 *   a flat cyan, on which the same blue is **4.37:1** — under AA for every nav
 *   link, price and inline action drawn in it. Nothing caught it because
 *   nothing computed it; the comment said a number and the number was about a
 *   surface the text never touched.
 *
 *   So this file computes. It imports the real tokens, pairs every text role
 *   with every surface it can legally land on, and fails on anything under the
 *   floor. A palette change that breaks a pair now breaks the build instead of
 *   shipping.
 */
import { Bands, Colors, HeroSurface, PageCanvas, ServiceTones } from '../src/constants/theme';
import { FORCED_SCHEME } from '../src/hooks/use-theme';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

/** WCAG 2.1 relative luminance, from the sRGB spec rather than an approximation. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (pair: string) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(value.slice(0, 2)) +
    0.7152 * channel(value.slice(2, 4)) +
    0.0722 * channel(value.slice(4, 6))
  );
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const AA = 4.5;
/** WCAG 1.4.11: icons, borders and other non-text indicators. */
const NON_TEXT = 3;

const round = (n: number) => Math.round(n * 100) / 100;

/*
 * ⚠ A renamed or deleted token should fail the suite, not crash it.
 *
 *   Removing `Bands.coolStrong` left it in this file's ground list as
 *   `undefined`, and the first thing the script did was throw a TypeError
 *   inside `luminance` — ten lines of stack and no indication that the problem
 *   was a token name. A check that explodes is a check nobody trusts.
 */
const HEX = /^#[0-9A-Fa-f]{6}$/;

function pair(name: string, fg: string, bg: string, floor = AA) {
  if (!HEX.test(fg ?? '') || !HEX.test(bg ?? '')) {
    check(name, false, `not a colour: ${String(fg)} on ${String(bg)} — a token was renamed or removed`);
    return 0;
  }

  const ratio = contrast(fg, bg);
  check(
    `${name} — ${fg} on ${bg}`,
    ratio >= floor,
    `measured ${round(ratio)}:1, floor ${floor}:1`,
  );
  return ratio;
}

/*
 * ⚠ Light only, and stated rather than assumed.
 *
 *   `useTheme` pins the app to the light palette, so the dark tokens are
 *   defined but unreachable. Asserting them would be asserting a surface
 *   nobody sees; asserting the light ones while quietly hoping the app is
 *   light is worse. This reads the pin.
 */
check(
  'the app is pinned to one scheme',
  FORCED_SCHEME === 'light',
  'if the app ever follows the device, every pair below has to be computed twice',
);

const t = Colors.light;

// -------------------------------------------- text on every legal ground ---

/*
 * The grid that was missing. A text role is only safe on a surface somebody
 * has actually measured it against, and "white" is not the only surface.
 */
const GROUNDS: Record<string, string> = {
  PageCanvas,
  surface: t.surface,
  surfaceMuted: t.surfaceMuted,
  backgroundElement: t.backgroundElement,
  'Bands.cool': Bands.cool,
  HeroSurface,
};

const TEXT_ROLES: Record<string, string> = {
  text: t.text,
  textSecondary: t.textSecondary,
  textMuted: t.textMuted,
  primary: t.primary,
};

for (const [groundName, ground] of Object.entries(GROUNDS)) {
  for (const [roleName, role] of Object.entries(TEXT_ROLES)) {
    pair(`${roleName} on ${groundName}`, role, ground);
  }
}

// ------------------------------------------------- labels on brand fills ---

pair('primaryText on primary', t.primaryText, t.primary);
pair('primaryText on primaryPressed', t.primaryText, t.primaryPressed);
pair('ink on primarySoft', t.text, t.primarySoft);
pair('primaryOnSoft on primarySoft', t.primaryOnSoft, t.primarySoft);

/*
 * ⚠ `primaryAccent` is the one brand colour with no contrast floor, because it
 *   is the one with no text on it.
 *
 *   It exists for tints, glows and decoration. Asserted as the thing it must
 *   NOT be: good enough to tempt someone into using it as a label.
 */
check(
  'primaryAccent is decorative, and demonstrably so',
  contrast(t.primaryText, t.primaryAccent) < AA,
  'if this ever clears AA, delete the token and use primary — two interchangeable blues is not a palette',
);

/*
 * And the gradient trap, stated as an assertion rather than a comment: the
 * accessible gradient is primary → primaryPressed, and its *lightest* point is
 * what decides.
 */
pair('a primary→pressed gradient at its lightest point', t.primaryText, t.primary);

// ------------------------------------------------------ the status tones ---

for (const tone of ['primary', 'success', 'warning', 'danger', 'neutral'] as const) {
  const soft = t[`${tone}Soft`];
  const onSoft = t[`${tone}OnSoft`];
  pair(`${tone}OnSoft on ${tone}Soft`, onSoft, soft);
  /* A tinted pill has to be distinguishable from the card it sits on. */
  pair(`${tone}Soft against surface`, soft, t.surface, 1.03);
}

pair('ink on warning', t.text, t.warning);
pair('white on danger', t.primaryText, t.danger);

/*
 * ⚠ `success` is the documented exception, and it is an old one.
 *
 *   White on #16A34A is 3.30:1. It clears the non-text floor and not the text
 *   one, which is correct for what it is used as — a dot, a tick, a progress
 *   fill — and would be wrong the day somebody puts a white label on it. The
 *   pairing that carries words is `successOnSoft` on `successSoft`, asserted
 *   above at 4.57:1.
 */
pair('success as a non-text indicator', t.success, t.surface, NON_TEXT);

// ------------------------------------------------- the service card tones --

for (const [name, tone] of Object.entries(ServiceTones)) {
  pair(`ServiceTones.${name} text on its own fill`, tone.text, tone.backgroundFrom);
  pair(`ServiceTones.${name} text on its fade`, tone.text, tone.backgroundTo);
  pair(`ServiceTones.${name} onAccent on accent`, tone.onAccent, tone.accent);
  /* The card sits on the page ground, so its fill has to be visible there. */
  pair(`ServiceTones.${name} reads apart from the ground`, tone.backgroundFrom, PageCanvas, 1.02);
}

// ------------------------------------------- the ground is a ground -------

/*
 * ⚠ The whole point of the repaint, asserted so it cannot quietly come back.
 *
 *   A tinted page is why the brand blue failed: there was no neutral for it to
 *   be coloured against. `PageCanvas` must stay near-neutral, which here means
 *   its channels sit within a few points of each other — a cyan #E0F7FA spans
 *   26.
 */
const channels = PageCanvas.replace('#', '').match(/../g)!.map((h) => parseInt(h, 16));
check(
  'the page ground is near-neutral',
  Math.max(...channels) - Math.min(...channels) <= 8,
  `${PageCanvas} spans ${Math.max(...channels) - Math.min(...channels)} between its channels — ` +
    'a saturated ground leaves colour nothing to stand out from, and pushes brand text under AA',
);
check(
  'and the hero wash is painted in exactly it',
  PageCanvas === t.background,
  'the wash over the hero photograph is Colors.light.background; a second literal here drifts into a grey veil',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — every text role clears AA on every surface it can land on, every tone pair\n' +
    '       clears it on its own tint, the brand fills carry their labels, the decorative\n' +
    "       accent is provably not a text colour, and the page ground is neutral enough\n" +
    '       for the brand to be a colour against it.',
);
