/**
 * Assertions for the guarantor portal — the one screen in Package Relay meant
 * for somebody with no account.
 *
 * ⚠ Three claims are asserted here that nothing else can assert.
 *
 *   1. The wording a guarantor agrees to is the wording that gets stored. The
 *      screen renders `SURETYSHIP_CLAUSE` and the client posts the same
 *      constant, so the record and the page are the same string by
 *      construction. A screen that rendered a summary and stored a template
 *      would be the most misleading thing this feature could do.
 *
 *   2. The client's own wording clears the floor the database enforces. A clause
 *      shorter than 200 characters is refused by
 *      `complete_guarantor_verification` — and if the app's constant ever fell
 *      below it, every guarantor in the country would meet "Please read and
 *      accept the guarantor declaration" while the box was ticked.
 *
 *   3. The live photo is taken, never chosen. Its entire value is that it was
 *      taken at the moment of signing, by the person holding the device, so
 *      `launchImageLibraryAsync` must not be reachable on that path.
 *
 * Run with `npm run verify:guarantor`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONSENT_TEXT,
  GUARANTOR_SURETYSHIP_REVIEW_REQUIRED,
  KNOWN_DURATIONS,
  EMPLOYMENT_STATUSES,
  MAX_DOCUMENT_BYTES,
  SURETYSHIP_CLAUSE,
  needsEmployer,
} from '../src/constants/guarantor';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const portal = read('src/app/guarantor/[token].tsx');
const store = read('src/store/guarantor.ts');
const uploadCard = read('src/components/ui/guarantor-upload-card.tsx');
const trackingCard = read('src/components/ui/guarantor-tracking-card.tsx');
const migration = read('supabase/migrations/20250101000051_guarantor_full_form.sql');
const fn = read('supabase/functions/guarantor-portal/index.ts');
const driverPortal = read('src/app/(tabs)/driver.tsx');

// ------------------------------------------------------------ the clause ----

/*
 * ⚠ The floor is read out of the migration rather than hard-coded here.
 *
 *   Two numbers that have to agree, written in two files, is one number that
 *   will disagree. If the migration's floor is raised, this assertion raises
 *   with it and fails on the constant that is now too short — which is the
 *   failure that should happen, in the place it can be fixed.
 */
const floor = Number(/length\(declaration\) < (\d+)/.exec(migration)?.[1] ?? 0);

check('the migration states a floor on the declaration', floor > 0, 'nothing to compare against');
check(
  `the app's own clause clears the database's ${floor}-character floor`,
  SURETYSHIP_CLAUSE.length >= floor,
  `the clause is ${SURETYSHIP_CLAUSE.length} characters — every submission would be refused`,
);

/*
 * ⚠ The three causes, named. A guarantee that appears to cover anything that
 *   ever happens is one a reasonable person closes the tab on.
 */
for (const cause of ['stole', 'deliberately kept', 'gross negligence']) {
  check(`the clause names ${cause}`, SURETYSHIP_CLAUSE.includes(cause));
}
check(
  'and says plainly what it does not cover',
  /accidents/.test(SURETYSHIP_CLAUSE) && /does not make me responsible/.test(SURETYSHIP_CLAUSE),
  'a clause without limits reads as unlimited, and would be read down as one',
);
check(
  'and caps the amount at the declared value',
  /up to the value declared/.test(SURETYSHIP_CLAUSE),
  'an uncapped guarantee typed on a phone is not something to want to hold',
);

/*
 * ⚠ The flag has to still be true.
 *
 *   Same arrangement as `CONTACT_IS_PLACEHOLDER` and `LEGAL_REVIEW_REQUIRED`: the
 *   constant is only worth having if something fails when it lies. Setting it
 *   false is a claim that a Nigerian lawyer has read the clause — and whoever
 *   does that has to delete this assertion deliberately.
 */
check(
  'the suretyship is still marked as awaiting legal review',
  GUARANTOR_SURETYSHIP_REVIEW_REQUIRED,
  'set this to false only when somebody qualified has actually read the clause',
);

// ------------------------------- the page shows what the row will store ----

check(
  'the portal renders the clause itself, not a summary of it',
  portal.includes('{SURETYSHIP_CLAUSE}'),
  'a page that summarises what it stores is how people sign what they have not read',
);
check(
  'and the same constant is what the client posts',
  /declarationText: SURETYSHIP_CLAUSE/.test(portal),
  'the wording on screen and the wording on file must be one string',
);
check(
  'the consent wording is likewise rendered and posted',
  portal.includes('label={CONSENT_TEXT}') && /consentText: CONSENT_TEXT/.test(portal),
);
check('the consent still says the NIN is their own', /my own/.test(CONSENT_TEXT));

