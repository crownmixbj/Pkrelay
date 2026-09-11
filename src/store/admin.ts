import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import type { ApplicationStatus } from '@/store/driver-applications';

/**
 * The Admin area's data access.
 *
 * Everything here goes through Row Level Security or a `security definer`
 * function that checks `is_admin()` server-side. Nothing in this file is the
 * security boundary — hiding the Admin nav entry is a courtesy, and these calls
 * simply fail for a non-admin. See `supabase/migrations/20250101000007_admin.sql`.
 */

// ------------------------------------------------------------- overview -----

export type AdminOverview = {
  users: number;
  admins: number;
  applicationsPending: number;
  applicationsUnderReview: number;
  driversApproved: number;
  applicationsRejected: number;
  parcelsTotal: number;
  parcelsUnclaimed: number;
  parcelsInTransit: number;
  parcelsDelivered: number;
  parcelsLast7Days: number;
  errorsLast24h: number;
};

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));

/**
 * Platform counts.
 *
 * Deliberately aggregates rather than rows: "how many parcels moved this week"
 * is an operational question, and answering it does not require an admin to see
 * anyone's recipient address. The function returns numbers only.
 */
export async function fetchOverview(): Promise<AdminOverview> {
  const { data, error } = await supabase.rpc('admin_overview');
  if (error) throw error;

  const raw = (data ?? {}) as Record<string, unknown>;

  return {
    users: num(raw.users),
    admins: num(raw.admins),
    applicationsPending: num(raw.applications_pending),
    applicationsUnderReview: num(raw.applications_under_review),
    driversApproved: num(raw.drivers_approved),
    applicationsRejected: num(raw.applications_rejected),
    parcelsTotal: num(raw.parcels_total),
    parcelsUnclaimed: num(raw.parcels_unclaimed),
    parcelsInTransit: num(raw.parcels_in_transit),
    parcelsDelivered: num(raw.parcels_delivered),
    parcelsLast7Days: num(raw.parcels_last_7_days),
    errorsLast24h: num(raw.errors_last_24h),
  };
}

export type CityVolume = { city: string; total: number; active: number };

export async function fetchCityVolumes(): Promise<CityVolume[]> {
  const { data, error } = await supabase.rpc('admin_city_volumes');
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    city: String(row.city ?? ''),
    total: num(row.total),
    active: num(row.active),
  }));
}

// ---------------------------------------------------------------- users -----

export type AdminUser = {
  id: string;
  fullName: string;
  phone: string;
  isAdmin: boolean;
  createdAt: string;
  /** Set while the person is barred from accepting jobs. Reversible. */
  drivingBannedAt: string | null;
  banReason: string | null;
  /** Set once erased. The account keeps its login but every policy refuses it. */
  deletedAt: string | null;
};

/**
 * Every account.
 *
 * Readable only because `20250101000007_admin.sql` adds an admin-only select policy on
 * `profiles`. Without it this returns exactly one row — the caller's own — which
 * is what it did before, and why this screen could not exist.
 */
export async function fetchUsers(): Promise<AdminUser[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select(
      'id, full_name, phone, is_admin, created_at, driving_banned_at, driving_ban_reason, deleted_at',
    )
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    fullName: String(row.full_name ?? ''),
    phone: String(row.phone ?? ''),
    isAdmin: Boolean(row.is_admin),
    createdAt: String(row.created_at ?? ''),
    drivingBannedAt: (row.driving_banned_at as string | null) ?? null,
    banReason: (row.driving_ban_reason as string | null) ?? null,
    deletedAt: (row.deleted_at as string | null) ?? null,
  }));
}

/**
 * Bar a driver from accepting jobs, or lift it.
 *
 * The account keeps working as a customer — banning revokes driving, not the
 * login. Enforced by `is_approved_driver()`, which the claim policy on
 * `bookings` already calls, so the ban applies to the feed and the claim at
 * once rather than being a UI condition someone can route around.
 *
 * A reason is required by the server when banning. A ban nobody can explain six
 * months later is a ban that cannot be defended or lifted with confidence.
 */
export async function setDrivingBan(
  targetId: string,
  banned: boolean,
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc('set_driving_ban', {
    target_id: targetId,
    banned,
    note: reason ?? null,
  });

  if (error) throw error;
}

