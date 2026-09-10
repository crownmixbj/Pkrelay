/**
 * Assertions for the Dojah liveness integration.
 *
 * Three things carry real risk here, and everything below guards one of them:
 *
 *   1. The secret key. Anything reachable from the client bundle is readable by
 *      anyone who installs the app, and a leaked Dojah key spends Package Relay's wallet.
 *   2. The sandbox/production distinction. Dojah's own docs: "Never use mock
 *      data to make a live trust decision." A sandbox pass rendered like a real
 *      one is exactly that mistake.
 *   3. The difference between "not a live person" and "the provider is down".
 *      Confusing them turns a Dojah outage into every sender in Nigeria being
 *      accused of fraud and unable to post a parcel.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_FACE_MATCH_PATH,
  DOJAH_BASE_URLS,
  IDENTITY_THRESHOLD,
  LIVENESS_THRESHOLD,
  bareBase64,
  compareFaces,
  interpret,
  interpretFaceMatch,
  readCredentials,
} from '../supabase/functions/verify-liveness/dojah';
import {
  maskNin,
  maskNinInput,
  ninError,
  normalizeNin,
  OUTCOME_MESSAGES,
  pathExplanation,
  verificationPath,
  type SenderIdentity,
} from '../src/store/identity';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');

const flat = (source: string) => source.replace(/\s+/g, ' ');

const fn = read('supabase/functions/verify-liveness/index.ts');
const fnCode = code(fn);
const dojahModule = read('supabase/functions/verify-liveness/dojah.ts');
const sql = read('supabase/migrations/20250101000014_liveness.sql');
const sqlCode = code(sql);
const store = read('src/store/capture-session.ts');
const storeCode = code(store);

// ------------------------------------------------------------ the secret ---

/*
 * The key must not be reachable from anything that ships to a device.
 *
 * Walked over the whole of src/ rather than spot-checked: the failure mode is
 * one careless import months from now, and a list of files to check would go
 * stale before the risk did.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const clientFiles = walk('src');

check(
  'no client file mentions the Dojah secret',
  clientFiles.every((path) => !/DOJAH_SECRET_KEY|DOJAH_APP_ID/.test(read(path))),
  'anything in src/ is compiled into the bundle and readable by anyone who installs the app',
);
check(
  'and no EXPO_PUBLIC_ variable carries a Dojah credential',
  !/EXPO_PUBLIC_DOJAH/.test(clientFiles.map((path) => read(path)).join('\n')) &&
    !/EXPO_PUBLIC_DOJAH/.test(read('eas.json')) &&
    !/EXPO_PUBLIC_DOJAH/.test(read('.env.example')),
  'the EXPO_PUBLIC_ prefix is exactly what puts a value into the client bundle',
);
check(
  'the client sends only a session id',
  flat(storeCode).includes('body: { session_id: sessionId }') &&
    !/image/.test(flat(storeCode).split('runLivenessCheck')[1] ?? ''),
  're-sending the image would let a client check one photo and upload another',
);
check(
  'the server reads the image from storage itself',
  flat(fnCode).includes('/storage/v1/object/sender-photo/${session.photo_path}'),
  'what gets checked has to be what was uploaded',
);

check(
  'the key goes in a header with no Bearer prefix',
  flat(dojahModule).includes('Authorization: credentials.secretKey') &&
    !/Authorization: `Bearer \$\{credentials\.secretKey\}`/.test(dojahModule),
  'Dojah rejects a Bearer prefix — it is the most common cause of a confusing 401',
);

// ---------------------------------------------------------- who is asking --

check(
  'the caller is identified from their JWT, not from the request body',
  flat(fnCode).includes('/auth/v1/user') && !/body\.user_id|body\.owner/.test(fnCode),
  'a body-supplied id would let any account run checks against another person’s session',
);
check(
  'the session lookup is scoped to the caller',
  flat(fnCode).includes('owner_id=eq.${encodeURIComponent(userId)}'),
  'the service role bypasses RLS, so every query has to filter by owner itself',
);
check(
  'a session already checked is not checked again',
  flat(fnCode).includes('if (session.liveness_status) {'),
  'retrying the same image until a probabilistic check passes is what liveness exists to deny',
);

// ------------------------------------------------- sandbox vs production ---

check(
  'the sandbox base URL is the documented one',
  DOJAH_BASE_URLS.sandbox === 'https://sandbox.dojah.io',
);
check(
  'and production is the documented one',
  DOJAH_BASE_URLS.production === 'https://api.dojah.io',
);
check('the two differ', DOJAH_BASE_URLS.sandbox !== DOJAH_BASE_URLS.production);

check(
  'an unset environment falls back to sandbox',
  readCredentials({ DOJAH_APP_ID: 'a', DOJAH_SECRET_KEY: 'b' })?.environment === 'sandbox',
  'defaulting to production would spend real money from the wallet on a misconfigured deploy',
);
check(
  'production is opt-in by exact word',
  readCredentials({ DOJAH_APP_ID: 'a', DOJAH_SECRET_KEY: 'b', DOJAH_ENVIRONMENT: 'production' })
    ?.environment === 'production' &&
    readCredentials({ DOJAH_APP_ID: 'a', DOJAH_SECRET_KEY: 'b', DOJAH_ENVIRONMENT: 'prod' })
      ?.environment === 'sandbox',
);
check(
  'missing credentials yield null rather than throwing',
  readCredentials({}) === null && readCredentials({ DOJAH_APP_ID: 'a' }) === null,
  'a Package Relay instance with no Dojah account still has to be able to post parcels',
);

check(
  'the environment is recorded on every verdict',
  flat(sqlCode).includes('liveness_environment text') &&
    flat(fnCode).includes('environment: result.environment'),
);
check(
  'a sandbox pass is labelled as not a real verification',
  flat(storeCode).includes("'Liveness check passed (test mode — not a real verification)'"),
  'Dojah’s own documentation: never use mock data to make a live trust decision',
);

// ------------------------------------------- failed vs unavailable, again --

const passing = {
  entity: {
    face: { face_detected: true, multiface_detected: false },
    liveness: { liveness_check: true, liveness_probability: 98 },
  },
};

check('a clean response passes', interpret(passing, 'production').verdict === 'passed');
check(
  'a low probability fails even when the provider says true',
  interpret(
    {
      entity: {
        face: { face_detected: true, multiface_detected: false },
        liveness: { liveness_check: true, liveness_probability: LIVENESS_THRESHOLD - 1 },
      },
    },
    'production',
  ).verdict === 'failed',
  'the threshold is a second opinion on the number behind the boolean',
);
check(
  'no face is a failure, not an outage',
  interpret(
    {
      entity: {
        face: { face_detected: false },
        liveness: { liveness_check: false, liveness_probability: 0 },
      },
    },
    'production',
  ).verdict === 'failed',
);
check(
  'two faces is a failure',
  interpret(
    {
      entity: {
        face: { face_detected: true, multiface_detected: true },
        liveness: { liveness_check: true, liveness_probability: 99 },
      },
    },
    'production',
  ).verdict === 'failed',
);

check(
  'an empty body is unavailable, not failed',
  interpret({}, 'sandbox').verdict === 'unavailable',
  'a provider outage must not read as "this person is not real"',
);
check(
  'and so is a response missing the liveness block',
  interpret({ entity: { face: { face_detected: true } } }, 'sandbox').verdict === 'unavailable',
  'if Dojah renames a field, senders must not all start failing',
);
check(
  'unavailable does not block posting',
  flat(storeCode).includes("return outcome.status === 'failed';"),
  'blocking every parcel because a third party is down is a worse failure than an unchecked photo',
);
check(
  'and the server agrees',
  flat(sqlCode).includes("if claimed_status = 'failed' then") &&
    !flat(sqlCode).includes("claimed_status = 'unavailable' then raise"),
  'the client refusing is not the rule — this is',
);

// -------------------------------------------------------------- the rest --

check(
  'a client cannot write its own verdict',
  flat(sqlCode).includes('guard_liveness_columns') &&
    flat(sqlCode).includes('Liveness results are written by the verification service'),
  'without this the whole check is advisory — a modified client sets its own status to passed',
);
check(
  'the guard lets the service role through',
  flat(sqlCode).includes('if auth.uid() is null then return new;'),
  'the edge function has no auth.uid(), and it is the one caller that must be able to write',
);

check(
  'a data-URL prefix is stripped before sending',
  bareBase64('data:image/jpeg;base64,ABC') === 'ABC' && bareBase64('ABC') === 'ABC',
  'the browser camera produces a data URL, and sending the prefix is a 400 that looks like a bad image',
);

check(
  'the provider payload does not reach the client',
  !/age_range|emotions|gender/.test(fnCode.split('return json({')[1] ?? ''),
  'age, gender and emotion are not needed to post a parcel and there is no basis to collect them',
);

check(
  'the passive-versus-active limit is written down where it will be read',
  /passive/i.test(dojahModule) && /passive/i.test(sql) && existsSync(join(ROOT, 'docs/DOJAH.md')),
  'a still-image check rejects a printed photo but not a video replayed on a second screen',
);

// ---------------------------------------- which path a sender is put down --

const identity = (over: Partial<SenderIdentity>): SenderIdentity => ({
  status: 'verified',
  hasReference: true,
  ninLast4: '8901',
  confidence: 95,
  environment: 'sandbox',
  checkedAt: new Date().toISOString(),
  reviewNote: null,
  ...over,
});

check('a sender with no record does the full onboarding', verificationPath(null) === 'onboarding');
check(
  'and so does one who started and never finished',
  verificationPath(identity({ status: 'pending' })) === 'onboarding' &&
    verificationPath(identity({ status: 'unverified' })) === 'onboarding',
  'treating pending as done would skip the check for everyone who abandoned partway, which is the population most worth checking',
);
check(
  'a verified sender is asked only for a selfie',
  verificationPath(identity({ status: 'verified', hasReference: true })) === 'selfie',
  'this is the whole feature — no NIN, no slip, on every parcel after the first',
);
check(
  'a flagged sender is not sent round onboarding again',
  verificationPath(identity({ status: 'flagged', hasReference: false })) !== 'onboarding',
  'they gave a NIN, a slip and a photo; asking again punishes them for a decision nobody has made yet',
);
check(
  'but their selfie is recorded rather than matched',
  verificationPath(identity({ status: 'flagged', hasReference: false })) === 'capture',
  'an unmatched selfie is never promoted to reference, so there is nothing to compare against — the state I left out of the SQL until the harness caught it',
);
check(
  'each path explains what it is about to ask for',
  (['onboarding', 'selfie', 'capture'] as const).every((path) => pathExplanation(path).length > 20),
);
check(
  'and only the onboarding path mentions the NIN',
  /NIN/.test(pathExplanation('onboarding')) &&
    !/NIN/.test(pathExplanation('selfie')) &&
    !/NIN/.test(pathExplanation('capture')),
);

check(
  'a NIN is eleven digits, and the error says how many you gave',
  ninError('1234567890') === 'A NIN is 11 digits — you have 10.' &&
    ninError('12345678901') === null,
);
check('spacing and dashes are accepted', ninError('123-4567-8901') === null);
check('an empty field asks rather than scolds', ninError('') === 'Enter your 11-digit NIN.');
check('the stored form is digits only', normalizeNin('123-4567 8901') === '12345678901');

/*
 * ---------- the cap lives on the input, not only on the validator ----------
 *
 * The sender's NIN field shipped with `maxLength={14}` and no digit mask, so
 * somebody could type fourteen characters — or paste a spaced number — and only
 * be told on submit. `ninError` was right the whole time and was the wrong
 * place to find out: the form was already finished.
 *
 * The mask is asserted rather than the maxLength, because `maxLength` counts
 * *characters*: on its own it would let eleven characters of "123-456-7890"
 * through and call that a complete NIN.
 */
