import { Eye, EyeOff, PackageOpen, Radio, ShieldAlert } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatStamp } from '@/lib/when';
import { ParcelPhotos } from '@/components/ui/parcel-photos';
import { Badge } from '@/components/ui/badge';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { EmptyState, SectionLabel } from '@/components/ui/screen';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  ageLabel,
  fetchAdminParcelDetail,
  fetchAdminParcels,
  fetchDeliveryAttribution,
  fetchUnassignedByDestination,
  revealParcelContacts,
  waitedLabel,
  type AdminParcelDetail,
  type AdminParcelRow,
  type DeliveryAttribution,
  type ParcelContacts,
  type ParcelScope,
  type UnassignedDestination,
} from '@/store/admin';
import { formatNaira } from '@/store/bookings';
import {
  attemptsLabel,
  fetchOfferAttempts,
  type OfferAttempts,
} from '@/store/dispatch-mode';

/**
 * The parcel drawer, opened from any admin stat card or list row.
 *
 * Two levels, on purpose:
 *
 *   the list    every parcel in a scope, enough to pick one out
 *   the detail  everything operational about that parcel
 *
 * ⚠ Names, phone numbers and addresses are not here. They come from an explicit
 *   "Show contact details" action that writes an audit line naming the admin
 *   and the parcel — see `admin_reveal_parcel_contacts`. An operator answering
 *   "why is this stuck" never needs a customer's home address, and the ones who
 *   do need it should leave a trace.
 */
