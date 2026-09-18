/**
 * Assertions for the Support Ticketing queue.
 *
 * ⚠ Four of these guard mistakes that would be invisible on the screen.
 *
 *   1. A function that forgot `is_admin()` looks identical in the browser to one
 *      that has it — the admin testing it is an admin. What changes is that
 *      every signed-in customer can read every ticket in the platform.
 *   2. `admin_support_messages` is the only path to an internal note in the
 *      whole schema. Granting it to `anon` would publish operational notes to a
 *      key that ships inside the app bundle.
 *   3. The customer's read path must stay on the table under RLS. The moment a
 *      customer screen calls an `admin_*` function, "staff only" depends on a
 *      function body rather than on a policy.
 *   4. `first_response_at` must not move for an internal note. That one line is
 *      the entire response-time metric, and getting it wrong reports a team as
 *      fast while nobody outside the building has heard anything.
 *
 * Run with `npm run verify:support`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_FILTERS,
  TICKET_FILTER_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  sinceLabel,
  statusTone,
  type TicketStatus,
} from '../src/store/support-tickets';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const migration = read('supabase/migrations/20250101000059_support_tickets.sql');
const store = read('src/store/support-tickets.ts');
const screen = read('src/app/(tabs)/admin-support.tsx');
const panel = read('src/components/ui/support-ticket-panel.tsx');
const nav = read('src/components/ui/app-nav-bar.tsx');

/** Source with comments stripped — the prose below quotes what it forbids. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '')
    .replace(/\/\/.*$/gm, '');

// ------------------------------------------------ 1. every door is guarded --

const ADMIN_FUNCTIONS = [
  'admin_support_counts',
  'admin_support_queue',
  'admin_support_ticket',
  'admin_support_messages',
  'admin_reply_support_ticket',
  'admin_set_support_status',
  'admin_assign_support_ticket',
  'admin_create_support_ticket',
] as const;

const ALL_FUNCTIONS = [
  ...ADMIN_FUNCTIONS,
  'create_support_ticket',
  'reply_support_ticket',
  'notify_support_admins',
  'scrub_support_tickets_on_erase',
] as const;

/** Everything from one `function public.<name>(` to the next, in file order. */
function bodyOf(name: string): string {
  const start = migration.indexOf(`function public.${name}(`);
  if (start < 0) return '';

  const next = ALL_FUNCTIONS.map((other) =>
    other === name ? -1 : migration.indexOf(`function public.${other}(`),
  ).filter((at) => at > start);

  return migration.slice(start, next.length ? Math.min(...next) : undefined);
}

for (const fn of ADMIN_FUNCTIONS) {
  const body = bodyOf(fn);
  check(`${fn} exists`, body.length > 0);
  if (!body) continue;

  check(
    `${fn} checks is_admin()`,
    /is_admin\(\)/.test(body),
    'a definer function with no caller check is a public API for the whole table',
  );
  check(
    `${fn} is security definer with a pinned search_path`,
    /security definer/.test(body) && /set search_path = ''/.test(body),
    'a definer function without a pinned search_path can be redirected by a caller-set path',
  );
  check(
    `${fn} is revoked from anon`,
    new RegExp(`revoke all on function public\\.${fn}\\(`).test(migration),
    'granted to anon, these answer to a key that ships in the app bundle',
  );
  check(
    `${fn} is granted to authenticated`,
    new RegExp(`grant execute on function public\\.${fn}\\(`).test(migration),
    'without the grant the screen gets "permission denied" from every call',
  );
}

for (const fn of ['create_support_ticket', 'reply_support_ticket'] as const) {
  const body = bodyOf(fn);
  check(
    `${fn} scopes itself to the caller`,
    /auth\.uid\(\)/.test(body),
    'the customer path is definer too, so the where clause IS the access control',
  );
}

{
  const body = bodyOf('notify_support_admins');
  check(
    'notify_support_admins is revoked from authenticated as well',
    /revoke all on function public\.notify_support_admins\([^)]*\)\s*\n?\s*from public, anon, authenticated;/.test(
      migration,
    ),
    'it queues a notification to every admin — a client that could call it could spam the team',
  );
  check('and it exists', body.length > 0);
}

// ------------------------------------------- 2. what the policies allow --

