import { normalizePhone } from '@/lib/handoff';

/**
 * The number a driver application must carry.
 *
 * A driver application is a claim about a person, and the account it is made
 * from is the only thing Package Relay knows about that person independently. Letting an
 * applicant type a different number breaks the link — two records that look
 * like the same driver but cannot be joined, and a support call that reaches
 * whoever answers the number typed rather than the person who signed up.
 *
 * The rule is enforced in `supabase/migrations/20250101000016_driver_identity.sql`, by a trigger. This
 * module exists so the form can behave well: prepopulate, lock, and explain the
 * refusal in a sentence rather than a constraint violation.
 */

/**
 * Whether a typed number is the same number as the registered one.
 *
 * Compared after normalising, because `08031234567` and `+2348031234567` are
 * the same number and a driver told otherwise would reasonably conclude the app
 * is broken.
 */
export function phoneMatchesAccount(typed: string, registered: string): boolean {
  const a = normalizePhone(typed);
  const b = normalizePhone(registered);
  if (!a || !b) return false;
  return a === b;
}

/**
 * True when the account has a usable number to lock the field to.
 *
 * Accounts created before sign-up captured a phone have none. The field stays
 * editable for them rather than locking to an empty string — a locked empty
 * field is a form nobody can submit, which is a worse failure than an unlocked
 * one.
 */
export function hasRegisteredPhone(registered: string | null | undefined): boolean {
  return normalizePhone(registered ?? '') !== null;
}

/** The registered number in the shape the form should display. */
export function displayRegisteredPhone(registered: string): string {
  return normalizePhone(registered) ?? registered;
}

/**
 * Puts the account's number back into a form, wherever that form came from.
 *
 * ⚠ The prefill effect is not enough on its own, and this is why.
 *
 *   The form is rebuilt from `INITIAL_FORM` in three places — first render, the
 *   saved-draft restore, and the reset after a submitted application. All three
 *   set `phone` to an empty string. The effect that fills it is keyed on
 *   `[phoneLocked, registeredPhone]`, and both of those are stable once the
 *   session has settled, so after the first fill it never fires again: a draft
 *   saved during the half-second before the session restored, or a reset after a
 *   rejection, leaves a LOCKED field empty with no way to type into it and no
 *   effect that will refill it. The applicant then meets "Phone number is
 *   required" on a field they cannot edit, which is a dead end.
 *
 *   Applying this at each rebuild makes the account the authority rather than
 *   whatever the previous form state happened to hold.
 *
 * ⚠ Only when the account HAS a number.
 *
 *   An account created before sign-up captured a phone keeps its editable, empty
 *   field — overwriting that with '' would be the same no-op, but returning the
 *   form untouched says plainly that there was nothing to apply.
 */
export function withRegisteredPhone<T extends { phone: string }>(
  form: T,
  registered: string | null | undefined,
): T {
  if (!hasRegisteredPhone(registered)) return form;

  const wanted = displayRegisteredPhone(registered ?? '');
  return form.phone === wanted ? form : { ...form, phone: wanted };
}

export const PHONE_LOCK_TITLE = 'Use your registered number';

/**
 * What the modal says.
 *
 * Names both numbers. "That number does not match" leaves someone staring at a
 * field wondering which of their two SIMs the account was made with, and the
 * answer is one they cannot see from here.
 */
export function phoneLockMessage(registered: string): string {
  return `This application has to use the phone number on your Package Relay account: ${displayRegisteredPhone(
    registered,
  )}.\n\nIt is how a driver is reached about a parcel, and how your application is matched to your account. To apply with a different number, change it on your account first — or sign in with the account that uses it.`;
}
