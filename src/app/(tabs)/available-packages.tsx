import { ScrollView, StyleSheet, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { JourneyPlanner } from '@/components/ui/journey-planner';
import { screenPadding, ScreenHeader } from '@/components/ui/screen';
import { MaxContentWidth, Spacing } from '@/constants/theme';

/**
 * Schedule My Journey — where a driver declares what they are doing.
 *
 * This screen used to be two things: the journey planner, and below it an open
 * marketplace of unmatched parcels with an Accept Order button on each. The
 * board is gone, and its absence is the feature.
 *
 * ⚠ Why browsing was removed rather than kept as a fallback.
 *
 *   The two ways of getting work were not equal and could not co-exist quietly.
 *   An offer is exclusive for its window — one live offer per parcel is a unique
 *   index — while the board was first-come. So a parcel could be held for a
 *   driver who was reading its countdown and simultaneously claimed out from
 *   under them by somebody scrolling a list. The offer's guarantee was only ever
 *   true if nobody used the board.
 *
 *   It also made the two modes indistinguishable in practice. Flash exists so a
 *   driver sitting in one city gets local parcels pushed to them; a board that
 *   listed those same parcels made Flash an opt-in nicety on top of a
 *   marketplace rather than the mechanism.
 *
 * ⚠ And what that cost, which is real.
 *
 *   The board was the only thing that still moved parcels when dispatch broke,
 *   and dispatch has broken twice. The replacement is `admin_assign_parcel`
 *   (20250101000025_dispatch_only.sql) — one audited human path, held by an admin, rather
 *   than an open list every driver can work around the matcher with.
 *
 * Nothing here fetches parcels any more. A driver's work reaches them on
 * Assigned Trip, as a timed offer, or not at all.
 */
export default function ScheduleMyJourneyScreen() {
  return (
    <ScrollView
      style={styles.screen}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        <ScreenHeader
          brand={false}
          title="Setup Trip"
          subtitle="Tell Package Relay where you are going and parcels on that route are offered to you automatically."
        />

        <JourneyPlanner />
      </View>
      <Footer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  /*
    ⚠ The house container, which this screen had lost.

      Every other route — book, tracking, locations, support, driver-signup,
      driver-updates, parcel detail — centres its content at `MaxContentWidth`.
      This screen did too until I rewrote it to strip the marketplace board and
      did not carry the constraint across, so on a desktop the form stretched
      the full viewport: a "To" dropdown a thousand pixels wide, and a caveat
      line nobody can track back to its own left margin.

      A form field wider than about 800px is not a style preference. Line length
      and target size are the two things every desktop form convention agrees
      on, and an input that spans the window fails both.
  */
  container: { flexGrow: 1, alignItems: 'center', paddingBottom: Spacing.six },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.four,
  },
});
