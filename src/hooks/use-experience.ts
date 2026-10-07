import { Platform } from 'react-native';

import { resolveExperience, type Experience } from '@/lib/experience';
import { useSession } from '@/store/session';

/**
 * The interface this person is currently in, or null while auth is restoring.
 *
 * A hook rather than a context: it derives entirely from `useSession`, which is
 * already a context. Wrapping it in a second provider would add a second copy
 * of the same state that can lag behind the first.
 */
export function useExperience(): Experience | null {
  const { permissionsKnown, isAuthenticated, isApprovedDriver, role } = useSession();

  return resolveExperience({
    platform: Platform.OS,
    accessLoading: !permissionsKnown,
    isAuthenticated,
    isApprovedDriver,
    role,
  });
}

/** Convenience for the common branch. False while still loading. */
export function useIsDriverApp(): boolean {
  return useExperience() === 'driver';
}

export function useIsWeb(): boolean {
  return useExperience() === 'web';
}
