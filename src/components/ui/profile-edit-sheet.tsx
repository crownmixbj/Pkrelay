import {
  Car,
  ChevronDown,
  Info,
  Lock,
  Phone,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  Wallet,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { DocumentList } from '@/components/ui/document-locker';
import { Button } from '@/components/ui/button';
import { Dropdown } from '@/components/ui/dropdown';
import { Field } from '@/components/ui/field';
import { showToast } from '@/components/ui/toast';
import { NIN_LENGTH } from '@/constants/driver-validation';
import { maskAccount, PAYOUT_COOLING_HOURS } from '@/store/driver-applications';
import { maskNinInput } from '@/store/identity';
import { FontSize, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { CITIES } from '@/store/bookings';
import type { DriverApplication } from '@/store/driver-applications';
import {
  changedFields,
  editWarning,
  fieldLabel,
  patchRisk,
  saveProfile,
} from '@/store/driver-profile';

/**
 * Edit Profile — the driver's own details, grouped by what a mistake costs.
 *
 * The structure is the argument. `supabase/migrations/20250101000029_driver_profile_edits.sql` sorts
 * every field into low, high or locked, and a driver who cannot see which is
 * which will eventually change their legal name to fix a typo and find
 * themselves suspended mid-shift. So the form has three tiers, visually
 * distinct, and the expensive one states its price before it will open.
 *
 * ⚠ Within the editable tier the grouping is by *subject* — vehicle, personal,
 *   next of kin — not by risk, because every field in it carries the same
 *   (zero) consequence and sorting them by consequence would be sorting them by
 *   a distinction that does not apply. Risk separates the tiers; subject
 *   organises inside them.
 *
 * ⚠ No `ScrollView` here. `BottomSheet` scrolls its own children, and nesting a
 *   second vertical scroller collapses the inner one on react-native-web.
 */

type FieldSpec = {
  key: string;
  label: string;
  placeholder: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad';
  autoCapitalize?: 'none' | 'words' | 'characters';
  /**
   * Hard stop on what the box can hold, for fields with a fixed length.
   *
   * ⚠ Paired with `mask`, never used alone. `maxLength` counts *characters*, so
   *   on its own it lets eleven characters of "123-456-7890" through and calls
   *   it a full NIN. The mask is what makes the count mean digits.
   */
  maxLength?: number;
  /** Applied on every keystroke, so an impossible value cannot be typed. */
  mask?: (raw: string) => string;
};

type Section = {
  key: string;
  title: string;
  /** One line on why these belong together. Not decoration — see `SectionCard`. */
  caption: string;
  icon: (color: string, size: number) => React.ReactNode;
  fields: FieldSpec[];
};

/**
 * The low-risk tier, in the order a driver would look for them.
 *
 * Three groups rather than one list of eight. The previous version was a single
 * column of inputs with no headings, which is legible at three fields and a
 * wall at eight — and this form is only ever opened to change one thing, so
 * every field that is not that thing is noise to scroll past.
 */
const EDITABLE_SECTIONS: Section[] = [
  {
    key: 'vehicle',
    title: 'Vehicle information',
    caption: 'What you ride, and what a hub will check at the gate.',
    icon: (color, size) => <Car color={color} size={size} />,
    fields: [
      { key: 'vehicle_type', label: 'Vehicle type', placeholder: 'Motorcycle' },
      { key: 'vehicle_colour', label: 'Vehicle colour', placeholder: 'Red' },
      {
        key: 'plate_number',
        label: 'Plate number',
        placeholder: 'ABC123XY',
        autoCapitalize: 'characters',
      },
    ],
  },
  {
    key: 'personal',
    title: 'Personal details',
    caption: 'Where you are based. This decides which parcels reach you.',
    icon: (color, size) => <UserRound color={color} size={size} />,
    fields: [{ key: 'address', label: 'Your address', placeholder: '8 Lebanon Street, Ibadan' }],
  },
  {
    key: 'kin',
    title: 'Next of kin',
    caption: 'Who Package Relay contacts if something happens to you on a trip.',
    icon: (color, size) => <Phone color={color} size={size} />,
    fields: [
      { key: 'kin_name', label: 'Full name', placeholder: 'Noah Adedapo' },
      {
        key: 'kin_phone',
        label: 'Phone number',
        placeholder: '+234 800 000 0000',
        keyboardType: 'phone-pad',
      },
      { key: 'kin_relationship', label: 'Relationship to you', placeholder: 'Sibling' },
    ],
  },
];

/** High-risk. Editing any one of these sends the account back for review. */
const IDENTITY_FIELDS: FieldSpec[] = [
  { key: 'full_name', label: 'Legal name', placeholder: 'Exactly as on your licence' },
  {
    key: 'nin',
    label: 'National Identification Number',
    placeholder: '11 digits',
    keyboardType: 'numeric',
    maxLength: NIN_LENGTH,
    mask: maskNinInput,
  },
  { key: 'license_id', label: "Driver's licence number", placeholder: 'LIC-000000' },
  { key: 'guarantor_name', label: 'Guarantor full name', placeholder: 'Full name' },
  {
    key: 'guarantor_phone',
    label: 'Guarantor phone',
    placeholder: '+234 800 000 0000',
    keyboardType: 'phone-pad',
  },
  { key: 'guarantor_relationship', label: 'Guarantor relationship', placeholder: 'Uncle' },
  { key: 'guarantor_address', label: 'Guarantor address', placeholder: 'Street, city' },
  {
    key: 'guarantor_nin',
    label: 'Guarantor NIN',
    placeholder: '11 digits',
    keyboardType: 'numeric',
    maxLength: NIN_LENGTH,
    mask: maskNinInput,
  },
];

/**
 * A field the driver submitted and cannot change here.
 *
 * ⚠ `field`, not `key`, and the difference is load-bearing rather than
 *   stylistic.
 *
 *   `verify-driver-security` scans this file for `key: '…', label:` pairs and
 *   asserts none of them is a locked field — the check that stops an editable
 *   box appearing for something the server refuses. Giving these rows the same
 *   shape as an input spec would trip that assertion on a form that is entirely
 *   correct, and the natural fix would have been to weaken the assertion. A
 *   different shape for a different thing keeps it sharp.
 */
type LockedRow = {
  field: string;
  label: string;
  /** Read off the application. Masked where the raw value is sensitive. */
  read: (application: DriverApplication) => string;
  /** Where it *can* be changed, in one line. Never just "you cannot". */
  where: string;
};

/**
 * Contact details. Locked for an operational reason.
 *
 * `guard_application_phone` in 20250101000016_driver_identity.sql pins the phone to the
 * number the account signed up with, and `driver_field_risk` classifies both of
 * these as locked.
 */
const CONTACT_ROWS: LockedRow[] = [
  {
    field: 'phone',
    label: 'Phone number',
    read: (a) => a.phone,
    where: 'Contact support and the team will change it with you.',
  },
  {
    field: 'email',
    label: 'Email address',
    read: (a) => a.email,
    where: 'Contact support and the team will change it with you.',
  },
];

/**
 * Payout details. Locked for a money reason, which is a different reason.
 *
 * The account number is masked here. This sheet is opened in hubs and on
 * shared screens, and a full account number on display is a different exposure
 * from a phone number — the last four are enough to confirm which account it is.
 */
const PAYOUT_ROWS: LockedRow[] = [
  {
    field: 'bank_name',
    label: 'Bank',
    read: (a) => a.bankName,
    where: 'Change it under Driver Wallet / Payouts.',
  },
  {
    field: 'account_number',
    label: 'Account number',
    read: (a) => maskAccount(a.accountNumber),
    where: 'Change it under Driver Wallet / Payouts.',
  },
  {
    field: 'account_name',
    label: 'Account name',
    read: (a) => a.accountName,
    where: 'Change it under Driver Wallet / Payouts.',
  },
];

/**
 * The state on the application.
 *
 * Not in `driver_field_risk` at all, so `fieldRisk` defaults it to locked and
 * the server refuses it — correctly. Shown here because it *was* submitted, and
 * a driver who has moved needs to see what Package Relay still has rather than wonder
 * why the form omits it. Base city, which is the one that actually decides
 * dispatch, is editable directly above it.
 */
const ORIGIN_ROW: LockedRow = {
  field: 'state',
  label: 'State on your application',
  read: (a) => a.state,
  where: 'Set when you applied. Contact support if you have moved state.',
};

/** Snapshot of the application, keyed the way the server expects. */
function toRow(application: DriverApplication): Record<string, string> {
  return {
    vehicle_type: application.vehicleType ?? '',
    vehicle_colour: application.vehicleColour ?? '',
    plate_number: application.plateNumber ?? '',
    base_city: application.baseCity ?? '',
    address: application.address ?? '',
    kin_name: application.kinName ?? '',
    kin_phone: application.kinPhone ?? '',
    kin_relationship: application.kinRelationship ?? '',
    full_name: application.fullName ?? '',
    nin: application.nin ?? '',
    license_id: application.licenseId ?? '',
    guarantor_name: application.guarantorName ?? '',
    guarantor_phone: application.guarantorPhone ?? '',
    guarantor_relationship: application.guarantorRelationship ?? '',
    guarantor_address: application.guarantorAddress ?? '',
    guarantor_nin: application.guarantorNin ?? '',
  };
}

export function ProfileEditSheet({
  visible,
  application,
  onClose,
  onSaved,
}: {
  visible: boolean;
  application: DriverApplication;
  onClose: () => void;
  onSaved: () => void;
}) {
  const theme = useTheme();

  const original = useMemo(() => toRow(application), [application]);
  const [draft, setDraft] = useState<Record<string, string>>(original);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (key: string) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  /*
   * The patch, recomputed on every keystroke.
   *
   * Everything below reads from this rather than from `draft`: what the driver
   * is about to be charged depends on what *differs*, not on what is on screen.
   */
  const patch = changedFields(original, draft);
  const risk = patchRisk(patch);
  const changed = Object.keys(patch);
  const dirty = changed.length > 0;
  const warning = editWarning(patch);

  const close = () => {
    setDraft(original);
    setIdentityOpen(false);
    setError('');
    onClose();
  };

  const submit = async () => {
    if (!dirty) return;

    setBusy(true);
    setError('');
    const outcome = await saveProfile(patch);
    setBusy(false);

    if (!outcome.ok) {
      /*
       * The server's sentence, verbatim.
       *
       * "Finish or release your current trip", "Bank details change through
       * Payout settings" — each names the thing to do next. A generic failure
       * would leave a driver pressing the same button against a rule they
       * cannot see.
       */
      setError(outcome.error);
      return;
    }

    showToast(
      outcome.suspended ? 'Sent for review' : 'Profile updated',
      outcome.suspended
        ? {
            message:
              'An admin will check your new details. You will not be offered trips until then.',
            tone: 'info',
          }
        : { message: `Updated ${changed.map(fieldLabel).join(', ')}.` },
    );

    onSaved();
    close();
  };

  return (
    <BottomSheet visible={visible} onClose={close}>
      {/*
        Constrained. A bottom sheet on a 2000px browser stretches its inputs the
        full width of the window, which is how a form ends up looking like a
        spreadsheet — no line length control, and the label miles from the value
        it belongs to. 560px is a comfortable single-column form measure.
      */}
      <View style={styles.frame}>
        {/* ---------------------------------------------------- header ---- */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.text }]}>Edit your details</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            Everyday details save immediately. Anything Package Relay verified during your application is
            handled separately below.
          </Text>
        </View>

        {/* ----------------------------------------- the editable tier ---- */}
        {EDITABLE_SECTIONS.map((section) => (
          <SectionCard key={section.key} section={section}>
            {section.fields.map((field) => (
              <Field
                key={field.key}
                label={field.label}
                placeholder={field.placeholder}
                value={draft[field.key] ?? ''}
                onChangeText={(text) => set(field.key)(field.mask ? field.mask(text) : text)}
                keyboardType={field.keyboardType}
                autoCapitalize={field.autoCapitalize}
                maxLength={field.maxLength}
              />
            ))}

            {/*
              Base city belongs to Personal details, but it is a Dropdown rather
              than a Field, so it cannot come from the `fields` array without
              giving every spec a "kind" discriminator for the sake of one row.
            */}
            {section.key === 'personal' && (
              <>
                <Dropdown
                  label="Base city"
                  options={CITIES}
                  selected={(draft.base_city || CITIES[0]) as string}
                  onSelect={(value) => set('base_city')(String(value))}
                />

                {/*
                  The state, in the group it belongs to rather than exiled to the
                  locked section at the bottom.

                  It sits directly under Base city on purpose: they are the two
                  answers to "where are you", one editable and one not, and a
                  driver comparing them can see at a glance which one dispatch
                  actually uses.
                */}
                <LockedValue row={ORIGIN_ROW} application={application} />
              </>
            )}
          </SectionCard>
        ))}

        {/* --------------------------------------- the high-risk tier ----- */}
        {/*
          Behind a disclosure that states the cost before it opens. A driver who
          expands this has read what it does; one who never opens it cannot
          suspend themselves by tabbing through the form.
        */}
        <Pressable
          onPress={() => setIdentityOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: identityOpen }}
          style={({ pressed }) => [
            styles.disclosure,
            styles.tappable,
            {
              backgroundColor: theme.surface,
              borderColor: identityOpen ? theme.warning : theme.border,
            },
            pressed && styles.pressed,
          ]}>
          <View style={[styles.sectionIcon, { backgroundColor: theme.warningSoft }]}>
            <ShieldAlert color={theme.warningOnSoft} size={17} />
          </View>
          <View style={styles.sectionHeaderText}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>
              Identity &amp; verification
            </Text>
            <Text style={[styles.sectionCaption, { color: theme.textMuted }]}>
              Name, NIN, licence and guarantor — changing any of these pauses your approval.
            </Text>
          </View>
          <View style={identityOpen ? styles.caretOpen : undefined}>
            <ChevronDown color={theme.textMuted} size={18} />
          </View>
        </Pressable>

        {identityOpen && (
          <View style={[styles.identityBody, { borderColor: theme.border }]}>
            <View style={[styles.notice, { backgroundColor: theme.warningSoft }]}>
              <Info color={theme.warningOnSoft} size={16} />
              <Text style={[styles.noticeText, { color: theme.warningOnSoft }]}>
                These are the details Package Relay approved you on. Saving a change here returns your
                account to review, and you will not be offered new trips until an administrator
                approves it. It cannot be done while you are carrying a parcel.
              </Text>
            </View>

            {IDENTITY_FIELDS.map((field) => (
              <Field
                key={field.key}
                label={field.label}
                placeholder={field.placeholder}
                value={draft[field.key] ?? ''}
                onChangeText={(text) => set(field.key)(field.mask ? field.mask(text) : text)}
                keyboardType={field.keyboardType}
                maxLength={field.maxLength}
              />
            ))}
          </View>
        )}

        {/* --------------------------------------------- the documents ---- */}
        {/*
          What was uploaded, alongside what was typed.

          The application is a form *and* five files, and a sheet showing only
          the form answers a driver's question by half — "what does Package Relay have
          for me" includes the licence they photographed at 11pm eighteen months
          ago. The list is read-only apart from the expiry date, which is the one
          thing on it a driver can correct without sending a new file.
        */}
        <DocumentList />

        {/* ------------------------------------------ the locked tier ----- */}
        {/*
          Shown WITH THEIR VALUES, not merely described.

          These were two prose banners explaining that bank and contact details
          are managed elsewhere. That answered "can I change this here?" and left
          the more common question — "what does Package Relay actually have for me?" —
          unanswered, so a driver who suspected a wrong phone number on file had
          no way to check it from the one screen about their own details.

          Two groups rather than one list, because they are locked for entirely
          different reasons: contact details by an operational rule, payout
          details by a money control. A driver reading a merged block has to work
          out which explanation applies to the field they came for.
        */}
        <Text style={[styles.groupLabel, { color: theme.textMuted }]}>
          ON FILE, MANAGED ELSEWHERE
        </Text>

        <LockedCard
          title="Contact details"
          caption="How Package Relay reaches you about a parcel."
          icon={(color, size) => <Lock color={color} size={size} />}
          tint={theme.neutralSoft}
          tintOn={theme.neutralOnSoft}
          rows={CONTACT_ROWS}
          application={application}
          reason={
            'Locked because Package Relay uses these to reach you about parcels already assigned to you — ' +
            'a change mid-delivery can send a pickup alert to a number that no longer belongs to ' +
            'you. If you do need them updated, please contact support and the team will make the ' +
            'change with you.'
          }
        />

        <LockedCard
          title="Payout account"
          caption="Where your earnings are sent."
          icon={(color, size) => <Wallet color={color} size={size} />}
          tint={theme.primarySoft}
          tintOn={theme.primaryOnSoft}
          rows={PAYOUT_ROWS}
          application={application}
          reason={
            `Please update these from the Driver Wallet / Payouts screen. For your protection a ` +
            `change there takes effect after a ${PAYOUT_COOLING_HOURS}-hour verification window, ` +
            `during which your current account continues to receive every transfer as normal — no ` +
            `payment is ever paused or missed.`
          }
        />

        {/* ----------------------------------------------------- footer --- */}
        {!!warning && risk === 'high' && (
          <View style={[styles.notice, { backgroundColor: theme.warningSoft }]}>
            <ShieldAlert color={theme.warningOnSoft} size={16} />
            <Text style={[styles.noticeText, { color: theme.warningOnSoft }]}>{warning}</Text>
          </View>
        )}

        {!!error && (
          <View style={[styles.notice, { backgroundColor: theme.dangerSoft }]}>
            <Info color={theme.dangerOnSoft} size={16} />
            <Text style={[styles.noticeText, { color: theme.dangerOnSoft }]}>{error}</Text>
          </View>
        )}

        {/*
          What is about to be saved, named.

          A Save button that is simply enabled tells a driver something changed
          but not what — and after scrolling three sections, "what did I touch?"
          is a real question. Listing the fields is also the last chance to
          notice a stray edit before it costs an approval.
        */}
        {dirty && (
          <View style={[styles.summary, { backgroundColor: theme.surfaceMuted }]}>
            <ShieldCheck color={risk === 'high' ? theme.warningOnSoft : theme.success} size={15} />
            <Text style={[styles.summaryText, { color: theme.textSecondary }]}>
              Ready to save: <Text style={font(600)}>{changed.map(fieldLabel).join(', ')}</Text>
            </Text>
          </View>
        )}

        <View style={styles.actions}>
          <Button
            label={
              busy
                ? 'Saving…'
                : !dirty
                  ? 'No changes yet'
                  : risk === 'high'
                    ? 'Save and send for review'
                    : 'Save changes'
            }
            onPress={submit}
            disabled={busy || !dirty}
          />
          <Button label="Cancel" variant="secondary" onPress={close} disabled={busy} />
        </View>
      </View>
    </BottomSheet>
  );
}

