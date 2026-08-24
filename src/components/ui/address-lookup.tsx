import { MapPin, Search } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Field } from '@/components/ui/field';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useAddressSuggestions } from '@/hooks/use-address-suggestions';
import { useTheme } from '@/hooks/use-theme';
import type { Point } from '@/lib/distance';
import type { Suggestion } from '@/store/places';

export type ResolvedAddress = {
  /** Exactly what will be shown to whoever has to find the place. */
  address: string;
  /** Present only when the text came from a suggestion. */
  point: Point | null;
};

/**
 * An address field for everywhere that wants an address.
 *
 * ⚠ Not `AddressField`, and the difference is what each one returns.
 *
 *   `AddressField` resolves what you type down to one of 37 LOCI cities,
 *   because the quote is priced per city band. That is wrong for a driver's
 *   home address, a guarantor's, or a hub's: those are read by a human being
 *   who has to arrive at the door, and reducing "14 Bode Thomas, Surulere" to
 *   "Lagos" destroys the only part that matters.
 *
 * ⚠ Typing freely always works, whatever Google is doing.
 *
 *   The suggestions are an accelerator, never a gate. If lookup is not
 *   deployed, is out of quota or cannot be reached, this stays an ordinary
 *   text field and the form submits exactly as it did before autocomplete
 *   existed. Nigerian addresses are also routinely absent from Google —
 *   informal settlements, new estates, "behind the second gate" — and a field
 *   that refused anything Google had not heard of would be unusable for a real
 *   fraction of the country.
 */
export function AddressLookup({
  label,
  value,
  onChange,
  placeholder,
  error,
  icon,
  multiline,
  hint,
  onBlur,
}: {
  label: string;
  value: string;
  /**
   * ⚠ One callback for both typing and choosing, so the coordinate can never
   *   outlive the text it belongs to.
   *
   *   With separate `onChangeText`/`onSelect` handlers a caller could keep the
   *   point from a chosen suggestion after the address had been edited by
   *   hand, and dispatch a driver to a place the sender did not ask for. Here,
   *   editing the text unavoidably clears the point.
   */
  onChange: (next: ResolvedAddress) => void;
  placeholder?: string;
  error?: string;
  icon?: (color: string, size: number) => React.ReactNode;
  multiline?: boolean;
  hint?: string;
  /**
   * ⚠ Safe here only because it validates and nothing more.
   *
   *   A blur handler that hid the suggestion list would race the tap that
   *   chose from it — on web the blur lands first and the list is gone before
   *   the press registers. Visibility is driven by the suggestions themselves,
   *   so this can stay a plain pass-through.
   */
  onBlur?: () => void;
}) {
  const theme = useTheme();
  const { suggestions, searching, unavailable, emptyResult, resolve, reopen } =
    useAddressSuggestions(value);
  const [resolving, setResolving] = useState(false);

  const choose = async (suggestion: Suggestion) => {
    setResolving(true);
    /*
     * The description goes in immediately so the field never looks unresponsive
     * while the details call is in flight. It is replaced by the formatted
     * address a moment later, which is usually tidier.
     */
    onChange({ address: suggestion.description, point: null });

    const result = await resolve(suggestion);
    setResolving(false);

    if (!result.ok) {
      /*
       * The text they chose is already in the field and is perfectly usable as
       * an address. Losing the coordinate costs a distance estimate, not the
       * form — so this says nothing and moves on.
       */
      return;
    }

    onChange({
      address: result.details.formattedAddress || suggestion.description,
      point: result.details.location,
    });
  };

  return (
    <View style={styles.block}>
      <Field
        label={label}
        placeholder={placeholder ?? 'Street, area or landmark'}
        value={value}
        onChangeText={(text) => {
          reopen();
          onChange({ address: text, point: null });
        }}
        onBlur={onBlur}
        error={error}
        multiline={multiline}
        autoCapitalize="words"
        icon={icon ?? ((color, size) => <Search color={color} size={size} />)}
      />

      {(searching || resolving) && (
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
        ⚠ Every one of these says the typed address is fine as it stands.

          This field is used for places a driver must physically reach, and
          plenty of real Nigerian addresses are not in Google. Wording that
          implied the address was not accepted until it matched a suggestion
          would push people into picking a nearby street that is not theirs.
      */}
      {!searching && !resolving && suggestions.length === 0 && (
        <Text style={[styles.note, { color: theme.textMuted }]}>
          {unavailable
            ? 'Address search is unavailable — type the address in full.'
            : emptyResult
              ? 'No matches — type the address in full, that works too.'
              : (hint ?? 'Start typing to search, or write the address out in full.')}
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
  pressed: {
    opacity: 0.6,
  },
});
