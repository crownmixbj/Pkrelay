import { useRouter } from 'expo-router';
import {
  BadgeCheck,
  ChevronRight,
  Headphones,
  Mail,
  MapPin,
  Fingerprint,
  Package,
  Pencil,
  Phone,
  ShieldAlert,
  ShieldQuestion,
  UserRound,
  Wallet,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ToggleRow } from '@/components/ui/dropdown';
import { Field } from '@/components/ui/field';
import { screenPadding, ScreenHeader } from '@/components/ui/screen';
import { SignedOutState } from '@/components/ui/signed-out-state';
import { VerifyIdentityCard } from '@/components/ui/verify-identity-card';
import { showToast } from '@/components/ui/toast';
import { MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatNaira, isFinished, parcelsForUser, useBookings } from '@/store/bookings';
import { useHubs } from '@/store/hubs';
import {
  fetchSenderIdentity,
  verificationPath,
  type IdentityStatus,
  type SenderIdentity,
} from '@/store/identity';
import { memberSince, saveOwnDetails } from '@/store/own-details';
import { useSession } from '@/store/session';
import { fetchBalance, type Balance } from '@/store/wallet';
import { isValidNigerianPhone, nigerianPhoneError } from '@/utils/validation';

/**
 * Profile — everything about this account on one page, no overlays.
 *
 * ⚠ Built against what exists, which is less than the design asked for.
 *
 *   The layout this came from included Saved Addresses, Payment Methods and
 *   Delivery Preferences tiles, and a wallet with a "Top Up" button. None of
 *   those exist in LOCI: there is no saved-address table, no stored cards, no
 *   preferences, and the wallet is a driver *earnings* ledger with payouts and
 *   security holds — money flows out of it, never in.
 *
 *   Tiles for those would be four taps into nothing, and a Top Up button would
 *   be a promise the app cannot keep. So the grid carries the destinations that
 *   are real and the wallet row says what the wallet actually is. The design's
 *   shape is kept; its inventory is not.
 *
 * ⚠ Every number here is read, never assumed.
 *
 *   The mockup carried "Joy Ada", "Member Since: March 2023", "₦12,500.00",
 *   "3 Active", "5 locations". Hardcoding any of them produces a screen that
 *   demos perfectly and lies to every real person who opens it — and a balance
 *   is the worst possible thing to be confidently wrong about.
 */
