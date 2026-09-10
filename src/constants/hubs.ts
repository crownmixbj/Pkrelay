import type { City } from '@/store/bookings';

/**
 * The Package Relay partner hub network.
 *
 * Lives here rather than inside the locations screen because the booking form
 * also needs it: choosing "Package Relay hub" as the pickup mode offers these, filtered
 * to the selected city.
 */
export type Hub = {
  id: string;
  name: string;
  area: string;
  city: City;
  address: string;
  hours: string;
  phone: string;
  services: string[];
  /** Flagship hub for that city — surfaced with a badge. */
  flagship?: boolean;
  /**
   * False for a hub that has been closed.
   *
   * Optional so the seed array does not have to repeat `active: true` for every
   * entry; absent means open. Closing rather than deleting is deliberate — a
   * deleted hub would orphan every booking that references it.
   */
  active?: boolean;
  /**
   * Surveyed position of the actual door. Absent for every hub today — see
   * `hubPosition` below, which falls back to the neighbourhood.
   */
  coordinates?: HubPosition;
};

export type HubPosition = {
  lat: number;
  lng: number;
  /**
   * `area` means the pin is the centre of the neighbourhood, not the door.
   * The UI must say so: a pin that looks exact but is 400m out sends someone
   * to the wrong building holding a parcel.
   */
  precision: 'area' | 'exact';
};

/**
 * The network as first written, now only a seed and a fallback.
 *
 * The live list lives in `public.hubs` (see `supabase/migrations/20250101000008_hubs.sql`) so an admin
 * can correct an address without a deploy. This array stays for two reasons:
 * it is what seeds that table, and `store/hubs.tsx` falls back to it when
 * Supabase is unconfigured or the migration has not been run — so the app never
 * shows an empty network because of a missing table.
 *
 * ⚠ Editing this no longer changes what anyone sees. Edit the hub in the Admin
 *   area instead; the seed is `on conflict do nothing` and will not overwrite it.
 */
