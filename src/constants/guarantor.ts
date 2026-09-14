/**
 * What a guarantor is asked, and what they are asked to agree to.
 *
 * ⚠ The wording here is stored with every submission, not merely displayed.
 *
 *   `complete_guarantor_verification` writes `consent_text` and
 *   `declaration_text` into the row from what the client sends, so the sentence
 *   on screen and the sentence on file cannot drift apart. Editing a string in
 *   this file changes what future guarantors agree to and changes nothing about
 *   what past ones agreed to, which is the only safe way round.
 *
 * ⚠ GUARANTOR_SURETYSHIP_REVIEW_REQUIRED — see below. The clause in this file
 *   has not been reviewed by a Nigerian lawyer.
 */

/**
 * Whether the suretyship wording is still awaiting legal review.
 *
 * ⚠ True, and it should stay true until somebody qualified has actually read it.
 *
 *   `SURETYSHIP_CLAUSE` asks a person with no account, no separate
 *   consideration and no negotiation to accept joint liability for somebody
 *   else's conduct. Whether that is enforceable in Nigeria — and against whom,
 *   and on what evidence — is a question for a Nigerian lawyer. Nothing in this
 *   codebase asserts that it is enforceable, and the portal's own copy does not
 *   claim it either.
 *
 *   What the software does guarantee is narrower and is achievable: the exact
 *   wording shown, the name typed under it, the time, the address it was
 *   submitted from, a photograph of a government ID and a photograph taken at
 *   the moment of signing are all recorded together and none of them can be
 *   changed afterwards. That is a record. Whether it is a remedy is not this
 *   file's claim to make.
 *
 *   `verify-guarantor-portal` fails if this flag lies — the same arrangement as
 *   `CONTACT_IS_PLACEHOLDER` and `LEGAL_REVIEW_REQUIRED`.
 */
export const GUARANTOR_SURETYSHIP_REVIEW_REQUIRED = true;

/**
 * The identity consent. Unchanged in substance from what shipped with the first
 * version of the portal, and moved here from `src/store/guarantor.ts` so that
 * both things a guarantor agrees to live in one file.
 */
export const CONSENT_TEXT =
  'I confirm that I agree to act as a guarantor for this driver on Package Relay, that the ' +
  'National Identification Number I have entered is my own, and that Package Relay may verify ' +
  'it with NIMC for this purpose.';

/**
 * The suretyship.
 *
 * ⚠ Three named causes, and no fourth.
 *
 *   Theft, deliberate conversion and gross negligence. A guarantor is not being
 *   asked to underwrite an accident, a traffic collision, a delay, a parcel
 *   damaged by rain, or a driver's ordinary mistakes — and saying so explicitly
 *   is what makes the clause readable rather than frightening. A clause that
 *   appears to make somebody liable for anything that ever happens is one a
 *   reasonable person closes the tab on, and one a court is more likely to read
 *   down.
 *
 * ⚠ Capped at the value of the goods, and "proven" is doing real work.
 *
 *   Not the value of the parcel as claimed in a dispute, and not costs, and not
 *   an open-ended indemnity: the declared value of the goods, and only after the
 *   conduct has been established rather than alleged. An uncapped guarantee
 *   signed by somebody's landlord on a phone is not a thing this company should
 *   want to hold.
 *
 * ⚠ Written to be read once, by somebody who was not expecting it.
 *
 *   Short sentences, no defined terms, no "hereinafter". The guarantor has no
 *   lawyer, no account, and no reason to persevere with a paragraph. Anything
 *   they cannot follow on one reading is not consent to anything.
 */
export const SURETYSHIP_CLAUSE =
  'I agree to stand as guarantor for this driver. If Package Relay proves that this driver ' +
  'stole goods entrusted to them, deliberately kept or sold goods that were not theirs, or ' +
  'lost goods through gross negligence, I accept that I can be held jointly responsible with ' +
  'them for the value of those goods, up to the value declared for the parcel concerned. ' +
  'I understand this applies only to those three situations. It does not make me responsible ' +
  'for accidents, traffic incidents, delays, ordinary damage in transit, or any other debt of ' +
  'this driver. I confirm that I know this person, that the details I have given about myself ' +
  'are true, and that I am giving this guarantee freely.';

/**
 * What Package Relay tells the guarantor about their own data, before they hand
 * any of it over.
 *
 * Separate from the two agreements because it is a notice rather than a promise
 * they make: under the NDPA the guarantor is a data subject in their own right,
 * and the driver was never in a position to consent for them.
 */
export const GUARANTOR_PRIVACY_NOTE =
  'Package Relay keeps what you enter here to check who you are and to contact you if there ' +
  'is ever a dispute about a parcel this driver carried. The driver never sees your NIN, your ' +
  'ID photograph or your photo. Only Package Relay review staff can open them.';

/** Employment statuses, matching the check constraint in migration 51. */
export const EMPLOYMENT_STATUSES = [
  'Employed',
  'Self-employed',
  'Business owner',
  'Civil servant',
  'Retired',
  'Unemployed',
  'Student',
] as const;

export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/**
 * The statuses that have no employer to name.
 *
 * ⚠ Asked of people who have an employer, and not of people who do not.
 *
 *   Requiring a company name of everybody makes a retired guarantor type
 *   something untrue into a form that is about to ask them to sign it. The same
 *   rule is enforced in `complete_guarantor_verification`, because the client is
 *   not the authority on its own validation.
 */
export const EMPLOYERLESS_STATUSES: readonly string[] = ['Retired', 'Unemployed', 'Student'];

export function needsEmployer(status: string): boolean {
  return status.length > 0 && !EMPLOYERLESS_STATUSES.includes(status);
}

/** How long they have known the applicant. Matches the constraint in 51. */
export const KNOWN_DURATIONS = [
  'Under 1 year',
  '1-2 years',
  '3-5 years',
  '6-10 years',
  'Over 10 years',
] as const;

export type KnownDuration = (typeof KNOWN_DURATIONS)[number];

/**
 * The two files a guarantor uploads.
 *
 * ⚠ `live_photo` is taken now, with the camera, and never chosen from a gallery.
 *
 *   The entire value of it is that it was taken at the moment the declaration
 *   was signed, by the person holding the device. A saved picture proves that
 *   somebody once had a picture. `verify-guarantor-portal` asserts that the
 *   portal reaches the gallery for the ID and not for the photo.
 */
export const DOCUMENT_KINDS = ['government_id', 'live_photo'] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  government_id: 'Photo of your government ID',
  live_photo: 'Live photo of you',
};

/**
 * Six megabytes, matching the ceiling in the edge function.
 *
 * The bucket allows ten. This is the rule and that is the backstop; two files at
 * the bucket's limit is a lot of somebody else's mobile data for a favour.
 */
export const MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;
