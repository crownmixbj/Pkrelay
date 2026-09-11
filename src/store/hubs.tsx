import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { errorMessage } from '@/lib/errors';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { SEED_HUBS, type Hub } from '@/constants/hubs';
import { parseHours } from '@/constants/hub-hours';
import type { City } from '@/store/bookings';

/**
 * The live hub network.
 *
 * Hubs used to be a constant compiled into the app, which meant correcting a
 * wrong address needed a deploy — and the Hubs & Operations screen had to
 * admit it could not edit anything. They now live in `public.hubs`: readable by
 * everyone, writable only by an admin. See `supabase/migrations/20250101000008_hubs.sql`.
 *
 * The seed array is still the fallback. If Supabase is unconfigured, or the
 * migration has not been run yet, the app shows the original network rather
 * than an empty page — a missing table should not make the Hubs page look like
 * Package Relay has no hubs.
 */

type HubRow = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Null-safe, because `Number(null)` is 0 — which would silently place every
 * hub without a surveyed position on the equator off the coast of Ghana.
 */
const numberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function rowToHub(row: HubRow): Hub {
  const lat = numberOrNull(row.lat);
  const lng = numberOrNull(row.lng);

  return {
    id: str(row.id),
    name: str(row.name),
    area: str(row.area),
    city: str(row.city) as City,
    address: str(row.address),
    hours: str(row.hours),
    phone: str(row.phone),
    services: Array.isArray(row.services) ? (row.services as string[]) : [],
    flagship: Boolean(row.flagship),
    active: row.active === undefined ? true : Boolean(row.active),
    // A stored position is a surveyed one; the neighbourhood fallback lives in
    // `hubPosition` and is labelled approximate there.
    coordinates:
      lat !== null && lng !== null ? { lat, lng, precision: 'exact' as const } : undefined,
  };
}

export type HubEdit = {
  name: string;
  area: string;
  address: string;
  hours: string;
  phone: string;
  services: string[];
  flagship: boolean;
  lat: number | null;
  lng: number | null;
  active: boolean;
};

/**
 * What the app can accept in the `hours` field.
 *
 * Checked before saving rather than after, because the Operating Hours page
 * reads these strings to decide whether a hub is open right now. A string it
 * cannot parse does not break the page — the badge just disappears — which is
 * exactly the kind of failure nobody notices until a driver is standing outside
 * a closed shutter.
 */
export function validateHubEdit(edit: HubEdit): string | null {
  if (!edit.name.trim()) return 'Give the hub a name.';
  if (!edit.area.trim()) return 'Give the hub an area.';
  if (!edit.address.trim()) return 'Give the hub an address.';

  if (!parseHours(edit.hours)) {
    return 'Hours must look like "Mon–Sat, 8:00am – 8:00pm". The Operating Hours page reads this to work out whether the hub is open.';
  }

  // Both or neither. Half a coordinate is not a position, and the database
  // rejects it too — better to say so here than to surface a constraint error.
  if ((edit.lat === null) !== (edit.lng === null)) {
    return 'Enter both a latitude and a longitude, or leave both blank.';
  }

  if (edit.lat !== null && (edit.lat < 3.5 || edit.lat > 14.5)) {
    return 'That latitude is outside Nigeria. Check you have not swapped it with the longitude.';
  }
  if (edit.lng !== null && (edit.lng < 2.5 || edit.lng > 15.5)) {
    return 'That longitude is outside Nigeria. Check you have not swapped it with the latitude.';
  }

  return null;
}

/**
 * A readable id for a new hub, in the same shape as the seeded ones.
 *
 * `lag-4`, `ib-11`. Readable matters because the id is what the audit log
 * prints — "update ib-3: address changed" tells you something, a uuid does not.
 *
 * Derived from the hubs already loaded, so two admins creating a hub in the
 * same city at the same moment can pick the same number. The primary key
 * refuses the second, and the editor keeps the form so it can be retried — a
 * rare collision handled loudly beats a silent uuid nobody can read.
 */
export function nextHubId(hubs: Hub[], city: City): string {
  const prefix =
    ({ Lagos: 'lag', Ibadan: 'ib', Abuja: 'abj', 'Port Harcourt': 'ph' } as Record<string, string>)[
      city
    ] ??
    city
      .toLowerCase()
      .replace(/[^a-z]/g, '')
      .slice(0, 3);

  const used = new Set(
    hubs
      .map((hub) => {
        const match = new RegExp(`^${prefix}-(\\d+)$`).exec(hub.id);
        return match ? Number(match[1]) : null;
      })
      .filter((n): n is number => n !== null),
  );

  let n = 1;
  while (used.has(n)) n += 1;
  return `${prefix}-${n}`;
}