export default function ProfileScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { user, isAuthenticated, role, setRole, isApprovedDriver, application, signOut } =
    useSession();
  const { bookings } = useBookings();
  const { hubs } = useHubs();

  const [identity, setIdentity] = useState<SenderIdentity | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  /*
   * ⚠ Held here rather than inside the section, so the pencil can open it.
   *
   *   The header's edit button and the Full name row open the same editor.
   *   With the state one level down the pencil had nothing to call and pushed
   *   a route parameter nothing read — a button that looked live and did
   *   nothing at all.
   */
  const [editing, setEditing] = useState<EditableKey | null>(null);

  const viewerId = user?.id ?? null;

  const activeCount = useMemo(() => {
    if (!viewerId) return 0;
    return parcelsForUser(bookings, viewerId).filter((booking) => !isFinished(booking)).length;
  }, [bookings, viewerId]);

  const reloadIdentity = useCallback(() => {
    void fetchSenderIdentity().then(setIdentity);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;

    void fetchSenderIdentity().then((record) => {
      /*
       * ⚠ The whole record, not just the status.
       *
       *   `ninLast4` is on it, and the settings menu now promises this screen
       *   shows the NIN. Keeping only the status would have made that promise
       *   false — which is why the copy and the data were changed together.
       */
      if (!cancelled) setIdentity(record);
    });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  /*
   * ⚠ Only for approved drivers, and not merely hidden for everyone else.
   *
   *   `driver_balance` is guarded server-side, so a sender calling it gets
   *   nothing. Not calling it at all keeps a pointless failing request out of
   *   every sender's console — the same reasoning as the address-lookup
   *   breaker.
   */
  useEffect(() => {
    if (!isApprovedDriver) {
      setBalance(null);
      return;
    }

    let cancelled = false;
    void fetchBalance().then((next) => {
      if (!cancelled) setBalance(next);
    });

    return () => {
      cancelled = true;
    };
  }, [isApprovedDriver]);

  if (!isAuthenticated || !user) {
    return (
      <SignedOutState
        title="Your profile"
        message="Sign in to see and edit your details."
        next="/(tabs)/profile"
      />
    );
  }

  const joined = memberSince(user.createdAt);

  return (
    <ScrollView
      contentContainerStyle={[styles.screen, screenPadding]}
      keyboardShouldPersistTaps="handled">
      <View style={styles.content}>
        {/*
          ⚠ `canGoBack` first, because this screen has two ways in.

            Opened from the account menu there is a history entry to return to.
            Opened from a link, a bookmark or a fresh reload there is not, and
            `router.back()` on an empty stack does nothing at all — a back
            arrow that silently refuses is worse than no arrow. Falling back to
            the home screen gives it something honest to do.

          ⚠ No action on the right.

            The design offered "an Edit text button or nothing". Nothing: the
            avatar already carries a pencil and every editable row already
            carries a chevron, so a header Edit would be a third control for
            the same job, and the ambiguous one — it would not say *what* it
            edits.
        */}
        <ScreenHeader
          title="My Profile"
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />

        <Card style={styles.card}>
          <ProfileHeader
            name={user.name}
            joined={joined}
            identity={identity?.status ?? null}
            onEdit={() => setEditing((was) => (was === 'name' ? null : 'name'))}
          />

          <Divider />

          <PersonalInformation
            user={user}
            ninLast4={identity?.ninLast4 ?? null}
            hasApplication={Boolean(application)}
            editing={editing}
            setEditing={setEditing}
          />

          {/*
            ⚠ Renders nothing once there is nothing to do.

              `VerifyIdentityCard` returns null for anyone already verified, so
              the divider and heading would otherwise be a section title with
              empty space under it for most of the people who see this screen.
          */}
          {verificationPath(identity) === 'onboarding' && (
            <>
              <Divider />
              <Section title="Verify your identity">
                <VerifyIdentityCard identity={identity} onVerified={reloadIdentity} />
              </Section>
            </>
          )}

          <Divider />

          <Section title="Account status & role">
            {/*
              ⚠ A toggle only for those it can actually move.

                Driver Mode switches which app this account sees, and the
                switch is refused server-side for anyone unapproved. Rendering
                a toggle that springs back is worse than not offering one, so
                an applicant sees where their application stands instead.
            */}
            {isApprovedDriver ? (
              <ToggleRow
                label="Driver mode"
                description={
                  role === 'driver'
                    ? 'Online — you see trips, offers and your wallet.'
                    : 'Off — you are using LOCI as a sender.'
                }
                value={role === 'driver'}
                onValueChange={(next) => setRole(next ? 'driver' : 'sender')}
                tone="primary"
              />
            ) : (
              <Row
                icon={<UserRound color={theme.textMuted} size={16} />}
                label="Driver mode"
                value={driverModeStatus(application?.status ?? null)}
                onPress={() => router.push('/(tabs)/driver-signup')}
              />
            )}

            {/*
              ⚠ Earnings, not a spendable balance, and the copy has to say so.

                The design called this "Wallet Balance" with a Top Up button.
                This ledger only ever pays *out* — deliveries credit it, payouts
                debit it, and part of it sits under a security hold until the
                delivery window passes. "Top Up" would be a button with nothing
                behind it, so the action is the wallet screen that already
                explains the hold.
            */}
            {isApprovedDriver && (
              <View style={[styles.walletRow, { borderColor: theme.border }]}>
                <View style={styles.rowIcon}>
                  <Wallet color={theme.textMuted} size={16} />
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>
                    Wallet — earnings
                  </Text>
                  {balance ? (
                    <Text style={[styles.rowValue, { color: theme.text }]}>
                      {formatNaira(balance.available)} available
                      {balance.onHold > 0 ? ` · ${formatNaira(balance.onHold)} on hold` : ''}
                    </Text>
                  ) : (
                    <ActivityIndicator color={theme.primary} size="small" />
                  )}
                </View>
                <Button label="View wallet" onPress={() => router.push('/(tabs)/driver-wallet')} />
              </View>
            )}
          </Section>

          <Divider />

          <Section title="Quick access">
            <View style={styles.grid}>
              <Tile
                icon={<Package color={theme.primary} size={20} />}
                label="My shipments"
                /* Counted from this account's own parcels — see `activeCount`. */
                sub={activeCount === 1 ? '1 active' : `${activeCount} active`}
                onPress={() => router.push('/(tabs)/my-packages')}
              />
              <Tile
                icon={<MapPin color={theme.primary} size={20} />}
                label="Pickup hubs"
                sub={`${hubs.length} location${hubs.length === 1 ? '' : 's'}`}
                onPress={() => router.push('/(tabs)/locations')}
              />
              <Tile
                icon={<Package color={theme.primary} size={20} />}
                label="Send a parcel"
                sub="New shipment"
                onPress={() => router.push('/(tabs)/book')}
              />
              <Tile
                icon={<Headphones color={theme.primary} size={20} />}
                label="Support"
                sub="Get help"
                onPress={() => router.push('/(tabs)/support')}
              />
            </View>
          </Section>

          <Divider />

          {/*
            ⚠ Outlined rather than filled, deliberately.

              Sign Out sits at the end of a scroll on a screen people open to
              read things. A solid red button is the loudest element on the
              page and invites the tap it should be discouraging.
          */}
          <Pressable
            onPress={() => void signOut()}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.signOut,
              { borderColor: theme.danger },
              pressed && styles.pressed,
            ]}>
            <Text style={[styles.signOutLabel, { color: theme.danger }]}>Sign out</Text>
          </Pressable>
        </Card>
      </View>

      <Footer />
    </ScrollView>
  );
}

