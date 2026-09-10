import { useRouter } from 'expo-router';
import {
  Banknote,
  ChevronRight,
  CircleCheck,
  Radio,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { FontSize, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatNaira } from '@/store/bookings';
import { matchStatusLabel, type MatchStatus } from '@/store/dispatch';
import { STATUS_LABELS, type DriverApplication } from '@/store/driver-applications';

/**
 * The three numbers a driver checks before they start.
 *
 * Mirrors the web portal's top row so a driver who uses both sees the same
 * figures in the same order — earnings, what dispatch is doing, and whether
 * they are cleared to work.
 *
 * Deliberately three items and no more. This sits above a map on a phone held
 * in one hand; a fourth would push the current job below the fold, which is the
 * thing the screen exists for.
 */
export function DriverSummaryCard({
  expectedEarnings,
  deliveredCount,
  match,
  application,
  isApprovedDriver,
  onOpenEarnings,
}: {
  /** Quoted fares on jobs held, not money paid. See the label. */
  expectedEarnings: number;
  deliveredCount: number;
  match: MatchStatus;
  application: DriverApplication | null;
  isApprovedDriver: boolean;
  /** Opens the history behind the figure. Omitted, the cell is inert. */
  onOpenEarnings?: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();

  /*
   * Compliance is one line with a tone, not a checklist.
   *
   * A driver either can work or cannot, and if they cannot the only useful
   * thing is what to do about it. The full application detail already has a
   * screen; repeating it here would make this card something to read rather
   * than glance at.
   */
  const compliance = complianceState(application, isApprovedDriver);

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        {/*
          ---------- Earnings ----------

          ⚠ The Pressable carries no flex of its own.

            `styles.cell` already sets `flex: 1`. Putting it on the wrapper too
            made the admin metric cards size themselves off the wrong axis —
            inside a column parent a flex basis sets *height* — and they looked
            tappable while landing nowhere. The wrapper here is layout-neutral
            and the cell keeps doing the sizing it already did.
        */}
        <Pressable
          onPress={onOpenEarnings}
          disabled={!onOpenEarnings}
          accessibilityRole="button"
          accessibilityLabel={`Expected earnings ${formatNaira(
            expectedEarnings,
          )}, ${deliveredCount} delivered. Open the breakdown.`}
          style={({ pressed }) => [
            styles.earningsPress,
            // react-native-web renders Pressable as a plain div, which shows a
            // text caret rather than a pointer unless it is asked.
            onOpenEarnings ? styles.tappable : null,
            pressed && styles.pressed,
          ]}>
          <View style={styles.cell}>
            <View style={styles.cellHead}>
              <Banknote color={theme.textMuted} size={14} />
              <Text style={[styles.cellLabel, { color: theme.textMuted }]}>Expected</Text>
              {onOpenEarnings ? <ChevronRight color={theme.textMuted} size={13} /> : null}
            </View>
            <Text style={[styles.cellValue, { color: theme.primary }]} numberOfLines={1}>
              {formatNaira(expectedEarnings)}
            </Text>
            {/*
              "Expected", never "earned". These are gross quoted fares on
              parcels held and delivered; the Wallet is net of commission and
              credits only on delivery, so the two differ by design. Tapping
              this opens the sheet, which names the wallet as the real balance —
              this cell has room for a number and a count, not a caveat.
            */}
            <Text style={[styles.cellNote, { color: theme.textMuted }]} numberOfLines={1}>
              {deliveredCount} delivered
            </Text>
          </View>
        </Pressable>

        <View style={[styles.divider, { backgroundColor: theme.border }]} />

        {/* ---------- Match status ---------- */}
        <View style={styles.cell}>
          <View style={styles.cellHead}>
            <Radio color={theme.textMuted} size={14} />
            <Text style={[styles.cellLabel, { color: theme.textMuted }]}>Dispatch</Text>
          </View>
          <Text
            style={[
              styles.cellStatus,
              { color: match.kind === 'offer' ? theme.warningOnSoft : theme.text },
            ]}
            numberOfLines={2}>
            {matchStatusLabel(match)}
          </Text>
        </View>

        <View style={[styles.divider, { backgroundColor: theme.border }]} />

        {/* ---------- Compliance ---------- */}
        <View style={styles.cell}>
          <View style={styles.cellHead}>
            {compliance.tone === 'ok' ? (
              <CircleCheck color={theme.success} size={14} />
            ) : compliance.tone === 'warn' ? (
              <TriangleAlert color={theme.warningOnSoft} size={14} />
            ) : (
              <ShieldAlert color={theme.danger} size={14} />
            )}
            <Text style={[styles.cellLabel, { color: theme.textMuted }]}>Status</Text>
          </View>
          <Text
            style={[
              styles.cellStatus,
              {
                color:
                  compliance.tone === 'ok'
                    ? theme.success
                    : compliance.tone === 'warn'
                      ? theme.warningOnSoft
                      : theme.danger,
              },
            ]}
            numberOfLines={2}>
            {compliance.label}
          </Text>
        </View>
      </View>

      {compliance.action && (
        <Text
          onPress={() => router.navigate(compliance.action!.href as '/')}
          accessibilityRole="link"
          style={[styles.action, { color: theme.primary }]}>
          {compliance.action.label}
        </Text>
      )}
    </Card>
  );
}

type Compliance = {
  label: string;
  tone: 'ok' | 'warn' | 'blocked';
  action?: { label: string; href: string };
};

/**
 * Exported for the verification script: a driver who cannot work must never see
 * a green line, and a driver who can must not be nagged.
 */
export function complianceState(
  application: DriverApplication | null,
  isApprovedDriver: boolean,
): Compliance {
  if (!application) {
    return {
      label: 'Not applied',
      tone: 'blocked',
      action: { label: 'Start your driver application →', href: '/driver-signup' },
    };
  }

  if (isApprovedDriver) {
    return { label: 'Approved to drive', tone: 'ok' };
  }

  /*
   * Approved-but-not-active is the case worth separating.
   *
   * `isApprovedDriver` is false for a banned or erased account as well as for
   * one still under review — see `is_approved_driver()` in 20250101000009_bans.sql. A
   * banned driver told "under review" would wait for a decision that already
   * happened, so the two read differently.
   */
  if (application.status === 'approved') {
    return {
      label: 'Approved, but not active',
      tone: 'blocked',
      action: { label: 'Contact support →', href: '/support' },
    };
  }

  return {
    label: STATUS_LABELS[application.status],
    tone: application.status === 'rejected' ? 'blocked' : 'warn',
    action: { label: 'See your application →', href: '/driver-updates' },
  };
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two + 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  // Layout-neutral on purpose — see the note at the Pressable.
  earningsPress: { alignSelf: 'stretch' },
  tappable: { cursor: 'pointer' },
  pressed: { opacity: 0.6 },
  cell: {
    flex: 1,
    gap: Spacing.half,
    paddingHorizontal: Spacing.one,
  },
  cellHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  cellLabel: {
    ...Typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  cellValue: {
    fontSize: FontSize.subhead,
    ...font(700),
  },
  cellStatus: {
    ...Typography.caption,
    ...font(600),
    lineHeight: 16,
  },
  cellNote: {
    ...Typography.caption,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.two - 2,
  },
  action: {
    ...Typography.caption,
    ...font(600),
    // A 44px row for a 12px label: the target has to be tappable even though
    // the text is deliberately quiet.
    paddingVertical: Spacing.two + 2,
    borderRadius: Radius.sm,
  },
});
