import { ArrowRight, Building2, Calculator, Navigation, Weight } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AddressField } from '@/components/ui/address-field';
import { Field } from '@/components/ui/field';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { DEFAULT_CITY, estimateFee, formatNaira, type City } from '@/store/bookings';

export type QuickQuoteProps = {
  /** Hands the chosen route and weight to the booking form. */
  onBook: (params: Record<string, string>) => void;
};

/**
 * Instant estimate without starting a booking. Delivery type is inferred from
 * the two cities — same city is local, different is inter-state — so there's no
 * third control for the user to get wrong.
 */
export function QuickQuote({ onBook }: QuickQuoteProps) {
  const theme = useTheme();

  const [origin, setOrigin] = useState<City>(DEFAULT_CITY);
  const [destination, setDestination] = useState<City>('Lagos');
  const [weight, setWeight] = useState('2');

  /*
   * The addresses behind the two cities, when they were typed rather than
   * picked.
   *
   * ⚠ Not used in the estimate, and that is not an oversight.
   *
   *   `estimateFee` prices by band — same city or not — with no distance term,
   *   so a street address cannot make this number more accurate. What it does
   *   is travel to the booking form, where it becomes an address a driver can
   *   actually find, instead of a city and an area.
   */
  const [originAddress, setOriginAddress] = useState<string | null>(null);
  const [destinationAddress, setDestinationAddress] = useState<string | null>(null);

  const deliveryType = origin === destination ? 'local' : 'interstate';
  const parsedWeight = Number(weight);
  const hasWeight = Number.isFinite(parsedWeight) && parsedWeight > 0;

  const fee = useMemo(
    () =>
      estimateFee({
        deliveryType,
        weight: parsedWeight,
        declaredValue: 0,
      }),
    [deliveryType, parsedWeight],
  );

  return (
    <View
      style={[
        styles.card,
        // Nearly opaque: at 0.8 the canvas showed through enough to soften the
        // new shadow and blur the card's edge against the hero above it.
        {
          backgroundColor: 'rgba(255,255,255,0.94)',
          borderColor: theme.primary,
          shadowColor: theme.shadow,
        },
      ]}>
      <View style={styles.header}>
        <View style={[styles.iconBubble, { backgroundColor: theme.primarySoft }]}>
          <Calculator color={theme.primaryOnSoft} size={15} />
        </View>
        <Text style={[styles.title, { color: theme.text }]}>Get a Quick Quote</Text>
        <Badge
          label={deliveryType === 'local' ? 'Local' : 'Inter-State'}
          tone={deliveryType === 'local' ? 'success' : 'primary'}
        />
      </View>

      <View style={styles.controls}>
        <View style={styles.control}>
          <AddressField
            label="Collect from"
            city={origin}
            onSelect={({ city, address }) => {
              setOrigin(city);
              setOriginAddress(address);
            }}
            icon={(color, size) => <Building2 color={color} size={size} />}
          />
        </View>
        <View style={styles.control}>
          <AddressField
            label="Deliver to"
            city={destination}
            onSelect={({ city, address }) => {
              setDestination(city);
              setDestinationAddress(address);
            }}
            icon={(color, size) => <Navigation color={color} size={size} />}
          />
        </View>
        <View style={styles.control}>
          <Field
            label="Weight (kg)"
            icon={(color, size) => <Weight color={color} size={size} />}
            placeholder="2"
            value={weight}
            onChangeText={setWeight}
            compact
            keyboardType="decimal-pad"
            error={weight.trim() && !hasWeight ? 'Enter a number above 0' : undefined}
          />
        </View>
      </View>

      <View style={[styles.result, { backgroundColor: theme.surfaceMuted }]}>
        <Text style={[styles.resultRoute, { color: theme.textSecondary }]} numberOfLines={1}>
          {origin} → {destination} · {hasWeight ? `${parsedWeight} kg` : '—'}
        </Text>
        <Text style={[styles.price, { color: theme.primary }]}>
          {hasWeight ? `Est. ${formatNaira(fee.total)}` : '—'}
        </Text>
      </View>

      <Button
        label="Book this delivery"
        size="md"
        style={styles.cta}
        icon={(color, size) => <ArrowRight color={color} size={size} />}
        onPress={() =>
          onBook({
            deliveryType,
            originCity: origin,
            destinationCity: destination,
            weight: hasWeight ? String(parsedWeight) : '',
            /*
              Carried through only when an address was actually typed. The
              booking form treats an empty string as "nothing chosen", so
              sending one for a city picked from the list would look like a
              door address the sender never gave.
            */
            ...(originAddress ? { pickupAddress: originAddress } : {}),
            ...(destinationAddress ? { dropoffAddress: destinationAddress } : {}),
          })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Lifted harder than any other card on the home screen. This is the primary
   * transactional tool and it lands directly under the hero's own frosted
   * cards, so at the old 0.05/3/1 it read as a continuation of the banner
   * rather than the thing to use. The service tiles below sit at 0.16/10/4;
   * this deliberately sits above them.
   */
  card: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    paddingHorizontal: Spacing.three + 2,
    paddingVertical: Spacing.three,
    gap: Spacing.three - 4,
    ...Platform.select({ android: { elevation: 8 }, default: {} }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
  },
  iconBubble: {
    width: 30,
    height: 30,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    ...Typography.body,
    ...font(700),
  },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three - 4,
  },
  control: {
    flexGrow: 1,
    flexBasis: 150,
    minWidth: 130,
  },
  /** Trimmed from the shared 44px so the card stays compact. */
  cta: {
    height: 38,
  },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two + 2,
    paddingHorizontal: Spacing.three - 4,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
  },
  resultRoute: {
    flex: 1,
    ...Typography.meta,
    ...font(600),
  },
  price: {
    ...Typography.cardTitle,
    ...font(700),
  },
});