/** What to tell somebody who is not an approved driver yet. */
function driverModeStatus(status: string | null): string {
  if (status === 'pending') return 'Application under review';
  if (status === 'rejected') return 'Application declined — tap to review';
  if (status === 'suspended') return 'Suspended — contact support';
  return 'Not a driver — tap to apply';
}

/* ------------------------------------------------------------ the header -- */

function ProfileHeader({
  name,
  joined,
  identity,
  onEdit,
}: {
  name: string;
  joined: string | null;
  identity: IdentityStatus | null;
  onEdit: () => void;
}) {
  const theme = useTheme();

  /*
   * Initials rather than a photo. The only face this app holds is the identity
   * selfie, which is sensitive personal data under the NDPA and is kept for
   * verification — reusing it as a decorative avatar would be a new purpose
   * nobody consented to.
   */
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <View style={styles.header}>
      <View style={styles.avatarWrap}>
        <View style={[styles.avatar, { backgroundColor: theme.primary }]}>
          <Text style={styles.avatarText}>{initials || '—'}</Text>
        </View>
        <Pressable
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel="Edit your details"
          hitSlop={8}
          style={[styles.pencil, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Pencil color={theme.textSecondary} size={12} />
        </Pressable>
      </View>

      <View style={styles.headerText}>
        <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
          {name}
        </Text>
        {/* Absent rather than guessed — see `memberSince`. */}
        {joined && (
          <Text style={[styles.meta, { color: theme.textMuted }]}>Member since {joined}</Text>
        )}
        <VerificationBadge status={identity} />
      </View>
    </View>
  );
}

/**
 * ⚠ Four states, and only one of them is a green tick.
 *
 *   Collapsing these to verified/not would tell somebody mid-review that they
 *   had failed, and somebody flagged that they were fine. Flagged in
 *   particular is not "unverified" — it means a check came back and disagreed
 *   with itself, which is a support conversation rather than a retry.
 */
function VerificationBadge({ status }: { status: IdentityStatus | null }) {
  const theme = useTheme();

  if (status === null) return null;

  const look = {
    verified: { text: 'Verified', color: theme.success, Icon: BadgeCheck },
    pending: { text: 'Verification in progress', color: theme.warning, Icon: ShieldQuestion },
    flagged: { text: 'Verification needs review', color: theme.danger, Icon: ShieldAlert },
    unverified: { text: 'Not verified yet', color: theme.textMuted, Icon: ShieldQuestion },
  }[status];

  return (
    <View style={styles.badge}>
      <look.Icon color={look.color} size={14} />
      <Text style={[styles.badgeText, { color: look.color }]}>{look.text}</Text>
    </View>
  );
}

/* --------------------------------------------- the personal information -- */

type EditableKey = 'name' | 'phone';

function PersonalInformation({
  user,
  ninLast4,
  hasApplication,
  editing,
  setEditing,
}: {
  user: { name: string; email: string | null; phone: string };
  /** Last four digits. The full NIN never leaves the server — see `identity.ts`. */
  ninLast4: string | null;
  hasApplication: boolean;
  editing: EditableKey | null;
  setEditing: (
    next: EditableKey | null | ((was: EditableKey | null) => EditableKey | null),
  ) => void;
}) {
  const theme = useTheme();
  const { refreshDriverStatus } = useSession();

  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const open = useCallback(
    (key: EditableKey, current: string) => {
      setEditing((was) => (was === key ? null : key));
      setDraft(current);
      setError(null);
    },
    [setEditing],
  );

  /* The pencil opens the name editor, so its draft has to be seeded too. */
  useEffect(() => {
    if (editing === 'name') setDraft((current) => (current ? current : user.name));
    if (editing === 'phone') setDraft((current) => (current ? current : user.phone));
    if (editing === null) setDraft('');
  }, [editing, user.name, user.phone]);

  const save = async (key: EditableKey) => {
    const value = draft.trim();

    if (!value) {
      setError(key === 'name' ? 'Your name cannot be empty' : 'Your phone number cannot be empty');
      return;
    }
    if (key === 'phone' && !isValidNigerianPhone(value)) {
      setError(nigerianPhoneError(value) ?? 'Enter a valid Nigerian number');
      return;
    }
    if (value === (key === 'name' ? user.name : user.phone)) {
      setEditing(null);
      return;
    }

    setSaving(true);
    const outcome = await saveOwnDetails({ [key]: value }, hasApplication);
    setSaving(false);

    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }

    setEditing(null);

    /*
     * ⚠ The suspended case is a headline, not a footnote.
     *
     *   For an approved driver, changing a name or a phone number suspends
     *   approval until an admin looks at it. Somebody who tapped a pencil to
     *   fix a typo and is now off the road needs to be told plainly, at the
     *   moment it happens — see `saveOwnDetails` for why the rule exists.
     */
    if (outcome.suspended) {
      showToast('Sent for review', {
        message: 'Your approval is paused until an admin checks this change.',
      });
      await refreshDriverStatus();
    } else {
      showToast('Saved');
    }
  };

  return (
    <Section title="Personal information">
      <Row
        icon={<UserRound color={theme.textMuted} size={16} />}
        label="Full name"
        value={user.name}
        onPress={() => open('name', user.name)}
        expanded={editing === 'name'}
      />
      {editing === 'name' && (
        <InlineEditor
          label="Full name"
          value={draft}
          onChange={setDraft}
          onSave={() => void save('name')}
          onCancel={() => setEditing(null)}
          error={error}
          saving={saving}
          notice={
            hasApplication
              ? 'Changing your name pauses your driver approval until an admin reviews it.'
              : null
          }
        />
      )}

      {/*
        ⚠ Email has no chevron, because this screen cannot change it.

          It is the account's login and the address every confirmation goes to.
          Changing it is a Supabase auth flow that re-confirms the new address
          before it takes effect, and a row that opened an editor which then
          silently did nothing would be worse than one that does not open.
      */}
      <Row
        icon={<Mail color={theme.textMuted} size={16} />}
        label="Email address"
        value={user.email ?? 'Not set'}
        hint="Used to sign in — contact support to change it"
      />

      <Row
        icon={<Phone color={theme.textMuted} size={16} />}
        label="Phone number"
        value={user.phone || 'Not set'}
        onPress={() => open('phone', user.phone)}
        expanded={editing === 'phone'}
      />
      {editing === 'phone' && (
        <InlineEditor
          label="Phone number"
          value={draft}
          onChange={setDraft}
          onSave={() => void save('phone')}
          onCancel={() => setEditing(null)}
          error={error}
          saving={saving}
          keyboardType="phone-pad"
          notice={
            hasApplication
              ? 'Changing your number pauses your driver approval until an admin reviews it.'
              : null
          }
        />
      )}

      {/*
        ⚠ Four digits, and never more.

          The full NIN is sensitive personal data under the NDPA and is held
          server-side; `sender_identity` returns only the last four so the app
          physically cannot render the rest. That is enough for somebody to
          confirm which of their numbers is on file, which is the only thing
          this row is for. It has no chevron because changing a verified NIN is
          a re-verification, not an edit.
      */}
      <Row
        icon={<Fingerprint color={theme.textMuted} size={16} />}
        label="NIN"
        value={ninLast4 ? `•••• •••• ${ninLast4}` : 'Not provided yet'}
        hint={
          ninLast4
            ? 'Only the last four digits are held on this device'
            : 'Added when you verify your identity'
        }
      />
    </Section>
  );
}

