/**
 * Assertions for cookie consent.
 *
 * Every check here is a rule somebody has been fined over, or a failure mode
 * that reads as permission:
 *
 *   - A parse bug that returns "allowed" for a value it could not understand.
 *   - A category added later that an old stored "yes" silently covers.
 *   - Refusing taking more effort than accepting — the CNIL cases against
 *     Google and Meta in 2022 turned on exactly this.
 *   - Consent that cannot be withdrawn, which makes the first "yes" permanent.
 *   - Reading localStorage during render, which throws in the static render
 *     pass this app does on every route.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * ⚠ A browser has to exist before `@/lib/consent` is first called.
 *
 *   Not before it is *imported* — `consentApplies()` re-tests on every call by
 *   design — but the assertions below are meaningless without one, so the fake
 *   goes in at the top of the file where the ordering is obvious.
 */
type Store = Record<string, string>;
let store: Store = {};
let throwOnWrite = false;

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      if (throwOnWrite) throw new Error('QuotaExceededError');
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  },
};

import {
  CONSENT_MAX_AGE_DAYS,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  acceptAll,
  clearConsent,
  consentApplies,
  currentConsent,
  essentialOnly,
  hasAnswerFor,
  isAllowed,
  loadConsent,
  parseConsent,
  saveConsent,
  shouldAsk,
  whenAllowed,
} from '../src/lib/consent';

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
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const banner = read('src/components/ui/cookie-banner.tsx');
const bannerCode = code(banner);
const consentSource = code(read('src/lib/consent.ts'));
const footer = code(read('src/components/Footer.tsx'));
const layout = code(read('src/app/_layout.tsx'));

const reset = () => {
  store = {};
  throwOnWrite = false;
  clearConsent();
};

const write = (value: unknown) => {
  store[CONSENT_STORAGE_KEY] = typeof value === 'string' ? value : JSON.stringify(value);
};

const record = (over: Record<string, unknown> = {}) => ({
  version: CONSENT_VERSION,
  decidedAt: new Date('2026-09-01T00:00:00Z').toISOString(),
  choices: { essential: true, analytics: false },
  ...over,
});

const NOW = new Date('2026-09-12T00:00:00Z');

// ----------------------------------------------- 1. nothing is on by default --

reset();
check('the harness is running as a browser', consentApplies());
check(
  'essential is the only thing on before anyone answers',
  essentialOnly().essential === true && essentialOnly().analytics === false,
);
check(
  'and the gate says no to analytics with no answer on file',
  isAllowed('analytics') === false,
  'an unanswered question is a refusal, not a default yes',
);
check('while essential never needs asking', isAllowed('essential') === true);
check(
  'accept-all turns on what is actually live, not every id ever declared',
  acceptAll().analytics === true,
);
check(
  'no toggle anywhere defaults to true',
  !/useState\(\s*true\s*\)/.test(bannerCode) && !bannerCode.includes('defaultChecked'),
  'a pre-ticked box is not consent (GDPR Recital 32)',
);

// -------------------------------------------------- 2. bad input fails safe --

for (const [label, raw] of [
  ['nothing stored', null],
  ['empty string', ''],
  ['not JSON', 'yes'],
  ['a bare string', '"accepted"'],
  ['an array', '[]'],
  ['no version', JSON.stringify({ decidedAt: NOW.toISOString(), choices: { analytics: true } })],
  ['an unparseable date', JSON.stringify(record({ decidedAt: 'soon' }))],
  ['no choices object', JSON.stringify({ version: 1, decidedAt: NOW.toISOString() })],
] as [string, string | null][]) {
  check(`${label} reads as no answer`, parseConsent(raw) === null);
  check(`${label} asks again`, shouldAsk(raw, NOW) === true);
}

check(
  'a non-boolean choice is not treated as a yes',
  parseConsent(JSON.stringify(record({ choices: { essential: true, analytics: 'yes' } })))
    ?.choices.analytics === false,
  "'yes' is truthy in JavaScript, which is exactly how this goes wrong",
);

// ------------------------------------------- 3. an old yes covers only what --
//                                                 it was actually given for

