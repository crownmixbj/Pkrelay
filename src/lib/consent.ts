import { Platform } from 'react-native';

/**
 * Cookie and storage consent, for the web build.
 *
 * ⚠ Read this before adding anything that tracks people.
 *
 *   Package Relay sets NO analytics or advertising storage today — there is no
 *   GA, no Plausible, no pixel, nothing. This module is the gate that anything
 *   like that must go through when it arrives, and the banner asks permission
 *   in advance so consent is already on file the day it does.
 *
 *   That is why the banner copy is written as a request ("we would like to")
 *   rather than a statement of current practice ("we use"). A consent notice
 *   describing tracking that does not exist is a false statement in the one
 *   document a regulator reads first. If you would rather not ask until there
 *   is something to ask about, set `enabled: false` on the analytics category
 *   below and the banner stops rendering entirely.
 *
 * ⚠ Native builds are out of scope and render nothing.
 *
 *   There are no cookies in a native app, and the storage it does use — the
 *   session token, form drafts — is strictly necessary for functionality the
 *   person asked for. The ePrivacy consent requirement is about the other kind.
 *
 * ⚠ Nothing here may touch `window` outside a browser.
 *
 *   `app.json` sets `web.output: "static"`, so Expo Router renders every route
 *   in Node before it reaches a browser. That is what broke `lib/supabase.ts`
 *   with `ReferenceError: window is not defined` — thrown inside the static
 *   render, which takes the dev server down rather than merely failing. Same
 *   `isBrowser` guard here, for the same reason.
 */

/**
 * ⚠ Evaluated on every call, not captured once at module load.
 *
 *   `lib/supabase.ts` computes the same test as a module constant because
 *   GoTrue reads storage during construction and there is no later moment to
 *   ask. Nothing here runs at import time, so a function is both equally safe
 *   under the static render and testable — a constant would freeze whatever was
 *   true when the bundle was evaluated, which in a test harness is "no browser"
 *   forever.
 */
const isBrowser = (): boolean =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

/** Web only, and only in a real browser. */
export const consentApplies = (): boolean => Platform.OS === 'web' && isBrowser();

export const CONSENT_STORAGE_KEY = 'pk_cookie_consent';

/**
 * Bump when the categories change in a way that makes an old answer
 * meaningless — a new category, or an existing one growing a new purpose.
 *
 * ⚠ A bump re-asks everybody, and that is the point.
 *
 *   Consent is specific to the purposes it was given for (GDPR Art. 4(11)).
 *   Carrying an old "yes" onto a purpose the person never saw is not consent.
 *   `hasAnswerFor` below also catches an added category on its own, so a
 *   forgotten bump fails safe rather than silently.
 */
export const CONSENT_VERSION = 1;

/**
 * How long an answer stands before it is asked again.
 *
 * Six months follows CNIL's guidance on renewing consent at reasonable
 * intervals. There is no fixed period in the GDPR itself; what is not
 * defensible is "never".
 */
export const CONSENT_MAX_AGE_DAYS = 182;

export type CategoryId = 'essential' | 'analytics';

export type ConsentCategory = {
  id: CategoryId;
  label: string;
  description: string;
  /**
   * Essential storage needs no consent and cannot be switched off — it is what
   * makes the thing the person asked for work at all. Presenting it as a choice
   * would be a dark pattern in the other direction: a toggle that does nothing.
   */
  required: boolean;
  /**
   * Whether this category is live. A category nobody uses yet is not worth
   * asking about — see the header. Flip this the day something reads it.
   */
  enabled: boolean;
};

export const CONSENT_CATEGORIES: readonly ConsentCategory[] = [
  {
    id: 'essential',
    label: 'Essential',
    description:
      'Keeps you signed in, remembers a half-finished booking or application, and stores this cookie choice. Package Relay does not work without these, so they cannot be turned off.',
    required: true,
    enabled: true,
  },
  {
    id: 'analytics',
    label: 'Analytics',
    description:
      'Would let us count visits and see which pages people struggle on, so we can fix them. Off unless you turn it on. Nothing is used to identify you, and nothing is sold or shared with advertisers.',
    required: false,
    enabled: true,
  },
] as const;

