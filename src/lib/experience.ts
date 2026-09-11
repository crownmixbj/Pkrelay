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
const COMPLETION_EXEMPT = ['/complete-profile', '/sign-in', '/sign-up', '/confirm', '/legal'];

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
export function completionRedirect(pathname: string, needsPhone: boolean): string | null {
  if (!needsPhone) return null;
  if (COMPLETION_EXEMPT.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return null;
  }
  return COMPLETE_PROFILE_ROUTE;
}
