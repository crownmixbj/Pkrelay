import { ArrowLeft, ArrowRight, Check } from 'lucide-react-native';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FontSize, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * The pieces both long forms are built from.
 *
 * Package Relay has two forms that ask for thirty-odd fields: the driver application and
 * Post a Parcel. They are unrelated in content and identical in shape — a
 * progress indicator, per-step validation, Back and Next, and one confirmation
 * before the irreversible button. Written twice they would drift, and the half
 * that drifts is always the validation.
 *
 * ⚠ Everything here is presentational. The wizard does not hold the step, does
 *   not know which fields exist, and cannot decide whether a step is complete.
 *   Both forms already own their state and their validation, and moving either
 *   into a shared component would mean this file knowing about NINs and parcel
 *   weights. It renders what it is told and calls back.
 */

export type WizardStep = {
  key: string;
  /** Shown in the indicator. Short — it sits under a number on a phone. */
  label: string;
};

/**
 * Step 2 of 3, with the steps named.
 *
 * ⚠ A completed step is marked with a tick AND filled, not filled alone.
 *
 *   Colour on its own fails WCAG 1.4.1, and on a 320px phone the three dots are
 *   small enough that a fill difference is genuinely hard to see. The tick is
 *   what makes "done" legible; the fill is what makes it obvious at a glance.
 */
