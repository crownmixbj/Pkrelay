import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Banknote,
  CircleCheckBig,
  Clock,
  FileText,
  IdCard,
  Landmark,
  MailWarning,
  MapPin,
  PhoneCall,
  ShieldAlert,
  ShieldCheck,
  Truck,
  UserRound,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { errorMessage } from '@/lib/errors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DispatchControl } from '@/components/ui/dispatch-control';
import { ChipGroup } from '@/components/ui/chip';
import { showDialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { EmptyState, screenPadding, ScreenHeader, SectionLabel } from '@/components/ui/screen';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { showToast } from '@/components/ui/toast';
import { FontSize, MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  canApprove,
  canReject,
  fetchAllApplications,
  isAwaitingReview,
  isOverdue,
  isWaitingOnGuarantor,
  subscribeToApplications,
  reviewApplication,
  REVIEW_WORKING_DAYS,
  STATUS_LABELS,
  workingDaysSince,
  type ApplicationStatus,
  type DriverApplication,
  type ReviewDecision,
} from '@/store/driver-applications';
import { useSession } from '@/store/session';
import { AdminOverview as OverviewPanel } from '@/components/ui/admin-overview';
import { signedDocumentUrl } from '@/store/driver-documents';

/**
 * Two of the five Admin views: the overview, and this review queue.
 *
 * One screen because the overview's headline numbers *are* the queue's numbers
 * — splitting them would mean two places computing "how many are waiting" and
 * eventually disagreeing.
 */
const SECTIONS = ['overview', 'dispatch', 'review'] as const;
type Section = (typeof SECTIONS)[number];

/**
 * ⚠ Long enough that "no" cannot be the whole message.
 *
 *   The number is arbitrary; what it buys is that the field cannot be cleared
 *   with a single character to get past it, which is what a length-1 check
 *   would have allowed. It is a floor on effort, not a measure of quality — a
 *   reviewer determined to write "no reason" still can, and no validation can
 *   stop that.
 */
const MIN_REASON = 12;

const SECTION_LABELS: Record<Section, string> = {
  overview: 'Overview',
  dispatch: 'Dispatch',
  review: 'Driver review',
};

/*
  Dispatch sits between the two on purpose.

  Overview answers "is anything wrong"; Dispatch is where you act on the answer;
  Driver review is a queue you work through on a different rhythm. Putting the
  control after the review queue would mean the tab you reach for during an
  incident is the one furthest from the tab that told you there was one.
*/

const SCREEN_TITLES: Record<Section, string> = {
  overview: 'Dashboard Overview',
  dispatch: 'Dispatch & Assignment',
  review: 'Driver & App Review',
};

function parseAdminSection(value: unknown): Section {
  return SECTIONS.includes(value as Section) ? (value as Section) : 'overview';
}

/*
 * ⚠ The first filter is a *set*, not a status.
 *
 *   `pending` and `ready_for_review` both mean "an admin's to pick up" — the
 *   first is every application submitted before guarantor verification existed,
 *   the second is every one submitted since. A chip literally labelled
 *   `pending` would have shown the old half of the queue and silently hidden
 *   the new half, which grows every day. So the chip is "Awaiting review" and
 *   it matches both, through `isAwaitingReview`.
 *
 * ⚠ And "Waiting on guarantor" is its own chip rather than being buried in All.
 *
 *   Those applications are not the queue's work, but somebody has to be able to
 *   see them — to notice that four applications this week have been sitting on
 *   an unopened email, which is a product problem rather than a staffing one.
 */
const FILTERS = [
  'awaiting',
  'pending_guarantor',
  'under_review',
  'approved',
  'rejected',
  'all',
] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABELS: Record<Filter, string> = {
  awaiting: 'Awaiting review',
  pending_guarantor: 'Waiting on guarantor',
  under_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  all: 'All',
};

/** Which applications a chip shows. One place, so a chip cannot mean two things. */
function matchesFilter(status: ApplicationStatus, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'awaiting') return isAwaitingReview(status);
  return status === filter;
}

/**
 * Driver application review.
 *
 * Only reachable, and only useful, for an account whose profile has `is_admin`.
 * The check below hides the screen; Row Level Security is what actually refuses
 * the data, so a non-admin who navigates here directly sees an empty list
 * rather than someone else's bank details.
 */