// ----------------------------------------- the live photo is taken, not picked

/*
 * ⚠ Split by kind inside one component, so this has to assert on the branch
 *   rather than on the file.
 *
 *   The ID may legitimately come from the gallery — somebody scanned it last
 *   year. The live photo may not. The component reaches the gallery through
 *   `fromGallery`, and the assertion is that the live-photo branch never calls
 *   it.
 */
/*
 * ⚠ Anchored on the controls, not on `live ? (`.
 *
 *   There are two of those — the icon in the card header is the other one — and
 *   anchoring on the first sliced the whole component, which is how this
 *   assertion passed while reading the ID branch it was meant to exclude. The
 *   platform split below it appears once.
 */
const liveStart = uploadCard.indexOf(') : live ? (\n        isWeb ? (');
/*
 * The branch ends where the ID's begins — the `) : (` that closes it. Sliced to
 * the end of the file, this assertion would read the ID branch as well and pass
 * on a live photo that did offer the gallery, which is the assertion failing to
 * do its one job.
 */
const liveEnd = uploadCard.indexOf('\n      ) : (', liveStart);
const liveBranch = liveStart >= 0 && liveEnd > liveStart ? uploadCard.slice(liveStart, liveEnd) : '';

check('the upload card has a live-photo branch', liveBranch.length > 0, 'nothing was sliced');
check(
  'the live photo never offers the gallery',
  liveBranch.length > 0 && !/fromGallery/.test(liveBranch),
  'a saved picture proves somebody once had a picture',
);
check(
  'and the ID does, because somebody may have scanned it last year',
  /fromGallery/.test(uploadCard.slice(liveEnd)),
);
check(
  'it reaches the camera on native and getUserMedia on web',
  /launchCameraAsync/.test(uploadCard) && /useWebcam/.test(uploadCard),
);
/*
 * The option, not the word: this file explains at length why cropping is off,
 * and a match on the prose would fail on its own comment.
 */
check(
  'and it does not crop either file',
  !/allowsEditing\s*:/.test(uploadCard),
  'a croppable live photo is one somebody can compose, and a cropped ID loses the part that matters',
);

// --------------------------------------------- the writes go through the fn --

