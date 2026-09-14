/**
 * Which interface a given person gets, on a given device.
 *
 * Package Relay runs three:
 *
 *   web           the full dashboard — everything, including admin
 *   sender        the phone app for someone posting parcels
 *   driver        the phone app for an approved driver carrying them
 *
 * The whole rule lives in `resolveExperience` below, as a pure function of four
 * inputs. Not scattered across screens: a routing rule expressed as `Platform.OS
 * === 'web' && ...` in nine files is nine chances to write the eighth one
 * differently, and the difference is invisible until someone is looking at the
 * wrong app.
 *
 * ⚠ None of this is a security boundary. A native build is a file an attacker
 *   controls, and hiding a screen does not stop a request. Every gate that
 *   matters — claiming a job, reading an application, writing a hub — is a Row
 *   Level Security policy or a `security definer` function, and stays that way.
 *   This decides what is *shown*, which is a usability question.
 */

export const EXPERIENCES = ['web', 'sender', 'driver'] as const;

export type Experience = (typeof EXPERIENCES)[number];

export type ExperienceInput = {
  /** `Platform.OS`. Anything other than 'web' is a native build. */
  platform: string;
  /** Still restoring a stored session. Nothing is decided yet. */
  authLoading: boolean;
  isAuthenticated: boolean;
  /**
   * An approved driver application — the same server-checked fact that gates
   * claiming a job.
   *
   * Deliberately *not* the Sender/Driver toggle. That toggle is a view
   * preference anyone can flip, so routing on it would hand the driver
   * interface to any sender who tapped it once. They still could not claim
   * anything (RLS refuses), but they would be looking at a set of screens built
   * for a job they cannot do.
   */
  isApprovedDriver: boolean;
  /**
   * The toggle. It only matters for someone who is *both* — an approved driver
   * who also sends parcels — and it lets them choose which app they are in.
   */
  role: 'sender' | 'driver';
};

export function resolveExperience(input: ExperienceInput): Experience | null {
  /*
   * Null while the session is restoring, rather than guessing.
   *
   * Guessing 'sender' here would put an approved driver through a visible
   * flick from the sender home to the driver home on every cold start, which
   * reads as the app being unsure who they are.
   */
  if (input.authLoading) return null;

  // The desktop dashboard is the same for everyone; what it *contains* still
  // depends on the account, which is what the RLS policies decide.
  if (input.platform === 'web') return 'web';

  // Signed out on a phone: the sender app, which is the one that works without
  // an account — browse hubs, get a quote, start a booking.
  if (!input.isAuthenticated) return 'sender';

  if (input.isApprovedDriver && input.role === 'driver') return 'driver';

  return 'sender';
}

/**
 * Where each interface starts.
 *
 * A driver's home is the portal — the deliveries they are carrying — not the
 * marketing home screen, which has nothing on it for someone mid-shift.
 */
export const EXPERIENCE_HOME: Record<Experience, string> = {
  web: '/',
  /*
   * The booking form, not the marketing home.
   *
   * On a phone the app opens on the thing you opened it to do. The landing
   * page — hero, ticker, "Delivering with Excellence" — is a website's front
   * door, and it has no tab in the native bar because nobody navigates to it
   * once the app is installed.
   */
  sender: '/book',
  driver: '/driver',
};

/**
 * Which routes belong to which interface.
 *
 * `'*'` means every experience. Anything not listed is treated as shared, so
 * adding a screen does not silently make it unreachable — the failure mode of
 * an allowlist is a blank screen nobody can explain.
 */