/**
 * Erase a person: irreversible.
 *
 * Overwrites every identifying field across the profile, the booking rows and
 * the driver application, deletes the uploaded documents, and blocks the
 * account. Parcels survive — the sender's own delivery history is theirs, and
 * destroying it to satisfy someone else's erasure would be the wrong trade.
 *
 * ⚠ Two steps, and the second is allowed to fail.
 *
 *   `erase_person` does the substantive work: every identifying field across
 *   ten tables, and the stored documents behind them. Removing the *login*
 *   needs the service key, so it is an Edge Function — and a project that has
 *   not deployed it can still erase people properly.
 *
 *   So a failure at step two does not undo step one, and it does not throw.
 *   Rolling back a completed scrub because the login survived would leave the
 *   data in place, which is the outcome erasure exists to prevent. The caller
 *   is told which of the two happened.
 */
export type EraseOutcome = {
  /** The scrub. If this is false, `erasePerson` threw and you never see it. */
  scrubbed: true;
  /** Whether the auth login was removed as well. */
  loginRemoved: boolean;
  /** Why not, when it was not. Null when the login is gone. */
  loginError: string | null;
};

export async function erasePerson(targetId: string, reason?: string): Promise<EraseOutcome> {
  const { error } = await supabase.rpc('erase_person', {
    target_id: targetId,
    note: reason ?? null,
  });

  if (error) throw error;

  /*
   * The login, best effort.
   *
   * `invoke` rejects on a non-2xx, and the function answers 501 when a project
   * has no service key — which is the ordinary state of a fresh deployment, not
   * an incident. Either way the person's data is already gone.
   */
  try {
    const { error: fnError } = await supabase.functions.invoke('erase-auth-user', {
      body: { user_id: targetId },
    });

    if (fnError) {
      return { scrubbed: true, loginRemoved: false, loginError: fnError.message };
    }
    return { scrubbed: true, loginRemoved: true, loginError: null };
  } catch (thrown) {
    return {
      scrubbed: true,
      loginRemoved: false,
      loginError: errorMessage(
        thrown,
        'The erase-auth-user function is not deployed on this project.',
      ),
    };
  }
}

/**
 * Just enough of each driver application to segment the user list.
 *
 * Deliberately not `fetchAllApplications`. That returns whole rows — NIN, bank
 * account, guarantor — and the user list needs none of it. Pulling the full
 * record into a screen that only wants to print "Approved" would put those
 * fields in the client's memory for no reason, and eventually into a log or a
 * crash report.
 */
export type ApplicationSummary = {
  userId: string;
  /*
   * ⚠ The shared type, not a second hand-written union.
   *
   *   This listed the four statuses inline, and adding two to
   *   `ApplicationStatus` left it silently wrong — a `ready_for_review` row
   *   would have been cast to a value this type says is impossible, and
   *   anything switching on it would have fallen through. Two hand-written
   *   lists of the same thing always drift; the compiler only catches it when
   *   they are the same list.
   */
  status: ApplicationStatus;
  reference: string;
  submittedAt: string;
};

export async function fetchApplicationSummaries(): Promise<ApplicationSummary[]> {
  const { data, error } = await supabase
    .from('driver_applications')
    .select('user_id, status, reference, submitted_at');

  if (error) throw error;

  return (data ?? []).map((row) => ({
    userId: String(row.user_id),
    status: row.status as ApplicationSummary['status'],
    reference: String(row.reference ?? ''),
    submittedAt: String(row.submitted_at ?? ''),
  }));
}

/**
 * Promote or demote.
 *
 * A function call, not an update: `profiles.is_admin` is un-writable by any
 * client, and this is the single audited path around that. The server refuses
 * to let you change your own row, and refuses to remove the last admin — both
 * surface here as thrown errors with messages worth showing verbatim.
 */
export async function setAdminRole(
  targetId: string,
  makeAdmin: boolean,
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc('set_admin_role', {
    target_id: targetId,
    make_admin: makeAdmin,
    note: reason ?? null,
  });

  if (error) throw error;
}

export type RoleGrant = {
  id: string;
  subjectId: string;
  actorId: string;
  granted: boolean;
  reason: string | null;
  createdAt: string;
};

/** The audit trail. Every row was written by `set_admin_role`, never a client. */
export async function fetchRoleGrants(limit = 25): Promise<RoleGrant[]> {
  const { data, error } = await supabase
    .from('role_grants')
    .select('id, subject_id, actor_id, granted, reason, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    subjectId: String(row.subject_id),
    actorId: String(row.actor_id),
    granted: Boolean(row.granted),
    reason: (row.reason as string | null) ?? null,
    createdAt: String(row.created_at ?? ''),
  }));
}