export const SEED_HUBS: Hub[] = [
  // ---- Lagos ----
  {
    id: 'lag-1',
    name: 'Package Relay Ikeja Hub',
    area: 'Ikeja',
    city: 'Lagos',
    address: '45 Allen Avenue, Ikeja, Lagos',
    hours: 'Mon–Sat, 8:00am – 8:00pm',
    phone: '+2348030001101',
    services: ['Drop-off', 'Collection', 'Packaging'],
    flagship: true,
  },
  {
    id: 'lag-2',
    name: 'Package Relay Yaba Counter',
    area: 'Yaba',
    city: 'Lagos',
    address: '12 Herbert Macaulay Way, Yaba, Lagos',
    hours: 'Mon–Fri, 9:00am – 6:00pm',
    phone: '+2348030001102',
    services: ['Drop-off', 'Collection'],
  },
  {
    id: 'lag-3',
    name: 'Package Relay Lekki Point',
    area: 'Lekki',
    city: 'Lagos',
    address: '3 Admiralty Way, Lekki Phase 1, Lagos',
    hours: 'Mon–Sat, 9:00am – 7:00pm',
    phone: '+2348030001103',
    services: ['Drop-off', 'Collection'],
  },
  // ---- Ibadan ----
  {
    id: 'ib-1',
    name: 'Package Relay Bodija Hub',
    area: 'Bodija',
    city: 'Ibadan',
    address: '18 Awolowo Avenue, Old Bodija, Ibadan',
    hours: 'Mon–Sat, 8:00am – 7:00pm',
    phone: '+2348030002201',
    services: ['Drop-off', 'Collection', 'Packaging'],
    flagship: true,
  },
  {
    id: 'ib-2',
    name: 'Package Relay Dugbe Counter',
    area: 'Dugbe',
    city: 'Ibadan',
    address: '8 Lebanon Street, Dugbe, Ibadan',
    hours: 'Mon–Fri, 9:00am – 6:00pm',
    phone: '+2348030002202',
    services: ['Drop-off', 'Collection'],
  },
  {
    id: 'ib-3',
    name: 'Package Relay Ring Road Point',
    area: 'Ring Road',
    city: 'Ibadan',
    address: '22 Ring Road, Challenge, Ibadan',
    hours: 'Mon–Sat, 8:00am – 8:00pm',
    phone: '+2348030002203',
    services: ['Drop-off'],
  },
  {
    id: 'ib-4',
    name: 'Package Relay Mokola Counter',
    area: 'Mokola',
    city: 'Ibadan',
    address: '5 Mokola Roundabout, Ibadan',
    hours: 'Mon–Sat, 8:00am – 7:00pm',
    phone: '+2348030002204',
    services: ['Drop-off', 'Collection'],
  },
  {
    id: 'ib-5',
    name: 'Package Relay Challenge Point',
    area: 'Challenge',
    city: 'Ibadan',
    address: '31 Challenge Road, Ibadan',
    hours: 'Mon–Sat, 8:00am – 6:00pm',
    phone: '+2348030002205',
    services: ['Drop-off'],
  },
  {
    id: 'ib-6',
    name: 'Package Relay UI/Agbowo Counter',
    area: 'UI/Agbowo',
    city: 'Ibadan',
    address: '2 Agbowo Express, Beside UI Gate, Ibadan',
    hours: 'Mon–Sat, 9:00am – 7:00pm',
    phone: '+2348030002206',
    services: ['Drop-off', 'Collection'],
  },
  {
    id: 'ib-7',
    name: 'Package Relay Iwo Road Hub',
    area: 'Iwo Road',
    city: 'Ibadan',
    address: '9 Iwo Road Interchange, Ibadan',
    hours: 'Mon–Sat, 7:30am – 8:00pm',
    phone: '+2348030002207',
    services: ['Drop-off', 'Collection'],
  },
  {
    id: 'ib-8',
    name: 'Package Relay Apata Counter',
    area: 'Apata',
    city: 'Ibadan',
    address: '16 Apata Ganga Road, Ibadan',
    hours: 'Mon–Fri, 9:00am – 6:00pm',
    phone: '+2348030002208',
    services: ['Drop-off', 'Collection'],
  },
  {
    id: 'ib-9',
    name: 'Package Relay Sango Point',
    area: 'Sango',
    city: 'Ibadan',
    address: '4 Sango–Eleyele Road, Ibadan',
    hours: 'Mon–Sat, 8:00am – 6:00pm',
    phone: '+2348030002209',
    services: ['Drop-off'],
  },
  {
    id: 'ib-10',
    name: 'Package Relay Akobo Counter',
    area: 'Akobo',
    city: 'Ibadan',
    address: '27 Akobo Ojurin Road, Ibadan',
    hours: 'Mon–Fri, 9:00am – 6:00pm',
    phone: '+2348030002210',
    services: ['Drop-off', 'Collection'],
  },
  // ---- Abuja ----
  {
    id: 'abj-1',
    name: 'Package Relay Wuse II Hub',
    area: 'Wuse II',
    city: 'Abuja',
    address: '14 Aminu Kano Crescent, Wuse II, Abuja',
    hours: 'Mon–Sat, 8:00am – 7:00pm',
    phone: '+2348030003301',
    services: ['Drop-off', 'Collection', 'Packaging'],
    flagship: true,
  },
  {
    id: 'abj-2',
    name: 'Package Relay Garki Counter',
    area: 'Garki',
    city: 'Abuja',
    address: '9 Moshood Abiola Way, Garki, Abuja',
    hours: 'Mon–Fri, 9:00am – 6:00pm',
    phone: '+2348030003302',
    services: ['Drop-off', 'Collection'],
  },
  {
    id: 'abj-3',
    name: 'Package Relay Gwarinpa Point',
    area: 'Gwarinpa',
    city: 'Abuja',
    address: '5th Avenue, Gwarinpa Estate, Abuja',
    hours: 'Mon–Sat, 9:00am – 7:00pm',
    phone: '+2348030003303',
    services: ['Drop-off'],
  },
  // ---- Other hubs ----
  {
    id: 'ph-1',
    name: 'Package Relay Port Harcourt Hub',
    area: 'GRA Phase 2',
    city: 'Port Harcourt',
    address: '3 Aba Road, GRA Phase 2, Port Harcourt',
    hours: 'Mon–Fri, 9:00am – 6:00pm',
    phone: '+2348030004401',
    services: ['Drop-off', 'Collection'],
  },
];

/**
 * The three views of the hub network.
 *
 * One screen, not three routes: all three answer questions about the same list
 * and share the city filter, so splitting them would mean re-picking the city
 * every time you moved between them.
 *
 * Carried in the URL as `?section=`, which is what lets the nav submenu open a
 * specific one and what makes a shared link land where the sender meant.
 */
export const HUB_SECTIONS = ['locations', 'map', 'hours'] as const;

export type HubSection = (typeof HUB_SECTIONS)[number];