const ROUTE_EXPERIENCES: { prefix: string; only: Experience[] }[] = [
  /*
   * The marketing home is web-only.
   *
   * Matching is exact here: the prefix rule below compares `pathname === '/'`
   * or `pathname.startsWith('//')`, so this catches the landing page and
   * nothing else. Without it a native cold start lands on the hero with no tab
   * selected, which reads as the app having failed to open properly.
   */
  { prefix: '/', only: ['web'] },

  /*
   * Driver-side screens. Hidden from the sender app because a sender cannot use
   * them, not because they are secret — /driver on a sender's phone shows an
   * empty portal and a prompt to apply, which is noise rather than help.
   */
  { prefix: '/driver', only: ['web', 'driver'] },
  { prefix: '/available-packages', only: ['web', 'driver'] },

  /*
   * The wallet needs its own line, and the reason is the matcher.
   *
   * `routeAllowed` matches `pathname === prefix || pathname.startsWith(prefix +
   * '/')` — segment-wise, deliberately, so that `/driver` does not swallow
   * `/driver-signup`. That is right for signup and updates, which a *sender*
   * should reach (applying to drive is how you stop being only a sender). It is
   * wrong here: without this line `/driver-wallet` falls through to the shared
   * default and a sender who has never driven gets a wallet.
   *
   * Not a security boundary — `driver_balance` returns their own rows, which
   * are none. It is that an empty wallet in the sender app is a screen offering
   * a payout for work the person cannot do.
   */
  { prefix: '/driver-wallet', only: ['web', 'driver'] },

  /*
   * Sending. An approved driver mid-shift is not booking a parcel, and the
   * booking form is the longest screen in the app — it has no place in the
   * driver interface. They can switch to Sender and get it back.
   */
  { prefix: '/book', only: ['web', 'sender'] },
  { prefix: '/my-packages', only: ['web', 'sender'] },
  { prefix: '/rate-calculator', only: ['web', 'sender'] },

  /*
   * Admin stays on every device.
   *
   * Restricting it to web would mean nobody could approve a driver or lift a
   * ban without a laptop. Platform is not a security boundary — `is_admin()`
   * is — so blocking it on a phone costs real operational time and buys
   * nothing.
   */
];

