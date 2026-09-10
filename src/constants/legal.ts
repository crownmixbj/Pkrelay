/**
 * Terms of Service and Privacy Policy content.
 *
 * ⚠ READ THIS BEFORE SHIPPING.
 *
 *   The privacy notice below is *accurate*: every item in `DATA_COLLECTED` was
 *   read out of the SQL in `supabase/` and the code that writes it, and
 *   `scripts/verify-about.ts` fails if the two drift apart. That part is worth
 *   having and is safe to show.
 *
 *   The terms are NOT a legal document. They describe how the service actually
 *   behaves, in plain English, which is a genuinely useful thing for a user to
 *   read — but they are not drafted by a lawyer, they create no enforceable
 *   position, and they are missing every clause that matters when something
 *   goes wrong. `TERMS_GAPS` lists what is absent.
 *
 *   Under the NDPR you are a data controller handling National Identification
 *   Numbers and bank account details. That is not a "get to it later" category
 *   of obligation. `LEGAL_REVIEW_REQUIRED` keeps the banner on screen until
 *   someone qualified has been through this.
 */

/** Keeps the "not yet reviewed" banner up. Flip only after a real review. */
export const LEGAL_REVIEW_REQUIRED = true;

/** Shown as the version date. Update whenever the content below changes. */
export const LEGAL_LAST_UPDATED = '2026-08-10';

export type LegalSection = 'terms' | 'privacy';

export const LEGAL_SECTIONS: readonly LegalSection[] = ['terms', 'privacy'] as const;

export const LEGAL_SECTION_LABELS: Record<LegalSection, string> = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
};

export function parseLegalSection(value: unknown): LegalSection {
  return LEGAL_SECTIONS.includes(value as LegalSection) ? (value as LegalSection) : 'terms';
}

// ------------------------------------------------------------------ terms ---

export type Clause = {
  key: string;
  title: string;
  body: string;
};

/**
 * How the service actually behaves.
 *
 * Every statement here is checkable against the code. Where the app does not do
 * something — insurance, refunds, a payout ledger — the clause says so rather
 * than describing a protection that does not exist.
 */
export const TERMS: Clause[] = [
  {
    key: 'what',
    title: 'What Package Relay does',
    body: 'Package Relay connects people sending parcels with independent drivers who carry them. We are not the carrier. Drivers use their own vehicles, set their own hours, and are not employees.',
  },
  {
    key: 'account',
    title: 'Your account',
    body: 'You need an account to send a parcel. You are responsible for what happens under it, so keep your password to yourself. Browsing — routes, fares, hubs, open jobs — needs no account at all.',
  },
  {
    key: 'driver',
    title: 'Driving with Package Relay',
    body: 'Carrying a parcel needs an approved driver application. We check identity, vehicle, licence and a guarantor before approving, and one live application is allowed per account. Approval can be withdrawn.',
  },
  {
    key: 'fares',
    title: 'Fares',
    body: 'The figure shown when you book is an estimate produced from distance, weight, size and handover choice. It is what the driver is paid on delivery. There is no separate Package Relay fee shown today.',
  },
  {
    key: 'fragile',
    title: 'Fragile items are not insured',
    body: 'Marking an item fragile tells the driver to handle it carefully. It does not buy cover, and Package Relay charges nothing extra for it. Nothing in this app currently insures a parcel against loss or damage.',
  },
  {
    key: 'handover',
    title: 'Collection and delivery',
    body: 'A parcel is handed to the named recipient or left at the hub named on the booking. Give an address and phone number that are correct — a delivery that fails because the details were wrong is not refunded, because there is no refund mechanism yet.',
  },
  {
    key: 'conduct',
    title: 'What you may not send',
    body: 'No cash, no weapons, no illegal drugs, nothing perishable that will spoil in transit, and nothing you are not legally entitled to move. Drivers may refuse anything, and are asked to.',
  },
  {
    key: 'data',
    title: 'Contact details on a job',
    body: 'A driver sees the addresses and phone numbers on a job so they can complete it. Using them for anything else ends their access. If that happens to you, write to privacy@pkrelay.ng.',
  },
];

/**
 * The clauses a lawyer has to write, listed so their absence is visible.
 *
 * A terms page that quietly omits liability and dispute resolution reads as
 * complete to a user and offers nothing at all when something actually goes
 * wrong. Naming the gaps is the honest position until they are filled.
 */
export const TERMS_GAPS: string[] = [
  'Limitation of liability — what Package Relay is and is not answerable for when a parcel is lost, damaged or stolen',
  'Insurance — whether any cover exists, who provides it, and what it pays',
  'Cancellation and refunds — there is no refund mechanism in the app today',
  'Dispute resolution and governing law',
  'Driver contractor terms — the relationship, tax position and payout schedule',
  'Termination — how an account or a driver approval is ended, and on what notice',
  'Consumer protection obligations under Nigerian law (FCCPA)',
];

// ---------------------------------------------------------------- privacy ---

