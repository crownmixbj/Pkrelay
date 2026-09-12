/**
 * What the web says about itself.
 *
 * The title in the browser tab, the sentence a search result shows, and the
 * card that appears when somebody drops a link into WhatsApp, Slack or X. They
 * live here rather than in `+html.tsx` for the same reason the contact details
 * do: they are brand copy, they will be edited by someone reading the brand
 * rather than the markup, and every place that needs them should read the same
 * string.
 */

export const SITE_NAME = 'Package Relay';

/** The tab title and the headline of every link preview. */
export const SITE_TITLE = 'Package Relay — Parcel delivery across Nigeria';

/**
 * The sentence under it. Kept under ~160 characters because that is where
 * Google truncates, and deliberately free of claims the Terms do not back —
 * "insured" is not one of them. See `src/constants/legal.ts`.
 */
export const SITE_DESCRIPTION =
  'Send a parcel with a driver already making that journey. Local and inter-state delivery ' +
  'across Nigeria — post it, track it, collect it.';

/**
 * The preview image, and the two numbers that go with it.
 *
 * 1200×630 is the ratio Facebook, WhatsApp, LinkedIn, Slack and X all crop to;
 * a square app icon posted as-is gets letterboxed or centre-cropped by each of
 * them differently. Declaring the dimensions lets a scraper lay out the card
 * before it has finished downloading the image, which is the difference between
 * a card that appears instantly and one that pops in.
 *
 * It lives in `public/`, which Expo copies to the root of `dist/` — so the path
 * below is also its URL.
 */
export const OG_IMAGE = {
  path: '/og-image.png',
  width: 1200,
  height: 630,
  alt: 'Package Relay — parcel delivery across Nigeria',
} as const;

/**
 * Where this deployment lives, e.g. `https://staging.pkrelay.com`.
 *
 * ⚠ Set it per environment, not in the repo. Cloudflare Pages keeps separate
 *   Production and Preview values (Settings → Environment variables), and the
 *   whole point of the variable is that staging says staging. A single
 *   hard-coded origin would have the staging build advertising production's
 *   images to every scraper that touched it.
 *
 * Accepts a bare host or a full origin; a trailing slash is trimmed either way,
 * because it is joined to paths that already begin with one.
 */
const configured = process.env.EXPO_PUBLIC_SITE_URL;

/**
 * Normalised to a bare origin: protocol added when missing, trailing slash
 * removed, whitespace trimmed. Exported as a pure function so the verify
 * script can put values through it without needing an environment.
 */
export function resolveSiteUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';

  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, '');
}

export const SITE_URL = resolveSiteUrl(configured);

export const siteUrlConfigured = SITE_URL.length > 0;

/**
 * A URL a scraper can actually fetch.
 *
 * ⚠ `og:image` and `og:url` are the two tags that genuinely need an absolute
 *   URL — a relative one is resolved by some scrapers and silently dropped by
 *   others, which is the failure where the link preview works in Slack and
 *   shows a blank card on WhatsApp.
 *
 * With no origin this returns the rooted path, so a local build still renders
 * and the tags are merely ignored rather than pointing somewhere wrong.
 */
export function absoluteUrlFrom(origin: string, path: string): string {
  const rooted = path.startsWith('/') ? path : `/${path}`;
  return origin ? `${origin}${rooted}` : rooted;
}

export function absoluteUrl(path: string): string {
  return absoluteUrlFrom(SITE_URL, path);
}