export function AdminParcelDrawer({
  scope,
  city,
  title,
  focusId,
  onClose,
}: {
  /** Null closes the drawer, unless `focusId` is set. */
  scope: ParcelScope | null;
  city?: string;
  title: string;
  /**
   * One parcel, opened straight to its detail with no list behind it.
   *
   * ⚠ The alternative was a second drawer for the in-flight board, which would
   *   have meant a second copy of the audited contact reveal — and the day those
   *   two disagree about what an admin may see is the day one of them is wrong.
   *   Back closes, rather than returning to a list that was never there.
   */
  focusId?: string | null;
  onClose: () => void;
}) {
  const theme = useTheme();

  const [rows, setRows] = useState<AdminParcelRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);

  /*
   * The destination breakdown, moved here from the dashboard.
   *
   * It used to be an inline expander on the Unclaimed card, which meant that
   * card behaved differently from every other one — click to expand rather than
   * click to open. Here it is a filter over the list it describes, which is
   * both the same information and one fewer thing to learn.
   */
  const [destinations, setDestinations] = useState<UnassignedDestination[]>([]);
  const [pickedCity, setPickedCity] = useState<string | undefined>(undefined);

  const activeCity = pickedCity ?? city;

  useEffect(() => {
    /* One parcel, straight to the detail: there is no list to fetch. */
    if (focusId) {
      setOpenId(focusId);
      setRows(null);
      setDestinations([]);
      return;
    }

    if (!scope) {
      setRows(null);
      setOpenId(null);
      setPickedCity(undefined);
      setDestinations([]);
      return;
    }

    let cancelled = false;
    void fetchAdminParcels(scope, activeCity).then((result) => {
      if (!cancelled) setRows(result);
    });

    // Only the unassigned view has a backlog worth splitting by destination.
    if (scope === 'unassigned') {
      void fetchUnassignedByDestination().then((result) => {
        if (!cancelled) setDestinations(result);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [scope, activeCity, focusId]);

  return (
    <BottomSheet visible={scope !== null || !!focusId} onClose={onClose}>
      {/* A View, not a ScrollView — BottomSheet already scrolls. */}
      <View style={styles.sheet}>
        <Text style={[styles.title, { color: theme.text }]}>{title}</Text>

        {openId ? (
          <ParcelDetail
            id={openId}
            /*
              ⚠ No back control at all when the drawer was opened on one parcel.

                The sheet already ends with its own Close, outside this branch.
                Giving the detail a second one labelled Close stacked two
                identical buttons at the bottom of the sheet — which is what
                shipped. With a list behind it the two are different actions and
                both earn their place: Back returns to the list, Close dismisses
                the sheet.
            */
            backLabel={focusId ? null : 'Back to the list'}
            onBack={() => setOpenId(null)}
          />
        ) : (
          <>
            {destinations.length > 0 && (
              <View style={styles.chips}>
                <Chip
                  label={`All (${destinations.reduce((sum, d) => sum + d.parcels, 0)})`}
                  active={!activeCity}
                  onPress={() => setPickedCity(undefined)}
                />
                {destinations.map((destination) => (
                  <Chip
                    key={destination.city}
                    label={`${destination.city} (${destination.parcels})`}
                    /*
                      The oldest wait, on the chip itself. A city with four
                      parcels waiting two days is a different problem from one
                      with four posted this morning, and the count alone cannot
                      tell them apart.
                    */
                    hint={`oldest ${waitedLabel(destination.oldestHours)}`}
                    active={activeCity === destination.city}
                    onPress={() => setPickedCity(destination.city)}
                  />
                ))}
              </View>
            )}
            {rows === null ? (
              <ActivityIndicator color={theme.primary} style={styles.loading} />
            ) : rows.length === 0 ? (
              <EmptyState
                icon={(color, size) => <PackageOpen color={color} size={size} />}
                title="Nothing here"
                message="No parcels match this view."
              />
            ) : (
              <View style={styles.list}>
                {rows.map((row) => (
                  <Pressable
                    key={row.id}
                    onPress={() => setOpenId(row.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Parcel ${row.trackingId}, ${row.status}`}
                    style={({ pressed }) => [
                      styles.row,
                      { backgroundColor: theme.surface, borderColor: theme.border },
                      pressed && styles.pressed,
                    ]}>
                    <View style={styles.rowText}>
                      <Text style={[styles.rowId, { color: theme.text }]}>#{row.trackingId}</Text>
                      <Text style={[styles.rowMeta, { color: theme.textMuted }]} numberOfLines={1}>
                        {row.originCity} → {row.destinationCity} · {row.weight} kg ·{' '}
                        {ageLabel(row.createdAt)} old
                      </Text>
                      {/*
                    The driver, or the reason there is not one. "Unassigned" on
                    a parcel dispatch is actively working reads very differently
                    from "unassigned" on one nobody has been offered.
                  */}
                      <Text style={[styles.rowMeta, { color: theme.textMuted }]} numberOfLines={1}>
                        {row.driverName
                          ? `Carrying: ${row.driverName}`
                          : row.offerOutstanding
                            ? 'Offered to a driver now'
                            : 'No driver, no live offer'}
                      </Text>
                    </View>
                    <Badge label={row.status} tone={row.driverName ? 'primary' : 'warning'} />
                  </Pressable>
                ))}

                {rows.length >= 50 && (
                  <Text style={[styles.note, { color: theme.textMuted }]}>
                    Showing the 50 oldest. Filter by destination above to narrow it.
                  </Text>
                )}
              </View>
            )}
          </>
        )}

        <Button label="Close" variant="secondary" onPress={onClose} />
      </View>
    </BottomSheet>
  );
}

/**
 * A destination filter.
 *
 * Its own component rather than a `Badge`, because a badge is decoration and
 * this is a control — it needs a press target of a usable size and a selected
 * state, and a badge has neither.
 */
function Chip({
  label,
  hint,
  active,
  onPress,
}: {
  label: string;
  hint?: string;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: active ? theme.primary : theme.surfaceMuted,
          borderColor: active ? theme.primary : theme.border,
        },
        pressed && styles.pressed,
      ]}>
      <Text style={[styles.chipLabel, { color: active ? theme.primaryText : theme.text }]}>
        {label}
      </Text>
      {!!hint && (
        <Text style={[styles.chipHint, { color: active ? theme.primaryText : theme.textMuted }]}>
          {hint}
        </Text>
      )}
    </Pressable>
  );
}

function ParcelDetail({
  id,
  backLabel,
  onBack,
}: {
  id: string;
  /** Null when the sheet's own Close is the only way out. */
  backLabel: string | null;
  onBack: () => void;
}) {
  const theme = useTheme();

  const [detail, setDetail] = useState<AdminParcelDetail | null>(null);
  const [missing, setMissing] = useState(false);
  /** Null while loading and if the call fails — the line says which. */
  const [attempts, setAttempts] = useState<OfferAttempts | null>(null);
  /** Who closed the delivery: the carrier, or an operator. */
  const [attribution, setAttribution] = useState<DeliveryAttribution | null>(null);

  const [contacts, setContacts] = useState<ParcelContacts | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchAdminParcelDetail(id).then((result) => {
      if (cancelled) return;
      setDetail(result);
      setMissing(result === null);
    });
    void fetchOfferAttempts(id).then((result) => {
      if (!cancelled) setAttempts(result);
    });
    void fetchDeliveryAttribution(id).then((result) => {
      if (!cancelled) setAttribution(result);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const reveal = useCallback(async () => {
    setBusy(true);
    const result = await revealParcelContacts(id, reason);
    setBusy(false);
    if (result) {
      setContacts(result);
      setAsking(false);
    }
  }, [id, reason]);

  if (missing) {
    return (
      <View style={styles.detail}>
        <Text style={[styles.note, { color: theme.textMuted }]}>
          That parcel could not be read. It may have been deleted.
        </Text>
        {!!backLabel && <Button label={backLabel} variant="secondary" onPress={onBack} />}
      </View>
    );
  }

  if (!detail) return <ActivityIndicator color={theme.primary} style={styles.loading} />;

  return (
    <View style={styles.detail}>
      <View style={styles.detailHead}>
        <Text style={[styles.detailId, { color: theme.text }]}>#{detail.trackingId}</Text>
        <Badge label={detail.status} tone={detail.driverName ? 'primary' : 'warning'} />
      </View>

      <SectionLabel>Route</SectionLabel>
      <Row label="From" value={`${detail.pickupArea}, ${detail.originCity}`} />
      <Row label="To" value={`${detail.dropoffArea}, ${detail.destinationCity}`} />
      <Row label="Handover" value={`${detail.pickupMode} → ${detail.dropoffMode}`} />

      <SectionLabel>Parcel</SectionLabel>
      <Row label="Item" value={detail.category} />
      <Row label="Weight" value={`${detail.weight} kg`} />
      <Row label="Declared value" value={formatNaira(detail.declaredValue)} />
      <Row label="Fee" value={formatNaira(detail.estimatedFee)} />
      {detail.fragile && <Row label="Handling" value="Fragile" />}

      <SectionLabel>Timing</SectionLabel>
      <Row label="Posted" value={when(detail.createdAt)} />
      <Row label="Accepted" value={when(detail.acceptedAt)} />
      <Row label="Collected" value={when(detail.pickedUpAt)} />
      <Row label="Delivered" value={when(detail.deliveredAt)} />
      {/*
        Who said so, when it was not the driver.

        ⚠ Shown only for an admin-recorded delivery, because that is the case
          where the question has an answer worth printing. A delivery the carrier
          recorded needs no line saying the carrier recorded it — but one closed
          from an office, months later, is indistinguishable from the real thing
          unless the row says otherwise. See `delivery_recorded_by` in 74.
      */}
      {attribution?.recordedByAdmin && (
        <Row
          label="Closed by"
          value={`${attribution.adminName ?? 'An administrator'} — the driver never recorded it`}
        />
      )}
      {detail.cancelledAt && (
        <Row
          label="Cancelled"
          value={`${when(detail.cancelledAt)} — ${detail.cancellationReason ?? 'no reason given'}`}
        />
      )}

      <SectionLabel>Dispatch</SectionLabel>
      <Row label="Driver" value={detail.driverName ?? 'Not assigned'} />
      <View style={styles.detailRow}>
        <Radio color={theme.textMuted} size={14} />
        {/*
          ⚠ Read from `offer_attempts`, not from `detail.offersMade`.

            That column counts offer rows and this line used to render it as
            "Offered to N drivers" — the same miscount the dispatch queue made,
            which turned seven attempts at one driver into a sentence about five
            drivers refusing a parcel. 71 added one function that counts both,
            and all three screens that say this now read it from there.
            `admin_parcel_detail` returns thirty columns and was left alone
            rather than recreated to add three.
        */}
        <Text style={[styles.detailValue, { color: theme.textSecondary }]}>
          {attempts === null
            ? 'Dispatch history unavailable'
            : (attemptsLabel(attempts) ?? 'Never offered to a driver')}
        </Text>
      </View>

      {/*
        The photographs, above the checks that describe them.

        "Photo on file: Yes" used to be the whole of it — a boolean about an
        image nobody could open. The parcel's own photo is shown outright; the
        sender's face costs a reason and is logged. See `parcel-photos.tsx`.
      */}
      <ParcelPhotos
        bookingId={detail.id}
        itemPhotoPath={detail.itemPhotoPath}
        hasSenderPhoto={detail.hasSenderPhoto}
      />

      <SectionLabel>Sender check</SectionLabel>
      <Row label="Liveness" value={detail.livenessStatus ?? 'not checked'} />

      {/* ---------- the audited door ---------- */}
      <View style={[styles.contactBox, { borderColor: theme.border }]}>
        {contacts ? (
          <>
            <View style={styles.detailRow}>
              <Eye color={theme.warningOnSoft} size={14} />
              <Text style={[styles.contactHead, { color: theme.warningOnSoft }]}>
                Contact details — this view has been logged
              </Text>
            </View>
            <Row label="Sender" value={`${contacts.pickupContactName} · ${contacts.senderPhone}`} />
            <Row label="Pickup" value={contacts.pickupAddress || '—'} />
            <Row
              label="Recipient"
              value={`${contacts.recipientName} · ${contacts.recipientPhone}`}
            />
            <Row label="Drop-off" value={contacts.dropoffAddress || '—'} />
          </>
        ) : asking ? (
          <>
            <Text style={[styles.contactHead, { color: theme.text }]}>
              Why do you need the contact details?
            </Text>
            {/*
              The reason is optional to the database and asked for here anyway.
              A log of who looked is useful; a log of who looked and why is the
              one somebody can actually review.
            */}
            <Field
              label="Reason (optional)"
              placeholder="Customer called about a delayed parcel"
              value={reason}
              onChangeText={setReason}
            />
            <Button
              label={busy ? 'Opening…' : 'Show and log it'}
              size="md"
              onPress={reveal}
              disabled={busy}
            />
            <Button
              label="Cancel"
              variant="secondary"
              size="md"
              onPress={() => setAsking(false)}
              disabled={busy}
            />
          </>
        ) : (
          <>
            <View style={styles.detailRow}>
              <EyeOff color={theme.textMuted} size={14} />
              <Text style={[styles.contactHead, { color: theme.textMuted }]}>
                Names, phone numbers and addresses are hidden
              </Text>
            </View>
            <Text style={[styles.note, { color: theme.textMuted }]}>
              Opening them writes a line to the audit log with your name and this parcel.
            </Text>
            <Button
              label="Show contact details"
              variant="secondary"
              size="md"
              icon={(color, size) => <ShieldAlert color={color} size={size} />}
              onPress={() => setAsking(true)}
            />
          </>
        )}
      </View>

      {!!backLabel && <Button label={backLabel} variant="secondary" onPress={onBack} />}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.kv}>
      <Text style={[styles.kvLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.kvValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

/** A timestamp in Lagos time, or an em dash — never an invented date. */
function when(iso: string | null): string {
  return formatStamp(iso) || '—';
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two - 2,
  },
  chip: {
    cursor: 'pointer',
    paddingHorizontal: Spacing.three - 4,
    // 44px of target height for a small label — a filter row is tapped far
    // more often than it is read.
    paddingVertical: Spacing.two + 2,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  chipLabel: {
    ...Typography.caption,
    ...font(700),
  },
  chipHint: {
    ...Typography.caption,
    fontSize: 10,
  },
  sheet: { gap: Spacing.three },
  title: { ...Typography.sectionTitle },
  loading: { paddingVertical: Spacing.four },
  list: { gap: Spacing.two },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    // Explicit, for the same reason as `metricSlot`. Ignored on native.
    cursor: 'pointer',
  },
  rowText: { flex: 1, gap: Spacing.half },
  rowId: { ...Typography.meta, ...font(700) },
  rowMeta: { ...Typography.caption },
  detail: { gap: Spacing.two },
  detailHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    marginBottom: Spacing.two,
  },
  detailId: { ...Typography.sectionTitle, flex: 1 },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  detailValue: { ...Typography.caption, flex: 1, lineHeight: 17 },
  kv: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingVertical: Spacing.one,
  },
  kvLabel: { ...Typography.caption },
  kvValue: { ...Typography.caption, ...font(600), flex: 1, textAlign: 'right' },
  contactBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.md,
    padding: Spacing.three - 4,
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  contactHead: { ...Typography.caption, ...font(700), flex: 1 },
  note: { ...Typography.caption, lineHeight: 17 },
  pressed: { opacity: 0.6 },
});
