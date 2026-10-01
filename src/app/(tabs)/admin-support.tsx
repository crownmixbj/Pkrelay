import { useRouter } from 'expo-router';
import {
  ChevronRight,
  Clock,
  Headset,
  Lock,
  MessageSquareText,
  PackageOpen,
  Phone,
  Plus,
  Search,
  Send,
  TriangleAlert,
  UserRound,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { AdminError, AdminShell, Metric, adminStyles } from '@/components/ui/admin-shell';
import { Badge } from '@/components/ui/badge';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipGroup } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { ModerationDialog } from '@/components/ui/moderation-dialog';
import { EmptyState, SectionLabel } from '@/components/ui/screen';
import { showToast } from '@/components/ui/toast';
import { FontSize, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/store/session';
import {
  ageLabel,
  fetchAdminParcelDetail,
  fetchUsers,
  type AdminParcelDetail,
  type AdminUser,
} from '@/store/admin';
import { formatNaira } from '@/store/bookings';
import {
  EMPTY_COUNTS,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_CHANNEL_LABELS,
  TICKET_FILTERS,
  TICKET_FILTER_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  assignTicket,
  fetchTicketCounts,
  fetchTicketDetail,
  fetchTicketQueue,
  fetchTicketThread,
  logTicketForCustomer,
  replyToTicket,
  setTicketStatus,
  sinceLabel,
  statusTone,
  type TicketCategory,
  type TicketCounts,
  type TicketDetail,
  type TicketFilter,
  type TicketMessage,
  type TicketRow,
  type TicketStatus,
} from '@/store/support-tickets';

/**
 * Support Tickets.
 *
 * One queue for customers and drivers both, because the two arrive through the
 * same phone line and the same inbox and a ticket's side is a property of the
 * person, not of the workflow — the row says which, and that is enough.
 *
 * ⚠ The default view is "Awaiting us", not "Open".
 *
 *   Open is a status somebody last clicked; awaiting us is the state of the
 *   world — the customer spoke last and nobody has answered. Those two sets
 *   overlap and are not the same, and only one of them is a list of work. See
 *   `TicketFilter` for why it is a filter rather than a fifth status.
 *
 * ⚠ Nothing on this screen is the control.
 *
 *   `AdminShell` keeps a non-admin off it, which is a courtesy. What refuses
 *   the data is `is_admin()` inside every function in
 *   `20250101000059_support_tickets.sql` — including the one that returns
 *   internal notes, which is the only path to them in the whole schema.
 */
export default function AdminSupportScreen() {
  const theme = useTheme();
  const { isAdmin } = useSession();

  const [counts, setCounts] = useState<TicketCounts>(EMPTY_COUNTS);
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [filter, setFilter] = useState<TicketFilter>('awaiting_us');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** The ticket the drawer is showing, or null. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);

  const load = useCallback(async () => {
    try {
      const [summary, queue] = await Promise.all([
        fetchTicketCounts(),
        fetchTicketQueue(filter, query),
      ]);
      setCounts(summary);
      setRows(queue);
      setError(null);
    } catch (thrown) {
      /*
       * The likeliest cause on a project that has not run the migration is
       * "function admin_support_queue does not exist", which is not a message
       * anybody should have to decode. Same treatment as the overview.
       */
      const message = errorMessage(thrown, 'Could not load the support queue.');
      setError(
        /does not exist|schema cache|404/i.test(message)
          ? 'The support functions are missing. Run supabase/migrations/20250101000059_support_tickets.sql, then reload.'
          : message,
      );
    } finally {
      setLoading(false);
    }
  }, [filter, query]);

  /*
   * Debounced while typing, immediate otherwise — the same 300ms the finance
   * ledger uses. A reference is eleven characters and eleven round trips
   * against a function that joins three tables is a screen that feels broken.
   */
  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => void load(), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [isAdmin, load, query]);

  return (
    <AdminShell
      title="Support Tickets"
      subtitle="Every question a customer or driver has asked, and whose move it is next."
      next="/admin-support">
      <View style={adminStyles.metrics}>
        <Metric
          label="Awaiting us"
          value={counts.awaitingUs}
          tone={counts.awaitingUs > 0 ? 'warning' : 'success'}
          hint="They spoke last. This is the queue."
        />
        {/*
          Shown only when there are some.

          A ticket nobody has answered at all is a different failure from a slow
          one, and it is the only number here that should be zero every evening.
          A permanent zero tile trains people to stop reading it.
        */}
        {counts.unanswered > 0 && (
          <Metric
            label="Never answered"
            value={counts.unanswered}
            tone="danger"
            hint="Nobody has replied to these once."
          />
        )}
        <Metric label="In progress" value={counts.inProgress} tone="primary" />
        <Metric
          label="Waiting on customer"
          value={counts.waitingOnCustomer}
          hint="Not ours to move."
        />
        <Metric
          label="Longest wait"
          value={counts.oldestWaitingHours >= 24
            ? `${Math.floor(counts.oldestWaitingHours / 24)}d`
            : `${Math.round(counts.oldestWaitingHours)}h`}
          tone={counts.oldestWaitingHours >= 24 ? 'danger' : 'neutral'}
          hint="Since the oldest unanswered message."
        />
        <Metric label="Resolved, 7 days" value={counts.resolvedLast7Days} tone="success" />
      </View>

      {/*
        The one state worth interrupting for, and it is not a big number — it is
        any number. Somebody has written in and nobody has said anything back.
      */}
      {counts.unanswered > 0 && (
        <View style={[styles.alert, { backgroundColor: theme.warningSoft }]}>
          <TriangleAlert color={theme.warningOnSoft} size={18} />
          <View style={styles.alertText}>
            <Text style={[styles.alertTitle, { color: theme.warningOnSoft }]}>
              {counts.unanswered} ticket{counts.unanswered === 1 ? '' : 's'} nobody has replied to
            </Text>
            <Text style={[styles.alertBody, { color: theme.warningOnSoft }]}>
              The Support page promises email is answered within one working day.
            </Text>
          </View>
        </View>
      )}

      <View style={styles.sectionRow}>
        <SectionLabel>Queue</SectionLabel>
        <Button
          label="Log a call"
          size="md"
          icon={(color, size) => <Plus color={color} size={size} />}
          onPress={() => setLogging(true)}
        />
      </View>

      <View style={styles.controls}>
        <View
          style={[
            styles.search,
            { borderColor: theme.borderStrong, backgroundColor: theme.surface },
          ]}>
          <Search color={theme.textMuted} size={16} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Reference, subject, tracking ID, name or phone"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.searchInput, { color: theme.text }]}
            accessibilityLabel="Search support tickets"
          />
        </View>

        <ChipGroup
          options={TICKET_FILTERS}
          selected={filter}
          onSelect={setFilter}
          renderLabel={(value) => TICKET_FILTER_LABELS[value]}
          scrollable
        />
      </View>

      {!!error && <AdminError message={error} />}

      {loading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : rows.length === 0 ? (
        <Card style={styles.emptyCard}>
          <EmptyState
            icon={(color, size) => <Headset color={color} size={size} />}
            title={query.trim() ? 'Nothing matches that' : 'Nothing waiting'}
            message={
              query.trim()
                ? `No ticket matches “${query.trim()}”. Try the reference, or part of a name.`
                : filter === 'awaiting_us'
                  ? 'Every ticket has had an answer. A new one appears here the moment somebody writes in.'
                  : 'No tickets in this view yet.'
            }
          />
        </Card>
      ) : (
        <View style={styles.list}>
          {rows.map((row) => (
            <TicketCard key={row.id} row={row} onPress={() => setOpenId(row.id)} />
          ))}
        </View>
      )}

      <TicketDrawer
        id={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => void load()}
      />

      {logging && (
        <LogCallSheet
          onClose={() => setLogging(false)}
          onLogged={(reference) => {
            setLogging(false);
            showToast('Ticket logged', { message: reference });
            void load();
          }}
        />
      )}
    </AdminShell>
  );
}