/** Whether `pathname` should be reachable in `experience`. */
export function routeAllowed(pathname: string, experience: Experience): boolean {
  const rule = ROUTE_EXPERIENCES.find(
    (entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`),
  );

  // Unlisted routes are shared. See the comment on ROUTE_EXPERIENCES.
  return rule ? rule.only.includes(experience) : true;
}

/**
 * Where to send someone who is on a route their interface does not have.
 *
 * Returns null when they are already somewhere valid, so a caller can treat a
 * non-null result as "navigate" without also having to ask "did anything
 * change?".
 */
export function redirectFor(pathname: string, experience: Experience | null): string | null {
  if (!experience) return null;
  if (routeAllowed(pathname, experience)) return null;
  return EXPERIENCE_HOME[experience];
}

// --------------------------------------- already signed in, still at the door --

/**
 * Routes that only mean something to somebody signed out.
 *
 * ⚠ The list is short on purpose, and the omissions are the interesting part.
 *
 *   `/verify-email` and `/confirm` belong to a person who *has* just signed up
 *   and often does have a session — bouncing them off either one strands a
 *   half-finished signup. `/forgot-password` stays open too: somebody signed in
 *   on this device who cannot remember their password still has to be able to
 *   ask for the email, and the reset link lands them back here.
 */
const SIGNED_OUT_ONLY = ['/sign-in', '/sign-up'];

export type SignedInRedirectInput = {
  pathname: string;
  isAuthenticated: boolean;
  /** From the session: an account with no phone number on file. */
  needsPhone: boolean;
  experience: Experience | null;
  /**
   * The `?next=` the auth gate set on its way here, if any.
   *
   * Honoured so that the two routes into the same place agree: somebody who
   * signs in on this screen is sent to `next` by the screen itself, and this
   * rule has to pick the same destination or whichever fires second wins and
   * the person lands somewhere they did not ask for.
   */
  next?: string | string[] | null;
};

/**
 * Where to send somebody who is already signed in and looking at the sign-in
 * form, or null when there is nothing to do.
 *
 * ⚠ The sign-in screen does not know it is being looked at by a signed-in
 *   person — it renders the same form either way, which is exactly the bug
 *   this fixes. The rule lives here rather than in the screen for the reason
 *   stated at the top of this file: a routing rule written into a screen is a
 *   routing rule the next screen gets slightly differently.
 *
 * ⚠ Nothing happens while `needsPhone` is true.
 *
 *   That account belongs to the completion gate, which deliberately leaves the
 *   auth routes reachable so somebody who signed in with the wrong Google
 *   account has a way back out. Redirecting them off `/sign-in` would take that
 *   exit away and leave them with one form and no door.
 */
export function signedInRedirect({
  pathname,
  isAuthenticated,
  needsPhone,
  experience,
  next,
}: SignedInRedirectInput): string | null {
  // Null experience means auth is still restoring: nobody is "already signed
  // in" yet, and deciding now would bounce a cold start off its own sign-in.
  if (!experience || !isAuthenticated || needsPhone) return null;

  if (!SIGNED_OUT_ONLY.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return null;
  }

  const home = EXPERIENCE_HOME[experience];
  const requested = internalPath(next);

  if (!requested) return home;
  // A `next` pointing back at the door would redirect to itself for ever.
  if (SIGNED_OUT_ONLY.some((route) => requested === route || requested.startsWith(`${route}/`))) {
    return home;
  }

  return routeAllowed(requested, experience) ? requested : home;
}

/**
 * `next` as a path inside this app, or null.
 *
 * ⚠ On the web this string reaches `router.replace`, and a URL is not a path.
 *
 *   `//evil.example` is protocol-relative and `/\evil.example` is treated the
 *   same way by browser URL parsers: both leave the site. A query parameter is
 *   attacker-supplied by definition — it arrives in a link somebody can send —
 *   so a single leading slash is the whole contract, and anything else falls
 *   back to the home route.
 */
function internalPath(next: string | string[] | null | undefined): string | null {
  // expo-router hands back an array when a parameter appears twice; a duplicated
  // `next` is not a request we can honour unambiguously.
  if (typeof next !== 'string') return null;

  const trimmed = next.trim();
  if (!trimmed.startsWith('/')) return null;
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return null;

  return trimmed;
}

// ------------------------------------------- an account with no phone number --

/** The one-field screen a Google account lands on before anything else. */
export const COMPLETE_PROFILE_ROUTE = '/complete-profile';

/**
 * Routes somebody without a phone number may still be on.
 *
 * ⚠ Sign-out has to be one of them.
 *
 *   A gate with no exit is a trap: somebody who signs in with the wrong Google
 *   account and does not want to give a number would otherwise be held on a
 *   form with no way back to a signed-out state. The auth routes stay open for
 *   the same reason.
 */
const COMPLETION_EXEMPT = [
  '/complete-profile',
  '/sign-in',
  '/sign-up',
  '/confirm',
  '/legal',
  /*
    Somebody mid-password-reset is not being asked for a phone number first.
    Without this the two gates take turns: recovery sends them to
    update-password, completion sends them straight back off it, and neither
    screen ever finishes.
  */
  '/update-password',
];

/**
 * Where to send an account that has no phone number on file, or null.
 *
 * ⚠ Every email sign-up has a valid Nigerian number, and a rule elsewhere rests
 *   on that.
 *
 *   `guard_application_phone` in `20250101000016_driver_identity.sql` stops a driver
 *   applicant claiming a number that is not their account's — and it
 *   deliberately passes accounts with *no* number, because some predate the
 *   field. Google accounts arrive with none, so without this every one of them
 *   would be a driver applicant who can type any phone they like. The lock
 *   would hold for every email signup and for no Google signup, silently.
 *
 * ⚠ A pure function so the rule can be tested, and mutated, without a router.
 */
export const UPDATE_PASSWORD_ROUTE = '/update-password';

/**
 * The only places somebody mid-password-reset may be.
 *
 * Deliberately short. `/sign-in` is *not* here: a recovery session is already
 * signed in, so offering the form would be nonsense, and leaving by that door
 * would strand them inside the app on an untrusted session. The way out is
 * signing out, which clears the flag and makes every route available again.
 */
const RECOVERY_EXEMPT = [UPDATE_PASSWORD_ROUTE, '/legal'];

/**
 * Keeps a recovery session pinned to the screen that ends it.
 *
 * ⚠ This one *is* closer to a gate than the rest of this module, and still is
 *   not a security boundary.
 *
 *   A recovery session carries the same privileges as any other, so nothing
 *   here stops a determined person calling the API directly — RLS is what
 *   governs that, as everywhere else. What this stops is the ordinary version:
 *   a forwarded reset email, or a shared inbox, turning into a working login
 *   for somebody who never knew the password and never sets one. Routing is
 *   the right tool for that because the honest case — a person who did ask for
 *   the reset — is one form away from being done.
 *
 * Ranked above `completionRedirect` by its caller: an account owes a password
 * before it owes a phone number.
 */
export function recoveryRedirect(pathname: string, recovering: boolean): string | null {
  if (!recovering) return null;
  if (RECOVERY_EXEMPT.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return null;
  }
  return UPDATE_PASSWORD_ROUTE;
}

export function completionRedirect(pathname: string, needsPhone: boolean): string | null {
  if (!needsPhone) return null;
  if (COMPLETION_EXEMPT.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return null;
  }
  return COMPLETE_PROFILE_ROUTE;
}
