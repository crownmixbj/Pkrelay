/**
 * Assertions for the call-to-action button in every email.
 *
 * ⚠ These render the real template and read the HTML it produces. None of it
 *   is a regex over the source.
 *
 *   The failures this guards against do not raise anywhere. A button whose
 *   anchor is inline rather than block is a coloured box where only the words
 *   are tappable. A message with no viewport is laid out at desktop width by
 *   the Gmail app's webview and scaled down, so a 50px button lands at roughly
 *   28px of real screen — under a thumb's reliable target, while looking
 *   perfectly fine in every desktop preview anyone tests in.
 *
 *   Both report identically: "the link does not work on my phone".
 */
import { render } from '../supabase/functions/notify-events/templates.ts';

let failures = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const APP = 'https://app.pkrelay.com';
const context = { appUrl: APP, supportEmail: 'support@pkrelay.ng' };

const rendered = render(
  'delivery_completed',
  {
    tracking_id: 'PKR-4821',
    delivered_at: '2026-09-20T10:00:00Z',
    recipient_name: 'Ada',
    driver_name: 'Tunde',
    fare: 4500,
    has_proof: true,
  },
  context,
);

check('the template renders at all', rendered !== null);
const html = rendered?.html ?? '';

// --------------------------------------------- 1. the link is real -------

const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
check('the email contains links', hrefs.length > 0);
check(
  'every link is absolute, with a scheme',
  hrefs.every((href) => /^https:\/\//.test(href)),
  `found: ${hrefs.join(' | ')}`,
);
check(
  'and points at the parcel by its tracking id',
  hrefs.some((href) => href === `${APP}/parcel/PKR-4821`),
  `found: ${hrefs.join(' | ')}`,
);
check(
  'no link is left relative or scheme-less',
  !/href="(?!https:\/\/|mailto:)/.test(html),
  'a mail client has no page to resolve a relative URL against',
);

// ------------------------------------------ 2. the whole box is the link --

const anchor = html.match(/<a class="pkr-button"[^>]*>/)?.[0] ?? '';
check('the button anchor is present', anchor !== '');
check(
  'it is display:block, so the padded area belongs to the link',
  /display:block/.test(anchor),
  'inline means only the text is tappable and the coloured edges do nothing',
);
check(
  'its style attribute is a single line',
  !/[\r\n]/.test(anchor),
  "Gmail's sanitiser is the documented weak point here; a wrapped attribute value is a risk with no upside",
);
check('it opens in a new context', /target="_blank"/.test(anchor));
check('and does not hand the opener away', /rel="noopener noreferrer"/.test(anchor));

// ----------------------------------------------- 3. a thumb can hit it ----

const padding = Number(anchor.match(/padding:(\d+)px/)?.[1] ?? 0);
const lineHeight = Number(anchor.match(/line-height:(\d+)px/)?.[1] ?? 0);
const tapHeight = padding * 2 + lineHeight;
check(
  `the button is at least 44px tall (measured ${tapHeight}px)`,
  tapHeight >= 44,
  'Apple 44pt / Android 48dp — below that a tap misses often enough to read as broken',
);
check(
  'the font is 16px or more, so no client zooms to compensate',
  Number(anchor.match(/font-size:(\d+)px/)?.[1] ?? 0) >= 16,
);

// ------------------------------------------ 4. the webview is told to stop --

check(
  'the document declares a viewport',
  /<meta name="viewport" content="width=device-width/.test(html),
  'without it the Gmail app renders at desktop width and scales the whole message down, shrinking the button with it',
);
check('and a charset, for the naira sign and the arrows', /<meta charset="utf-8"/.test(html));
check(
  'iOS Mail is told not to reformat',
  /x-apple-disable-message-reformatting/.test(html),
);
check(
  'text is not auto-scaled either',
  /text-size-adjust:100%/.test(html),
);

// ------------------------------------------------ 5. the fallback survives --

check(
  'the full address is printed underneath the button',
  html.includes('Or paste this into your browser'),
  'some clients strip anchors outright; the typed URL is what always works',
);
check(
  'the plain-text part carries the link too',
  (rendered?.text ?? '').includes(`${APP}/parcel/PKR-4821`),
  'a data-saving client may never show the HTML part at all',
);

// --------------------------------- 6. a missing app URL degrades honestly --

const noUrl = render(
  'delivery_completed',
  { tracking_id: 'PKR-4821', delivered_at: '2026-09-20T10:00:00Z', fare: 4500 },
  { appUrl: null, supportEmail: null },
);
check('an email with no app URL still renders', noUrl !== null);
check(
  'and simply has no button rather than a dead one',
  !/<a class="pkr-button"/.test(noUrl?.html ?? ''),
  'href="" is a button that silently fails; no button at least leaves the text',
);

const mangled = render(
  'delivery_completed',
  { tracking_id: 'PKR-4821', delivered_at: '2026-09-20T10:00:00Z', fare: 4500 },
  { appUrl: '.https://app.pkrelay.com', supportEmail: null },
);
check(
  'a mangled app URL produces no button either',
  !/<a class="pkr-button"/.test(mangled?.html ?? ''),
  'the stray leading dot that shipped a broken guarantor link — absoluteUrl refuses it',
);

// -------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('verify:email-buttons — all checks passed');
