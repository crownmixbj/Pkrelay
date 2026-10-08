import { LinearGradient } from 'expo-linear-gradient';
import { MapPin, Truck, UserRound } from 'lucide-react-native';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Marquee, PulsingDot } from '@/components/ui/marquee';
import { FontSize, PageMeasure, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { ActiveMovement } from '@/store/bookings';
import type { SessionRole } from '@/store/session';

export type TopStatusBarProps = {
  movements: ActiveMovement[];
  /** Drives the wording: senders read who it's going to, drivers who to deliver to. */
  role: SessionRole;
  /** Opens the active parcel / tracking detail. */
  onPressTicker: () => void;
};

/**
 * A single live ticker. The promo and the app CTA used to share this pill;
 * both are gone — 'Get the App' now lives in the header menu, so the bar
 * carries one message instead of three competing ones.
 */
export function TopStatusBar({ movements, role, onPressTicker }: TopStatusBarProps) {
  const theme = useTheme();

  /*
   * ⚠ Nothing at all when nothing is moving, where this used to say so.
   *
   *   The idle state was a 44px bar running the full width of the window
   *   reading "No parcels moving right now" — directly under the navigation and
   *   above the hero, so it was the first sentence on the page and the first
   *   thing a visitor who had never sent a parcel was told. A marketing page
   *   does not open on an empty state, and a signed-out visitor has no parcels
   *   by definition, so for them it could never say anything else.
   *
   *   The bar still appears the moment there is something live to say, which is
   *   the only time it was ever carrying information.
   */
  if (movements.length === 0) return null;

  return (
    <View style={styles.band}>
      <View style={styles.wrapper}>
        <LinearGradient
          colors={[theme.primarySoft, theme.surface]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.bar, { borderColor: theme.border }]}>
          <Pressable
            onPress={onPressTicker}
            accessibilityRole="button"
            accessibilityLabel={`Live deliveries. ${movements
              .map((m) => movementLabel(m, role))
              .join('. ')}. Tap for details`}
            style={({ pressed }) => [styles.tickerArea, pressed && styles.pressed]}>
            <View style={styles.liveBadge}>
              <PulsingDot color={theme.primary} />
              <Text style={[styles.liveText, { color: theme.primary }]}>LIVE</Text>
            </View>

            <Marquee>
              <TickerContent movements={movements} role={role} />
            </Marquee>
          </Pressable>
        </LinearGradient>
      </View>
    </View>
  );
}

/** Plain-text version of a ticker item, reused for the accessibility label. */
function movementLabel(movement: ActiveMovement, role: SessionRole): string {
  if (role === 'driver') {
    return `Delivering to: ${movement.recipientName}`;
  }

  // A parcel nobody has claimed yet has no driver to name.
  const carrier = movement.driverName
    ? `Delivering by: ${movement.driverName}`
    : 'Awaiting a driver';

  return `On the way to: ${movement.recipientName} · ${carrier}`;
}

function TickerContent({ movements, role }: { movements: ActiveMovement[]; role: SessionRole }) {
  const theme = useTheme();

  return (
    <>
      {movements.map((movement, index) => (
        <View key={`${movement.id}-${index}`} style={styles.item}>
          {index > 0 && <PulsingDot color={theme.primary} style={styles.divider} />}

          {role === 'driver' ? (
            <>
              <MapPin color={theme.primary} size={12} />
              <Text style={[styles.itemText, { color: theme.textSecondary }]} numberOfLines={1}>
                {'Delivering to: '}
                <Text style={[styles.itemDestination, { color: theme.text }]}>
                  {movement.recipientName}
                </Text>
              </Text>
            </>
          ) : (
            <>
              <Truck color={theme.success} size={12} />
              <Text style={[styles.itemText, { color: theme.textSecondary }]} numberOfLines={1}>
                {'On the way to: '}
                <Text style={[styles.itemDestination, { color: theme.text }]}>
                  {movement.recipientName}
                </Text>
              </Text>

              <UserRound color={theme.primary} size={12} style={styles.carrierIcon} />
              <Text style={[styles.itemText, { color: theme.textSecondary }]} numberOfLines={1}>
                {movement.driverName ? (
                  <>
                    {'Delivering by: '}
                    <Text style={[styles.itemDestination, { color: theme.text }]}>
                      {movement.driverName}
                    </Text>
                  </>
                ) : (
                  'Awaiting a driver'
                )}
              </Text>
            </>
          )}
        </View>
      ))}
      {/* Trailing divider so the seam between copies matches internal spacing. */}
      <PulsingDot color={theme.primary} style={styles.divider} />
    </>
  );
}

const styles = StyleSheet.create({
  /**
   * The measure, the gutter and the gap to the navbar above.
   *
   * Owned here rather than by `StickyHeader`, which is where it used to live:
   * this component renders nothing at all when no parcel is moving, and a
   * parent's `marginTop` would hold a band open above a component that is not
   * there. Shaped exactly like the nav capsule's wrapper — cap, centre, then
   * gutter as padding — so the pill's edge and the capsule's edge land on the
   * same pixel at every width.
   *
   * `zIndex: 1` keeps it explicitly *below* the navbar: the two are siblings,
   * so without it they stack in document order and the ticker — being second —
   * covers any open nav dropdown.
   */
  band: {
    width: '100%',
    maxWidth: PageMeasure,
    alignSelf: 'center',
    paddingHorizontal: Spacing.four,
    marginTop: Spacing.two,
    zIndex: 1,
  },
  wrapper: {
    borderRadius: Radius.pill,
    ...Platform.select({
      ios: {
        shadowColor: '#0F172A',
        shadowOpacity: 0.05,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 1 },
      },
      android: { elevation: 1 },
      default: {},
    }),
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    height: 44,
    paddingHorizontal: Spacing.three - 2,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.7,
  },
  tickerArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    overflow: 'hidden',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    flexShrink: 0,
  },
  liveText: {
    fontSize: FontSize.micro,
    ...font(800),
    letterSpacing: 0.6,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  itemText: {
    ...Typography.meta,
  },
  itemDestination: {
    ...font(700),
  },
  divider: {
    marginHorizontal: Spacing.two + 2,
  },
  /** Separates the recipient clause from the driver clause. */
  carrierIcon: {
    marginLeft: Spacing.two,
  },
});
