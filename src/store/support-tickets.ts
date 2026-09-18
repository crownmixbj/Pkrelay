import { supabase } from '@/lib/supabase';

/**
 * The support queue's data access, both sides of it.
 *
 * Every admin call is a `security definer` function that checks `is_admin()`
 * server-side — see `supabase/migrations/20250101000059_support_tickets.sql`.
 * Nothing in this file is the security boundary: a non-admin calling one gets
 * an exception, which is what the screen above is built on rather than a
 * fallback it hopes for.
 *
 * ⚠ The two halves of this file do not share a read path, on purpose.
 *
 *   A customer reads their own tickets straight from the table under RLS, and
 *   the policy there cannot return an internal note. An admin reads through
 *   `admin_support_*`, which can. Folding both onto one function — "return the
 *   thread, hide the notes if you are not staff" — would put that decision in
 *   one `if` instead of in the policy, and the day somebody widens the shape is
 *   the day operational notes start arriving in the customer's app.
 */

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const maybeText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

// ---------------------------------------------------------- the vocabulary --

/**
 * The four states a ticket moves through.
 *
 * ⚠ `waiting_on_customer` is the one that earns its place. Without it, a ticket
 *   we are not holding up sits in `in_progress` beside the ones we are, and
 *   "how many people are waiting on us" stops being answerable.
 */
export type TicketStatus = 'open' | 'in_progress' | 'waiting_on_customer' | 'resolved';

export const TICKET_STATUSES: readonly TicketStatus[] = [
  'open',
  'in_progress',
  'waiting_on_customer',
  'resolved',
] as const;

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  waiting_on_customer: 'Waiting on customer',
  resolved: 'Resolved',
};

/**
 * What the queue can be filtered to.
 *
 * ⚠ `awaiting_us` and `unresolved` are filters, not statuses, and the
 *   distinction is load-bearing: `awaiting_us` crosses three statuses — it is
 *   "the customer spoke last and it is not resolved" — which is the view an
 *   operator actually works from. Making it a fifth status would have put a
 *   value in the check constraint that nobody ever sets by hand.
 */
export type TicketFilter = 'awaiting_us' | 'unresolved' | TicketStatus | 'all';

export const TICKET_FILTERS: readonly TicketFilter[] = [
  'awaiting_us',
  'unresolved',
  'open',
  'in_progress',
  'waiting_on_customer',
  'resolved',
  'all',
] as const;

export const TICKET_FILTER_LABELS: Record<TicketFilter, string> = {
  awaiting_us: 'Awaiting us',
  unresolved: 'All open',
  open: 'Open',
  in_progress: 'In Progress',
  waiting_on_customer: 'Waiting on customer',
  resolved: 'Resolved',
  all: 'Everything',
};

export type TicketCategory = 'parcel' | 'payment' | 'driver_application' | 'account' | 'other';

export const TICKET_CATEGORIES: readonly TicketCategory[] = [
  'parcel',
  'payment',
  'driver_application',
  'account',
  'other',
] as const;

export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  parcel: 'A parcel',
  payment: 'Payment or refund',
  driver_application: 'Driving with us',
  account: 'My account',
  other: 'Something else',
};

export type TicketChannel = 'app' | 'phone' | 'email';

export const TICKET_CHANNEL_LABELS: Record<TicketChannel, string> = {
  app: 'In-app',
  phone: 'Phone',
  email: 'Email',
};

const asStatus = (value: unknown): TicketStatus =>
  TICKET_STATUSES.includes(value as TicketStatus) ? (value as TicketStatus) : 'open';

const asCategory = (value: unknown): TicketCategory =>
  TICKET_CATEGORIES.includes(value as TicketCategory) ? (value as TicketCategory) : 'other';

const asChannel = (value: unknown): TicketChannel =>
  value === 'phone' || value === 'email' ? value : 'app';

