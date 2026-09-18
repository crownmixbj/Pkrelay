/**
 * Assertions for push notifications and the unified matcher.
 *
 * The risks here are quiet ones again:
 *
 *   - A push token is a bearer credential. Anyone holding one can notify that
 *     device with no key of their own.
 *   - A notification renders on a lock screen — the least private surface in the
 *     system — so anything in the body is public to whoever is stood nearby.
 *   - A dead token never stops being dead, and keeping it makes "we notified
 *     them" true in the log and false in the world.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXPO_BATCH_SIZE,
  EXPO_PUSH_URL,
  buildMessage,
  chunk,
  interpretTickets,
  type OfferPayload,
} from '../supabase/functions/notify-offer/expo-push';

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

const sql = read('supabase/migrations/20250101000019_push.sql');
const sqlCode = code(sql);
const fn = read('supabase/functions/notify-offer/index.ts');
const fnCode = code(fn);
const client = read('src/store/push.ts');
const flashSql = code(read('supabase/migrations/20250101000018_flash_mode.sql'));

// ------------------------------------------------- 1. the unified matcher --

check(
  'a local parcel routes to a flash driver in that city',
  flat(flashSql).includes(
    "when 'flash' then parcel_origin = parcel_destination and parcel_origin = journey_origin",
  ),
);
check(
  'an interstate parcel routes to a declared schedule',
  flat(flashSql).includes(
    'else journey_origin = parcel_origin and journey_destination = parcel_destination',
  ),
);
check(
  'the branch is chosen by the journey, not by guessing from the parcel',
  flat(flashSql).includes('case journey_mode'),
  'a parcel does not know what kind of driver should take it — the journey declares that',
);
check(
  'only approved drivers hold journeys at all',
  flat(read('supabase/migrations/20250101000015_dispatch.sql')).includes(
    'with check (driver_id = (select auth.uid()) and public.is_approved_driver())',
  ),
  'city credentials are the approved application; nothing else grants a driver a city',
);

// ------------------------------------------ 2. availability lands at once --

check(
  'declaring a route sweeps parcels already waiting',
  flat(sqlCode).includes('create trigger driver_journeys_sweep'),
  'without it a new route only ever sees parcels posted after it, which was the gap flash already closed',
);
check(
  'and the sweep uses the same matcher as everything else',
  flat(sqlCode).includes('public.journey_matches(') && flat(sqlCode).includes('b.weight, new.mode'),
  'a second copy of the rule is a second place for it to drift',
);
check(
  'the sweep does not fire on update',
  flat(sqlCode).includes('after insert on public.driver_journeys') &&
    !flat(sqlCode).includes('after insert or update on public.driver_journeys'),
  'pause-and-resume would otherwise be a way to re-sweep the queue on demand',
);
check(
  'going offline takes effect without anything to invalidate',
  flat(read('supabase/migrations/20250101000018_flash_mode.sql')).includes("set status = 'completed'") &&
    flat(read('supabase/migrations/20250101000015_dispatch.sql')).includes("where j.status = 'open'"),
  'the matcher reads status live, so a mode change is visible on the next match',
);

// ---------------------------------------------- 3. dispatch fires on post --

check(
  'a posted parcel is dispatched by a trigger',
  flat(read('supabase/migrations/20250101000015_dispatch.sql')).includes('create trigger bookings_dispatch_on_insert'),
);
check(
  'and every created offer notifies, from the row rather than the caller',
  flat(sqlCode).includes('create trigger dispatch_offers_notify') &&
    flat(sqlCode).includes('after insert on public.dispatch_offers'),
  'dispatch_booking is called from four places and every one of them should notify',
);
check(
  'the notifier is called asynchronously',
  flat(sqlCode).includes('extensions.net.http_post'),
  'a slow notifier must not roll back the offer it is announcing',
);
check(
  'an unconfigured deployment still dispatches',
  flat(sqlCode).includes('if edge_url is null or service_key is null then return new;'),
  'every preview build has no edge settings, and must still be able to assign parcels',
);

// ------------------------------------------------------ tokens are secrets --

check(
  'a driver can only read their own tokens',
  flat(sqlCode).includes('using (user_id = (select auth.uid()))'),
  'a token is a bearer credential — reading someone else’s is enough to notify their phone',
);
check(
  'and there is no admin exception',
  !/push_tokens[\s\S]{0,400}?is_admin\(\)/.test(sqlCode),
  'an admin has no operational need to send arbitrary notifications to a driver',
);
check(
  'a token is claimed by the account registering it',
  flat(sqlCode).includes('on conflict (token) do update set user_id = excluded.user_id'),
  'two drivers share a phone more often than either uninstalls — the token follows whoever is signed in',
);
check(
  'a malformed token is refused',
  flat(sqlCode).includes("push_token !~ '^Ex(ponent)?PushToken"),
);
check(
  'the token is the primary key',
  flat(sqlCode).includes('token text primary key'),
  'a surrogate id would allow two rows for one device, which is two notifications on one phone',
);
check(
  'signing out forgets the device',
  flat(code(read('src/store/session.tsx'))).includes('await unregisterPush();'),
  'otherwise the next person on a shared phone keeps getting the previous driver’s offers',
);
check(
  'and it happens before the session is dropped',
  code(read('src/store/session.tsx')).indexOf('await unregisterPush()') <
    code(read('src/store/session.tsx')).indexOf('supabase.auth.signOut()'),
  'the delete needs the session it is about to end — the order is load-bearing',
);

// ------------------------------------ the notifier cannot take dispatch down --

const delivery = read('supabase/migrations/20250101000024_push_delivery.sql');
const deliveryCode = code(delivery);

check(
  'pg_net is resolved at runtime, not hard-coded',
  flat(deliveryCode).includes('post_fn := private.pg_net_post_fn();') &&
    flat(deliveryCode).includes("where p.proname = 'http_post'"),
  'Supabase puts pg_net in net on some projects and extensions on others; 20250101000019_push.sql guessed a third thing that is not valid SQL at all',
);
check(
  'the broken three-part name is gone',
  !deliveryCode.includes('extensions.net.http_post'),
  'Postgres reads extensions.net.http_post as database.schema.function and refuses before it looks for anything',
);
check(
  'the send cannot abort the offer',
  flat(deliveryCode).includes('exception when others then'),
  'it is an AFTER INSERT trigger on dispatch_offers, and dispatch runs inside the booking insert trigger — a raise here stops a sender posting a parcel at all',
);
check(
  'a failed send is recorded rather than swallowed',
  flat(deliveryCode).includes("'error', 'push', 'could not queue an offer notification'"),
);
/*
 * Scoped to the error path, not the whole function.
 *
 * My first version of this assertion searched the entire function for
 * `service_key` inside a `jsonb_build_object` and failed — on the Authorization
 * header, which is the one place the key is supposed to be. An assertion that
 * fires on correct code is worse than none: it trains you to edit the test.
 */
