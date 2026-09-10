/**
 * How a QR code on a desktop reaches the app on a phone.
 *
 * Two mechanisms, and the difference decides whether the standard cross-device
 * flow actually works:
 *
 *   custom scheme    `parcelmobile://capture/<id>`. Works when the app is
 *                    installed *and* the link is opened from somewhere that
 *                    honours arbitrary schemes. A phone's stock camera app
 *                    generally does not — it surfaces http(s) URLs and stays
 *                    silent on anything else. With no app installed it fails
 *                    with no message at all.
 *
 *   universal link   `https://<domain>/capture/<id>`. The stock camera offers
 *                    it because it is an ordinary web URL; the OS routes it to
 *                    the app when installed, and to the website when not. This
 *                    is what every cross-device identity flow uses, and it is
 *                    the only one where "point your phone camera at this" is a
 *                    true instruction.
 *
 * The domain is configuration, not a constant, because it does not exist until
 * someone owns it and hosts two association files at its root — see
 * `docs/DEEP-LINKS.md`. Until then the scheme is used and the UI says so
 * instead of promising the camera will work.
 */

/**
 * Set `EXPO_PUBLIC_LINK_DOMAIN` to the bare host, e.g. `pkrelay.ng`.
 *
 * No protocol and no trailing slash: it is interpolated into both a URL and an
 * `applinks:` entry, and those want different shapes around the same host.
 */
const configured = (process.env.EXPO_PUBLIC_LINK_DOMAIN ?? '').trim();

/** Stripped of anything that would break either use. Empty when unset. */
export const LINK_DOMAIN = configured
  .replace(/^https?:\/\//i, '')
  .replace(/\/+$/, '')
  .toLowerCase();

/** The app's private scheme. Must match `scheme` in app.json. */
export const APP_SCHEME = 'parcelmobile';

/**
 * True when links can be https. Everything user-facing branches on this rather
 * than on the domain string, so the two cannot drift.
 */
export const universalLinksEnabled = LINK_DOMAIN.length > 0;

/** Where a capture QR points. */
export function captureLink(sessionId: string): string {
  return universalLinksEnabled
    ? `https://${LINK_DOMAIN}/capture/${sessionId}`
    : `${APP_SCHEME}://capture/${sessionId}`;
}

/**
 * What to tell someone looking at the code.
 *
 * Returned from here rather than written into the component so the instruction
 * cannot outlive the mechanism it describes. The scheme wording is deliberately
 * clumsier — because that route genuinely is clumsier, and pretending otherwise
 * leaves people pointing a camera at a code that does nothing.
 */
export function captureInstruction(): { title: string; body: string } {
  return universalLinksEnabled
    ? {
        title: 'Scan with your phone',
        body: 'Point your phone camera at the code and tap the link. Package Relay opens on the photo screen — or the web page, if you have not installed it yet.',
      }
    : {
        title: 'Scan from inside the Package Relay app',
        body: 'Open Package Relay on your phone and scan this code from there. Your phone’s ordinary camera app will not open it — that needs a web address, which is not set up yet.',
      };
}

/**
 * Where a confirmation email should send somebody back to.
 *
 * ⚠ The address rides along as a query parameter, and the landing page needs it.
 *
 *   Supabase puts nothing identifying on an *error* redirect — an expired link
 *   arrives as `?error=access_denied&error_code=otp_expired` and nothing else.
 *   With no email there is nobody to offer a fresh link to, and no way to
 *   notice that the session already open belongs to a different person. Both of
 *   those branches exist only because this parameter does.
 *
 * ⚠ Whatever this returns has to be in the project's Redirect URLs allowlist,
 *   under Authentication → URL Configuration. Supabase silently falls back to
 *   the Site URL for anything not on the list, which looks exactly like this
 *   code not working. See README.
 *
 * On the web the current origin is used rather than `LINK_DOMAIN`, so a preview
 * deploy confirms back into itself instead of bouncing people to production.
 */
export function emailConfirmationLink(email: string): string {
  const address = `email=${encodeURIComponent(email.trim().toLowerCase())}`;

  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/confirm?${address}`;
  }

  return universalLinksEnabled
    ? `https://${LINK_DOMAIN}/confirm?${address}`
    : `${APP_SCHEME}://confirm?${address}`;
}

/**
 * Where Google should send somebody back to after they approve.
 *
 * ⚠ Whatever this returns has to be in the project's Redirect URLs allowlist,
 *   exactly like `emailConfirmationLink`. Supabase silently falls back to the
 *   Site URL for anything not on the list, which looks precisely like OAuth
 *   being broken and sends the next hour into the client code.
 *
 * ⚠ No email rides along, and none is needed.
 *
 *   The confirmation link carries one because Supabase puts nothing
 *   identifying on an expired-link error. An OAuth return either carries a
 *   session or an error the provider named, and in both cases the app already
 *   knows who it asked about.
 *
 * On the web the current origin is used rather than `LINK_DOMAIN`, so a preview
 * deploy signs back into itself instead of dropping people on production.
 */
export function oauthRedirectLink(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/sign-in`;
  }

  /*
   * ⚠ Native comes back through the scheme even when universal links are on.
   *
   *   A universal link would be caught by the *browser* that is showing
   *   Google's consent screen, not by the app that opened it — so the person
   *   ends up on a web page inside a modal browser with a session the app
   *   never sees. The custom scheme is what closes that browser and hands the
   *   tokens back.
   */
  return `${APP_SCHEME}://sign-in`;
}
