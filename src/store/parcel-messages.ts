import { useCallback, useEffect, useState } from 'react';

import { useLiveRefresh } from '@/hooks/use-live-refresh';
import { supabase } from '@/lib/supabase';
import type { Booking } from '@/store/bookings';

/**
 * Driver ↔ sender chat on a parcel.
 *
 * Server rules live in `20250101000083_parcel_messages.sql`: only the sender
 * and the driver the thread belongs to can read it, and messages can only be
 * sent while the job is live. This file is the client's view of those rules —
 * it decides what to *show*, the database decides what is *allowed*.
 */

export type ParcelMessage = {
  id: string;
  bookingId: string;
  driverId: string;
  authorId: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

type Row = {
  id: string;
  booking_id: string;
  driver_id: string;
  author_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

const toMessage = (row: Row): ParcelMessage => ({
  id: row.id,
  bookingId: row.booking_id,
  driverId: row.driver_id,
  authorId: row.author_id,
  body: row.body,
  createdAt: row.created_at,
  readAt: row.read_at,
});

export const MESSAGE_MAX_LENGTH = 1000;

/** Statuses during which a message can be sent. Mirrors the SQL function. */
const CHAT_OPEN_STATUSES: readonly string[] = ['Assigned', 'Picked Up', 'In Transit'];

/** Whether new messages can be sent on this parcel right now. */
export function chatIsOpen(booking: Pick<Booking, 'driverId' | 'status'>): boolean {
  return !!booking.driverId && CHAT_OPEN_STATUSES.includes(booking.status);
}

/** The viewer's side of the conversation, or null if they are neither. */
export function chatRole(
  booking: Pick<Booking, 'senderId' | 'driverId'>,
  userId: string | null | undefined,
): 'sender' | 'driver' | null {
  if (!userId) return null;
  if (booking.driverId === userId) return 'driver';
  if (booking.senderId === userId) return 'sender';
  return null;
}

/**
 * The thread with the parcel's current driver, oldest first.
 *
 * Filtered on `driver_id` so a sender whose parcel changed hands sees the
 * conversation with the driver who has it now, not a mix of two people.
 */
export async function fetchThread(bookingId: string, driverId: string): Promise<ParcelMessage[]> {
  const { data, error } = await supabase
    .from('parcel_messages')
    .select('*')
    .eq('booking_id', bookingId)
    .eq('driver_id', driverId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).map(toMessage);
}

/** Sends one message. Throws the server's own sentence on refusal. */
export async function sendMessage(bookingId: string, body: string): Promise<ParcelMessage> {
  const { data, error } = await supabase.rpc('send_parcel_message', {
    p_booking: bookingId,
    p_body: body,
  });
  if (error) throw new Error(error.message);
  return toMessage(data as Row);
}

/** Marks what this viewer has received as read, and clears the inbox notice. */
export async function markThreadRead(bookingId: string): Promise<void> {
  await supabase.rpc('mark_parcel_messages_read', { p_booking: bookingId });
}

/** How many messages the viewer has not read on this parcel's current thread. */
export async function fetchUnreadCount(
  bookingId: string,
  driverId: string,
  viewerId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('parcel_messages')
    .select('id', { count: 'exact', head: true })
    .eq('booking_id', bookingId)
    .eq('driver_id', driverId)
    .neq('author_id', viewerId)
    .is('read_at', null);

  if (error) return 0;
  return count ?? 0;
}

/**
 * Live unread count for a "Message …" button.
 *
 * Realtime on this parcel's messages plus a slow poll; zero when the viewer is
 * not part of the conversation or nobody has the parcel yet.
 */
export function useUnreadMessages(
  booking: Pick<Booking, 'id' | 'driverId' | 'senderId'>,
  viewerId: string | null | undefined,
): number {
  const [count, setCount] = useState(0);
  const enabled = !!viewerId && !!booking.driverId && !!chatRole(booking, viewerId);

  const refresh = useCallback(async () => {
    if (!viewerId || !booking.driverId) return;
    setCount(await fetchUnreadCount(booking.id, booking.driverId, viewerId));
  }, [booking.id, booking.driverId, viewerId]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  useLiveRefresh(refresh, {
    channel: `parcel-unread:${booking.id}:${viewerId ?? 'none'}`,
    tables: ['parcel_messages'],
    filter: `booking_id=eq.${booking.id}`,
    intervalMs: 60_000,
    enabled,
  });

  return enabled ? count : 0;
}
