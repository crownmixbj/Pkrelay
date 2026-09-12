/**
 * Assertions for what a link to this site looks like before anyone opens it.
 *
 * The tab title, the sentence a search result shows, and the card WhatsApp,
 * Slack, LinkedIn and X draw when somebody pastes the URL. All of it is
 * invisible from inside the app: the page works perfectly with an empty title
 * and no `og:image`, and the only way to notice is to share a link and see the
 * default Expo icon — or nothing at all — where the brand should be.
 *
 * Two failures this pins in particular:
 *
 *   The duplicate title. `expo-router/head` injects at the top of the head, so
 *   a `<title>` declared in `+html.tsx` as well is the second one and loses.
 *   Whichever a scraper reads, one of the two is dead code nobody can see.
 *
 *   The wrong-sized card. `og:image:width`/`height` are what a scraper lays the
 *   card out with before the image downloads. If they disagree with the actual
 *   pixels the card jumps, and on a few clients it never repaints.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  OG_IMAGE,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TITLE,
  absoluteUrlFrom,
  resolveSiteUrl,
} from '../src/constants/site';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/**
 * Width, height and byte count straight out of the file.
 *
 * Read as `latin1` because one character is then exactly one byte, which is
 * what lets `charCodeAt` walk a PNG's IHDR chunk — the width and height are the
 * two big-endian 32-bit numbers at offsets 16 and 20. A missing file throws
 * here, which is the assertion "the image is where the tags say it is".
 */
const PNG_SIGNATURE = '137,80,78,71,13,10,26,10';

/** The file's first eight bytes, as the numbers a PNG has to start with. */
function isPng(path: string): boolean {
  const head = readFileSync(join(ROOT, path), 'latin1').slice(0, 8);
  return [...head].map((c) => c.charCodeAt(0)).join(',') === PNG_SIGNATURE;
}

/**
 * Whether the PNG carries an alpha channel.
 *
 * Byte 25 is IHDR's colour type: 4 is greyscale+alpha and 6 is RGBA; 0, 2 and 3
 * have no alpha of their own. It settles two opposite requirements — the
 * Android foreground must be transparent, the iOS icon must not be.
 */
function hasAlpha(path: string): boolean {
  const colourType = readFileSync(join(ROOT, path), 'latin1').charCodeAt(25);
  return colourType === 4 || colourType === 6;
}

function pngFile(path: string): { width: number; height: number; bytes: number } {
  const data = readFileSync(join(ROOT, path), 'latin1');

  if (!isPng(path)) {
    throw new Error(`${path} is not a PNG`);
  }

  const uint32 = (offset: number) =>
    [0, 1, 2, 3].reduce((total, i) => total * 256 + data.charCodeAt(offset + i), 0);

  return { width: uint32(16), height: uint32(20), bytes: data.length };
}

// ------------------------------------------------------------- the copy ----

check('the title names the brand', SITE_TITLE.includes(SITE_NAME));
check(
  'and is short enough to survive a search result',
  SITE_TITLE.length <= 70,
  `${SITE_TITLE.length} characters — Google truncates around 60-70`,
);
check(
  'the description fits too',
  SITE_DESCRIPTION.length > 0 && SITE_DESCRIPTION.length <= 165,
  `${SITE_DESCRIPTION.length} characters — the cut is around 160`,
);

/*
 * The Terms say this service is uninsured, unreviewed and unrefundable — see
 * verify-about. A share card is the one piece of copy that travels without the
 * page attached, so a promise made here is the hardest one to walk back.
 */
check(
  'and promises nothing the Terms deny',
  !/\b(insured|insurance|guarantee[ds]?|refund(?:able|ed)?|vetted)\b/i.test(SITE_DESCRIPTION),
  SITE_DESCRIPTION,
);

// ------------------------------------------------------------ the origin ---

check('a bare host gains a protocol', resolveSiteUrl('staging.pkrelay.com') === 'https://staging.pkrelay.com');
check(
  'a full origin is left alone',
  resolveSiteUrl('https://staging.pkrelay.com') === 'https://staging.pkrelay.com',
);
check(
  'a trailing slash is trimmed',
  resolveSiteUrl('https://pkrelay.com/') === 'https://pkrelay.com',
  'it is joined to paths that already start with one, and //og-image.png is a different URL',
);
check('an unset variable resolves to nothing', resolveSiteUrl(undefined) === '');
check(
  'a configured origin makes the image URL absolute',
  absoluteUrlFrom('https://staging.pkrelay.com', OG_IMAGE.path) ===
    'https://staging.pkrelay.com/og-image.png',
  'WhatsApp and Facebook drop a relative og:image rather than resolving it',
);
check(
  'and an unset one falls back to the rooted path rather than a broken absolute',
  absoluteUrlFrom('', OG_IMAGE.path) === '/og-image.png',
);

// ------------------------------------------------------------ the assets ---

/*
 * Read by the path the tags use rather than a hard-coded one: `public/` is
 * copied to the root of `dist`, so `OG_IMAGE.path` is both the URL and the
 * file. A tag pointing at an image nobody exported is the whole failure.
 */
const og = pngFile(`public${OG_IMAGE.path}`);

check(
  'and is exactly the size the tags declare',
  og.width === OG_IMAGE.width && og.height === OG_IMAGE.height,
  `${og.width}×${og.height} on disk vs ${OG_IMAGE.width}×${OG_IMAGE.height} declared`,
);
check(
  'which is the 1.91:1 ratio every scraper crops to',
  Math.abs(og.width / og.height - 1.91) < 0.02,
  `${(og.width / og.height).toFixed(2)}:1`,
);

const touch = pngFile('public/apple-touch-icon.png');
check(
  'the apple-touch-icon is 180×180',
  touch.width === 180 && touch.height === 180,
  `${touch.width}×${touch.height} — iOS scales anything else and softens it`,
);