export type DataItem = {
  key: string;
  /** Where it is stored, as a hint for anyone checking this against the schema. */
  store: 'auth' | 'profiles' | 'bookings' | 'driver_applications' | 'storage' | 'device';
  what: string;
  why: string;
  who: string;
};

/**
 * Everything this app stores about a person.
 *
 * Read from `supabase/migrations/20250101000001_bookings.sql`, `20250101000002_driver_applications.sql`,
 * `20250101000005_storage_and_alerts.sql` and `hooks/use-form-draft.ts`. The verification
 * script cross-checks the sensitive columns against the SQL, so a new field
 * added to the schema without a line here is caught.
 */
export const DATA_COLLECTED: DataItem[] = [
  {
    key: 'account',
    store: 'auth',
    what: 'Email address and a password',
    why: 'To sign you in and to send you account email.',
    who: 'You. The password is hashed by Supabase and is never readable, including by us.',
  },
  {
    key: 'profile',
    store: 'profiles',
    what: 'Name and phone number',
    why: 'So a driver knows who they are collecting from, and so we can reach you.',
    who: 'You, and the driver carrying your parcel.',
  },
  {
    key: 'booking',
    store: 'bookings',
    what: 'Pickup and drop-off addresses, recipient name and phone, item description, weight, size, declared value, and map coordinates if you drop a pin',
    why: 'To price the job, show it to drivers, and get the parcel to the right door.',
    who: 'You, and the driver who claims the job. Other drivers see open jobs before anyone claims them.',
  },
  {
    key: 'application',
    store: 'driver_applications',
    what: 'National Identification Number, home address, driving licence number, vehicle and plate, bank name, account number and account name, and your guarantor and next-of-kin details including their NIN and phone',
    why: 'To verify you are who you say you are before trusting you with other people’s property, and to pay you.',
    who: 'You and Package Relay reviewers only. Row Level Security refuses this data to every other account, including other drivers.',
  },
  {
    key: 'documents',
    store: 'storage',
    what: 'The identity, licence and vehicle documents you upload',
    why: 'Evidence for the review.',
    who: 'You and Package Relay reviewers. Held in a private store and opened only through short-lived signed links, so a leaked URL stops working.',
  },
  {
    key: 'draft',
    store: 'device',
    what: 'A saved draft of a form you have not submitted — which can include your NIN and bank details',
    why: 'So a half-finished application survives signing in, or closing the tab by accident.',
    who: 'Nobody but you. It stays on your device, expires after 24 hours, and is deleted when you submit or sign out.',
  },
];

export type Processor = {
  key: string;
  name: string;
  purpose: string;
  /** What actually leaves the project, stated precisely. */
  shares: string;
};

/**
 * Third parties that receive data, and exactly what reaches them.
 *
 * OpenStreetMap is on this list because a map tile request carries the user's
 * IP address to a third party. It is easy to forget an embedded map is a
 * disclosure, and leaving it off would make this notice quietly incomplete.
 */
export const PROCESSORS: Processor[] = [
  {
    key: 'supabase',
    name: 'Supabase',
    purpose: 'Hosts the database, accounts and uploaded documents.',
    shares: 'Everything listed above except the on-device draft.',
  },
  {
    key: 'resend',
    name: 'Resend',
    purpose: 'Sends the driver application confirmation email.',
    shares:
      'Your name, email address and application reference. Never your NIN, bank details or guarantor.',
  },
  {
    key: 'slack',
    name: 'Slack',
    purpose: 'Alerts the Package Relay team that a new driver application has arrived.',
    shares:
      'Name, phone, email, city and vehicle type. Deliberately not your NIN, bank account or guarantor details.',
  },
  {
    key: 'osm',
    name: 'OpenStreetMap',
    purpose: 'Draws the maps.',
    shares:
      'Your IP address, and the area being viewed, as part of loading map tiles. No parcel or account data.',
  },
];

/** What the NDPR entitles someone to, stated plainly. */
export const YOUR_RIGHTS: Clause[] = [
  {
    key: 'access',
    title: 'A copy of your data',
    body: 'Ask and we will send you everything we hold about you.',
  },
  {
    key: 'correct',
    title: 'Correction',
    body: 'Details verified during a driver review cannot be edited in the app, on purpose. Write to us and we will change them.',
  },
  {
    key: 'delete',
    title: 'Deletion',
    body: 'You can ask us to delete your account and your data. Some records tied to a completed delivery may need to be kept where the law requires it.',
  },
  {
    key: 'withdraw',
    title: 'Withdrawing consent',
    body: 'You can stop driving or stop using Package Relay at any time. Finish anything you have already accepted first.',
  },
];

/**
 * Retention is a business decision, not a technical one, and none has been made.
 *
 * Saying "we keep it as long as necessary" would be the standard evasion. Under
 * the NDPR, holding a rejected applicant's NIN and bank account indefinitely is
 * a real exposure, so the absence is stated rather than papered over.
 */
export const RETENTION_UNDECIDED = true;
