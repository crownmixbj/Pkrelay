/**
 * Assertions for reaching the edge functions from a browser at all.
 *
 * ⚠ The bug this guards has no symptom at the place it happens.
 *
 *   `supabase.functions.invoke` sends `content-type`, `authorization`,
 *   `apikey` and `x-client-info`. That makes the request non-simple, so the
 *   browser first sends an `OPTIONS` preflight and refuses to send the real
 *   call unless the answer permits the origin and every header named.
 *
 *   A function that answers `OPTIONS` with its method check — `405 Method not
 *   allowed`, with no CORS headers — is reported by the browser as "blocked by
 *   CORS policy". The function logs nothing, because from its side no request
 *   arrived. Supabase is healthy, the key is set, the code is correct, and the
 *   feature does not work. Address lookup shipped in exactly that state.
 *
 *   Native has no same-origin policy and never hits this, so it fails on web
 *   only — which is where the app is developed, demonstrated and deployed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fetchSuggestions, probePlacesLookup } from '../src/store/places';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

// ------------------------------------------------------- the shared module --

const shared = read('supabase/functions/_shared/cors.ts');

/*
 * ⚠ All four headers, because a preflight is refused if any one is missing.
 *
 *   `erase-auth-user` had CORS and was broken anyway: it allowed
 *   `authorization, content-type` and supabase-js also sends `apikey` and
 *   `x-client-info`. A partial list fails identically to no list, which is why
 *   this is asserted as the full set rather than as "has some CORS".
 */
for (const header of ['authorization', 'x-client-info', 'apikey', 'content-type']) {
  check(
    `the preflight allows ${header}`,
    new RegExp(`Access-Control-Allow-Headers'?\\s*:\\s*'[^']*\\b${header}\\b`).test(shared),
    'supabase-js sends this on every call, and one unlisted header refuses the whole preflight',
  );
}

check(
  'and the preflight is answered rather than refused',
  /request\.method !== 'OPTIONS'\) return null;[\s\S]{0,120}new Response\('ok', \{ headers: CORS \}\)/.test(
    shared,
  ),
  'answering OPTIONS with a 405 is what produced "blocked by CORS policy"',
);

// ------------------------------- every function a browser calls has it ----

/*
 * ⚠ Named, and split by who calls them.
 *
 *   `notify-offer` and `notify-application` are invoked by database triggers
 *   through pg_net, which is not a browser and has no preflight. Requiring
 *   CORS of them would be cargo-cult; requiring it of the other four is the
 *   whole point. If one of the notifiers ever gains a client caller, it moves
 *   lists — deliberately, rather than by having been covered all along.
 */
const BROWSER_CALLED = [
  'places-lookup',
  'verify-identity',
  'verify-liveness',
  'erase-auth-user',
] as const;