export default function AdminScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ section?: string }>();
  const { user, isAdmin, isAuthenticated } = useSession();

  const [section, setSection] = useState<Section>(() => parseAdminSection(params.section));

  // The URL leads, so the nav can open either view while already on this screen.
  useEffect(() => setSection(parseAdminSection(params.section)), [params.section]);

  const chooseSection = (next: Section) => {
    setSection(next);
    router.setParams({ section: next });
  };

  const [applications, setApplications] = useState<DriverApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('awaiting');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setApplications(await fetchAllApplications());
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not load applications.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    void load();
  }, [isAdmin, load]);

  /*
   * ⚠ The queue keeps up with things nobody here did.
   *
   *   Every other change to an application is made by the admin looking at this
   *   screen, so the list being a snapshot was fine — you saw the result of your
   *   own click. A guarantor completing their verification is different: it
   *   happens when a stranger opens an email, at no moment anybody here can
   *   predict, and it moves an application into this queue. Without this, it
   *   sits unseen for as long as the tab stays open.
   */
  useEffect(() => {
    if (!isAdmin) return;

    return subscribeToApplications((changed) => {
      setApplications((current) => {
        const at = current.findIndex((a) => a.id === changed.id);
        /*
         * A brand-new application arrives as an INSERT — it belongs at the top,
         * where the list is already sorted newest-first.
         */
        if (at === -1) return [changed, ...current];

        const next = [...current];
        next[at] = changed;
        return next;
      });
    });
  }, [isAdmin]);

  const counts = useMemo(() => {
    const by = (status: ApplicationStatus) =>
      applications.filter((a) => a.status === status).length;
    return {
      /*
       * ⚠ Both, added together.
       *
       *   Counting only `pending` would show a shrinking number while the real
       *   queue grew — the most misleading shape a backlog metric can take.
       */
      awaiting: applications.filter((a) => isAwaitingReview(a.status)).length,
      waitingOnGuarantor: by('pending_guarantor'),
      under_review: by('under_review'),
      approved: by('approved'),
      rejected: by('rejected'),
      overdue: applications.filter((a) => isOverdue(a)).length,
    };
  }, [applications]);

  const visible = useMemo(
    () => applications.filter((a) => matchesFilter(a.status, filter)),
    [applications, filter],
  );

  const approve = (application: DriverApplication) => {
    if (!user) return;

    showDialog(
      'Approve this driver?',
      `${application.fullName} will be able to accept delivery jobs immediately. Check the documents and guarantor first — this is the only gate.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          onPress: () => void apply(application, { status: 'approved', reviewerId: user.id }),
        },
      ],
    );
  };

  /*
   * ⚠ No second confirmation, because the reason field already is one.
   *
   *   The reviewer has just typed a sentence explaining themselves to a named
   *   person; a modal asking "are you sure" on top of that is the kind of prompt
   *   people learn to dismiss without reading, which is what makes the *next*
   *   one — the approval — less safe too.
   */
  const reject = (application: DriverApplication, reason: string) => {
    if (!user) return;
    void apply(application, { status: 'rejected', note: reason, reviewerId: user.id });
  };

  const apply = async (application: DriverApplication, decision: ReviewDecision) => {
    setBusyId(application.id);
    try {
      const updated = await reviewApplication(application.id, decision);
      setApplications((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      showToast(decision.status === 'approved' ? 'Driver approved' : 'Application rejected', {
        message: `${application.fullName} — ${application.reference}`,
      });
    } catch (thrown) {
      showDialog('Could not save the decision', errorMessage(thrown, 'Try again.'));
    } finally {
      setBusyId(null);
    }
  };

  if (!isAuthenticated) {
    return (
      <ScrollView contentContainerStyle={[styles.container, screenPadding]}>
        <View style={styles.content}>
          <SignedOutState
            title="Sign in to review applications"
            message="The review dashboard is only available to LOCI administrators."
            next="/admin"
          />
        </View>
      </ScrollView>
    );
  }

  /*
   * Deliberately vague. Telling a signed-in non-admin "you are not an admin"
   * confirms the dashboard exists and that admin accounts are a thing worth
   * hunting for.
   */
  if (!isAdmin) {
    return (
      <ScrollView contentContainerStyle={[styles.container, screenPadding]}>
        <View style={styles.content}>
          <Card style={styles.emptyCard}>
            <EmptyState
              icon={(color, size) => <ShieldAlert color={color} size={size} />}
              title="Not available"
              message="This area isn't available on your account."
            />
            <Button label="Back to LOCI" size="md" onPress={() => router.replace('/')} />
          </Card>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        <ScreenHeader
          brand={false}
          title={SCREEN_TITLES[section]}
          subtitle={
            section === 'overview'
              ? 'How the platform is running right now.'
              : section === 'dispatch'
                ? 'Whether LOCI matches parcels to drivers, or you do.'
                : `Review within ${REVIEW_WORKING_DAYS} working days, as the Drivers page promises.`
          }
        />

        <ChipGroup
          options={SECTIONS as unknown as string[]}
          selected={section}
          onSelect={(value) => chooseSection(value as Section)}
          renderLabel={(value) => SECTION_LABELS[value as Section]}
          scrollable
        />

        {section === 'overview' && <OverviewPanel onReview={() => chooseSection('review')} />}

        {section === 'dispatch' && <DispatchControl />}

        {section === 'review' && (
          <>
            {/* ---------- Queue health ---------- */}
            <View style={styles.stats}>
              <Stat label="Awaiting review" value={counts.awaiting} tone="warning" />
              {/*
                ⚠ Shown next to the backlog, and deliberately not counted in it.

                  These are held on somebody outside LOCI. Adding more reviewers
                  clears none of them, so folding them into "Awaiting review"
                  would be a number that asks for the wrong response.
              */}
              <Stat label="Waiting on guarantor" value={counts.waitingOnGuarantor} tone="neutral" />
              <Stat label="In review" value={counts.under_review} tone="primary" />
              <Stat label="Approved" value={counts.approved} tone="success" />
              <Stat
                label={`Past ${REVIEW_WORKING_DAYS} days`}
                value={counts.overdue}
                tone={counts.overdue > 0 ? 'danger' : 'neutral'}
              />
            </View>

            <ChipGroup
              options={FILTERS as unknown as string[]}
              selected={filter}
              onSelect={(value) => setFilter(value as Filter)}
              renderLabel={(value) => FILTER_LABELS[value as Filter]}
            />

            {!!error && (
              <View style={[styles.banner, { backgroundColor: theme.dangerSoft }]}>
                <Text style={[styles.bannerText, { color: theme.dangerOnSoft }]}>{error}</Text>
              </View>
            )}

            {loading ? (
              <View style={styles.loading}>
                <ActivityIndicator color={theme.primary} />
                <Text style={[styles.loadingText, { color: theme.textSecondary }]}>
                  Loading applications…
                </Text>
              </View>
            ) : visible.length === 0 ? (
              <Card style={styles.emptyCard}>
                <EmptyState
                  icon={(color, size) => <CircleCheckBig color={color} size={size} />}
                  title={filter === 'awaiting' ? 'Nothing waiting' : 'No applications here'}
                  message={
                    filter === 'awaiting'
                      ? 'Every application has been looked at. New ones appear here as they arrive.'
                      : 'Try another filter.'
                  }
                />
              </Card>
            ) : (
              visible.map((application) => (
                <ApplicationCard
                  key={application.id}
                  application={application}
                  busy={busyId === application.id}
                  onApprove={() => approve(application)}
                  onReject={(reason) => reject(application, reason)}
                />
              ))
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'primary' | 'success' | 'warning' | 'danger' | 'neutral';
}) {
  const theme = useTheme();
  const color =
    tone === 'success'
      ? theme.successOnSoft
      : tone === 'warning'
        ? theme.warningOnSoft
        : tone === 'danger'
          ? theme.dangerOnSoft
          : tone === 'primary'
            ? theme.primaryOnSoft
            : theme.textSecondary;

  return (
    <View style={[styles.stat, { backgroundColor: theme.surfaceMuted }]}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

function ApplicationCard({
  application,
  busy,
  onApprove,
  onReject,
}: {
  application: DriverApplication;
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const waiting = workingDaysSince(application.submittedAt);
  const overdue = isOverdue(application);
  const decided = application.status === 'approved' || application.status === 'rejected';
  const firstName = application.fullName.trim().split(/\s+/)[0] || 'The applicant';

  const attached = Object.entries(application.documents).filter(([, name]) => Boolean(name));

  return (
    <Card style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardHeading}>
          <Text style={[styles.name, { color: theme.text }]}>{application.fullName}</Text>
          <Text style={[styles.reference, { color: theme.textMuted }]}>
            {application.reference} · {application.state}
          </Text>
        </View>

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
      </View>

      {/* Time in queue, because the promise is a number of days. */}
      {!decided && (
        <View style={styles.waitRow}>
          <Clock color={overdue ? theme.dangerOnSoft : theme.textMuted} size={13} />
          <Text
            style={[
              styles.waitText,
              { color: overdue ? theme.dangerOnSoft : theme.textSecondary },
            ]}>
            {waiting === 0
              ? 'Submitted today'
              : `Waiting ${waiting} working day${waiting === 1 ? '' : 's'}`}
            {overdue ? ` — past the ${REVIEW_WORKING_DAYS}-day promise` : ''}
          </Text>
        </View>
      )}

      <Row icon={<PhoneCall color={theme.textMuted} size={15} />} label="Contact">
        {application.phone} · {application.email}
      </Row>
      <Row icon={<Truck color={theme.textMuted} size={15} />} label="Vehicle">
        {application.vehicleType} · {application.plateNumber} · Licence {application.licenseId}
      </Row>
      <Row icon={<MapPin color={theme.textMuted} size={15} />} label="Based">
        {application.baseCity ?? application.state}
      </Row>

      {/*
        Only shown when the confirmation email failed.
        The applicant was told on screen to check their inbox, so a failure here
        means someone is sitting in silence believing the application vanished.
        Whoever works this queue is the only person in a position to notice.
      */}
      {!!application.confirmationEmailError && (
        <View style={[styles.emailWarning, { backgroundColor: theme.dangerSoft }]}>
          <MailWarning color={theme.dangerOnSoft} size={15} />
          <Text style={[styles.emailWarningText, { color: theme.dangerOnSoft }]}>
            Confirmation email did not send — {application.email} was never told we received this.
            Contact them directly.
          </Text>
        </View>
      )}

      <Pressable
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        hitSlop={6}
        style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}>
        <Text style={[styles.toggleText, { color: theme.primary }]}>
          {expanded ? 'Hide full application' : 'View full application'}
        </Text>
      </Pressable>

      {expanded && (
        <View style={styles.details}>
          <SectionLabel>Identity</SectionLabel>
          <Row icon={<IdCard color={theme.textMuted} size={15} />} label="NIN">
            {application.nin}
          </Row>
          <Row icon={<UserRound color={theme.textMuted} size={15} />} label="Address">
            {application.address}
          </Row>

          <SectionLabel>Guarantor</SectionLabel>
          <Row icon={<UserRound color={theme.textMuted} size={15} />} label="Name">
            {application.guarantorName} ({application.guarantorRelationship})
          </Row>
          <Row icon={<PhoneCall color={theme.textMuted} size={15} />} label="Phone">
            {application.guarantorPhone}
          </Row>
          <Row icon={<IdCard color={theme.textMuted} size={15} />} label="NIN">
            {application.guarantorNin}
          </Row>
          <Row icon={<MapPin color={theme.textMuted} size={15} />} label="Address">
            {application.guarantorAddress}
          </Row>

          <SectionLabel>Payout</SectionLabel>
          <Row icon={<Landmark color={theme.textMuted} size={15} />} label="Bank">
            {application.bankName}
          </Row>
          <Row icon={<Banknote color={theme.textMuted} size={15} />} label="Account">
            {application.accountNumber} · {application.accountName}
          </Row>

          <SectionLabel>Next of kin</SectionLabel>
          <Row icon={<HeartLike color={theme.textMuted} />} label="Contact">
            {application.kinName} ({application.kinRelationship}) · {application.kinPhone}
          </Row>

          <SectionLabel>Documents</SectionLabel>
          {attached.length === 0 ? (
            <Text style={[styles.value, { color: theme.textMuted }]}>Nothing attached.</Text>
          ) : (
            attached.map(([key, path]) => <DocumentRow key={key} label={key} path={String(path)} />)
          )}
        </View>
      )}

      {decided ? (
        <>
          <Text style={[styles.decided, { color: theme.textMuted }]}>
            {STATUS_LABELS[application.status]}
            {application.reviewedAt
              ? ` on ${new Date(application.reviewedAt).toLocaleDateString()}`
              : ''}
          </Text>
          {/* The reason, kept where the decision is, so it can be quoted back. */}
          {(application.reviewNote ?? '').length > 0 && (
            <Text style={[styles.decidedNote, { color: theme.textSecondary }]}>
              “{application.reviewNote}”
            </Text>
          )}
        </>
      ) : rejecting ? (
        <View style={styles.rejectBox}>
          <Field
            label="Why is this being rejected?"
            hint={`${firstName} is sent this word for word. Say what was wrong and whether they can fix it.`}
            value={reason}
            onChangeText={setReason}
            multiline
            numberOfLines={3}
            editable={!busy}
            placeholder="e.g. The licence photo is expired — re-apply with a current one."
          />
          <View style={styles.actions}>
            <Button
              label={busy ? 'Saving…' : 'Confirm rejection'}
              size="md"
              style={styles.action}
              disabled={busy || reason.trim().length < MIN_REASON}
              onPress={() => onReject(reason.trim())}
            />
            <Button
              label="Cancel"
              variant="secondary"
              size="md"
              style={styles.action}
              disabled={busy}
              onPress={() => {
                setRejecting(false);
                setReason('');
              }}
            />
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          {canApprove(application.status) && (
            <Button
              label={busy ? 'Saving…' : 'Approve'}
              size="md"
              style={styles.action}
              disabled={busy}
              icon={(color, size) => <ShieldCheck color={color} size={size} />}
              onPress={onApprove}
            />
          )}
          {canReject(application.status) && (
            <Button
              label="Reject"
              variant="secondary"
              size="md"
              style={styles.action}
              disabled={busy}
              onPress={() => setRejecting(true)}
            />
          )}
        </View>
      )}

      {/*
        ⚠ Said out loud, rather than left as a missing button.

        An admin who sees Reject without Approve has no way to tell whether the
        control is gone deliberately or the screen is broken — and the guess
        that costs LOCI a driver is the second one, because it ends in somebody
        approving from the SQL editor to work around it.
      */}
      {isWaitingOnGuarantor(application.status) && !rejecting && (
        <Text style={[styles.decided, { color: theme.textMuted }]}>
          Approval opens once the guarantor confirms. Nothing here is waiting on you.
        </Text>
      )}
    </Card>
  );
}

/**
 * One document, opened through a short-lived signed URL.
 *
 * The URL is minted on tap rather than up front: generating one per document
 * for every card in the queue would issue dozens of live links a reviewer never
 * uses, and each is a working key to somebody's identity papers for its
 * lifetime.
 */
function DocumentRow({ label, path }: { label: string; path: string }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const url = await signedDocumentUrl(path);
      await Linking.openURL(url);
    } catch (thrown) {
      showDialog(
        'Could not open the document',
        errorMessage(thrown, 'The file may have been removed.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={() => void open()}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`Open ${label}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.rowIcon}>
        <FileText color={theme.primary} size={15} />
      </View>
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.value, { color: theme.primary }]}>
        {busy ? 'Opening…' : 'View document'}
      </Text>
    </Pressable>
  );
}

