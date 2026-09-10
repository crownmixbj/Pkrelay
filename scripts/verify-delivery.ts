/**
 * Assertions for advancing a delivery and proving it happened.
 *
 * Weighted toward `supabase/migrations/20250101000010_delivery.sql`, because that is where the rules
 * actually live. The client can be modified by anyone holding the phone; the
 * things that must be true — only the carrier moves a parcel, stages never skip
 * or reverse, a delivery cannot be recorded without a name, and a proof photo
 * cannot be replaced after the fact — are true only if the SQL says so.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BOOKING_STAGES, type Booking, type BookingStage } from '../src/store/bookings';
import {
  activeLeg,
  advanceLabel,
  awaitingPickup,
  driverAlerts,
  isFinalStep,
  nextStage,
  proofPath,
  readPhotoBytes,
  uploadProof,
  type PhotoBytes,
} from '../src/store/delivery';
import { assertImageBytes, contentTypeFor } from '../src/lib/upload';
import { supabase } from '../src/lib/supabase';
import { deliveredLabel, earningsSummary } from '../src/store/earnings';
import { dialUrl, navigationUrl, normalizePhone } from '../src/lib/handoff';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Comments stripped: these files explain the rules they enforce. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');

/** Collapses the line breaks Prettier introduces inside JSX text. */
const flat = (source: string) => source.replace(/\s+/g, ' ');

const sql = read('supabase/migrations/20250101000010_delivery.sql');
const sqlCode = code(sql);
const hub = read('src/components/ui/driver-hub.tsx');
const tracking = read('src/app/(tabs)/tracking.tsx');

// ------------------------------------------------------ the state machine ---

check(
  'Booked does not advance',
  nextStage('Booked') === null,
  'a parcel leaves Booked by being claimed, which is a different action with a different policy',
);

check('Assigned advances to Picked Up', nextStage('Assigned') === 'Picked Up');
check('Picked Up advances to In Transit', nextStage('Picked Up') === 'In Transit');
check('In Transit advances to Out for Delivery', nextStage('In Transit') === 'Out for Delivery');
check('Out for Delivery advances to Delivered', nextStage('Out for Delivery') === 'Delivered');
check('Delivered is the end', nextStage('Delivered') === null);

/*
 * No stage is ever skipped.
 *
 * Walking the chain from Assigned must visit every remaining stage in order.
 * The failure this catches is a well-meant shortcut — "mark delivered" from
 * Picked Up — which would leave the sender's timeline with a hole in it and no
 * record of when the parcel was actually out.
 */
const walked: BookingStage[] = [];
let cursor: BookingStage | null = 'Assigned';
while (cursor) {
  walked.push(cursor);
  cursor = nextStage(cursor);
  if (walked.length > 10) break;
}

check(
  'the chain visits every stage from Assigned onward, in order',
  walked.join(' > ') === BOOKING_STAGES.slice(1).join(' > '),
  `walked: ${walked.join(' > ')}`,
);

check(
  'the client mirror agrees with the SQL',
  BOOKING_STAGES.slice(1, -1).every((stage) => {
    const next = nextStage(stage);
    return next !== null && sqlCode.includes(`'${stage}'`) && sqlCode.includes(`'${next}'`);
  }),
  'next_booking_status and nextStage must not drift — the button would promise a stage the server refuses',
);

check(
  'only the last step is the final one',
  isFinalStep('Out for Delivery') &&
    !isFinalStep('Assigned') &&
    !isFinalStep('Picked Up') &&
    !isFinalStep('In Transit'),
);

check(
  'every advancing stage has a button label',
  BOOKING_STAGES.slice(1, -1).every((stage) => (advanceLabel(stage) ?? '').length > 0),
  'a stage with no label renders a button that says nothing',
);
check('Delivered offers no label', advanceLabel('Delivered') === null);
check('Booked offers no label', advanceLabel('Booked') === null);

// -------------------------------------------------------- only the carrier --

check(
  'the server refuses anyone but the driver carrying the parcel',
  sqlCode.includes('row_driver is distinct from actor'),
  'without this an admin, the sender, or any other driver could move someone else’s parcel',
);
check(
  'and re-checks driver approval at the moment of the update',
  sqlCode.includes('is_approved_driver()'),
  'approval can be revoked or a driver banned while they are holding a job',
);
check(
  'advance_booking is security definer with a pinned search_path',
  /security definer/.test(sqlCode) && /set search_path = ''/.test(sqlCode),
  'a definer function without a pinned search_path is a privilege-escalation hole',
);
check(
  'anon cannot execute it',
  sqlCode.includes('revoke all on function public.advance_booking') &&
    sqlCode.includes(
      'grant execute on function public.advance_booking(uuid, text, text, text) to authenticated',
    ),
);

