import { useLocalSearchParams } from 'expo-router';
import { Ban, History, ShieldCheck, ShieldOff, Trash2, UserRound } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { AdminError, AdminShell } from '@/components/ui/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipGroup } from '@/components/ui/chip';
import { showDialog } from '@/components/ui/dialog';
import { ConfirmCheckbox } from '@/components/ui/form-wizard';
import { EmptyState, SectionLabel } from '@/components/ui/screen';
import { showToast } from '@/components/ui/toast';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  erasePerson,
  fetchApplicationSummaries,
  fetchRoleGrants,
  fetchUsers,
  setAdminRole,
  setDrivingBan,
  type AdminUser,
  type ApplicationSummary,
  type RoleGrant,
} from '@/store/admin';
import { ModerationDialog } from '@/components/ui/moderation-dialog';
import { STATUS_LABELS } from '@/store/driver-applications';
import { useSession } from '@/store/session';

/**
 * The segments the list can be filtered to.
 *
 * ⚠ Nobody signs up *as* a driver. Every account is created the same way; some
 *   of those people then submit a driver application. So "sender" here means
 *   "has not applied", not "chose to be a sender" — and the screen says so,
 *   because a segment that looks like a signup choice would be read as one.
 */
const SEGMENTS = ['all', 'senders', 'applicants', 'approved'] as const;
type Segment = (typeof SEGMENTS)[number];

const SEGMENT_LABELS: Record<Segment, string> = {
  all: 'Everyone',
  senders: 'Senders only',
  applicants: 'Applied to drive',
  approved: 'Approved drivers',
};

/**
 * User & Role Management.
 *
 * Who has an account, which of them applied to drive, and who holds admin.
 *
 * Every role change goes through `set_admin_role`, which is the *only* path
 * that can write `profiles.is_admin` — no client can update that column
 * directly, by policy. The server enforces the two rules that matter and
 * returns their messages verbatim, so what you read here is what the database
 * actually refused:
 *
 *   - you cannot change your own role
 *   - the last remaining admin cannot be demoted
 *
 * Both are checked server-side rather than hidden in the UI, because a disabled
 * button is a suggestion and a raised exception is a rule.
 */
