import type { Session, User } from '@supabase/supabase-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { errorMessage } from '@/lib/errors';
import { showToast } from '@/components/ui/toast';
import { clearAllDrafts } from '@/hooks/use-form-draft';
import {
  fetchIsAdmin,
  fetchMyApplication,
  statusChangeMessage,
  subscribeToMyApplication,
  type ApplicationStatus,
  type DriverApplication,
} from '@/store/driver-applications';
import { authErrorMessage, isEmailTakenCode, isSupabaseConfigured, supabase } from '@/lib/supabase';
import { emailConfirmationLink, oauthRedirectLink, passwordResetLink } from '@/constants/links';
import { registerForPush, unregisterPush } from '@/store/push';
import type { City } from '@/store/bookings';

/**
 * The signed-in session, backed by Supabase auth.
 *
 * Passwords are never handled here beyond passing them straight to Supabase,
 * which hashes and stores them server-side. Nothing about a password is kept on
 * the device; what persists is a refresh token in AsyncStorage, managed by the
 * client.
 */
export type SessionRole = 'sender' | 'driver';

/** Both options, in the order the segmented control renders them. */
export const SESSION_ROLES: readonly { value: SessionRole; label: string }[] = [
  { value: 'sender', label: 'Sender' },
  { value: 'driver', label: 'Driver' },
];

export type SessionUser = {
  id: string;
  /** Display name. Also what `Booking.driver` stores when this user claims a job. */
  name: string;
  phone: string;
  /** Where transactional mail goes. Always set for a Supabase account. */
  email: string | null;
  /**
   * When the account was created, as Supabase's ISO string.
   *
   * Null on the seeded demo owner, which predates accounts — so anything
   * rendering "member since" has to handle its absence rather than assume it.
   */
  createdAt: string | null;
};

/**
 * Owner of the seeded demo parcels.
 *
 * The sample bookings were stamped with this id long before accounts existed.
 * Nothing shows them to a signed-out visitor any more — this exists only so the
 * seed rows in `bookings.tsx` have an owner. Delete both the day the seed data
 * goes.
 */
export const DEMO_USER_ID = 'user-you';

/** Kept for the seed rows in `bookings.tsx`, which reference it directly. */
export const SESSION_USER: SessionUser = {
  id: DEMO_USER_ID,
  name: 'You',
  phone: '+2348012345678',
  email: null,
  /* Predates accounts, so there is no join date to claim. */
  createdAt: null,
};

/**
 * What a submitted driver application leaves behind.
 *
 * `baseCity` is derived from `state` at submit rather than stored twice — see
 * `cityForState`. It is null when the state has no Package Relay city, which cannot
 * happen today but would the moment the two lists drift apart.
 */
export type DriverRegistration = {
  /** As picked in "State of operation". */
  state: string;
  /** The Package Relay city that state operates out of. Null when unmapped. */
  baseCity: City | null;
  /** Residential address, from "Your details". */
  address: string;
  reference: string;
  submittedAt: string;
};

/**
 * Where one account's chosen view is remembered.
 *
 * Per user id, so signing in as someone else on the same device starts from the
 * default rather than inheriting a stranger's preference.
 */
const activeViewKey = (userId: string) => `loci.activeView.${userId}`;

/**
 * That this account arrived on a recovery link and has not set a password yet.
 *
 * ⚠ Persisted, and that is the point rather than an optimisation.
 *
 *   A recovery link mints an ordinary session. Holding "they are mid-reset"
 *   only in memory means closing the app and reopening it drops the flag and
 *   leaves a full, signed-in session behind — which is the emailed-link-as-
 *   login hole this gate exists to close, reachable by doing nothing more
 *   than force-quitting.
 *
 * Per user id, like the view key: two people resetting on the same device do
 * not inherit each other's state. Cleared the moment a password is set, and on
 * sign-out.
 */
const recoveryKey = (userId: string) => `loci.recovery.${userId}`;

/** `loading` covers the moment at launch before a stored session is restored. */
export type SessionStatus = 'loading' | 'signedIn' | 'signedOut';

/**
 * How long the app will wait for a stored session before giving up on one.
 *
 * See the note beside the timer in the restore effect: this exists so a promise
 * that never settles cannot pin every guard in the app on 'loading'.
 */
const AUTH_RESTORE_DEADLINE_MS = 8000;

export type SignUpParams = {
  email: string;
  password: string;
  name: string;
  phone: string;
};

export type AuthResult = {
  /** Null on success; a human-readable message otherwise. */
  error: string | null;
  /**
   * True when the email is already registered. Separate from `error` because
   * the screen answers it with a dialog offering to sign in, not a red banner.
   */
  emailTaken?: boolean;
  /**
   * True when the account was created but Supabase is holding it until the
   * emailed link is clicked. The screen must say so rather than claiming
   * success and dropping the user at a signed-out home screen.
   */
  needsEmailConfirmation?: boolean;
};

