import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { MODE_LABEL, MODE_MEANING, type OperatingMode } from '@/store/dispatch';

/**
 * Current Operating Mode — Scheduled (interstate) or Flash (intrastate).
 *
 * The two are genuinely different products, not a preference: a scheduled
 * journey is a route declared ahead of time, and a flash shift is a driver
 * sitting in one city for the next couple of hours. Matching treats them
 * differently — see `supabase/migrations/20250101000018_flash_mode.sql` — so the driver has to be able
 * to say which one they are doing.
 *
 * ⚠ One deliberate departure from the mockup.
 *
 *   The mockup labels the switch "Scheduled" on the left and "Flash" on the
 *   right, with the switch on. That is ambiguous: a switch has an on state, not
 *   a left and a right, and nothing on it says whether on means Flash. A driver
 *   glancing down mid-shift needs to know which mode they are in without
 *   working it out from a knob position.
 *
 *   So the active side is stated in words and carries the colour, the inactive
 *   side is muted, and the whole row reads as one control. Both labels are also
 *   pressable, because on a phone the label is the bigger target and people
 *   tap it.
 */
export function OperatingModeCard({
  mode,
  onChange,
  /** Shown under the switch — e.g. "Online in Ibadan until 14:20". */
  status,
}: {
  mode: OperatingMode;
  onChange: (next: OperatingMode) => void;
  status?: string;
}) {
  const theme = useTheme();
  const isFlash = mode === 'flash';

  return (
    <Card style={styles.card}>
      <Text style={[styles.title, { color: theme.text }]}>Current Operating Mode</Text>

      <View style={styles.row}>
        <ModeLabel
          label={MODE_LABEL.scheduled}
          active={!isFlash}
          onPress={() => onChange('scheduled')}
        />

        <Switch
          value={isFlash}
          onValueChange={(next) => onChange(next ? 'flash' : 'scheduled')}
          accessibilityRole="switch"
          /*
            The label says which mode the switch selects, not just "on". A
            screen reader announcing "switch, on" tells a driver nothing about
            whether they are taking local jobs.
          */
          accessibilityLabel={`Operating mode. Currently ${MODE_LABEL[mode]}. ${
            isFlash ? 'Turn off for Scheduled.' : 'Turn on for Flash.'
          }`}
          trackColor={{ false: theme.borderStrong, true: theme.primary }}
          thumbColor="#FFFFFF"
        />

        <ModeLabel label={MODE_LABEL.flash} active={isFlash} onPress={() => onChange('flash')} />
      </View>

      {/* What the selected mode actually means, in one line. */}
      <Text style={[styles.meaning, { color: theme.textMuted }]}>{MODE_MEANING[mode]}</Text>

      {!!status && (
        <View style={[styles.status, { backgroundColor: theme.successSoft }]}>
          <Text style={[styles.statusText, { color: theme.successOnSoft }]}>{status}</Text>
        </View>
      )}
    </Card>
  );
}

function ModeLabel({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Switch to ${label}`}
      style={({ pressed }) => [styles.label, pressed && styles.pressed]}>
      <Text
        style={[
          styles.labelText,
          { color: active ? theme.text : theme.textMuted },
          active && font(700),
        ]}>
        {label}
      </Text>
      {/*
        An underline on the active side, so the state is not carried by weight
        and colour alone — WCAG 1.4.1, and the difference between 600 and 700
        weight is not much to go on at arm's length in daylight.
      */}
      <View
        style={[styles.underline, { backgroundColor: active ? theme.primary : 'transparent' }]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.three - 2,
  },
  title: {
    ...Typography.sectionTitle,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  label: {
    // A real target: the label is what people tap, not the 50px switch.
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.one,
    gap: Spacing.one,
    alignItems: 'center',
    cursor: 'pointer',
  },
  labelText: {
    ...Typography.cardTitle,
  },
  underline: {
    height: 2,
    width: '100%',
    borderRadius: Radius.pill,
  },
  meaning: {
    ...Typography.caption,
    lineHeight: 17,
  },
  status: {
    padding: Spacing.two + 2,
    borderRadius: Radius.sm,
  },
  statusText: {
    ...Typography.caption,
    ...font(600),
  },
  pressed: {
    opacity: 0.6,
  },
});
