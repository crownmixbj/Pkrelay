/**
 * Assertions for everything between pressing the shutter and the bytes landing.
 *
 * ⚠ Three separate lists have to agree, and nothing made them.
 *
 *   1. `src/lib/upload.ts` maps an extension to the content type a photo is
 *      *sent* under.
 *   2. `src/store/driver-documents.ts` does the same for driver paperwork.
 *   3. Each bucket's `allowed_mime_types`, in SQL, decides what is *accepted*.
 *
 *   When they disagree the failure is silent until a real person has already
 *   taken the photo: the read works, the label is honest, the request is built,
 *   and Storage answers "mime type X is not supported". That has now happened
 *   twice — `text/plain` for a mislabelled JPEG, and `image/heif`, which every
 *   client map has always known and no bucket allowed.
 *
 *   Both are parsed here rather than transcribed, so this cannot pass by the
 *   same wrong thing being written in two places.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/*
 * ⚠ `/*` only counts as a comment when something could precede it.
 *
 *   `driver-signup.tsx` passes `type: ['image/*', 'application/pdf']` to the
 *   document picker. The old pattern saw the `/*` inside that string, ran to
 *   the next real `*\/` hundreds of lines below, and deleted everything in
 *   between — including a guard this file asserts the presence of, and,
 *   worse, code that other negative assertions were checking the *absence* of.
 *   Those passed for the best part of a day by examining a truncated file.
 *
 *   Requiring a boundary character in front distinguishes a comment opener
 *   from two characters in the middle of a string.
 */
const code = (source: string) =>
  source
    .replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------- the two maps ----

/** `heic: 'image/heic',` → the set of content types the client can produce. */
function clientTypes(source: string, constName: string): Set<string> {
  const from = source.indexOf(constName);
  const body = source.slice(from, source.indexOf('};', from));
  return new Set([...body.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/g)].map((m) => m[1]));
}

const uploadTypes = clientTypes(code(read('src/lib/upload.ts')), 'const MIME');
const documentTypes = clientTypes(code(read('src/store/driver-documents.ts')), 'MIME_BY_EXTENSION');

check('the photo map parsed', uploadTypes.size >= 5, [...uploadTypes].join(', '));
check('the document map parsed', documentTypes.size >= 5, [...documentTypes].join(', '));

// ------------------------------------------------------------ the buckets ---

/*
 * Read from the migration that last set each bucket, so this tracks the file a
 * person actually runs rather than a list kept here.
 */
const BUCKET_SOURCES: Record<string, string> = {
  'driver-documents': 'supabase/migrations/20250101000005_storage_and_alerts.sql',
  'delivery-proof': 'supabase/migrations/20250101000010_delivery.sql',
  'sender-photo': 'supabase/migrations/20250101000012_sender_photo.sql',
  'sender-identity': 'supabase/migrations/20250101000028_sender_identity.sql',
};

const WIDENED = 'supabase/migrations/20250101000035_heif_uploads.sql';

function bucketTypes(bucket: string): Set<string> {
  const source = read(BUCKET_SOURCES[bucket]);
  const at = source.indexOf(`'${bucket}',`);
  const arrayStart = source.indexOf('array[', at);
  const body = source.slice(arrayStart, source.indexOf(']', arrayStart));
  return new Set([...body.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/g)].map((m) => m[1]));
}

/*
 * The later migration widens every bucket, so what a bucket accepts is the
 * union of the two files. Both are parsed: reading only the creating migration
 * would report a fix that has shipped as still broken.
 *
 * ⚠ Comments stripped, and the array read by name rather than by sweeping the
 *   file for anything quoted.
 *
 *   My first version regexed the whole migration for `'image/…'`. That file
 *   *explains itself* — its header names `image/heif` four times in prose — so
 *   deleting the type from the actual SQL left the assertion green. An
 *   assertion satisfied by its own documentation is not an assertion, and this
 *   is the second time that shape has bitten in this repo.
 */
const widenedSql = read(WIDENED)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*--.*$/gm, '');

function sqlArrayAfter(source: string, marker: string): Set<string> {
  const at = source.indexOf(marker);
  if (at === -1) return new Set();
  const open = source.indexOf('array[', at);
  const body = source.slice(open, source.indexOf(']', open));
  return new Set([...body.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/g)].map((m) => m[1]));
}

