import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Clock,
  MapPin,
  Info,
  MapPinned,
  Navigation,
  PackagePlus,
  Phone,
  Store,
  TriangleAlert,
} from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { showDialog } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipGroup } from '@/components/ui/chip';
import { MapView, type MapMarker } from '@/components/ui/map-view';
import { EmptyState, screenPadding, ScreenHeader, SectionLabel } from '@/components/ui/screen';
import { openLabel, openState } from '@/constants/hub-hours';
import {
  HUB_SECTIONS,
  HUB_SECTION_SHORT,
  citiesWithHubs,
  hasApproximatePositions,
  hubPosition,
  hubsForCity,
  parseHubSection,
  type Hub,
  type HubSection,
} from '@/constants/hubs';
import { MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { CITIES, cityHubLabel, DEFAULT_CITY, type City } from '@/store/bookings';
import { useHubs } from '@/store/hubs';

/** Pretty-print a stored E.164-ish number: +234 803 000 1101 */
function formatPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  const match = digits.match(/^(\+\d{3})(\d{3})(\d{3})(\d{4})$/);
  return match ? `${match[1]} ${match[2]} ${match[3]} ${match[4]}` : phone;
}

/**
 * Opens the address in whichever map app the person uses. A search query, not
 * coordinates — we don't hold per-hub lat/lon, and a query on a full street
 * address resolves reliably on all three platforms.
 */
function openDirections(hub: Hub) {
  const query = encodeURIComponent(`${hub.name}, ${hub.address}`);
  const url = Platform.select({
    ios: `http://maps.apple.com/?q=${query}`,
    android: `geo:0,0?q=${query}`,
    default: `https://www.google.com/maps/search/?api=1&query=${query}`,
  });
  Linking.openURL(url).catch(() =>
    showDialog('Could not open maps', 'No map application is available on this device.'),
  );
}

/**
 * What the Flagship badge actually means, stated from the data rather than
 * invented: every flagship carries three services including packaging, while
 * the other hubs carry one or two.
 */
const FLAGSHIP_NOTE =
  'Flagship hubs carry the full service list, including packaging. Smaller counters handle drop-off and collection only.';

const SECTION_SUBTITLES: Record<HubSection, string> = {
  locations: 'Drop a parcel off yourself, or have it held for collection.',
  map: 'Where every counter sits, so you can pick the one on your way.',
  hours: "When each hub opens, and what's open right now.",
};