const errorPath = flat(deliveryCode).slice(
  flat(deliveryCode).indexOf('exception when others then'),
);

check(
  'and the service key never reaches the log line',
  errorPath.includes("'error', sqlerrm, 'via', post_fn") && !errorPath.includes('service_key'),
  'the key is in scope exactly where the error is written, which is when it is easiest to log by accident',
);
check(
  'a project without pg_net says so instead of going quiet',
  flat(deliveryCode).includes("'warning', 'push', 'pg_net is not enabled"),
);
check(
  'an unconfigured project still dispatches',
  flat(deliveryCode).includes('if edge_url is null or service_key is null then return new;'),
  'every preview build in the field is in this state',
);

// ------------------------------------------- registered when a driver signs in --

const sessionSource = code(read('src/store/session.tsx'));

check(
  'an approved driver registers for push at sign-in',
  sessionSource.includes("if (nextApplication?.status === 'approved')") &&
    sessionSource.includes('void registerForPush();'),
  'registering only when a driver goes online means the first offer of the day arrives on a silent phone',
);
check(
  'and nobody else is prompted',
  /nextApplication\?\.status === 'approved'/.test(sessionSource),
  'a sender has nothing offered to them, so a notification prompt is a cost with no return',
);
check(
  'the app does not wait on the permission dialog',
  sessionSource.includes('void registerForPush();') &&
    !sessionSource.includes('await registerForPush();'),
  'a driver must never be held out of their own home screen by a system prompt',
);

check(
  'the push token is minted against an explicit project id',
  code(read('src/store/push.ts')).includes(
    'Notifications.getExpoPushTokenAsync({ projectId: projectId() })',
  ),
  'inference throws when it fails, and every caller here catches — so the driver would be told "could not turn on alerts" and no reason would exist anywhere',
);
check(
  'in both the register and the release path',
  (
    code(read('src/store/push.ts')).match(
      /getExpoPushTokenAsync\(\{ projectId: projectId\(\) \}\)/g,
    ) ?? []
  ).length === 2,
  'a release that mints a different token than the register did would delete nothing',
);

