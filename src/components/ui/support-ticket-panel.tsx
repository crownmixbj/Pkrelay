import { ChevronDown, ChevronRight, MessageSquareText, PackageOpen, Send } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipGroup } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { SectionLabel } from '@/components/ui/screen';
import { showToast } from '@/components/ui/toast';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useBookings } from '@/store/bookings';
import { useSession } from '@/store/session';
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_STATUS_LABELS,
  fetchMyTicketThread,
  fetchMyTickets,
  openTicket,
  replyToMyTicket,
  sinceLabel,
  statusTone,
  type MyTicket,
  type TicketCategory,
  type TicketMessage,
} from '@/store/support-tickets';

/**
 * The customer's half of support: raise something, and read what came back.
 *
 * ⚠ It only renders for somebody signed in, and that is not a gate for its own
 *   sake. A ticket has to belong to an account — it is how the reply reaches
 *   them, and how an operator knows whose parcel to look at. A form for a signed
 *   out visitor would be a contact form with nowhere to send the answer, which
 *   is what the email address above it already is.
 *
 * ⚠ The tickets list is here rather than on its own screen because of what it
 *   prevents: a person who writes in and then sees nothing concludes nothing
 *   happened and writes in again, by another channel. Their own thread, with a
 *   status on it, is the answer to "did anyone read this".
 */
