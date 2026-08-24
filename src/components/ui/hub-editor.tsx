import { MapPin, X } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';
import { ToggleRow } from '@/components/ui/dropdown';
import type { Hub } from '@/constants/hubs';
import { Elevation, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useAddressSuggestions } from '@/hooks/use-address-suggestions';
import { useTheme } from '@/hooks/use-theme';
import type { Suggestion } from '@/store/places';
import { ChipGroup } from '@/components/ui/chip';
import { CITIES, DEFAULT_CITY, type City } from '@/store/bookings';
import { nextHubId, useHubs, validateHubEdit, type HubEdit } from '@/store/hubs';

/** A sensible starting point for a new hub, not an empty form. */
const BLANK: HubEdit = {
  name: '',
  area: '',
  address: '',
  // Prefilled with the shape the validator wants, so the format is shown rather
  // than only described in an error after the first failed save.
  hours: 'Mon–Sat, 9:00am – 6:00pm',
  phone: '',
  services: ['Drop-off', 'Collection'],
  flagship: false,
  lat: null,
  lng: null,
  active: true,
};

/**
 * Creating or editing one hub.
 *
 * A modal rather than an inline row: an address, opening hours, a phone number
 * and a pair of coordinates is too much to expand in a list, and half-finished
 * edits to several hubs at once is a way to save the wrong one.
 *
 * `hub` null means create. The two modes share this component because the
 * fields and their validation are identical — two forms would drift, and the
 * one that drifts is always the one used less often.
 *
 * Neither mode can change an existing `id` or `city`. The id is referenced by
 * existing bookings, and moving a hub between cities would silently re-file
 * every parcel booked against it — that is a data migration, not a text field.
 * A *new* hub picks its city once, because nothing references it yet.
 */
export function HubEditor({
  hub,
  city: initialCity,
  disabled,
  onClose,
  onSaved,
}: {
  /** Null to create. */
  hub: Hub | null;
  /** Starting city for a new hub. Ignored when editing. */
  city?: City;
  /** True when the seed list is showing, so there is no table to write to. */
  disabled: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const theme = useTheme();
  const { updateHub, createHub, allHubs } = useHubs();

  const creating = hub === null;
  const [city, setCity] = useState<City>(hub?.city ?? initialCity ?? DEFAULT_CITY);

  const [edit, setEdit] = useState<HubEdit>(
    hub
      ? {
          name: hub.name,
          area: hub.area,
          address: hub.address,
          hours: hub.hours,
          phone: hub.phone,
          services: hub.services,
          flagship: Boolean(hub.flagship),
          lat: hub.coordinates?.lat ?? null,
          lng: hub.coordinates?.lng ?? null,
          /*
           * The stored value, not `true`.
           *
           * Hardcoding true meant opening a closed hub's editor and pressing
           * Save silently re-opened it to senders — a change nobody asked for,
           * made by looking.
           */
          active: hub.active !== false,
        }
      : BLANK,
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof HubEdit>(key: K, value: HubEdit[K]) => {
    setEdit((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  /**
   * Coordinates as text, so a half-typed "7." doesn't become NaN mid-keystroke.
   *
   * An empty field means "no surveyed position" and must stay null rather than
   * becoming 0 — which is a point in the Gulf of Guinea, and passes any naive
   * "is it a number" check.
   */
  const setCoord = (key: 'lat' | 'lng', text: string) => {
    const trimmed = text.trim();
    if (trimmed === '') return set(key, null);

    const parsed = Number(trimmed);
    set(key, Number.isFinite(parsed) ? parsed : null);
  };

  const save = async () => {
    const problem = validateHubEdit(edit);
    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    try {
      if (hub) {
        await updateHub(hub.id, edit);
        showToast('Hub updated', { message: `${edit.name} — changes are live now.` });
      } else {
        await createHub(city, edit);
        showToast('Hub created', { message: `${edit.name} is live in ${city}.` });
      }
      onSaved();
    } catch (thrown) {
      /*
       * Shown verbatim. If Row Level Security refused the write the message
       * says so, and rewriting it as "Something went wrong" would hide that the
       * account simply is not an admin any more.
       */
      setError(errorMessage(thrown, 'Could not save the hub.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close editor">
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, shadowColor: theme.shadow },
            Elevation.raised,
          ]}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: theme.text }]}>
                {creating ? 'New hub' : 'Edit hub'}
              </Text>
              <Text style={[styles.subtitle, { color: theme.textMuted }]}>
                {creating
                  ? // Shown before saving so the id is never a surprise, and so a
                    // collision error afterwards names something recognisable.
                    `Will be created as ${nextHubId(allHubs, city)}`
                  : `${hub.id} · ${hub.city}`}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityLabel="Close"
              style={[styles.close, { backgroundColor: theme.surfaceMuted }]}>
              <X color={theme.textSecondary} size={18} />
            </Pressable>
          </View>

          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            {/*
              City is chosen once, at creation, and fixed afterwards. Offering
              it on an existing hub would let one tap re-file every parcel
              booked against it.
            */}
            {creating && (
              <View style={styles.field}>
                <Text style={[styles.label, { color: theme.textSecondary }]}>City</Text>
                <ChipGroup
                  options={CITIES as unknown as string[]}
                  selected={city}
                  onSelect={(value) => setCity(value as City)}
                  scrollable
                />
                <Text style={[styles.hint, { color: theme.textMuted }]}>
                  Fixed once saved — a hub cannot be moved between cities.
                </Text>
              </View>
            )}

            <Field label="Name" value={edit.name} onChange={(v) => set('name', v)} />
            <Field
              label="Area"
              value={edit.area}
              onChange={(v) => set('area', v)}
              hint="Shown as the neighbourhood, and copied onto a booking when a sender picks this hub."
            />
            {/*
              ⚠ The one address in the app that a stranger navigates to.

                Get Directions hands this string to a maps app. A hub address
                that Google cannot resolve fails silently for every sender who
                taps it, and nobody in the office finds out. Picking from the
                suggestions guarantees the string round-trips — but it stays
                typeable, because a new hub may not be on the map yet.
            */}
            <AddressSearchField
              label="Address"
              value={edit.address}
              onChange={(v) => set('address', v)}
              hint="This is what Get Directions searches for, so write it as you would to a taxi driver."
            />
            <Field
              label="Opening hours"
              value={edit.hours}
              onChange={(v) => set('hours', v)}
              hint='Must read like "Mon–Sat, 8:00am – 8:00pm". The Operating Hours page parses this to show whether the hub is open right now.'
            />
            <Field label="Phone" value={edit.phone} onChange={(v) => set('phone', v)} />

            <View style={styles.row}>
              <View style={styles.rowItem}>
                <Field
                  label="Latitude"
                  value={edit.lat === null ? '' : String(edit.lat)}
                  onChange={(v) => setCoord('lat', v)}
                  keyboardType="numeric"
                />
              </View>
              <View style={styles.rowItem}>
                <Field
                  label="Longitude"
                  value={edit.lng === null ? '' : String(edit.lng)}
                  onChange={(v) => setCoord('lng', v)}
                  keyboardType="numeric"
                />
              </View>
            </View>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Leave both blank to keep the approximate neighbourhood pin. Fill them in and the map
              stops calling this one approximate — so only enter a position you have actually stood
              at.
            </Text>

            <View style={styles.toggleRow}>
              <ToggleRow
                label="Flagship hub"
                description="Flagships carry the full service list, including packaging."
                value={edit.flagship}
                onValueChange={(v) => set('flagship', v)}
                tone="primary"
              />
            </View>

            <View style={styles.toggleRow}>
              <ToggleRow
                label="Open for business"
                description="Turning this off hides the hub from senders without deleting it, so parcels already booked against it keep their history."
                value={edit.active}
                onValueChange={(v) => set('active', v)}
              />
            </View>

            {!!error && (
              <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
                <Text style={[styles.errorText, { color: theme.dangerOnSoft }]}>{error}</Text>
              </View>
            )}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: theme.border }]}>
            <Button label="Cancel" variant="secondary" size="md" onPress={onClose} />
            <Button
              label={saving ? 'Saving…' : creating ? 'Create hub' : 'Save changes'}
              size="md"
              disabled={saving || disabled}
              onPress={() => void save()}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  multiline,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  multiline?: boolean;
  keyboardType?: 'numeric';
}) {
  const theme = useTheme();

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.textSecondary }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        keyboardType={keyboardType}
        accessibilityLabel={label}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          { backgroundColor: theme.surfaceMuted, borderColor: theme.border, color: theme.text },
        ]}
      />
      {!!hint && <Text style={[styles.hint, { color: theme.textMuted }]}>{hint}</Text>}
    </View>
  );
}