for (const name of BROWSER_CALLED) {
  const source = read(`supabase/functions/${name}/index.ts`);

  check(
    `${name} imports the shared CORS helpers`,
    source.includes("from '../_shared/cors.ts'"),
    'a second copy of these headers is a second one to get wrong',
  );

  const preflightAt = source.indexOf('preflight(request)');
  const methodCheckAt = source.search(/request\.method !== 'POST'/);

  check(`${name} answers the preflight`, preflightAt >= 0);
  /*
   * ⚠ Order, not just presence.
   *
   *   `preflight()` after the method check is dead code: the 405 returns
   *   first, and the browser never gets its headers. This is the exact shape
   *   the bug had.
   */
  check(
    `${name} answers it before refusing the method`,
    preflightAt >= 0 && (methodCheckAt < 0 || preflightAt < methodCheckAt),
    'a preflight that reaches the POST-only check is answered with a 405 and blocked',
  );

  /*
   * Every response has to carry the headers, not only the preflight. A browser
   * that is allowed to *ask* but not to *read the answer* fails just as hard,
   * and one hand-rolled `new Response(JSON.stringify(...))` is enough to do it.
   */
  check(
    `${name} returns every response through the shared json()`,
    !/new Response\(JSON\.stringify/.test(source),
    'a response built by hand carries no CORS headers, and the browser discards it unread',
  );
}

// ------------------------------------------- and the app stops asking ----

/*
 * ⚠ A count, which is the only way to state this honestly.
 *
 *   With lookup broken, every keystroke in every address field fired its own
 *   request — a screenful of red in the console, a delay on each character
 *   while the failure round-trips, and somebody else's mobile data. The field
 *   behaved correctly throughout, which is what made it easy to miss.
 */
const setAnswer = (answer: () => unknown) => {
  (globalThis as Record<string, unknown>).__answer = answer;
};

const HEALTHY = () => ({ data: { configured: true, suggestions: [] }, error: null });

const invoked = () => ((globalThis as Record<string, unknown>).__invokes as unknown[]).length;

/*
 * ⚠ A controllable clock, because the contract is stated in time.
 *
 *   The breaker short-circuits *before* calling, so a healthy endpoint cannot
 *   announce itself during the cooldown — nothing asks it. My first test
 *   assumed one success would reopen it and failed against correct code; the
 *   real guarantee is "it tries again after the cooldown", and the only honest
 *   way to assert that is to move the clock.
 */
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const COOLDOWN_MS = 60_000;

async function requestsFor(keystrokes: number): Promise<number> {
  (globalThis as Record<string, unknown>).__invokes = [];
  for (let i = 0; i < keystrokes; i += 1) {
    await fetchSuggestions(`ikeja road ${i}`, 'session');
  }
  return invoked();
}

/** Types `keystrokes` characters against a broken lookup, from a clean start. */
async function requestsWhileBroken(answer: () => unknown, keystrokes: number): Promise<number> {
  /*
   * Past any cooldown a previous case left running. Without this the second
   * and third failure cases record zero requests and the first case's stale
   * reason — the test leaking state, which is what happened first time.
   */
  clockOffset += COOLDOWN_MS + 1_000;
  setAnswer(answer);
  return requestsFor(keystrokes);
}

/*
 * ⚠ Wrapped in a runner because these assertions are asynchronous.
 *
 *   esbuild targets CommonJS here, which has no top-level await. The exit
 *   code still has to reflect the failures, so the summary runs inside.
 */
async function run() {
  /* A healthy lookup asks every time — the breaker must not suppress real work. */
  setAnswer(() => ({ data: { configured: true, suggestions: [] }, error: null }));
  check(
    'a working lookup is asked on every keystroke',
    (await requestsFor(15)) === 15,
    'the cooldown must not throttle a lookup that is answering',
  );

  for (const [name, answer] of [
    ['the function is not deployed', () => ({ data: null, error: { message: 'Failed to fetch' } })],
    ['the key is not set', () => ({ data: { configured: false }, error: null })],
    ['Google refused', () => ({ data: { error: 'OVER_QUERY_LIMIT' }, error: null })],
  ] as const) {
    /* One request to discover it, and none after. */
    const asked = await requestsWhileBroken(answer, 15);
    check(
      `when ${name}, fifteen keystrokes cost one request`,
      asked === 1,
      `${asked} requests — a broken lookup must be discovered once, not once per character`,
    );
  }

  /*
   * ⚠ It reopens, or deploying the fix would need a reload.
   *
   *   A breaker that latched for the session would be tidier to write and
   *   would mean somebody who deploys `places-lookup` sees no change until
   *   they reload the page — and would reasonably conclude the deploy failed.
   */
  await requestsWhileBroken(() => ({ data: null, error: { message: 'Failed to fetch' } }), 3);
  setAnswer(HEALTHY);
  (globalThis as Record<string, unknown>).__invokes = [];
  const duringCooldown = await fetchSuggestions('ikeja', 'session');
  check(
    'a tripped breaker asks nothing until the cooldown ends',
    invoked() === 0 && duringCooldown.unavailable === 'unreachable',
    'this is the whole point — no request, and the remembered reason',
  );

  clockOffset += COOLDOWN_MS + 1_000;
  const afterCooldown = await fetchSuggestions('ikeja', 'session');
  check(
    'and tries again once it does',
    invoked() === 1 && afterCooldown.unavailable === null,
    'a breaker that never reopens makes a successful deploy look like a failed one',
  );

  /*
   * ⚠ And the field is told the same thing it would have been told anyway.
   *
   *   A breaker that silenced the reason would leave the field showing "start
   *   typing" forever, which is worse than the storm it replaced.
   */
  await requestsWhileBroken(() => ({ data: { configured: false }, error: null }), 1);
  const suppressed = await fetchSuggestions('ikeja road', 'session');
  check(
    'a suppressed request still reports why lookup is unavailable',
    suppressed.unavailable === 'not-configured',
    `got ${suppressed.unavailable} — the field has to say which of the three it is`,
  );

  /*
   * ⚠ The diagnostics panel must see through it.
   *
   *   The Build-and-schema panel exists to answer "is this deployed". If the
   *   breaker answered on its behalf it would report a remembered outage as a
   *   current one, and somebody would redeploy a function that was already fine.
   */
  setAnswer(() => ({ data: { configured: true, suggestions: [] }, error: null }));
  (globalThis as Record<string, unknown>).__invokes = [];
  const probed = await probePlacesLookup();
  check(
    'the deployment probe ignores the cooldown',
    ((globalThis as Record<string, unknown>).__invokes as unknown[]).length === 1 &&
      probed === null,
    'a panel that reports a remembered failure sends somebody to redeploy a healthy function',
  );

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }

  console.log(
    'PASS — every browser-called function answers the preflight before refusing the method,\n' +
      '       permits all four headers supabase-js sends, and returns every response with CORS\n' +
      '       headers attached; a broken lookup costs one request rather than one per\n' +
      '       keystroke, still says why, and the deployment probe sees past the cooldown.',
  );
}

void run();