{
  check(
    'the tickets table is RLS-enabled',
    /alter table public\.support_tickets enable row level security/.test(migration),
  );
  check(
    'the messages table is RLS-enabled',
    /alter table public\.support_ticket_messages enable row level security/.test(migration),
  );

  const sql = code(migration);

  check(
    'a requester may read their own tickets',
    /create policy "own support tickets"[\s\S]{0,200}for select[\s\S]{0,200}requester_id = \(select auth\.uid\(\)\)/.test(
      sql,
    ),
  );
  check(
    "the message policy returns public entries only",
    /create policy "own support messages"[\s\S]{0,400}visibility = 'public'/.test(sql),
    'an internal note is written on the assumption the customer cannot read it',
  );
  check(
    'and it still scopes to their own ticket',
    /create policy "own support messages"[\s\S]{0,500}requester_id = \(select auth\.uid\(\)\)/.test(sql),
  );
  check(
    'there is no insert, update or delete policy on either table',
    !/create policy[^;]*on public\.support_ticket(s|_messages) for (insert|update|delete)/.test(sql),
    'a client that could write these sets its own status, reference and first_response_at',
  );
  check(
    'and no admin select policy either',
    !/create policy[^;]*on public\.support_ticket(s|_messages)[\s\S]{0,300}is_admin\(\)/.test(sql),
    'a blanket admin read policy exposes every thread through PostgREST',
  );
}

// ------------------------------------- 3. the constraints that hold the shape --

