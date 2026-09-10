/**
 * How to reach Package Relay.
 *
 * ⚠ Every address and number below is a placeholder on a domain nobody has
 *   registered. They are in one file precisely so that replacing them is a
 *   single edit rather than a hunt through screens — but until they are real,
 *   the Support screen is advertising channels that go nowhere.
 *
 *   `scripts/verify-about.ts` fails if `PLACEHOLDER` is still true while the
 *   addresses are being shown as live, so this cannot quietly ship.
 */

/** Flip to false once the addresses and numbers below actually work. */
export const CONTACT_IS_PLACEHOLDER = true;

export type Channel = {
  key: string;
  label: string;
  /** What this channel is genuinely the fastest route for. */
  bestFor: string;
  value: string;
  /** `mailto:` / `tel:` / `https:` target. */
  href: string;
  /** Honest expectation, not a promise nobody is staffed to keep. */
  responseTime: string;
};

export const CHANNELS: Channel[] = [
  {
    key: 'email',
    label: 'Email support',
    bestFor: 'Anything about an application, a parcel, or your account.',
    value: 'support@pkrelay.ng',
    href: 'mailto:support@pkrelay.ng',
    responseTime: 'Within 1 working day',
  },
  {
    key: 'phone',
    label: 'Phone',
    bestFor: 'A parcel in transit right now, or a driver who has not arrived.',
    value: '+234 803 000 0000',
    href: 'tel:+2348030000000',
    responseTime: 'Mon–Sat, 8:00am – 6:00pm WAT',
  },
  {
    key: 'business',
    label: 'Business & partnerships',
    bestFor: 'Bulk delivery, becoming a partner hub, press.',
    value: 'business@pkrelay.ng',
    href: 'mailto:business@pkrelay.ng',
    responseTime: 'Within 2 working days',
  },
  {
    key: 'privacy',
    label: 'Privacy requests',
    bestFor: 'Getting a copy of your data, or asking us to delete it.',
    value: 'privacy@pkrelay.ng',
    href: 'mailto:privacy@pkrelay.ng',
    /*
     * The NDPR expects a data-subject request to be answered within one month.
     * Quoting it here is a commitment — it is also the only honest thing to
     * print next to an address that exists for exactly that purpose.
     */
    responseTime: 'Within 30 days, as the NDPR requires',
  },
];

/**
 * Things people write to support about that the app can already answer.
 *
 * Pointing someone at the screen that holds their answer resolves it in
 * seconds instead of a day, and it is the difference between a support page
 * that helps and one that is just an email address.
 */
export type SelfServe = {
  key: string;
  question: string;
  action: string;
  /** A route in this app. */
  href: string;
};

export const SELF_SERVE: SelfServe[] = [
  {
    key: 'application',
    question: 'Where is my driver application?',
    action: 'Open Be a Driver / Updates',
    href: '/driver-updates',
  },
  {
    key: 'email',
    question: "I didn't get the confirmation email",
    action: 'See exactly what we sent',
    href: '/driver-updates',
  },
  {
    key: 'jobs',
    question: 'Why is the Accept button greyed out?',
    action: 'Read the driver guidelines',
    href: '/driver-guidelines',
  },
  {
    key: 'parcel',
    question: 'Where is the parcel I sent?',
    action: 'Open My Parcels',
    href: '/my-packages',
  },
  {
    key: 'hub',
    question: 'Is my nearest hub open?',
    action: 'Check operating hours',
    href: '/locations?section=hours',
  },
];