export default function LocationsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ section?: string }>();

  const [city, setCity] = useState<City>(DEFAULT_CITY);
  const [section, setSection] = useState<HubSection>(() => parseHubSection(params.section));

  /*
   * The URL leads. Tapping "Sorting Centers Map" in the nav while already on
   * this screen changes the query string without remounting, so without this
   * the submenu would appear to do nothing.
   */
  useEffect(() => setSection(parseHubSection(params.section)), [params.section]);

  // Live from the database, falling back to the seed — see `store/hubs.tsx`.
  const { hubs: allHubs } = useHubs();

  const cities = useMemo(() => citiesWithHubs(allHubs, CITIES), [allHubs]);
  const hubs = useMemo(() => hubsForCity(allHubs, city), [allHubs, city]);

  /** Keeps the address bar honest when the section is changed on screen. */
  const chooseSection = (next: HubSection) => {
    setSection(next);
    router.setParams({ section: next });
  };

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        <ScreenHeader
          brand={false}
          title="Partner Hub Locations"
          subtitle={SECTION_SUBTITLES[section]}
        />

        <View style={styles.sectionTabs}>
          <ChipGroup
            options={HUB_SECTIONS as unknown as string[]}
            selected={section}
            onSelect={(value) => chooseSection(value as HubSection)}
            /*
              Short labels here, full names in the nav submenu. "Drop-off /
              Pickup Locations" is 26 characters — three of those side by side
              would wrap to three lines on a phone. The screen title and
              subtitle already carry the longer meaning.
            */
            renderLabel={(value) => HUB_SECTION_SHORT[value as HubSection]}
            scrollable
          />
        </View>

        <View style={[styles.filterBlock, { borderBottomColor: theme.border }]}>
          <SectionLabel>Select a city</SectionLabel>
          <ChipGroup
            options={cities}
            selected={city}
            onSelect={setCity}
            renderLabel={(c) => `${c} (${allHubs.filter((h) => h.city === c).length})`}
            scrollable
          />
        </View>

        <Text style={[styles.cityLine, { color: theme.textMuted }]}>
          {cityHubLabel(city)} · {hubs.length} {hubs.length === 1 ? 'hub' : 'hubs'}
        </Text>

        {hubs.length === 0 ? (
          <EmptyState
            icon={(color, size) => <MapPinned color={color} size={size} />}
            title="No hubs yet"
            message={`We haven't opened a partner hub in ${city}. Doorstep pickup still covers the whole city.`}
          />
        ) : section === 'map' ? (
          <HubMap hubs={hubs} />
        ) : section === 'hours' ? (
          <HubHours hubs={hubs} />
        ) : (
          <View style={styles.list}>
            {hubs.map((hub) => (
              <View key={hub.id} style={styles.gridItem}>
                <HubCard
                  hub={hub}
                  onSelect={() =>
                    router.navigate({
                      pathname: '/book',
                      params: { originCity: hub.city, pickupArea: hub.area },
                    })
                  }
                />
              </View>
            ))}
          </View>
        )}

        <Button
          label="Book a doorstep pickup instead"
          icon={(color, size) => <Navigation color={color} size={size} />}
          onPress={() => router.navigate('/book')}
          style={styles.cta}
        />
      </View>
      <Footer />
    </ScrollView>
  );
}

/**
 * The network on a map.
 *
 * Pins are neighbourhood centres, not surveyed doors, and the caveat below is
 * not decoration: someone who trusts a pin to 10m and finds nothing there is
 * standing in the street with a parcel. "Get Directions" on the Locations tab
 * searches the full street address instead, which is the accurate route.
 */