/** The editor that opens under a row, rather than over the screen. */
function InlineEditor({
  label,
  value,
  onChange,
  onSave,
  onCancel,
  error,
  saving,
  notice,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
  error: string | null;
  saving: boolean;
  notice: string | null;
  keyboardType?: 'phone-pad';
}) {
  const theme = useTheme();

  return (
    <View style={[styles.editor, { backgroundColor: theme.surfaceMuted }]}>
      <Field
        label={label}
        value={value}
        onChangeText={onChange}
        error={error ?? undefined}
        keyboardType={keyboardType}
        autoCapitalize={keyboardType ? 'none' : 'words'}
        compact
      />
      {/* Said before saving, not after — see `saveOwnDetails`. */}
      {notice && <Text style={[styles.notice, { color: theme.warning }]}>{notice}</Text>}
      <View style={styles.editorActions}>
        <Button label="Cancel" variant="secondary" onPress={onCancel} />
        <Button label={saving ? 'Saving…' : 'Save'} onPress={onSave} disabled={saving} />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------- the parts -- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function Row({
  icon,
  label,
  value,
  hint,
  onPress,
  expanded,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  onPress?: () => void;
  expanded?: boolean;
}) {
  const theme = useTheme();

  const body = (
    <>
      <View style={styles.rowIcon}>{icon}</View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>{label}</Text>
        <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={1}>
          {value}
        </Text>
        {!!hint && <Text style={[styles.rowHint, { color: theme.textMuted }]}>{hint}</Text>}
      </View>
      {/* Only where there is somewhere to go — an inert chevron is a broken promise. */}
      {onPress && (
        <ChevronRight
          color={theme.textMuted}
          size={18}
          style={expanded ? styles.chevronOpen : undefined}
        />
      )}
    </>
  );

  if (!onPress) {
    return <View style={[styles.row, { borderColor: theme.border }]}>{body}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        { borderColor: theme.border },
        pressed && styles.pressed,
      ]}>
      {body}
    </Pressable>
  );
}