/**
 * The address field, with Google's suggestions under it.
 *
 * ⚠ Built on the local `Field` rather than the app's `AddressLookup`.
 *
 *   `AddressLookup` renders the shared, rounded, icon-led input used on the
 *   public forms. This sheet is an admin panel with its own flatter styling,
 *   and dropping one foreign-looking control into the middle of eight matching
 *   ones reads as a bug. The lookup *logic* is shared through the hook, which
 *   is the part that must not diverge — the presentation is allowed to.
 */
function AddressSearchField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  const theme = useTheme();
  const { suggestions, searching, unavailable, resolve, reopen } = useAddressSuggestions(value);

  const choose = async (suggestion: Suggestion) => {
    onChange(suggestion.description);
    const result = await resolve(suggestion);
    if (result.ok && result.details.formattedAddress) {
      onChange(result.details.formattedAddress);
    }
  };

  return (
    <View>
      <Field
        label={label}
        value={value}
        onChange={(next) => {
          reopen();
          onChange(next);
        }}
        multiline
        hint={
          unavailable
            ? 'Address search is unavailable right now — type the address in full.'
            : searching
              ? 'Searching…'
              : hint
        }
      />

      {suggestions.length > 0 && (
        <View
          style={[
            styles.suggestions,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}>
          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion.placeId}
              onPress={() => void choose(suggestion)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.suggestion, pressed && { opacity: 0.6 }]}>
              <MapPin color={theme.textMuted} size={13} />
              <Text style={[styles.suggestionText, { color: theme.text }]} numberOfLines={1}>
                {suggestion.description}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '90%',
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
    paddingBottom: Spacing.three,
  },
  headerText: {
    flex: 1,
    gap: Spacing.half,
  },
  title: {
    ...Typography.sectionTitle,
  },
  subtitle: {
    ...Typography.caption,
  },
  close: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    paddingHorizontal: Spacing.four,
  },
  field: {
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  suggestions: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginTop: -Spacing.two,
    marginBottom: Spacing.three,
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two + 2,
  },
  suggestionText: {
    ...Typography.caption,
    flex: 1,
  },
  label: {
    ...Typography.caption,
    ...font(700),
  },
  input: {
    minHeight: 44,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three - 2,
    paddingVertical: Spacing.two,
    ...Typography.meta,
    // See `field.tsx`: RN types outlineStyle as solid/dotted/dashed only.
    outlineWidth: 0,
  },
  inputMultiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  hint: {
    ...Typography.caption,
    lineHeight: 17,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  rowItem: {
    flex: 1,
  },
  toggleRow: {
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  error: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    marginBottom: Spacing.three,
  },
  errorText: {
    ...Typography.caption,
    ...font(600),
    lineHeight: 18,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    padding: Spacing.four,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