/**
 * One titled group of fields.
 *
 * The caption is load-bearing rather than decorative: "Next of kin" is a form
 * label people fill in without reading, and "who Package Relay contacts if something
 * happens to you on a trip" is the sentence that makes somebody check the
 * number is current.
 */
function SectionCard({ section, children }: { section: Section; children: React.ReactNode }) {
  const theme = useTheme();

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.sectionHeader}>
        <View style={[styles.sectionIcon, { backgroundColor: theme.primarySoft }]}>
          {section.icon(theme.primaryOnSoft, 17)}
        </View>
        <View style={styles.sectionHeaderText}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>{section.title}</Text>
          <Text style={[styles.sectionCaption, { color: theme.textMuted }]}>{section.caption}</Text>
        </View>
      </View>

      <View style={[styles.rule, { backgroundColor: theme.border }]} />

      <View style={styles.fields}>{children}</View>
    </View>
  );
}

/**
 * One read-only value, styled so it cannot be mistaken for an input.
 *
 * ⚠ It has to look *unlike* the `Field`s above it, not merely be disabled.
 *
 *   A greyed-out text box still reads as a box you should be able to type in,
 *   and a driver will tap it, get no caret, and conclude the form is broken. A
 *   recessed row with a lock and no border is a different object.
 */
function LockedValue({ row, application }: { row: LockedRow; application: DriverApplication }) {
  const theme = useTheme();
  const value = row.read(application);

  return (
    <View style={[styles.lockedRow, { backgroundColor: theme.surfaceMuted }]}>
      <View style={styles.lockedRowText}>
        <Text style={[styles.lockedRowLabel, { color: theme.textMuted }]}>{row.label}</Text>
        {/*
          An empty value is stated, not left blank.

          A blank line under "Account name" reads as a rendering failure. "Not
          recorded" reads as a gap the driver can ask support to fill, which is
          what it is.
        */}
        <Text style={[styles.lockedRowValue, { color: value ? theme.text : theme.textMuted }]}>
          {value || 'Not recorded'}
        </Text>
      </View>
      <Lock color={theme.textMuted} size={14} />
    </View>
  );
}