function Tile({
  icon,
  label,
  sub,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.tile,
        { backgroundColor: theme.surfaceMuted, borderColor: theme.border },
        pressed && styles.pressed,
      ]}>
      {icon}
      <Text style={[styles.tileLabel, { color: theme.text }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.tileSub, { color: theme.textMuted }]} numberOfLines={1}>
        {sub}
      </Text>
    </Pressable>
  );
}

function Divider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.border }]} />;
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  card: {
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  avatarWrap: {
    width: 64,
    height: 64,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    ...Typography.cardTitle,
    ...font(700),
    color: '#fff',
  },
  pencil: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  name: {
    ...Typography.cardTitle,
    ...font(700),
  },
  meta: {
    ...Typography.caption,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    marginTop: Spacing.one,
  },
  badgeText: {
    ...Typography.caption,
    ...font(600),
  },
  section: {
    gap: Spacing.two,
  },
  sectionTitle: {
    ...Typography.caption,
    ...font(700),
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: {
    width: 24,
    alignItems: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowLabel: {
    ...Typography.caption,
  },
  rowValue: {
    ...Typography.meta,
    ...font(600),
  },
  rowHint: {
    ...Typography.caption,
    marginTop: 1,
  },
  chevronOpen: {
    transform: [{ rotate: '90deg' }],
  },
  editor: {
    gap: Spacing.two,
    padding: Spacing.two,
    borderRadius: Radius.md,
  },
  editorActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
  },
  notice: {
    ...Typography.caption,
    lineHeight: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  tile: {
    /*
     * Two per row at every width this app renders at. `flexBasis` with a
     * percentage rather than a fixed width so the gap does not push the second
     * tile onto its own line on a narrow phone.
     */
    flexGrow: 1,
    flexBasis: '45%',
    gap: Spacing.one,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tileLabel: {
    ...Typography.meta,
    ...font(600),
  },
  tileSub: {
    ...Typography.caption,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  signOut: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  signOutLabel: {
    ...Typography.meta,
    ...font(700),
  },
  pressed: {
    opacity: 0.6,
  },
});