check(
  'a record missing a live category is incomplete',
  hasAnswerFor(JSON.stringify(record({ choices: { essential: true } }))) === false,
  'a category added after the answer was given was never consented to',
);
check(
  'so it asks again',
  shouldAsk(JSON.stringify(record({ choices: { essential: true } })), NOW) === true,
);
check(
  'a version bump asks again',
  shouldAsk(JSON.stringify(record({ version: CONSENT_VERSION + 1 })), NOW) === true,
);
check(
  'a complete, current answer does not',
  shouldAsk(JSON.stringify(record()), NOW) === false,
);

// ------------------------------------------------------------ 4. it expires --

const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

check(
  'an answer inside the window stands',
  shouldAsk(JSON.stringify(record({ decidedAt: daysAgo(CONSENT_MAX_AGE_DAYS - 1) })), NOW) === false,
);
check(
  'an answer past it is asked again',
  shouldAsk(JSON.stringify(record({ decidedAt: daysAgo(CONSENT_MAX_AGE_DAYS + 1) })), NOW) === true,
  'consent given once is not consent forever',
);
check(
  'a future timestamp is stale, not fresh',
  shouldAsk(JSON.stringify(record({ decidedAt: daysAgo(-30) })), NOW) === true,
  'a clock set forward would otherwise never be re-asked',
);

// ------------------------------------------------ 5. saving, and the gate ---

reset();
saveConsent({ essential: true, analytics: true });
check('a yes is remembered', isAllowed('analytics') === true);
check('and written under the agreed key', typeof store[CONSENT_STORAGE_KEY] === 'string');

const saved = JSON.parse(store[CONSENT_STORAGE_KEY]);
check('with a timestamp', typeof saved.decidedAt === 'string' && !Number.isNaN(Date.parse(saved.decidedAt)));
check('and the version it was given under', saved.version === CONSENT_VERSION);

reset();
write(record({ choices: { essential: true, analytics: true } }));
loadConsent(NOW);
check('a stored yes is honoured on load', currentConsent().analytics === true);

reset();
write(record({ decidedAt: daysAgo(CONSENT_MAX_AGE_DAYS + 1), choices: { essential: true, analytics: true } }));
loadConsent(NOW);
check(
  'an expired yes is not honoured while it is being re-asked',
  currentConsent().analytics === false,
  'the banner is up again, so tracking must already have stopped',
);

// ------------------------------------------------- 6. withdrawal works now --

reset();
const events: string[] = [];
const stop = whenAllowed('analytics', () => events.push('grant'), () => events.push('revoke'));
check('nothing loads before consent', events.length === 0);

saveConsent({ essential: true, analytics: true });
check('it loads on consent', events.join() === 'grant');

saveConsent({ essential: true, analytics: false });
check(
  'and unloads on withdrawal, immediately',
  events.join() === 'grant,revoke',
  'GDPR Art. 7(3) — withdrawing has to be as effective as giving, not effective next page load',
);

saveConsent({ essential: true, analytics: true });
clearConsent();
check('clearing consent also revokes', events.join() === 'grant,revoke,grant,revoke');

stop();
saveConsent({ essential: true, analytics: true });
check('an unsubscribed gate stops reacting', events.join() === 'grant,revoke,grant,revoke');

// ----------------------------------------- 7. storage refusing is not a yes --

reset();
const blocked: string[] = [];
const stopBlocked = whenAllowed('analytics', () => blocked.push('grant'), () => blocked.push('revoke'));
throwOnWrite = true;
const ok = saveConsent({ essential: true, analytics: true });
check('a refused write is reported', ok === false, 'so the banner can say so rather than just vanishing');
check(
  'but the choice still governs this page view',
  blocked.join() === 'grant',
  'a person who said yes should not have to say it twice in one visit',
);
check(
  'and the banner tells them it could not be saved',
  bannerCode.includes('setWriteFailed(true)') && banner.includes('asked again next time'),
);
stopBlocked();
reset();

// --------------------------------------- 8. refusing is as easy as accepting --

