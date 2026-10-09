import { Pressable, StyleSheet, Text, type PressableProps } from 'react-native';

import { Elevation, Radius, Spacing, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ButtonProps = Omit<PressableProps, 'style' | 'children'> & {
  label: string;
  /** Leading icon; receives the resolved label color so it always matches. */
  icon?: (color: string, size: number) => React.ReactNode;
  variant?: 'primary' | 'secondary';
  size?: 'md' | 'lg';
  style?: PressableProps['style'];
};

export function Button({
  label,
  icon,
  variant = 'primary',
  size = 'lg',
  style,
  disabled,
  ...rest
}: ButtonProps) {
  const theme = useTheme();

  const isPrimary = variant === 'primary';
  const iconSize = size === 'lg' ? 20 : 18;

  /*
   * Disabled gets its own colours rather than `opacity: 0.5`.
   *
   * Fading the whole button fades the label with it: measured, white on the
   * half-faded primary blue is 2.09:1, which is not "greyed out" so much as
   * "gone". WCAG 1.4.3 exempts inactive controls, but a disabled button whose
   * label states *why* it is disabled has to stay readable — that label is the
   * explanation. The muted pair below is 9.45:1.
   */
  const labelColor = disabled ? theme.textSecondary : isPrimary ? theme.primaryText : theme.primary;

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={(state) => [
        styles.base,
        size === 'lg' ? styles.lg : styles.md,
        {
          backgroundColor: disabled
            ? theme.surfaceMuted
            : isPrimary
              ? state.pressed
                ? theme.primaryPressed
                : theme.primary
              : state.pressed
                ? theme.backgroundSelected
                : theme.surface,
          borderColor: disabled ? theme.border : isPrimary ? 'transparent' : theme.borderStrong,
          /*
            A primary button casts its own colour, not a grey.

            The ink-coloured shadow every other surface uses reads as dirt under
            a saturated fill; tinting it to the fill is what makes the button
            sit on the page rather than on top of it. Secondary and disabled
            keep the neutral shadow — they are surfaces, not actions.
          */
          shadowColor: disabled ? theme.shadow : isPrimary ? theme.primary : theme.shadow,
        },
        // No lift on a button that does nothing.
        isPrimary && !disabled && Elevation.card,
        typeof style === 'function' ? style(state) : style,
      ]}
      {...rest}>
      {icon?.(labelColor, iconSize)}
      <Text style={[styles.label, { color: labelColor }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  lg: {
    height: 54,
    paddingHorizontal: Spacing.four,
  },
  md: {
    height: 44,
    paddingHorizontal: Spacing.three,
  },
  label: {
    ...Typography.button,
  },
});