/** Which side spoke last. Drives the whole "is this ours to answer" reading. */
export type LastWord = 'customer' | 'admin';

// --------------------------------------------------------------- the tiles --

export type TicketCounts = {
  open: number;
  inProgress: number;
  waitingOnCustomer: number;
  resolved: number;
  resolvedLast7Days: number;
  /** Not resolved, and the customer spoke last. The number that is a queue. */
  awaitingUs: number;
  /** Never answered by anybody. Should be zero every evening. */
  unanswered: number;
  unassigned: number;
  oldestWaitingHours: number;
};

export const EMPTY_COUNTS: TicketCounts = {
  open: 0,
  inProgress: 0,
  waitingOnCustomer: 0,
  resolved: 0,
  resolvedLast7Days: 0,
  awaitingUs: 0,
  unanswered: 0,
  unassigned: 0,
  oldestWaitingHours: 0,
};

export async function fetchTicketCounts(): Promise<TicketCounts> {
  const { data, error } = await supabase.rpc('admin_support_counts');
  if (error) throw error;

  const raw = (data ?? {}) as Record<string, unknown>;

  return {
    open: num(raw.open),
    inProgress: num(raw.in_progress),
    waitingOnCustomer: num(raw.waiting_on_customer),
    resolved: num(raw.resolved),
    resolvedLast7Days: num(raw.resolved_last_7_days),
    awaitingUs: num(raw.awaiting_us),
    unanswered: num(raw.unanswered),
    unassigned: num(raw.unassigned),
    oldestWaitingHours: num(raw.oldest_waiting_hours),
  };
}

// ---------------------------------------------------------------- the queue --

export type TicketRow = {
  id: string;
  reference: string;
  status: TicketStatus;
  category: TicketCategory;
  channel: TicketChannel;
  subject: string;
  requesterId: string;
  requesterName: string;
  /** Whether this account drives. A driver's "where is my money" is not a sender's. */
  requesterIsDriver: boolean;
  /** Null once the parcel is gone; `trackingId` outlives it. */
  bookingId: string | null;
  trackingId: string | null;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  firstResponseAt: string | null;
  lastMessageAt: string;
  lastMessageFrom: LastWord;
  messageCount: number;
  createdAt: string | null;
  resolvedAt: string | null;
};

const toRow = (row: Record<string, unknown>): TicketRow => ({
  id: text(row.id),
  reference: text(row.reference),
  status: asStatus(row.status),
  category: asCategory(row.category),
  channel: asChannel(row.channel),
  subject: text(row.subject),
  requesterId: text(row.requester_id),
  requesterName: text(row.requester_name),
  requesterIsDriver: row.requester_is_driver === true,
  bookingId: maybeText(row.booking_id),
  trackingId: maybeText(row.booking_tracking_id),
  assignedAdminId: maybeText(row.assigned_admin_id),
  assignedAdminName: maybeText(row.assigned_admin_name),
  firstResponseAt: maybeText(row.first_response_at),
  lastMessageAt: text(row.last_message_at),
  lastMessageFrom: row.last_message_from === 'admin' ? 'admin' : 'customer',
  messageCount: num(row.message_count),
  createdAt: maybeText(row.created_at),
  resolvedAt: maybeText(row.resolved_at),
});

export async function fetchTicketQueue(
  filter: TicketFilter = 'awaiting_us',
  search?: string,
): Promise<TicketRow[]> {
  const { data, error } = await supabase.rpc('admin_support_queue', {
    p_status: filter,
    p_search: search?.trim() || null,
    p_max_rows: 100,
  });

  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map(toRow);
}

export type TicketDetail = TicketRow & {
  resolution: string | null;
  openedByAdminName: string | null;
  statusChangedAt: string | null;
};

