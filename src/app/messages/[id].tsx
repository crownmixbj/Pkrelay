import { useLocalSearchParams } from 'expo-router';
import { ArrowLeft, MessageCircle, PackageSearch, Phone, Send } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { showDialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/screen';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { StickyHeaderScreen } from '@/components/ui/sticky-header';
import { MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useGoBack } from '@/hooks/use-go-back';
import { useLiveRefresh } from '@/hooks/use-live-refresh';
import { useTheme } from '@/hooks/use-theme';
import { errorMessage } from '@/lib/errors';
import { findParcel } from '@/lib/parcel-link';
import { formatClock, formatDay } from '@/lib/when';
import { statusLabel, statusTone, useBookings } from '@/store/bookings';
import {
  chatIsOpen,
  chatRole,
  fetchThread,
  markThreadRead,
  MESSAGE_MAX_LENGTH,
  sendMessage,
  type ParcelMessage,
} from '@/store/parcel-messages';
import { useSession } from '@/store/session';

/**
 * Messages between a parcel's sender and its driver.
 *
 * Reached from "Message sender" on the driver's job card, "Message driver" on
 * the sender's parcel, and from the push / inbox notification a new message
 * raises. Live: a Realtime subscription on this parcel's messages brings the
 * other side's replies in within a second, with a poll behind it.
 *
 * Quick replies cover the handful of things a driver on a motorbike actually
 * says — typing a sentence at a junction is the thing this screen should make
 * unnecessary.
 */

const QUICK_REPLIES: Record<'driver' | 'sender', string[]> = {
  driver: [
    "I'm on my way to collect the parcel.",
    "I've arrived at the pickup point.",
    "I'm running about 10 minutes late.",
    'Please confirm the pickup address.',
  ],
  sender: [
    'The parcel is ready for pickup.',
    'Please call me when you arrive.',
    "I'll be there in 5 minutes.",
    'Thank you!',
  ],
};

export default function ParcelMessagesScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const goBack = useGoBack('/(tabs)/my-packages');
  const { bookings, loading } = useBookings();
  const { user, isAuthenticated } = useSession();

  const booking = useMemo(() => findParcel(bookings, id), [bookings, id]);
  const role = booking ? chatRole(booking, user?.id) : null;
  const open = booking ? chatIsOpen(booking) : false;

  const [messages, setMessages] = useState<ParcelMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<ScrollView>(null);

  const bookingId = booking?.id ?? null;
  const driverId = booking?.driverId ?? null;

  const refresh = useCallback(async () => {
    if (!bookingId || !driverId) return;
    try {
      const thread = await fetchThread(bookingId, driverId);
      setMessages(thread);
      setLoadError(null);
      // Anything addressed to the viewer is now on screen.
      if (thread.some((m) => m.authorId !== user?.id && !m.readAt)) {
        void markThreadRead(bookingId);
      }
    } catch (thrown) {
      setLoadError(errorMessage(thrown, 'Could not load messages.'));
    }
  }, [bookingId, driverId, user?.id]);

  const enabled = !!bookingId && !!driverId && !!role;

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  useLiveRefresh(refresh, {
    channel: `parcel-chat:${bookingId ?? 'none'}`,
    tables: ['parcel_messages'],
    filter: bookingId ? `booking_id=eq.${bookingId}` : undefined,
    intervalMs: 15_000,
    debounceMs: 150,
    enabled,
  });

  // Keep the newest message in view.
  useEffect(() => {
    const timer = setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(timer);
  }, [messages?.length]);

  const send = async (text: string) => {
    const body = text.trim();
    if (!bookingId || !body || sending) return;

    setSending(true);
    try {
      const saved = await sendMessage(bookingId, body);
      setMessages((current) =>
        current?.some((m) => m.id === saved.id) ? current : [...(current ?? []), saved],
      );
      if (text === draft) setDraft('');
    } catch (thrown) {
      showDialog('Message not sent', errorMessage(thrown, 'Check your connection and try again.'));
    } finally {
      setSending(false);
    }
  };

  // ------------------------------------------------------------ states ----

  if (!booking && loading) {
    return (
      <StickyHeaderScreen>
        <View style={[styles.center, { backgroundColor: theme.background }]}>
          <ActivityIndicator color={theme.primary} />
        </View>
      </StickyHeaderScreen>
    );
  }

  if (!booking && !isAuthenticated) {
    return (
      <StickyHeaderScreen>
        <View style={[styles.center, { backgroundColor: theme.background }]}>
          <View style={styles.narrow}>
            <SignedOutState
              title="Sign in to read your messages"
              message="Messages about a parcel are only shown to its sender and its driver."
              next={`/messages/${id ?? ''}`}
            />
          </View>
        </View>
      </StickyHeaderScreen>
    );
  }

  if (!booking || !role) {
    return (
      <StickyHeaderScreen>
        <View style={[styles.center, { backgroundColor: theme.background }]}>
          <View style={styles.narrow}>
            <EmptyState
              icon={(color, size) => <PackageSearch color={color} size={size} />}
              title="Conversation not available"
              message="Only the sender and the driver carrying a parcel can message about it."
            />
            <Button label="Go back" variant="secondary" onPress={goBack} />
          </View>
        </View>
      </StickyHeaderScreen>
    );
  }

  const otherName =
    role === 'driver'
      ? booking.pickupContactName?.trim() || 'the sender'
      : booking.driver?.trim() || 'your driver';
  const otherPhone = role === 'driver' ? booking.senderPhone : null;

  // ------------------------------------------------------------- screen ----

  return (
    <StickyHeaderScreen>
      <KeyboardAvoidingView
        style={[styles.flex, { backgroundColor: theme.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}>
        <View style={styles.page}>
          {/* ---------- Header ---------- */}
          <View
            style={[
              styles.header,
              { backgroundColor: theme.surface, borderBottomColor: theme.border },
            ]}>
            <Pressable
              onPress={goBack}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={[styles.iconButton, { backgroundColor: theme.surfaceMuted }]}>
              <ArrowLeft color={theme.text} size={18} />
            </Pressable>
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                {role === 'driver' ? `Sender · ${otherName}` : `Driver · ${otherName}`}
              </Text>
              <Text style={[styles.subtitle, { color: theme.textMuted }]} numberOfLines={1}>
                #{booking.trackingId} · {booking.originCity} → {booking.destinationCity}
              </Text>
            </View>
            <Badge label={statusLabel(booking)} tone={statusTone(booking)} />
            {!!otherPhone && Platform.OS !== 'web' && (
              <Pressable
                onPress={() => void Linking.openURL(`tel:${otherPhone}`)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={`Call ${otherName}`}
                style={[styles.iconButton, { backgroundColor: theme.primarySoft }]}>
                <Phone color={theme.primaryOnSoft} size={17} />
              </Pressable>
            )}
          </View>

          {/* ---------- Thread ---------- */}
          <ScrollView
            ref={scroller}
            style={styles.flex}
            contentContainerStyle={styles.thread}
            keyboardShouldPersistTaps="handled">
            {messages === null && !loadError ? (
              <ActivityIndicator color={theme.primary} style={styles.loading} />
            ) : loadError ? (
              <Text style={[styles.notice, { color: theme.dangerOnSoft }]}>{loadError}</Text>
            ) : messages && messages.length === 0 ? (
              <EmptyState
                icon={(color, size) => <MessageCircle color={color} size={size} />}
                title="No messages yet"
                message={
                  role === 'driver'
                    ? 'Let the sender know you are on your way, or ask anything about the pickup.'
                    : 'Send your driver pickup instructions, or ask when they will arrive.'
                }
              />
            ) : (
              messages?.map((message, index) => {
                const mine = message.authorId === user?.id;
                const previous = messages[index - 1];
                const newDay =
                  !previous ||
                  new Date(previous.createdAt).toDateString() !==
                    new Date(message.createdAt).toDateString();

                return (
                  <View key={message.id}>
                    {newDay && (
                      <Text style={[styles.day, { color: theme.textMuted }]}>
                        {formatDay(message.createdAt)}
                      </Text>
                    )}
                    <View style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowTheirs]}>
                      <View
                        style={[
                          styles.bubble,
                          mine
                            ? [styles.bubbleMine, { backgroundColor: theme.primary }]
                            : [
                                styles.bubbleTheirs,
                                { backgroundColor: theme.surface, borderColor: theme.border },
                              ],
                        ]}>
                        <Text
                          selectable
                          style={[
                            styles.bubbleText,
                            { color: mine ? theme.primaryText : theme.text },
                          ]}>
                          {message.body}
                        </Text>
                        <Text
                          style={[
                            styles.stamp,
                            { color: mine ? theme.primaryText : theme.textMuted },
                          ]}>
                          {formatClock(message.createdAt)}
                          {mine ? (message.readAt ? ' · Seen' : ' · Sent') : ''}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>

          {/* ---------- Composer ---------- */}
          {open ? (
            <View
              style={[
                styles.composerWrap,
                { backgroundColor: theme.surface, borderTopColor: theme.border },
              ]}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.quickRow}
                keyboardShouldPersistTaps="handled">
                {QUICK_REPLIES[role].map((reply) => (
                  <Pressable
                    key={reply}
                    onPress={() => void send(reply)}
                    disabled={sending}
                    accessibilityRole="button"
                    accessibilityLabel={`Send: ${reply}`}
                    style={({ pressed }) => [
                      styles.quick,
                      { borderColor: theme.border, backgroundColor: theme.surfaceMuted },
                      pressed && styles.pressed,
                    ]}>
                    <Text style={[styles.quickText, { color: theme.textSecondary }]}>{reply}</Text>
                  </Pressable>
                ))}
              </ScrollView>

              <View style={styles.composer}>
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={`Message ${otherName}`}
                  placeholderTextColor={theme.textMuted}
                  multiline
                  maxLength={MESSAGE_MAX_LENGTH}
                  editable={!sending}
                  accessibilityLabel={`Message ${otherName}`}
                  onKeyPress={(event) => {
                    // Enter sends on web; Shift+Enter makes a new line.
                    const native = event.nativeEvent as { key: string; shiftKey?: boolean };
                    if (Platform.OS === 'web' && native.key === 'Enter' && !native.shiftKey) {
                      (event as unknown as { preventDefault?: () => void }).preventDefault?.();
                      void send(draft);
                    }
                  }}
                  style={[
                    styles.input,
                    {
                      color: theme.text,
                      backgroundColor: theme.surfaceMuted,
                      borderColor: theme.border,
                    },
                  ]}
                />
                <Pressable
                  onPress={() => void send(draft)}
                  disabled={sending || draft.trim().length === 0}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  style={({ pressed }) => [
                    styles.send,
                    {
                      backgroundColor:
                        sending || draft.trim().length === 0 ? theme.border : theme.primary,
                    },
                    pressed && styles.pressed,
                  ]}>
                  {sending ? (
                    <ActivityIndicator color={theme.primaryText} size="small" />
                  ) : (
                    <Send color={theme.primaryText} size={18} />
                  )}
                </Pressable>
              </View>
            </View>
          ) : (
            <View
              style={[
                styles.closed,
                { backgroundColor: theme.surfaceMuted, borderTopColor: theme.border },
              ]}>
              <Text style={[styles.notice, { color: theme.textSecondary }]}>
                {booking.driverId
                  ? `This parcel is ${statusLabel(booking).toLowerCase()}, so the chat is closed. Contact support if something is wrong.`
                  : 'Messaging opens once a driver accepts this parcel.'}
              </Text>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </StickyHeaderScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.four },
  narrow: { width: '100%', maxWidth: 480, gap: Spacing.three },
  page: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerText: { flex: 1, gap: 2 },
  title: { ...Typography.meta, ...font(700) },
  subtitle: { ...Typography.caption },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thread: { padding: Spacing.three, gap: Spacing.two, flexGrow: 1 },
  loading: { marginTop: Spacing.five },
  day: { ...Typography.caption, ...font(600), textAlign: 'center', marginVertical: Spacing.two },
  bubbleRow: { flexDirection: 'row' },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: Spacing.three - 2,
    paddingVertical: Spacing.two,
    borderRadius: Radius.lg,
    gap: 4,
  },
  bubbleMine: { borderBottomRightRadius: 4 },
  bubbleTheirs: { borderBottomLeftRadius: 4, borderWidth: StyleSheet.hairlineWidth },
  bubbleText: { ...Typography.body, lineHeight: 21 },
  stamp: { ...Typography.caption, fontSize: 11, opacity: 0.85, alignSelf: 'flex-end' },
  composerWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.three,
    gap: Spacing.two,
  },
  quickRow: { paddingHorizontal: Spacing.three, gap: Spacing.two },
  quick: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three - 2,
    paddingVertical: Spacing.one + 2,
  },
  quickText: { ...Typography.caption, ...font(600) },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.three - 2,
    paddingTop: 11,
    paddingBottom: 11,
    ...Typography.body,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closed: { borderTopWidth: StyleSheet.hairlineWidth, padding: Spacing.three },
  notice: { ...Typography.caption, lineHeight: 18, textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
