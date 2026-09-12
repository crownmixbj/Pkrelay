import { useRouter } from 'expo-router';
import { Cookie, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { Button } from '@/components/ui/button';
import {
  CONSENT_CATEGORIES,
  CONSENT_STORAGE_KEY,
  acceptAll,
  consentApplies,
  consentNeeded,
  currentConsent,
  essentialOnly,
  saveConsent,
  shouldAsk,
  type ConsentChoices,
} from '@/lib/consent';
import {
  Elevation,
  MaxContentWidth,
  Radius,
  Spacing,
  Typography,
  font,
} from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * The cookie banner, and the preferences behind it.
 *
 * ⚠ Web only, and it renders nothing until an effect has run.
 *
 *   `app.json` sets `web.output: "static"`, so every route is rendered in Node
 *   first. Reading `localStorage` during render would throw there — the failure
 *   that took the dev server down in `lib/supabase.ts` — and even a safe read
 *   would produce server HTML that disagrees with the client's first paint,
 *   which React reports as a hydration mismatch. Starting at `hidden` and
 *   deciding in an effect avoids both, and has the side benefit that somebody
 *   who already answered never sees a flash of the banner.
 *
 * ⚠ Rejecting is one tap, in a button the same size and shape as accepting.
 *
 *   This is the detail regulators have actually fined people over: CNIL's cases
 *   against Google and Meta in 2022 turned on refusal taking more clicks than
 *   acceptance, not on the wording. "Accept all" and "Essential only" sit side
 *   by side here, same height, same weight, both solid controls — `secondary`
 *   in this design system is an outlined button, not a text link.
 *
 *   If your DPO wants strict visual parity rather than equal prominence, make
 *   both `variant="primary"`. That is a call for them, not for this file.
 *
 * ⚠ There is no dismiss control, deliberately.
 *
 *   Closing a banner is not consent (EDPB Guidelines 05/2020), so an X would
 *   have to mean "essential only" — at which point it is a third, unlabelled
 *   way of doing what the labelled button already does, and the one people
 *   click without reading. The banner does not block the page, so nothing is
 *   held hostage while it is up.
 */

/* --------------------------------------------------------------- reopening -- */

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Reopens the preferences panel from anywhere — the footer link uses this.
 *
 * ⚠ Not a nicety. Withdrawing consent has to be as easy as giving it
 *   (GDPR Art. 7(3)), and a banner that never comes back makes "yes" a
 *   one-way door. Without a route back to this panel the rest of the
 *   implementation does not comply, however correct it is.
 */
export function openCookiePreferences(): void {
  for (const listener of [...listeners]) listener();
}

/** Whether to show a "Cookie preferences" entry point at all. */
export const cookiePreferencesAvailable = (): boolean => consentApplies() && consentNeeded();

/* ------------------------------------------------------------------ banner -- */

type Mode = 'hidden' | 'banner' | 'preferences';

export function CookieBanner() {
  const theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [mode, setMode] = useState<Mode>('hidden');
  const [draft, setDraft] = useState<ConsentChoices>(essentialOnly);
  const [writeFailed, setWriteFailed] = useState(false);

  /** Below this the two consent buttons stack rather than shrink below a thumb. */
  const narrow = width < 560;

  useEffect(() => {
    if (!consentApplies() || !consentNeeded()) return;

    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    } catch {
      /* Storage blocked. Treated as no answer, which asks rather than assumes. */
    }

    if (shouldAsk(raw)) {
      setDraft(essentialOnly());
      setMode('banner');
    }
  }, []);

  useEffect(() => {
    const listener = () => {
      /*
       * Reopening starts from what is actually stored, not from the defaults.
       * Someone checking what they agreed to must see their own answer; showing
       * them everything off would read as their choice having been discarded.
       */
      setDraft({ ...currentConsent() });
      setWriteFailed(false);
      setMode('preferences');
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const commit = useCallback((choices: ConsentChoices) => {
    const ok = saveConsent(choices);
    if (ok) {
      setMode('hidden');
      return;
    }
    /*
     * The choice governs this page view either way — `saveConsent` has already
     * told the gate. But it will be asked again next load, and saying so is
     * better than a banner that mysteriously returns.
     */
    setWriteFailed(true);
  }, []);

  const openPrivacy = useCallback(() => {
    router.navigate('/legal?section=privacy');
  }, [router]);

  if (mode === 'hidden') return null;

  const privacyLink = (
    <Pressable onPress={openPrivacy} accessibilityRole="link" hitSlop={6}>
      <Text style={[styles.link, { color: theme.primary }]}>Read our Privacy Policy</Text>
    </Pressable>
  );

  const failureNote = writeFailed ? (
    <Text style={[styles.note, { color: theme.warningOnSoft }]}>
      Your choice applies to this visit, but your browser would not let us save it — you will be
      asked again next time.
    </Text>
  ) : null;

  /* ------------------------------------------------------------ preferences -- */

  if (mode === 'preferences') {
    return (
      <Modal
        visible
        transparent
        animationType="fade"
        /* Android hardware back is a dismissal, which is not consent: it closes
           back to the banner rather than granting or denying anything. */
        onRequestClose={() => setMode('banner')}
        accessibilityViewIsModal>
        <View style={styles.scrim}>
          <View
            accessibilityLabel="Cookie preferences"
            style={[
              styles.panel,
              Elevation.raised,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}>
            <View style={styles.panelHead}>
              <Text style={[styles.heading, { color: NAVY }]}>Cookie preferences</Text>
              <Pressable
                onPress={() => setMode('banner')}
                accessibilityRole="button"
                accessibilityLabel="Close preferences without saving"
                hitSlop={10}>
                <X color={theme.textMuted} size={20} />
              </Pressable>
            </View>

            <ScrollView style={styles.panelBody} contentContainerStyle={styles.panelBodyContent}>
              {CONSENT_CATEGORIES.filter((category) => category.enabled).map((category) => (
                <View
                  key={category.id}
                  style={[styles.categoryRow, { borderColor: theme.border }]}>
                  <View style={styles.categoryText}>
                    <Text style={[styles.categoryLabel, { color: theme.text }]}>
                      {category.label}
                      {category.required ? ' · always on' : ''}
                    </Text>
                    <Text style={[styles.categoryBody, { color: theme.textSecondary }]}>
                      {category.description}
                    </Text>
                  </View>
                  <Switch
                    value={category.required ? true : draft[category.id] === true}
                    disabled={category.required}
                    onValueChange={(next) =>
                      setDraft((prev) => ({ ...prev, [category.id]: next }))
                    }
                    accessibilityLabel={`${category.label} cookies`}
                    trackColor={{ false: theme.borderStrong, true: theme.primary }}
                    thumbColor={Platform.OS === 'android' ? theme.surface : undefined}
                  />
                </View>
              ))}

              {privacyLink}
              {failureNote}
            </ScrollView>

            <View style={[styles.panelActions, narrow && styles.actionsStacked]}>
              <Button
                label="Save preferences"
                size="md"
                onPress={() => commit(draft)}
                style={styles.action}
              />
              <Button
                label="Accept all"
                variant="secondary"
                size="md"
                onPress={() => commit(acceptAll())}
                style={styles.action}
              />
            </View>
          </View>
        </View>
      </Modal>
    );
  }

  /* ----------------------------------------------------------------- banner -- */

  return (
    <View
      accessibilityLabel="Cookie notice"
      style={[
        styles.bar,
        Elevation.raised,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}>
      <View style={styles.barInner}>
        <View style={styles.message}>
          <View style={styles.messageHead}>
            <Cookie color={NAVY} size={18} />
            <Text style={[styles.heading, { color: NAVY }]}>Cookies on Package Relay</Text>
          </View>

          {/*
            ⚠ "would also like to", not "we use".

              Package Relay sets no analytics storage today — see the header of
              lib/consent.ts. A notice describing tracking that does not exist
              is a false statement in the document a regulator reads first.
          */}
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            We use essential cookies to keep you signed in, hold a half-finished booking, and
            remember this choice. We would also like to use analytics cookies to see which pages
            people struggle on — only if you agree. You can change your mind at any time.
          </Text>

          {privacyLink}
          {failureNote}
        </View>

        <View style={styles.barActions}>
          {/*
            Equal size, side by side, both solid. See the header — this is the
            arrangement the CNIL cases were about.
          */}
          <View style={[styles.choices, narrow && styles.actionsStacked]}>
            <Button
              label="Accept all"
              size="md"
              onPress={() => commit(acceptAll())}
              style={styles.action}
            />
            <Button
              label="Essential only"
              variant="secondary"
              size="md"
              onPress={() => commit(essentialOnly())}
              style={styles.action}
            />
          </View>

          <Pressable
            onPress={() => {
              setDraft({ ...currentConsent() });
              setMode('preferences');
            }}
            accessibilityRole="button"
            hitSlop={6}
            style={({ pressed }) => [styles.manage, pressed && styles.pressed]}>
            <Text style={[styles.manageText, { color: theme.primary }]}>Manage preferences</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/**
 * The brand navy, matching the nav links.
 *
 * Taken from `app-nav-bar.tsx` rather than the palette because the palette has
 * no navy token — it measures 11.2:1 on the white surface, which is the reason
 * that file uses it for text too. The banner keeps a light surface rather than
 * inverting to a navy panel: every foreground token in `theme.ts` is defined
 * against light backgrounds, and a one-off dark region would need each of them
 * re-checked for contrast rather than reused.
 */
const NAVY = '#0B3C5D';

const styles = StyleSheet.create({
  /*
   * `absolute`, not `fixed`. On web, React Native maps absolute onto the root
   * view, which is what we want here; `fixed` is not a valid React Native
   * value. `toast.tsx` makes the same call for the same reason.
   */
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.four,
  },
  barInner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.three,
  },
  message: {
    gap: Spacing.two,
  },
  messageHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  heading: {
    ...Typography.sectionTitle,
  },
  body: {
    ...Typography.meta,
  },
  link: {
    ...Typography.meta,
    ...font(600),
    textDecorationLine: 'underline',
  },
  note: {
    ...Typography.caption,
  },
  barActions: {
    gap: Spacing.two,
  },
  choices: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionsStacked: {
    flexDirection: 'column',
  },
  /* Equal width as well as equal height — prominence is the whole point. */
  action: {
    flex: 1,
  },
  manage: {
    alignSelf: 'flex-start',
    paddingVertical: Spacing.one,
    minHeight: 44,
    justifyContent: 'center',
  },
  manageText: {
    ...Typography.button,
    textDecorationLine: 'underline',
  },
  pressed: {
    opacity: 0.6,
  },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  panel: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '85%',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  panelHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: Spacing.three,
    gap: Spacing.three,
  },
  panelBody: {
    flexGrow: 0,
  },
  panelBodyContent: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
    gap: Spacing.three,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
    paddingTop: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  categoryText: {
    flex: 1,
    gap: Spacing.one,
  },
  categoryLabel: {
    ...Typography.cardTitle,
  },
  categoryBody: {
    ...Typography.caption,
  },
  panelActions: {
    flexDirection: 'row',
    gap: Spacing.two,
    padding: Spacing.three,
  },
});