export async function fetchTicketDetail(id: string): Promise<TicketDetail | null> {
  const { data, error } = await supabase.rpc('admin_support_ticket', { p_ticket: id });
  if (error) throw error;

  const row = ((data ?? []) as Record<string, unknown>[])[0];
  if (!row) return null;

  return {
    ...toRow(row),
    /*
      The detail function does not return `message_count` — the thread comes
      back from its own call, and counting it twice is how the two disagree.
    */
    messageCount: 0,
    resolution: maybeText(row.resolution),
    openedByAdminName: maybeText(row.opened_by_admin_name),
    statusChangedAt: maybeText(row.status_changed_at),
  };
}

// --------------------------------------------------------------- the thread --

export type TicketMessage = {
  id: string;
  authorId: string | null;
  authorName: string;
  authorRole: 'customer' | 'admin';
  /** `internal` never leaves the Admin area. The RLS policy cannot return one. */
  visibility: 'public' | 'internal';
  body: string;
  createdAt: string;
};

const toMessage = (row: Record<string, unknown>): TicketMessage => ({
  id: text(row.id),
  authorId: maybeText(row.author_id),
  authorName: text(row.author_name),
  authorRole: row.author_role === 'admin' ? 'admin' : 'customer',
  visibility: row.visibility === 'internal' ? 'internal' : 'public',
  body: text(row.body),
  createdAt: text(row.created_at),
});

export async function fetchTicketThread(id: string): Promise<TicketMessage[]> {
  const { data, error } = await supabase.rpc('admin_support_messages', { p_ticket: id });
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map(toMessage);
}

/**
 * Sends a reply, or files an internal note.
 *
 * ⚠ `internal` is the whole difference between a note and an answer. A public
 *   reply starts the response clock, moves an Open ticket to In Progress and
 *   pushes a notification to the customer; an internal one touches nothing.
 *   The server decides all of that — this flag is the only input.
 */
export async function replyToTicket(
  id: string,
  body: string,
  internal = false,
): Promise<void> {
  const { error } = await supabase.rpc('admin_reply_support_ticket', {
    p_ticket: id,
    p_body: body,
    p_internal: internal,
  });

  if (error) throw error;
}

/**
 * Moves a ticket.
 *
 * The note is optional except when resolving, where the server refuses without
 * one and sends it to the customer as a public reply. That asymmetry is
 * deliberate and lives in SQL, not here — see the migration.
 */
export async function setTicketStatus(
  id: string,
  status: TicketStatus,
  note?: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_set_support_status', {
    p_ticket: id,
    p_status: status,
    p_note: note?.trim() || null,
  });

  if (error) throw error;
}

/** Assigns, or hands it back to the pile with `null`. */
export async function assignTicket(id: string, adminId: string | null): Promise<void> {
  const { error } = await supabase.rpc('admin_assign_support_ticket', {
    p_ticket: id,
    p_admin: adminId,
  });

  if (error) throw error;
}

/**
 * Logs an inquiry that came in by phone or email.
 *
 * ⚠ `trackingId`, not a booking id, and that is what an operator actually has.
 *   The server resolves it against the requester's own parcels and refuses one
 *   that is not theirs — see the migration. A typo comes back as an error naming
 *   the id, which is the only way the operator can tell it was a typo.
 */
export async function logTicketForCustomer(input: {
  requesterId: string;
  subject: string;
  note: string;
  category: TicketCategory;
  channel: Exclude<TicketChannel, 'app'>;
  trackingId?: string | null;
}): Promise<{ id: string; reference: string } | null> {
  const { data, error } = await supabase.rpc('admin_create_support_ticket', {
    p_requester: input.requesterId,
    p_subject: input.subject,
    p_body: input.note,
    p_category: input.category,
    p_channel: input.channel,
    p_booking_id: null,
    p_tracking_id: input.trackingId?.trim() || null,
  });

  if (error) throw error;

  const row = ((data ?? []) as Record<string, unknown>[])[0];
  return row ? { id: text(row.id), reference: text(row.reference) } : null;
}

// ==================================================== the customer's side ==