type HubsContextValue = {
  /** Active hubs only — what senders and drivers should be offered. */
  hubs: Hub[];
  /**
   * Every hub including closed ones, for the Admin area.
   *
   * Without this a closed hub would vanish from the admin list too, leaving no
   * way to re-open it short of the SQL editor.
   */
  allHubs: Hub[];
  loading: boolean;
  /** Null unless the load failed. The seed is showing when this is set. */
  error: string | null;
  /** True while the fallback is on screen, so callers can say so. */
  usingSeed: boolean;
  refresh: () => Promise<void>;
  /** Admin-only; the database refuses it for everyone else. */
  updateHub: (id: string, edit: HubEdit) => Promise<void>;
  createHub: (city: City, edit: HubEdit) => Promise<void>;
};

const HubsContext = createContext<HubsContextValue | null>(null);

export function HubsProvider({ children }: { children: ReactNode }) {
  const [allHubs, setAllHubs] = useState<Hub[]>(SEED_HUBS);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);
  const [usingSeed, setUsingSeed] = useState(true);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    try {
      /*
       * No `active` filter here. The admin list needs closed hubs too — the
       * public screens filter them out below instead, so "what senders see" and
       * "what an admin can manage" stay one query apart rather than two round
       * trips.
       */
      const { data, error: thrown } = await supabase
        .from('hubs')
        .select('*')
        .order('city')
        .order('id');

      if (thrown) throw thrown;

      /*
       * An empty table is treated as "not seeded", not as "no hubs". The seed
       * runs in the same migration that creates the table, so empty almost
       * always means something went wrong — and showing nothing would make the
       * public Hubs page claim Package Relay has no network at all.
       */
      if (!data || data.length === 0) {
        setAllHubs(SEED_HUBS);
        setUsingSeed(true);
      } else {
        setAllHubs(data.map(rowToHub));
        setUsingSeed(false);
      }
      setError(null);
    } catch (caught) {
      // See `src/lib/errors.ts`: String() on a Supabase error yields
      // "[object Object]", which the tests below would never match.
      const message = errorMessage(caught, String(caught));
      setAllHubs(SEED_HUBS);
      setUsingSeed(true);
      setError(
        /does not exist|schema cache|relation/i.test(message)
          ? 'Showing the built-in hub list. Run supabase/migrations/20250101000008_hubs.sql to make hubs editable.'
          : message,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateHub = useCallback(
    async (id: string, edit: HubEdit) => {
      const problem = validateHubEdit(edit);
      if (problem) throw new Error(problem);

      const { error: thrown } = await supabase
        .from('hubs')
        .update({
          name: edit.name.trim(),
          area: edit.area.trim(),
          address: edit.address.trim(),
          hours: edit.hours.trim(),
          phone: edit.phone.trim(),
          services: edit.services,
          flagship: edit.flagship,
          lat: edit.lat,
          lng: edit.lng,
          active: edit.active,
          /*
           * `updated_at` and `updated_by` are deliberately not sent. A trigger
           * stamps them from `auth.uid()`, so an edit cannot be attributed to
           * someone else by a client that simply claims a different id.
           */
        })
        .eq('id', id);

      if (thrown) throw thrown;
      await refresh();
    },
    [refresh],
  );

  const createHub = useCallback(
    async (city: City, edit: HubEdit) => {
      const problem = validateHubEdit(edit);
      if (problem) throw new Error(problem);

      const { error: thrown } = await supabase.from('hubs').insert({
        id: nextHubId(allHubs, city),
        city,
        name: edit.name.trim(),
        area: edit.area.trim(),
        address: edit.address.trim(),
        hours: edit.hours.trim(),
        phone: edit.phone.trim(),
        services: edit.services,
        flagship: edit.flagship,
        lat: edit.lat,
        lng: edit.lng,
        active: edit.active,
      });

      if (thrown) throw thrown;
      await refresh();
    },
    [allHubs, refresh],
  );

  /** What the public screens show. A closed hub is not a drop-off option. */
  const hubs = useMemo(() => allHubs.filter((hub) => hub.active !== false), [allHubs]);

  const value = useMemo(
    () => ({ hubs, allHubs, loading, error, usingSeed, refresh, updateHub, createHub }),
    [hubs, allHubs, loading, error, usingSeed, refresh, updateHub, createHub],
  );

  return <HubsContext.Provider value={value}>{children}</HubsContext.Provider>;
}

export function useHubs(): HubsContextValue {
  const context = useContext(HubsContext);
  if (!context) throw new Error('useHubs must be used inside a HubsProvider');
  return context;
}