/** The categories a person is actually asked about. */
export const optionalCategories = (): ConsentCategory[] =>
  CONSENT_CATEGORIES.filter((category) => !category.required && category.enabled);

/** True when there is anything worth asking about at all. */
export const consentNeeded = (): boolean => optionalCategories().length > 0;

export type ConsentChoices = Record<CategoryId, boolean>;

export type ConsentRecord = {
  version: number;
  /** ISO 8601. The record of when consent was given, which is itself required. */
  decidedAt: string;
  choices: ConsentChoices;
};

/** Everything off except what cannot be. The state before anyone has answered. */
export function essentialOnly(): ConsentChoices {
  return CONSENT_CATEGORIES.reduce((acc, category) => {
    acc[category.id] = category.required;
    return acc;
  }, {} as ConsentChoices);
}

export function acceptAll(): ConsentChoices {
  return CONSENT_CATEGORIES.reduce((acc, category) => {
    acc[category.id] = category.required || category.enabled;
    return acc;
  }, {} as ConsentChoices);
}

/* ------------------------------------------------------------------ *
 * Pure logic
 *
 * Split out so the rules that decide whether somebody is asked again
 * can be tested without a browser — the same split `wallet.ts` uses
 * for `payoutStatusLine`.
 * ------------------------------------------------------------------ */

/**
 * Reads a stored record, or null if there is nothing usable there.
 *
 * ⚠ Anything unrecognisable is treated as no answer, not as consent.
 *
 *   The value is JSON written by an older release, and it is also a string any
 *   script on the origin can overwrite. Every failure here — malformed JSON, a
 *   missing field, a category that has since appeared — has to fall to "ask
 *   again". The alternative is a parse bug that reads as permission.
 */
export function parseConsent(raw: string | null): ConsentRecord | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Partial<ConsentRecord>;

  if (typeof record.version !== 'number') return null;
  if (typeof record.decidedAt !== 'string' || Number.isNaN(Date.parse(record.decidedAt))) {
    return null;
  }
  if (typeof record.choices !== 'object' || record.choices === null) return null;

  const choices = essentialOnly();
  for (const category of CONSENT_CATEGORIES) {
    const value = (record.choices as Record<string, unknown>)[category.id];
    if (category.required) continue;
    /*
     * A category the stored record has never heard of stays off, and
     * `hasAnswerFor` will report the record as incomplete so the person is
     * asked. Defaulting a missing category to `true` is the single most
     * expensive mistake available in this file.
     */
    if (typeof value === 'boolean') choices[category.id] = value;
  }

  return { version: record.version, decidedAt: record.decidedAt, choices };
}

/** Whether the record covers every category currently being asked about. */
export function hasAnswerFor(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const stored = JSON.parse(raw) as { choices?: Record<string, unknown> };
    const choices = stored?.choices ?? {};
    return optionalCategories().every((category) => typeof choices[category.id] === 'boolean');
  } catch {
    return false;
  }
}