/** lucide has no "kin" glyph; a person icon reads better than a heart here. */
function HeartLike({ color }: { color: string }) {
  return <UserRound color={color} size={15} />;
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>{icon}</View>
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.value, { color: theme.text }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, alignItems: 'center' },
  content: { width: '100%', maxWidth: MaxContentWidth, gap: Spacing.three },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  stat: {
    flexGrow: 1,
    flexBasis: 140,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    gap: 2,
  },
  statValue: { fontSize: FontSize.heading, ...font(800) },
  statLabel: { ...Typography.meta },
  banner: { padding: Spacing.three - 4, borderRadius: Radius.md },
  bannerText: { ...Typography.meta, lineHeight: 19 },
  loading: { alignItems: 'center', gap: Spacing.two, paddingVertical: Spacing.five },
  loadingText: { ...Typography.meta },
  emptyCard: { gap: Spacing.three, alignItems: 'center' },
  card: { gap: Spacing.two, marginBottom: Spacing.one },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  cardHeading: { flex: 1, gap: 2 },
  name: { ...Typography.sectionTitle },
  reference: { ...Typography.meta },
  emailWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.one + 2,
    padding: Spacing.two,
    borderRadius: Radius.md,
  },
  emailWarningText: { ...Typography.meta, ...font(600), flex: 1, lineHeight: 18 },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one + 2 },
  waitText: { ...Typography.meta, ...font(600) },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two, paddingVertical: 3 },
  rowIcon: { width: 20, paddingTop: 1 },
  rowLabel: { ...Typography.meta, width: 84 },
  value: { ...Typography.meta, flex: 1, ...font(600) },
  toggle: { paddingVertical: Spacing.one },
  toggleText: { ...Typography.meta, ...font(700) },
  pressed: { opacity: 0.7 },
  details: { gap: Spacing.one, paddingTop: Spacing.one },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.two,
    borderRadius: Radius.md,
  },
  noticeText: { ...Typography.caption, flex: 1, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.one },
  action: { flexGrow: 1, flexBasis: 130 },
  decided: { ...Typography.meta, marginTop: Spacing.one },
  decidedNote: { ...Typography.meta, marginTop: Spacing.half, fontStyle: 'italic' },
  rejectBox: { gap: Spacing.one, marginTop: Spacing.one },
});
