import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useExperience } from '@/hooks/use-experience';
import { completionRedirect, redirectFor } from '@/lib/experience';
import { useSession } from '@/store/session';

/**
 * Keeps the person on a route their interface actually has.
 *
 * Mounted once, inside the navigator. Renders nothing — it exists for the
 * effect, which is the only way to redirect after the router has settled
 * without fighting whatever navigation just happened.
 *
 * ⚠ This is not access control. It is the difference between a driver landing
 *   on the booking form and landing on their deliveries. Every real gate is a
 *   Row Level Security policy — see `lib/experience.ts`.
 */
export function ExperienceRouter() {
  const router = useRouter();
  const pathname = usePathname();
  const experience = useExperience();
  const { needsPhone } = useSession();

  /*
   * The last path we sent someone to.
   *
   * Without it, a redirect target that is itself disallowed — a bug, but a
   * cheap one to make — becomes an infinite loop of navigations rather than a
   * single wrong screen. This turns that failure into something visible and
   * survivable.
   */
  const lastRedirect = useRef<string | null>(null);

  useEffect(() => {
    // Null means auth is still restoring. Deciding now would flick an approved
    // driver through the sender home on every cold start.
    if (!experience) return;

    /*
     * ⚠ Checked before the experience rule, because it outranks it.
     *
     *   An account with no phone number is not allowed anywhere the experience
     *   rules would send it. Running them first would bounce somebody to a home
     *   screen and then to this form, which is two navigations to reach one
     *   destination — and on web, two entries in the history somebody has to
     *   press back through.
     */
    const target = completionRedirect(pathname, needsPhone) ?? redirectFor(pathname, experience);
    if (!target) {
      lastRedirect.current = null;
      return;
    }

    if (lastRedirect.current === target) {
      // Already tried this and we are still somewhere disallowed: the rule is
      // wrong, not the navigation. Stop rather than loop.
      return;
    }

    lastRedirect.current = target;
    /*
     * `replace`, not `push`. The route they are leaving does not exist for
     * them, so leaving it on the back stack means the back gesture returns to
     * a screen that immediately redirects again.
     */
    router.replace(target as '/');
  }, [experience, needsPhone, pathname, router]);

  return null;
}