export function isExpired(record: ConsentRecord, now: Date = new Date()): boolean {
  const age = now.getTime() - Date.parse(record.decidedAt);
  return age > CONSENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Whether to put the banner up.
 *
 * ⚠ A future `decidedAt` counts as expired rather than as fresh.
 *
 *   Device clocks drift and can be set by hand. A record stamped next year
 *   would otherwise never be re-asked; treating it as stale costs one extra
 *   prompt and closes the hole.
 */
export function shouldAsk(
  raw: string | null,
  now: Date = new Date(),
  version: number = CONSENT_VERSION,
): boolean {
  if (!consentNeeded()) return false;

  const record = parseConsent(raw);
  if (!record) return true;
  if (!hasAnswerFor(raw)) return true;
  if (record.version !== version) return true;
  if (Date.parse(record.decidedAt) > now.getTime()) return true;
  return isExpired(record, now);
}

/* ------------------------------------------------------------------ *
 * Storage and the gate
 * ------------------------------------------------------------------ */

type Listener = (choices: ConsentChoices) => void;
const listeners = new Set<Listener>();

/** Cached so `isAllowed` is a synchronous read a script loader can branch on. */
let current: ConsentChoices = essentialOnly();
let loaded = false;

function readRaw(): string | null {
  if (!consentApplies()) return null;
  try {
    return window.localStorage.getItem(CONSENT_STORAGE_KEY);
  } catch {
    /*
     * Safari in private mode, storage disabled by policy, quota exhausted.
     * No stored answer is the truthful reading, and it fails to "ask" rather
     * than to "allow".
     */
    return null;
  }
}

/** Loads the stored decision into memory. Safe to call repeatedly. */
export function loadConsent(now: Date = new Date()): ConsentChoices {
  const raw = readRaw();
  const record = parseConsent(raw);

  current =
    record && !shouldAsk(raw, now) ? { ...essentialOnly(), ...record.choices } : essentialOnly();
  loaded = true;
  return current;
}

export function currentConsent(): ConsentChoices {
  if (!loaded) loadConsent();
  return current;
}

/**
 * The gate. Everything that stores or sends anything non-essential asks this.
 *
 * Synchronous and safe before load: an unanswered question is a no.
 */
export function isAllowed(category: CategoryId): boolean {
  const definition = CONSENT_CATEGORIES.find((entry) => entry.id === category);
  if (definition?.required) return true;
  if (!consentApplies()) return false;
  return currentConsent()[category] === true;
}

/**
 * Records a decision and tells everything that cares.
 *
 * Returns false when the write failed, so the caller can decide what to say
 * rather than hiding a banner whose answer went nowhere — the person would be
 * asked again next load with no explanation.
 */
export function saveConsent(choices: ConsentChoices, now: Date = new Date()): boolean {
  const record: ConsentRecord = {
    version: CONSENT_VERSION,
    decidedAt: now.toISOString(),
    choices: { ...essentialOnly(), ...choices },
  };

  current = record.choices;
  loaded = true;

  let ok = false;
  if (consentApplies()) {
    try {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
      ok = true;
    } catch {
      ok = false;
    }
  }

  /*
   * Listeners run whether or not the write landed. The person's choice governs
   * this page view even if it cannot be remembered for the next one — and a
   * revocation especially must take effect now rather than after a reload.
   */
  for (const listener of [...listeners]) listener(current);
  return ok;
}

/** Forgets the decision entirely, so the banner asks again. */
export function clearConsent(): void {
  current = essentialOnly();
  loaded = true;
  if (consentApplies()) {
    try {
      window.localStorage.removeItem(CONSENT_STORAGE_KEY);
    } catch {
      /* Nothing to forget, or storage is unavailable. */
    }
  }
  for (const listener of [...listeners]) listener(current);
}

/** Subscribes to changes. Returns the unsubscribe. */
export function onConsentChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs `grant` while a category is permitted, and `revoke` when it stops being.
 *
 * ⚠ `revoke` is not optional in spirit, and it is the half people skip.
 *
 *   Withdrawing consent has to be as effective as giving it (GDPR Art. 7(3)).
 *   A gate that only ever loads a script means "off" stops *new* page views
 *   from being tracked and leaves the current one running, with its cookies
 *   still on the device. Whatever you pass as `grant` — a script tag, an SDK
 *   init — `revoke` has to undo, including deleting the cookies it set.
 *
 * Example, for whenever analytics actually arrive:
 *
 *     whenAllowed('analytics', () => loadPlausible(), () => removePlausible());
 */
export function whenAllowed(
  category: CategoryId,
  grant: () => void,
  revoke?: () => void,
): () => void {
  let active = false;

  const apply = () => {
    const allowed = isAllowed(category);
    if (allowed && !active) {
      active = true;
      grant();
    } else if (!allowed && active) {
      active = false;
      revoke?.();
    }
  };

  apply();
  const unsubscribe = onConsentChange(apply);

  return () => {
    unsubscribe();
    if (active) {
      active = false;
      revoke?.();
    }
  };
}