check(
  'a twelfth digit cannot be typed at all',
  maskNinInput('123456789012') === '12345678901',
  'more than eleven should be structurally impossible, not merely refused on submit',
);
check(
  'and punctuation is dropped rather than counted toward the eleven',
  maskNinInput('123-4567 8901') === '12345678901',
  'maxLength counts characters; without the mask "123-456-7890" reads as a full NIN',
);
check(
  'but a half-typed NIN is left alone',
  maskNinInput('123') === '123',
  'a field that truncates or complains on the third keystroke is shouting at somebody still typing',
);
/*
 * Read locally rather than reusing `onboarding`, which is declared ninety lines
 * below this block. Reaching for it here is a temporal-dead-zone access, and
 * the whole assertion resolved to nothing useful instead of failing loudly.
 */
const ninField = read('src/components/ui/identity-onboarding.tsx');
check(
  'the sender field masks on every keystroke and caps at the shared length',
  /onChangeText=\{\(text\) => onNin\(maskNinInput\(text\)\)\}/.test(ninField) &&
    /maxLength=\{NIN_LENGTH\}/.test(ninField) &&
    !/maxLength=\{1[0-9]\}/.test(ninField),
  'a hard-coded 14 here is what let a fourteen-character NIN be typed',
);

/*
 * The other two NIN boxes, on the driver profile editor. Same defect, same fix
 * — asserted here so all three stay together rather than drifting apart the
 * next time one of them is touched.
 */
