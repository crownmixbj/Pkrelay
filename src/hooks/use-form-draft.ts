import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps a long form's answers across navigation, reloads and sign-in.
 *
 * The driver application and the booking form both ask for an account at
 * *submit* rather than on entry, which is the right order — nobody should have
 * to sign in before seeing whether the thing is worth filling in. But it means
 * the app navigates away mid-form, and `useState` does not survive that:
 * `router.replace('/driver-signup')` after sign-in mounts a *new* screen, and
 * signing up leaves the app entirely for an email confirmation.
 *
 * So the answers live somewhere that outlives the component.
 *
 * ⚠ These drafts contain personal data — a NIN, a bank account number, a
 *   guarantor's details. Three mitigations, all deliberate:
 *
 *     1. They expire (`TTL_MS`), so an abandoned draft doesn't sit on a device
 *        indefinitely.
 *     2. They are cleared on successful submit — the server has it now.
 *     3. They are cleared on sign-out, which is the "I'm done on this shared
 *        computer" signal.
 *
 *   On web this is `localStorage`, readable by any script on the origin. That
 *   is the same place the session token lives, so it is not a new class of
 *   exposure — but if you ever decide a half-finished application is too
 *   sensitive to keep locally, `DRAFT_KEYS` below is the list to stop writing.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Every draft this app writes, so sign-out can clear the lot. */
export const DRAFT_KEYS = ['loci.draft.driver-application', 'loci.draft.booking'] as const;

export type DraftKey = (typeof DRAFT_KEYS)[number];

type Stored<T> = { savedAt: number; value: T };

/**
 * Restores a saved draft onto the current shape of a form.
 *
 * ⚠ Never `setForm(draft)`. That is the bug this exists to prevent, and it
 *   ships silently.
 *
 *   A draft is JSON written by a *previous version of the app*. Add a field and
 *   every draft on every device is missing it; the form is replaced wholesale
 *   with the old shape, and the first line of validation that reads
 *   `form.newField.trim()` throws on a value TypeScript swears is a string.
 *
 *   That is exactly how `guarantorEmail` crashed the driver application: the
 *   type was right, the form was right, and a day-old draft was not. Nothing in
 *   development catches it, because a developer adding a field has no draft
 *   from before they added it.
 *
 * ⚠ Keys the form no longer has are dropped, not carried.
 *
 *   Drafts also outlive *removals* — `guarantorNin` and `guarantorAddress` were
 *   taken off this form last week and are still sitting in storage. Spreading
 *   the saved object over the defaults would keep them, quietly reintroducing
 *   fields the app has deliberately stopped collecting. Only keys the current
 *   shape declares survive.
 */
export function mergeDraft<T extends object>(defaults: T, saved: unknown): T {
  if (!saved || typeof saved !== 'object') return defaults;

  const stored = saved as Record<string, unknown>;
  const merged = { ...defaults } as Record<string, unknown>;

  for (const key of Object.keys(defaults)) {
    const value = stored[key];
    /*
     * `undefined` means the draft predates the field; the default stands.
     * `null` is a real stored value for the nullable ones, so it passes.
     */
    if (value !== undefined) merged[key] = value;
  }

  return merged as T;
}

export async function clearAllDrafts(): Promise<void> {
  await AsyncStorage.multiRemove([...DRAFT_KEYS]);
}

/**
 * Returns the restored draft (or null while loading / when there isn't one),
 * a setter that persists, and a way to clear it.
 *
 * `ready` matters: a form must not render its empty initial state, let the user
 * start typing, and *then* overwrite it with a restored draft. Callers wait.
 */
export function useFormDraft<T extends object>(key: DraftKey) {
  const [draft, setDraft] = useState<T | null>(null);
  const [ready, setReady] = useState(false);

  // Writes are debounced: a form fires onChangeText per keystroke, and hitting
  // storage that often is wasteful and janky on a slow device.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;

    AsyncStorage.getItem(key)
      .then((raw) => {
        if (!active) return;

        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Stored<T>;

            if (Date.now() - parsed.savedAt < TTL_MS) {
              setDraft(parsed.value);
            } else {
              // Expired. Remove it rather than leaving it to rot.
              void AsyncStorage.removeItem(key);
            }
          } catch {
            // A corrupt draft is not worth surfacing — start clean.
            void AsyncStorage.removeItem(key);
          }
        }
      })
      .finally(() => {
        if (active) setReady(true);
      });

    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key]);

  const save = useCallback(
    (value: T) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void AsyncStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }));
      }, 400);
    },
    [key],
  );

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setDraft(null);
    return AsyncStorage.removeItem(key);
  }, [key]);

  return { draft, ready, save, clear };
}