// ----------------------------------------- nothing private on a lock screen --

const offer: OfferPayload = {
  offerId: 'o-1',
  bookingId: 'b-1',
  originCity: 'Ibadan',
  destinationCity: 'Lagos',
  weight: 4,
  fee: 6500,
  isLocal: false,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};

/*
 * A fixed clock.
 *
 * `buildMessage` floors the remaining minutes, so the handful of milliseconds
 * between building `expiresAt` and calling it turned 5 into 4 — a failure about
 * elapsed time rather than about the message. The function takes `now` for
 * exactly this reason.
 */
const fixedNow = new Date(Date.parse(offer.expiresAt) - 5 * 60_000);
const message = buildMessage('ExponentPushToken[abc]', offer, fixedNow);
const rendered = `${message.title} ${message.body} ${JSON.stringify(message.data)}`;

check('the notification names the route', rendered.includes('Ibadan → Lagos'));
check('and the fee and weight', rendered.includes('4 kg') && rendered.includes('6,500'));
check('and how long is left', /5 min left/.test(rendered));
check(
  'and says what to do about it',
  /Open Package Relay to accept/.test(rendered),
  'a deadline with no named action tells a driver they are late without telling them for what',
);
check(
  'a local job reads differently from an interstate one',
  /Local job in Ibadan/.test(buildMessage('t', { ...offer, isLocal: true }, fixedNow).body),
  'a driver in flash mode should not have to parse a route to see it is local',
);

check(
  'the payload carries ids, not people',
  Object.keys(message.data).every((key) =>
    ['type', 'offerId', 'bookingId', 'expiresAt'].includes(key),
  ),
);
check(
  'and the SQL only ever hands the notifier an id',
  flat(sqlCode).includes("jsonb_build_object('offer_id', new.id)"),
  'passing a name or address through pg_net puts customer data in net._http_response',
);
check(
  'the payload function returns no contact column',
  ['recipient_name', 'recipient_phone', 'pickup_address', 'dropoff_address', 'sender_phone'].every(
    (column) =>
      !sqlCode.slice(sqlCode.indexOf('offer_push_payload')).slice(0, 1200).includes(column),
  ),
);
check(
  'and no client may call it',
  flat(sqlCode).includes(
    'revoke all on function public.offer_push_payload(uuid) from public, anon, authenticated',
  ),
);

// -------------------------------------------------------- delivery hygiene --

check(
  'the Expo endpoint is the documented one',
  EXPO_PUSH_URL === 'https://exp.host/--/api/v2/push/send',
);
check('batches respect Expo’s limit', EXPO_BATCH_SIZE === 100);
check(
  'and a long token list is split',
  chunk(Array.from({ length: 250 }, (_, i) => `t${i}`)).length === 3,
);

check(
  'a per-message failure is read from the ticket, not the status code',
  interpretTickets(['a', 'b'], {
    data: [{ status: 'ok' }, { status: 'error', details: { error: 'MessageTooBig' } }],
  }).sent === 1,
  'Expo returns 200 even when individual messages failed',
);
check(
  'a dead device is reported for deletion',
  interpretTickets(['a'], {
    data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
  }).deadTokens[0] === 'a',
);
check(
  'other errors do not delete a working token',
  interpretTickets(['a'], {
    data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }],
  }).deadTokens.length === 0,
  'rate limiting is ours to fix, not a reason to stop being able to reach a driver',
);
check(
  'an unreadable response fails closed rather than claiming success',
  interpretTickets(['a', 'b'], {}).failed === 2,
);
check(
  'and the function actually deletes what Expo rejected',
  flat(fnCode).includes("await rpc('forget_push_token', { dead_token: dead })"),
  'a token for an uninstalled app is invalid forever and costs a send every time',
);

/*
 * ⚠ Repointed at the property, not at the line that used to carry it.
 *
 *   This pinned `auth !== \`Bearer ${SERVICE_KEY}\`` — a comparison with the key
 *   *this deployment* was injected with. The identical check in `notify-events`
 *   turned a rotated key, and a key stored with a trailing newline, into a 403
 *   that recorded nothing anywhere while the database believed it had posted.
 *   All three trigger-called functions now share `isServiceRole`, which asks
 *   whether the caller *is* the service role rather than whether it holds this
 *   copy of it — and which still refuses the anon key, which is the thing that
 *   actually matters here and is unit-tested in `verify-notify-events.ts`.
 */