const editSheet = read('src/components/ui/profile-edit-sheet.tsx');
check(
  'the profile editor masks its NIN and guarantor NIN too',
  (editSheet.match(/mask: maskNinInput/g) ?? []).length === 2 &&
    (editSheet.match(/maxLength: NIN_LENGTH/g) ?? []).length === 2,
  'both are eleven-digit fields and neither was bounded',
);
/*
 * Counted, not merely present.
 *
 * The sheet renders `Field` from two places — the everyday sections and the
 * identity disclosure — and the NIN boxes live in the second. Testing that the
 * mask is applied *somewhere* passed while the identity site was reverted to a
 * bare `set(field.key)`, which is precisely where it matters.
 */
check(
  'and both render sites actually apply the mask they declare',
  (editSheet.match(/field\.mask \? field\.mask\(text\) : text/g) ?? []).length === 2,
  'a declared mask nothing calls is the same as no mask',
);
check(
  'and only the last four are ever rendered',
  maskNin('8901') === '•••• •••• 8901' && maskNin(null) === 'Not on file',
);

// --------------------------------------- comparing a face against a face ---

check(
  'a confident match is a match',
  interpretFaceMatch(
    { entity: { selfie_verification: { match: true, confidence_value: 97 } } },
    'sandbox',
  ).verdict === 'matched',
);
check(
  'a low score is not, however confident the flag',
  interpretFaceMatch(
    { entity: { selfie_verification: { match: true, confidence_value: IDENTITY_THRESHOLD - 1 } } },
    'sandbox',
  ).verdict === 'mismatch',
  'the threshold is the decision, not the provider boolean',
);
check(
  'the flat response shape is read too',
  interpretFaceMatch({ entity: { match: true, confidence_value: 98 } }, 'sandbox').verdict ===
    'matched',
  'the NIN endpoint nests its verdict and the photo-ID ones have been seen not to; reading one shape only fails silently forever',
);
check(
  'an empty answer is unavailable, never a mismatch',
  interpretFaceMatch({ entity: {} }, 'sandbox').verdict === 'unavailable' &&
    interpretFaceMatch(null, 'sandbox').verdict === 'unavailable',
  'a renamed field must never read as "this is a different person"',
);