// ------------------------------------------------------------- forwards only --

check(
  'the update reads its next stage from next_booking_status',
  sqlCode.includes('next_status := public.next_booking_status(row_status)'),
  'a status passed in by the client would let a driver name any stage they liked',
);
check(
  'a finished delivery cannot be advanced again',
  flat(sqlCode).includes('if next_status is null then') &&
    flat(sql).includes('This delivery is already complete'),
);
check(
  'delivered_at is only stamped on the Delivered step',
  flat(sqlCode).includes(
    "delivered_at = case when next_status = 'Delivered' then now() else delivered_at end",
  ),
  'stamping it on any other step would put a delivery time on a parcel still in transit',
);

// ---------------------------------------------------------- a name required --

check(
  'a delivery cannot be recorded without saying who received it',
  flat(sqlCode).includes(
    "if next_status = 'Delivered' and coalesce(trim(received_by_name), '') = ''",
  ),
  'this is the whole point of the feature — a nameless Delivered is the gap it exists to close',
);
check(
  'and the client asks for the name before it calls',
  hub.includes('receivedBy') && flat(hub).includes('Write the name of whoever took the parcel'),
);
check(
  'the name is trimmed before storage',
  flat(sqlCode).includes(
    "received_by = case when next_status = 'Delivered' then trim(received_by_name)",
  ),
);

// ------------------------------------------------------------ proof storage --

check(
  'the proof bucket is created private',
  flat(sqlCode).includes("'delivery-proof', 'delivery-proof', false"),
  'a public bucket hands out a permanent unauthenticated URL for a photo of someone’s front door',
);
check(
  'and stays private on re-run',
  flat(sqlCode).includes('on conflict (id) do update set public = false'),
  'without this, re-running the file after someone flipped the bucket public would leave it public',
);
check(
  'only the carrier can upload',
  sqlCode.includes('"carrier uploads proof"') &&
    flat(sqlCode).includes('b.driver_id = (select auth.uid())'),
);
check(
  'the sender, the driver and an admin can read it — nobody else',
  sqlCode.includes('"parties read proof"') &&
    flat(sqlCode).includes('public.is_admin()') &&
    flat(sqlCode).includes(
      'b.sender_id = (select auth.uid()) or b.driver_id = (select auth.uid())',
    ),
);

/*
 * Evidence that can be overwritten is not evidence.
 *
 * Two halves: no storage update or delete policy on the bucket, and a path that
 * is unique per capture so a second upload cannot land on the first.
 */
check(
  'there is no update or delete policy on the proof bucket',
  !/create policy[^;]*for (update|delete)[^;]*delivery-proof/is.test(sqlCode) &&
    !/delivery-proof[^;]*for (update|delete)/is.test(sqlCode),
  'a driver who can replace a photo after a complaint can rewrite the record',
);

const first = proofPath('booking-1', 'IMG_0042.HEIC');
check('the proof path leads with the booking id', first.startsWith('booking-1/'), first);
check('the extension is lowercased and cleaned', first.endsWith('.heic'), first);
check(
  'a path with no extension still produces one',
  proofPath('booking-1', 'photo').endsWith('.jpg'),
);
check(
  'the client uploads with upsert off',
  code(read('src/store/delivery.ts')).includes('upsert: false'),
);
check(
  'the photo is uploaded before the delivery is recorded',
  code(hub).indexOf('uploadProof') < code(hub).indexOf('advanceBooking({'),
  'the other order writes a proof_path pointing at an object that failed to upload',
);
check(
  'and the stored path is what gets attached to the record',
  flat(code(hub)).includes('path = result.path;') && flat(code(hub)).includes('proofPath: path,'),
  'an upload that succeeds and is then not recorded is the same outcome as one that failed',
);

// ------------------------------------------------ the upload actually runs --

/*
 * `undefined is not a function`.
 *
 * That is what Hermes says for `x.y()` when `y` is undefined, and it is what a
 * driver saw on Mark delivered. The call was `response.blob()`, and
 * `Response.prototype.blob` is only defined by whatwg-fetch when `Blob` and
 * `FileReader` are globals at the moment the polyfill loads — which depends on
 * module evaluation order, not on anything in this repository.
 *
 * These exercise the real `uploadProof` against a stubbed storage client, so
 * the payload and every failure path are checked by running them.
 */