check(
  'accept and reject are the same size',
  /label="Accept all"[\s\S]{0,200}size="md"/.test(banner) &&
    /label="Essential only"[\s\S]{0,200}size="md"/.test(banner),
);
check(
  'and share one row, each taking equal width',
  /styles\.choices/.test(bannerCode) && /action: \{\s*flex: 1,/.test(banner),
  'CNIL fined Google and Meta over refusal being harder than acceptance, not over the wording',
);
check(
  'both are solid controls, not one button and one text link',
  /label="Essential only"[\s\S]{0,200}variant="secondary"/.test(banner),
);
check(
  'and both are one tap from the banner',
  (bannerCode.match(/commit\(acceptAll\(\)\)/g) ?? []).length >= 1 &&
    (bannerCode.match(/commit\(essentialOnly\(\)\)/g) ?? []).length >= 1,
);
check(
  'closing the preferences panel grants nothing',
  bannerCode.includes("onRequestClose={() => setMode('banner')}"),
  'dismissal is not consent (EDPB Guidelines 05/2020)',
);

// ------------------------------------------------- 9. it can be reopened ----

check(
  'the footer offers a way back',
  footer.includes('openCookiePreferences') && footer.includes('cookiePreferencesAvailable'),
  'without this, "Accept all" is a one-way door and the implementation does not comply',
);
check(
  'reopening starts from what was actually chosen',
  bannerCode.includes('setDraft({ ...currentConsent() })'),
  'showing everything off would read as their answer having been thrown away',
);

// ------------------------------------------ 10. it survives the static render --

check(
  'the banner reads storage only inside an effect',
  !/^(?!.*useEffect)[\s\S]*?window\.localStorage/.test(
    bannerCode.slice(0, bannerCode.indexOf('useEffect')),
  ),
  'web.output is "static", so every route renders in Node first — a read during render throws there',
);
check(
  'it starts hidden and decides afterwards',
  bannerCode.includes("useState<Mode>('hidden')"),
  'anything else is a hydration mismatch, and a flash of the banner for someone who already answered',
);
check(
  'every storage access is wrapped',
  (consentSource.match(/try \{/g) ?? []).length >= 4,
  'localStorage throws in Safari private mode and when storage is disabled by policy',
);
check(
  'the module does nothing at import time',
  !/^(?!.*=>)[\s\S]*?window\.localStorage\.getItem/.test(consentSource.split('function readRaw')[0]),
);

// ---------------------------------------------------- 11. it is mounted -----

check('the root layout renders it', layout.includes('<CookieBanner />'));
check(
  'globally, outside the navigator',
  layout.indexOf('<CookieBanner />') > layout.indexOf('</Stack>'),
  'a banner inside the Stack would unmount on navigation',
);

// ------------------------------------- 12. the static render, for real ----

/*
 * ⚠ Not a source assertion — the module is actually called with no `window`.
 *
 *   This is the pass that broke `lib/supabase.ts`: Expo Router renders every
 *   route in Node before it reaches a browser, and a `window` reference there
 *   does not degrade, it throws inside the render and takes the dev server
 *   down. Reading the code and concluding it is safe is what everybody does
 *   right before shipping the thing that is not.
 */
reset();
delete (globalThis as { window?: unknown }).window;

try {
  check('consent does not apply with no browser', consentApplies() === false);
  check('the gate refuses rather than throwing', isAllowed('analytics') === false);
  check('essential is still allowed', isAllowed('essential') === true);
  check('loading is a no-op that returns the safe default', loadConsent().analytics === false);
  check('saving does not throw', saveConsent({ essential: true, analytics: true }) === false);
  check('clearing does not throw', (clearConsent(), true));
  check('and shouldAsk answers without a browser', typeof shouldAsk(null) === 'boolean');
  check('a gate registered server-side grants nothing', (() => {
    const seen: string[] = [];
    whenAllowed('analytics', () => seen.push('grant'))();
    return seen.length === 0;
  })());
} catch (error) {
  failures += 1;
  console.error(`FAIL — the module threw during a server render\n       ${String(error)}`);
}

// -------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('verify:consent — all checks passed');
