import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { formatNaira, routeLabel, type Booking } from '@/store/bookings';

/**
 * Outbox for transactional email and SMS.
 *
 * NOTHING IS SENT FROM HERE, and nothing should be. A client cannot hold the
 * credentials for an email or SMS provider without shipping them to every
 * device, so the only correct shape is: the app records what it wants sent, a
 * server picks the queue up and delivers it.
 *
 * `deliver()` below is the single seam for that server. Until it exists,
 * messages sit at `queued` and the UI says so — a driver who is told "sent"
 * may wait for a message that never arrives before setting off.
 */
export type NotificationChannel = 'email' | 'sms';

export type NotificationStatus = 'queued' | 'sent' | 'failed';

export type QueuedNotification = {
  id: string;
  channel: NotificationChannel;
  /** Email address or E.164 phone number. */
  to: string;
  /** Email only. */
  subject?: string;
  body: string;
  status: NotificationStatus;
  queuedAt: string;
  /** Set once a backend reports back. */
  sentAt: string | null;
  failureReason: string | null;
};

/** Who to contact, as captured at registration. */
export type NotificationRecipient = {
  name: string;
  email: string | null;
  phone: string | null;
};

/* ------------------------------------------------------------------ *
 * Message content
 *
 * Composed here rather than at the call site so the wording is testable
 * without rendering a screen, and so email and SMS can't drift apart.
 * ------------------------------------------------------------------ */

export function jobAcceptedEmail(booking: Booking, driverName: string) {
  return {
    subject: `You accepted job #${booking.trackingId} — ${routeLabel(booking)}`,
    body: [
      `Hi ${driverName},`,
      '',
      `You've accepted a Package Relay delivery.`,
      '',
      `Reference:  #${booking.trackingId}`,
      `Item:       ${booking.itemDescription} (${booking.weight} kg)`,
      `Route:      ${routeLabel(booking)}`,
      `Pickup:     ${[booking.pickupAddress, booking.pickupArea, booking.originCity].filter(Boolean).join(', ')}`,
      `Drop-off:   ${[booking.dropoffAddress, booking.dropoffArea, booking.destinationCity].filter(Boolean).join(', ')}`,
      `Payout:     ${formatNaira(booking.estimatedFee)} on completion`,
      '',
      `Contact at pickup: ${booking.pickupContactName || 'Sender'} — ${booking.senderPhone}`,
      `Recipient: ${booking.recipientName} — ${booking.recipientPhone}`,
      booking.fragile ? '\nThis parcel is marked FRAGILE. Pack it separately.' : '',
      '',
      'Open the Package Relay app to start the pickup.',
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  };
}

/** Kept under 160 characters so it lands as a single SMS segment. */
export function jobAcceptedSms(booking: Booking): string {
  return (
    `Package Relay: job #${booking.trackingId} accepted. ${routeLabel(booking)}. ` +
    `Payout ${formatNaira(booking.estimatedFee)}. Pickup: ${booking.pickupArea}, ${booking.originCity}.`
  );
}

/* ------------------------------------------------------------------ */

export type NotificationsContextValue = {
  outbox: QueuedNotification[];
  /**
   * Queues the driver's confirmation pair. Returns what was queued so the
   * screen can say exactly where each message is going — or that a channel was
   * skipped because no address is on file.
   */
  notifyJobAccepted: (
    booking: Booking,
    recipient: NotificationRecipient,
  ) => { queued: QueuedNotification[]; skipped: NotificationChannel[] };
};

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

let counter = 0;
const nextId = () => `ntf-${Date.now()}-${(counter += 1)}`;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [outbox, setOutbox] = useState<QueuedNotification[]>([]);

  const notifyJobAccepted = useCallback((booking: Booking, recipient: NotificationRecipient) => {
    const queued: QueuedNotification[] = [];
    const skipped: NotificationChannel[] = [];
    const queuedAt = new Date().toISOString();

    if (recipient.email) {
      const { subject, body } = jobAcceptedEmail(booking, recipient.name);
      queued.push({
        id: nextId(),
        channel: 'email',
        to: recipient.email,
        subject,
        body,
        status: 'queued',
        queuedAt,
        sentAt: null,
        failureReason: null,
      });
    } else {
      skipped.push('email');
    }

    if (recipient.phone) {
      queued.push({
        id: nextId(),
        channel: 'sms',
        to: recipient.phone,
        body: jobAcceptedSms(booking),
        status: 'queued',
        queuedAt,
        sentAt: null,
        failureReason: null,
      });
    } else {
      skipped.push('sms');
    }

    setOutbox((prev) => [...queued, ...prev]);
    return { queued, skipped };
  }, []);

  const value = useMemo(() => ({ outbox, notifyJobAccepted }), [outbox, notifyJobAccepted]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsContextValue {
  const context = useContext(NotificationsContext);
  if (!context) throw new Error('useNotifications must be used inside NotificationsProvider');
  return context;
}