check(
  'only the service role can call the notifier',
  flat(fnCode).includes('isServiceRole(auth, SERVICE_KEY)') &&
    flat(fnCode).includes('if (!caller.ok)'),
  'without it, any caller could pass an offer id and ring somebody else’s phone',
);
check(
  'and it refuses before reading the body',
  flat(fnCode).indexOf('isServiceRole(auth, SERVICE_KEY)') < flat(fnCode).indexOf('request.json()'),
  'a body parsed before the caller is checked is work done for a stranger',
);
check(
  'the response carries counts, never tokens',
  flat(fnCode).includes("return json({ status: 'sent', sent, failed })") &&
    !/json\(\{[^}]*token/i.test(flat(fnCode)),
);
check(
  'a settled offer is a no-op, not an error',
  flat(fnCode).includes("if (!row) return json({ status: 'gone' })"),
  'the offer can be declined on another device between the trigger firing and this running',
);
check(
  'a driver with no device is not a failure',
  flat(fnCode).includes("if (tokens.length === 0) return json({ status: 'no-devices' })"),
);

// ------------------------------------------------------------ the client ---

check(
  'permission is asked for when the driver goes online, not at launch',
  flat(code(read('src/components/ui/driver-hub.tsx'))).includes('await registerForPush()'),
  'asking on first launch gets refused, and on iOS the prompt never comes back',
);
check(
  'and the client says so where somebody would move it',
  /Only ever call this at a moment the driver would expect it/.test(client),
);
check(
  'a refusal tells the driver what to do instead',
  flat(client).includes('keep this screen open while you wait'),
  'a driver who declined notifications still needs to know how to catch an offer',
);
check(
  'simulators and web are handled rather than thrown from',
  flat(client).includes("if (Platform.OS === 'web' || !Device.isDevice)"),
  'getExpoPushTokenAsync throws on a simulator',
);
check(
  'Android gets a dedicated channel',
  flat(client).includes("DISPATCH_CHANNEL = 'dispatch'") &&
    flat(read('supabase/functions/notify-offer/expo-push.ts')).includes("channelId: 'dispatch'"),
  'without a channel Android 8+ buries it in the default one, which a driver may have muted',
);
check(
  'the notification handler is set before any screen mounts',
  flat(code(read('src/app/_layout.tsx'))).includes('configureNotificationHandler();'),
);
check(
  'tapping a notification opens the screen where the offer is answered',
  (() => {
    /*
     * Derived, not pinned to a route string.
     *
     * The previous version of this assertion checked the router navigated to
     * '/available-packages'. It kept passing after the offer card moved to
     * Assigned Trip — the string was still there, and still wrong. A tap landed
     * on a screen with nothing to answer.
     *
     * So follow the route to the screen and check the offer card is actually
     * rendered somewhere down it. That fails the next time the card moves,
     * which is the only version of this check worth having.
     */
    const router = code(read('src/components/ui/notification-router.tsx'));
    const target = /router\.navigate\('([^']+)'\)/.exec(router)?.[1];
    if (!target) return false;

    const screen = code(read(`src/app/(tabs)${target}.tsx`));
    const renders = (source: string) => source.includes('<DispatchOffers');

    return (
      renders(screen) ||
      (screen.includes('DriverHub') && renders(code(read('src/components/ui/driver-hub.tsx'))))
    );
  })(),
  'the destination has to be a screen that renders DispatchOffers, whichever route that is',
);
check(
  'and a cold start is handled as well as a warm one',
  flat(client + read('src/components/ui/notification-router.tsx')).includes(
    'getLastNotificationResponseAsync',
  ),
  'the listener alone misses the case where the notification launched the app',
);

check(
  'the notifications plugin is registered so a build has the native side',
  JSON.stringify(JSON.parse(read('app.json')).expo.plugins).includes('expo-notifications'),
);

// -------------------------------------------------------- the honest gaps --

check(
  'the unconfirmed-delivery gap is written down',
  /receipts endpoint this does not poll/i.test(flat(sql)),
  'Expo returns a ticket; the real outcome arrives later and nothing fetches it',
);
check('and so is the shift that never ends itself', /nothing detects absence/i.test(flat(sql)));

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — local parcels route to flash drivers in that city and interstate ones to declared\n' +
    '       schedules, a new route sweeps the parcels already waiting, every offer notifies from\n' +
    '       the row rather than the caller, tokens are readable only by their owner and dropped\n' +
    '       when Expo says the device is gone, and nothing on a lock screen names a customer.',
);