const widened = sqlArrayAfter(widenedSql, 'photo_types text[] :=');

check(
  'the widening migration parsed',
  widened.size >= 5 && !widened.has('application/pdf'),
  `${[...widened].join(', ')} — the photo list is images only; PDF is concatenated per bucket`,
);

/** Which buckets the migration additionally grants `application/pdf`. */
const widenedPdf = /photo_types \|\| array\['application\/pdf'\]/.test(widenedSql);
check(
  'and still grants the two document buckets a PDF',
  widenedPdf,
  'a NIN slip and an insurance certificate are as often PDFs as photographs',
);

const DOCUMENT_BUCKETS = ['driver-documents', 'sender-identity'];

/*
 * ⚠ The widening migration *replaces* each list rather than appending to it, so
 *   what a bucket accepts afterwards is what that file sets — not the union
 *   with what created it. Treating it as a union would have hidden a migration
 *   that dropped a type.
 */
const accepts = (bucket: string): Set<string> => {
  const allowed = new Set(widened);
  if (DOCUMENT_BUCKETS.includes(bucket) && widenedPdf) allowed.add('application/pdf');
  return allowed;
};

// --------------------------------------------------- and they have to agree --

/*
 * Every photo bucket has to accept every image type the shared reader can
 * produce. PDF is excluded here on purpose: `assertImageBytes` refuses one on
 * the client before a request is built for these two, which is why they are
 * allowed to be narrower.
 */
const imageTypes = [...uploadTypes].filter((type) => type.startsWith('image/'));

for (const bucket of ['sender-photo', 'delivery-proof', 'sender-identity']) {
  const allowed = accepts(bucket);
  const missing = imageTypes.filter((type) => !allowed.has(type));

  check(
    `${bucket} accepts every image type the app can send it`,
    missing.length === 0,
    `${missing.join(', ')} would be read, labelled honestly, uploaded and refused`,
  );
}

check(
  'and the identity bucket still takes a PDF slip',
  accepts('sender-identity').has('application/pdf'),
  'a NIN slip is as often a PDF as a photograph',
);

/*
 * 35 replaces each list rather than appending, so it is able to *narrow* a
 * bucket by omission — a type that used to be accepted quietly disappearing.
 * Every type the creating migration granted must still be granted.
 */
for (const bucket of Object.keys(BUCKET_SOURCES)) {
  const lost = [...bucketTypes(bucket)].filter((type) => !accepts(bucket).has(type));
  check(
    `${bucket} lost nothing when the list was rewritten`,
    lost.length === 0,
    `${lost.join(', ')} was accepted before 20250101000035_heif_uploads.sql and is not now`,
  );
}

const documentMissing = [...documentTypes].filter((type) => !accepts('driver-documents').has(type));
check(
  'driver-documents accepts every type its own picker offers',
  documentMissing.length === 0,
  documentMissing.join(', '),
);

/*
 * And the reverse for the photo buckets: nothing may be accepted that the
 * client refuses to send, because that is a rule nobody can discover.
 */
check(
  'the two photo buckets refuse PDFs',
  !accepts('sender-photo').has('application/pdf') &&
    !accepts('delivery-proof').has('application/pdf'),
  'assertImageBytes refuses one on the client; a bucket that took it would make that guard a lie',
);

// ------------------------------------------------- the size cap, both ways ---

const signup = code(read('src/app/(tabs)/driver-signup.tsx'));

check(
  'both attach paths check the size',
  (signup.match(/> MAX_DOCUMENT_BYTES/g) ?? []).length >= 2,
  'the file browser refused an oversized file and the camera did not, so a large photo failed at submit instead of at capture',
);
check(
  'and the client cap matches the bucket',
  /MAX_DOCUMENT_BYTES = 10 \* 1024 \* 1024/.test(read('src/store/driver-documents.ts')) &&
    read(BUCKET_SOURCES['driver-documents']).includes('10485760'),
  'a client cap above the bucket limit turns a local refusal into a remote one',
);

// ------------------------------------------------------ the camera itself ---

