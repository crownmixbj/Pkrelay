import { AdminShell } from '@/components/ui/admin-shell';
import { IdentityReviewPanel } from '@/components/ui/identity-review-panel';

/**
 * Sender ID Review.
 *
 * ⚠ Its own route rather than a tab inside the driver console, and the reason
 *   is not tidiness.
 *
 *   It shipped as a fourth chip beside Overview, Dispatch and Driver review —
 *   which made one control mean two unrelated things. Those three are the
 *   driver console: is anything wrong, do I dispatch by hand, who is waiting to
 *   be let in as a driver. Sender IDs is a customer support queue on a
 *   different rhythm, worked by potentially different people, and it inherited
 *   the driver console's furniture including a subtitle promising a review
 *   window the Drivers page makes and this page does not.
 *
 *   User & Role Mgmt., Hubs & Operations and System Logs are already separate
 *   routes for the same reason. This is that list catching up.
 *
 * ⚠ `AdminShell` is the guard, and it is a courtesy.
 *
 *   It hides the screen from a non-admin and sends a signed-out visitor to sign
 *   in. What actually refuses the data is `is_admin()` inside
 *   `admin_identity_queue` and `admin_review_identity` — see
 *   `41_sender_identity_review.sql`. Somebody who navigates here directly gets
 *   an empty list, not somebody else's NIN.
 */
export default function AdminIdentityScreen() {
  return (
    <AdminShell
      title="Sender ID Review"
      /*
       * ⚠ Says what is waiting, not how fast it will be dealt with.
       *
       *   The tab version read "Review within 7 working days, as the Drivers
       *   page promises" — copy that fell through from the driver queue's
       *   header. LOCI makes that promise to driver applicants on the Drivers
       *   page. It has never made it to a sender about their ID, and a screen
       *   that invents a commitment is one support has to defend.
       */
      subtitle="NIN and selfie checks that need a person to decide."
      next="/admin-identity">
      <IdentityReviewPanel />
    </AdminShell>
  );
}
