/**
 * Marketing copy for the three hero services.
 *
 * Pricing examples are computed from `PRICING` via `estimateFee` rather than
 * written as literals, so the copy can never drift from what the form quotes.
 */

import { estimateFee, formatNaira, PRICING, type DeliveryType } from '@/store/bookings';

import type { Tone } from '@/constants/theme';

export const SERVICE_IDS = ['same-day-local', 'interstate-express', 'insured-parcels'] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

/** Query params handed to `/book` so the form can pre-select this service. */
export type ServicePrefill = {
  deliveryType?: DeliveryType;
  /** Ask the booking form to scroll to and focus the declared-value field. */
  focusDeclaredValue?: boolean;
};

export type ServiceSection = {
  heading: string;
  body: string;
};

export type Service = {
  id: ServiceId;
  /** Text on the hero chip. */
  chipLabel: string;
  title: string;
  tagline: string;
  tone: Tone;
  facts: { label: string; value: string }[];
  sections: ServiceSection[];
  prefill: ServicePrefill;
  /** Copy for the primary button, e.g. "Send Locally". */
  ctaLabel: string;
};

/*
 * Worked example: a 2 kg parcel across town, on the cheapest route.
 *
 * `estimateFee` defaults both ends to `CHEAPEST_HANDOVER`, which is now a
 * public-location pickup met at a hub — no longer "hub to hub", because a hub
 * pickup carries the surcharge. The wording below says "collected and met in
 * public" for that reason: describing this as hub-to-hub would understate what
 * a hub-to-hub parcel actually costs by ₦800.
 */
const localExample = estimateFee({
  deliveryType: 'local',
  weight: 2,
  declaredValue: 0,
});

/** Worked example: a 5 kg parcel Ibadan → Lagos, on the same cheapest route. */
const interstateExample = estimateFee({
  deliveryType: 'interstate',
  weight: 5,
  declaredValue: 0,
});

export const SERVICES: Record<ServiceId, Service> = {
  'same-day-local': {
    id: 'same-day-local',
    chipLabel: 'Local Delivery',
    title: 'Local Delivery',
    tagline: 'Within one city, met in public or all the way to the door.',
    tone: 'success',
    facts: [
      { label: 'Pickup window', value: 'As requested' },
      { label: 'Handover', value: 'Hub or Public location' },
      { label: 'From', value: formatNaira(localExample.total) },
    ],
    sections: [
      {
        heading: 'Pickup timelines',
        body: 'Pickup happens at the time you set when you post the parcel — a driver already covering that route collects it then. There are no speed tiers to buy; every parcel is loaded on the next run going that way. You will see the driver’s name on your tracking card the moment the job is accepted.',
      },
      {
        heading: 'Motorcycle dispatch rules',
        body: 'Local runs go out by motorcycle, which caps a single parcel at 20 kg and roughly the size of a backpack. Anything larger is re-routed to a van at the standard rate. Riders carry one active parcel at a time on local jobs, so your item is never held while another drop is completed.',
      },
      {
        heading: 'Pricing',
        body: `Base fare ${formatNaira(PRICING.base.local)} plus ${formatNaira(PRICING.perKg.local)} per kilogram. A 2 kg parcel across town, collected and met in public, works out at about ${formatNaira(localExample.total)}. Bringing the parcel to a hub, or having it delivered to a door, each add ${formatNaira(PRICING.handoverSurcharge)}. Fragile handling is free.`,
      },
    ],
    prefill: { deliveryType: 'local' },
    ctaLabel: 'Send Locally',
  },

  'interstate-express': {
    id: 'interstate-express',
    chipLabel: 'Inter-State',
    title: 'Inter-State',
    tagline: 'Between cities, on the next departure along your route.',
    tone: 'primary',
    facts: [
      { label: 'Ibadan → Lagos', value: 'As requested' },
      { label: 'Ibadan → Abuja', value: 'Hub or Public location' },
      { label: 'From', value: formatNaira(interstateExample.total) },
    ],
    sections: [
      {
        heading: 'Routes and transit times',
        body: 'Collection is scheduled for the time you request, and the parcel travels on the next departure covering your route. Hand it over at a Package Relay hub or meet the driver at an agreed public location — the same choice applies at the destination. Longer pairs such as Port Harcourt → Kano are scheduled on request.',
      },
      {
        heading: 'Vehicle and traveller options',
        body: 'Most inter-state parcels move by scheduled van. Documents and small items under 5 kg can instead ride with a vetted traveller on an existing trip, which is faster on busy corridors and cheaper per kilogram. Bulky items over 30 kg are consolidated onto the daily truck, which adds roughly 12 hours.',
      },
      {
        heading: 'Pricing',
        body: `Base fare ${formatNaira(PRICING.base.interstate)} plus ${formatNaira(PRICING.perKg.interstate)} per kilogram. A 5 kg parcel Ibadan → Lagos, collected and met in public, works out at about ${formatNaira(interstateExample.total)}. Bringing the parcel to a hub, or having it delivered to a door, each add ${formatNaira(PRICING.handoverSurcharge)}.`,
      },
    ],
    prefill: { deliveryType: 'interstate' },
    ctaLabel: 'Send Inter-State',
  },

  'insured-parcels': {
    id: 'insured-parcels',
    chipLabel: 'Insured Parcels',
    title: 'Insured Parcels',
    tagline: 'Declare what it’s worth, and it’s covered end to end.',
    tone: 'warning',
    facts: [
      { label: 'Cover level', value: 'Set by your declaration' },
      { label: 'Claim window', value: '3 days' },
    ],
    sections: [
      {
        heading: 'Declaring value',
        body: 'Enter what the item is actually worth in the Declared value field when you book. That figure is what sets your level of cover — the parcel is insured for the amount you declare, and a settled claim pays up to it. Declare nothing and the parcel travels uninsured, so under-declaring to save on the premium also caps what you can be paid.',
      },
      {
        heading: 'Safety guarantees',
        body: 'Every parcel is photographed at pickup and again at handover, and both images are attached to your tracking record. Custody passes between named handlers only, and the recipient’s phone number is verified at the door before release. Parcels marked fragile are packed separately and never stacked under other freight.',
      },
      {
        heading: 'Claim coverage',
        body: 'If a parcel is lost or damaged in our custody, file a claim within 3 days of the delivery date with your tracking number and the pickup photograph. Settled claims pay the declared value, capped at the amount you declared. Perishables and cash are excluded from cover.',
      },
    ],
    prefill: { focusDeclaredValue: true },
    ctaLabel: 'Book an Insured Parcel',
  },
};

/** Hero chip order. */
export const HERO_SERVICES: ServiceId[] = [...SERVICE_IDS];

/** Turns a service's prefill into expo-router query params (all values must be strings). */
export function servicePrefillParams(id: ServiceId): Record<string, string> {
  const { prefill } = SERVICES[id];
  const params: Record<string, string> = { service: id };

  if (prefill.deliveryType) params.deliveryType = prefill.deliveryType;
  if (prefill.focusDeclaredValue) params.focusDeclaredValue = '1';

  return params;
}
