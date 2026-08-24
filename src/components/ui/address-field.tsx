import { MapPin, Search } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Dropdown } from '@/components/ui/dropdown';
import { Field } from '@/components/ui/field';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { resolutionSummary } from '@/lib/place-to-city';
import {
  fetchPlaceDetails,
  fetchSuggestions,
  newSessionToken,
  unavailableReason,
  type Suggestion,
} from '@/store/places';
import { CITIES, cityHubLabel, type City } from '@/store/bookings';

/** Long enough that a typist does not spend a session per letter. */
const DEBOUNCE_MS = 300;

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
  /** `address` is null when the city was picked from the list rather than typed. */
  onSelect: (next: { city: City; address: string | null }) => void;
  icon?: (color: string, size: number) => React.ReactNode;
}) {
  const theme = useTheme();

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [note, setNote] = useState('');
  const [picking, setPicking] = useState(false);

  /** One token per address chosen, so a lookup is billed once. See `places.ts`. */
  const session = useRef(newSessionToken());

  useEffect(() => {
    const term = query.trim();

    /*
     * Nothing typed, or a suggestion already taken — no request either way.
     * `picking` guards the moment between tapping a suggestion and the details
     * call returning, when the field's text is the address that was just
     * chosen and searching for it again would be pointless and billable.
     */
    if (term.length < 2 || picking) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    setSearching(true);

    const timer = setTimeout(async () => {
      const result = await fetchSuggestions(term, session.current);
      if (cancelled) return;

      setSearching(false);
      setSuggestions(result.suggestions);

      /*
       * ⚠ Say why, every time the control changes underneath somebody.
       *
       *   This used to set `unavailable` and nothing else, so the field a
       *   person was typing into silently became a dropdown. They could not
       *   tell a broken feature from one that was never switched on from
       *   something they had done wrong — and the most likely reading is the
       *   last one, which is both wrong and discouraging.
       */
      if (result.unavailable) {
        setUnavailable(true);
        setNote(unavailableReason(result.unavailable));
        return;
      }

      /*
       * A working lookup that matched nothing is not a reason to swap the
       * control. "24 Abayomi" with no results usually means one more word is
       * needed, not that the feature is broken.
       */
      if (result.suggestions.length === 0) {
        setNote('No matches yet — keep typing, or pick a city.');
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSearching(false);
    };
  }, [query, picking]);

  const choose = async (suggestion: Suggestion) => {
    setPicking(true);
    setQuery(suggestion.description);
    setSuggestions([]);
    setNote('');

    const result = await fetchPlaceDetails(suggestion.placeId, session.current);
    session.current = newSessionToken();
    setPicking(false);

    if (!result.ok) {
      setUnavailable(true);
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
      setUnavailable(true);
      return;
    }

    onSelect({ city: resolution.city, address: formattedAddress });
  };

  /* ---------- the fallback, and the way back to it ---------- */
  if (unavailable) {
    return (
      <View style={styles.block}>
        <Dropdown
          label={label}
          options={CITIES}
          searchable
          searchPlaceholder="Search city or state"
          selected={city}
          onSelect={(next) => onSelect({ city: next, address: null })}
          renderLabel={cityHubLabel}
          compact
          icon={icon}
        />
        {note.length > 0 && <Text style={[styles.note, { color: theme.textMuted }]}>{note}</Text>}
        <Pressable
          onPress={() => {
            setUnavailable(false);
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
          setPicking(false);
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

      {!note && !searching && (
        <Text style={[styles.note, { color: theme.textMuted }]}>
          Priced as {city}.{' '}
          <Text
            style={[styles.link, { color: theme.primary }]}
            onPress={() => setUnavailable(true)}>
            Pick a city
          </Text>
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