{
  check(
    'a customer cannot author an internal note',
    /constraint support_internal_is_staff_only check \(\s*author_role = 'admin' or visibility = 'public'\s*\)/.test(
      migration,
    ),
    'one transposed argument would silently lose half a thread with no error anywhere',
  );
  check(
    'resolved and resolved_at move together',
    /\(status = 'resolved'\) = \(resolved_at is not null\)/.test(migration),
    'otherwise a reopened ticket is open and closed at once, and every count disagrees',
  );
  check(
    'the four statuses are checked in the table',
    /status text not null default 'open' check \(status in \([\s\S]{0,200}'waiting_on_customer'/.test(
      migration,
    ),
    'waiting_on_customer is the state that makes "awaiting us" answerable',
  );
}

// --------------------------------- 4. an internal note is not an answer --

{
  const reply = bodyOf('admin_reply_support_ticket');

  check(
    'the reply function branches on internal before touching the dated columns',
    /if not internal then[\s\S]{0,600}first_response_at = coalesce\(first_response_at, now\(\)\)/.test(
      reply,
    ),
    'a note that moved first_response_at would report the ticket as answered',
  );
  check(
    'and it only notifies on a public reply',
    /if not internal then[\s\S]{0,900}queue_notification/.test(reply),
    'the note exists precisely because the customer should not read it',
  );
  check(
    'a public reply takes an Open ticket to In Progress',
    /status = case when status = 'open' then 'in_progress' else status end/.test(reply),
  );

  const resolve = bodyOf('admin_set_support_status');
  check(
    'resolving demands a note',
    /p_status = 'resolved' and length\(note\) < 4/.test(resolve),
    'a silent close is indistinguishable, from the outside, from being ignored',
  );
  check(
    'and the note is filed where the customer can read it',
    /'admin', 'public', note/.test(resolve),
  );

  const customerReply = bodyOf('reply_support_ticket');
  check(
    'a customer reply reopens a resolved ticket',
    /when 'resolved' then 'open'/.test(customerReply),
    '"that did not fix it" is the most important thing a support system can hear',
  );
  check(
    'and clears the stale resolution with it',
    /resolution = case when status = 'resolved' then null else resolution end/.test(customerReply),
  );
}

// ------------------------------------------ 5. erasure reaches the threads --

{
  const scrub = bodyOf('scrub_support_tickets_on_erase');

  check(
    'erasure empties the threads',
    /delete from public\.support_ticket_messages/.test(scrub),
    'a support thread is the one place an address can arrive as prose',
  );
  check(
    'and the trigger fires on the erasure, not on every profile update',
    /after update of deleted_at on public\.profiles[\s\S]{0,200}when \(old\.deleted_at is null and new\.deleted_at is not null\)/.test(
      migration,
    ),
  );
  check(
    'the shell is kept rather than deleted',
    /update public\.support_tickets\s*\n\s*set subject = 'Removed'/.test(scrub),
    'that an account raised four tickets is operational history; what they typed is not',
  );
}

// --------------------------------------- 6. the two halves stay separate --

{
  check(
    'the customer panel never calls an admin function',
    !/admin_support|admin_reply|admin_set_support|admin_assign|admin_create_support/.test(panel),
    'the moment it does, "staff only" depends on a function body rather than a policy',
  );
  check(
    'the customer read path goes through the table under RLS',
    /from\('support_tickets'\)/.test(store) && /from\('support_ticket_messages'\)/.test(store),
    'so a second customer screen written against it is safe by construction',
  );
  check(
    'and it never asks for an author name from profiles',
    !/author_name:/.test(code(store).split('fetchMyTicketThread')[0] ?? '') ||
      /author_role === 'admin' \? 'Package Relay' : 'You'/.test(store),
    'putting a staff name in front of a customer invites them to ask for that person',
  );
}

// --------------------------------------------- 7. the labels are complete --

{
  for (const status of TICKET_STATUSES) {
    check(`${status} has a label`, !!TICKET_STATUS_LABELS[status]);
    check(`${status} has a tone`, !!statusTone(status));
  }
  for (const filter of TICKET_FILTERS) {
    check(`the ${filter} filter has a label`, !!TICKET_FILTER_LABELS[filter]);
  }
  for (const category of TICKET_CATEGORIES) {
    check(`the ${category} category has a label`, !!TICKET_CATEGORY_LABELS[category]);
  }

  /*
   * Every status in the TypeScript union is in the SQL check constraint, and the
   * reverse. Two hand-written lists of the same thing always drift; the compiler
   * only catches it when they are the same list, and these cannot be.
   */
  const constraint =
    migration.match(/status text not null default 'open' check \(status in \(([\s\S]*?)\)\)/)?.[1] ??
    '';
  const inSql = [...constraint.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);

  check(
    'the SQL statuses and the TypeScript statuses are the same set',
    inSql.length === TICKET_STATUSES.length &&
      TICKET_STATUSES.every((status) => inSql.includes(status)),
    `sql: ${inSql.join(', ')}\n       ts:  ${TICKET_STATUSES.join(', ')}`,
  );

  /* The two queue-only filters are filters, and must not have become statuses. */
  for (const filter of ['awaiting_us', 'unresolved'] as const) {
    check(
      `${filter} is a filter and not a status`,
      !(TICKET_STATUSES as readonly string[]).includes(filter) &&
        new RegExp(`p_status = '${filter}'`).test(migration),
      'it crosses three statuses — as a fifth status nobody would ever set it by hand',
    );
  }
}

// ----------------------------------------------- 8. the screen is wired in --

{
  check(
    'the support screen is wrapped in AdminShell',
    /<AdminShell/.test(screen),
    'not as the control — as the courtesy that keeps a non-admin off a screen that would be\n' +
      '       empty anyway',
  );
  check(
    'and it says where the boundary actually is',
    /is_admin\(\)/.test(screen),
    'the next person to read this needs to know it is not the shell',
  );
  check(
    'the queue defaults to what is awaiting us',
    /useState<TicketFilter>\('awaiting_us'\)/.test(screen),
    'Open is a status somebody clicked; awaiting us is the state of the world',
  );
  check(
    'an internal note is a toggle rather than a second send button',
    /accessibilityRole="switch"/.test(screen),
    'two send buttons is one mis-tap from putting an internal note in front of a customer',
  );
  check(
    'the nav entry resolves to the route',
    nav.includes("href: '/admin-support'"),
  );
  check(
    'and the route is in the admin `also` list',
    /also: \[[^\]]*'\/admin-support'/s.test(nav),
    'without it the Admin tab stops looking active on this screen',
  );
  check(
    'the ticket drawer links out to the account',
    /admin-users\?q=/.test(screen),
    'an operator reading a ticket needs the account it belongs to, one tap away',
  );
  check(
    'and shows the parcel without navigating away',
    /fetchAdminParcelDetail/.test(screen),
    'losing the thread to read two fields is how a half-written reply gets abandoned',
  );
  check(
    'the customer panel is on the Support screen',
    /<SupportTicketPanel \/>/.test(read('src/app/(tabs)/support.tsx')),
    'a queue with no way in stays empty and the phone keeps ringing',
  );
}

// ------------------------------------------------------- 9. small things --

{
  check('sinceLabel says "just now" under an hour', sinceLabel(new Date().toISOString()) === 'just now');
  check(
    'and counts days past a day',
    sinceLabel(new Date(Date.now() - 50 * 3_600_000).toISOString()) === '2 days ago',
  );
  check('and copes with nothing', sinceLabel(null) === '—');

  const tones = TICKET_STATUSES.map((status: TicketStatus) => statusTone(status));
  check(
    'resolved is the only success tone',
    tones.filter((tone) => tone === 'success').length === 1,
    'if two statuses read as done, the queue stops telling you which ones are',
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('the support queue screens hold.\n');