// ------------------------------- what a sender is shown, and never shown ---

const onboarding = read('src/components/ui/identity-onboarding.tsx');
const identitySql = read('supabase/migrations/20250101000028_sender_identity.sql');
const identityStore = read('src/store/identity.ts');

check(
  'the whole form appears on the first parcel only',
  code(onboarding).includes("if (path !== 'onboarding') {"),
  'repeating it on every parcel makes a solved problem look like an ongoing one — and it is the friction this feature exists to remove',
);
check(
  'a returning sender sees the masked NIN, never the number',
  code(onboarding).includes('maskNin(identity?.ninLast4 ?? null)') &&
    !/\{identity\?\.nin\}/.test(onboarding),
);
check(
  'and the client only ever holds four digits of it',
  code(identityStore).includes('ninLast4: row.nin ? row.nin.slice(-4) : null'),
);
check(
  'the sender is told the NIN leaves Package Relay before they type it',
  /Used once, to check your NIN photo/.test(onboarding),
  'matching against a government record means telling the provider which record; that belongs on the form, not in a policy page',
);
check(
  'and that the selfie is kept as a reference',
  /kept as your reference photo/.test(onboarding),
);
check(
  'the slip is described as evidence, not as the thing matched against',
  /matched against the NIMC record, not\s*\n?\s*against this photo/.test(onboarding),
  'a slip is an image the sender supplies, so a forged one matches a forged face perfectly',
);

