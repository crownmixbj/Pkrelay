import { useRouter } from 'expo-router';
import { Banknote, PackageCheck, Truck, Wallet } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, SectionLabel } from '@/components/ui/screen';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatNaira } from '@/store/bookings';
import { deliveredLabel, type EarningsEntry, type EarningsSummary } from '@/store/earnings';

/**
 * The history behind the Expected figure on the driver's summary card.
 *
 * ⚠ Two sections, because one would not add up.
 *
 *   The card's headline sums every parcel this driver holds — delivered and
 *   still moving. A history listing only completed parcels would therefore show
 *   a total smaller than the number that was tapped, with nothing on screen
 *   explaining the gap. A driver checking their money against a figure that
 *   does not reconcile assumes they are being short-changed, and they would be
 *   right to.
 *
 *   So delivered work comes first and is the point of the screen, and what is
 *   still in progress sits below it accounting for the rest.
 *
 * ⚠ No `ScrollView` here. `BottomSheet` already scrolls its children, and
 *   nesting two vertical scroll containers collapses the inner one to nothing
 *   on react-native-web — which is how the admin drawer and the sender photo
 *   sheet both shipped opening empty.
 */
export function EarningsSheet({
  visible,
  onClose,
  summary,
}: {
  visible: boolean;
  onClose: () => void;
  summary: EarningsSummary;
}) {
  const theme = useTheme();
  const router = useRouter();
  const { delivered, inProgress } = summary;

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={[styles.title, { color: theme.text }]}>Expected earnings</Text>

      {/*
        The caveat leads, rather than sitting in small print at the bottom.

        Every figure below is the fare quoted to the *sender*, gross, on parcels
        held and delivered. The Wallet is net of commission, credits only on
        delivery, and holds new money for a day — so it will show less, often a
        lot less, and a driver who scrolls a list of naira amounts without
        reading to the end will take this total for their balance.

        Naming the wallet is the load-bearing half. "These are quotes" explains
        what this is not; it does not tell anybody where the real number lives.
      */}
      <Text style={[styles.caveat, { color: theme.textMuted }]}>
        Quoted fares on your parcels, before Package Relay&apos;s commission. Your actual balance — what you
        can withdraw — is in Driver Wallet, and it will be lower.
      </Text>

      <Card style={styles.totals}>
        <View style={styles.totalRow}>
          <View style={styles.totalHead}>
            <PackageCheck color={theme.success} size={15} />
            <Text style={[styles.totalLabel, { color: theme.textSecondary }]}>
              Delivered ({delivered.count})
            </Text>
          </View>
          <Text style={[styles.totalValue, { color: theme.text }]}>
            {formatNaira(delivered.total)}
          </Text>
        </View>

        <View style={styles.totalRow}>
          <View style={styles.totalHead}>
            <Truck color={theme.textMuted} size={15} />
            <Text style={[styles.totalLabel, { color: theme.textSecondary }]}>
              Still carrying ({inProgress.count})
            </Text>
          </View>
          <Text style={[styles.totalValue, { color: theme.textSecondary }]}>
            {formatNaira(inProgress.total)}
          </Text>
        </View>

        <View style={[styles.rule, { backgroundColor: theme.border }]} />

        <View style={styles.totalRow}>
          <View style={styles.totalHead}>
            <Banknote color={theme.primary} size={15} />
            <Text style={[styles.totalLabel, { color: theme.text, ...font(700) }]}>Expected</Text>
          </View>
          <Text style={[styles.grandValue, { color: theme.primary }]}>
            {formatNaira(summary.total)}
          </Text>
        </View>
      </Card>

      {/*
        The way to the real number, right under the one that is not it.

        A caveat pointing at a screen the driver then has to go and find is a
        caveat most people will not act on — and the whole risk here is somebody
        taking the total above at face value.
      */}
      <Button
        label="Open Driver Wallet"
        variant="secondary"
        size="md"
        icon={(color, size) => <Wallet color={color} size={size} />}
        onPress={() => {
          onClose();
          router.navigate('/driver-wallet');
        }}
      />

      <SectionLabel>Delivered</SectionLabel>
      {delivered.entries.length === 0 ? (
        <EmptyState
          icon={(color, size) => <PackageCheck color={color} size={size} />}
          title="Nothing delivered yet"
          message="Completed parcels appear here with what each one was quoted at and when it landed."
        />
      ) : (
        <View style={styles.list}>
          {delivered.entries.map((entry) => (
            <EntryRow key={entry.bookingId} entry={entry} />
          ))}
        </View>
      )}

      {inProgress.entries.length > 0 && (
        <>
          <SectionLabel>Still carrying</SectionLabel>
          <Text style={[styles.sectionNote, { color: theme.textMuted }]}>
            Counted in the Expected total above. Not delivered, so not yet earned.
          </Text>
          <View style={styles.list}>
            {inProgress.entries.map((entry) => (
              <EntryRow key={entry.bookingId} entry={entry} />
            ))}
          </View>
        </>
      )}
    </BottomSheet>
  );
}

function EntryRow({ entry }: { entry: EarningsEntry }) {
  const theme = useTheme();

  return (
    <View style={[styles.entry, { borderColor: theme.border }]}>
      <View style={styles.entryText}>
        <Text style={[styles.entryId, { color: theme.textMuted }]}>#{entry.trackingId}</Text>
        <Text style={[styles.entryItem, { color: theme.text }]} numberOfLines={1}>
          {entry.itemDescription}
        </Text>
        <Text style={[styles.entryRoute, { color: theme.textSecondary }]} numberOfLines={1}>
          {entry.route}
        </Text>
        <Text style={[styles.entryWhen, { color: theme.textMuted }]}>
          {entry.stage ? entry.stage : deliveredLabel(entry.deliveredAt)}
        </Text>
      </View>
      <Text style={[styles.entryFee, { color: theme.text }]}>{formatNaira(entry.fee)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { ...Typography.sectionTitle },
  caveat: { ...Typography.caption, lineHeight: 18 },
  totals: { gap: Spacing.two },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  totalHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one, flex: 1 },
  totalLabel: { ...Typography.meta },
  totalValue: { ...Typography.meta, ...font(600) },
  grandValue: { ...Typography.cardTitle },
  rule: { height: StyleSheet.hairlineWidth },
  sectionNote: { ...Typography.caption },
  list: { gap: Spacing.two },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  entryText: { flex: 1, gap: 2 },
  entryId: { ...Typography.caption },
  entryItem: { ...Typography.meta, ...font(600) },
  entryRoute: { ...Typography.caption },
  entryWhen: { ...Typography.caption },
  entryFee: { ...Typography.meta, ...font(700) },
});
