/**
 * All 36 states plus the Federal Capital Territory, alphabetically.
 *
 * The single source for every state picker in the app. Deliberately separate
 * from `CITIES` in the bookings store: that is the nine-city *operating*
 * footprint that pricing, booking and the jobs feed depend on. A driver can
 * live in a state Package Relay does not yet serve; a parcel cannot be routed there.
 */
export const NIGERIA_STATES = [
  'Abia',
  'Adamawa',
  'Akwa Ibom',
  'Anambra',
  'Bauchi',
  'Bayelsa',
  'Benue',
  'Borno',
  'Cross River',
  'Delta',
  'Ebonyi',
  'Edo',
  'Ekiti',
  'Enugu',
  'FCT - Abuja',
  'Gombe',
  'Imo',
  'Jigawa',
  'Kaduna',
  'Kano',
  'Katsina',
  'Kebbi',
  'Kogi',
  'Kwara',
  'Lagos',
  'Nasarawa',
  'Niger',
  'Ogun',
  'Ondo',
  'Osun',
  'Oyo',
  'Plateau',
  'Rivers',
  'Sokoto',
  'Taraba',
  'Yobe',
  'Zamfara',
] as const;

export type NigeriaState = (typeof NIGERIA_STATES)[number];

export const DEFAULT_STATE: NigeriaState = 'Lagos';

/** True when the value is one of the 37. Guards data coming back from a server. */
export function isNigeriaState(value: string): value is NigeriaState {
  return (NIGERIA_STATES as readonly string[]).includes(value);
}