// --------------------------------------------------------------- events -----

export type EventLevel = 'info' | 'warning' | 'error';

export type AppEvent = {
  id: string;
  level: EventLevel;
  area: string;
  message: string;
  context: Record<string, unknown>;
  actorId: string | null;
  createdAt: string;
};

export async function fetchEvents(options?: {
  level?: EventLevel | 'all';
  limit?: number;
}): Promise<AppEvent[]> {
  let query = supabase
    .from('app_events')
    .select('id, level, area, message, context, actor_id, created_at')
    .order('created_at', { ascending: false })
    .limit(options?.limit ?? 100);

  if (options?.level && options.level !== 'all') {
    query = query.eq('level', options.level);
  }

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    level: (row.level as EventLevel) ?? 'info',
    area: String(row.area ?? ''),
    message: String(row.message ?? ''),
    context: (row.context as Record<string, unknown>) ?? {},
    actorId: (row.actor_id as string | null) ?? null,
    createdAt: String(row.created_at ?? ''),
  }));
}

/**
 * Records something that went wrong.
 *
 * Fire-and-forget, and it swallows its own failure on purpose: a logger that
 * throws turns a handled error into an unhandled one, and the thing being
 * logged is more important than the log.
 *
 * ⚠ `context` reaches a table an admin can read. Do not put a NIN, a bank
 *   account, an address or a phone number in it — put an id and let the reader
 *   look it up under the policies that govern that data.
 */
export async function logEvent(
  level: EventLevel,
  area: string,
  message: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  try {
    await supabase.from('app_events').insert({
      level,
      area,
      // Truncated: an error message can be a whole HTML page from a proxy, and
      // a log row that big is unreadable in the viewer and expensive to store.
      message: message.slice(0, 500),
      context,
    });
  } catch {
    // Nothing to do. Failing to log must never mask the original failure.
  }
}

// -------------------------------------------- where the backlog is going ----

export type UnassignedDestination = {
  city: string;
  parcels: number;
  /** Hours the oldest has been waiting. */
  oldestHours: number;
  /** How many are currently out with a driver on a live dispatch offer. */
  offered: number;
};

/**
 * Unassigned parcels, grouped by destination.
 *
 * "Unclaimed: 14" says there is a problem. This says whether it is fourteen
 * parcels for Kano or one each across fourteen cities — a different problem
 * with a different fix, and not derivable from the count.
 *
 * `offered` matters as much as the total: a backlog that is being actively
 * worked by dispatch looks identical to one nobody has touched, unless you
 * separate them.
 */
export async function fetchUnassignedByDestination(): Promise<UnassignedDestination[]> {
  const { data, error } = await supabase.rpc('admin_unassigned_by_destination');
  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    city: String(row.city ?? ''),
    parcels: num(row.parcels),
    oldestHours: num(row.oldest_hours),
    offered: num(row.offered),
  }));
}

/**
 * How long the oldest parcel has waited, in words.
 *
 * Hours below a day, then days — because "73.4 hours" is a number an operator
 * has to do arithmetic on, and the arithmetic is the only part that matters.
 */
export function waitedLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  if (hours < 1) return 'under an hour';
  if (hours < 24) return `${Math.round(hours)}h`;

  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

// ----------------------------------------------------- parcels, for an admin ---

/**
 * What an operator sees about a parcel.
 *
 * No names and no phone numbers. `admin_parcel_detail` in
 * `supabase/migrations/20250101000017_admin_parcel_detail.sql` returns a fixed shape that excludes
 * them — there is still no admin read policy on `bookings`, so this is the only
 * way in, and it decides what "the whole parcel" means rather than the caller.
 */
export type AdminParcelDetail = {
  id: string;
  trackingId: string;
  status: string;
  deliveryType: string;
  originCity: string;
  destinationCity: string;
  pickupArea: string;
  dropoffArea: string;
  pickupMode: string;
  dropoffMode: string;
  weight: number;
  declaredValue: number;
  estimatedFee: number;
  category: string;
  fragile: boolean;
  createdAt: string | null;
  acceptedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  driverName: string | null;
  driverId: string | null;
  hasSenderPhoto: boolean;
  /*
    The parcel's own photograph, as an object path rather than a boolean.

    Unlike the sender's face this is operational — a box on a table — so it
    comes back with the rest of the detail rather than through the audited
    reveal. See `20250101000036_parcel_photos.sql` for the split.
  */
  itemPhotoPath: string | null;
  livenessStatus: string | null;
  offersMade: number;
  offerOutstanding: boolean;
};