function HubMap({ hubs }: { hubs: Hub[] }) {
  const theme = useTheme();

  const markers: MapMarker[] = hubs.flatMap((hub) => {
    const position = hubPosition(hub);
    if (!position) return [];

    return [
      {
        lat: position.lat,
        lng: position.lng,
        label: `${hub.name} — ${hub.area}`,
        tone: hub.flagship ? ('pickup' as const) : ('dropoff' as const),
      },
    ];
  });

  const missing = hubs.length - markers.length;

  if (markers.length === 0) {
    return (
      <EmptyState
        icon={(color, size) => <MapPinned color={color} size={size} />}
        title="No positions yet"
        message="We don't have map coordinates for these hubs. The Locations tab lists their full addresses."
      />
    );
  }

  return (
    <View style={styles.mapBlock}>
      <MapView markers={markers} height={380} />

      {hasApproximatePositions(hubs) && (
        <View style={[styles.notice, { backgroundColor: theme.warningSoft }]}>
          <TriangleAlert color={theme.warningOnSoft} size={15} />
          <Text style={[styles.noticeText, { color: theme.warningOnSoft }]}>
            Pins show the neighbourhood, not the exact door — they can be a few hundred metres out.
            Use Get Directions on the Locations tab to navigate to the address.
          </Text>
        </View>
      )}

      {missing > 0 && (
        <Text style={[styles.mapFootnote, { color: theme.textMuted }]}>
          {missing} {missing === 1 ? 'hub is' : 'hubs are'} not on the map yet.
        </Text>
      )}

      <View style={styles.legend}>
        <LegendDot color="#16A34A" label="Flagship hub" />
        <LegendDot color="#0077B6" label="Counter" />
      </View>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  const theme = useTheme();

  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={[styles.legendText, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

/**
 * Opening hours, with a live open/closed badge.
 *
 * The badge is computed in Africa/Lagos rather than from the device clock — see
 * `nigeriaNow`. A hub's hours belong to the hub, not to whoever is looking.
 */
function HubHours({ hubs }: { hubs: Hub[] }) {
  const theme = useTheme();

  /*
   * Re-read the clock every minute. Without this a page left open at 5:58pm
   * still says "Open now" at 7pm — a stale badge that sends someone out to a
   * closed shutter is worse than no badge.
   */
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Card style={styles.hoursCard}>
      {hubs.map((hub, index) => {
        const state = openState(hub);
        const label = openLabel(state);

        return (
          <View
            key={hub.id}
            style={[
              styles.hoursRow,
              index > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.border,
              },
            ]}>
            <View style={styles.hoursText}>
              <Text style={[styles.hubName, { color: theme.text }]}>{hub.name}</Text>
              <Text style={[styles.hubArea, { color: theme.textMuted }]}>{hub.area}</Text>
              <View style={styles.hoursLine}>
                <Clock color={theme.textMuted} size={13} />
                <Text style={[styles.detailValue, { color: theme.textSecondary }]}>
                  {hub.hours}
                </Text>
              </View>
            </View>

            {/*
              Only when the hours actually parsed. A badge is a claim about
              right now; guessing one from a string we could not read would be
              worse than staying quiet.
            */}
            {!!label && (
              <Badge
                label={label}
                tone={state.known && state.open ? 'success' : 'neutral'}
                uppercase={false}
              />
            )}
          </View>
        );
      })}

      <Text style={[styles.hoursFootnote, { color: theme.textMuted }]}>
        Times are West Africa Time (UTC+1). Public holidays may differ — call ahead if it matters.
      </Text>
    </Card>
  );
}

function HubCard({ hub, onSelect }: { hub: Hub; onSelect: () => void }) {
  const theme = useTheme();
  const [showFlagshipNote, setShowFlagshipNote] = useState(false);

  return (
    <Card style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={[styles.iconBubble, { backgroundColor: theme.primarySoft }]}>
          <Store color={theme.primaryOnSoft} size={18} />
        </View>
        <View style={styles.cardHeaderText}>
          <Text style={[styles.hubName, { color: theme.text }]}>{hub.name}</Text>
          <Text style={[styles.hubArea, { color: theme.textMuted }]}>
            {hub.area}, {hub.city}
          </Text>
        </View>
        {hub.flagship && (
          <Pressable
            onPress={() => setShowFlagshipNote((open) => !open)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showFlagshipNote }}
            accessibilityLabel="Flagship hub. What this means"
            hitSlop={6}>
            <Badge
              label="Flagship"
              tone="primary"
              icon={(color) => <Info color={color} size={11} />}
            />
          </Pressable>
        )}
      </View>

      {hub.flagship && showFlagshipNote && (
        <Text style={[styles.flagshipNote, { color: theme.textSecondary }]}>{FLAGSHIP_NOTE}</Text>
      )}

      <View style={[styles.divider, { backgroundColor: theme.border }]} />

      <DetailRow
        icon={<MapPin color={theme.primary} size={15} />}
        label="Address"
        value={hub.address}
      />
      <DetailRow
        icon={<Clock color={theme.textMuted} size={15} />}
        label="Opening hours"
        value={hub.hours}
      />
      <DetailRow
        icon={<Phone color={theme.textMuted} size={15} />}
        label="Phone"
        value={formatPhone(hub.phone)}
        onPress={() => Linking.openURL(`tel:${hub.phone}`)}
      />

      <View style={styles.serviceRow}>
        {hub.services.map((service) => (
          <Badge key={service} label={service} tone="neutral" uppercase={false} />
        ))}
      </View>

      {/*
        Two actions, because a hub page has two jobs: getting there, and
        starting a booking that lands there. Directions opens the OS map with
        the address as a search query — no map SDK, no API key, and it works on
        whichever map app the person actually uses.
      */}
      <View style={[styles.actions, { borderTopColor: theme.border }]}>
        <Button
          label="Get Directions"
          size="md"
          variant="secondary"
          style={styles.action}
          icon={(color, size) => <Navigation color={color} size={size} />}
          onPress={() => openDirections(hub)}
        />
        <Button
          label="Select Hub"
          size="md"
          style={styles.action}
          icon={(color, size) => <PackagePlus color={color} size={size} />}
          onPress={onSelect}
        />
      </View>
    </Card>
  );
}

function DetailRow({
  icon,
  label,
  value,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onPress?: () => void;
}) {
  const theme = useTheme();

  const body = (
    <View style={styles.detailRow}>
      <View style={styles.detailIcon}>{icon}</View>
      <View style={styles.detailText}>
        <Text style={[styles.detailLabel, { color: theme.textMuted }]}>{label}</Text>
        <Text style={[styles.detailValue, { color: onPress ? theme.primary : theme.text }]}>
          {value}
        </Text>
      </View>
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Call ${value}`}
      style={({ pressed }) => pressed && styles.pressed}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  /**
   * The filter is its own step, not a continuation of the header. At the old
   * 8px it read as part of the subtitle.
   */
  filterBlock: {
    marginTop: Spacing.three,
    marginBottom: Spacing.four,
    paddingBottom: Spacing.four,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cityLine: {
    ...Typography.meta,
    ...font(600),
    marginBottom: Spacing.three,
  },
  /**
   * Wraps into columns rather than one full-width stack. A hub card is a short
   * address, a time and a phone number — stretched across a 1280px monitor the
   * eye has to travel the whole width for three words of content.
   */
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three - 2,
  },
  /** ~360px is where the address stops wrapping awkwardly. */
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.three - 4,
    marginTop: Spacing.one,
  },
  action: {
    flexGrow: 1,
    flexBasis: 140,
  },
  flagshipNote: {
    ...Typography.caption,
    lineHeight: 19,
  },
  gridItem: {
    flexGrow: 1,
    flexBasis: 340,
    maxWidth: 520,
  },
  card: {
    gap: Spacing.two + 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
  },
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHeaderText: {
    flex: 1,
    gap: Spacing.half,
  },
  hubName: {
    ...Typography.body,
    ...font(700),
  },
  hubArea: {
    ...Typography.meta,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two + 2,
  },
  detailIcon: {
    width: 18,
    alignItems: 'center',
    paddingTop: 2,
  },
  detailText: {
    flex: 1,
    gap: Spacing.half,
  },
  detailLabel: {
    ...Typography.caption,
  },
  detailValue: {
    ...Typography.meta,
    ...font(600),
    lineHeight: 19,
  },
  pressed: {
    opacity: 0.7,
  },
  serviceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two - 2,
    marginTop: Spacing.half,
  },
  cta: {
    marginTop: Spacing.four,
  },
  sectionTabs: {
    marginTop: Spacing.three,
  },

  // Map
  mapBlock: {
    gap: Spacing.three - 2,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
  },
  noticeText: {
    ...Typography.meta,
    ...font(600),
    flex: 1,
    lineHeight: 19,
  },
  mapFootnote: {
    ...Typography.caption,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  legendDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  legendText: {
    ...Typography.caption,
    ...font(600),
  },

  // Hours
  hoursCard: {
    gap: 0,
  },
  hoursRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingVertical: Spacing.three - 2,
  },
  hoursText: {
    flex: 1,
    gap: Spacing.half,
  },
  hoursLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
    marginTop: Spacing.half,
  },
  hoursFootnote: {
    ...Typography.caption,
    lineHeight: 18,
    paddingTop: Spacing.three - 2,
  },
});