check(
  'the portal never calls the completion RPC directly',
  !/rpc\('complete_guarantor_verification'/.test(store),
  'that grant was taken away from anon in 51 — a direct call is a 403 in production',
);
check(
  'every write goes through the edge function',
  /functions\.invoke\(FUNCTION/.test(store) && store.includes("const FUNCTION = 'guarantor-portal'"),
);
check(
  'the client still reads the invitation over the anon RPC',
  /rpc\('open_guarantor_invitation'/.test(store),
  'the one thing a stranger may call without a function in front of it',
);
check(
  'and the client does not report its own IP',
  !/p_ip/.test(store),
  'a client-supplied address next to a real one is something that looks like evidence and is not',
);
check(
  'the function fills the address it observed',
  /x-forwarded-for/.test(fn) && /p_ip: clientIp\(request\)/.test(fn),
);
check(
  'and asks Storage what landed rather than believing the client',
  /object\/info\//.test(fn),
  'a documents row with no object behind it is a submission that passes on a lie',
);
/*
 * ⚠ The path and the field names, both pinned, because both were wrong once and
 *   neither fails loudly.
 *
 *   `/object/info/authenticated/…` is the download path's shape, not this one,
 *   and `contentType` is the camelCase guess — the API answers `size` and
 *   `content_type`. Either mistake stores every document as zero bytes of
 *   octet-stream, and the guarantor is told their file came through empty while
 *   it sits in the bucket intact.
 */
check(
  'on the object-info path, not the download path',
  !/object\/info\/authenticated/.test(fn),
);
check(
  'reading the field names the API actually returns',
  /meta\.size/.test(fn) && /content_type/.test(fn),
);
/*
 * ⚠ Upsert is a header on the signing request, and it is asserted because the
 *   failure is invisible until somebody retakes a photo.
 *
 *   Sent as a JSON field — which is how this was first written — the API ignores
 *   it silently. Signing succeeds, the first upload succeeds, and the second
 *   fails with "The resource already exists" on a path the person cannot see.
 */
check(
  'the signing request asks for upsert in the header',
  /'x-upsert': 'true'/.test(fn),
  'as a body field it is ignored in silence, and only retakes break',
);
check(
  'and the client does not pretend to set it',
  !/upsert: true/.test(store),
  'upsert passed to uploadToSignedUrl has no effect — it would be the wrong place to look',
);

check(
  'the size ceiling is the same on both sides',
  fn.includes(`${6 * 1024 * 1024}`) || /6 \* 1024 \* 1024/.test(fn),
);
check('and the client knows it before uploading', MAX_DOCUMENT_BYTES === 6 * 1024 * 1024);

// ------------------------------------------------ the payload keys match ----

/*
 * ⚠ Every key the SQL reads is a key the client sends.
 *
 *   `complete_guarantor_verification` reads `p_payload->>'full_name'`. A
 *   camelCase key in the client is not a type error anywhere — it is a null in a
 *   column, or a refusal the form cannot explain. So the keys are extracted from
 *   the migration and looked for in the store.
 */
const readKeys = [...migration.matchAll(/p_payload->>'([a-z_]+)'/g)].map((m) => m[1]);
check('the migration reads some payload keys', readKeys.length > 5);
for (const key of [...new Set(readKeys)]) {
  check(`the client sends ${key}`, new RegExp(`\\b${key}:`).test(store), 'a missing key is a null column');
}

// ------------------------------------------------- the vocabularies agree ---

/*
 * The two closed sets are pinned by check constraints. A value offered in the
 * app that the constraint refuses is a dropdown that cannot be submitted.
 */
for (const value of KNOWN_DURATIONS) {
  check(`'${value}' is accepted by the duration constraint`, migration.includes(`'${value}'`));
}
for (const value of EMPLOYMENT_STATUSES) {
  check(`'${value}' is accepted by the employment constraint`, migration.includes(`'${value}'`));
}

/* And the employer rule is the same rule on both sides. */
check('a retired guarantor is not asked for an employer', !needsEmployer('Retired'));
check('an employed one is', needsEmployer('Employed'));
check(
  'and the database agrees',
  /not in \('Retired', 'Unemployed', 'Student'\)/.test(migration),
);

// ---------------------------------------------------- the driver's card -----

check(
  'the tracking card shows the address the invite went to',
  /state\.guarantorEmail/.test(trackingCard),
  'the one fault a driver can fix is the one they have to be able to see',
);
check(
  'and both timestamps, as two different facts',
  /invitedAt/.test(trackingCard) && /emailSentAt/.test(trackingCard),
);
check(
  'saying so when the email has not left yet',
  /Still queued/.test(trackingCard),
  'an unsent email presented as sent is a driver blaming the wrong person',
);
/*
 * ⚠ Asserted on the shape of the data, not on the word.
 *
 *   The card's own comments explain at length why the token is not here, so a
 *   match on the word fails on the explanation. What matters is that nothing
 *   carrying a token reaches the driver at all: the function returns no such
 *   column, the client type has no such field, and the card renders nothing by
 *   that name.
 */
const statusReturns = migration.slice(
  migration.indexOf('create or replace function public.my_guarantor_status'),
  migration.indexOf('$$;', migration.indexOf('create or replace function public.my_guarantor_status')),
);
check(
  'the driver-facing function returns no token',
  statusReturns.length > 0 && !/token/.test(statusReturns),
  'a driver holding the link is a driver guaranteeing themselves',
);
check(
  'the driver-facing type has no token field',
  !/token/i.test(store.slice(store.indexOf('export type GuarantorState'), store.indexOf('/** What the driver may know'))),
);

check(
  'it offers a corrected address',
  /reinviteGuarantor/.test(trackingCard) && /Wrong address/.test(trackingCard),
);
check(
  'and the driver portal shows it only while it is the live question',
  /pending_guarantor/.test(driverPortal) && /ready_for_review/.test(driverPortal),
  'an approved driver carrying "Guarantor verified" forever is a dashboard nobody reads',
);

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — the clause the guarantor reads is the clause that gets stored and clears the\n' +
    "       database's own floor, the live photo can only be taken and never chosen, every\n" +
    '       write goes through the edge function that sees the real address, the payload\n' +
    '       keys are the keys the SQL reads, and the driver sees the address and both\n' +
    '       timestamps but never the token.',
);
