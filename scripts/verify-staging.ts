/**
 * Assertions for the staging environment guard.
 *
 * ⚠ What this file is defending.
 *
 *   Staging has its own Supabase project, so nothing it writes can reach
 *   production data. That is the easy half and it is already true by the time
 *   anyone reads this. The half that is not automatic is everything the edge
 *   functions reach *outward* to — Resend, Dojah, Slack — none of which know or
 *   care which database the row came from. A staging deployment with a real
 *   Resend key emails real drivers. A staging deployment with a production
 *   Dojah secret spends the real wallet, one parcel at a time.
 *
 *   `_shared/environment.ts` is the single place that decides those three
 *   questions. This file asserts the decision is correct and, more importantly,
 *   that every call site still routes through it — because the failure that
 *   actually happens is not a wrong answer here, it is a ninth email template
 *   added next month that calls Resend directly and never asks.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  readEnvironment,
  resolveRecipient,
  slackEnabled,
} from '../supabase/functions/_shared/environment.ts';
import { readCredentials } from '../supabase/functions/verify-liveness/dojah.ts';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const STAGING = { LOCI_ENVIRONMENT: 'staging' };
const PROD = {};

// ------------------------------------------------------ which environment ---

check('an unset LOCI_ENVIRONMENT means production', readEnvironment(PROD) === 'production');
check('"staging" means staging', readEnvironment(STAGING) === 'staging');
check(
  'and the comparison is not case- or whitespace-sensitive',
  readEnvironment({ LOCI_ENVIRONMENT: '  Staging ' }) === 'staging',
  'a value pasted from a dashboard field arrives with whatever the dashboard put around it',
);
check(
  'an unrecognised value is production, not staging',
  readEnvironment({ LOCI_ENVIRONMENT: 'stagng' }) === 'production',
  'a typo must not silently disable the guards on a production deployment',
);

// ------------------------------------------------------------------ email ---

check(
  'production returns the address untouched',
  resolveRecipient('driver@example.com', PROD)?.to === 'driver@example.com',
);
check(
  'and adds no subject prefix',
  resolveRecipient('driver@example.com', PROD)?.subjectPrefix === '',
  'a "[STAGING]" on a production email is its own incident',
);
check(
  'staging with no test inbox refuses to send',
  resolveRecipient('driver@example.com', STAGING) === null,
  'the alternative is a real applicant receiving a confirmation generated from test rows',
);

const redirected = resolveRecipient('driver@example.com', {
  LOCI_ENVIRONMENT: 'staging',
  LOCI_STAGING_EMAIL: 'qa@loci.test',
});
check('staging with a test inbox redirects there', redirected?.to === 'qa@loci.test');
check(
  'and the intended recipient survives in the subject',
  redirected?.subjectPrefix.includes('driver@example.com') === true,
  'eight templates land in one inbox; without this you cannot tell them apart',
);

// ------------------------------------------------------------------ slack ---

check(
  'production posts when a webhook is set',
  slackEnabled('https://hooks.slack.com/services/x', PROD),
);
check('production skips when it is not', !slackEnabled(null, PROD));
check(
  'staging never posts, webhook or not',
  !slackEnabled('https://hooks.slack.com/services/x', STAGING),
  'a webhook copied into the staging project by accident must stay inert',
);

// ------------------------------------------------------------------ dojah ---

const dojah = (env: Record<string, string | undefined>) =>
  readCredentials({ DOJAH_APP_ID: 'id', DOJAH_SECRET_KEY: 'secret', ...env });

check('sandbox is the default', dojah({})?.environment === 'sandbox');
check(
  'production can opt in to the live endpoint',
  dojah({ DOJAH_ENVIRONMENT: 'production' })?.environment === 'production',
);
check(
  'staging cannot, even asking for it explicitly',
  dojah({ DOJAH_ENVIRONMENT: 'production', LOCI_ENVIRONMENT: 'staging' })?.environment === 'sandbox',
  'this is the assertion that stops a production Dojah secret spending the real wallet from staging',
);
check(
  'and missing credentials are still null rather than a fabricated sandbox login',
  readCredentials({ LOCI_ENVIRONMENT: 'staging' }) === null,
  'unavailable has to stay distinguishable from checked-and-passed',
);

// ------------------------------------------- every call site asks the guard --

/*
 * The source-level half.
 *
 * Everything above proves the guard answers correctly. These prove it is still
 * being consulted — the failure mode that actually ships is a new call site,
 * not a wrong answer.
 */
const sharedEmail = code(read('supabase/functions/_shared/email.ts'));
check(
  'the shared sender resolves the recipient before calling Resend',
  sharedEmail.includes('resolveRecipient(input.to, input.env)') &&
    sharedEmail.includes('to: [destination.to]'),
  'this is the chokepoint for every notify-events template, present and future',
);
check(
  'and it never sends to the raw address',
  !/to: \[input\.to\]/.test(sharedEmail),
  'one line reverted here re-enables mail to real users from staging',
);

const application = code(read('supabase/functions/notify-application/index.ts'));
check(
  'the applicant confirmation resolves the recipient too',
  application.includes('resolveRecipient(to, {') && application.includes('destination.to'),
  'it has its own Resend call rather than going through _shared/email.ts',
);
check(
  'and the Slack alert asks slackEnabled rather than only checking the webhook',
  application.includes('slackEnabled(webhook,'),
  '',
);

/*
 * ⚠ Nothing may add a third way to reach Resend.
 *
 *   Two call sites is already one more than ideal — both are guarded, and both
 *   are asserted above. A third would be guarded by nobody, so it fails here
 *   until it is either routed through `_shared/email.ts` or added to the list.
 */
const functionsWithResend = ['_shared/email.ts', 'notify-application/index.ts'];
const allFunctionFiles = (() => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, 'supabase/functions', dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (rel.endsWith('.ts')) out.push(rel);
    }
  };
  walk('');
  return out;
})();

const unexpected = allFunctionFiles.filter(
  (rel) => read(`supabase/functions/${rel}`).includes('api.resend.com') && !functionsWithResend.includes(rel),
);
check(
  'no unguarded Resend call site',
  unexpected.length === 0,
  unexpected.length ? `${unexpected.join(', ')} calls Resend without the staging guard` : '',
);

// ---------------------------------------- the guard is server-side only -----

/*
 * ⚠ This must never become an EXPO_PUBLIC_ variable.
 *
 *   Anything with that prefix is compiled into the app bundle, which means a
 *   tester — or anybody who installs the APK — can change it. A guard that the
 *   attacker sets is not a guard. The environment is a server-side secret on
 *   the Supabase project, and the client is never told which one it is talking
 *   to beyond the build channel already stamped into it.
 */
for (const path of ['eas.json', '.env.example']) {
  check(
    `${path} carries no EXPO_PUBLIC_LOCI_ENVIRONMENT`,
    !/EXPO_PUBLIC_LOCI_ENVIRONMENT/.test(read(path)),
    'the client cannot be trusted to say which environment it is in',
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('staging guard: all assertions passed');
