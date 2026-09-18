/**
 * Assertions for the handler that turns a queued row into a sent email.
 *
 * ⚠ Everything here guards one property: a request that reaches this function
 *   never leaves the row exactly as it found it without saying why.
 *
 *   The symptom that produced this file was a sweep that posted successfully,
 *   a function that "exited without completing", and an outbox row with
 *   `sent_at` null, `error` null and `attempts` ticking upward. Three exits did
 *   that — a refused Authorization header, an unparseable body, and a REST read
 *   that failed — and a fourth was worse: the write-back ignored its own
 *   response, so an email that had genuinely been sent could leave the row
 *   unmarked and be sent again by the next sweep, every five minutes.
 *
 * The auth helper is imported and exercised rather than pattern-matched. It is
 * the piece that decides whether anything happens at all, and a regex cannot
 * tell you that it lets the anon key through.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isServiceRole, jwtRole, timingSafeEqual } from '../supabase/functions/_shared/service-role';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const handler = read('supabase/functions/notify-events/index.ts');

/**
 * A project JWT with the given role. Only the payload segment is ever read.
 *
 * Built with `btoa` rather than `Buffer` so this file needs no node types — the
 * same reason `_shared/service-role.ts` decodes with `atob`.
 */
const tokenFor = (role: string) => {
  const payload = btoa(JSON.stringify({ role, iss: 'supabase' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return ['eyJhbGciOiJIUzI1NiJ9', payload, 'sig'].join('.');
};

// ------------------------------------------------------------ who may call --

check('a service_role JWT is accepted', isServiceRole(`Bearer ${tokenFor('service_role')}`, 'other').ok);

/*
 * ⚠ The assertion the whole check exists for.
 *
 *   The anon key ships inside the app bundle. Supabase's gateway accepts it as
 *   a valid project JWT, so this function is the only thing standing between it
 *   and an endpoint that sends mail from a DKIM-signed domain.
 */
const anon = isServiceRole(`Bearer ${tokenFor('anon')}`, 'other');
check('the anon key is refused', !anon.ok, 'the anon key is in the app bundle');
check('and the log says which role it was', anon.how === 'jwt-role:anon', anon.how);

/*
 * ⚠ A different-but-valid service key still works, which is the bug being fixed.
 *
 *   The old check was `auth !== \`Bearer ${SERVICE_KEY}\`` — the key *this
 *   deployment* was injected with. A rotated key, or the same key stored in
 *   `private.app_settings` with a trailing newline from a SQL-editor paste, is
 *   a 403 that records nothing and looks exactly like the function never being
 *   called.
 */
check(
  'a rotated service_role JWT is still the service role',
  isServiceRole(`Bearer ${tokenFor('service_role')}`, 'a-completely-different-key').ok,
  'comparing against this deployment’s own copy is what broke',
);
check(
  'a non-JWT secret falls back to matching this deployment’s key',
  isServiceRole('Bearer sb_secret_abc123', 'sb_secret_abc123').ok,
);
check(
  'and whitespace does not decide it',
  isServiceRole('Bearer   sb_secret_abc123  \n', 'sb_secret_abc123\n').ok,
  'a value pasted into the SQL editor picks up a newline, and nobody can see it',
);
check('a wrong secret is refused', !isServiceRole('Bearer nope', 'sb_secret_abc123').ok);
check('an empty header is refused', !isServiceRole('', 'key').ok);
check(
  'and an unconfigured deployment refuses rather than accepting everything',
  !isServiceRole('Bearer anything', null).ok,
  'an empty expected key must never compare equal',
);

check('a non-JWT has no role', jwtRole('sb_secret_abc') === null);
check('garbage in the payload segment does not throw', jwtRole('a.!!!!.c') === null);
check('the comparison is length-guarded', !timingSafeEqual('abc', 'abcd'));

// ------------------------------------------------------- who it comes from --

/*
 * ⚠ The sender is a constant with an override, not a secret that must be set.
 *
 *   It was `env('LOCI_FROM_EMAIL') ?? ''`, and an unset secret meant the row was
 *   marked "LOCI_FROM_EMAIL is not set" and nothing was sent — a deployment step
 *   standing between a queued email and a person, for a value that is not a
 *   secret and does not vary.
 */
const shared = read('supabase/functions/_shared/email.ts');
const defaultFrom = /DEFAULT_FROM = '([^']+)'/.exec(shared)?.[1] ?? '';

check('there is a default sender', defaultFrom.length > 0, 'nothing to fall back to');
check(
  'it is a real address on the app domain',
  /^[^<]*<[^@\s]+@[^@\s]+\.[a-z]{2,}>$/.test(defaultFrom),
  `DEFAULT_FROM is "${defaultFrom}" — Resend needs "Name <address>"`,
);
/*
 * The display name follows the prose rule — `Package Relay`, not `PKRELAY`. A
 * From line is the most-read user-facing string this system produces.
 */
check(
  'and it is branded in prose, not in the wordmark',
  defaultFrom.startsWith('Package Relay <'),
  `DEFAULT_FROM is "${defaultFrom}"`,
);
check(
  'the handler falls back to it',
  /const FROM = \(env\('LOCI_FROM_EMAIL'\) \?\? ''\)\.trim\(\) \|\| DEFAULT_FROM/.test(handler),
  'a whitespace-only secret must fall back too, which `??` alone does not do',
);
check(
  'and an unset sender is no longer a reason not to send',
  !handler.includes("LOCI_FROM_EMAIL is not set"),
  'that branch recorded a refusal for a value the code can supply itself',
);
/*
 * Both functions that email a driver use the same one. Two addresses would be
 * two reputations to warm up and two things for a recipient to distrust.
 */
check(
  'the application confirmation sends from the same address',
  read('supabase/functions/notify-application/index.ts').includes('|| DEFAULT_FROM'),
);

// ------------------------------------------- every exit leaves a record ----

/*
 * ⚠ Counted, not eyeballed.
 *
 *   Each of these is a path that returns after the outbox id is known. Every
 *   one has to either mark the row sent or write a sentence into `error`; the
 *   two that run before the id is known cannot write to a row and log instead.
 */
for (const [label, marker] of [
  ['an unreadable row', 'Could not read the row'],
  ['a missing Resend key', 'RESEND_API_KEY is not set'],
  ['a template that throws', 'failed: ${detail}'],
  ['a kind with no template', 'No template for kind'],
] as const) {
  check(
    `${label} is written to the row`,
    handler.includes(marker),
    'a row that cannot explain itself is indistinguishable from one nothing ever touched',
  );
}

for (const stage of [
  'refused',
  'unparseable-body',
  'no-outbox-id',
  'no-such-row',
  'unreadable-row',
  'send-failed',
  'write-back-refused',
]) {
  check(`the ${stage} path logs`, handler.includes(`log('${stage}'`), 'this exit is invisible otherwise');
}

/*
 * ⚠ The refusal says which kind of refusal it was.
 *
 *   `jwt-role:anon` and `key-mismatch` are different problems with different
 *   fixes. A bare 403 distinguishes neither, and the caller here is a database
 *   trigger that cannot read prose.
 */
check(
  'a refusal reports why',
  /log\('refused', \{ why: caller\.how \}\)/.test(handler) && handler.includes("why: caller.how }, 403"),
);

// ----------------------------------------------- the write-back is checked --

/*
 * ⚠ The dangerous one.
 *
 *   `recordOutcome` was `await fetch(...)` with no look at the response. A PATCH
 *   refused for any reason left `sent_at` null on an email that had already
 *   gone out — and `sweep_unsent_emails` then re-sends it every five minutes
 *   until `attempts` reaches three. The column is the only thing preventing
 *   that, so a silent write-back failure is not a logging gap, it is a mailing
 *   loop.
 */
check(
  'the write-back checks its own response',
  /if \(!response\.ok\) \{[\s\S]{0,400}write-back-refused/.test(handler),
  'ignoring the PATCH response turns a sent email into one the sweep sends again',
);
check(
  'and a send that could not be recorded is not reported as success',
  /recorded: false/.test(handler) && /sent but could not mark the row/.test(handler),
  'answering ok:true there is invisibly wrong in somebody’s inbox every five minutes',
);
check(
  'rendering is wrapped rather than allowed to 500',
  /try \{\s*rendered = render\(/.test(handler),
  'an uncaught throw in a template is the same invisible failure with a different cause',
);
check(
  'a REST failure is not reported as a missing row',
  handler.includes("reason: 'unreadable'") && handler.includes("reason === 'absent'"),
  '"no such email" sends whoever reads it looking in the wrong place',
);

// ------------------------------------------- and the other two callers too --

/*
 * `notify-offer` and `notify-push` are reached by the same trigger machinery
 * carrying the same key from the same table, and had the same check.
 */
for (const fn of ['notify-offer', 'notify-push']) {
  const source = read(`supabase/functions/${fn}/index.ts`);
  check(
    `${fn} uses the shared service-role check`,
    source.includes("from '../_shared/service-role.ts'") && source.includes('isServiceRole('),
  );
  check(
    `${fn} no longer compares the header with its own key`,
    !/auth !== `Bearer \$\{SERVICE_KEY\}`/.test(source),
    'the same 403-that-records-nothing, in a function nobody is watching',
  );
}

/* The key must never reach a log line, and it is in scope in all three. */
for (const fn of ['notify-events', 'notify-offer', 'notify-push']) {
  const source = read(`supabase/functions/${fn}/index.ts`);
  check(
    `${fn} never logs the service key`,
    !/console\.[a-z]+\([^)]*SERVICE_KEY/.test(source),
    'a key in a log aggregator is a key that has left the building',
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — the anon key cannot reach an endpoint that sends mail, a rotated or whitespace-\n' +
    '       padded service key still can, every exit after the id is known writes its reason\n' +
    '       onto the row, the ones before it log, the write-back checks its own response, and\n' +
    '       a sent email that could not be marked is reported as the failure it is.',
);
