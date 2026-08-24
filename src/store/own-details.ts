import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { saveProfile } from '@/store/driver-profile';

/**
 * Changing your own name or phone number, from the profile screen.
 *
 * ⚠ There are two ways to write these, and picking the wrong one is a way to
 *   launder an edit past review.
 *
 *   For someone with no driver application, name and phone are display data in
 *   `user_metadata`. Nobody is vetting them and nothing depends on them, so
 *   `auth.updateUser` is the whole story.
 *
 *   For a driver, they are not. `supabase/29_driver_profile_edits.sql` classes
 *   both as high risk: changing them suspends approval and files the old and
 *   new values for an admin, because a name change on an approved account is
 *   either a typo fix or somebody taking the account over, and only a person
 *   can tell those apart. `update_driver_profile` is what enforces that.
 *
 *   Writing metadata directly for a driver would change the name the app shows
 *   — the name a sender sees on the person collecting their parcel — while
 *   leaving the vetted application untouched and no review raised. That is the
 *   exact hole this function exists to close, which is why the branch is here,
 *   once, rather than in the screen.
 */
export type DetailsOutcome = { ok: true; suspended: boolean } | { ok: false; error: string };

export type OwnDetails = {
  name?: string;
  phone?: string;
};

export async function saveOwnDetails(
  patch: OwnDetails,
  /**
   * Whether this account has a driver application of any status.
   *
   * ⚠ Any status, not just approved.
   *
   *   A pending application is being read by an admin right now, and a rejected
   *   one may be appealed. Letting either edit its name through the metadata
   *   path would change what the reviewer is looking at underneath them.
   */
  hasDriverApplication: boolean,
): Promise<DetailsOutcome> {
  if (Object.keys(patch).length === 0) return { ok: true, suspended: false };

  if (hasDriverApplication) {
    const outcome = await saveProfile(patch);
    if (!outcome.ok) return { ok: false, error: outcome.error };
    return { ok: true, suspended: outcome.suspended };
  }

  try {
    const { error } = await supabase.auth.updateUser({ data: patch });
    if (error) return { ok: false, error: error.message };
    return { ok: true, suspended: false };
  } catch (thrown) {
    return { ok: false, error: errorMessage(thrown, 'Could not save your details.') };
  }
}

/**
 * When someone joined, for the profile header.
 *
 * ⚠ Returns null rather than a guess when there is no date.
 *
 *   The seeded demo owner has none, and a signed-in account whose
 *   `created_at` failed to parse has none either. "Member since January 1970"
 *   is what a silent fallback to zero produces, and it is worse than the row
 *   simply not appearing.
 */
export function memberSince(createdAt: string | null): string | null {
  if (!createdAt) return null;

  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return null;

  return at.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
