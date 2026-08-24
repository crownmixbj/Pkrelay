import { ArrowRight, Building2, Calculator, Navigation, Weight } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { distanceLabel, type Distance, type Point } from '@/lib/distance';
import { measureDistance } from '@/store/places';
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

  const [originPoint, setOriginPoint] = useState<Point | null>(null);
  const [destinationPoint, setDestinationPoint] = useState<Point | null>(null);

  /*
   * The distance the fare is priced on.
   *
   * ⚠ Null until both ends are known, and null is not zero.
   *
   *   `estimateFee` charges nothing for an unknown distance, which is what
   *   keeps a city picked from the emergency fallback on exactly the fare it
   *   had before distance pricing existed. Defaulting it to 0 would look the
   *   same and mean something different — a measured journey of no length.
   */
  const [distance, setDistance] = useState<Distance | null>(null);
  const [measuring, setMeasuring] = useState(false);

  useEffect(() => {
    if (!originPoint || !destinationPoint) {
      setDistance(null);
      return;
    }

    let cancelled = false;
    setMeasuring(true);

    void measureDistance(originPoint, destinationPoint).then((result) => {
      if (cancelled) return;
      setDistance(result);
      setMeasuring(false);
    });

    return () => {
      cancelled = true;
    };
  }, [originPoint, destinationPoint]);

  const deliveryType = origin === destination ? 'local' : 'interstate';
  const parsedWeight = Number(weight);
  const hasWeight = Number.isFinite(parsedWeight) && parsedWeight > 0;

  const fee = useMemo(
    () =>
      estimateFee({
        deliveryType,
        weight: parsedWeight,
        /*
         * ⚠ Zero here, and the booking form will add to it.
         *
         *   Declaring a value is now required to post a parcel, and insurance
         *   is 1% of it. This form asks three questions and adding a fourth
         *   would defeat the point, so the quote is quoted without cover — and
         *   is therefore always a little *under* what the booking will charge.
         *
         *   A quote that is quietly low is the kind of thing people notice at
         *   the moment they are asked to pay, so the line below says so rather
         *   than leaving them to find it.
         */
        declaredValue: 0,
        distanceKm: distance?.km,
      }),
    [deliveryType, parsedWeight, distance?.km],
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
            onSelect={({ city, address, point }) => {
              setOrigin(city);
              setOriginAddress(address);
              setOriginPoint(point);
            }}
            icon={(color, size) => <Building2 color={color} size={size} />}
          />
        </View>
        <View style={styles.control}>
          <AddressField
            label="Deliver to"
            city={destination}
            onSelect={({ city, address, point }) => {
              setDestination(city);
              setDestinationAddress(address);
              setDestinationPoint(point);
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
        {/*
          The distance is named on the line the price is on.

          A fare that moves with the journey has to say what journey it thinks
          it is pricing, or a customer comparing two quotes has no way to see
          why they differ. "about" appears when the distance was estimated
          rather than measured — see `distanceLabel`.
        */}
        <Text style={[styles.resultRoute, { color: theme.textSecondary }]} numberOfLines={1}>
          {origin} → {destination} · {hasWeight ? `${parsedWeight} kg` : '—'}
          {measuring ? ' · measuring…' : distance ? ` · ${distanceLabel(distance)}` : ''}
        </Text>
        <Text style={[styles.price, { color: theme.primary }]}>
          {hasWeight ? `Est. ${formatNaira(fee.total)}` : '—'}
        </Text>
      </View>

      {/*
        Says where the quote is knowingly short, rather than letting somebody
        discover it at the point of paying.
      */}
      {hasWeight && (
        <Text style={[styles.footnote, { color: theme.textMuted }]}>
          Before insurance — 1% of the value you declare when booking.
        </Text>
      )}

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
  footnote: {
    ...Typography.caption,
    marginTop: Spacing.one,
  },
  price: {
    ...Typography.cardTitle,
    ...font(700),
  },
});