export function SupportTicketPanel() {
  const theme = useTheme();
  const { isAuthenticated } = useSession();

  const [tickets, setTickets] = useState<MyTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTickets(await fetchMyTickets());
      setError(null);
    } catch (thrown) {
      /*
       * A project that has not run the migration has no table here, and the
       * honest reading of that is "this is not switched on yet" rather than an
       * error the person could do anything about.
       */
      const message = errorMessage(thrown, 'Could not load your tickets.');
      setError(/does not exist|schema cache|404/i.test(message) ? null : message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    void load();
  }, [isAuthenticated, load]);

  if (!isAuthenticated) return null;

  return (
    <View style={styles.panel}>
      <View style={styles.sectionRow}>
        <SectionLabel>Your support tickets</SectionLabel>
        {!composing && (
          <Button
            label="Raise a ticket"
            size="md"
            icon={(color, size) => <MessageSquareText color={color} size={size} />}
            onPress={() => setComposing(true)}
          />
        )}
      </View>

      {composing && (
        <TicketComposer
          onCancel={() => setComposing(false)}
          onOpened={(reference) => {
            setComposing(false);
            showToast('Ticket raised', {
              message: `${reference} — we answer in the app, so check back here.`,
            });
            void load();
          }}
        />
      )}

      {!!error && (
        <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
          <Text style={[styles.errorText, { color: theme.dangerOnSoft }]}>{error}</Text>
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : tickets.length === 0 ? (
        !composing && (
          <Card>
            <Text style={[styles.meta, { color: theme.textSecondary }]}>
              Nothing open. A ticket raised here goes straight to the Package Relay team, and the
              reply lands in this app — no inbox to watch.
            </Text>
          </Card>
        )
      ) : (
        <View style={styles.list}>
          {tickets.map((ticket) => (
            <TicketRow
              key={ticket.id}
              ticket={ticket}
              open={openId === ticket.id}
              onToggle={() => setOpenId(openId === ticket.id ? null : ticket.id)}
              onReplied={() => void load()}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * The form.
 *
 * ⚠ The parcel is picked from their own list, never typed.
 *
 *   A typed tracking id is a typo waiting to happen, and the server refuses one
 *   that is not theirs — so a person who mistypes their own parcel gets an error
 *   they cannot make sense of. Their parcels are already loaded on this device;
 *   offering them is both easier and impossible to get wrong.
 */
function TicketComposer({
  onCancel,
  onOpened,
}: {
  onCancel: () => void;
  onOpened: (reference: string) => void;
}) {
  const theme = useTheme();
  const { bookings } = useBookings();

  const [category, setCategory] = useState<TicketCategory>('parcel');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Their six most recent parcels. Older than that and they would search, not scan. */
  const recent = useMemo(() => bookings.slice(0, 6), [bookings]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await openTicket({
        subject: subject.trim(),
        body: body.trim(),
        category,
        bookingId: category === 'parcel' ? bookingId : null,
      });
      onOpened(created?.reference ?? 'Raised');
    } catch (thrown) {
      /*
       * Shown verbatim. The server's refusals here are written for the person
       * reading them — "a few more words, so somebody can act on it" — and
       * replacing them with a generic failure would throw away the only part
       * that tells them what to change.
       */
      setError(errorMessage(thrown, 'Could not raise the ticket.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={styles.composer}>
      <Text style={[styles.label, { color: theme.textSecondary }]}>What is it about</Text>
      <ChipGroup
        options={TICKET_CATEGORIES}
        selected={category}
        onSelect={setCategory}
        renderLabel={(value) => TICKET_CATEGORY_LABELS[value]}
        scrollable
      />

      {category === 'parcel' && recent.length > 0 && (
        <View style={styles.block}>
          <Text style={[styles.label, { color: theme.textSecondary }]}>Which parcel</Text>
          <ChipGroup
            options={['none', ...recent.map((booking) => booking.id)]}
            selected={bookingId ?? 'none'}
            onSelect={(value) => setBookingId(value === 'none' ? null : value)}
            renderLabel={(value) =>
              value === 'none'
                ? 'Not about one parcel'
                : (recent.find((booking) => booking.id === value)?.trackingId ?? value)
            }
            scrollable
          />
        </View>
      )}

      <Field
        label="Subject"
        value={subject}
        onChangeText={setSubject}
        placeholder="Driver has not arrived"
        hint="One line, so the team can see at a glance what this is."
      />

      <Field
        label="What happened"
        value={body}
        onChangeText={setBody}
        multiline
        numberOfLines={5}
        placeholder="Booked for a 9am pickup, nobody came and the driver's phone is off."
        hint="Dates, times and names help. Please do not include card details."
      />

      {!!error && (
        <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
          <Text style={[styles.errorText, { color: theme.dangerOnSoft }]}>{error}</Text>
        </View>
      )}

      <View style={styles.actions}>
        <Button
          label={busy ? 'Sending…' : 'Send it'}
          size="md"
          disabled={busy || subject.trim().length === 0 || body.trim().length < 10}
          icon={(color, size) => <Send color={color} size={size} />}
          onPress={() => void submit()}
        />
        <Button label="Cancel" variant="secondary" size="md" onPress={onCancel} />
      </View>
    </Card>
  );
}

/** One of their tickets, expanding into the conversation. */
function TicketRow({
  ticket,
  open,
  onToggle,
  onReplied,
}: {
  ticket: MyTicket;
  open: boolean;
  onToggle: () => void;
  onReplied: () => void;
}) {
  const theme = useTheme();

  const [thread, setThread] = useState<TicketMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setThread(await fetchMyTicketThread(ticket.id));
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not load the conversation.'));
    }
  }, [ticket.id]);

  useEffect(() => {
    if (open && thread === null) void load();
  }, [open, thread, load]);

  const send = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await replyToMyTicket(ticket.id, draft.trim());
      setDraft('');
      await load();
      onReplied();
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not send that.'));
    } finally {
      setBusy(false);
    }
  };

  const theirTurn = ticket.lastMessageFrom === 'customer' && ticket.status !== 'resolved';

  return (
    <Card style={styles.ticket}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${ticket.reference}: ${ticket.subject}. ${TICKET_STATUS_LABELS[ticket.status]}.`}
        style={({ pressed }) => [styles.ticketHead, pressed && { opacity: 0.7 }]}>
        <View style={styles.ticketHeadText}>
          <Text style={[styles.reference, { color: theme.textMuted }]}>
            {ticket.reference}
            {!!ticket.trackingId && ` · ${ticket.trackingId}`}
          </Text>
          <Text style={[styles.subject, { color: theme.text }]} numberOfLines={2}>
            {ticket.subject}
          </Text>
          {/*
            Whose move it is, in their words rather than ours.

            "Waiting on customer" is an operations label; a person reading their
            own ticket needs to know that the next move is theirs, which is a
            different sentence.
          */}
          <Text style={[styles.meta, { color: theme.textMuted }]}>
            {ticket.status === 'resolved'
              ? `Resolved ${sinceLabel(ticket.resolvedAt)}`
              : theirTurn
                ? `Sent ${sinceLabel(ticket.lastMessageAt)} — we are on it`
                : `Package Relay replied ${sinceLabel(ticket.lastMessageAt)}`}
          </Text>
        </View>
        <Badge
          label={TICKET_STATUS_LABELS[ticket.status]}
          tone={statusTone(ticket.status)}
          uppercase={false}
        />
        {open ? (
          <ChevronDown color={theme.textMuted} size={18} />
        ) : (
          <ChevronRight color={theme.textMuted} size={18} />
        )}
      </Pressable>

      {open && (
        <View style={styles.block}>
          {!!ticket.trackingId && (
            <View style={styles.inlineFact}>
              <PackageOpen color={theme.textMuted} size={13} />
              <Text style={[styles.meta, { color: theme.textSecondary }]}>
                About parcel {ticket.trackingId}
              </Text>
            </View>
          )}

          {thread === null ? (
            <ActivityIndicator color={theme.primary} />
          ) : (
            <View style={styles.thread}>
              {thread.map((message) => (
                <View
                  key={message.id}
                  style={[
                    styles.entry,
                    {
                      backgroundColor:
                        message.authorRole === 'admin' ? theme.primarySoft : theme.surfaceMuted,
                    },
                  ]}>
                  <Text
                    style={[
                      styles.entryAuthor,
                      {
                        color:
                          message.authorRole === 'admin' ? theme.primaryOnSoft : theme.textSecondary,
                      },
                    ]}>
                    {message.authorName} · {sinceLabel(message.createdAt)}
                  </Text>
                  <Text
                    style={[
                      styles.entryBody,
                      { color: message.authorRole === 'admin' ? theme.primaryOnSoft : theme.text },
                    ]}>
                    {message.body}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {!!error && (
            <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
              <Text style={[styles.errorText, { color: theme.dangerOnSoft }]}>{error}</Text>
            </View>
          )}

          <Field
            label="Add to this ticket"
            value={draft}
            onChangeText={setDraft}
            multiline
            numberOfLines={3}
            placeholder="Anything new, or anything we got wrong."
            hint={
              ticket.status === 'resolved'
                ? 'This ticket is resolved — replying reopens it.'
                : undefined
            }
          />

          <View style={styles.actions}>
            <Button
              label={busy ? 'Sending…' : 'Send'}
              size="md"
              disabled={busy || draft.trim().length === 0}
              icon={(color, size) => <Send color={color} size={size} />}
              onPress={() => void send()}
            />
          </View>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: Spacing.four,
    gap: Spacing.two,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  loading: {
    marginVertical: Spacing.four,
  },
  list: {
    gap: Spacing.two + 2,
  },
  composer: {
    gap: Spacing.three - 2,
  },
  ticket: {
    gap: Spacing.two + 2,
  },
  ticketHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    cursor: 'pointer',
  },
  ticketHeadText: {
    flex: 1,
    gap: Spacing.half,
  },
  reference: {
    ...Typography.caption,
    ...font(700),
  },
  subject: {
    ...Typography.meta,
    ...font(700),
    lineHeight: 20,
  },
  meta: {
    ...Typography.caption,
    lineHeight: 18,
  },
  label: {
    ...Typography.caption,
    ...font(700),
  },
  block: {
    gap: Spacing.two,
  },
  inlineFact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  thread: {
    gap: Spacing.two,
  },
  entry: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    gap: Spacing.one,
  },
  entryAuthor: {
    ...Typography.caption,
    ...font(700),
  },
  entryBody: {
    ...Typography.meta,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  error: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
  },
  errorText: {
    ...Typography.meta,
    ...font(600),
  },
});
