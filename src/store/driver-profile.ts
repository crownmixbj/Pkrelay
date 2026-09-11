import { supabase } from '@/lib/supabase';

/**
 * What an approved driver may change about themselves.
 *
 * The classification below mirrors `public.driver_field_risk` in
 * `supabase/migrations/20250101000029_driver_profile_edits.sql`, and the verification suite asserts
 * the two agree field for field. The client copy exists so a form can grey out
 * a locked field and warn before a high-risk one — not so it can decide. The
 * server refuses independently, and a client that disagreed would simply get an
 * error it could not have predicted.
 */

export type FieldRisk = 'low' | 'high' | 'locked';

/**
 * ⚠ Unknown fields are `locked`, matching the SQL.
 *
 *   Defaulting to `low` would mean any column added later became editable by
 *   the driver it describes on the day it was created. The default has to be
 *   refusal in both copies, or they disagree the first time the schema grows.
 */
export const FIELD_RISK: Record<string, FieldRisk> = {
  vehicle_type: 'low',
  vehicle_colour: 'low',
  plate_number: 'low',
  base_city: 'low',
  address: 'low',
  kin_name: 'low',
  kin_phone: 'low',
  kin_relationship: 'low',

  full_name: 'high',
  nin: 'high',
  license_id: 'high',
  guarantor_name: 'high',
  guarantor_phone: 'high',
  guarantor_relationship: 'high',
  guarantor_address: 'high',
  guarantor_nin: 'high',
  documents: 'high',

  phone: 'locked',
  email: 'locked',
  bank_name: 'locked',
  account_number: 'locked',
  account_name: 'locked',
};

export function fieldRisk(field: string): FieldRisk {
  return FIELD_RISK[field] ?? 'locked';
}

/** The riskiest thing in a patch, which is what decides the consequence. */
export function patchRisk(patch: Record<string, unknown>): FieldRisk {
  const risks = Object.keys(patch).map(fieldRisk);
  if (risks.includes('locked')) return 'locked';
  if (risks.includes('high')) return 'high';
  return 'low';
}

/**
 * What to tell a driver before they save.
 *
 * Said in advance, not after. A driver who taps Save and *then* discovers they
 * are suspended pending review has been ambushed by their own app — and the one
 * thing they cannot do at that point is undo it.
 */
export function editWarning(patch: Record<string, unknown>): string | null {
  switch (patchRisk(patch)) {
    case 'locked':
      return 'Some of these details cannot be changed here. Bank details go through Payout settings; contact support to change your phone or email.';
    case 'high':
      return 'Changing your identity details sends your account back for review. You will not be offered new trips until an admin approves it, and you cannot do this while carrying a parcel.';
    case 'low':
      return null;
  }
}

/**
 * Only what actually differs.
 *
 * ⚠ This is load-bearing, not a tidy-up.
 *
 *   `update_driver_profile` decides the consequence from the *keys* of the
 *   patch, before it looks at any value. Posting the whole form back would put
 *   `full_name` in every patch — so a driver correcting their plate number
 *   would be sent back for review, lose their approval, and be unable to accept
 *   work, for a change they did not make.
 *
 *   The server does skip unchanged values when writing history, but by then it
 *   has already classified the patch as high-risk. The diff has to happen here.
 *
 * Trailing whitespace is stripped before comparing: a stray space picked up
 * from a keyboard suggestion is not an edit, and treating it as one would
 * suspend somebody over an invisible character.
 */
export function changedFields(
  original: Record<string, unknown>,
  edited: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(edited)) {
    const before =
      typeof original[key] === 'string' ? (original[key] as string).trim() : original[key];
    const after = typeof value === 'string' ? value.trim() : value;

    // `null` and `''` are the same absence on a nullable column; a driver
    // clearing a field they never filled is not a change.
    const same = before === after || ((before ?? '') === '' && (after ?? '') === '');

    if (!same) patch[key] = after;
  }

  return patch;
}

export type ProfileEditOutcome =
  { ok: true; status: string; suspended: boolean } | { ok: false; error: string };

/**
 * Saves a patch.
 *
 * ⚠ The server's message is passed through verbatim on failure.
 *
 *   Every refusal here is actionable and specific: finish your trip, use Payout
 *   settings, contact support. Replacing them with "could not save" would leave
 *   a driver pressing the same button against a rule they cannot see.
 */
export async function saveProfile(patch: Record<string, unknown>): Promise<ProfileEditOutcome> {
  const { data, error } = await supabase.rpc('update_driver_profile', { patch });

  if (error) return { ok: false, error: error.message };

  const status = String(data ?? 'approved');
  return { ok: true, status, suspended: status === 'under_review' };
}

export type EditHistoryEntry = {
  field: string;
  risk: 'low' | 'high';
  /** Last few characters only — see `my_edit_history` for why. */
  oldHint: string | null;
  newHint: string | null;
  suspendedApproval: boolean;
  createdAt: string;
};

/**
 * This driver's own edit trail.
 *
 * Worth surfacing rather than keeping for support: a driver seeing a change
 * they did not make is the earliest anyone finds out an account was taken over.
 */
export async function fetchEditHistory(limit = 50): Promise<EditHistoryEntry[]> {
  const { data, error } = await supabase.rpc('my_edit_history', { limit_rows: limit });

  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    field: String(row.field),
    risk: row.risk === 'high' ? 'high' : 'low',
    oldHint: (row.old_hint as string | null) ?? null,
    newHint: (row.new_hint as string | null) ?? null,
    suspendedApproval: row.suspended_approval === true,
    createdAt: String(row.created_at),
  }));
}

/** Human labels, so a history row does not read as a column name. */
export const FIELD_LABELS: Record<string, string> = {
  vehicle_type: 'Vehicle type',
  vehicle_colour: 'Vehicle colour',
  plate_number: 'Plate number',
  base_city: 'Base city',
  address: 'Address',
  kin_name: 'Next of kin',
  kin_phone: 'Next of kin phone',
  kin_relationship: 'Next of kin relationship',
  full_name: 'Legal name',
  nin: 'NIN',
  license_id: "Driver's licence",
  guarantor_name: 'Guarantor',
  guarantor_phone: 'Guarantor phone',
  guarantor_relationship: 'Guarantor relationship',
  guarantor_address: 'Guarantor address',
  guarantor_nin: 'Guarantor NIN',
  documents: 'Documents',
};

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field;