export type SessionContextValue = {
  status: SessionStatus;
  /** Null while signed out. Browsing is allowed; actions are not. */
  user: SessionUser | null;
  isAuthenticated: boolean;
  /**
   * Whose parcels the personal feeds should show, or null when signed out.
   *
   * It used to fall back to the demo identity so the app looked populated on
   * first run. That was a privacy bug waiting to happen: a stranger saw seeded
   * parcels presented as *theirs*, complete with recipient names and phone
   * numbers. Signed out now means no personal data — the screens prompt to sign
   * in instead.
   */
  viewerId: string | null;
  role: SessionRole;
  setRole: (role: SessionRole) => void;
  toggleRole: () => void;
  /** Null until a driver application is submitted on this device. */
  driver: DriverRegistration | null;
  registerDriver: (registration: DriverRegistration) => void;
  /** The signed-in user's own application, once loaded. Null if they have none. */
  application: DriverApplication | null;
  /**
   * False until the application has actually been looked up.
   *
   * `application === null` alone cannot tell "they have none" from "we have not
   * asked yet", and screens that pick a default view from it need the
   * difference.
   */
  driverStatusLoaded: boolean;
  /** True only once an admin has approved. Gates accepting jobs. */
  isApprovedDriver: boolean;
  /** Whether this account can open the review dashboard. */
  isAdmin: boolean;
  /** Re-reads the application and admin flag, e.g. after submitting. */
  refreshDriverStatus: () => Promise<void>;
  signUp: (params: SignUpParams) => Promise<AuthResult>;
  signIn: (params: { email: string; password: string }) => Promise<AuthResult>;
  /** Re-sends the sign-up confirmation email. */
  resendConfirmation: (email: string) => Promise<AuthResult>;
  /** Emails a password-reset link. Never reveals whether the account exists. */
  requestPasswordReset: (email: string) => Promise<AuthResult>;
  /**
   * True between arriving on a recovery link and actually setting a password.
   *
   * ⚠ Read it as "this session is not trusted yet", not as a routing hint.
   *
   *   Supabase answers a recovery link with a real session — same shape, same
   *   privileges as one earned with a password — so `status` alone says
   *   "signed in" for somebody who has proved only that they can read an
   *   inbox. `recoveryRedirect` in `lib/experience.ts` is what keeps them on
   *   the update-password screen until they have proved more than that.
   */
  recovering: boolean;
  /**
   * Sets a new password and ends the recovery state.
   *
   * Used by the update-password screen for both cases that reach it: somebody
   * who followed a reset link, and somebody changing a password they already
   * know while signed in. Supabase requires only a session for either.
   */
  updatePassword: (password: string) => Promise<AuthResult>;
  /**
   * Hands off to Google and comes back with a session.
   *
   * ⚠ Resolves *before* the session exists on web, and that is not a bug.
   *
   *   The browser navigates away to Google. Nothing after the call runs — the
   *   page is replaced — so a caller that awaits this and then reads `user`
   *   would be writing code for a moment that never arrives. On native the
   *   browser is a modal and this does resolve, which is why the return type
   *   carries an error at all.
   */
  signInWithGoogle: () => Promise<AuthResult>;
  /**
   * True when the signed-in account has no phone number on file.
   *
   * ⚠ Only a Google account can be in this state.
   *
   *   Email sign-up refuses to submit without a valid Nigerian number, so every
   *   account created that way has one. `guard_application_phone` rests on
   *   that: it stops a driver applicant claiming a number that is not their
   *   account's, and passes accounts with none. Without the screen this flag
   *   drives, every Google account would be an applicant who can type any phone
   *   they like.
   */
  needsPhone: boolean;
  /** Records the number a Google account was asked for on first sign-in. */
  savePhone: (phone: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Supabase's user shape into ours. Name and phone live in `user_metadata`
 * because they were collected at sign-up; `email` is a first-class column.
 */
function toSessionUser(user: User): SessionUser {
  const meta = user.user_metadata ?? {};

  return {
    id: user.id,
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : 'You',
    phone: typeof meta.phone === 'string' ? meta.phone : '',
    email: user.email ?? null,
    createdAt: user.created_at ?? null,
  };
}

/**
 * Auth requests must not be able to hang forever.
 *
 * `supabase-js` has no built-in timeout: on a phone that has switched networks,
 * or against a URL that resolves but never answers, the promise simply never
 * settles. The screen is left on "Creating account…" with the button disabled
 * and nothing to read — the worst possible failure, because it looks like the
 * app is working. A rejection the UI can render beats silence.
 */
const AUTH_TIMEOUT_MS = 20_000;

/**
 * Shorter than the auth timeout, because nothing is waiting on a person here.
 *
 * Signing in is an action somebody just took and is watching; twenty seconds of
 * patience is reasonable. The application lookup runs unprompted at launch, and
 * a screen blocked on it shows a spinner with no explanation — so it gives up
 * sooner and carries on with what it knows.
 */
const STATUS_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: PromiseLike<T>, ms = AUTH_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Supabase reports most problems by *returning* an error, but a few — DNS
 * failures, a malformed URL, storage errors — are thrown. Those were escaping
 * uncaught, which is what stranded the button.
 */
function thrownMessage(thrown: unknown): string {
  /*
   * `errorMessage`, not `String(thrown)`.
   *
   * A Supabase failure is a plain object, so `String` on it produces the
   * literal text "[object Object]" — which then fails every `includes` test
   * below and falls through to the generic branch. The sign-in screen has been
   * showing a catch-all for any server-side refusal.
   */
  const raw = errorMessage(thrown, String(thrown));

  if (raw.toLowerCase().includes('timed out')) {
    return `The server didn't respond. Check your connection, and that EXPO_PUBLIC_SUPABASE_URL points at your project.`;
  }

  return authErrorMessage(undefined, raw);
}

/**
 * An account created within this window is treated as brand new, so the first
 * greeting says "welcome to Package Relay" rather than "welcome back".
 *
 * Five minutes rather than seconds: with email confirmation on, the account is
 * created when the form is submitted but the first sign-in happens whenever the
 * person gets round to opening their inbox. A tight window would greet a
 * genuinely new user as a returning one.
 */
const NEW_ACCOUNT_WINDOW_MS = 5 * 60 * 1000;

/** First name only — "Welcome back, Bolaji Noah" reads like a bank letter. */
function firstName(user: User): string {
  const full = typeof user.user_metadata?.name === 'string' ? user.user_metadata.name.trim() : '';
  const first = full.split(/\s+/)[0];
  return first || 'there';
}

function welcome(user: User) {
  const createdAt = user.created_at ? Date.parse(user.created_at) : Number.NaN;
  const isNew = Number.isFinite(createdAt) && Date.now() - createdAt < NEW_ACCOUNT_WINDOW_MS;

  if (isNew) {
    showToast(`Welcome to Package Relay, ${firstName(user)}`, {
      message: 'Your account is ready. You can post a parcel or start carrying jobs.',
    });
    return;
  }

  showToast(`Welcome back, ${firstName(user)}`, {
    message: 'You are signed in.',
  });
}

const NOT_CONFIGURED: AuthResult = {
  error:
    'Accounts are not configured yet. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env.local and restart the dev server.',
};

export function SessionProvider({
  children,
  initialRole = 'sender',
}: {
  children: ReactNode;
  initialRole?: SessionRole;
}) {
  const [role, setRoleState] = useState<SessionRole>(initialRole);
  const [driver, setDriver] = useState<DriverRegistration | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [application, setApplication] = useState<DriverApplication | null>(null);
  const [driverStatusLoaded, setDriverStatusLoaded] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [status, setStatus] = useState<SessionStatus>(
    isSupabaseConfigured ? 'loading' : 'signedOut',
  );

  /**
   * Who has already been welcomed, for as long as the app is running.
   *
   * A ref rather than state: nothing renders from it, and making it state would
   * re-render every consumer of this context on sign-in for no visible reason.
   */
  const greetedUserId = useRef<string | null>(null);

  /**
   * Whether the initial session restore has finished, either way.
   *
   * A ref rather than state: nothing renders from it, and it is read inside an
   * auth callback that must see the current value rather than the one captured
   * when the listener was attached.
   */
  const restored = useRef(false);

  /**
   * Restore any stored session, then follow it. `onAuthStateChange` covers sign
   * in, sign out, token refresh and expiry, so no screen has to poll.
   */
  useEffect(() => {
    if (!isSupabaseConfigured) return;

    let active = true;

    /*
     * ⚠ The stored recovery flag is read *before* status leaves `loading`, and
     *   the single `setStatus` below is why.
     *
     *   Everything downstream treats `loading` as "do not decide yet" —
     *   `resolveExperience` returns null, and `ExperienceRouter` returns early
     *   on it. Flipping to `signedIn` first and setting `recovering` a tick
     *   later would open exactly one frame in which a half-reset session looks
     *   like a good one, and one frame is all a redirect needs.
     */
    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        const restoring = data.session?.user?.id ?? null;
        const stored = restoring
          ? await AsyncStorage.getItem(recoveryKey(restoring)).catch(() => null)
          : null;

        if (!active) return;
        setRecovering(stored === '1');
        setSession(data.session);
        setStatus(data.session ? 'signedIn' : 'signedOut');
      })
      .catch(() => {
        /* Storage unreadable, or the client refused. Signed out is the safe read. */
        if (active) setStatus('signedOut');
      })
      .finally(() => {
        restored.current = true;
      });

    /*
     * ⚠ A deadline, for the same reason `_layout.tsx` has one for fonts.
     *
     *   Everything downstream treats `loading` as "do not decide yet", so a
     *   `getSession()` that never settles is not a slow app — it is a permanent
     *   skeleton on every screen that waits for it. That file learned this the
     *   expensive way with a font promise that resolved without decoding and
     *   shipped a white page.
     *
     *   Eight seconds is far longer than a storage read plus a token refresh
     *   and short enough that somebody has not yet given up. It settles to
     *   signed out, which is the recoverable direction: the sign-in screen
     *   works, where a stuck skeleton does not.
     */
    const deadline = setTimeout(() => {
      if (!active || restored.current) return;
      restored.current = true;
      setStatus((current) => (current === 'loading' ? 'signedOut' : current));
    }, AUTH_RESTORE_DEADLINE_MS);

    const { data: subscription } = supabase.auth.onAuthStateChange((event, next) => {
      /*
       * ⚠ INITIAL_SESSION is ignored here, and this is the sign-in flash.
       *
       *   Supabase emits INITIAL_SESSION the moment this listener is attached —
       *   before the stored session has finished being read. On the web that
       *   first event frequently carries `next = null`, and the two lines below
       *   used to take it at face value: `status` left 'loading' and landed on
       *   'signedOut'. Every guard that waits on 'loading' let go, the parcel
       *   screen painted its sign-in prompt, and a moment later `getSession()`
       *   resolved with a perfectly good session and it all flipped back.
       *
       *   One frame is all a wrong answer needs. `getSession()` above is the
       *   authority on the initial state — it awaits the storage read — so this
       *   listener's job is changes, not the beginning.
       *
       * ⚠ And no event may report signed-out before the restore has finished.
       *
       *   Supabase has more than one way to announce "nothing yet" on startup,
       *   and each new one would reintroduce exactly this bug. Rather than
       *   enumerate them, anything arriving empty before `restored` is set is
       *   left for `getSession()` to answer. A real sign-out cannot happen
       *   before the restore completes: there is nothing to sign out of.
       */
      if (event === 'INITIAL_SESSION') return;
      if (!next && !restored.current) return;

      setSession(next);
      setStatus(next ? 'signedIn' : 'signedOut');

      /*
       * Greet once per person, not once per event.
       *
       * Filtering on `SIGNED_IN` alone was not enough. Supabase re-emits it
       * whenever a web tab regains visibility — it re-validates the stored
       * session on focus and announces the result — so switching to another tab
       * and back produced "Welcome back" every single time. `INITIAL_SESSION`
       * and `TOKEN_REFRESHED` are excluded for related reasons: the first fires
       * on every launch, the second roughly hourly, mid-task.
       *
       * Remembering *who* was greeted is what actually fixes it, and it does so
       * whatever new reason Supabase finds to re-emit the event. Signing out
       * clears it, so signing back in — as the same person or a different one —
       * greets again, which is the one case where the message is warranted.
       */
      /*
       * ⚠ A reset link is not a sign-in, however much the session looks like one.
       *
       *   Supabase mints an ordinary session for a recovery link and reports it
       *   here as `PASSWORD_RECOVERY`. Left to the branches below it would fall
       *   through as an unremarkable signed-in state: "Welcome back", the app
       *   home, full access — to somebody who has demonstrated only that they
       *   can open an email. Whoever forwarded that message, or is still logged
       *   into a shared inbox, gets the same.
       *
       *   So it is flagged instead, and the flag is what `recoveryRedirect`
       *   holds them on the update-password screen with. It outlives a restart
       *   because it is written to storage here, and it is cleared in exactly
       *   two places: a password actually being set, and signing out.
       */
      if (event === 'PASSWORD_RECOVERY') {
        setRecovering(true);
        if (next?.user) {
          void AsyncStorage.setItem(recoveryKey(next.user.id), '1').catch(() => {});
        }
        return;
      }

      if (event === 'SIGNED_OUT') {
        greetedUserId.current = null;
        setRecovering(false);
        /*
         * Forget the stored view for the account that just left, so the next
         * person on this device is not dropped into their interface.
         */
        if (user) {
          void AsyncStorage.removeItem(activeViewKey(user.id)).catch(() => {});
          void AsyncStorage.removeItem(recoveryKey(user.id)).catch(() => {});
        }
        restoredViewFor.current = null;
        return;
      }

      if (event === 'SIGNED_IN' && next?.user && greetedUserId.current !== next.user.id) {
        greetedUserId.current = next.user.id;
        welcome(next.user);
      }
    });

    return () => {
      active = false;
      clearTimeout(deadline);
      subscription.subscription.unsubscribe();
    };
  }, []);

  const user = useMemo(() => (session?.user ? toSessionUser(session.user) : null), [session]);

  /**
   * Reads the application and the admin flag together.
   *
   * Both come from the server rather than being inferred locally: approval and
   * admin rights are decisions someone else made, and a client that decided
   * them for itself would be no gate at all.
   */
  const refreshDriverStatus = useCallback(async () => {
    if (!isSupabaseConfigured || !user) {
      setApplication(null);
      setIsAdmin(false);
      setDriverStatusLoaded(true);
      return;
    }

    /*
     * ⚠ Timed out, and the failures fall back rather than propagate.
     *
     *   `driverStatusLoaded` is what Be a Driver / Updates waits on before it
     *   can show anything at all, so a request that never settles is a page
     *   that spins forever. Both calls already swallowed rejections; neither
     *   had any protection against simply hanging, which is what a phone
     *   holding one bar actually does.
     *
     *   Falling back to "no application, not an admin" is the safe direction:
     *   it offers the form to somebody who may have already applied, which
     *   `one_open_application` refuses with a message they can act on. The
     *   opposite mistake — assuming an application exists — shows an applicant
     *   a timeline of nothing.
     */
    const [nextApplication, nextIsAdmin] = await Promise.all([
      withTimeout(fetchMyApplication(user.id), STATUS_TIMEOUT_MS).catch(() => null),
      withTimeout(fetchIsAdmin(user.id), STATUS_TIMEOUT_MS).catch(() => false),
    ]);

    setApplication(nextApplication);
    setIsAdmin(nextIsAdmin);
    /*
     * Distinguishes "no application" from "not asked yet".
     *
     * Both read as `application === null`, and a screen that has to *choose* a
     * default from it — Be a Driver / Updates picks the form or the timeline —
     * would otherwise show an existing applicant the blank form for the moment
     * before the fetch lands.
     */
    setDriverStatusLoaded(true);

    /*
     * An approved driver's device registers for push here, at sign-in.
     *
     * ⚠ This is the one place the "never ask for notifications early" rule in
     *   `registerForPush` does not apply, and it is worth saying why rather
     *   than looking like an oversight.
     *
     *   The rule exists because a prompt in front of somebody who has not yet
     *   seen what an app does gets refused, and on iOS a refusal is close to
     *   permanent. An approved driver is the opposite case: they have filled in
     *   an application, been vetted, and are opening Package Relay to find work. The
     *   prompt is the app doing the thing they came for.
     *
     *   Everyone else — senders, applicants, rejected drivers — is untouched.
     *   Nothing is offered to them, so there is nothing to notify them about.
     *
     * It also refreshes the stored token on every sign-in, which matters
     * independently of the prompt: Expo tokens are not permanent, and a stale
     * one is a driver the notifier believes it reached.
     */
    if (nextApplication?.status === 'approved') {
      // Fire and forget. A driver must never wait on a permission dialog to
      // reach their own home screen.
      void registerForPush();
    }
  }, [user]);

  /**
   * Reload the application whenever the *person* changes — not whenever the
   * session object does.
   *
   * `user` is derived from `session`, so it gets a new identity on every token
   * refresh. Keying the reset on `user.id` instead means an hourly refresh does
   * not blank `driverStatusLoaded` and flash a spinner over whatever the person
   * was reading.
   */
  /*
   * ⚠ Starts `undefined`, and the difference from `null` is the whole bug.
   *
   *   This was `useRef<string | null>(null)`. A signed-out visitor also has an
   *   id of `null`, so on the very first render the guard below compared null
   *   to null, matched, and returned — `refreshDriverStatus` was never called,
   *   `driverStatusLoaded` stayed false, and it never got another chance:
   *   `getSession()` resolving to no session sets the same `null` React bails
   *   out on, so nothing downstream changes identity and the effect does not
   *   re-run.
   *
   *   Signed-in people were unaffected, which is what hid it — their id arrives
   *   as a string, which does differ from null. Signed out, Be a Driver /
   *   Updates spun forever, because it waits for `driverStatusLoaded` before
   *   choosing between the application form and the timeline. The page that
   *   exists to be opened by people who have not applied was the one page they
   *   could not open.
   *
   *   `undefined` is a value no account can have, so "nobody yet" and "nobody,
   *   confirmed" are finally distinguishable.
   */
  const loadedForUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const id = user?.id ?? null;
    if (loadedForUserId.current === id) return;

    loadedForUserId.current = id;
    // Back to "not asked yet". Without this, a returning applicant would be
    // shown the blank Be a Driver form for the moment before their row loads,
    // because the flag was left true by the previous session.
    setDriverStatusLoaded(false);
    void refreshDriverStatus();
  }, [user?.id, refreshDriverStatus]);

  /*
   * Live application status.
   *
   * An applicant waiting up to seven working days should not have to reload the
   * app to find out they've been approved. This listens to their own row and
   * announces the change the moment an admin saves it.
   *
   * The previous status is held in a ref rather than read from `application`:
   * the effect must not re-subscribe every time the row changes, or approving
   * would tear down and rebuild the channel mid-announcement.
   */
  const lastStatus = useRef<ApplicationStatus | null>(null);

  useEffect(() => {
    lastStatus.current = application?.status ?? null;
  }, [application?.status]);

  useEffect(() => {
    if (!isSupabaseConfigured || !user) return;

    return subscribeToMyApplication(user.id, (next) => {
      const announcement = statusChangeMessage(lastStatus.current, next.status);
      lastStatus.current = next.status;
      setApplication(next);

      if (announcement) {
        showToast(announcement.title, {
          message: announcement.message,
          tone: announcement.tone === 'success' ? 'success' : 'info',
          // Longer than a greeting: this is the outcome of a week's wait.
          duration: 7000,
        });
      }
    });
  }, [user?.id]);

  /**
   * The active view, remembered per account.
   *
   * Keyed by user id rather than stored under one key: a shared device would
   * otherwise hand the next person to sign in whatever view the last one chose,
   * and "why am I looking at the driver app?" is a confusing first impression
   * for someone who has never applied.
   *
   * Written after the state update rather than awaited before it, so the
   * interface switches on the tap. A view preference is not worth a spinner,
   * and a failed write costs at most the next cold start.
   */
  const setRole = useCallback(
    (next: SessionRole) => {
      setRoleState(next);
      if (user) void AsyncStorage.setItem(activeViewKey(user.id), next).catch(() => {});
    },
    [user],
  );

  const toggleRole = useCallback(
    () => setRole(role === 'sender' ? 'driver' : 'sender'),
    [role, setRole],
  );

  /*
   * Restore the stored view when the person changes.
   *
   * Keyed on `user?.id` for the same reason `driverStatusLoaded` is: `user` is
   * derived from the session and gets a new identity on every hourly token
   * refresh, so keying on the object would re-read storage all day.
   *
   * Nothing validates the stored value against approval here. It does not need
   * to — `resolveExperience` already falls back to the sender interface for
   * anyone without an approved application, so a stale 'driver' cannot strand
   * someone whose approval was revoked.
   */
  /* `undefined`, for the reason spelled out on `loadedForUserId` above. */
  const restoredViewFor = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const id = user?.id ?? null;
    if (restoredViewFor.current === id) return;
    restoredViewFor.current = id;

    if (!id) {
      setRoleState(initialRole);
      return;
    }

    let active = true;
    void AsyncStorage.getItem(activeViewKey(id)).then((stored) => {
      if (!active) return;
      if (stored === 'sender' || stored === 'driver') setRoleState(stored);
    });

    return () => {
      active = false;
    };
  }, [user?.id, initialRole]);

  const registerDriver = useCallback((registration: DriverRegistration) => {
    setDriver(registration);
  }, []);

  const signUp = useCallback(async (params: SignUpParams): Promise<AuthResult> => {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;

    try {
      const { data, error } = await withTimeout(
        supabase.auth.signUp({
          email: params.email.trim().toLowerCase(),
          password: params.password,
          options: {
            // Stored on the auth user, so it survives without a separate profile
            // table. Move to a `profiles` row once there's more than name and phone.
            data: { name: params.name.trim(), phone: params.phone.trim() },
            /*
              ⚠ Named route, and the address travels with it.

                Without `emailRedirectTo` the link lands on the project's Site
                URL — the marketing home — where nothing reads the parameters,
                so an expired token showed a normal home page and the person was
                left believing the email had done something. The email on the
                URL is what lets `/confirm` offer a resend to the right address
                and spot a link claimed under somebody else's session.
            */
            emailRedirectTo: emailConfirmationLink(params.email),
          },
        }),
      );

      if (error) {
        return {
          error: authErrorMessage(error.code, error.message),
          emailTaken: isEmailTakenCode(error.code),
        };
      }

      /*
       * The quiet duplicate.
       *
       * With email confirmation enabled, signing up with an address that is
       * already registered does NOT return an error — Supabase returns a
       * success with an obfuscated user so the form can't be used to discover
       * who has an account. The tell is an empty `identities` array. Without
       * this check the user is sent to "check your email" for a confirmation
       * that never arrives, which is the most confusing outcome available.
       */
      const identities = data.user?.identities;
      if (data.user && Array.isArray(identities) && identities.length === 0) {
        return { error: null, emailTaken: true };
      }

      // A confirmed-email project returns a user but no session until the link
      // is clicked. Reporting that honestly avoids "account created" followed
      // by a sign-in that refuses to work.
      return { error: null, needsEmailConfirmation: Boolean(data.user) && !data.session };
    } catch (thrown) {
      return { error: thrownMessage(thrown) };
    }
  }, []);

  const signIn = useCallback(
    async (params: { email: string; password: string }): Promise<AuthResult> => {
      if (!isSupabaseConfigured) return NOT_CONFIGURED;

      try {
        const { error } = await withTimeout(
          supabase.auth.signInWithPassword({
            email: params.email.trim().toLowerCase(),
            password: params.password,
          }),
        );

        return { error: error ? authErrorMessage(error.code, error.message) : null };
      } catch (thrown) {
        return { error: thrownMessage(thrown) };
      }
    },
    [],
  );

  /**
   * Starts a password reset.
   *
   * Always reports success, even for an address with no account: the response
   * must not tell a stranger whether an email is registered here. Supabase
   * behaves the same way for the same reason.
   */
  const requestPasswordReset = useCallback(async (email: string): Promise<AuthResult> => {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;

    try {
      const address = email.trim().toLowerCase();
      const { error } = await withTimeout(
        supabase.auth.resetPasswordForEmail(address, {
          /*
            Without this the link lands on the Site URL, which reads no
            parameters — no token exchange, no `PASSWORD_RECOVERY`, and a
            marketing page that looks like the reset simply did nothing.
            See `constants/links.ts`; the URL must also be allowlisted.
          */
          redirectTo: passwordResetLink(address),
        }),
      );

      // Rate limits and outages are real failures worth surfacing. "No such
      // user" is not one Supabase returns here, by design.
      return { error: error ? authErrorMessage(error.code, error.message) : null };
    } catch (thrown) {
      return { error: thrownMessage(thrown) };
    }
  }, []);

  /**
   * Sets a new password on the current session, and lifts the recovery gate.
   *
   * ⚠ The flag is cleared only after Supabase confirms the write.
   *
   *   Clearing optimistically would release the gate on a request that failed —
   *   a rate limit, a dropped connection, a password the project's own rules
   *   rejected — leaving somebody inside the app with the old password still
   *   live and no prompt to finish. The gate stays shut until the thing it is
   *   waiting for has actually happened.
   */
  const updatePassword = useCallback(
    async (password: string): Promise<AuthResult> => {
      if (!isSupabaseConfigured) return NOT_CONFIGURED;

      try {
        const { data, error } = await withTimeout(supabase.auth.updateUser({ password }));

        if (error) return { error: authErrorMessage(error.code, error.message) };

        setRecovering(false);
        if (data.user) {
          void AsyncStorage.removeItem(recoveryKey(data.user.id)).catch(() => {});
        }

        return { error: null };
      } catch (thrown) {
        return { error: thrownMessage(thrown) };
      }
    },
    [],
  );

  /** Re-sends the confirmation email. Supabase rate-limits this server-side. */
  const resendConfirmation = useCallback(async (email: string): Promise<AuthResult> => {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;

    try {
      const { error } = await withTimeout(
        supabase.auth.resend({ type: 'signup', email: email.trim().toLowerCase() }),
      );

      return { error: error ? authErrorMessage(error.code, error.message) : null };
    } catch (thrown) {
      return { error: thrownMessage(thrown) };
    }
  }, []);

  const signInWithGoogle = useCallback(async (): Promise<AuthResult> => {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;

    try {
      const { data, error } = await withTimeout(
        supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: oauthRedirectLink(),
            /*
             * ⚠ Web navigates itself; native must not.
             *
             *   Left to redirect on native, Supabase would try to replace a
             *   document that is not there. The URL is opened in a modal
             *   browser instead, and the scheme redirect closes it.
             */
            skipBrowserRedirect: Platform.OS !== 'web',
          },
        }),
      );

      if (error) return { error: authErrorMessage(error.code, error.message) };

      if (Platform.OS !== 'web' && data?.url) {
        const result = await WebBrowser.openAuthSessionAsync(data.url, oauthRedirectLink());

        /*
         * ⚠ Dismissing is not failing.
         *
         *   Somebody who changes their mind and closes the sheet gets `dismiss`
         *   or `cancel`. Reporting that as an error puts a red banner in front
         *   of a deliberate act.
         */
        if (result.type !== 'success') return { error: null };

        /*
         * The tokens come back in the URL fragment. `setSession` is what turns
         * them into a session the rest of the app can see; without it the
         * browser closes and nothing has happened.
         */
        const params = new URLSearchParams(result.url.split('#')[1] ?? '');
        const access_token = params.get('access_token');
        const refresh_token = params.get('refresh_token');

        if (access_token && refresh_token) {
          const restored = await supabase.auth.setSession({ access_token, refresh_token });
          if (restored.error) {
            return { error: authErrorMessage(restored.error.code, restored.error.message) };
          }
        }
      }

      return { error: null };
    } catch (thrown) {
      return { error: thrownMessage(thrown) };
    }
  }, []);

  /**
   * ⚠ Written to both places the phone is read from.
   *
   *   `handle_new_user` copies `raw_user_meta_data ->> 'phone'` into
   *   `profiles.phone` at signup, and `guard_application_phone` reads the
   *   metadata rather than the profile. Updating only one would leave the
   *   profile screen showing a number the driver phone lock cannot see.
   */
  const savePhone = useCallback(async (phone: string): Promise<AuthResult> => {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;

    const trimmed = phone.trim();

    try {
      const { data, error } = await withTimeout(
        supabase.auth.updateUser({ data: { phone: trimmed } }),
      );
      if (error) return { error: authErrorMessage(error.code, error.message) };

      const { error: profileError } = await withTimeout(
        supabase
          .from('profiles')
          .update({ phone: trimmed })
          .eq('id', data.user?.id ?? ''),
      );
      if (profileError) return { error: profileError.message };

      setSession((previous) =>
        previous ? { ...previous, user: { ...previous.user, phone: trimmed } } : previous,
      );

      return { error: null };
    } catch (thrown) {
      return { error: thrownMessage(thrown) };
    }
  }, []);

  const signOut = useCallback(async () => {
    /*
     * Forget the device before dropping the session.
     *
     * `unregisterPush` deletes its own row, which needs the session that is
     * about to end — so the order here is load-bearing rather than stylistic.
     * Without it, the next person to sign in on a shared phone keeps receiving
     * the previous driver's trip offers.
     */
    await unregisterPush();
    if (isSupabaseConfigured) await supabase.auth.signOut();
    setSession(null);
    setStatus('signedOut');
    /*
     * Drafts hold a NIN, a bank account and a guarantor's details. Signing out
     * is the clearest "I'm finished on this device" signal there is, so they go
     * with the session rather than waiting for their 24-hour expiry.
     */
    await clearAllDrafts();

    // These belong to the person, not the device.
    setDriver(null);
    setApplication(null);
    setDriverStatusLoaded(false);
    setIsAdmin(false);
    setRole('sender');

    /*
     * Belt and braces alongside the `SIGNED_OUT` listener: when Supabase is not
     * configured no auth event fires at all, and the next sign-in should still
     * be greeted.
     */
    greetedUserId.current = null;
    setRecovering(false);
    /*
     * Forget the stored view for the account that just left, so the next
     * person on this device is not dropped into their interface.
     */
    if (user) {
      void AsyncStorage.removeItem(activeViewKey(user.id)).catch(() => {});
      void AsyncStorage.removeItem(recoveryKey(user.id)).catch(() => {});
    }
    restoredViewFor.current = null;
  }, []);

  const value = useMemo(
    () => ({
      status,
      user,
      isAuthenticated: Boolean(user),
      viewerId: user?.id ?? null,
      role,
      setRole,
      toggleRole,
      driver,
      registerDriver,
      application,
      driverStatusLoaded,
      isApprovedDriver: application?.status === 'approved',
      isAdmin,
      refreshDriverStatus,
      signUp,
      signIn,
      signInWithGoogle,
      needsPhone: status === 'signedIn' && (user?.phone ?? '').trim().length === 0,
      savePhone,
      resendConfirmation,
      requestPasswordReset,
      recovering,
      updatePassword,
      signOut,
    }),
    [
      status,
      user,
      role,
      toggleRole,
      driver,
      registerDriver,
      application,
      isAdmin,
      refreshDriverStatus,
      signUp,
      signIn,
      signInWithGoogle,
      savePhone,
      resendConfirmation,
      requestPasswordReset,
      recovering,
      updatePassword,
      signOut,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);

  if (!context) {
    throw new Error('useSession must be used within a SessionProvider');
  }

  return context;
}