/**
 * One row of the queue.
 *
 * ⚠ The waiting time is on the left of the status, not beside the date.
 *
 *   "4 days ago" is what decides whether this is the ticket you open next; the
 *   status is what it is called. An operator scanning twenty rows reads the
 *   first column and nothing else, so the first column has to be the one that
 *   ranks them.
 */
function TicketCard({ row, onPress }: { row: TicketRow; onPress: () => void }) {
  const theme = useTheme();

  const oursToAnswer = row.lastMessageFrom === 'customer' && row.status !== 'resolved';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.reference}: ${row.subject}. ${TICKET_STATUS_LABELS[row.status]}. Open the ticket.`}
      style={({ pressed }) => [styles.cardSlot, pressed && { opacity: 0.7 }]}>
      <Card style={styles.card}>
        <View style={styles.cardHead}>
          <View style={styles.cardHeadText}>
            <Text style={[styles.reference, { color: theme.textSecondary }]}>{row.reference}</Text>
            <Text style={[styles.subject, { color: theme.text }]} numberOfLines={2}>
              {row.subject}
            </Text>
          </View>
          <View style={styles.cardHeadRight}>
            <Badge
              label={TICKET_STATUS_LABELS[row.status]}
              tone={statusTone(row.status)}
              uppercase={false}
            />
            <ChevronRight color={theme.textMuted} size={16} />
          </View>
        </View>

        <View style={styles.factRow}>
          <View style={styles.inlineFact}>
            <UserRound color={theme.textMuted} size={13} />
            <Text style={[styles.meta, { color: theme.textSecondary }]} numberOfLines={1}>
              {row.requesterName}
            </Text>
            {row.requesterIsDriver && <Badge label="Driver" tone="primary" uppercase={false} />}
          </View>

          {!!row.trackingId && (
            <View style={styles.inlineFact}>
              <PackageOpen color={theme.textMuted} size={13} />
              <Text style={[styles.meta, { color: theme.textSecondary }]}>{row.trackingId}</Text>
            </View>
          )}

          {row.channel !== 'app' && (
            <View style={styles.inlineFact}>
              <Phone color={theme.textMuted} size={13} />
              <Text style={[styles.meta, { color: theme.textSecondary }]}>
                {TICKET_CHANNEL_LABELS[row.channel]}
              </Text>
            </View>
          )}

          <View style={styles.inlineFact}>
            <Clock color={oursToAnswer ? theme.warningOnSoft : theme.textMuted} size={13} />
            <Text
              style={[
                styles.meta,
                { color: oursToAnswer ? theme.warningOnSoft : theme.textMuted },
                oursToAnswer && font(700),
              ]}>
              {oursToAnswer
                ? `waiting ${sinceLabel(row.lastMessageAt)}`
                : `replied ${sinceLabel(row.lastMessageAt)}`}
            </Text>
          </View>
        </View>

        {/*
          Two things an operator needs before opening it: whether anybody has
          ever answered, and whose it is. Both are absences, so both are only
          rendered when they are true — a row with neither is a normal row.
        */}
        <View style={styles.tagRow}>
          {row.firstResponseAt === null && row.status !== 'resolved' && (
            <Badge label="Never answered" tone="danger" uppercase={false} />
          )}
          {!!row.assignedAdminName && (
            <Badge label={row.assignedAdminName} tone="neutral" uppercase={false} />
          )}
          <Text style={[styles.meta, { color: theme.textMuted }]}>
            {TICKET_CATEGORY_LABELS[row.category]} · {row.messageCount} message
            {row.messageCount === 1 ? '' : 's'}
          </Text>
        </View>
      </Card>
    </Pressable>
  );
}

/**
 * One ticket, everything about it, and every way to move it.
 *
 * ⚠ The thread is the screen, and the reply box is under it rather than at the
 *   top. An operator reads down to the last thing said and then types; a compose
 *   box above the history is a box you type into before you have read it.
 */
function TicketDrawer({
  id,
  onClose,
  onChanged,
}: {
  /** Null closes the drawer. */
  id: string | null;
  onClose: () => void;
  /** Called after anything that changes the queue behind it. */
  onChanged: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  const { user } = useSession();

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [thread, setThread] = useState<TicketMessage[]>([]);
  const [parcel, setParcel] = useState<AdminParcelDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [internal, setInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [resolving, setResolving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [detail, messages] = await Promise.all([fetchTicketDetail(id), fetchTicketThread(id)]);
      setTicket(detail);
      setThread(messages);
      setError(null);

      /*
       * The parcel, when there is one, through the existing admin RPC.
       *
       * ⚠ Deliberately the parcel *summary* and not a link away from here.
       *
       *   "Which parcel is this about" is answered nine times out of ten by the
       *   status and the route, and sending an operator to another screen to
       *   read two fields loses the thread they were halfway through. Names,
       *   phone numbers and addresses are not in this shape — those come from
       *   the audited reveal in the parcel drawer, and 17 explains why.
       */
      setParcel(detail?.bookingId ? await fetchAdminParcelDetail(detail.bookingId) : null);
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not load the ticket.'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) {
      setTicket(null);
      setThread([]);
      setParcel(null);
      setDraft('');
      setInternal(false);
      setError(null);
      return;
    }
    void load();
  }, [id, load]);

  const send = async () => {
    if (!id || !draft.trim()) return;
    setSending(true);
    try {
      await replyToTicket(id, draft.trim(), internal);
      setDraft('');
      showToast(internal ? 'Note added' : 'Reply sent', {
        message: internal
          ? 'Visible to admins only.'
          : 'The customer has been notified in the app.',
      });
      await load();
      onChanged();
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not send that.'));
    } finally {
      setSending(false);
    }
  };

  const move = async (status: TicketStatus) => {
    if (!id) return;

    /*
     * Resolving is the one transition that asks a question first.
     *
     * The note is required by the server and is sent to the customer as a
     * public reply, so it is not bookkeeping — it is the last thing they hear
     * from us. `ModerationDialog` already exists for exactly this shape of
     * "confirm, and say why".
     */
    if (status === 'resolved') {
      setResolving(true);
      return;
    }

    try {
      await setTicketStatus(id, status);
      await load();
      onChanged();
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not change the status.'));
    }
  };

  const assign = async (to: string | null) => {
    if (!id) return;
    try {
      await assignTicket(id, to);
      await load();
      onChanged();
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not assign the ticket.'));
    }
  };

  const mine = !!ticket?.assignedAdminId && ticket.assignedAdminId === user?.id;

  return (
    <BottomSheet visible={!!id} onClose={onClose}>
      <View style={styles.sheet}>
        {loading && !ticket ? (
          <ActivityIndicator color={theme.primary} style={styles.loading} />
        ) : !ticket ? (
          <EmptyState
            icon={(color, size) => <Headset color={color} size={size} />}
            title="Ticket not found"
            message="It may have been erased with the account it belonged to."
          />
        ) : (
          <>
            <View style={styles.sheetHead}>
              <View style={styles.cardHeadText}>
                <Text style={[styles.reference, { color: theme.textSecondary }]}>
                  {ticket.reference} · {TICKET_CHANNEL_LABELS[ticket.channel]}
                  {!!ticket.openedByAdminName && ` · logged by ${ticket.openedByAdminName}`}
                </Text>
                <Text style={[styles.sheetTitle, { color: theme.text }]}>{ticket.subject}</Text>
              </View>
              <Badge
                label={TICKET_STATUS_LABELS[ticket.status]}
                tone={statusTone(ticket.status)}
                uppercase={false}
              />
            </View>

            {!!error && <AdminError message={error} />}

            {/* --------------------------------------------- who, and what -- */}
            <Card style={styles.block}>
              <View style={styles.rowBetween}>
                <View style={styles.inlineFact}>
                  <UserRound color={theme.textMuted} size={14} />
                  <Text style={[styles.value, { color: theme.text }]}>{ticket.requesterName}</Text>
                  {ticket.requesterIsDriver && (
                    <Badge label="Driver" tone="primary" uppercase={false} />
                  )}
                </View>
                <Button
                  label="Open account"
                  variant="secondary"
                  size="md"
                  onPress={() =>
                    /*
                      Seeds the search box on User & Role Mgmt rather than
                      inventing a per-user route. That screen filters on name or
                      phone already, so one query parameter reaches the row —
                      and an admin who lands there can ban or erase from the
                      same place, which is why they are going.
                    */
                    router.navigate(
                      `/admin-users?q=${encodeURIComponent(ticket.requesterName)}` as '/',
                    )
                  }
                />
              </View>

              <View style={styles.factRow}>
                <Fact label="Category" value={TICKET_CATEGORY_LABELS[ticket.category]} />
                <Fact label="Opened" value={sinceLabel(ticket.createdAt)} />
                <Fact
                  label="First answered"
                  value={ticket.firstResponseAt ? sinceLabel(ticket.firstResponseAt) : 'never'}
                />
                <Fact
                  label="Assigned"
                  value={ticket.assignedAdminName ?? 'nobody'}
                />
              </View>

              <Text selectable style={[styles.accountId, { color: theme.textMuted }]}>
                Account {ticket.requesterId}
              </Text>
            </Card>

            {/* ------------------------------------------------ the parcel -- */}
            {!!ticket.trackingId && (
              <Card style={styles.block}>
                <View style={styles.inlineFact}>
                  <PackageOpen color={theme.textMuted} size={14} />
                  <Text style={[styles.value, { color: theme.text }]}>{ticket.trackingId}</Text>
                  {!!parcel && (
                    <Badge label={parcel.status} tone="neutral" uppercase={false} />
                  )}
                </View>

                {parcel ? (
                  <View style={styles.factRow}>
                    <Fact label="Route" value={`${parcel.originCity} → ${parcel.destinationCity}`} />
                    <Fact label="Driver" value={parcel.driverName ?? 'unclaimed'} />
                    <Fact label="Fare" value={formatNaira(parcel.estimatedFee)} />
                    <Fact label="Posted" value={ageLabel(parcel.createdAt)} />
                  </View>
                ) : (
                  /*
                    The tracking id outlived the parcel row, which is what the
                    snapshot is for. Saying so is better than rendering an empty
                    parcel card and letting somebody conclude the link is broken.
                  */
                  <Text style={[styles.meta, { color: theme.textMuted }]}>
                    This parcel is no longer in the system — the tracking ID is kept so the ticket
                    still says which one it was about.
                  </Text>
                )}
              </Card>
            )}

            {/* ------------------------------------------------ the thread -- */}
            <SectionLabel>Conversation</SectionLabel>
            <View style={styles.thread}>
              {thread.map((message) => (
                <ThreadEntry key={message.id} message={message} />
              ))}
            </View>

            {/* ------------------------------------------------- the reply -- */}
            <Field
              label={internal ? 'Internal note' : 'Reply to the customer'}
              value={draft}
              onChangeText={setDraft}
              multiline
              numberOfLines={4}
              placeholder={
                internal
                  ? 'What you found, what you tried, what the next person needs to know.'
                  : 'What you are doing about it, and what happens next.'
              }
              hint={
                internal
                  ? 'Staff only. Does not notify them and does not count as a response.'
                  : 'Sent to their in-app inbox and pushed to their phone.'
              }
            />

            <View style={styles.replyRow}>
              {/*
                A toggle rather than two buttons.

                Two send buttons side by side is one mis-tap away from putting an
                internal note in front of a customer, and that mistake cannot be
                taken back — the push has already left.
              */}
              <Pressable
                onPress={() => setInternal((value) => !value)}
                accessibilityRole="switch"
                accessibilityState={{ checked: internal }}
                accessibilityLabel="Internal note, staff only"
                style={({ pressed }) => [
                  styles.toggle,
                  {
                    backgroundColor: internal ? theme.warningSoft : theme.surfaceMuted,
                    borderColor: internal ? theme.warningOnSoft : theme.border,
                  },
                  pressed && { opacity: 0.7 },
                ]}>
                <Lock color={internal ? theme.warningOnSoft : theme.textMuted} size={14} />
                <Text
                  style={[
                    styles.toggleText,
                    { color: internal ? theme.warningOnSoft : theme.textSecondary },
                  ]}>
                  Internal note
                </Text>
              </Pressable>

              <Button
                label={sending ? 'Sending…' : internal ? 'Add note' : 'Send reply'}
                size="md"
                disabled={sending || draft.trim().length === 0}
                icon={(color, size) =>
                  internal ? (
                    <MessageSquareText color={color} size={size} />
                  ) : (
                    <Send color={color} size={size} />
                  )
                }
                onPress={() => void send()}
              />
            </View>

            {/* ------------------------------------------------ the status -- */}
            <SectionLabel>Move it</SectionLabel>
            <ChipGroup
              options={TICKET_STATUSES}
              selected={ticket.status}
              onSelect={(status) => void move(status)}
              renderLabel={(status) => TICKET_STATUS_LABELS[status]}
              scrollable
            />

            {ticket.status === 'resolved' && !!ticket.resolution && (
              <View style={[styles.resolution, { backgroundColor: theme.successSoft }]}>
                <Text style={[styles.resolutionText, { color: theme.successOnSoft }]}>
                  {ticket.resolution}
                </Text>
              </View>
            )}

            <View style={styles.actions}>
              <Button
                label={mine ? 'Hand it back' : 'Assign to me'}
                variant="secondary"
                size="md"
                onPress={() => void assign(mine ? null : (user?.id ?? null))}
              />
              <Button label="Close" variant="secondary" size="md" onPress={onClose} />
            </View>
          </>
        )}
      </View>

      {resolving && !!ticket && (
        <ModerationDialog
          title={`Resolve ${ticket.reference}`}
          body="This closes the ticket and tells the customer what happened."
          consequences={[
            'Your note is added to the conversation, where they can read it.',
            'They are notified in the app and on their phone.',
            'If they reply to say it is not fixed, the ticket reopens by itself.',
          ]}
          confirmLabel="Resolve"
          reasonRequired
          reasonLabel="What resolved it"
          onConfirm={async (reason) => {
            await setTicketStatus(ticket.id, 'resolved', reason);
            await load();
            onChanged();
            showToast('Ticket resolved', { message: ticket.reference });
          }}
          onClose={() => setResolving(false)}
        />
      )}
    </BottomSheet>
  );
}

/**
 * One entry in the thread.
 *
 * ⚠ An internal note looks like a different kind of object, not like a message
 *   with a label on it. Tinted, bordered, padlocked. The failure this prevents
 *   is an operator skim-reading a note as something the customer has already
 *   been told — and then never telling them.
 */
function ThreadEntry({ message }: { message: TicketMessage }) {
  const theme = useTheme();

  const internal = message.visibility === 'internal';
  const fromUs = message.authorRole === 'admin';

  return (
    <View
      style={[
        styles.entry,
        {
          backgroundColor: internal
            ? theme.warningSoft
            : fromUs
              ? theme.primarySoft
              : theme.surfaceMuted,
          borderColor: internal ? theme.warningOnSoft : 'transparent',
          borderWidth: internal ? StyleSheet.hairlineWidth : 0,
        },
      ]}>
      <View style={styles.entryHead}>
        {internal && <Lock color={theme.warningOnSoft} size={12} />}
        <Text
          style={[
            styles.entryAuthor,
            { color: internal ? theme.warningOnSoft : fromUs ? theme.primaryOnSoft : theme.text },
          ]}>
          {internal ? `${message.authorName} · internal note` : message.authorName}
        </Text>
        <Text style={[styles.entryTime, { color: theme.textMuted }]}>
          {sinceLabel(message.createdAt)}
        </Text>
      </View>
      <Text
        style={[
          styles.entryBody,
          { color: internal ? theme.warningOnSoft : fromUs ? theme.primaryOnSoft : theme.text },
        ]}>
        {message.body}
      </Text>
    </View>
  );
}

/**
 * Logs an inquiry that arrived by phone or email.
 *
 * ⚠ The account is picked, never typed.
 *
 *   A ticket filed against the wrong account is worse than no ticket: it sits in
 *   somebody else's history and the person who actually rang gets forgotten. The
 *   picker searches the same name-or-phone the User & Role screen does, because
 *   a phone number is what an operator has while the caller is still on the line.
 */
function LogCallSheet({
  onClose,
  onLogged,
}: {
  onClose: () => void;
  onLogged: (reference: string) => void;
}) {
  const theme = useTheme();

  const [accounts, setAccounts] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<AdminUser | null>(null);

  const [subject, setSubject] = useState('');
  const [note, setNote] = useState('');
  const [category, setCategory] = useState<TicketCategory>('parcel');
  const [channel, setChannel] = useState<'phone' | 'email'>('phone');
  const [tracking, setTracking] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchUsers()
      .then(setAccounts)
      .catch((thrown) => setError(errorMessage(thrown, 'Could not load accounts.')));
  }, []);

  /*
   * Filtered here rather than in SQL, and only once there is something to filter
   * on. The admin select policy on `profiles` already handed us every account —
   * a second round trip per keystroke would buy nothing.
   */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return accounts
      .filter(
        (account) =>
          account.fullName.toLowerCase().includes(needle) || account.phone.includes(needle),
      )
      .slice(0, 6);
  }, [accounts, query]);

  const log = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const created = await logTicketForCustomer({
        requesterId: picked.id,
        subject: subject.trim(),
        note: note.trim(),
        category,
        channel,
        trackingId: tracking,
      });
      onLogged(created?.reference ?? 'Logged');
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not log the ticket.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet visible onClose={onClose}>
      <View style={styles.sheet}>
        <Text style={[styles.sheetTitle, { color: theme.text }]}>Log a call or an email</Text>
        <Text style={[styles.meta, { color: theme.textSecondary }]}>
          The ticket belongs to the customer, not to you. What you type below is filed as an
          internal note — it is your summary, not their words.
        </Text>

        {!!error && <AdminError message={error} />}

        {picked ? (
          <View style={styles.rowBetween}>
            <View style={styles.inlineFact}>
              <UserRound color={theme.textMuted} size={14} />
              <Text style={[styles.value, { color: theme.text }]}>
                {picked.fullName || 'Unnamed account'}
              </Text>
              <Text style={[styles.meta, { color: theme.textMuted }]}>{picked.phone}</Text>
            </View>
            <Button
              label="Change"
              variant="secondary"
              size="md"
              onPress={() => {
                setPicked(null);
                setQuery('');
              }}
            />
          </View>
        ) : (
          <View style={styles.block}>
            <Field
              label="Whose account is this about"
              value={query}
              onChangeText={setQuery}
              placeholder="Name or phone number"
              autoCapitalize="none"
              autoCorrect={false}
              hint="Two characters to search."
            />
            {matches.map((account) => (
              <Pressable
                key={account.id}
                onPress={() => setPicked(account)}
                accessibilityRole="button"
                accessibilityLabel={`Pick ${account.fullName || 'unnamed account'}`}
                style={({ pressed }) => [
                  styles.pickRow,
                  { borderTopColor: theme.border },
                  pressed && { backgroundColor: theme.surfaceMuted },
                ]}>
                <Text style={[styles.value, { color: theme.text }]}>
                  {account.fullName || 'Unnamed account'}
                </Text>
                <Text style={[styles.meta, { color: theme.textMuted }]}>{account.phone}</Text>
                {account.deletedAt && <Badge label="Erased" tone="danger" uppercase={false} />}
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.block}>
          <Text style={[styles.label, { color: theme.textSecondary }]}>How did it arrive</Text>
          <ChipGroup
            options={['phone', 'email'] as const}
            selected={channel}
            onSelect={setChannel}
            renderLabel={(value) => (value === 'phone' ? 'Phone' : 'Email')}
          />
        </View>

        <View style={styles.block}>
          <Text style={[styles.label, { color: theme.textSecondary }]}>What is it about</Text>
          <ChipGroup
            options={TICKET_CATEGORIES}
            selected={category}
            onSelect={setCategory}
            renderLabel={(value) => TICKET_CATEGORY_LABELS[value]}
            scrollable
          />
        </View>

        <Field
          label="Subject"
          value={subject}
          onChangeText={setSubject}
          placeholder="Driver never arrived for a 9am pickup"
          hint="This is what the queue shows, and what the customer sees."
        />

        <Field
          label="Tracking ID (if it is about a parcel)"
          value={tracking}
          onChangeText={setTracking}
          placeholder="PKR-…"
          autoCapitalize="characters"
          autoCorrect={false}
          hint="Checked against their own parcels. Leave it blank if there isn't one."
        />

        <Field
          label="What they said"
          value={note}
          onChangeText={setNote}
          multiline
          numberOfLines={4}
          placeholder="Rang at 09:40. Says the driver never came and the phone was off."
          hint="Filed as an internal note — staff only."
        />

        <View style={styles.actions}>
          <Button
            label={busy ? 'Logging…' : 'Log the ticket'}
            size="md"
            disabled={busy || !picked || subject.trim().length === 0}
            icon={(color, size) => <Phone color={color} size={size} />}
            onPress={() => void log()}
          />
          <Button label="Cancel" variant="secondary" size="md" onPress={onClose} />
        </View>
      </View>
    </BottomSheet>
  );
}

/** A labelled value in a wrapping row. Same shape as the finance screen's. */
function Fact({ label, value }: { label: string; value: string }) {
  const theme = useTheme();

  return (
    <View style={styles.fact}>
      <Text style={[styles.factLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.factValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    marginVertical: Spacing.six,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  controls: {
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three - 2,
    height: 42,
  },
  searchInput: {
    flex: 1,
    ...Typography.meta,
  },
  alert: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two + 2,
    padding: Spacing.three,
    borderRadius: Radius.md,
    marginBottom: Spacing.four,
  },
  alertText: {
    flex: 1,
    flexBasis: 200,
    gap: Spacing.half,
  },
  alertTitle: {
    ...Typography.meta,
    ...font(700),
  },
  alertBody: {
    ...Typography.caption,
    lineHeight: 18,
  },
  emptyCard: {
    marginBottom: Spacing.four,
  },
  list: {
    gap: Spacing.two + 2,
    marginBottom: Spacing.four,
  },
  cardSlot: {
    cursor: 'pointer',
  },
  card: {
    gap: Spacing.two,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  cardHeadText: {
    flex: 1,
    gap: Spacing.half,
  },
  cardHeadRight: {
    alignItems: 'flex-end',
    gap: Spacing.one,
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
  factRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  inlineFact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    flexShrink: 1,
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  meta: {
    ...Typography.caption,
  },
  value: {
    ...Typography.meta,
    ...font(700),
  },
  label: {
    ...Typography.caption,
    ...font(700),
  },
  fact: {
    gap: 1,
    flexGrow: 1,
    flexBasis: 110,
  },
  factLabel: {
    ...Typography.caption,
  },
  factValue: {
    ...Typography.meta,
    ...font(600),
  },
  sheet: {
    gap: Spacing.three,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  sheetTitle: {
    fontSize: FontSize.subhead,
    ...font(800),
  },
  block: {
    gap: Spacing.two,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  accountId: {
    ...Typography.caption,
  },
  thread: {
    gap: Spacing.two,
  },
  entry: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    gap: Spacing.one,
  },
  entryHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  entryAuthor: {
    ...Typography.caption,
    ...font(700),
    flex: 1,
  },
  entryTime: {
    ...Typography.caption,
  },
  entryBody: {
    ...Typography.meta,
    lineHeight: 20,
  },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: Spacing.one + 2,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    cursor: 'pointer',
  },
  toggleText: {
    ...Typography.caption,
    ...font(700),
  },
  resolution: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
  },
  resolutionText: {
    ...Typography.meta,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
