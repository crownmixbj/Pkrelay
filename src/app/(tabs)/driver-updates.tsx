import { useRouter } from 'expo-router';
import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  Circle,
  FileText,
  LayoutDashboard,
  RefreshCw,
  UserPen,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DocumentAlerts } from '@/components/ui/document-locker';
import { ProfileEditSheet } from '@/components/ui/profile-edit-sheet';
import { EmptyState, screenPadding, ScreenHeader, SectionLabel } from '@/components/ui/screen';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { showToast } from '@/components/ui/toast';
import { MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  DECISION_EMAILS_ENABLED,
  formatWhen,
  notificationTimeline,
  reviewTimeline,
  type TimelineEntry,
  type TimelineTone,
} from '@/store/application-timeline';
import { REVIEW_WORKING_DAYS, STATUS_LABELS } from '@/store/driver-applications';
import { useSession } from '@/store/session';

// The Be a Driver form. Its own route as well as this one — same component, so
// the two can never ask for different things.
import DriverSignupScreen from './driver-signup';

/**
 * Be a Driver / Updates.
 *
 * One entry, two states, because they are two halves of the same thing: if you
 * have not applied you get the Be a Driver form itself — not a page describing
 * it with a button — and once you have, you get the review and the record of
 * every message we sent about it.
 *
 * The form here is the *same component* the /driver-signup route renders, not a
 * copy. A second copy of a thirty-field application would drift within a week,
 * and validation drifting between two versions of a form asking for a NIN and a
 * bank account is not a cosmetic problem.
 *
 * The timeline is read from the application row, so this screen cannot claim an
 * email that was never sent — see `store/application-timeline.ts`. It also
 * updates live: the session subscribes to this user's own row, so an approval
 * lands without a refresh.
 */