check(
  'a flagged account is told its parcels still go out',
  /still go out as normal/.test(onboarding),
  'the answer to "flag rather than block" has to reach the person it is about',
);
check(
  'and nothing in the flow refuses a shipment',
  // Flattened: prettier wraps the object across lines, so a literal
  // `return { ok: false` never matches and the check could not fail.
  !/return \{ ok: false/.test(
    flat(code(identityStore)).slice(
      flat(code(identityStore)).indexOf('export async function runIdentityCheck'),
    ),
  ),
  'a mismatch is an outcome, not an error; returning one would have callers block the parcel on it',
);
/*
 * ⚠ Repointed. This pinned the sentence "Your parcel is not held up", which
 *   `20250101000042_verified_senders_only.sql` turned into a lie.
 *
 *   The property it was really defending is that an outage is an *outcome*
 *   rather than a refusal: the selfie is stored, the check can be re-run, and
 *   nothing about the sender is held against them. That is unchanged. What
 *   changed is that the parcel now does wait — so the assertion follows the
 *   status, and `verify-posting-gate.ts` polices the wording.
 */
check(
  'an unreachable provider reads as unavailable, not as a refusal',
  code(identityStore).includes("status: 'unavailable'") &&
    /saved/i.test(OUTCOME_MESSAGES.unavailable),
  'a transport failure says nothing about the sender, and their submission is kept',
);
check(
  'and does not tell them their parcel is unaffected',
  !/not held up|still goes ahead/i.test(OUTCOME_MESSAGES.unavailable),
  'only a verified sender can post; that reassurance stopped being true',
);

check(
  'the reference photo is only ever set from a matched check',
  flat(code(identitySql)).includes(
    "reference_path = case when verdict = 'verified' then coalesce(reference, reference_path) else reference_path end",
  ),
  'enrolling an unmatched face would make every later comparison agree with the wrong person',
);
check(
  'an outage writes no verdict at all',
  flat(code(identitySql)).includes(
    "if verdict = 'unavailable' then update public.sender_identity set checked_at = now()",
  ),
  'Dojah being down is not evidence about the sender in either direction',
);
check(
  'a sender cannot write their own status',
  !/create policy[^;]*for (insert|update)[^;]*sender_identity/is.test(identitySql) &&
    flat(code(identitySql)).includes(
      'revoke all on function public.record_identity_result(uuid, text, text, numeric, text) from public, anon, authenticated',
    ),
  'a sender who could write this table could set themselves verified',
);
check(
  'the admin queue carries neither the NIN nor a photo path',
  (() => {
    const fn = flat(code(identitySql));
    const from = fn.indexOf('create or replace function public.admin_flagged_identities');
    const body = fn.slice(from, fn.indexOf('$$;', from));
    return (
      body.includes('right(i.nin, 4)') &&
      !body.includes('reference_path') &&
      !body.includes('slip_path')
    );
  })(),
  'a review queue is a screen somebody leaves open; it should not be a gallery of customers faces',
);
check(
  'the legal position is stated in the migration rather than assumed',
  /LEGAL_REVIEW_REQUIRED/.test(identitySql) &&
    /uniquely identifying a natural person/.test(identitySql) &&
    /no retention rule/i.test(identitySql),
  'this extends biometric processing from a few vetted drivers to every customer, and nothing deletes a reference photo',
);

// -------------------------------- where it sits, now that it has moved ------

const bookScreen = read('src/app/(tabs)/book.tsx');
const bookCode = code(bookScreen);
const profileScreen = read('src/app/(tabs)/profile.tsx');
const profileCode = code(profileScreen);
const verifyCard = code(read('src/components/ui/verify-identity-card.tsx'));

/*
 * ⚠ Five assertions here used to pin the NIN card to the booking form, and
 *   they failed the moment it moved. They were right when written and are
 *   repointed rather than deleted, because the thing they were protecting is
 *   still worth protecting — it just lives somewhere else now.
 *
 *   The card was step two of Post a Parcel: a government ID check in the middle
 *   of somebody trying to send a package. It is account-level data, a second
 *   parcel never re-asked for it, and it is now on the profile.
 */
check(
  'the booking form asks for no NIN',
  !bookCode.includes('<IdentityOnboarding') && !/\bninError\(/.test(bookCode),
  'the whole point of the move is that sending a parcel no longer requires a government ID check first',
);
check(
  'and holds no NIN or slip state',
  !/const \[nin,/.test(bookCode) && !/const \[slipUri,/.test(bookCode),
  'state left behind is a field somebody re-renders later',
);

/*
 * ⚠ Reversed, deliberately, and the old assertion is worth reading first.
 *
 *   This said "an unverified sender is not blocked from posting", and warned
 *   that a form branching on verification would eventually branch into a
 *   refusal. It has: the app now uses a just-in-time gate, and the refusal is
 *   the point rather than an accident.
 *
 *   What survives is the shape of the objection. The gate must sit at the end,
 *   so the form still fills freely; it must stop only people who have never
 *   submitted; and it must open when verification itself is unreachable. All
 *   three are asserted in `verify-posting-gate`, which is where this moved
 *   rather than where it died.
 */
check(
  'the form still asks for no NIN, gate or no gate',
  !/<IdentityOnboarding/.test(bookCode) && !/\bninError\(/.test(bookCode),
  'the gate routes to the profile; it must not quietly bring the form back',
);
check(
  'the per-parcel selfie survived the removal',
  bookCode.includes('<LiveSelfieCard') && bookCode.includes('runIdentityCheck(sessionId)'),
  'the selfie is about *this* parcel — who handed it over — and was never the thing being moved',
);
check(
  'and it runs one check rather than branching',
  !bookCode.includes('submitOnboarding'),
  'the onboarding branch depended on fields this form no longer collects',
);

/*
 * ⚠ Moved, not deleted. `submitOnboarding` was dead code once before in this
 *   project — collected and discarded — and removing its last caller without
 *   adding a new one would put it straight back there, with the profile
 *   screen's "Added when you verify your identity" pointing at nothing.
 */
check(
  'the profile can submit a NIN',
  verifyCard.includes('submitOnboarding({ nin, slipUri, sessionId })'),
  'without a caller the NIN check is dead code and no sender can ever be verified',
);
check(
  'the profile renders the card',
  profileCode.includes('<VerifyIdentityCard'),
  'a component nobody mounts is the same as no component',
);
check(
  'the NIN never enters the booking form state',
  !/nin/i.test(
    bookCode.slice(bookCode.indexOf('type BookingForm'), bookCode.indexOf('const INITIAL_FORM')),
  ),
  'everything in `form` is written to an on-device draft on every keystroke; a NIN there is a government identifier sitting unencrypted in AsyncStorage on a phone that may be shared or resold',
);
check(
  'and does not enter a draft on the profile either',
  !/saveDraft/.test(verifyCard),
  'the reason a NIN was kept out of the booking draft applies wherever it is typed',
);
check(
  'the draft is saved from the form only',
  bookCode.includes('saveDraft(form);') && !/saveDraft\([^)]*nin/i.test(bookCode),
);

/*
 * ⚠ The selfie is still required *with* the NIN, wherever they are asked.
 *
 *   `submitOnboarding` matches the slip against a live photograph and promotes
 *   it to the account's master reference. A NIN accepted without one is a
 *   number nobody has confirmed belongs to the person who typed it, and it
 *   would leave every later parcel with nothing to compare against.
 */
check(
  'the profile takes a selfie alongside the NIN',
  verifyCard.includes('<LiveSelfieCard'),
  'without it there is nothing to match the slip against and no reference for later parcels',
);
check(
  'and refuses the camera until the NIN and slip are there',
  /const gate = \(proceed[\s\S]{0,400}ninError\(nin\)/.test(verifyCard) &&
    verifyCard.includes('gate={gate}'),
  'validating after the photo throws away work for an error that was knowable before it',
);
check(
  'a verified sender is not asked again',
  verifyCard.includes("if (path !== 'onboarding') return null;"),
  'the card is the way to become verified, not a permanent fixture of the profile',
);

check(
  'the labels say whose NIN it is',
  /National Identification Number/.test(onboarding) && /Verify your identity/.test(onboarding),
  'it sits under a field called "Contact person", which is often a shop assistant rather than the account holder — the copy has to disambiguate',
);

/*
 * Wrapped and called below: the verify scripts bundle to CJS, which has no
 * top-level await.
 */
async function faceMatchChecks() {
  const credentials = {
    appId: 'app',
    secretKey: 'secret',
    environment: 'sandbox' as const,
  };

  let sent: { url: string; body: string } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent = { url: String(url), body: String(init.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        entity: { selfie_verification: { match: true, confidence_value: 96 } },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const matched = await compareFaces(
    'data:image/jpeg;base64,AAA',
    'BBB',
    credentials,
    DEFAULT_FACE_MATCH_PATH,
    fakeFetch,
  );

  check('a comparison reaches the sandbox host', sent!.url.startsWith(DOJAH_BASE_URLS.sandbox));
  check('at the configured path', sent!.url.endsWith(DEFAULT_FACE_MATCH_PATH));
  check(
    'with the data URI prefix stripped from both images',
    !sent!.body.includes('data:image') && sent!.body.includes('AAA') && sent!.body.includes('BBB'),
  );
  check('and the verdict comes back', matched.verdict === 'matched' && matched.confidence === 96);

  const unset = await compareFaces('AAA', 'BBB', credentials, null, fakeFetch);
  check(
    'an unconfigured endpoint is unavailable rather than an error',
    unset.verdict === 'unavailable',
    'I could not read Dojah docs from here, so the path is a setting — and with it unset every repeat sender is recorded rather than matched, which is the outage behaviour and breaks nothing',
  );

  const dead = (async () => {
    throw new Error('network');
  }) as unknown as typeof fetch;
  check(
    'a dead network is unavailable, not a mismatch',
    (await compareFaces('A', 'B', credentials, DEFAULT_FACE_MATCH_PATH, dead)).verdict ===
      'unavailable',
  );

  const refused = (async () =>
    ({
      ok: false,
      status: 402,
      json: async () => ({}),
    }) as unknown as Response) as unknown as typeof fetch;
  check(
    'and an out-of-credit account is unavailable too',
    (await compareFaces('A', 'B', credentials, DEFAULT_FACE_MATCH_PATH, refused)).verdict ===
      'unavailable',
    'a 402 says something about the Package Relay account, not about the sender holding the phone',
  );
}

// ------------------------------------------- the capture is live, or nothing --

/*
 * ⚠ The gallery must not be reachable from any selfie path.
 *
 *   The entire claim the photo makes is that it was taken now, by the person
 *   holding the device. One `launchImageLibraryAsync` on this path and the
 *   claim is worth nothing — a saved picture of somebody else passes, and every
 *   downstream check, including the NIN match, is checking the wrong face.
 *
 *   `photo-picker.tsx` is deliberately absent from this list. It collects
 *   licences and insurance certificates, which people photograph in advance and
 *   should be able to attach from their camera roll.
 */
for (const path of [
  'src/components/ui/sender-photo-sheet.tsx',
  'src/components/ui/live-selfie-card.tsx',
  'src/app/capture/[id].tsx',
]) {
  const source = code(read(path));
  check(
    `${path.split('/').pop()} cannot reach the photo gallery`,
    !/launchImageLibraryAsync|requestMediaLibraryPermissionsAsync|MediaLibrary/.test(source),
    'a saved picture would pass every check the live one is there to survive',
  );
}

check(
  'the native capture opens the front camera',
  flat(code(read('src/components/ui/sender-photo-sheet.tsx'))).includes(
    'cameraType: ImagePicker.CameraType.front',
  ),
  'the rear camera on a selfie step is a prompt to photograph something else',
);

/*
 * Both long forms refuse to submit without a session, in the handler as well as
 * on the button.
 *
 * The disabled prop is the one people see; this is the one that still holds
 * when the account signs out between capture and submit, or a saved draft comes
 * back with the confirmation already ticked.
 */
for (const [label, path] of [
  ['the parcel', 'src/app/(tabs)/book.tsx'],
  ['the application', 'src/app/(tabs)/driver-signup.tsx'],
] as const) {
  const source = code(read(path));
  check(
    `${label} cannot be submitted without a live photo`,
    /if \(!photoSession\) \{[\s\S]{0,400}?return;/.test(source),
    'a guard that lives only in a `disabled` prop is one code path away from not existing',
  );
  check(
    `and the session is never written to ${label}'s saved draft`,
    !/photoSession/.test(source.split('useFormDraft')[1]?.slice(0, 600) ?? ''),
    'a restored session is spent or expired — a green tick on a photograph that is gone',
  );
}

void faceMatchChecks().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }

  console.log(
    'PASS — the Dojah secret is unreachable from the client bundle, the caller is identified\n' +
      '       from their own token, the image is read server-side, a sender onboards once and\n' +
      '       shows a face thereafter, sandbox is labelled as mock wherever a sender sees it,\n' +
      '       no selfie path can reach the photo gallery, neither form submits without a live\n' +
      '       capture, and a provider outage never reads as a failed person.',
  );
});
