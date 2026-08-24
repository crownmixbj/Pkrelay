import { MapPin, Search } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Dropdown } from '@/components/ui/dropdown';
import { Field } from '@/components/ui/field';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useAddressSuggestions } from '@/hooks/use-address-suggestions';
import { useTheme } from '@/hooks/use-theme';
import { resolutionSummary } from '@/lib/place-to-city';
import type { Point } from '@/lib/distance';
import { unavailableReason, type Suggestion } from '@/store/places';
import { CITIES, cityHubLabel, type City } from '@/store/bookings';

/**
 * Type an address, get a city the pricing understands.
 *
 * ⚠ The value this hands back is a `City`, not an address, and that is the
 *   point rather than a limitation.
 *
 *   `estimateFee` prices by band — same city or not — with no distance term.
 *   So the address is a way of *choosing* among 37 names, for the many people
 *   who know their street but would hesitate over which LOCI city it belongs
 *   to. The formatted address comes back too, for the booking form to carry
 *   forward to a driver, but it is not what sets the price.
 *
 * ⚠ The city picker is always one tap away, and is shown automatically when
 *   lookup cannot work.
 *
 *   No key on this deployment, no network, Google rate-limiting us, or an
 *   address in a state LOCI does not serve — none of those is the person's
 *   fault, and a quote form that becomes unusable because a third party is
 *   having a bad afternoon is worse than one that never had autocomplete. The
 *   fallback is the control this field replaced, so nothing is lost.
 */
export function AddressField({
  label,
  city,
  onSelect,
  icon,
}: {
  label: string;
  /** The currently chosen city — what the quote is actually priced on. */
  city: City;
  /**
   * `address` and `point` are null when the city came from the emergency
   * picker rather than from a resolved address — which is also what tells the
   * quote form it has no distance to price on.
   */
  onSelect: (next: { city: City; address: string | null; point: Point | null }) => void;
  icon?: (color: string, size: number) => React.ReactNode;
}) {
  const theme = useTheme();

  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');

  /*
   * The debounce, the session token and the three failure modes live in the
   * hook, shared with `AddressLookup`. What is left here is the part that is
   * specific to pricing: turning a place into one of 37 cities, and falling
   * back to the picker when it cannot.
   */
  const { suggestions, searching, unavailable, emptyResult, resolve, reopen } =
    useAddressSuggestions(query);

  /*
   * ⚠ Latched, where the hook's signal is momentary.
   *
   *   The hook reports what the last lookup did. This has to persist: once the
   *   picker is on screen it must stay until the person asks for address
   *   search again, or a single successful keystroke would snatch the control
   *   back mid-selection. It is also set by two things the hook knows nothing
   *   about — a details call that failed, and an address outside the network.
   */
  const [showPicker, setShowPicker] = useState(false);

  /*
   * ⚠ Say why, every time the control changes underneath somebody.
   *
   *   This used to swap in the dropdown and say nothing, so the field a person
   *   was typing into silently became a picker. They could not tell a broken
   *   feature from one that was never switched on from something they had done
   *   wrong — and the most likely reading is the last one, which is both wrong
   *   and discouraging.
   */
  useEffect(() => {
    if (!unavailable) return;
    setShowPicker(true);
    setNote(unavailableReason(unavailable));
  }, [unavailable]);

  /*
   * A working lookup that matched nothing is not a reason to swap the control.
   * "24 Abayomi" with no results usually means one more word is needed, not
   * that the feature is broken.
   */
  useEffect(() => {
    if (emptyResult) setNote('No matches yet — keep typing, or pick a city.');
  }, [emptyResult]);

  const choose = async (suggestion: Suggestion) => {
    setQuery(suggestion.description);
    setNote('');

    const result = await resolve(suggestion);

    if (!result.ok) {
      setShowPicker(true);
      setNote('That address could not be checked. Pick a city instead.');
      return;
    }

    const { resolution, formattedAddress } = result.details;
    setNote(resolutionSummary(resolution));

    if (resolution.kind !== 'served') {
      /*
        An address outside the network is not an error to argue with — the
        picker appears so they can choose somewhere LOCI does reach, and the
        note above says why.
      */
      setShowPicker(true);
      return;
    }

    onSelect({ city: resolution.city, address: formattedAddress, point: result.details.location });
  };

  /* ---------- the fallback, and the way back to it ---------- */
  if (showPicker) {
    return (
      <View style={styles.block}>
        <Dropdown
          label={label}
          options={CITIES}
          searchable
          searchPlaceholder="Search city or state"
          selected={city}
          onSelect={(next) => onSelect({ city: next, address: null, point: null })}
          renderLabel={cityHubLabel}
          compact
          icon={icon}
        />
        {note.length > 0 && <Text style={[styles.note, { color: theme.textMuted }]}>{note}</Text>}
        <Pressable
          onPress={() => {
            setShowPicker(false);
            setNote('');
            setQuery('');
          }}
          accessibilityRole="button"
          hitSlop={6}>
          <Text style={[styles.link, { color: theme.primary }]}>Search by address instead</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.block}>
      <Field
        label={label}
        placeholder="Street, area or city"
        value={query}
        onChangeText={(next) => {
          setQuery(next);
          reopen();
          setNote('');
        }}
        compact
        autoCapitalize="words"
        icon={icon ?? ((color, size) => <Search color={color} size={size} />)}
      />

      {searching && (
        <View style={styles.row}>
          <ActivityIndicator color={theme.primary} size="small" />
          <Text style={[styles.note, { color: theme.textMuted }]}>Looking up addresses…</Text>
        </View>
      )}

      {suggestions.length > 0 && (
        <View style={[styles.list, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion.placeId}
              onPress={() => void choose(suggestion)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}>
              <MapPin color={theme.textMuted} size={14} />
              <View style={styles.suggestionText}>
                <Text style={[styles.main, { color: theme.text }]} numberOfLines={1}>
                  {suggestion.mainText}
                </Text>
                {!!suggestion.secondaryText && (
                  <Text style={[styles.secondary, { color: theme.textMuted }]} numberOfLines={1}>
                    {suggestion.secondaryText}
                  </Text>
                )}
              </View>
            </Pressable>
          ))}
        </View>
      )}

      {/*
        What the price is based on, said plainly.

        Somebody who types a street in Ikeja and sees a Lagos rate needs to see
        why, or the number looks arbitrary.
      */}
      {note.length > 0 && <Text style={[styles.note, { color: theme.textMuted }]}>{note}</Text>}

      {/*
        ⚠ No "pick a city" link here any more.

          The fare is now priced on the measured distance between two
          addresses, so a city chosen from a list has no distance to price on
          and quietly falls back to the old flat band. Offering that as an
          equal option invited people to take the less accurate route for no
          reason. The picker still exists, but only appears when address search
          genuinely cannot answer — see the branch above.
      */}
      {!note && !searching && (
        <Text style={[styles.note, { color: theme.textMuted }]}>
          Start typing to find the exact address.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  list: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two + 2,
  },
  suggestionText: {
    flex: 1,
  },
  main: {
    ...Typography.meta,
    ...font(600),
  },
  secondary: {
    ...Typography.caption,
  },
  note: {
    ...Typography.caption,
    lineHeight: 16,
  },
  link: {
    ...Typography.caption,
    ...font(700),
  },
  pressed: {
    opacity: 0.6,
  },
});