export default function DriverUpdatesScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { isAuthenticated, status, application, driverStatusLoaded, refreshDriverStatus } =
    useSession();
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);

  /**
   * Which half to show, decided once and then left alone.
   *
   * Deriving it from `application` on every render would swap the form out from
   * under someone the instant they submitted — `refreshDriverStatus` populates
   * the row, this screen would flip to the timeline, and the form's own
   * "Application received" confirmation would never appear. Latching it means
   * the submit flow finishes the way it was designed to.
   */
  const [view, setView] = useState<'apply' | 'updates' | null>(null);

  useEffect(() => {
    // `application === null` also means "not looked up yet", which is why the
    // decision waits for `driverStatusLoaded` rather than for a non-null row.
    if (view !== null || !driverStatusLoaded) return;
    setView(application ? 'updates' : 'apply');
  }, [application, driverStatusLoaded, view]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshDriverStatus();
      showToast('Up to date', { message: 'Checked for changes to your application.' });
    } finally {
      setRefreshing(false);
    }
  }, [refreshDriverStatus]);

  if (status === 'loading' || view === null) {
    return (
      <View style={[styles.loading, { backgroundColor: theme.background }]}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  /*
   * The Be a Driver form, rendered whole.
   *
   * Returned bare rather than inside `Shell`: it brings its own
   * KeyboardAvoidingView and ScrollView, and nesting scroll containers breaks
   * keyboard avoidance on iOS and produces a scroll-within-a-scroll on web.
   *
   * Deliberately not gated on being signed in. The form asks for an account at
   * *submit*, keeps a draft while you sign in, and hands it back — see
   * `use-form-draft`. Putting a login wall in front of it would mean asking
   * someone to create an account before they can see what is being asked of
   * them.
   */
  if (view === 'apply') {
    return <DriverSignupScreen />;
  }

  if (!isAuthenticated) {
    return (
      <Shell>
        <SignedOutState
          title="Sign in to see your updates"
          message="Your application status and the emails we've sent are tied to your account."
          next="/driver-updates"
        />
      </Shell>
    );
  }

  if (!application) {
    return (
      <Shell>
        <Card style={styles.emptyCard}>
          <EmptyState
            icon={(color, size) => <FileText color={color} size={size} />}
            title="No application yet"
            message={`Once you apply to drive, this page tracks the review and every email we send you. Reviews take up to ${REVIEW_WORKING_DAYS} working days.`}
          />
          <Button
            label="Start your driver application"
            onPress={() => router.navigate('/driver-signup')}
          />
        </Card>
      </Shell>
    );
  }

  const review = reviewTimeline(application);
  const notifications = notificationTimeline(application);

  return (
    <Shell>
      <View style={styles.statusStrip}>
        <Badge
          label={STATUS_LABELS[application.status]}
          tone={
            application.status === 'approved'
              ? 'success'
              : application.status === 'rejected'
                ? 'danger'
                : application.status === 'under_review'
                  ? 'primary'
                  : 'warning'
          }
        />
        <Text style={[styles.reference, { color: theme.textMuted }]}>{application.reference}</Text>
      </View>

      <SectionLabel>Progress</SectionLabel>
      <Card style={styles.timelineCard}>
        {review.map((entry, index) => (
          <TimelineRow key={entry.key} entry={entry} last={index === review.length - 1} />
        ))}
      </Card>

      <SectionLabel>Notifications</SectionLabel>
      <Card style={styles.timelineCard}>
        {notifications.map((entry, index) => (
          <TimelineRow key={entry.key} entry={entry} last={index === notifications.length - 1} />
        ))}

        {/*
          Stated rather than left to be discovered.

          The confirmation email promises "we will email you as soon as a
          decision is made", and no code sends that message yet. Someone waiting
          on an inbox that will stay quiet is the exact failure this screen
          exists to prevent — so it says where to actually look.
        */}
        {!DECISION_EMAILS_ENABLED && (
          <View style={[styles.notice, { backgroundColor: theme.primarySoft }]}>
            <CircleAlert color={theme.primaryOnSoft} size={15} />
            <Text style={[styles.noticeText, { color: theme.primaryOnSoft }]}>
              Decision emails aren&apos;t switched on yet. When your application is approved or
              rejected you&apos;ll see it here and get an in-app notification — not an email. Check
              back, or keep the app open.
            </Text>
          </View>
        )}
      </Card>

      {/*
        ---------- Editing ----------

        Approved drivers only. Before approval the whole application is still
        editable through the form they submitted, and offering a second edit
        path beside it would be two ways to change the same row.

        A driver already back under review keeps the button: the reason they are
        under review may be the thing they need to correct, and taking the
        control away at exactly that moment leaves them stuck waiting for an
        admin to ask them for it.
      */}
      {(application.status === 'approved' || application.status === 'under_review') && (
        <>
          {/*
            ---------- Document alerts ----------

            Above the editor, and only the banners.

            An expired licence has stopped this driver earning, which outranks
            every other thing on the page. The document *list* is not here — it
            lives inside Edit your details with the rest of the submitted
            application, because that is where somebody looks for "what did I
            give Package Relay". Status where it is seen; information where it belongs.
          */}
          <DocumentAlerts />

          <SectionLabel>Your details</SectionLabel>
          <Card style={styles.timelineCard}>
            <Text style={[styles.editNote, { color: theme.textSecondary }]}>
              Vehicle, address and next of kin save straight away. Changing your legal name, NIN,
              licence or guarantor sends your account back for review.
            </Text>
            <Button
              label="Edit profile"
              size="md"
              icon={(color, size) => <UserPen color={color} size={size} />}
              onPress={() => setEditing(true)}
            />
          </Card>

          <ProfileEditSheet
            visible={editing}
            application={application}
            onClose={() => setEditing(false)}
            onSaved={() => void refresh()}
          />
        </>
      )}

      <View style={styles.actions}>
        <Button
          label={refreshing ? 'Checking…' : 'Check for updates'}
          variant="secondary"
          size="md"
          disabled={refreshing}
          icon={(color, size) => <RefreshCw color={color} size={size} />}
          onPress={() => void refresh()}
          style={styles.action}
        />
        <Button
          label="Driver Portal"
          size="md"
          icon={(color, size) => <LayoutDashboard color={color} size={size} />}
          onPress={() => router.navigate('/driver')}
          style={styles.action}
        />
      </View>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const theme = useTheme();

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        <ScreenHeader
          brand={false}
          title="Be a Driver / Updates"
          subtitle="Where your driver application stands, and every message we've sent about it."
        />
        {children}
      </View>
      <Footer />
    </ScrollView>
  );
}

const TONE_ICON: Record<TimelineTone, (color: string) => React.ReactNode> = {
  done: (color) => <CircleCheck color={color} size={18} />,
  current: (color) => <CircleDot color={color} size={18} />,
  pending: (color) => <Circle color={color} size={18} />,
  failed: (color) => <CircleAlert color={color} size={18} />,
};

function TimelineRow({ entry, last }: { entry: TimelineEntry; last: boolean }) {
  const theme = useTheme();

  const color =
    entry.tone === 'done'
      ? theme.success
      : entry.tone === 'failed'
        ? theme.danger
        : entry.tone === 'current'
          ? theme.primary
          : theme.textMuted;

  return (
    <View style={styles.row}>
      {/*
        The rail is drawn per row rather than as one line behind the column, so
        it always ends at the last dot. A single absolutely-positioned line
        overshoots whenever the final entry is shorter than the others.
      */}
      <View style={styles.rail}>
        {TONE_ICON[entry.tone](color)}
        {!last && <View style={[styles.railLine, { backgroundColor: theme.border }]} />}
      </View>

      <View style={[styles.rowText, last && styles.rowTextLast]}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>{entry.title}</Text>
        {!!entry.at && (
          <Text style={[styles.rowWhen, { color: theme.textMuted }]}>{formatWhen(entry.at)}</Text>
        )}
        <Text style={[styles.rowDetail, { color: theme.textSecondary }]}>{entry.detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCard: {
    gap: Spacing.three,
    marginTop: Spacing.three,
  },
  statusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
    marginBottom: Spacing.two,
  },
  reference: {
    ...Typography.meta,
    ...font(600),
  },
  editNote: { ...Typography.caption, lineHeight: 18 },
  timelineCard: {
    gap: 0,
    marginBottom: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.two + 2,
  },
  rail: {
    alignItems: 'center',
    width: 18,
  },
  railLine: {
    width: 2,
    flex: 1,
    marginTop: 2,
    marginBottom: 2,
    borderRadius: 1,
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
    paddingBottom: Spacing.four,
  },
  rowTextLast: {
    paddingBottom: 0,
  },
  rowTitle: {
    ...Typography.meta,
    ...font(700),
  },
  rowWhen: {
    ...Typography.caption,
  },
  rowDetail: {
    ...Typography.caption,
    lineHeight: 18,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    marginTop: Spacing.three,
  },
  noticeText: {
    ...Typography.caption,
    ...font(600),
    flex: 1,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  action: {
    flexGrow: 1,
    flexBasis: 160,
  },
});