export type MyTicket = {
  id: string;
  reference: string;
  status: TicketStatus;
  subject: string;
  category: TicketCategory;
  trackingId: string | null;
  lastMessageAt: string;
  lastMessageFrom: LastWord;
  createdAt: string | null;
  resolvedAt: string | null;
};

/**
 * A person's own tickets, straight from the table under RLS.
 *
 * ⚠ Not an RPC, and that is the point rather than a shortcut: "own tickets
 *   only" is a policy on the table, so this query is safe by construction and
 *   stays safe if somebody writes a second screen against it. An RPC would put
 *   the same rule in a function body where the next caller has to remember it.
 */
export async function fetchMyTickets(): Promise<MyTicket[]> {
  const { data, error } = await supabase
    .from('support_tickets')
    .select(
      'id, reference, status, subject, category, booking_tracking_id, last_message_at, last_message_from, created_at, resolved_at',
    )
    .order('last_message_at', { ascending: false })
    .limit(20);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    reference: String(row.reference ?? ''),
    status: asStatus(row.status),
    subject: String(row.subject ?? ''),
    category: asCategory(row.category),
    trackingId: (row.booking_tracking_id as string | null) ?? null,
    lastMessageAt: String(row.last_message_at ?? ''),
    lastMessageFrom: row.last_message_from === 'admin' ? 'admin' : 'customer',
    createdAt: (row.created_at as string | null) ?? null,
    resolvedAt: (row.resolved_at as string | null) ?? null,
  }));
}

/** One of the person's own threads. Public entries only — the policy sees to it. */
export async function fetchMyTicketThread(id: string): Promise<TicketMessage[]> {
  const { data, error } = await supabase
    .from('support_ticket_messages')
    .select('id, author_id, author_role, visibility, body, created_at')
    .eq('ticket_id', id)
    .order('created_at', { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) =>
    toMessage({
      ...row,
      /*
        No `author_name` column to join on from here.

        The admin path resolves names from `profiles`; a customer must not, so
        the two roles render as "You" and "Package Relay". Nobody outside the
        building needs to know which operator typed the reply, and putting a
        staff name in front of a customer invites them to ask for that person.
      */
      author_name: row.author_role === 'admin' ? 'Package Relay' : 'You',
    }),
  );
}

export async function openTicket(input: {
  subject: string;
  body: string;
  category: TicketCategory;
  bookingId?: string | null;
}): Promise<{ id: string; reference: string } | null> {
  const { data, error } = await supabase.rpc('create_support_ticket', {
    p_subject: input.subject,
    p_body: input.body,
    p_category: input.category,
    p_booking_id: input.bookingId ?? null,
  });

  if (error) throw error;

  const row = ((data ?? []) as Record<string, unknown>[])[0];
  return row ? { id: text(row.id), reference: text(row.reference) } : null;
}

export async function replyToMyTicket(id: string, body: string): Promise<void> {
  const { error } = await supabase.rpc('reply_support_ticket', {
    p_ticket: id,
    p_body: body,
  });

  if (error) throw error;
}

// ------------------------------------------------------------------ labels --

/**
 * How long something has waited, in words an operator does not have to do
 * arithmetic on. Same shape as `waitedLabel` in `store/admin.ts`, which exists
 * for the same reason.
 */
export function sinceLabel(timestamp: string | null, now: Date = new Date()): string {
  if (!timestamp) return '—';

  const ms = now.getTime() - Date.parse(timestamp);
  if (!Number.isFinite(ms) || ms < 0) return '—';

  const hours = ms / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** The tone a status should read in. Kept here so the queue and the drawer agree. */
export function statusTone(status: TicketStatus): 'warning' | 'primary' | 'neutral' | 'success' {
  switch (status) {
    case 'open':
      return 'warning';
    case 'in_progress':
      return 'primary';
    case 'waiting_on_customer':
      return 'neutral';
    case 'resolved':
      return 'success';
  }
}
