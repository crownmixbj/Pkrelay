import { useRouter } from 'expo-router';
import { Info, MapPinned, Pencil, Plus, Store } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { errorMessage } from '@/lib/errors';
import { DeploymentPanel } from '@/components/ui/deployment-panel';
import { AdminError, AdminShell, Metric, adminStyles } from '@/components/ui/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MapView, type MapMarker } from '@/components/ui/map-view';
import { SectionLabel } from '@/components/ui/screen';
import { openLabel, openState } from '@/constants/hub-hours';
import { hubPosition, type Hub } from '@/constants/hubs';
import { FontSize, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fetchCityVolumes, type CityVolume } from '@/store/admin';
import { HubEditor } from '@/components/ui/hub-editor';
import { useHubs } from '@/store/hubs';
import { useSession } from '@/store/session';

/**
 * Hubs & Operations.
 *
 * The network on one side, what is moving through it on the other.
 *
 * Hubs are editable here. They live in `public.hubs` — public to read, admin to
 * write — so correcting an address no longer needs a deploy, and the change is
 * visible on the Hubs page and in the booking form immediately.
 *
 * Parcel volumes come from `admin_city_volumes`, which returns numbers and not
 * anyone's address.
 */
export default function AdminOpsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { isAdmin } = useSession();
  /*
   * `allHubs`, not `hubs`. The public list hides closed hubs; the admin list
   * must not, or closing one would remove the only way to re-open it.
   */
  const { allHubs: HUBS, usingSeed, error: hubsError, refresh } = useHubs();

  /**
   * What the editor is doing: nothing, creating, or editing one hub.
   *
   * A single value rather than a boolean plus a hub — those two can disagree,
   * and the state where `creating` is true *and* a hub is selected has no
   * meaning.
   */
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; hub: Hub } | null>(
    null,
  );

  const [volumes, setVolumes] = useState<CityVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setVolumes(await fetchCityVolumes());
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not load volumes.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    void load();
  }, [isAdmin, load]);

  /*
   * A closed hub is not "open right now" whatever its posted hours say, so the
   * active check comes first — otherwise closing a hub would leave it counted
   * as open all week.
   */
  const live = HUBS.filter((hub) => hub.active !== false);

  const openNow = live.filter((hub) => {
    const state = openState(hub);
    return state.known && state.open;
  }).length;

  const cities = new Set(live.map((hub) => hub.city)).size;

  const markers: MapMarker[] = live.flatMap((hub) => {
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

  return (
    <AdminShell
      title="Hubs & Operations"
      subtitle="The partner network, and the parcel volume flowing through each city."
      next="/admin-ops">
      {!!error && <AdminError message={error} />}

      <View style={adminStyles.metrics}>
        <Metric
          label="Hubs"
          value={live.length}
          tone="primary"
          hint={HUBS.length > live.length ? `${HUBS.length - live.length} closed` : undefined}
        />
        <Metric label="Cities covered" value={cities} />
        <Metric
          label="Open right now"
          value={openNow}
          tone={openNow > 0 ? 'success' : 'warning'}
          hint="West Africa Time"
        />
        <Metric label="Flagship hubs" value={live.filter((h) => h.flagship).length} />
      </View>

      {/*
        First on the page, above the operational panels.

        Everything below it describes the network; this describes whether what
        you are looking at is current. When it is not, nothing below can be
        trusted either — a missing migration shows up as an empty list rather
        than as an error.
      */}
      <DeploymentPanel />

      <SectionLabel>Parcel volume by city</SectionLabel>
      {loading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : volumes.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
            No parcels have been booked yet, so there is nothing to count.
          </Text>
        </Card>
      ) : (
        <Card style={styles.list}>
          {volumes.map((row, index) => {
            const hubsHere = live.filter((hub) => hub.city === row.city).length;

            return (
              <View
                key={row.city}
                style={[
                  styles.volumeRow,
                  index > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: theme.border,
                  },
                ]}>
                <View style={styles.volumeText}>
                  <Text style={[styles.city, { color: theme.text }]}>{row.city}</Text>
                  {/*
                    Volume against coverage in one line. A city sending parcels
                    with no hub is the operational signal on this screen — it is
                    where a hub should open next.
                  */}
                  <Text style={[styles.meta, { color: theme.textMuted }]}>
                    {hubsHere === 0
                      ? 'No hub here yet — doorstep only'
                      : `${hubsHere} hub${hubsHere === 1 ? '' : 's'}`}
                  </Text>
                </View>
                <View style={styles.volumeNumbers}>
                  <Text style={[styles.total, { color: theme.text }]}>{row.total}</Text>
                  {row.active > 0 && (
                    <Badge label={`${row.active} active`} tone="primary" uppercase={false} />
                  )}
                </View>
              </View>
            );
          })}
        </Card>
      )}

      <SectionLabel>Network map</SectionLabel>
      <View style={styles.mapBlock}>
        <MapView markers={markers} height={320} />
        <Text style={[styles.mapNote, { color: theme.textMuted }]}>
          Pins are neighbourhood centres, not surveyed addresses — they can be a few hundred metres
          out.
        </Text>
      </View>

      <View style={styles.sectionRow}>
        <SectionLabel>Hub status</SectionLabel>
        <Button
          label="New hub"
          size="md"
          icon={(color, size) => <Plus color={color} size={size} />}
          disabled={usingSeed}
          onPress={() => setEditor({ mode: 'create' })}
        />
      </View>
      <Card style={styles.list}>
        {HUBS.map((hub, index) => {
          const state = openState(hub);
          const label = openLabel(state);

          return (
            <Pressable
              key={hub.id}
              onPress={() => setEditor({ mode: 'edit', hub })}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${hub.name}`}
              style={({ pressed }) => [
                styles.hubRow,
                index > 0 && {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: theme.border,
                },
                pressed && { backgroundColor: theme.surfaceMuted },
              ]}>
              <Store color={theme.textMuted} size={15} />
              <View style={styles.volumeText}>
                <Text style={[styles.hubName, { color: theme.text }]}>{hub.name}</Text>
                {/* The address leads: it is the field most likely to be wrong. */}
                <Text style={[styles.meta, { color: theme.textMuted }]}>{hub.address}</Text>
                <Text style={[styles.meta, { color: theme.textMuted }]}>{hub.hours}</Text>
              </View>
              {/*
                A closed hub's posted hours are irrelevant, so the badge says
                Closed rather than "Opens later today" — which would read as
                though it were merely shut for the evening.
              */}
              {hub.active === false ? (
                <Badge label="Closed" tone="danger" uppercase={false} />
              ) : (
                label && (
                  <Badge
                    label={label}
                    tone={state.known && state.open ? 'success' : 'neutral'}
                    uppercase={false}
                  />
                )
              )}
              <Pencil color={theme.primary} size={15} />
            </Pressable>
          );
        })}
      </Card>

      {/*
        The one state where the edit controls would silently do nothing.

        With no `hubs` table the app falls back to the built-in list, which is
        read-only — saving would fail against a table that does not exist. Better
        to say which file to run than to let someone type a corrected address
        and lose it.
      */}
      {usingSeed && (
        <View style={[styles.notice, { backgroundColor: theme.warningSoft }]}>
          <Info color={theme.warningOnSoft} size={16} />
          <Text style={[styles.noticeText, { color: theme.warningOnSoft }]}>
            {hubsError ?? 'Showing the built-in hub list.'} Until{' '}
            <Text style={font(700)}>supabase/migrations/20250101000008_hubs.sql</Text> has been run, edits cannot be saved.
          </Text>
        </View>
      )}

      {editor && (
        <HubEditor
          hub={editor.mode === 'edit' ? editor.hub : null}
          disabled={usingSeed}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void refresh();
          }}
        />
      )}

      <Button
        label="Open the public hubs page"
        variant="secondary"
        size="md"
        icon={(color, size) => <MapPinned color={color} size={size} />}
        onPress={() => router.navigate('/locations')}
      />
    </AdminShell>
  );
}

const styles = StyleSheet.create({
  loading: {
    marginVertical: Spacing.six,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  emptyCard: {
    marginBottom: Spacing.four,
  },
  emptyText: {
    ...Typography.meta,
  },
  list: {
    gap: 0,
    marginBottom: Spacing.four,
  },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three - 2,
  },
  volumeText: {
    flex: 1,
    gap: Spacing.half,
  },
  city: {
    ...Typography.meta,
    ...font(700),
  },
  meta: {
    ...Typography.caption,
  },
  volumeNumbers: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  total: {
    fontSize: FontSize.subhead,
    ...font(800),
  },
  mapBlock: {
    gap: Spacing.two,
    marginBottom: Spacing.four,
  },
  mapNote: {
    ...Typography.caption,
    lineHeight: 18,
  },
  hubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two + 2,
  },
  hubName: {
    ...Typography.meta,
    ...font(600),
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    marginBottom: Spacing.four,
  },
  noticeText: {
    ...Typography.caption,
    flex: 1,
    lineHeight: 19,
  },
});
