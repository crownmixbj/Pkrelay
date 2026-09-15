/**
 * Assertions for the ten changes in this batch.
 *
 * The two that carry real risk are the cancellation windows and the sender
 * photo. A cancellation window enforced only in the UI is not a rule — it is a
 * button someone can reach with a network client. And a selfie described as
 * "verification" is a claim Package Relay cannot back, to senders and to anyone relying
 * on it afterwards. Most of what follows guards those two.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  cancellationAllowed,
  cancelActionLabel,
  cancelClosedReason,
  type CancelRole,
} from '../src/store/cancellation';
import {
  BOOKING_STAGES,
  CHEAPEST_HANDOVER,
  estimateFee,
  handoverFeeLabel,
  isChargeableHandover,
  PRICING,
  stageIndex,
  type Booking,
  type BookingStage,
} from '../src/store/bookings';

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

const cancelSql = read('supabase/migrations/20250101000011_cancellation.sql');
const cancelSqlCode = code(cancelSql);
const photoSql = read('supabase/migrations/20250101000012_sender_photo.sql');
const photoSqlCode = code(photoSql);
const book = read('src/app/(tabs)/book.tsx');
const bookCode = code(book);

/*
 * The body, with the import block removed.
 *
 * Ordering assertions below compare `indexOf` positions, and an import names
 * every symbol it brings in at the top of the file — so `indexOf('uploadSenderPhoto')`
 * finds line 50, not the call site four hundred lines down, and reports the
 * order as wrong when it is right. This is the same trap the layout suite hit
 * with `useRef<ScrollView>`.
 */
const bookBody = bookCode.slice(bookCode.indexOf('export default function'));
const photoSheet = read('src/components/ui/sender-photo-sheet.tsx');

// ------------------------------------------------------ cancellation rules --

const ALL: BookingStage[] = [...BOOKING_STAGES, 'Cancelled'];

for (const stage of ALL) {
  check(
    `a sender may cancel at ${stage} only if it is Booked`,
    cancellationAllowed(stage, 'sender') === (stage === 'Booked'),
    'the window closes the moment a driver commits',
  );
  check(
    `a driver may release at ${stage} only if it is Assigned`,
    cancellationAllowed(stage, 'driver') === (stage === 'Assigned'),
    'after pickup the driver is holding someone else’s property',
  );
}

/*
 * The client copy and the SQL must agree, or the button lies.
 *
 * Checked by reading the two windows out of the SQL rather than trusting the
 * comment above them.
 */
check(
  'the SQL gives the sender exactly the Booked window',
  flat(cancelSqlCode).includes("when 'sender' then booking_status = 'Booked'"),
);
check(
  'the SQL gives the driver exactly the Assigned window',
  flat(cancelSqlCode).includes("when 'driver' then booking_status = 'Assigned'"),
);
check(
  'and anything else is refused',
  flat(cancelSqlCode).includes('else false'),
  'an unknown role must not fall through to permitted',
);