/*
 * Read from the config rather than named here.
 *
 * Expo generates `/favicon.ico` from whatever `expo.web.favicon` points at, so
 * the only file worth asserting on is the one that setting names — otherwise
 * this passes happily while the build uses something else entirely.
 */
const appConfig = JSON.parse(read('app.json')) as {
  expo: {
    icon: string;
    web: { favicon: string };
    android: { adaptiveIcon: { foregroundImage: string } };
  };
};

const faviconPath = appConfig.expo.web.favicon.replace(/^\.\//, '');
const favicon = pngFile(faviconPath);

check(
  'the favicon source is square and large enough to generate an .ico from',
  favicon.width === favicon.height && favicon.width >= 48,
  `${faviconPath} is ${favicon.width}×${favicon.height}`,
);
/*
 * The Expo template's favicon is a 1129-byte 48×48 file. Shipping it is the
 * default this whole change exists to remove, and it is the one regression
 * that would look completely normal in the repo.
 */
check(
  'and is not the one the Expo template shipped',
  favicon.bytes > 5_000,
  'the template default is ~1KB at 48×48; a real mark is not',
);

/*
 * ⚠ A JPEG saved as `.png` is the failure this catches.
 *
 *   Every image exporter will hand you one, Finder and Preview open it without
 *   a murmur, and nothing complains until an EAS build rejects the icon or the
 *   web build emits a favicon.ico made of nothing. It has happened here once
 *   already: the PR icon arrived as a JPEG named icon.png.
 */
for (const [label, configured] of [
  ['the app icon', appConfig.expo.icon],
  ['the adaptive foreground', appConfig.expo.android.adaptiveIcon.foregroundImage],
  ['the favicon source', appConfig.expo.web.favicon],
] as const) {
  const path = configured.replace(/^\.\//, '');
  check(
    `${label} is a real PNG, not a renamed JPEG`,
    isPng(path),
    `${path} does not start with the PNG signature`,
  );
}

/*
 * One mark, three files, and the two derived ones do jobs the master cannot.
 *
 *   `icon.png`                    the artwork as drawn — the tile, with its margin
 *   `favicon.png`                 that tile cropped to the mark, because a 16px
 *                                 browser tab otherwise spends two thirds of
 *                                 itself on the margin
 *   `android-icon-foreground.png` the mark alone on transparency, scaled inside
 *                                 the 66% safe zone, so the launcher's own mask
 *                                 and `backgroundColor` do the shaping
 *
 * ⚠ Regenerate all three together. A rebrand that updates only `icon.png` ships
 *   the new mark to iOS and the old one to the launcher and the browser tab,
 *   and nothing in the build says a word about it.
 *
 * The two checks below are the halves a build actually rejects: opposite
 * requirements, one file each.
 */
check(
  'the adaptive foreground is transparent',
  hasAlpha(appConfig.expo.android.adaptiveIcon.foregroundImage.replace(/^\.\//, '')),
  'an opaque foreground hides backgroundColor and puts the launcher mask through the artwork',
);
check(
  'and the app icon is not',
  !hasAlpha(appConfig.expo.icon.replace(/^\.\//, '')),
  'App Store Connect rejects an icon with an alpha channel',
);

// -------------------------------------------------------------- the head ---

const html = read('src/app/+html.tsx');
const layout = read('src/app/_layout.tsx');

/**
 * Comments stripped before searching.
 *
 * `+html.tsx` explains the duplicate-title rule in prose, so a naive search for
 * `<title` finds the explanation and reports it as the thing being warned
 * about — the same trap verify-about documents for `overflow: 'hidden'`.
 */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check(
  'the shell keeps the viewport meta Expo used to supply',
  html.includes('name="viewport"') && html.includes('width=device-width'),
  'without it a phone renders the page at 980px and scales it down',
);
check(
  'and the scroll reset',
  html.includes('<ScrollViewStyleReset />'),
  'without it a root ScrollView grows the document instead of scrolling inside it',
);

for (const tag of [
  'og:title',
  'og:description',
  'og:image',
  'og:image:width',
  'og:image:height',
  'og:url',
  'og:site_name',
  'twitter:card',
  'twitter:image',
]) {
  check(`the shell declares ${tag}`, html.includes(`"${tag}"`));
}

check(
  'the card is the large one',
  html.includes('content="summary_large_image"'),
  'the alternative is a thumbnail the size of a postage stamp',
);
check(
  'the icons are linked',
  html.includes('rel="icon"') && html.includes('rel="apple-touch-icon"'),
);
check(
  'the share tags read the same constants as the title',
  html.includes("from '@/constants/site'") && layout.includes("from '@/constants/site'"),
  'two copies of the brand sentence is one copy that goes stale',
);

/*
 * The duplicate-title rule, asserted from both ends.
 */
check(
  'the shell declares no title of its own',
  !/<title/.test(withoutComments(html)),
  'expo-router/head injects at the top of the head, so this one would be the loser of the pair',
);
check(
  'the root layout is the one that sets it',
  layout.includes("from 'expo-router/head'") && layout.includes('<title>{SITE_TITLE}</title>'),
  'without a Head anywhere, helmet renders an empty <title> and the tab says the URL',
);
check(
  'and the description with it',
  layout.includes('content={SITE_DESCRIPTION}'),
  'the meta description is the sentence under a search result',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — the title and description are short enough to survive a search result and promise\n' +
    '       nothing the Terms deny, the origin resolves with or without a protocol, the share\n' +
    '       image is on disk at exactly the size its tags declare, every icon the config names\n' +
    '       is a real PNG with the alpha channel its platform demands, and exactly one <title>\n' +
    '       is rendered.',
);