/*
 * Wrapped in a function because the verify scripts bundle to CJS, which has no
 * top-level await. Called below, before the failure summary.
 */
async function uploadChecks() {
  type Captured = { path: string; body: unknown; options: Record<string, unknown> };
  // Held in a box rather than a bare `let`: assigned only inside the stub's
  // closure, TypeScript narrows a plain variable to `never` after it is reset.
  const seen: { last: Captured | null } = { last: null };
  const state: { error: { message: string } | null } = { error: null };

  (supabase as unknown as { storage: unknown }).storage = {
    from: () => ({
      upload: async (path: string, body: unknown, options: Record<string, unknown>) => {
        seen.last = { path, body, options };
        return { data: null, error: state.error };
      },
    }),
  };

  const bytesOf = (text: string): PhotoBytes => ({
    bytes: new TextEncoder().encode(text).buffer as ArrayBuffer,
    contentType: 'image/jpeg',
  });

  const uploaded = await uploadProof('booking-9', 'file:///tmp/IMG_1.jpg', async () =>
    bytesOf('not-really-a-jpeg'),
  );

  check('a good photo uploads', uploaded.ok === true);
  check(
    'the bytes reach storage, not a Blob and not a URI',
    seen.last?.body instanceof ArrayBuffer && (seen.last.body as ArrayBuffer).byteLength > 0,
    'this is the payload the old code could not build at all',
  );
  check(
    'under a path derived from the booking and the file name',
    typeof seen.last?.path === 'string' &&
      seen.last.path.startsWith('booking-9/') &&
      seen.last.path.endsWith('.jpg'),
  );
  check(
    'with the content type and no overwrite',
    seen.last?.options.contentType === 'image/jpeg' && seen.last?.options.upsert === false,
  );
  check(
    'and the caller is handed the same path that was written',
    uploaded.ok && uploaded.path === seen.last?.path,
    'the record must point at the object that exists, not at one computed twice',
  );

  seen.last = null;
  const empty = await uploadProof('booking-9', 'file:///tmp/IMG_2.jpg', async () => ({
    bytes: new ArrayBuffer(0),
    contentType: 'image/jpeg',
  }));
  check(
    'a zero-byte photo is refused before it reaches storage',
    empty.ok === false && seen.last === null,
    'storage accepts an empty object without complaint, which would mark a delivery complete with evidence that is not evidence',
  );

  const unreadable = await uploadProof('booking-9', 'file:///tmp/IMG_3.jpg', async () => {
    throw new Error('Could not read that photo off this device.');
  });
  check(
    'an unreadable photo fails with a sentence a driver can act on',
    unreadable.ok === false && /read that photo off this device/.test(unreadable.error),
    'the old failure said "undefined is not a function" to somebody standing at a door with a parcel',
  );

  state.error = { message: 'new row violates row-level security policy' };
  const refused = await uploadProof('booking-9', 'file:///tmp/IMG_4.jpg', async () =>
    bytesOf('bytes'),
  );
  check(
    "storage's own refusal is passed through rather than flattened",
    refused.ok === false && /row-level security/.test(refused.error),
  );
  state.error = null;

  /*
   * Swept across every uploader, not just this one.
   *
   * `fetch(uri).blob()` was written three times — delivery proof, the sender's
   * verification photo, and driver documents. I fixed the first, did not look for
   * the others, and the sender's photo went on failing on a real phone with
   * "mime type text/plain is not supported" for another two days.
   *
   * Listing the files rather than naming one means the fourth uploader is covered
   * the day it is written.
   */
  const UPLOADERS = [
    'src/store/delivery.ts',
    'src/store/capture-session.ts',
    'src/store/driver-documents.ts',
  ];

  check(
    'no uploader reads a local file with blob()',
    UPLOADERS.every((path) => !code(read(path)).includes('.blob()')),
    'Response.prototype.blob is undefined on some builds, and when it works its type is the header React Native invented',
  );
  check(
    'every uploader goes through the shared reader',
    UPLOADERS.every((path) => code(read(path)).includes('readFileBytes')),
  );
  /*
   * The photo callers refuse a non-image before Storage has to.
   *
   * "mime type text/plain is not supported" reached a real sender twice. It is
   * Storage rejecting the bucket's allowed types — the app had already sent the
   * photo and learned what was wrong from a server that knows nothing about
   * cameras. A local check can name the type it was about to send, which makes
   * the next occurrence readable from the screenshot.
   */
  check(
    'a non-image is refused before it is uploaded',
    (() => {
      try {
        assertImageBytes({ bytes: new ArrayBuffer(4), contentType: 'text/plain' });
        return false;
      } catch (thrown) {
        return thrown instanceof Error && /not an image/.test(thrown.message);
      }
    })(),
  );
  check(
    'and the message names the type that was about to be sent',
    (() => {
      try {
        assertImageBytes({ bytes: new ArrayBuffer(4), contentType: 'text/plain' }, 'selfie');
        return false;
      } catch (thrown) {
        return thrown instanceof Error && thrown.message.includes('text/plain');
      }
    })(),
    'the whole cost of this bug was two round trips to find out what the client had sent',
  );
  check(
    'an image passes through untouched',
    assertImageBytes({ bytes: new ArrayBuffer(4), contentType: 'image/jpeg' }).contentType ===
      'image/jpeg',
  );
  check(
    'the selfie and proof paths both use it',
    code(read('src/store/capture-session.ts')).includes('assertImageBytes(') &&
      code(read('src/store/delivery.ts')).includes('assertImageBytes('),
  );
  check(
    'but documents are not forced to be images',
    !code(read('src/store/driver-documents.ts')).includes('assertImageBytes'),
    'a driver licence is legitimately a PDF',
  );
  check(
    'a storage failure says which build produced it',
    code(read('src/store/capture-session.ts')).includes('${buildLabel()}'),
    'twice a fix was reported as still broken because the phone had an older bundle, and nothing on screen said so',
  );

  check(
    'the shared reader uses the arraybuffer response type',
    code(read('src/lib/upload.ts')).includes("request.responseType = 'arraybuffer'"),
    'React Native decodes this natively and it needs neither Blob nor FileReader',
  );
  /*
   * ⚠ This used to assert the name was consulted *before* the response header.
   *
   *   The header is not consulted at all any more, so the old check compared a
   *   real index against -1 and failed on a change that made it more true. The
   *   rule was never about ordering — it is that the header must not decide the
   *   type — so it is now asserted as an absence.
   */
  check(
    'and takes the content type from the name, never from the response header',
    !code(read('src/lib/upload.ts')).includes("getResponseHeader('content-type')") &&
      code(read('src/lib/upload.ts')).includes('contentTypeHint || contentTypeFor(uri)'),
    'a file:// read reports text/plain, which is exactly what the sender-photo bucket rejected',
  );

  /*
   * ---------- reading the file at all ----------
   *
   * "Could not read that file off this device." reached a driver taking their
   * selfie for the application. That message is this file's own words for
   * `XMLHttpRequest.onerror` — XHR being a network client asked to open a local
   * path, backed on Android by a stack that speaks http and https and nothing
   * else. The photo was on the phone the whole time.
   */
  check(
    'a local file is read through the file system, not the network stack',
    code(read('src/lib/upload.ts')).includes('new FileSystemFile(uri).arrayBuffer()'),
    'XHR cannot open content:// under any circumstances, and file:// only when a handler happens to be registered',
  );
  check(
    'on native only — the web hands back blob: and data:, which XHR is good at',
    /Platform\.OS !== 'web'[\s\S]{0,200}new FileSystemFile/.test(code(read('src/lib/upload.ts'))),
    'the file system module has no view of a blob URL from a browser camera element',
  );
  /*
   * ⚠ Matched on the fallback's own shape, not on "a catch near an XHR call".
   *
   *   My first version was `/catch[\s\S]{0,400}readFileBytesOverXhr/`, and
   *   deleting the fallback left it green — 400 characters later comes the
   *   *web* path, which calls the same function for an unrelated reason. An
   *   assertion satisfied by a line it is not about is not an assertion.
   */
  check(
    'with the old path kept as a fallback',
    code(read('src/lib/upload.ts')).includes(
      'return readFileBytesOverXhr(uri, contentType).catch(',
    ),
    'the person holding the phone should not be the one who discovers a URI shape the new reader refuses',
  );
  check(
    'and a failure names the scheme, the platform and the build',
    /schemeOf\(uri\)\} URI, \$\{Platform\.OS\}, \$\{buildLabel\(\)\}/.test(
      code(read('src/lib/upload.ts')),
    ),
    'the first report of this said only that a file could not be read — nothing about what kind of file, on what, from which bundle',
  );
  /*
   * Positive, not a ban on one spelling.
   *
   * My first version forbade `blob.type.split`, which a rename walks straight
   * past: renaming the variable made the assertion pass while the extension
   * still came from a mime type. Requiring the right source is the only form
   * that holds.
   */
  check(
    'every stored file name takes its extension from the file name',
    UPLOADERS.every((path) => {
      const source = code(read(path));
      if (!source.includes('${Date.now()}.')) return true;
      return /\$\{Date\.now\(\)\}\.\$\{extensionOf\(/.test(source);
    }),
    'deriving it from the mime type turned a JPEG into "1755000000.plain" on the way to a bucket that only takes images',
  );

  check(
    'the content type follows the file name',
    contentTypeFor('a.png') === 'image/png' &&
      contentTypeFor('a.HEIC') === 'image/heic' &&
      contentTypeFor('photo') === 'image/jpeg',
  );
  check(
    'a query string is not mistaken for an extension',
    contentTypeFor('shot.png?width=100') === 'image/png' &&
      proofPath('b', 'shot.png?width=100').endsWith('.png'),
    'a blob: or content:// URI can carry one, and `photo.jpg?w=1` would otherwise be stored as `.jpg?w=1`',
  );

  check('the reader is a function the screen can be given', typeof readPhotoBytes === 'function');
}

// ------------------------------------------------------------ the audit log --

check('every advance is audited', sqlCode.includes('insert into public.app_events'));
check(
  'the audit entry carries ids and a stage, not the recipient’s details',
  flat(sqlCode).includes("jsonb_build_object('booking', booking_id, 'to', next_status)") &&
    !/jsonb_build_object\([^)]*recipient/i.test(flat(sqlCode)),
  'an admin reads this log, and a parcel’s contact details are not theirs by default',
);

// ----------------------------------------------------------------- the bell --

const base: Booking = {
  ...(JSON.parse('{}') as Booking),
  id: 'j1',
  trackingId: 'PKG-1',
  status: 'Assigned',
  acceptedAt: new Date().toISOString(),
} as Booking;

const job = (status: BookingStage, acceptedAt: string | null = new Date().toISOString()): Booking =>
  ({ ...base, status, acceptedAt }) as Booking;

// ----------------------------------------------- the earnings that add up --

const card = read('src/components/ui/driver-summary-card.tsx');
const sheet = read('src/components/ui/earnings-sheet.tsx');

const paid = (id: string, status: BookingStage, fee: number, deliveredAt: string | null) =>
  ({
    ...base,
    id,
    trackingId: id,
    status,
    estimatedFee: fee,
    deliveredAt,
    driverId: 'me',
  }) as Booking;

const ledger = [
  paid('a', 'Delivered', 3500, '2026-08-10T09:00:00.000Z'),
  paid('b', 'Delivered', 2000, '2026-08-14T17:30:00.000Z'),
  paid('c', 'Out for Delivery', 1500, null),
  paid('d', 'Cancelled', 9999, null),
  { ...paid('e', 'Delivered', 4444, null), driverId: 'someone-else' } as Booking,
];

const mine = earningsSummary(ledger, 'me');

check(
  'delivered work is totalled from the driver own completed parcels',
  mine.delivered.count === 2 && mine.delivered.total === 5500,
);
check(
  'work still in hand is counted apart',
  mine.inProgress.count === 1 && mine.inProgress.total === 1500,
);
check(
  'and the headline is the two added together',
  mine.total === 7000 && mine.total === mine.delivered.total + mine.inProgress.total,
  'the card summed every job while the count beside it was delivered-only, so a history of completed parcels alone would total less than the number that was tapped',
);
check(
  'a cancelled parcel is in neither total',
  !JSON.stringify(mine).includes('9999'),
  'counting it would either inflate what a driver is owed or imply a delivery that did not happen',
);
check(
  "another driver's parcel is not in this driver's history",
  !JSON.stringify(mine).includes('4444'),
  'the filter is driverId, which is the same predicate RLS enforces server-side',
);
check(
  'nobody signed in has no earnings rather than everybody else',
  earningsSummary(ledger, null).total === 0,
);

check('the newest delivery is listed first', mine.delivered.entries[0]?.trackingId === 'b');
check(
  'a delivery with no recorded date sorts last, not first',
  earningsSummary(
    [paid('x', 'Delivered', 1, null), paid('y', 'Delivered', 1, '2020-01-01T00:00:00.000Z')],
    'me',
  ).delivered.entries[1]?.trackingId === 'x',
  'an unknown date is not a recent one; treating it as now buries today under a row from before the column existed',
);
check(
  'a missing timestamp says so instead of showing an invalid date',
  deliveredLabel(null) === 'Date not recorded' &&
    deliveredLabel('nonsense') === 'Date not recorded',
);
check(
  'a real timestamp carries the time, not just the day',
  /\d/.test(deliveredLabel('2026-08-14T17:30:00.000Z')) &&
    deliveredLabel('2026-08-14T17:30:00.000Z') !== 'Date not recorded',
  'two parcels delivered the same day are common and the order they landed in is what is being checked',
);

check(
  'the Expected cell is an explicit interactive element',
  code(card).includes('<Pressable') && code(card).includes('onPress={onOpenEarnings}'),
);
check(
  'with a pointer cursor, because web renders Pressable as a plain div',
  code(card).includes("tappable: { cursor: 'pointer' }"),
);
check(
  'the wrapper carries no flex of its own',
  code(card).includes("earningsPress: { alignSelf: 'stretch' }") &&
    !/earningsPress:\s*\{[^}]*flex/.test(code(card)),
  'the admin metric cards sized themselves off the wrong axis when both the wrapper and the cell set flex, and looked tappable while landing nowhere',
);
check(
  'and it is inert rather than broken when no handler is given',
  code(card).includes('disabled={!onOpenEarnings}'),
);
check(
  'the screen opens the sheet from that cell',
  code(hub).includes('onOpenEarnings={() => setEarningsOpen(true)}') &&
    code(hub).includes('<EarningsSheet'),
);

check(
  'the sheet does not nest a scroll container inside the sheet',
  !code(sheet).includes('ScrollView'),
  'BottomSheet already scrolls; nesting two collapses the inner one on web, which is how the admin drawer and the photo sheet both shipped opening empty',
);
check(
  'the sheet shows delivered work, what is still carried, and the total',
  code(sheet).includes('delivered.total') &&
    code(sheet).includes('inProgress.total') &&
    code(sheet).includes('summary.total'),
);
check(
  'each row carries its own payout and when it landed',
  code(sheet).includes('formatNaira(entry.fee)') && code(sheet).includes('deliveredLabel('),
);
/*
 * The claim under test changed when the ledger landed.
 *
 * This used to pin "does not track payouts", which is now false — there is a
 * ledger, in `supabase/migrations/20250101000030_driver_wallet.sql`. The risk moved rather than went
 * away: this sheet totals *gross* fares on parcels including ones still moving,
 * and the wallet is net of commission, delivered-only, less a hold. So the two
 * screens show different numbers for the same work, and the sheet's job is to
 * say which one is the balance — pointing at the wallet, not merely disclaiming
 * itself.
 *
 * Both halves are asserted because either alone is passable and useless: naming
 * the wallet without saying this is gross invites the driver to read them as
 * the same figure; saying "these are quotes" without naming the wallet leaves
 * them with no number they can act on.
 */
check(
  'the sheet says these are gross quotes and names the wallet as the real balance',
  /before Package Relay(&apos;|')s commission/i.test(sheet) && /Driver Wallet/.test(sheet),
  'two screens showing different totals for the same work, with neither claiming to be the balance',
);
check(
  'and offers a way to it rather than only mentioning it',
  /router\.navigate\('\/driver-wallet'\)/.test(sheet),
  'a caveat pointing at a screen the driver has to go and find is a caveat most people will not act on',
);

// ------------------------------------------- which counterparty, and when --

/*
 * A parcel with two distinct ends, so a leg reading from the wrong one is
 * visible rather than coincidentally correct.
 */
const twoEnded = (status: BookingStage): Booking =>
  ({
    ...base,
    status,
    pickupContactName: 'Bola Sender',
    senderPhone: '+2348011112222',
    pickupAddress: '8 Lebanon Street',
    pickupArea: 'Dugbe',
    originCity: 'Ibadan',
    pickupLat: 7.1,
    pickupLng: 3.1,
    recipientName: 'Yetunde Ajoke',
    recipientPhone: '+2348012345678',
    dropoffAddress: 'oje filling station',
    dropoffArea: 'Akobo',
    destinationCity: 'Ibadan',
    dropoffLat: 7.9,
    dropoffLng: 3.9,
  }) as Booking;

check(
  'a parcel not yet collected points at the sender',
  ['Booked', 'Assigned'].every((stage) => {
    const leg = activeLeg(twoEnded(stage as BookingStage));
    return (
      leg.role === 'sender' &&
      leg.callLabel === 'Call sender' &&
      leg.phone === '+2348011112222' &&
      leg.name === 'Bola Sender'
    );
  }),
  'the screen showed the recipient for both halves, so an Assigned job offered to ring somebody across the city about a parcel still with the sender',
);

check(
  'and every stage from collection onwards points at the recipient',
  ['Picked Up', 'In Transit', 'Out for Delivery', 'Delivered'].every((stage) => {
    const leg = activeLeg(twoEnded(stage as BookingStage));
    return (
      leg.role === 'recipient' &&
      leg.callLabel === 'Call recipient' &&
      leg.phone === '+2348012345678'
    );
  }),
);

check(
  'the boundary is collection itself',
  awaitingPickup('Assigned') && !awaitingPickup('Picked Up'),
  'Confirm pickup is the moment the counterparty changes',
);

check(
  'a cancelled parcel is treated as never collected',
  activeLeg(twoEnded('Cancelled')).role === 'sender',
  'Cancelled sits outside BOOKING_STAGES and indexes to -1; the safe reading of an unknown stage is that nothing was picked up',
);

check(
  'navigation follows the same leg as the call button',
  (() => {
    const before = activeLeg(twoEnded('Assigned'));
    const after = activeLeg(twoEnded('In Transit'));
    return (
      before.lat === 7.1 &&
      before.navigationAddress.includes('Dugbe') &&
      after.lat === 7.9 &&
      after.navigationAddress.includes('Akobo')
    );
  })(),
  'routing to the drop-off before collection sends a driver across the city to an address holding nothing',
);
/*
 * Scoped to the two handlers, not the whole file.
 *
 * My first version of this checked `job.dropoffLat` appeared nowhere in the
 * screen, and failed on `markersFor` — which plots both ends deliberately,
 * because the map is of the whole trip rather than of the current leg. An
 * assertion that fires on correct code trains you to edit the test.
 */
const handlers = (() => {
  const source = code(hub);
  const from = source.indexOf('const openNavigation');
  // To the end of the second handler, not to a named landmark: `match` reads
  // like it comes after these and is declared above them, so slicing to it
  // produced an empty range that passed for the wrong reason.
  const to = source.indexOf('void Linking.openURL(url);', from);
  return from >= 0 && to > from ? source.slice(from, to) : '';
})();

check(
  'and the screen has no second opinion about where to go or who to ring',
  !handlers.includes('job.dropoffLat') &&
    !handlers.includes('job.recipientPhone') &&
    handlers.includes('activeLeg(job)'),
  'the button, the contact line and the map disagreed because each was written separately',
);

check(
  'the leg can be read for a stage the job does not hold yet',
  activeLeg(twoEnded('Assigned'), 'Picked Up').role === 'recipient',
  'advanceBooking returns the new stage before the refetch lands, and the toast names the new contact from it',
);
check(
  'and the screen uses that to announce the handover',
  code(hub).includes('activeLeg(job, to)') && code(hub).includes('Calls now reach the'),
  'a button that silently starts ringing somebody else is found out by ringing the wrong person',
);

check(
  'the pickup contact is the person holding the parcel, not the account holder',
  activeLeg(twoEnded('Assigned')).name === 'Bola Sender',
  'the form asks who physically hands it over, which is often a shop assistant rather than whoever paid',
);

check(
  'no phone number is rendered as text on the driver screen',
  !code(hub).includes('leg.phone') || !/>\s*\{leg\.phone\}/.test(hub),
  'the number is only ever handed to the dialler; a driver cannot read it off the card and keep it',
);

check('no jobs means no alerts', driverAlerts([]).length === 0);
check(
  'an accepted-but-uncollected parcel raises one',
  driverAlerts([job('Assigned')]).some((a) => a.key === 'awaiting-pickup'),
);
check(
  'a delivered parcel raises none',
  driverAlerts([job('Delivered')]).length === 0,
  'the badge is a worklist, so finished work must leave it',
);

const dayAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
check(
  'a parcel accepted more than a day ago is flagged overdue',
  driverAlerts([job('Assigned', dayAgo)]).some((a) => a.key === 'stale'),
);
check(
  'one accepted an hour ago is not',
  !driverAlerts([job('Assigned', new Date(Date.now() - 3600_000).toISOString())]).some(
    (a) => a.key === 'stale',
  ),
);
check(
  'a job with no acceptedAt never counts as overdue',
  !driverAlerts([job('Assigned', null)]).some((a) => a.key === 'stale'),
  'a null timestamp parses to NaN, which must not read as "long ago"',
);
check(
  'the badge shows a count rather than a bare dot',
  flat(hub).includes('{alerts.length}</Text>'),
  'state carried by colour alone fails WCAG 1.4.1',
);

// ------------------------------------------------------------ handing off ---

check(
  'a pinned drop-off navigates by coordinates',
  navigationUrl({ lat: 6.5244, lng: 3.3792, address: 'Ignore me' }).includes(
    'destination=6.5244%2C3.3792',
  ),
);
check(
  'an unpinned one falls back to the address',
  navigationUrl({ lat: null, lng: null, address: '14 Awolowo Road, Ikoyi' }).includes(
    'destination=14%20Awolowo%20Road%2C%20Ikoyi',
  ),
);
check(
  'a NaN coordinate does not produce destination=NaN',
  !navigationUrl({ lat: Number.NaN, lng: 3.3, address: 'Ikeja' }).includes('NaN'),
);
check(
  'the link asks for driving directions',
  navigationUrl({ lat: 1, lng: 1, address: '' }).includes('travelmode=driving'),
);

check('a local 0803 number becomes +234', normalizePhone('0803 123 4567') === '+2348031234567');
check(
  'a 234-prefixed number gains the plus',
  normalizePhone('234 803 123 4567') === '+2348031234567',
);
check(
  'an already-international number survives',
  normalizePhone('+234 803 123 4567') === '+2348031234567',
);
check('punctuation is stripped', normalizePhone('+234-803-123-4567') === '+2348031234567');
check('an empty number is unusable', normalizePhone('   ') === null);
check('a too-short number is unusable', normalizePhone('12345') === null);
check('dialUrl hides the button rather than offering a dead one', dialUrl('') === null);
check('dialUrl produces a tel: link', dialUrl('08031234567') === 'tel:+2348031234567');

// ------------------------------------------------------ what the UI claims --

check(
  'the hub is the native driver home and the portal stays on web',
  read('src/app/(tabs)/driver.tsx').includes("if (experience === 'driver') return <DriverHub />"),
);
check(
  'the advance button is disabled, not hidden, for an unapproved driver',
  flat(hub).includes('disabled={busy || !canAct}') &&
    flat(hub).includes('Available once your driver application is approved.'),
  'a missing button reads as a broken app; a disabled one with a reason reads as a rule',
);
check(
  'the sender’s map still disclaims live tracking',
  flat(tracking).includes(
    'This is not the driver&apos;s live position — nothing in the app reports that.',
  ),
  'a map with two pins on it reads as live tracking unless it says otherwise',
);
/*
 * This assertion changed direction when the booking form's map pickers were
 * removed. There used to be a note explaining why a parcel had no pins; now
 * *every* new parcel has none, so the note would be permanent furniture. The
 * map itself is conditional instead, and the rule to protect is that an empty
 * one never renders.
 */
check(
  'the map only renders when the parcel actually carries pins',
  flat(hub).includes('{pins.length > 0 && ('),
  'an empty map reads as "we do not know where this is"',
);
check(
  'and the address is always present as the real information',
  flat(hub).includes('{leg.name} · {leg.address}'),
  'with no pins, the written address is all a driver has — and it has to be the address for the leg they are on',
);
check(
  'the bell explains that it has no read state',
  flat(hub).includes('it empties when the work is done rather than when you have read it'),
  'a count that never clears looks broken unless the reason is stated',
);
check(
  'a photo that cannot be stored is disclosed before the driver relies on it',
  flat(hub).includes('Storage is not configured in this build, so the photo will not be saved'),
);

// -------------------------------------------------- the sender’s side of it --

check(
  'the tracking timeline stamps Picked Up and Delivered from real columns',
  flat(tracking).includes("if (stage === 'Picked Up') return booking.pickedUpAt;") &&
    flat(tracking).includes("if (stage === 'Delivered') return booking.deliveredAt;"),
);
/*
 * In Transit and Out for Delivery have no timestamp column, and must not
 * acquire a plausible-looking one. The failure this catches is a helpful
 * `?? booking.createdAt` fallback, which would put an invented time in front of
 * someone trying to work out when their parcel actually moved.
 */
const trackingCode = code(tracking);
const stampFn = flat(
  trackingCode.slice(
    trackingCode.indexOf('function stageTimestamp'),
    trackingCode.indexOf('function StageRow'),
  ),
);

check(
  'stageTimestamp invents nothing for the two stages with no column',
  stampFn.length > 0 &&
    !stampFn.includes("'In Transit'") &&
    !stampFn.includes("'Out for Delivery'") &&
    (stampFn.match(/createdAt/g) ?? []).length === 1,
  'createdAt should appear once, for Booked — a second use is a fabricated timestamp',
);

void uploadChecks().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }

  console.log(
    'PASS — stages advance one at a time and never backwards, only the carrier can move a\n' +
      '       parcel, a proof photo is read as bytes and refused when empty, photos land in\n' +
      '       a private bucket with no update or delete path, the call button follows the leg\n' +
      '       of the trip, and the hub discloses every limit it has rather than implying none.',
  );
});
