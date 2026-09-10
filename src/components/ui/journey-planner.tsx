import { useRouter } from 'expo-router';
import { MapPin, Pause, Pencil, Play, Radio, Route, Trash2, Weight } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DeparturePicker } from '@/components/ui/departure-picker';
import { showDialog } from '@/components/ui/dialog';
import { Dropdown } from '@/components/ui/dropdown';
import { Field } from '@/components/ui/field';
import { EmptyState, SectionLabel } from '@/components/ui/screen';
import { showToast } from '@/components/ui/toast';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { departureLabel } from '@/lib/departure';
import { CITIES, type City } from '@/store/bookings';
import {
  cancelJourney,
  declareJourney,
  fetchJourneys,
  OFFER_HOLD_MINUTES,
  setJourneyStatus,
  updateJourney,
  validateJourney,
  type Journey,
  type JourneyErrors,
} from '@/store/dispatch';
import { useSession } from '@/store/session';

/**
 * Schedule My Journey — the driver declares where they are going.
 *
 * This replaces browsing a board. A driver says "Ibadan to Lagos, this
 * afternoon, 40kg spare" and parcels on that route are offered to them.
 *
 * ⚠ An offer is held five minutes within a city and ten between cities — see
 *   `OFFER_HOLD_MINUTES`, which mirrors `public.offer_hold` in
 *   `supabase/migrations/20250101000021_offer_windows.sql`. Offers themselves land on Assigned Trip,
 *   and `notify-offer` alerts the driver when one does; the warning that used to
 *   live here belongs on that screen, where the push permission can be checked.
 */