/*
 * Every camera call asks for permission first.
 *
 * `launchCameraAsync` on a phone that has never been asked returns a cancelled
 * result rather than an error, which is indistinguishable from the person
 * changing their mind — so the app would silently do nothing.
 */
for (const path of [
  'src/components/ui/sender-photo-sheet.tsx',
  'src/app/(tabs)/driver-signup.tsx',
  'src/app/capture/[id].tsx',
  'src/components/ui/photo-picker.tsx',
]) {
  const source = code(read(path));
  if (!source.includes('launchCameraAsync')) continue;

  check(
    `${path.split('/').pop()} asks for the camera before opening it`,
    source.includes('requestCameraPermissionsAsync'),
    'a refusal without a prompt is indistinguishable from the person cancelling',
  );
}

check(
  'the camera permission strings are declared for both stores',
  (() => {
    const app = JSON.parse(read('app.json')).expo;
    const plugin = (app.plugins ?? []).find(
      (entry: unknown) => Array.isArray(entry) && entry[0] === 'expo-image-picker',
    );
    return (
      Boolean(app.ios?.infoPlist?.NSCameraUsageDescription) &&
      Boolean(plugin?.[1]?.cameraPermission)
    );
  })(),
  'iOS kills the app on a missing usage string, and Android needs the plugin to add CAMERA',
);

// ------------------------------------------------- is this build the build ---

/*
 * ⚠ Three fixes have been reported as not working while working.
 *
 *   Each time the code was right and something older was in the way: the bundle
 *   on the device, or the schema in the database. The app could not tell the
 *   two apart from the inside, so the only way to find out was another round
 *   trip. `DeploymentPanel` answers both, and these assertions keep it honest.
 */
const deployment = code(read('src/store/deployment.ts'));

/*
 * ⚠ The capability list moved out of the panel's own file.
 *
 *   It now lives in `lib/schema-gap.ts`, shared with the code that turns a
 *   missing-function error into the name of the migration to run — one list, so
 *   the panel and the error message cannot disagree about which file to run.
 *   This scrape followed it rather than silently finding nothing, which is what
 *   it did for one run: zero capabilities parsed, and every check below it
 *   skipped without a word.
 */
const capabilityList = code(read('src/lib/schema-gap.ts'));

check(
  'the schema is probed without calling anything',
  deployment.includes('/rest/v1/') && !/supabase\.rpc\(/.test(deployment),
  'calling admin_reveal_sender_identity to see whether it exists would log that an admin looked at a face',
);
check(
  'a probe that fails reports as unknown rather than as missing',
  /present: exposed \? exposed\.has\(fn\) : null/.test(deployment),
  'a network failure rendered as "migration missing" would send somebody to re-run SQL that is already applied',
);
check(
  'and the panel names the file to run',
  code(read('src/components/ui/deployment-panel.tsx')).includes('capability.migration'),
  '"missing" says there is a problem; the file name says what to do about it',
);

/*
 * Every capability names a function that some migration actually creates —
 * otherwise the panel reports a permanent failure for something that was never
 * going to be there.
 */
const migrations = readdirSync(join(ROOT, 'supabase/migrations')).filter((name) => name.endsWith('.sql'));

const claims = [...capabilityList.matchAll(/fn: '(\w+)'[\s\S]{0,80}?migration: '([\w.]+)'/g)].map(
  (match) => ({ fn: match[1], file: match[2] }),
);

check('the capability list parsed', claims.length >= 5, `${claims.length} capabilities`);

for (const claim of claims) {
  check(
    `${claim.file} exists`,
    migrations.includes(claim.file),
    `named by the deployment panel but not in supabase/`,
  );
  check(
    `and creates ${claim.fn}`,
    read(`supabase/migrations/${claim.file}`).includes(`function public.${claim.fn}(`),
    'the panel would report this as never applied, however many times it was run',
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — every content type the app can produce is one its bucket accepts, the two photo\n' +
    '       buckets still refuse PDFs, both attach paths check the size against the same cap\n' +
    '       the bucket enforces, no camera opens without asking first, and the admin panel\n' +
    '       can say which migrations this database is missing without calling any of them.',
);