export function WizardProgress({
  steps,
  current,
  onJump,
}: {
  steps: WizardStep[];
  /** Zero-based. */
  current: number;
  /**
   * Tapping a *completed* step goes back to it. Never forward.
   *
   * Jumping ahead would skip the validation that gates Next, so a person could
   * arrive at the last step with the first one empty. Going back is free — the
   * state is all still there, and a form that will not let you re-read what you
   * typed is a form people abandon.
   */
  onJump?: (index: number) => void;
}) {
  const theme = useTheme();

  return (
    <View style={styles.progress}>
      <View style={styles.progressHead}>
        <Text style={[styles.progressCount, { color: theme.primary }]}>
          Step {current + 1} of {steps.length}
        </Text>
        <Text style={[styles.progressLabel, { color: theme.textSecondary }]} numberOfLines={1}>
          {steps[current]?.label ?? ''}
        </Text>
      </View>

      <View style={styles.track}>
        {steps.map((step, index) => {
          const done = index < current;
          const active = index === current;
          const reachable = done && onJump;

          return (
            <Pressable
              key={step.key}
              onPress={reachable ? () => onJump(index) : undefined}
              disabled={!reachable}
              accessibilityRole={reachable ? 'button' : 'text'}
              accessibilityLabel={`Step ${index + 1}, ${step.label}${
                done ? ', completed' : active ? ', current' : ''
              }`}
              style={[styles.segment, reachable ? styles.tappable : null]}>
              <View
                style={[
                  styles.bar,
                  {
                    backgroundColor: done || active ? theme.primary : theme.border,
                  },
                ]}
              />
              <View style={styles.segmentLabel}>
                {done ? (
                  <Check color={theme.primary} size={12} />
                ) : (
                  <Text
                    style={[
                      styles.segmentNumber,
                      { color: active ? theme.primary : theme.textMuted },
                    ]}>
                    {index + 1}
                  </Text>
                )}
                <Text
                  style={[
                    styles.segmentText,
                    { color: active ? theme.text : theme.textMuted },
                    active && font(700),
                  ]}
                  numberOfLines={1}>
                  {step.label}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Back and Next, or Back and the real button.
 *
 * ⚠ Next is never disabled.
 *
 *   The obvious build greys it out until the step validates. That is worse:
 *   a person facing a dead button on a form with eleven fields has to find the
 *   incomplete one themselves, and nothing on screen says which it is. Pressing
 *   Next instead *runs* the validation, marks the offending fields, and scrolls
 *   to the first one — so the control that looks like it should tell you what
 *   is wrong is the control that tells you.
 *
 *   The final submit button is the exception, and it is disabled by the
 *   confirmation checkbox rather than by validation. See `ConfirmCheckbox`.
 */
export function WizardNav({
  onBack,
  onNext,
  nextLabel = 'Next',
  backLabel = 'Back',
  busy,
  /** Rendered instead of Next on the last step. */
  finalAction,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  backLabel?: string;
  busy?: boolean;
  finalAction?: React.ReactNode;
}) {
  return (
    <View style={styles.nav}>
      {finalAction ?? (
        <Button
          label={nextLabel}
          onPress={onNext}
          disabled={busy}
          icon={(color, size) => <ArrowRight color={color} size={size} />}
        />
      )}

      {/*
        Back is rendered only when there is somewhere to go.

        A disabled Back on step one is a control that exists to be refused,
        which teaches people that this form's buttons do not work.
      */}
      {!!onBack && (
        <Button
          label={backLabel}
          variant="secondary"
          onPress={onBack}
          disabled={busy}
          icon={(color, size) => <ArrowLeft color={color} size={size} />}
        />
      )}
    </View>
  );
}

/**
 * The confirmation above an irreversible button.
 *
 * ⚠ It gates the button, and that is the whole point — but it is a deliberate
 *   piece of friction rather than a safety mechanism.
 *
 *   Nothing here validates anything. Somebody can tick it with a wrong account
 *   number in the form, and the server will still refuse what the server
 *   refuses. What it buys is a moment: the last screen of a long form is where
 *   people stop reading, and one control that cannot be passed by momentum is
 *   the cheapest way to make somebody look at what they are about to submit.
 *
 *   So the label states what is being confirmed rather than saying "I agree".
 */
export function ConfirmCheckbox({
  checked,
  onChange,
  label,
  disabled,
  compact = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /**
   * Tighter, for a narrow action column rather than the foot of a form.
   *
   * ⚠ A variant rather than a second checkbox somewhere else.
   *
   *   The admin user list needs one of these inside a right-aligned column of
   *   pill buttons, where the full-width version wraps badly. Hand-rolling a
   *   small one there would make four checkboxes in this app, three of which
   *   share a look by coincidence — and the next person restyling the tick
   *   would fix three of them.
   */
  compact?: boolean;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={() => onChange(!checked)}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.confirm,
        compact && styles.confirmCompact,
        styles.tappable,
        {
          backgroundColor: checked ? theme.primarySoft : theme.surfaceMuted,
          borderColor: checked ? theme.primary : theme.border,
        },
        pressed && styles.pressed,
      ]}>
      <View
        style={[
          styles.box,
          compact && styles.boxCompact,
          {
            backgroundColor: checked ? theme.primary : theme.surface,
            borderColor: checked ? theme.primary : theme.borderStrong,
          },
        ]}>
        {checked && <Check color={theme.primaryText} size={compact ? 11 : 14} />}
      </View>

      <Text
        style={[
          styles.confirmText,
          compact && styles.confirmTextCompact,
          { color: checked ? theme.primaryOnSoft : theme.text },
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  progress: {
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  progressHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
  progressCount: {
    ...Typography.caption,
    ...font(700),
    letterSpacing: 0.4,
  },
  progressLabel: {
    ...Typography.caption,
    flex: 1,
  },
  track: {
    flexDirection: 'row',
    gap: Spacing.one + 2,
  },
  segment: {
    flex: 1,
    gap: Spacing.one,
  },
  /**
   * 3px rather than a hairline: at 1px this renders sub-pixel on a 2x screen
   * and reads as a grey smear rather than a progress bar. Same reasoning as the
   * nav underline in `app-nav-bar.tsx`.
   */
  bar: {
    height: 3,
    borderRadius: 2,
  },
  segmentLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  segmentNumber: {
    fontSize: FontSize.micro,
    ...font(700),
  },
  segmentText: {
    fontSize: FontSize.micro,
    flex: 1,
  },
  nav: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  confirm: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two + 2,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: Spacing.two,
  },
  confirmCompact: {
    alignItems: 'center',
    gap: Spacing.one + 2,
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    marginTop: 0,
  },
  boxCompact: {
    width: 16,
    height: 16,
    borderWidth: 1.25,
  },
  confirmTextCompact: {
    /*
     * ⚠ Not `flex: 1` here.
     *
     *   The full-width version fills its row; this one sits in a column that
     *   sizes to its widest child, and stretching would make the whole action
     *   column as wide as this label.
     */
    flex: 0,
    ...Typography.caption,
    lineHeight: 16,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: Radius.sm - 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmText: {
    flex: 1,
    ...Typography.caption,
    lineHeight: 19,
  },
  tappable: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  pressed: { opacity: 0.7 },
});
