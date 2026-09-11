import { useRouter } from 'expo-router';
import { Check, ChevronRight, LogOut, PackagePlus, Truck, UserRound, X } from 'lucide-react-native';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { buildLabel } from '@/lib/build-info';
import { showToast } from '@/components/ui/toast';
import { Elevation, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useExperience } from '@/hooks/use-experience';
import { EXPERIENCE_HOME } from '@/lib/experience';
import { useSession, type SessionRole } from '@/store/session';

/**
 * The settings sheet behind the gear icon.
 *
 * Holds the things about *you* rather than the things you can navigate to:
 * which interface you are in, who you are signed in as, and the way out.
 *
 * Switching view is here rather than as a segmented control in the nav bar
 * because it belongs to the account, not to the page — and because two controls
 * doing the same thing is how they end up disagreeing. The old toggle is gone.
 */
export function SettingsMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const router = useRouter();
  const experience = useExperience();

  const { user, isAuthenticated, isApprovedDriver, isAdmin, role, setRole, signOut } = useSession();

  /**
   * Only someone who is genuinely both sees the choice.
   *
   * On web there is one interface, so a switch there would change nothing
   * visible and read as broken.
   */
  const canSwitch = isApprovedDriver && experience !== 'web';

  const choose = (next: SessionRole) => {
    if (next === role) return onClose();

    setRole(next);
    onClose();

    /*
     * Go to the new interface's home rather than staying put.
     *
     * The route guard would move them anyway — the screen they are on may not
     * exist on the other side — but doing it here means the transition reads as
     * "I switched and arrived", not "I switched and something threw me
     * somewhere". `replace`, so back does not return to a screen the new view
     * does not have.
     */
    router.replace(EXPERIENCE_HOME[next === 'driver' ? 'driver' : 'sender'] as '/');

    showToast(next === 'driver' ? 'Driver view' : 'Sender view', {
      message:
        next === 'driver'
          ? 'Showing your deliveries and the open job board.'
          : 'Showing sending and tracking. Switch back any time.',
    });
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close settings">
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, shadowColor: theme.shadow },
            Elevation.raised,
          ]}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: theme.text }]}>Settings</Text>
              {/*
                ⚠ Nothing here when signed in.

                  This used to print the email address, which the account card
                  below then printed again a few pixels later. Signed *out* is
                  different: there is no card, and "Not signed in" is the one
                  thing somebody wondering why the menu looks empty needs.
              */}
              {!isAuthenticated && (
                <Text style={[styles.subtitle, { color: theme.textMuted }]} numberOfLines={1}>
                  Not signed in
                </Text>
              )}
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityLabel="Close"
              style={[styles.close, { backgroundColor: theme.surfaceMuted }]}>
              <X color={theme.textSecondary} size={18} />
            </Pressable>
          </View>

          <ScrollView style={styles.body}>
            {canSwitch && (
              <>
                <Text style={[styles.label, { color: theme.textSecondary }]}>Active view</Text>

                <ViewOption
                  label="Sender"
                  description="Send a parcel, track it, see what you have sent."
                  icon={(color) => <PackagePlus color={color} size={18} />}
                  selected={role === 'sender'}
                  onPress={() => choose('sender')}
                />
                <ViewOption
                  label="Driver"
                  description="Your deliveries, and the open job board."
                  icon={(color) => <Truck color={color} size={18} />}
                  selected={role === 'driver'}
                  onPress={() => choose('driver')}
                />

                <Text style={[styles.hint, { color: theme.textMuted }]}>
                  Switching takes effect immediately — no need to sign out. Your choice is
                  remembered on this device.
                </Text>
              </>
            )}

            {/*
              Said plainly to an approved driver on the web dashboard, who would
              otherwise wonder where the switch went.
            */}
            {isApprovedDriver && experience === 'web' && (
              <View style={[styles.note, { backgroundColor: theme.primarySoft }]}>
                <Text style={[styles.noteText, { color: theme.primaryOnSoft }]}>
                  The web dashboard shows sending and driving together, so there is nothing to
                  switch between. The choice appears in the mobile app.
                </Text>
              </View>
            )}

            {isAuthenticated && (
              <>
                <Text style={[styles.label, { color: theme.textSecondary }]}>Account</Text>

                {/*
                  ⚠ One card, where there were two rows saying the same thing.

                    An identity row printed the name over the email, and a
                    separate link underneath said "Profile & account details".
                    Between them and the header they stated the email twice and
                    gave the reader two targets for one destination. Merged, the
                    identity *is* the button — which is also what makes the
                    whole thing one tap rather than a small one.

                  ⚠ The helper text names what is actually on that screen.

                    The wording asked for was "personal info, NIN &
                    preferences". There are no preferences in Package Relay, and the
                    NIN was not on the profile screen until this change put it
                    there. Copy is a promise about where a tap leads, and the
                    cheapest way to keep it was to add the row.
                */}
                <Pressable
                  onPress={() => {
                    onClose();
                    router.push('/profile');
                  }}
                  accessibilityRole="link"
                  accessibilityLabel={`${user?.name ?? 'Your account'} — open your profile`}
                  style={({ pressed }) => [
                    styles.accountCard,
                    { borderColor: theme.border },
                    pressed && { backgroundColor: theme.surfaceMuted },
                  ]}>
                  <View style={[styles.avatar, { backgroundColor: theme.primarySoft }]}>
                    <UserRound color={theme.primaryOnSoft} size={20} />
                  </View>

                  <View style={styles.optionText}>
                    <Text style={[styles.optionLabel, { color: theme.text }]} numberOfLines={1}>
                      {user?.name ?? 'Your account'}
                    </Text>
                    <Text
                      style={[styles.optionDescription, { color: theme.textMuted }]}
                      numberOfLines={1}>
                      View personal info, NIN and verification
                    </Text>
                  </View>

                  {/*
                    Kept from the row this replaced. "Admin" and "Approved
                    driver" are the fastest way for somebody to confirm which
                    account they are signed in as on a shared device.
                  */}
                  {(isAdmin || isApprovedDriver) && (
                    <Badge
                      label={isAdmin ? 'Admin' : 'Approved driver'}
                      tone="primary"
                      uppercase={false}
                    />
                  )}

                  <ChevronRight color={theme.textMuted} size={18} />
                </Pressable>

                {/*
                  Its own block, with air above it. Sign Out sitting flush
                  under the account card reads as part of it, and the one
                  irreversible action in this menu should not be a neighbour of
                  the one people open it for.
                */}
                <View style={styles.signOutBlock}>
                  <Pressable
                    onPress={() => {
                      onClose();
                      void signOut();
                      showToast('Signed out', {
                        message: 'You can browse Package Relay without an account.',
                      });
                      router.replace('/');
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Sign out"
                    style={({ pressed }) => [
                      styles.option,
                      { borderColor: theme.border },
                      pressed && { backgroundColor: theme.surfaceMuted },
                    ]}>
                    <LogOut color={theme.danger} size={18} />
                    <Text style={[styles.optionLabel, { color: theme.danger }]}>Sign out</Text>
                  </Pressable>
                </View>
              </>
            )}

            {!isAuthenticated && (
              <Pressable
                onPress={() => {
                  onClose();
                  router.push('/sign-in');
                }}
                accessibilityRole="link"
                style={({ pressed }) => [
                  styles.option,
                  { borderColor: theme.border },
                  pressed && { backgroundColor: theme.surfaceMuted },
                ]}>
                <UserRound color={theme.primary} size={18} />
                <Text style={[styles.optionLabel, { color: theme.primary }]}>
                  Sign in or create an account
                </Text>
              </Pressable>
            )}

            {/*
              The build, spelled out.

              A tester's report is only actionable if it names the artefact it
              came from — four builds can be in circulation at once during a
              test round, and "it crashes on my phone" fits all of them. This is
              the line we ask people to copy into a bug report.
            */}
            <Text style={[styles.buildLine, { color: theme.textMuted }]} selectable>
              PKRELAY {buildLabel()}
            </Text>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ViewOption({
  label,
  description,
  icon,
  selected,
  onPress,
}: {
  label: string;
  description: string;
  icon: (color: string) => React.ReactNode;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label} view. ${description}`}
      style={({ pressed }) => [
        styles.option,
        {
          borderColor: selected ? theme.primary : theme.border,
          backgroundColor: selected ? theme.primarySoft : 'transparent',
        },
        pressed && { opacity: 0.7 },
      ]}>
      {icon(selected ? theme.primaryOnSoft : theme.textSecondary)}
      <View style={styles.optionText}>
        <Text
          style={[
            styles.optionLabel,
            { color: selected ? theme.primaryOnSoft : theme.text },
            selected && font(700),
          ]}>
          {label}
        </Text>
        <Text style={[styles.optionDescription, { color: theme.textMuted }]}>{description}</Text>
      </View>
      {/*
        A tick as well as the fill and the ring. The tinted background is
        1.15:1 against the sheet — nowhere near enough to carry the state on
        its own, and colour alone fails WCAG 1.4.1 regardless.
      */}
      {selected && <Check color={theme.primary} size={18} />}
    </Pressable>
  );
}

/*
 * `Row` lived here: a non-interactive name-over-email line above a separate
 * "Profile & account details" link. The account card replaced both — it shows
 * the identity *and* is the way in, so a passive row displaying the same
 * fields had nothing left to do.
 */

const styles = StyleSheet.create({
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signOutBlock: {
    marginTop: Spacing.three,
  },
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '85%',
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
    paddingBottom: Spacing.three,
  },
  headerText: {
    flex: 1,
    gap: Spacing.half,
  },
  title: {
    ...Typography.sectionTitle,
  },
  subtitle: {
    ...Typography.caption,
  },
  close: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
  },
  label: {
    ...Typography.caption,
    ...font(700),
    marginTop: Spacing.two,
    marginBottom: Spacing.two,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    borderWidth: 1,
    marginBottom: Spacing.two,
  },
  optionText: {
    flex: 1,
    gap: Spacing.half,
  },
  optionLabel: {
    ...Typography.meta,
    ...font(600),
  },
  optionDescription: {
    ...Typography.caption,
    lineHeight: 17,
  },
  hint: {
    ...Typography.caption,
    lineHeight: 17,
    marginBottom: Spacing.three,
  },
  note: {
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    marginTop: Spacing.two,
    marginBottom: Spacing.two,
  },
  buildLine: {
    ...Typography.caption,
    textAlign: 'center',
    marginTop: Spacing.three,
  },
  noteText: {
    ...Typography.caption,
    lineHeight: 18,
  },
});
