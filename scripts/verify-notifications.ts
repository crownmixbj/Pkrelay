/**
 * Assertions for the notification centre.
 *
 * The risks here are the quiet ones that only show up in front of a driver:
 *
 *   - A badge that disagrees with the list it sits above. Two sources for one
 *     number is the classic notification bug, and people screenshot it.
 *   - An inbox that is right while you watch it and wrong when you look away —
 *     a socket that dropped in a pocket and nothing that refetches after.
 *   - A `kind` the database can write and the app has never heard of, which
 *     renders as a blank card with no error anywhere.
 *   - A push and the same row in the inbox opening different screens.
 *   - An optimistic "read" that silently keeps a write the server refused.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  INBOX_PAGE_SIZE,
  badgeLabel,
  mergeNotification,
  relativeTime,
  routeFor,
  toneFor,
  unreadCount,
  type AppNotification,
  type NotificationKind,
} from '../src/store/notification-centre';

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

const store = read('src/store/notification-centre.ts');
const storeCode = code(store);
const hook = code(read('src/hooks/use-notification-centre.ts'));
const router = code(read('src/components/ui/notification-router.tsx'));
const pushClient = code(read('src/store/push.ts'));
const message = code(read('supabase/functions/notify-push/message.ts'));
const migration = code(read('supabase/migrations/20250101000049_notifications.sql'));

// ------------------------------------- 1. the app knows every kind the DB has --

/*
 * ⚠ The single most valuable assertion in this file.
 *
 *   `kind` is a check constraint in SQL and a union type in TypeScript, written
 *   out twice by hand. Adding a kind to one and not the other produces no error
 *   at any layer: the trigger writes happily, the row arrives over Realtime, and
 *   the app renders a card with a default icon and no route. Found by a driver,
 *   months later, if at all.
 */
const sqlKinds = (() => {
  const block = migration.match(/kind text not null check \(kind in \(([\s\S]*?)\)\)/);
  if (!block) throw new Error('could not find the kind check constraint in 49');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
})();

const tsKinds = (() => {
  const block = store.match(/export type NotificationKind =([\s\S]*?);\n/);
  if (!block) throw new Error('could not find NotificationKind');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
})();

check(
  'every kind the database can write is a kind the app knows',
  sqlKinds.every((kind) => tsKinds.includes(kind)),
  `missing from NotificationKind: ${sqlKinds.filter((k) => !tsKinds.includes(k)).join(', ')}`,
);
check(
  'and the app invents none the database would reject',
  tsKinds.every((kind) => sqlKinds.includes(kind)),
  `not in the check constraint: ${tsKinds.filter((k) => !sqlKinds.includes(k)).join(', ')}`,
);

// ------------------------------------ 2. Android channels match the server --

/*
 * ⚠ Resolves `id: DISPATCH_CHANNEL` as well as `id: 'delivery'`.
 *
 *   The first version of this matched string literals only, so it read three
 *   channels where the file declares four and failed on correct code. A check
 *   that cannot read the thing it checks is worse than no check: it trains you
 *   to ignore it.
 */
const clientChannels = (() => {
  const block = pushClient.match(/export const NOTIFICATION_CHANNELS = \[([\s\S]*?)\] as const;/);
  if (!block) throw new Error('could not find NOTIFICATION_CHANNELS');
  const constants: Record<string, string> = {};
  for (const [, name, value] of pushClient.matchAll(/export const ([A-Z_]+) = '([a-z]+)';/g)) {
    constants[name] = value;
  }
  return [...block[1].matchAll(/id: (?:'([a-z]+)'|([A-Z_]+))/g)]
    .map(([, literal, constant]) => literal ?? constants[constant] ?? constant)
    .sort();
})();
const serverChannels = (() => {
  const block = message.match(/export const CHANNELS = \{([\s\S]*?)\} as const;/);
  if (!block) throw new Error('could not find CHANNELS');
  return [...block[1].matchAll(/([a-z]+): '([a-z]+)'/g)].map((m) => m[2]).sort();
})();

check(
  'the app creates exactly the Android channels the server sends to',
  JSON.stringify(clientChannels) === JSON.stringify(serverChannels),
  `app: ${clientChannels.join(', ')} | server: ${serverChannels.join(', ')} — ` +
    'Android does not error on an unknown channel id, it silently files the message under a default channel',
);
check(
  'and creates them before asking for permission',
  pushClient.indexOf('await ensureChannels();') < pushClient.indexOf('requestPermissionsAsync'),
  'a channel created after the first notification arrives is a channel that notification did not use',
);

// ------------------------------------------------- 3. one routing mapping --

check(
  'the push-tap router uses the shared mapping',
  router.includes('routeFor({ kind, metadata: data })'),
  'a second mapping is how a push and the same row in the inbox open different screens',
);
check(
  'and ignores the payload route hint',
  !router.includes('data.route'),
  'the hint exists for a future web client; this app has the mapping in its bundle',
);
check(
  'the legacy offer payload still routes',
  router.includes("data.type === 'dispatch_offer'"),
  'offers still push through notify-offer — see the header of 50 — so both shapes arrive on real devices',
);

const meta = (extra: Record<string, unknown> = {}) => ({ metadata: extra });

check('an offer opens Assigned Trip', routeFor({ kind: 'offer_received', ...meta() }) === '/driver');
check('a pickup reminder opens Assigned Trip', routeFor({ kind: 'pickup_reminder', ...meta() }) === '/driver');
check(
  'a parcel update opens that parcel',
  routeFor({ kind: 'parcel_status_changed', ...meta({ booking_id: 'b-1' }) }) === '/parcel/b-1',
);
check(
  'a parcel update with no id opens the list rather than a broken detail screen',
  routeFor({ kind: 'delivery_completed', ...meta() }) === '/my-packages',
);
check('money opens the wallet', routeFor({ kind: 'payout_paid', ...meta() }) === '/driver-wallet');
check(
  'onboarding opens driver updates',
  routeFor({ kind: 'application_approved', ...meta() }) === '/driver-updates',
);