export function JourneyPlanner() {
  const theme = useTheme();
  const router = useRouter();
  const { application, isApprovedDriver } = useSession();

  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [busy, setBusy] = useState(false);

  const [origin, setOrigin] = useState<City>('Ibadan');
  const [destination, setDestination] = useState<City>('Lagos');
  const [capacity, setCapacity] = useState('');
  const [departureAt, setDepartureAt] = useState<Date | null>(null);
  const [errors, setErrors] = useState<JourneyErrors>({});

  /*
   * Editing reuses the declare form rather than opening a second one.
   *
   * The fields are identical, and two places to type a route is two places for
   * the validation to drift apart. `editing` only changes what the submit
   * button does and what it is called.
   */
  const [editing, setEditing] = useState<Journey | null>(null);

  const startEdit = (journey: Journey) => {
    setEditing(journey);
    setOrigin(journey.originCity);
    setDestination(journey.destinationCity);
    setCapacity(String(journey.capacityKg));
    setDepartureAt(new Date(journey.departureAt ?? journey.departsBefore));
    setErrors({});
  };

  const stopEdit = () => {
    setEditing(null);
    setCapacity('');
    setDepartureAt(null);
    setErrors({});
  };

  const refresh = useCallback(async () => {
    setJourneys(await fetchJourneys());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useMemo(() => journeys.filter((j) => j.status === 'open'), [journeys]);

  const submit = async () => {
    /*
     * An exact departure, not a relative window.
     *
     * This used to ask "leaving within N hours" and derive a window from it.
     * The reasoning was that a driver declaring a journey is standing next to a
     * bike rather than planning a calendar — which is still true of the *input*,
     * and is why the selector opens on the next quarter hour and offers chips
     * rather than a spinner. What changed is what gets stored: a moment the
     * driver chose, instead of an offset from whenever they happened to tap.
     */
    const input = {
      originCity: origin,
      destinationCity: destination,
      departureAt: departureAt ?? new Date(0),
      capacityKg: Number(capacity),
      vehicleType: application?.vehicleType ?? 'Motorcycle',
    };

    const found = validateJourney(input);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);

    if (editing) {
      const outcome = await updateJourney(editing.id, {
        originCity: input.originCity,
        destinationCity: input.destinationCity,
        capacityKg: input.capacityKg,
        departureAt: input.departureAt,
      });
      setBusy(false);

      if (!outcome.ok) {
        /*
         * The server's own sentence, not a generic one.
         *
         * Every way this fails is something the driver has to do something
         * about — answer the offer waiting on the route, or go offline to
         * change a shift. "Could not save" leaves them pressing the button
         * again.
         */
        showDialog('That change did not go through', outcome.error);
        return;
      }

      stopEdit();
      showToast('Journey updated', {
        message: `${input.originCity} → ${input.destinationCity}, leaving ${departureLabel(
          input.departureAt,
        )}.`,
      });
      void refresh();
      return;
    }

    const created = await declareJourney(input);
    setBusy(false);

    if (!created) {
      showDialog(
        'Could not save that journey',
        'Check your connection and try again. Your driver approval has to be active.',
      );
      return;
    }

    setCapacity('');
    setDepartureAt(null);
    showToast('Journey scheduled', {
      message: `Parcels going ${origin} → ${destination} will be offered to you until ${departureLabel(
        input.departureAt,
      )}.`,
    });
    void refresh();
  };

  const confirmCancel = (journey: Journey) => {
    showDialog(
      'Withdraw this journey?',
      `${journey.originCity} → ${journey.destinationCity}, leaving ${departureLabel(
        new Date(journey.departureAt ?? journey.departsBefore),
      )}.\n\nNo more parcels will be offered on this route. Any trip already waiting on your answer goes straight to another driver.`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Withdraw',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const done = await cancelJourney(journey.id);
              if (!done) {
                showDialog('Could not withdraw it', 'Check your connection and try again.');
                return;
              }
              if (editing?.id === journey.id) stopEdit();
              showToast('Journey withdrawn');
              void refresh();
            })();
          },
        },
      ],
    );
  };

  if (!isApprovedDriver) {
    return (
      <Card style={styles.gate}>
        <Radio color={theme.warningOnSoft} size={20} />
        <Text style={[styles.gateTitle, { color: theme.text }]}>
          Scheduling unlocks when you are approved
        </Text>
        <Text style={[styles.gateBody, { color: theme.textSecondary }]}>
          {application
            ? 'Your application is still being reviewed. Once it is approved you can declare the journeys you are making and parcels will be offered to you automatically.'
            : 'Apply to drive first. Approved drivers declare the journeys they are making, and Package Relay offers them parcels going the same way.'}
        </Text>
        <Button
          label={application ? 'See your application' : 'Apply to drive'}
          onPress={() => router.navigate(application ? '/driver-updates' : '/driver-signup')}
        />
      </Card>
    );
  }

  return (
    <View style={styles.wrap}>
      {/*
        Offers are not shown here.

        They live on the Assigned Trip screen — `DispatchOffers`, rendered by
        `driver-hub.tsx`. Scheduling is something a driver does once and leaves;
        the home screen is the one they sit on. An offer is held five or ten
        minutes, so which screen it appears on decides whether it is answered.
      */}

      {/* ---------- Declare one ---------- */}
      <Card style={styles.form}>
        <View style={styles.formHead}>
          <Route color={theme.primary} size={18} />
          <Text style={[styles.formTitle, { color: theme.text }]}>
            {editing ? 'Edit this journey' : 'Where are you going?'}
          </Text>
        </View>

        <View style={styles.row}>
          <View style={styles.rowItem}>
            <Dropdown
              label="From"
              options={CITIES}
              selected={origin}
              onSelect={(value) => setOrigin(value as City)}
              icon={(color, size) => <MapPin color={color} size={size} />}
            />
          </View>
          <View style={styles.rowItem}>
            <Dropdown
              label="To"
              options={CITIES}
              selected={destination}
              onSelect={(value) => setDestination(value as City)}
              icon={(color, size) => <MapPin color={color} size={size} />}
              error={errors.destinationCity}
            />
          </View>
        </View>

        {/*
          Capacity and departure share a row, as From and To do above.

          A single-item row left capacity spanning the full width while the two
          fields above it were halves — three inputs, three different widths, on
          a form with four fields. Pairing them gives the card two even rows and
          puts the whole thing in one glance.
        */}
        <View style={styles.row}>
          <View style={styles.rowItem}>
            <Field
              label="Spare capacity (kg)"
              icon={(color, size) => <Weight color={color} size={size} />}
              placeholder="40"
              keyboardType="numeric"
              value={capacity}
              onChangeText={setCapacity}
              error={errors.capacityKg}
            />
          </View>
          <View style={styles.rowItem}>
            <DeparturePicker
              value={departureAt}
              onChange={setDepartureAt}
              error={errors.departureAt}
            />
          </View>
        </View>

        <Button
          label={busy ? 'Saving…' : editing ? 'Save changes' : 'Broadcast this journey'}
          icon={(color, size) => <Radio color={color} size={size} />}
          onPress={submit}
          disabled={busy}
        />

        {!!editing && (
          <Button label="Cancel editing" variant="secondary" onPress={stopEdit} disabled={busy} />
        )}

        {/*
          The honest limit, on the screen rather than in a changelog.

          A driver whose offers keep expiring will conclude the app is broken or
          that Package Relay is giving work to someone else. Saying it here costs one
          sentence and saves that.

          No caveat about keeping the screen open: this screen is not where
          offers land, so the advice would be wrong even for a driver whose
          notifications are off. Assigned Trip carries that warning, where it
          can check the permission.
        */}
        <Text style={[styles.caveat, { color: theme.textMuted }]}>
          Matched trips appear on your Assigned Trip screen, not here, and Package Relay alerts you when one
          does. Trips within one city are held for {OFFER_HOLD_MINUTES.local} minutes and trips
          between cities for {OFFER_HOLD_MINUTES.interstate}.
        </Text>
      </Card>

      {/* ---------- What is live ---------- */}
      <View style={styles.section}>
        <SectionLabel>{`Your journeys (${open.length} listening)`}</SectionLabel>

        {journeys.length === 0 ? (
          <EmptyState
            icon={(color, size) => <Route color={color} size={size} />}
            title="No journeys yet"
            message="Declare where you are going and Package Relay will offer you parcels heading the same way."
          />
        ) : (
          <View style={styles.list}>
            {journeys.map((journey) => (
              <JourneyRow
                key={journey.id}
                journey={journey}
                editing={editing?.id === journey.id}
                onToggle={async () => {
                  await setJourneyStatus(journey.id, journey.status === 'open' ? 'paused' : 'open');
                  void refresh();
                }}
                onEdit={() => startEdit(journey)}
                onCancel={() => confirmCancel(journey)}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function JourneyRow({
  journey,
  editing,
  onToggle,
  onEdit,
  onCancel,
}: {
  journey: Journey;
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const live = journey.status === 'open';
  const departs = new Date(journey.departureAt ?? journey.departsBefore);

  /*
   * A withdrawn or finished route keeps its row but loses its controls.
   *
   * Hiding it entirely would make a cancel look like the row failed to save.
   */
  const settled = journey.status === 'cancelled' || journey.status === 'completed';

  return (
    <View
      style={[
        styles.journey,
        {
          backgroundColor: theme.surface,
          borderColor: editing ? theme.primary : theme.border,
          borderWidth: editing ? 1.5 : StyleSheet.hairlineWidth,
        },
      ]}>
      <View style={styles.journeyHead}>
        <View style={styles.journeyText}>
          <Text style={[styles.journeyRoute, { color: theme.text }]}>
            {journey.originCity} → {journey.destinationCity}
          </Text>
          {/*
            The full date, not just a time.

            This read "leaves by 11:00", which is unreadable the moment a driver
            has two routes — 11:00 today and 11:00 on Thursday are the same
            sentence. `departureLabel` says Today, Tomorrow, or the date.
          */}
          <Text style={[styles.journeyMeta, { color: theme.textMuted }]}>
            {journey.capacityKg} kg spare · leaves {departureLabel(departs)}
          </Text>
        </View>

        {settled ? (
          <Text style={[styles.journeyState, { color: theme.textMuted }]}>
            {journey.status === 'cancelled' ? 'Withdrawn' : 'Done'}
          </Text>
        ) : (
          <Pressable
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel={live ? 'Pause this journey' : 'Resume this journey'}
            style={({ pressed }) => [styles.toggle, styles.tappable, pressed && styles.pressed]}>
            {live ? (
              <Pause color={theme.textMuted} size={16} />
            ) : (
              <Play color={theme.primary} size={16} />
            )}
            <Text style={[styles.toggleText, { color: live ? theme.textMuted : theme.primary }]}>
              {live ? 'Pause' : 'Resume'}
            </Text>
          </Pressable>
        )}
      </View>

      {!settled && (
        <View style={[styles.journeyActions, { borderTopColor: theme.border }]}>
          <Pressable
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${journey.originCity} to ${journey.destinationCity}`}
            style={({ pressed }) => [styles.rowAction, styles.tappable, pressed && styles.pressed]}>
            <Pencil color={theme.primary} size={15} />
            <Text style={[styles.rowActionText, { color: theme.primary }]}>
              {editing ? 'Editing…' : 'Edit'}
            </Text>
          </Pressable>

          {/*
            Withdraw sits apart and in the danger colour.

            It is the only control here that cannot be undone — Pause resumes,
            an edit can be edited again — so it should not look like its
            neighbours.
          */}
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel={`Withdraw ${journey.originCity} to ${journey.destinationCity}`}
            style={({ pressed }) => [styles.rowAction, styles.tappable, pressed && styles.pressed]}>
            <Trash2 color={theme.danger} size={15} />
            <Text style={[styles.rowActionText, { color: theme.danger }]}>Withdraw</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.four },
  section: { gap: Spacing.two },
  list: { gap: Spacing.two },
  form: { gap: Spacing.three },
  formHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  formTitle: { ...Typography.sectionTitle },
  row: { flexDirection: 'row', gap: Spacing.three - 4 },
  rowItem: { flex: 1 },
  caveat: { ...Typography.caption, lineHeight: 17 },
  journey: {
    gap: Spacing.two,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  journeyHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  journeyState: { ...Typography.caption, ...font(600) },
  journeyActions: {
    flexDirection: 'row',
    gap: Spacing.three,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowAction: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  rowActionText: { ...Typography.caption, ...font(600) },
  // react-native-web renders Pressable as a plain div, which shows a text caret
  // rather than a pointer unless it is asked.
  tappable: { cursor: 'pointer' },
  journeyText: { flex: 1, gap: Spacing.half },
  journeyRoute: { ...Typography.meta, ...font(700) },
  journeyMeta: { ...Typography.caption },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.two + 2,
    paddingHorizontal: Spacing.two,
  },
  toggleText: { ...Typography.caption, ...font(600) },
  gate: { gap: Spacing.two + 2 },
  gateTitle: { ...Typography.sectionTitle },
  gateBody: { ...Typography.meta, lineHeight: 20 },
  pressed: { opacity: 0.6 },
});
