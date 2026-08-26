import { buildLabel } from '@/lib/build-info';
import { restEndpoint } from '@/lib/supabase';
import { probePlacesLookup } from '@/store/places';
import { CAPABILITIES } from '@/lib/schema-gap';

/**
 * Whether the thing you are looking at is the thing that was built.
 *
 * ⚠ This exists because the same misunderstanding has cost three rounds.
 *
 *   A fix ships, the person testing it opens the app, the old behaviour is
 *   still there, and it is reported as still broken. Every time, the code was
 *   right and one of two things was stale: the bundle on the device, or the
 *   schema in the database. Nothing on screen could tell them apart, so the
 *   only way to find out was another round trip.
 *
 *   There is no EAS Update on this project, so a JS change needs a new binary;
 *   the web build is deployed separately again; and migrations are run by hand.
 *   Three clocks, none of them visible.
 *
 * ⚠ The list of capabilities lives in `lib/schema-gap.ts`, not here.
 *
 *   The same mapping answers two questions — "what is missing" for this panel,
 *   and "which file do I run" for the error a screen shows when it hits a
 *   function that is not there. Two copies would drift, and the copy people
 *   read under pressure is the error message.
 *
 * ⚠ The database half is read from PostgREST's own OpenAPI document, not by
 *   calling the functions.
 *
 *   Calling `admin_reveal_sender_identity` to see whether it exists would write
 *   an audit line saying an administrator looked at somebody's face. A probe
 *   with a side effect is not a probe. The root of `/rest/v1/` lists every
 *   exposed function and changes nothing.
 */

export type Capability = {
  label: string;
  /** The file to run, or the command to deploy. */
  migration: string;
  /** Null when the state could not be read at all. */
  present: boolean | null;
  /** Set when there is something more useful to say than "missing". */
  note?: string;
};

export type Deployment = {
  build: string;
  /** Null when the schema could not be read — a network or key problem. */
  capabilities: Capability[];
  error: string | null;
};

/**
 * Reads the list of functions PostgREST is currently exposing.
 *
 * Returns null rather than throwing: a diagnostics panel that itself fails is
 * worse than one that says it could not tell.
 */
async function exposedFunctions(): Promise<Set<string> | null> {
  const { url, anonKey } = restEndpoint;
  if (!url || !anonKey) return null;

  try {
    const response = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (!response.ok) return null;

    const spec = (await response.json()) as { paths?: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    return new Set(
      paths.filter((path) => path.startsWith('/rpc/')).map((path) => path.slice('/rpc/'.length)),
    );
  } catch {
    return null;
  }
}

/*
 * ⚠ Edge functions are not in PostgREST's list, so they need their own probe.
 *
 *   `places-lookup` refuses a one-character input before it builds a Google
 *   request, which makes asking it whether it is alive free. Without this the
 *   panel could say the database was complete while the one thing somebody was
 *   actually looking at — address search — was not deployed at all.
 */
async function placesCapability(): Promise<Capability> {
  const reason = await probePlacesLookup();

  if (reason === null) {
    return { label: 'Address search', migration: 'places-lookup', present: true };
  }

  return {
    label: 'Address search',
    migration: 'places-lookup',
    present: false,
    note:
      reason === 'not-configured'
        ? 'Deployed, but GOOGLE_PLACES_KEY is not set'
        : 'Not deployed, or unreachable from here',
  };
}

export async function fetchDeployment(): Promise<Deployment> {
  const [exposed, places] = await Promise.all([exposedFunctions(), placesCapability()]);

  return {
    build: buildLabel(),
    capabilities: [
      ...CAPABILITIES.map(({ label, fn, migration }) => ({
        label,
        migration,
        present: exposed ? exposed.has(fn) : null,
      })),
      places,
    ],
    error: exposed ? null : 'The database schema could not be read from here.',
  };
}

/** How many migrations are missing, for the one-line summary. */
export function missingCount(capabilities: Capability[]): number {
  return capabilities.filter((capability) => capability.present === false).length;
}