export type AdminParcelRow = {
  id: string;
  trackingId: string;
  status: string;
  originCity: string;
  destinationCity: string;
  weight: number;
  estimatedFee: number;
  createdAt: string | null;
  driverName: string | null;
  offerOutstanding: boolean;
};

export type ParcelScope = 'unassigned' | 'assigned' | 'all';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const maybeText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export async function fetchAdminParcels(
  scope: ParcelScope,
  city?: string,
): Promise<AdminParcelRow[]> {
  const { data, error } = await supabase.rpc('admin_parcels', {
    scope,
    city: city ?? null,
    max_rows: 50,
  });
  if (error || !data) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    id: text(row.id),
    trackingId: text(row.tracking_id),
    status: text(row.status),
    originCity: text(row.origin_city),
    destinationCity: text(row.destination_city),
    weight: num(row.weight),
    estimatedFee: num(row.estimated_fee),
    createdAt: maybeText(row.created_at),
    driverName: maybeText(row.driver_name),
    offerOutstanding: row.offer_outstanding === true,
  }));
}

export async function fetchAdminParcelDetail(id: string): Promise<AdminParcelDetail | null> {
  const { data, error } = await supabase.rpc('admin_parcel_detail', { booking_id: id });
  if (error || !data) return null;

  const row = (data as Record<string, unknown>[])[0];
  if (!row) return null;

  return {
    id: text(row.id),
    trackingId: text(row.tracking_id),
    status: text(row.status),
    deliveryType: text(row.delivery_type),
    originCity: text(row.origin_city),
    destinationCity: text(row.destination_city),
    pickupArea: text(row.pickup_area),
    dropoffArea: text(row.dropoff_area),
    pickupMode: text(row.pickup_mode),
    dropoffMode: text(row.dropoff_mode),
    weight: num(row.weight),
    declaredValue: num(row.declared_value),
    estimatedFee: num(row.estimated_fee),
    category: text(row.category),
    fragile: row.fragile === true,
    createdAt: maybeText(row.created_at),
    acceptedAt: maybeText(row.accepted_at),
    pickedUpAt: maybeText(row.picked_up_at),
    deliveredAt: maybeText(row.delivered_at),
    cancelledAt: maybeText(row.cancelled_at),
    cancellationReason: maybeText(row.cancellation_reason),
    driverName: maybeText(row.driver_name),
    driverId: maybeText(row.driver_id),
    hasSenderPhoto: row.has_sender_photo === true,
    itemPhotoPath: maybeText(row.item_photo_path),
    livenessStatus: maybeText(row.liveness_status),
    offersMade: num(row.offers_made),
    offerOutstanding: row.offer_outstanding === true,
  };
}

export type ParcelContacts = {
  pickupContactName: string;
  senderPhone: string;
  pickupAddress: string;
  recipientName: string;
  recipientPhone: string;
  dropoffAddress: string;
};

/**
 * The names, numbers and addresses — and a line in the audit log naming the
 * admin who asked and the parcel they asked about.
 *
 * Deliberately a second call. Folding it into the detail fetch would put a
 * customer's home address on screen every time somebody opened a stuck parcel,
 * and would fill the audit log with entries nobody could act on.
 */
export async function revealParcelContacts(
  id: string,
  reason?: string,
): Promise<ParcelContacts | null> {
  const { data, error } = await supabase.rpc('admin_reveal_parcel_contacts', {
    booking_id: id,
    reason: reason?.trim() || null,
  });
  if (error || !data) return null;

  const row = (data as Record<string, unknown>[])[0];
  if (!row) return null;

  return {
    pickupContactName: text(row.pickup_contact_name),
    senderPhone: text(row.sender_phone),
    pickupAddress: text(row.pickup_address),
    recipientName: text(row.recipient_name),
    recipientPhone: text(row.recipient_phone),
    dropoffAddress: text(row.dropoff_address),
  };
}

/** How long a parcel has been waiting, from its creation timestamp. */
export function ageLabel(createdAt: string | null, now: Date = new Date()): string {
  if (!createdAt) return '—';
  const ms = now.getTime() - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return waitedLabel(ms / 3_600_000);
}