// --------------------------------------------------------- 4. the badge ----

check('no unread, no badge', badgeLabel(0) === '');
check('a count shows', badgeLabel(3) === '3');
check(
  'the badge caps rather than lying about what it cannot see',
  badgeLabel(INBOX_PAGE_SIZE + 20) === `${INBOX_PAGE_SIZE}+`,
);
check(
  'the badge is derived from the list, not a second query',
  !storeCode.includes('unread_notification_count'),
  'two sources for one number is how a badge says 3 above a list showing 2',
);

const row = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: 'n-1',
  kind: 'offer_received' as NotificationKind,
  title: 'Trip offered',
  body: '',
  metadata: {},
  readAt: null,
  createdAt: '2026-09-11T10:00:00Z',
  ...over,
});

check('unread counts only unread', unreadCount([row(), row({ id: 'n-2', readAt: 'x' })]) === 1);

// ------------------------------------------------------ 5. merging rows ----

const older = row({ id: 'a', createdAt: '2026-09-11T09:00:00Z' });
const newer = row({ id: 'b', createdAt: '2026-09-11T11:00:00Z' });

check('an arriving row lands at the top', mergeNotification([older], newer)[0].id === 'b');
check(
  'the same row twice is one row',
  mergeNotification([older, newer], { ...newer, title: 'changed' }).length === 2,
  'a refetch on reconnect races the INSERTs that follow it — the same row genuinely arrives twice',
);
check(
  'and the newer copy wins',
  mergeNotification([older, newer], { ...newer, title: 'changed' })[0].title === 'changed',
);
check(
  'the list stays capped',
  mergeNotification(
    Array.from({ length: INBOX_PAGE_SIZE }, (_, i) =>
      row({ id: `x-${i}`, createdAt: `2026-09-0${(i % 9) + 1}T09:00:00Z` }),
    ),
    newer,
  ).length === INBOX_PAGE_SIZE,
);

// ---------------------------------------------------- 6. relative times ----

const now = new Date('2026-09-11T12:00:00Z');
check('seconds read as just now', relativeTime('2026-09-11T11:59:30Z', now) === 'Just now');
check('minutes read as minutes', relativeTime('2026-09-11T11:48:00Z', now) === '12 min ago');
check('one hour is singular', relativeTime('2026-09-11T11:00:00Z', now) === '1 hour ago');
check('hours are plural', relativeTime('2026-09-11T09:00:00Z', now) === '3 hours ago');
check('yesterday is named', relativeTime('2026-09-10T11:00:00Z', now) === 'Yesterday');
check('a few days are counted', relativeTime('2026-09-08T11:00:00Z', now) === '3 days ago');
check(
  'a clock-drifted future timestamp does not claim to be scheduled',
  relativeTime('2026-09-11T12:00:30Z', now) === 'Just now',
  'created_at is the server clock; a phone a minute fast would render every arriving notification as a future event',
);
check('an unparseable date renders nothing rather than NaN', relativeTime('not a date', now) === '');

// ------------------------------------------------------------ 7. tone -----

check(
  'a cancelled job and a completed delivery do not look alike',
  toneFor('job_cancelled') !== toneFor('delivery_completed'),
  'one means stop driving, the other means well done',
);
check('a failed payout is danger', toneFor('payout_failed') === 'danger');
check('a paid payout is success', toneFor('payout_paid') === 'success');
check('a pickup reminder is a warning, not an alarm', toneFor('pickup_reminder') === 'warning');

// ------------------------------------------- 8. the client cannot write ----

for (const forbidden of ['.insert(', '.upsert(', '.delete(']) {
  check(
    `the store never calls ${forbidden} on notifications`,
    !storeCode.includes(`from('notifications')${forbidden}`) &&
      !storeCode.includes(forbidden.replace('(', '')) ,
    'every row is written by a security-definer trigger; a client that could insert could write itself "You have been paid"',
  );
}
check(
  'marking read goes through the RPC, not a table update',
  storeCode.includes("rpc('mark_notification_read'") && !storeCode.includes("update({ read_at"),
  'a client that could update this table could set pushed_at on a push that never left',
);

// ------------------------------------------------- 9. the hook refreshes ---

check(
  'the inbox refetches when the socket comes back',
  hook.includes("event.type === 'resubscribed'"),
  'Realtime does not replay what it missed while the phone was asleep',
);
check(
  'and when the app is foregrounded',
  hook.includes("state === 'active'") && hook.includes('AppState.addEventListener'),
  'iOS suspends the socket on background without always reporting a disconnect, so the channel can resume nominally subscribed and having missed everything',
);
check(
  'an optimistic read reverts when the server refuses',
  hook.includes('if (ok) return;') && hook.includes('readAt: null'),
  'a badge that clears on a failed write comes back on the next launch with no explanation',
);
check(
  'mark-all reverts too',
  hook.includes('if (changed === null) setNotifications(snapshot);'),
);
check(
  'signing out empties the inbox',
  hook.includes('setNotifications([]);'),
  'the inbox is personal data and must not survive the session that loaded it',
);
check(
  'a resolved fetch for a previous account is discarded',
  hook.includes('activeViewer.current !== viewer'),
  'signing out mid-request would otherwise render one person’s notifications under another person’s session',
);

// -------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('verify:notifications — all checks passed');