/** A titled group of read-only values, with one shared reason underneath. */
function LockedCard({
  title,
  caption,
  icon,
  tint,
  tintOn,
  rows,
  application,
  reason,
}: {
  title: string;
  caption: string;
  icon: (color: string, size: number) => React.ReactNode;
  tint: string;
  tintOn: string;
  rows: LockedRow[];
  application: DriverApplication;
  reason: string;
}) {
  const theme = useTheme();

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.sectionHeader}>
        <View style={[styles.sectionIcon, { backgroundColor: tint }]}>{icon(tintOn, 17)}</View>
        <View style={styles.sectionHeaderText}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>{title}</Text>
          <Text style={[styles.sectionCaption, { color: theme.textMuted }]}>{caption}</Text>
        </View>
      </View>

      <View style={[styles.rule, { backgroundColor: theme.border }]} />

      <View style={styles.lockedRows}>
        {rows.map((row) => (
          <LockedValue key={row.field} row={row} application={application} />
        ))}
      </View>

      {/*
        The reason once per group, not once per row.

        All three payout rows are locked by the same 48-hour window; repeating
        it three times is noise that pushes the actual values apart.
      */}
      <Text style={[styles.lockedBody, { color: theme.textSecondary }]}>{reason}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  /** A single-column form measure, centred on wide screens. */
  frame: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    gap: Spacing.three,
    paddingBottom: Spacing.two,
  },
  header: {
    gap: Spacing.one + 2,
    paddingBottom: Spacing.one,
  },
  title: {
    ...Typography.sectionHeading,
  },
  subtitle: {
    ...Typography.meta,
    lineHeight: 20,
  },
  card: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.three,
    gap: Spacing.three - 2,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
  },
  sectionIcon: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionHeaderText: {
    flex: 1,
    gap: 1,
  },
  sectionTitle: {
    fontSize: FontSize.body,
    ...font(700),
  },
  sectionCaption: {
    ...Typography.caption,
    lineHeight: 17,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
  },
  /** 16px between inputs. The old form ran them together at 8px. */
  fields: {
    gap: Spacing.three - 2,
  },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  caretOpen: {
    transform: [{ rotate: '180deg' }],
  },
  identityBody: {
    gap: Spacing.three - 2,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    // Pulled up so it reads as the disclosure's contents rather than a
    // separate card that happens to follow it.
    marginTop: -Spacing.two - 4,
  },
  groupLabel: {
    ...Typography.caption,
    ...font(700),
    letterSpacing: 0.8,
    marginTop: Spacing.two,
  },
  lockedRows: { gap: Spacing.two },
  lockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two + 4,
    borderRadius: Radius.sm,
  },
  lockedRowText: { flex: 1, gap: 1 },
  lockedRowLabel: { ...Typography.caption },
  lockedRowValue: { ...Typography.meta, ...font(600) },
  locked: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two + 2,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  lockedText: {
    flex: 1,
    gap: Spacing.one,
  },
  lockedTitle: {
    ...Typography.meta,
    ...font(700),
  },
  lockedBody: {
    ...Typography.caption,
    lineHeight: 19,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
  },
  noticeText: {
    flex: 1,
    ...Typography.caption,
    lineHeight: 19,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.two + 4,
    borderRadius: Radius.md,
  },
  summaryText: {
    flex: 1,
    ...Typography.caption,
    lineHeight: 18,
  },
  actions: {
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  // react-native-web renders Pressable as a plain div, which shows a text caret
  // rather than a pointer unless it is asked.
  tappable: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  pressed: { opacity: 0.6 },
});