export const HUB_SECTION_LABELS: Record<HubSection, string> = {
  locations: 'Drop-off / Pickup Locations',
  map: 'Sorting Centers Map',
  hours: 'Operating Hours',
};

/** Short forms, for the on-screen segmented control where the full names won't fit. */
export const HUB_SECTION_SHORT: Record<HubSection, string> = {
  locations: 'Locations',
  map: 'Map',
  hours: 'Hours',
};

/** Anything unrecognised — a stale link, a typo — falls back to the list. */
export function parseHubSection(value: unknown): HubSection {
  return HUB_SECTIONS.includes(value as HubSection) ? (value as HubSection) : 'locations';
}

/**
 * Neighbourhood centres, used until real hub coordinates exist.
 *
 * Kept as a separate table rather than folded into `HUBS` on purpose: these are
 * approximations, and mixing them into the hub records would make invented
 * numbers look as authoritative as the addresses and phone numbers beside them.
 * When a hub is actually surveyed, put the real position on `Hub.coordinates`
 * with `precision: 'exact'` and `hubPosition` will prefer it — no need to touch
 * this table.
 *
 * Accuracy: within a few hundred metres. Good enough to answer "which part of
 * town is this?", not good enough to navigate to. Every consumer must surface
 * the `precision` field.
 */
const AREA_CENTRES: Record<string, { lat: number; lng: number }> = {
  // Lagos
  'lag-1': { lat: 6.6018, lng: 3.3515 }, // Ikeja / Allen Avenue
  'lag-2': { lat: 6.5095, lng: 3.3711 }, // Yaba / Herbert Macaulay
  'lag-3': { lat: 6.4413, lng: 3.474 }, // Lekki Phase 1 / Admiralty
  // Ibadan
  'ib-1': { lat: 7.431, lng: 3.906 }, // Old Bodija
  'ib-2': { lat: 7.386, lng: 3.883 }, // Dugbe
  'ib-3': { lat: 7.351, lng: 3.876 }, // Ring Road
  'ib-4': { lat: 7.402, lng: 3.889 }, // Mokola
  'ib-5': { lat: 7.343, lng: 3.883 }, // Challenge
  'ib-6': { lat: 7.443, lng: 3.899 }, // UI / Agbowo
  'ib-7': { lat: 7.4, lng: 3.933 }, // Iwo Road
  'ib-8': { lat: 7.36, lng: 3.836 }, // Apata
  'ib-9': { lat: 7.423, lng: 3.879 }, // Sango
  'ib-10': { lat: 7.44, lng: 3.935 }, // Akobo
  // Abuja
  'abj-1': { lat: 9.079, lng: 7.468 }, // Wuse II
  'abj-2': { lat: 9.033, lng: 7.488 }, // Garki
  'abj-3': { lat: 9.108, lng: 7.403 }, // Gwarinpa
  // Port Harcourt
  'ph-1': { lat: 4.812, lng: 7.013 }, // GRA Phase 2
};

/**
 * Where to draw a hub's pin, and how much to trust it.
 *
 * Returns null rather than a guess when neither source has a position — a map
 * that silently drops a hub is better than one that invents a location for it.
 */
export function hubPosition(hub: Hub): HubPosition | null {
  if (hub.coordinates) return hub.coordinates;

  const centre = AREA_CENTRES[hub.id];
  return centre ? { ...centre, precision: 'area' } : null;
}

/** True while any pin on the map is a neighbourhood centre rather than a door. */
export function hasApproximatePositions(hubs: Hub[]): boolean {
  return hubs.some((hub) => hubPosition(hub)?.precision === 'area');
}

/*
 * The helpers below take the list explicitly rather than reading a module
 * constant. That is what lets them work against the live table: a function that
 * closes over `SEED_HUBS` would keep answering from the seed no matter what an
 * admin changed, and the mistake would be invisible at every call site.
 */

/** Hubs in one city, in the order they were listed. */
export function hubsForCity(hubs: Hub[], city: City): Hub[] {
  return hubs.filter((hub) => hub.city === city);
}

/** Cities we have actually opened a hub in — 4 of the 37 today. */
export function citiesWithHubs(hubs: Hub[], cities: readonly City[]): City[] {
  return cities.filter((city) => hubs.some((hub) => hub.city === city));
}

export function findHub(hubs: Hub[], id: string): Hub | undefined {
  return hubs.find((hub) => hub.id === id);
}

/** "Package Relay Ikeja Hub — Ikeja" */
export function hubLabel(hub: Hub): string {
  return `${hub.name} — ${hub.area}`;
}