export default function AdminUsersScreen() {
  const theme = useTheme();
  const { user, isAdmin } = useSession();

  /*
   * `?q=` seeds the search box, and nothing else reads it.
   *
   * The Support queue links here to get an operator to one account — it has a
   * name, not a row id, and this screen already filters on name or phone. A
   * per-user route would be a second way to render the same list; seeding the
   * filter it already has is the same destination with nothing new to maintain.
   */
  const params = useLocalSearchParams<{ q?: string }>();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [applications, setApplications] = useState<ApplicationSummary[]>([]);
  const [grants, setGrants] = useState<RoleGrant[]>([]);
  const [segment, setSegment] = useState<Segment>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(() => params.q ?? '');
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * The one row whose role button is live, or none.
   *
   * ⚠ A single id rather than a set of ticked rows, and that is the design.
   *
   *   Nine rows here look almost identical — a name, a phone, a date. The
   *   mistake this guards is not "meant to click later", it is "clicked the row
   *   above the one I meant". Independent per-row ticks would let somebody arm
   *   four rows while reading, and leave four irreversible actions one stray
   *   click apart. Arming a second row disarms the first, so at most one
   *   dangerous button on this screen is ever live.
   *
   *   It is an id and not a boolean because the list re-sorts and re-filters: a
   *   tick that meant "row 3" would follow the position rather than the person.
   */
  const [armedId, setArmedId] = useState<string | null>(null);

  /**
   * The open moderation dialog, or null.
   *
   * One value rather than a set of booleans: "banning" and "erasing" cannot
   * both be true, and a shape that allows it is a shape that will eventually
   * hold it.
   */
  const [moderating, setModerating] = useState<{
    action: 'ban' | 'unban' | 'erase';
    target: AdminUser;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextUsers, nextApplications, nextGrants] = await Promise.all([
        fetchUsers(),
        fetchApplicationSummaries(),
        fetchRoleGrants(),
      ]);
      setUsers(nextUsers);
      setApplications(nextApplications);
      setGrants(nextGrants);
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not load users.'));
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

  /** userId → their application, for anyone who has one. */
  const applicationByUser = useMemo(
    () => new Map(applications.map((application) => [application.userId, application])),
    [applications],
  );

  const inSegment = useCallback(
    (user: AdminUser, which: Segment) => {
      const application = applicationByUser.get(user.id);

      switch (which) {
        case 'senders':
          return !application;
        case 'applicants':
          return Boolean(application);
        case 'approved':
          return application?.status === 'approved';
        case 'all':
          return true;
      }
    },
    [applicationByUser],
  );

  /*
   * Counted from the whole list, not the filtered one — a chip whose number
   * changes when you type in the search box is telling you about your query
   * rather than about the platform.
   */
  const counts = useMemo(() => {
    const by = (which: Segment) => users.filter((user) => inSegment(user, which)).length;
    return {
      all: users.length,
      senders: by('senders'),
      applicants: by('applicants'),
      approved: by('approved'),
    };
  }, [users, inSegment]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return users.filter((user) => {
      if (!inSegment(user, segment)) return false;
      if (!needle) return true;
      return user.fullName.toLowerCase().includes(needle) || user.phone.includes(needle);
    });
  }, [query, users, segment, inSegment]);

  const adminCount = users.filter((u) => u.isAdmin).length;

  /*
   * ⚠ An arm does not survive the list changing underneath it.
   *
   *   Typing in the search box or switching segment re-renders a different set
   *   of rows in different positions. Somebody who armed a row, searched for
   *   somebody else, and clicked the button now sitting where the old one was
   *   would change the wrong person's role — and the toast would name the right
   *   one, so nothing on screen would look wrong.
   */
  useEffect(() => {
    setArmedId(null);
  }, [query, segment]);

  /** Names for the audit trail, so it doesn't read as a wall of UUIDs. */
  const nameFor = useCallback(
    (id: string) => users.find((u) => u.id === id)?.fullName || 'Unknown user',
    [users],
  );

  /*
   * ⚠ The dialog stays, and here it is not the second confirmation it would be
   *   on a single card.
   *
   *   Elsewhere in this app a checkbox replaced a modal, because both were
   *   asking the same question about the same one thing on screen. These two
   *   ask different questions. The tick asks "this row"; the dialog names the
   *   person and says what admin actually grants — which is the check that
   *   catches somebody who armed the row above the one they meant. In a list of
   *   near-identical rows that is a different failure, and it needs its own
   *   guard.
   */
  const confirm = (target: AdminUser) => {
    const promoting = !target.isAdmin;

    showDialog(
      promoting ? 'Make this person an admin?' : 'Remove admin from this person?',
      promoting
        ? `${target.fullName} will be able to read every account, approve drivers, and change other people's roles. There is no lesser tier — admin is all of it.`
        : `${target.fullName} will lose access to the Admin area immediately. Their account and any parcels are untouched.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: promoting ? 'Make admin' : 'Remove admin',
          style: promoting ? 'default' : 'destructive',
          onPress: () => void apply(target, promoting),
        },
      ],
    );
  };

  const apply = async (target: AdminUser, makeAdmin: boolean) => {
    setBusyId(target.id);
    /*
     * ⚠ Disarmed as the action starts, not after it lands.
     *
     *   Clearing it in `finally` would be a moment too late: `load()` is
     *   awaited in the success path, and the row stays armed and clickable
     *   across that round trip. Clearing it here means the button is dead the
     *   instant it has been used, whichever way the call goes.
     */
    setArmedId(null);
    try {
      await setAdminRole(target.id, makeAdmin);
      await load();
      showToast(makeAdmin ? 'Admin granted' : 'Admin removed', { message: target.fullName });
    } catch (thrown) {
      /*
       * The server's message, not a rewritten one. "This is the only
       * administrator left" and "You cannot change your own role" are precise,
       * and paraphrasing them into "Something went wrong" would hide the one
       * piece of information that explains the refusal.
       */
      showDialog('Role not changed', errorMessage(thrown, 'The database refused the change.'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AdminShell
      title="User & Role Mgmt."
      subtitle={`${users.length} account${users.length === 1 ? '' : 's'} · ${counts.applicants} applied to drive · ${adminCount} admin${adminCount === 1 ? '' : 's'}`}
      next="/admin-users">
      {!!error && <AdminError message={error} />}

      <View style={styles.segments}>
        <ChipGroup
          options={SEGMENTS as unknown as string[]}
          selected={segment}
          onSelect={(value) => setSegment(value as Segment)}
          renderLabel={(value) =>
            `${SEGMENT_LABELS[value as Segment]} (${counts[value as Segment]})`
          }
          scrollable
        />
      </View>

      {/*
        Stated once, next to the filter it explains.

        "Senders only" is the absence of an application, not a choice anyone
        made at signup — and someone reading it as a signup statistic would draw
        the wrong conclusion about what the app offers.
      */}
      <Text style={[styles.segmentNote, { color: theme.textMuted }]}>
        Everyone signs up the same way. &ldquo;Senders only&rdquo; means they have never submitted a
        driver application — not that they chose a sender account.
      </Text>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search by name or phone"
        placeholderTextColor={theme.textMuted}
        accessibilityLabel="Search users"
        style={[
          styles.search,
          { backgroundColor: theme.surfaceMuted, borderColor: theme.border, color: theme.text },
        ]}
      />

      {loading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : filtered.length === 0 ? (
        <Card style={styles.emptyCard}>
          <EmptyState
            icon={(color, size) => <UserRound color={color} size={size} />}
            title={query ? 'No match' : `No ${SEGMENT_LABELS[segment].toLowerCase()}`}
            message={
              query
                ? 'Nothing matches that name or number in this segment.'
                : segment === 'all'
                  ? 'Accounts appear here as people sign up.'
                  : 'Nobody falls into this segment yet.'
            }
          />
        </Card>
      ) : (
        <Card style={styles.list}>
          {filtered.map((item, index) => {
            const isSelf = item.id === user?.id;
            const application = applicationByUser.get(item.id);

            return (
              <View
                key={item.id}
                style={[
                  styles.row,
                  index > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: theme.border,
                  },
                ]}>
                <View style={[styles.avatar, { backgroundColor: theme.primarySoft }]}>
                  <Text style={[styles.avatarText, { color: theme.primaryOnSoft }]}>
                    {(item.fullName.trim()[0] ?? '?').toUpperCase()}
                  </Text>
                </View>

                <View style={styles.rowText}>
                  <View style={styles.nameRow}>
                    <Text style={[styles.name, { color: theme.text }]}>
                      {item.fullName || 'Unnamed account'}
                    </Text>
                    {isSelf && <Badge label="You" tone="neutral" uppercase={false} />}
                    {item.isAdmin && <Badge label="Admin" tone="primary" uppercase={false} />}
                    {application && (
                      <Badge
                        label={application.status === 'approved' ? 'Driver' : 'Applicant'}
                        tone={
                          application.status === 'approved'
                            ? 'success'
                            : application.status === 'rejected'
                              ? 'danger'
                              : 'warning'
                        }
                        uppercase={false}
                      />
                    )}
                    {/*
                      Banned and erased are separate states and read that way.
                      An erased account is also banned in the database, but
                      showing both badges would suggest two things happened.
                    */}
                    {item.deletedAt ? (
                      <Badge label="Erased" tone="danger" uppercase={false} />
                    ) : (
                      item.drivingBannedAt && (
                        <Badge label="Banned from driving" tone="danger" uppercase={false} />
                      )
                    )}
                  </View>
                  <Text style={[styles.meta, { color: theme.textMuted }]}>
                    {item.phone || 'No phone'} · joined{' '}
                    {new Date(item.createdAt).toLocaleDateString()}
                  </Text>
                  {/*
                    The application line, or its absence. Printing "Sender"
                    explicitly rather than leaving the row blank: a blank row
                    reads as missing data, and this is a fact about the account.
                  */}
                  {!!item.drivingBannedAt && !item.deletedAt && (
                    <Text style={[styles.banReason, { color: theme.dangerOnSoft }]}>
                      Banned {new Date(item.drivingBannedAt).toLocaleDateString()}
                      {item.banReason ? ` — ${item.banReason}` : ''}
                    </Text>
                  )}
                  {application ? (
                    <Text style={[styles.meta, { color: theme.textMuted }]}>
                      {STATUS_LABELS[application.status]} · {application.reference} · applied{' '}
                      {new Date(application.submittedAt).toLocaleDateString()}
                    </Text>
                  ) : (
                    <Text style={[styles.meta, { color: theme.textMuted }]}>
                      Sender — no driver application
                    </Text>
                  )}
                </View>

                {/*
                  Hidden for your own row rather than shown-and-disabled: the
                  server refuses it outright, so offering the control at all
                  would be an invitation to an error message.
                */}
                {!isSelf && (
                  <View style={styles.rowActions}>
                    {/*
                      ⚠ Hidden on an erased account rather than shown disabled.

                        There is no role to change on a row whose account is
                        gone, so a tick there would arm nothing. Offering it
                        would be a control that does not do anything, which is
                        how people learn the ticks do not matter.
                    */}
                    {!item.deletedAt && (
                      <ConfirmCheckbox
                        compact
                        checked={armedId === item.id}
                        disabled={busyId === item.id}
                        /*
                         * ⚠ Names the direction, so the label is never true of
                         *   the wrong button.
                         *
                         *   "I confirm this role modification" reads the same
                         *   above Make admin and above Remove. Saying which way
                         *   it goes means a tick made while looking at a
                         *   promotion cannot quietly sit above a removal.
                         */
                        label={item.isAdmin ? 'Confirm removing admin' : 'Confirm making admin'}
                        onChange={(next) => setArmedId(next ? item.id : null)}
                      />
                    )}

                    <Pressable
                      onPress={() => confirm(item)}
                      /*
                       * ⚠ Armed, not busy, not erased — in that order of
                       *   importance.
                       *
                       *   The tick is what makes this button live at all. The
                       *   other two conditions were already here and still
                       *   hold: an in-flight change must not be sent twice, and
                       *   an erased account has no role to change.
                       */
                      disabled={
                        armedId !== item.id || busyId === item.id || Boolean(item.deletedAt)
                      }
                      accessibilityRole="button"
                      accessibilityState={{ disabled: armedId !== item.id }}
                      accessibilityLabel={
                        item.isAdmin
                          ? `Remove admin from ${item.fullName}`
                          : `Make ${item.fullName} an admin`
                      }
                      style={({ pressed }) => [
                        styles.roleButton,
                        {
                          backgroundColor: item.isAdmin ? theme.dangerSoft : theme.primarySoft,
                          opacity:
                            armedId !== item.id || busyId === item.id || item.deletedAt ? 0.4 : 1,
                        },
                        pressed && styles.pressed,
                      ]}>
                      {item.isAdmin ? (
                        <ShieldOff color={theme.dangerOnSoft} size={15} />
                      ) : (
                        <ShieldCheck color={theme.primaryOnSoft} size={15} />
                      )}
                      <Text
                        style={[
                          styles.roleText,
                          { color: item.isAdmin ? theme.dangerOnSoft : theme.primaryOnSoft },
                        ]}>
                        {item.isAdmin ? 'Remove' : 'Make admin'}
                      </Text>
                    </Pressable>

                    {/*
                      Banning is offered only to someone who can actually
                      drive. On a sender it would be a control with no effect —
                      the ban blocks claiming jobs, and they cannot claim one
                      anyway.
                    */}
                    {application?.status === 'approved' && !item.deletedAt && (
                      <Pressable
                        onPress={() =>
                          setModerating({
                            action: item.drivingBannedAt ? 'unban' : 'ban',
                            target: item,
                          })
                        }
                        accessibilityRole="button"
                        accessibilityLabel={
                          item.drivingBannedAt
                            ? `Lift driving ban on ${item.fullName}`
                            : `Ban ${item.fullName} from driving`
                        }
                        style={({ pressed }) => [
                          styles.roleButton,
                          {
                            backgroundColor: item.drivingBannedAt
                              ? theme.successSoft
                              : theme.warningSoft,
                          },
                          pressed && styles.pressed,
                        ]}>
                        <Ban
                          color={item.drivingBannedAt ? theme.successOnSoft : theme.warningOnSoft}
                          size={15}
                        />
                        <Text
                          style={[
                            styles.roleText,
                            {
                              color: item.drivingBannedAt
                                ? theme.successOnSoft
                                : theme.warningOnSoft,
                            },
                          ]}>
                          {item.drivingBannedAt ? 'Lift ban' : 'Ban driving'}
                        </Text>
                      </Pressable>
                    )}

                    {!item.deletedAt && (
                      <Pressable
                        onPress={() => setModerating({ action: 'erase', target: item })}
                        accessibilityRole="button"
                        accessibilityLabel={`Erase ${item.fullName}`}
                        style={({ pressed }) => [
                          styles.roleButton,
                          { backgroundColor: theme.dangerSoft },
                          pressed && styles.pressed,
                        ]}>
                        <Trash2 color={theme.dangerOnSoft} size={15} />
                        <Text style={[styles.roleText, { color: theme.dangerOnSoft }]}>Erase</Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </Card>
      )}

      <View style={[styles.notice, { backgroundColor: theme.primarySoft }]}>
        <Text style={[styles.noticeText, { color: theme.primaryOnSoft }]}>
          Admin is a single tier — there is no read-only or reviewer-only role. Anyone you promote
          can see every account and promote others. You cannot change your own role, and the last
          admin cannot be removed.
        </Text>
      </View>

      {grants.length > 0 && (
        <>
          <SectionLabel>Recent role changes</SectionLabel>
          <Card style={styles.list}>
            {grants.map((grant, index) => (
              <View
                key={grant.id}
                style={[
                  styles.grantRow,
                  index > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: theme.border,
                  },
                ]}>
                <History color={theme.textMuted} size={15} />
                <View style={styles.rowText}>
                  <Text style={[styles.grantText, { color: theme.text }]}>
                    {nameFor(grant.subjectId)} was {grant.granted ? 'made an admin' : 'demoted'} by{' '}
                    {nameFor(grant.actorId)}
                  </Text>
                  <Text style={[styles.meta, { color: theme.textMuted }]}>
                    {new Date(grant.createdAt).toLocaleString()}
                    {grant.reason ? ` · ${grant.reason}` : ''}
                  </Text>
                </View>
              </View>
            ))}
          </Card>
          <Text style={[styles.footnote, { color: theme.textMuted }]}>
            Written by the database, not by this app — no client can insert into this log, so it
            cannot be forged from the outside.
          </Text>
        </>
      )}

      <Button label="Refresh" variant="secondary" size="md" onPress={() => void load()} />

      {moderating?.action === 'ban' && (
        <ModerationDialog
          title={`Ban ${moderating.target.fullName} from driving?`}
          body="They stay a Package Relay customer. This only stops them taking on deliveries."
          consequences={[
            'They can no longer claim or accept any job.',
            'Jobs they have already accepted are left alone — a parcel mid-journey is not dropped back into the feed.',
            'They can still sign in, send parcels and track them.',
            'Reversible: you can lift this at any time.',
          ]}
          confirmLabel="Ban from driving"
          reasonRequired
          reasonLabel="Why are you banning them?"
          onConfirm={async (reason) => {
            await setDrivingBan(moderating.target.id, true, reason);
            await load();
            showToast('Driver banned', { message: moderating.target.fullName });
          }}
          onClose={() => setModerating(null)}
        />
      )}

      {moderating?.action === 'unban' && (
        <ModerationDialog
          title={`Lift the ban on ${moderating.target.fullName}?`}
          body="They will be able to claim deliveries again immediately."
          consequences={[
            'Their approved application applies again from the moment you confirm.',
            'The original ban and its reason stay in the log.',
          ]}
          confirmLabel="Lift ban"
          reasonRequired={false}
          reasonLabel="Note (recorded in the log)"
          onConfirm={async (reason) => {
            await setDrivingBan(moderating.target.id, false, reason || undefined);
            await load();
            showToast('Ban lifted', { message: moderating.target.fullName });
          }}
          onClose={() => setModerating(null)}
        />
      )}

      {moderating?.action === 'erase' && (
        <ModerationDialog
          title={`Erase ${moderating.target.fullName}?`}
          body="This cannot be undone. Everything identifying this person is overwritten, and their deliveries stay in place for the people on the other end of them."
          consequences={[
            'Name, phone, NIN, address, bank details, guarantor and next of kin are overwritten.',
            'Their NIN record, stored selfies, licence and ID scans are deleted outright.',
            'Bank details are removed from payout requests and change requests; the earnings ledger keeps its amounts.',
            'Parcels they carried keep their route and fare, with the carrier shown as "Former driver".',
            'Parcels they sent keep their route and fare; the addresses and phone numbers on them are removed.',
            'They are blocked from driving and from posting parcels.',
            'Their login is removed too, if the erase-auth-user function is deployed. You will be told either way.',
          ]}
          confirmLabel="Erase permanently"
          confirmWord="ERASE"
          reasonRequired
          reasonLabel="Why are you erasing this account?"
          destructive
          onConfirm={async (reason) => {
            const outcome = await erasePerson(moderating.target.id, reason);
            await load();

            /*
              Two outcomes, said apart.

              The scrub either succeeded or threw — there is no partial version
              of it. The *login* is a separate step that a project without the
              Edge Function deployed will not complete, and reporting a plain
              "Account erased" in that case would tell an operator the login is
              gone when it is not. For an erasure request that is the one
              detail somebody may have to answer for.
            */
            showToast(
              outcome.loginRemoved ? 'Account erased' : 'Data erased, login remains',
              outcome.loginRemoved
                ? { message: 'The person is gone; the deliveries remain.' }
                : {
                    message: `Everything identifying them is gone and they are blocked. Their login could not be removed: ${outcome.loginError ?? 'reason unknown'}`,
                    tone: 'info',
                  },
            );
          }}
          onClose={() => setModerating(null)}
        />
      )}
    </AdminShell>
  );
}

const styles = StyleSheet.create({
  segments: {
    marginBottom: Spacing.two,
  },
  segmentNote: {
    ...Typography.caption,
    lineHeight: 17,
    marginBottom: Spacing.three,
  },
  search: {
    height: 44,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three - 2,
    marginBottom: Spacing.three,
    ...Typography.meta,
    // See `field.tsx`: RN types outlineStyle as solid/dotted/dashed only.
    outlineWidth: 0,
  },
  loading: {
    marginVertical: Spacing.six,
  },
  emptyCard: {
    marginBottom: Spacing.three,
  },
  list: {
    gap: 0,
    marginBottom: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingVertical: Spacing.three - 2,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    ...Typography.meta,
    ...font(800),
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.one + 2,
  },
  name: {
    ...Typography.meta,
    ...font(700),
  },
  meta: {
    ...Typography.caption,
  },
  rowActions: {
    alignItems: 'flex-end',
    gap: Spacing.one + 2,
  },
  banReason: {
    ...Typography.caption,
    ...font(600),
    lineHeight: 17,
  },
  roleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: Spacing.one + 2,
    borderRadius: Radius.pill,
  },
  roleText: {
    ...Typography.caption,
    ...font(700),
  },
  pressed: {
    opacity: 0.6,
  },
  notice: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    marginBottom: Spacing.four,
  },
  noticeText: {
    ...Typography.caption,
    ...font(600),
    lineHeight: 19,
  },
  grantRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    paddingVertical: Spacing.two + 2,
  },
  grantText: {
    ...Typography.caption,
    ...font(600),
    lineHeight: 18,
  },
  footnote: {
    ...Typography.caption,
    lineHeight: 18,
    marginBottom: Spacing.four,
  },
});
