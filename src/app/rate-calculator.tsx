import { useRouter } from 'expo-router';
import {
  Banknote,
  Calculator,
  PackagePlus,
  Receipt,
  ShieldAlert,
  Weight,
  X,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Footer } from '@/components/Footer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/chip';
import { ToggleRow } from '@/components/ui/dropdown';
import { Field } from '@/components/ui/field';
import { SectionLabel } from '@/components/ui/screen';
import { FontSize, MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useGoBack } from '@/hooks/use-go-back';
import { useTheme } from '@/hooks/use-theme';
import {
  DELIVERY_TYPES,
  estimateFee,
  formatAmountInput,
  formatNaira,
  parseAmountInput,
  PRICING,
  type DeliveryType,
} from '@/store/bookings';

const DELIVERY_TYPE_TITLES: Record<DeliveryType, string> = {
  local: 'Local',
  interstate: 'Inter-State',
};

export default function RateCalculatorScreen() {
  const theme = useTheme();
  const router = useRouter();
  const goBack = useGoBack();

  const [deliveryType, setDeliveryType] = useState<DeliveryType>('local');
  const [weight, setWeight] = useState('');
  const [declaredValue, setDeclaredValue] = useState('');
  const [fragile, setFragile] = useState(false);

  const fee = useMemo(
    () =>
      estimateFee({
        deliveryType,
        weight: Number(weight),
        declaredValue: parseAmountInput(declaredValue),
      }),
    [deliveryType, weight, declaredValue],
  );

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <View style={styles.titleRow}>
                <Calculator color={theme.primary} size={22} />
                <Text style={[styles.title, { color: theme.text }]}>Rate Calculator</Text>
              </View>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                Estimate a fee without starting a booking.
              </Text>
            </View>
            <Pressable
              onPress={goBack}
              hitSlop={10}
              accessibilityLabel="Close"
              style={[styles.close, { backgroundColor: theme.surfaceMuted }]}>
              <X color={theme.textSecondary} size={18} />
            </Pressable>
          </View>

          <View>
            <SectionLabel>Delivery type</SectionLabel>
            <SegmentedControl
              options={DELIVERY_TYPES}
              selected={deliveryType}
              onSelect={setDeliveryType}
              renderLabel={(type) => DELIVERY_TYPE_TITLES[type]}
            />
          </View>

          <Card style={styles.card}>
            <View style={styles.row}>
              <View style={styles.rowItem}>
                <Field
                  label="Weight (kg)"
                  icon={(color, size) => <Weight color={color} size={size} />}
                  placeholder="2.5"
                  value={weight}
                  onChangeText={setWeight}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={styles.rowItem}>
                <Field
                  label="Declared value (₦)"
                  icon={(color, size) => <Banknote color={color} size={size} />}
                  placeholder="45,000"
                  value={declaredValue}
                  onChangeText={(text) => setDeclaredValue(formatAmountInput(text))}
                  keyboardType="number-pad"
                />
              </View>
            </View>

            <ToggleRow
              label="Fragile / Handle with care"
              description="Flags the job for drivers to ensure careful handling at no extra cost"
              value={fragile}
              onValueChange={setFragile}
              icon={(color, size) => <ShieldAlert color={color} size={size} />}
            />
          </Card>

          <Card style={[styles.card, styles.summaryCard, { borderColor: theme.primary }]}>
            <View style={styles.summaryHeader}>
              <View style={styles.titleRow}>
                <Receipt color={theme.primary} size={18} />
                <Text style={[styles.summaryTitle, { color: theme.text }]}>Estimate</Text>
              </View>
              <Badge
                label={DELIVERY_TYPE_TITLES[deliveryType]}
                tone={deliveryType === 'local' ? 'success' : 'primary'}
              />
            </View>

            <View style={[styles.divider, { backgroundColor: theme.border }]} />

            <CostRow label="Base fare" value={fee.base} />
            <CostRow
              label={`Weight · ${weight.trim() || 0} kg × ${formatNaira(PRICING.perKg[deliveryType])}`}
              value={fee.weight}
            />
            <CostRow label="Insurance · 1% of declared value" value={fee.insurance} />

            <View style={[styles.divider, { backgroundColor: theme.border }]} />

            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: theme.text }]}>Estimated total</Text>
              <Text style={[styles.totalValue, { color: theme.primary }]}>
                {formatNaira(fee.total)}
              </Text>
            </View>
            <Text style={[styles.disclaimer, { color: theme.textMuted }]}>
              Estimate only. Final fare is confirmed when a driver accepts.
            </Text>
          </Card>

          <Button
            label="Send a Parcel"
            icon={(color, size) => <PackagePlus color={color} size={size} />}
            /*
             * ⚠ One navigation, not a back followed by a navigate.
             *
             *   This read `router.back(); router.navigate('/book')` — pop the
             *   calculator, then open the form — which is what `replace` does in
             *   a single action. The two-step version also raised an unhandled
             *   GO_BACK on a direct load of this page, where there is nothing to
             *   pop, before navigating anyway.
             */
            onPress={() => router.replace('/book')}
          />
        </View>
        <Footer />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function CostRow({ label, value }: { label: string; value: number }) {
  const theme = useTheme();
  return (
    <View style={styles.costRow}>
      <Text style={[styles.costLabel, { color: theme.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.costValue, { color: theme.text }]}>{formatNaira(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    alignItems: 'center',
    padding: Spacing.four,
    paddingTop: Spacing.five,
    paddingBottom: Spacing.six,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
    marginBottom: Spacing.one,
  },
  headerText: {
    flex: 1,
    gap: Spacing.one,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  title: {
    ...Typography.screenTitle,
    fontSize: FontSize.title,
  },
  subtitle: {
    ...Typography.screenSubtitle,
  },
  close: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    gap: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.three - 4,
  },
  rowItem: {
    flex: 1,
  },
  pickerField: {
    gap: Spacing.two - 2,
  },
  pickerLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  pickerLabel: {
    ...Typography.label,
  },
  summaryCard: {
    borderWidth: 1,
    gap: Spacing.two,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  summaryTitle: {
    ...Typography.sectionTitle,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Spacing.one,
  },
  costRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  costLabel: {
    ...Typography.meta,
    flexShrink: 1,
  },
  costValue: {
    ...Typography.meta,
    ...font(600),
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  totalLabel: {
    ...Typography.sectionTitle,
  },
  totalValue: {
    fontSize: FontSize.heading,
    ...font(700),
  },
  disclaimer: {
    ...Typography.meta,
  },
});