check(
  'the actor’s role is read from the row, never taken as an argument',
  !/cancel_booking\(\s*booking_id uuid,\s*actor_role/.test(flat(cancelSqlCode)) &&
    flat(cancelSqlCode).includes('if row_sender = actor then'),
  'a role passed in lets a sender claim to be the driver and cancel in the wrong window',
);

check(
  'cancel_booking is security definer with a pinned search_path',
  /security definer/.test(cancelSqlCode) && /set search_path = ''/.test(cancelSqlCode),
);
check(
  'anon cannot execute it',
  cancelSqlCode.includes('revoke all on function public.cancel_booking') &&
    cancelSqlCode.includes(
      'grant execute on function public.cancel_booking(uuid, text) to authenticated',
    ),
);

/*
 * A driver releasing does not cancel the shipment.
 *
 * This is the distinction most likely to be lost in a later edit: the parcel
 * goes back to the board and the sender keeps it. If this ever starts writing
 * status 'Cancelled' for a driver, senders lose parcels because a driver had a
 * flat tyre.
 */
check(
  'a driver release returns the parcel to the open board',
  flat(cancelSqlCode).includes(
    "set status = 'Booked', driver = null, driver_id = null, accepted_at = null",
  ),
  'the shipment survives — only the assignment ends',
);
check(
  'and only a sender cancellation writes the Cancelled status',
  flat(cancelSqlCode).includes("set status = 'Cancelled'") &&
    flat(cancelSqlCode).includes("cancelled_role = 'sender'"),
);
check(
  'the two actions read differently in the UI',
  cancelActionLabel('sender') !== cancelActionLabel('driver') &&
    /release/i.test(cancelActionLabel('driver')),
  'telling a driver they "cancelled" a parcel says they destroyed a sender’s shipment',
);

check(
  'a cancelled row must carry when, who and how',
  flat(cancelSqlCode).includes('constraint cancellation_consistent') &&
    flat(cancelSqlCode).includes("status = 'Cancelled' and cancelled_at is not null"),
  'otherwise a status flip leaves a cancellation that cannot say anything about itself',
);

check(
  'Cancelled is not in the ordered pipeline',
  !(BOOKING_STAGES as readonly string[]).includes('Cancelled') && stageIndex('Cancelled') === -1,
  'in the pipeline it becomes reachable by pressing "advance" once more',
);

/*
 * Someone who expected the button gets a sentence, not silence — but only where
 * it would actually surprise them.
 */
for (const role of ['sender', 'driver'] as CancelRole[]) {
  const open = role === 'sender' ? 'Booked' : 'Assigned';
  check(
    `no explanation while ${role} cancellation is still open`,
    cancelClosedReason({ status: open } as Booking, role) === null,
  );
  check(
    `${role} gets a reason once the window has closed`,
    (cancelClosedReason({ status: 'In Transit' } as Booking, role) ?? '').length > 20,
    'a missing button with no explanation reads as a broken app',
  );
}

// -------------------------------------------------------------- the pricing --

check('the surcharge is still ₦800', PRICING.handoverSurcharge === 800);

check(
  'a hub pickup is now chargeable',
  isChargeableHandover('hub', 'pickup'),
  'this is the change — it discourages senders queueing at a hub Package Relay has to staff',
);
check(
  'a public-location pickup is now free',
  !isChargeableHandover('doorstep', 'pickup') && !isChargeableHandover('meetpoint', 'pickup'),
);
check(
  'a doorstep delivery is still chargeable',
  isChargeableHandover('doorstep', 'dropoff'),
  'that leg was never the one being changed',
);
check(
  'a hub delivery is still free',
  !isChargeableHandover('hub', 'dropoff'),
  'charging the recipient’s end for collecting at a hub was not asked for',
);

const money = (pickup: Booking['pickupMode'], dropoff: Booking['dropoffMode']) =>
  estimateFee({
    deliveryType: 'local',
    weight: 2,
    declaredValue: 0,
    pickupMode: pickup,
    dropoffMode: dropoff,
  }).handover;

check('public pickup, hub delivery costs nothing extra', money('doorstep', 'hub') === 0);
check('hub pickup, hub delivery costs one surcharge', money('hub', 'hub') === 800);
check('hub pickup, doorstep delivery costs two', money('hub', 'doorstep') === 1600);
check('public pickup, doorstep delivery costs one', money('doorstep', 'doorstep') === 800);

/*
 * The headline "from ₦X" quotes must not have quietly gone up.
 *
 * They defaulted to `hub` at both ends, which was free before this change and
 * is now ₦800 at the pickup end. Left alone, every "from" price in the app
 * would have risen by 800 with nobody editing a price.
 */
check(
  'the default quote still uses the cheapest legs',
  CHEAPEST_HANDOVER.pickup === 'meetpoint' && CHEAPEST_HANDOVER.dropoff === 'hub',
);
check(
  'so a headline quote carries no surcharge',
  estimateFee({ deliveryType: 'local', weight: 2, declaredValue: 0 }).handover === 0,
  'a "from" price with a surcharge baked in is not a from price',
);

check(
  'the fee line names the leg that was charged',
  handoverFeeLabel('hub', 'hub') === 'Handover · hub pickup' &&
    handoverFeeLabel('doorstep', 'doorstep') === 'Handover · doorstep delivery' &&
    handoverFeeLabel('hub', 'doorstep') === 'Handover · hub pickup and doorstep delivery',
  '"Doorstep · pickup" is now simply wrong — the chargeable pickup is a hub',
);

check(
  'the free pickup option is offered first',
  bookCode.indexOf("label: 'Public location pickup'") < bookCode.indexOf("label: 'Package Relay hub'"),
  'the first card is the one people take when they are not reading closely',
);
check('the hub card no longer claims to be free', !flat(bookCode).includes('Zero drop-off fees'));

// -------------------------------------------------------------- the renames --

check(
  'the mobile tab says New Shipment',
  read('src/components/ui/bottom-tab-bar.tsx').includes("label: 'New Shipment'"),
);
check(
  'the web nav says New Shipment',
  read('src/components/ui/app-nav-bar.tsx').includes("label: 'New Shipment'"),
);
check(
  'neither says New Booking or Send a New Parcel any more',
  !read('src/components/ui/bottom-tab-bar.tsx').includes('New Booking') &&
    !read('src/components/ui/app-nav-bar.tsx').includes('Send a New Parcel'),
);
check(
  'the four-sections subtitle is gone',
  !book.includes("You'll see the fee before you confirm"),
  'it described the form rather than saying anything actionable, and cost two lines of a pinned block',
);

// ------------------------------------------------------------- the map pins --

check(
  'the booking form has no map pickers',
  !bookCode.includes('LocationPicker') &&
    !book.includes('Pickup point on the map') &&
    !book.includes('Drop-off point on the map'),
);
check(
  'and posts no coordinates',
  flat(bookCode).includes('pickupLat: null, pickupLng: null, dropoffLat: null, dropoffLng: null,'),
);
check(
  'the columns survive for parcels that already have pins',
  read('src/store/bookings.tsx').includes('pickupLat: number | null;'),
  'dropping them would erase real data from before the change',
);

// ------------------------------------------------------ the sender’s photo --

const captureSql = read('supabase/migrations/20250101000013_capture_sessions.sql');
const captureSqlCode = code(captureSql);
const captureScreen = read('src/app/capture/[id].tsx');
const captureStore = read('src/store/capture-session.ts');
const privacyNotes = read('docs/PRIVACY-NOTES.md');

/*
 * The claim, and the limits of it.
 *
 * ⚠ Inverted, because the thing this used to assert became false — and the
 *   assertion went on passing on the comment that recorded it becoming false.
 *
 *   These three demanded that both surfaces say "It is a photo record, not an
 *   identity check" and "does not match your face against any document or
 *   database". `sender-photo-sheet` withdrew both sentences when the sender's
 *   photo started being compared against their NIN record, calling the denial
 *   "the most misleading kind of privacy copy". The assertion kept passing:
 *   `flat()` collapses whitespace and leaves comments, and the comment
 *   explaining the withdrawal quotes the withdrawn sentence verbatim.
 *
 *   So the test that this file calls the one that matters most was, for
 *   months, proving the opposite of what the code had decided — satisfied by
 *   its own obituary. Everything below runs on `code()`, which strips comments,
 *   so a sentence can only satisfy an assertion by being on screen.
 *
 * The property worth defending has not changed: no surface may overstate what
 * was done. It has simply moved — the overstatement is now the *denial*.
 */
for (const [label, source] of [
  ['the sheet', photoSheet],
  ['the capture screen', captureScreen],
] as const) {
  check(
    `${label} does not deny an identity check that now happens`,
    !flat(code(source)).includes('not an identity check'),
    'both photos are compared against the photo on the person’s NIN record; denying it is the most misleading copy available',
  );
  check(
    `${label} does not claim nothing is matched`,
    !flat(code(source)).includes('does not match your face against any document or database'),
  );
  check(
    `${label} says what the photo is compared with`,
    /NIN record/.test(code(source)),
    'somebody handing over their face is owed the sentence saying what it is measured against',
  );
}
check(
  'no UI surface claims verification',
  [photoSheet, captureScreen].every((source) => !/verif(y|ied|ication)/i.test(code(source))),
  'a sender told they were "verified" would reasonably believe Package Relay checked who they are',
);
check(
  'the camera opens front-facing on both paths',
  photoSheet.includes('ImagePicker.CameraType.front') &&
    captureScreen.includes('ImagePicker.CameraType.front'),
);

/*
 * Mandatory means mandatory — no decline anywhere.
 */
check(
  'the sheet has no decline path',
  !/Post without a photo|skip|Skip/.test(code(photoSheet)),
  'the photo is required; a skip button would be the one route around it',
);
check(
  'and cannot hand back "no photo"',
  !/onDone\(null\)/.test(code(photoSheet)),
  'a null result would post a parcel with nothing attached',
);
check(
  'the booking form requires a session id, not an optional uri',
  flat(bookBody).includes('const postParcel = async (photoSessionId: string) => {'),
  'an optional parameter is a mandatory rule with a hole in it',
);
check(
  'backing out returns to the form rather than posting',
  flat(photoSheet).includes('label="Back to the form"'),
);

/*
 * The QR handoff.
 *
 * The id in the code is the only secret, so everything here is about that id
 * not being enough on its own.
 */
check(
  'a capture session is bound to one account',
  flat(captureSqlCode).includes('if row_owner <> actor then'),
  'without it, a QR photographed over someone’s shoulder could be completed by a stranger',
);
check(
  'and expires',
  flat(captureSqlCode).includes(
    "expires_at timestamptz not null default (now() + interval '10 minutes')",
  ) && flat(captureSqlCode).includes('if row_expires <= now() then'),
);
check(
  'and cannot be completed twice',
  flat(captureSqlCode).includes('if row_completed is not null then'),
);
check(
  'and can be spent on only one parcel',
  flat(captureSqlCode).includes('and consumed_at is null') &&
    flat(captureSqlCode).includes('returning photo_path into claimed_path'),
  'read-and-mark in one statement is what makes this safe under two simultaneous postings',
);
check(
  'opening a session closes the account’s other open ones',
  flat(captureSqlCode).includes('set expires_at = now() where owner_id = actor'),
  'a reloaded booking page should not leave live codes behind it',
);

check(
  'the storage path is derived server-side, never taken from the client',
  flat(captureSqlCode).includes("set photo_path = session_id::text || '/' || safe_name"),
  'a client-supplied path could point a session at another session’s object',
);
check(
  'and the file name is sanitised',
  flat(captureSqlCode).includes(
    "regexp_replace(coalesce(file_name, ''), '[^A-Za-z0-9._-]', '', 'g')",
  ) && flat(captureSqlCode).includes("safe_name like '%..%'"),
  'traversal out of the session folder is the whole risk of accepting a name at all',
);
check(
  'the client sends only a file name',
  flat(captureStore).includes('file_name: fileName') &&
    !/rpc\([^)]*photo_path/s.test(flat(captureStore)),
  'reading photo_path back is fine; sending one would let a session point anywhere',
);

check(
  'sessions are readable only by their owner',
  captureSqlCode.includes('"owner reads own sessions"') &&
    flat(captureSqlCode).includes('using (owner_id = (select auth.uid()))'),
  'this is what makes the id safe to display on a screen',
);
check(
  'there is no client update or delete policy on sessions',
  !/create policy[^;]*for (update|delete)[^;]*photo_capture_sessions/is.test(captureSqlCode),
  'completing a session goes through the function, or photo_path is client-controlled',
);
check(
  'all three functions are definer with a pinned search_path and no anon grant',
  ['start_capture_session', 'complete_capture_session', 'consume_capture_session'].every(
    (fn) =>
      captureSqlCode.includes(`revoke all on function public.${fn}`) &&
      captureSqlCode.includes(`grant execute on function public.${fn}`),
  ) && (captureSqlCode.match(/security definer/g) ?? []).length >= 3,
);

/*
 * The web page has to notice the phone finishing, or the sender waits forever.
 */
check(
  'the browser watches the session over Realtime',
  flat(captureStore).includes("event: 'UPDATE'") &&
    flat(captureStore).includes('photo_capture_sessions'),
);
check(
  'and polls underneath it',
  flat(captureStore).includes('setInterval('),
  'a websocket blocked by a proxy fails silently, and the sender sits in front of a code they already scanned',
);
check(
  'both are torn down together',
  flat(captureStore).includes('clearInterval(timer)') &&
    flat(captureStore).includes('removeChannel(channel)'),
);

/*
 * The link type, and the promise made about it.
 *
 * A QR containing a private scheme is not the standard cross-device pattern —
 * a phone's stock camera ignores it, and with no app installed it fails with no
 * message at all. https universal links are what make "point your phone camera
 * at this" a true sentence. The domain is configuration, so what matters here
 * is that the code and the copy agree about which mechanism is in play.
 */
const links = read('src/constants/links.ts');
const appJson = JSON.parse(read('app.json')).expo;

check(
  'the link prefers https when a domain is configured',
  flat(links).includes('universalLinksEnabled ? `https://${LINK_DOMAIN}/capture/${sessionId}`'),
);
check(
  'and falls back to the app scheme when it is not',
  flat(links).includes('`${APP_SCHEME}://capture/${sessionId}`') &&
    links.includes("APP_SCHEME = 'parcelmobile'") &&
    appJson.scheme === 'parcelmobile',
  'a QR pointing at a scheme the app does not register opens nothing',
);
check(
  'the domain is stripped of a protocol and trailing slashes',
  flat(links).includes("replace(/^https?:\\/\\//i, '')") &&
    flat(links).includes("replace(/\\/+$/, '')"),
  'it is interpolated into both a URL and an applinks: entry, which want different shapes',
);

/*
 * The instruction cannot outlive the mechanism.
 *
 * The copy shipped before this said "point your phone camera at the code" while
 * the QR held a private scheme, which was simply untrue. It now comes from the
 * same module that decides the link type.
 */
check(
  'the instruction is derived from the link type, not written in the component',
  flat(links).includes('export function captureInstruction()') &&
    photoSheet.includes('captureInstruction()') &&
    !flat(photoSheet).includes('Point your phone camera at the code'),
  'text written beside the QR goes on claiming things after they stop being true',
);
check(
  'the scheme wording does not promise the stock camera',
  flat(links).includes('ordinary camera app will not open it'),
);
check(
  'and the https wording does',
  flat(links).includes('Point your phone camera at the code and tap the link'),
);

/*
 * The association files. Placeholders are fine; a wrong shape is not, because
 * neither platform reports why verification failed.
 */
const aasa = JSON.parse(read('public/.well-known/apple-app-site-association'));
const assetLinks = JSON.parse(read('public/.well-known/assetlinks.json'));

check(
  'the Apple association file scopes itself to the capture path',
  aasa.applinks.details[0].components[0]['/'] === '/capture/*',
  'claiming the whole domain would route every Package Relay web page into the app',
);
check(
  'and names the real bundle identifier',
  String(aasa.applinks.details[0].appIDs[0]).endsWith(`.${appJson.ios.bundleIdentifier}`),
);
check(
  'the Android association file names the real package',
  assetLinks[0].target.package_name === appJson.android.package,
);
check(
  'both still carry their placeholders, and the docs say what replaces them',
  read('public/.well-known/apple-app-site-association').includes('REPLACE_WITH_APPLE_TEAM_ID') &&
    read('public/.well-known/assetlinks.json').includes('REPLACE_WITH_SHA256_FINGERPRINT') &&
    read('docs/DEEP-LINKS.md').includes('App signing key'),
  'the upload key and the app signing key differ, and using the wrong one is the usual failure',
);

check(
  'the native config declares the domain on both platforms',
  Array.isArray(appJson.ios.associatedDomains) &&
    appJson.ios.associatedDomains[0].startsWith('applinks:') &&
    appJson.android.intentFilters[0].data[0].pathPrefix === '/capture' &&
    appJson.android.intentFilters[0].autoVerify === true,
  'these are baked into the native build and cannot come from a runtime env var',
);

check(
  'there is a web page for a scan with no app installed',
  captureScreen.includes("if (Platform.OS === 'web')") &&
    flat(captureScreen).includes('Open this in the Package Relay app'),
  'the silent failure is exactly what the https link exists to avoid',
);
check(
  'and it points back at the computer rather than dead-ending',
  flat(captureScreen).includes('go back to the computer where you started'),
);
check(
  'and there is a screen at the route it opens',
  captureScreen.includes('export default function CaptureScreen'),
);
/*
 * ⚠ "Go back to the browser to finish", without naming what is being finished.
 *
 *   This pinned "…to finish posting", which was written when the handoff only
 *   ever served a parcel. The driver application uses the same screen, and the
 *   session row carries no purpose — so the phone cannot know, and a wrong noun
 *   beside a browser tab headed "to finish your application" is worse than
 *   none. The instruction is what this assertion is for, and it survives.
 */
check(
  'the capture screen tells the sender to go back to the browser',
  flat(code(captureScreen)).includes('Go back to the browser to finish'),
  'otherwise people wait on the phone for something that already happened elsewhere',
);
check(
  'and names neither a parcel nor an application, because it cannot know which',
  !/\b(parcel|application)\b/i.test(
    code(captureScreen).replace(/parcelmobile/g, ''),
  ),
  'the driver application uses this same handoff; the session row says nothing about which flow opened it',
);

/*
 * The fallback. Without it, mandatory + QR means a web sender with no app
 * simply cannot post a parcel.
 */
/*
 * The fallback is present but subordinate.
 *
 * The phone is the intended route — better camera, and face images stay off
 * shared desktops. But a first-time sender on a laptop has no reason to have
 * installed anything, and with the photo required, no fallback means no parcel.
 * So it stays, as a link rather than a button.
 */
check(
  'the web offers a browser camera as well as the QR',
  flat(photoSheet).includes('Use this computer&apos;s camera instead'),
);
check(
  'and it is quieter than the QR route',
  flat(photoSheet).includes('style={styles.fallbackText}') ||
    flat(photoSheet).includes('styles.fallbackText'),
  'an equal-weight button beside the QR invites the worse path',
);
check(
  'the webcam stream is stopped when the sheet closes',
  flat(read('src/components/ui/webcam-capture.tsx')).includes('useEffect(() => stop, [])'),
  'a camera left running keeps the browser recording indicator lit on a page that stopped asking',
);
check(
  'the stored webcam photo is un-mirrored',
  flat(read('src/components/ui/webcam-capture.tsx')).includes('context.scale(-1, 1)'),
  'a mirrored face is subtly wrong to anyone comparing it to a person later',
);

/*
 * The QR is generated locally.
 */
check(
  'the QR code is rendered from a local encoder',
  read('src/components/ui/qr-code.tsx').includes("from 'qrcode-generator'") &&
    !/api\.qrserver|chart\.googleapis|quickchart/i.test(read('src/components/ui/qr-code.tsx')),
  'a remote QR service would post a live capture-session id to a third party',
);

/*
 * Ordering. The photo is asked for last and attached after the parcel exists.
 *
 * ⚠ This used to read `validate(...) < setPhotoOpen(true)`, because the sheet
 *   opened inside the submit handler. The capture is now an item on page three
 *   instead, so the same principle — never ask for a face before the sender
 *   knows what they are getting — is asserted against where the card sits on
 *   the page rather than where a function is called.
 */
check(
  'the photo is asked for after the fare is on screen',
  bookBody.indexOf('Estimated total') < bookBody.indexOf('<LiveSelfieCard'),
  'asking for a face before the fare is known is asking for a face in exchange for nothing',
);
check(
  'and only on the last step',
  bookBody.indexOf('{step === 2 &&') < bookBody.indexOf('<LiveSelfieCard'),
  'pages one and two are still unvalidated at that point',
);
check(
  'the parcel cannot be posted without one',
  /disabled=\{!confirmed \|\| !photoSession \|\| posting\}/.test(bookBody),
  'the sheet used to be the only path to the post, so backing out was the only refusal',
);
/*
 * ⚠ Both of these pinned an ordering that no longer exists, and the second
 *   pinned a behaviour that is now the bug.
 *
 *   The selfie used to be linked by `consumeCaptureSession` *after* the insert,
 *   because there was no booking row to attach it to until then — so spending
 *   the session second was correct, and swallowing its failure was correct too:
 *   the parcel was already posted, and sending somebody back to a completed
 *   form would have lost it to save a link.
 *
 *   That produced parcels with no record of who posted them and nothing saying
 *   so — a dropped connection, an unrun migration or a closed tab between two
 *   statements was enough. `20250101000044_selfie_with_the_parcel.sql` moves the attach
 *   inside the insert, so a failure now means no parcel rather than a parcel
 *   with no evidence. Swallowing it would be hiding the wrong thing.
 */
check(
  'the session is sent with the booking rather than spent after it',
  /captureSessionId: photoSessionId/.test(bookBody) && !/consumeCaptureSession\(/.test(bookCode),
  'a link made by a second call is a link that can silently not be made',
);
check(
  'and a failed post is reported rather than swallowed',
  /if \(!booking\) \{ showDialog\( 'Could not post the parcel'/.test(flat(bookCode)),
  'the parcel no longer exists when this fails, so there is nothing left to protect by hiding it',
);
/*
 * ⚠ And it says what the server said.
 *
 *   "Check your connection" was the only failure worth naming while the insert
 *   asked four questions about the row itself. Since 42 and 44 a post can also
 *   be refused for being unverified, or for a selfie already spent, never
 *   finished, or failed — and sending somebody with a working connection to
 *   restart their router over a photograph is a support ticket by design.
 */
check(
  'naming the reason the server gave',
  /bookingError\s*\?/.test(bookCode),
  'a single generic sentence for five different refusals explains none of them',
);

/*
 * The legal position is stated, and stated as unresolved.
 */
check(
  'the photo bucket is private',
  flat(photoSqlCode).includes("'sender-photo', 'sender-photo', false"),
);
check(
  'the sender and an admin can read it, and the driver cannot',
  photoSqlCode.includes('"sender and admin read photo"') &&
    flat(photoSqlCode).includes('public.is_admin()') &&
    !/sender-photo[\s\S]*?driver_id/.test(photoSqlCode),
  'a face plus a pickup address handed to every driver browsing the board is a safety problem',
);
check(
  'there is no update or delete policy on it',
  !/create policy[^;]*for (update|delete)[^;]*sender-photo/is.test(photoSqlCode),
);

check(
  'the copy states a purpose rather than asking for consent',
  flat(photoSheet).includes('Required to post a parcel') &&
    flat(photoSheet).includes('protects them and deters prohibited items'),
  'the NDPA says consent is not freely given when the service is conditional on it',
);
check(
  'the legal position is flagged for review, not asserted',
  photoSheet.includes('LEGAL_REVIEW_REQUIRED') &&
    read('supabase/migrations/20250101000012_sender_photo.sql').includes('LEGAL_REVIEW_REQUIRED') &&
    privacyNotes.includes('LEGAL_REVIEW_REQUIRED'),
);
check(
  'the notes correct the earlier over-warning about biometric data',
  flat(privacyNotes).includes('That was too strong') &&
    flat(privacyNotes).includes('for the purpose of uniquely identifying'),
  'the Act only treats it as sensitive where it is used to identify — Package Relay does no matching',
);
check(
  'and record that retention is still unresolved',
  /retention/i.test(privacyNotes) && /erasure/i.test(privacyNotes),
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — both cancellation windows are enforced in SQL and mirrored client-side, a driver\n' +
    '       release returns the parcel rather than destroying it, the ₦800 moved from public\n' +
    '       pickup to hub pickup without raising any headline quote, the map pickers are gone\n' +
    '       but their columns survive, and the sender photo is required on every path, handed\n' +
    '       off by a single-use account-bound QR session, and never described as verification.',
);
