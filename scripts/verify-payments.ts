/**
 * Assertions for the money.
 *
 * ⚠ Three of these are the difference between a payment gate and a decoration,
 *   and none of them has a symptom you would notice in a demo.
 *
 *   1. The webhook signature. It is the only thing standing between an
 *      unauthenticated public endpoint and anybody who can spell its URL. A
 *      check that always returns true looks exactly like a working one until
 *      somebody posts `{"event":"charge.success"}` at it.
 *   2. The staging guard. Staging shares this repository, these functions and
 *      this secret store with production. A live key pasted into the staging
 *      project charges real cards for test parcels, and nothing on screen
 *      would say so.
 *   3. Kobo. A fare sent in naira charges one hundredth of the fare, and every
 *      test transaction succeeds.
 *
 * Run with `npm run verify:payments`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  callbackUrl,
  formatKobo,
  nairaToKobo,
  paymentReference,
  readPaystackConfig,
  verifyWebhookSignature,
} from '../supabase/functions/_shared/paystack.ts';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

// ------------------------------------------------------------ the minor unit --

check('a ₦2,800 fare is 280000 kobo', nairaToKobo(2800) === 280000);
check(
  'and a fraction of a kobo is rounded, not truncated',
  nairaToKobo(28.005) === 2801,
  'Math.trunc here loses a kobo per transaction, which reconciliation notices and nobody can explain',
);
check('kobo formats back as naira', formatKobo(280000).includes('2,800'));

// -------------------------------------------------------------- the key guard --

{
  const missing = readPaystackConfig({});
  check('no key is a refusal', missing.ok === false);

  const nonsense = readPaystackConfig({ PAYSTACK_SECRET_KEY: 'hunter2' });
  check(
    'a value that is not a Paystack key is a refusal',
    nonsense.ok === false,
    'an anon key or a public key pasted into the secret would otherwise reach the API and 401',
  );

  const publicKey = readPaystackConfig({ PAYSTACK_SECRET_KEY: 'pk_test_abc123' });
  check(
    'and so is the *public* key, which is the easy one to paste',
    publicKey.ok === false,
    'pk_ and sk_ differ by one character and only one of them can verify a transaction',
  );

  const live = readPaystackConfig({ PAYSTACK_SECRET_KEY: 'sk_live_abc123' });
  check('a live key is accepted on production', live.ok === true);
  check(
    'and reports itself as live',
    live.ok === true && live.config.mode === 'live',
    'the mode is read from the key rather than configured separately, so the two cannot disagree',
  );

  const liveOnStaging = readPaystackConfig({
    PAYSTACK_SECRET_KEY: 'sk_live_abc123',
    LOCI_ENVIRONMENT: 'staging',
  });
  check(
    'but a live key on staging is refused outright',
    liveOnStaging.ok === false,
    'staging shares this repo and these functions with production — the only thing stopping a\n' +
      '       production secret reaching it is this check. A test parcel would take real money.',
  );

  const testOnStaging = readPaystackConfig({
    PAYSTACK_SECRET_KEY: 'sk_test_abc123',
    LOCI_ENVIRONMENT: 'staging',
  });
  check('while a test key on staging is fine', testOnStaging.ok === true);
}

// ------------------------------------------------------------- the reference --

{
  const a = paymentReference();
  const b = paymentReference();

  check('a reference is prefixed for the dashboard', a.startsWith('pkr_'));
  check('and two are never the same', a !== b);
  check(
    'and it is long enough not to be guessed',
    a.length >= 24,
    'references travel in redirect URLs; a short or sequential one lets somebody enumerate charges',
  );
}

// -------------------------------------------------------------- the callback --

{
  check(
    'the callback is built from the configured origin',
    callbackUrl({ LOCI_APP_URL: 'https://staging.pkrelay.com' }, 'pkr_1') ===
      'https://staging.pkrelay.com/payment-return?reference=pkr_1',
  );
  check(
    'a trailing slash does not double up',
    callbackUrl({ LOCI_APP_URL: 'https://pkrelay.com/' }, 'pkr_1').includes('.com/payment-return'),
  );
  check(
    'and with no origin configured there is no callback rather than a wrong one',
    callbackUrl({}, 'pkr_1') === '',
    'a relative or invented callback silently drops the sender somewhere that is not this app',
  );

  const initialize = read('supabase/functions/payments-initialize/index.ts');
  check(
    'and the function never takes a callback from the request',
    !/callback_url\s*[:=]\s*(body|request)/.test(initialize),
    'a caller-supplied callback is an open redirect with a payment attached',
  );
}

// --------------------------------------------------------- the webhook signature --

{
  /* Paystack's own scheme: HMAC-SHA512 of the raw body, keyed on the secret. */
  const secret = 'sk_test_thisisnotarealkey';
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'pkr_1' } });

  const sign = async (key: string, text: string) => {
    const imported = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['sign'],
    );
    const digest = await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  };

  const good = await sign(secret, body);

  check('a correctly signed body is accepted', await verifyWebhookSignature(secret, body, good));
  check(
    'an unsigned body is refused',
    !(await verifyWebhookSignature(secret, body, '')),
    'this endpoint has no JWT: an empty signature passing means anybody can settle any parcel',
  );
  check(
    'a body signed with a different key is refused',
    !(await verifyWebhookSignature(secret, body, await sign('sk_test_wrong', body))),
  );
  check(
    'and a signature that does not match its body is refused',
    !(await verifyWebhookSignature(secret, `${body} `, good)),
    'one byte of difference must fail, or the signature is checking nothing about the payload',
  );
  check(
    'the digest is compared case-insensitively',
    await verifyWebhookSignature(secret, body, good.toUpperCase()),
    'a provider that sends upper-case hex would be rejected forever, and the logs would read\n' +
      '       as a sustained forgery attempt',
  );
}

// ------------------------------------------------- what the webhook must not do --

{
  const webhook = read('supabase/functions/payments-webhook/index.ts');

  check(
    'the webhook reads the raw body before parsing it',
    webhook.indexOf('request.text()') >= 0 &&
      webhook.indexOf('request.text()') < webhook.indexOf('JSON.parse'),
    'the digest is over bytes: parsing first and re-serialising produces a check that fails 100%\n' +
      '       of the time, which in a log is indistinguishable from an attack',
  );

  check(
    'the signature is checked before anything is acted on',
    webhook.indexOf('verifyWebhookSignature') < webhook.indexOf('settle_parcel_payment'),
  );

  check(
    'and a signed body is still verified against the API',
    webhook.includes('verifyTransaction'),
    'a replayed body carries a genuinely valid old signature — the signature decides whether to\n' +
      '       look, the API decides what is true',
  );

  check(
    'the webhook does not answer with wildcard CORS',
    !webhook.includes("from '../_shared/cors.ts'"),
    'no browser calls this endpoint; allowing every origin on an unauthenticated endpoint invites\n' +
      '       any page on the internet to POST to it and read the reply',
  );

  check(
    'and it says out loud that it deploys without jwt verification',
    webhook.includes('--no-verify-jwt'),
    'deployed with jwt verification, Paystack is refused at the gateway, this function logs\n' +
      '       nothing, and every payment sits pending until somebody notices',
  );
}

// ------------------------------------------- the client is not trusted with any of it --

{
  const store = read('src/store/payments.ts');
  const sheet = read('src/components/ui/payment-sheet.tsx');
  const book = read('src/app/(tabs)/book.tsx');

  for (const [name, source] of [
    ['the payments store', store],
    ['the checkout sheet', sheet],
    ['the booking form', book],
  ] as const) {
    check(
      `${name} holds no Paystack key`,
      !/\b[ps]k_(test|live)_/.test(source),
      'even the public key belongs server-side here: the whole transaction is initialized by an\n' +
        '       edge function so the amount is never something the client can state',
    );
  }

  check(
    'the client never sends an amount',
    !/amount(_kobo)?\s*:/.test(store.split('export async function initializeParcelPayment')[1] ?? ''),
    'an amount in the request body is an amount the sender chooses',
  );

  check(
    'and never concludes a payment succeeded on its own',
    store.includes('verifyParcelPayment') && !/status\s*=\s*['"]success['"]/.test(sheet),
    'the sheet reports how the checkout closed; only the server says whether it was paid',
  );

  check(
    "an inconclusive verification is its own outcome, not a failure",
    store.includes("'unknown'"),
    'reporting "payment failed" one second before the webhook settles it is how somebody pays twice',
  );
}

// ---------------------------------------------------------------- the migration --

{
  const migration = read('supabase/migrations/20250101000056_parcel_payments.sql');

  /*
   * ⚠ The six guards of "sender creates own", counted.
   *
   *   09 left the warning and 42, 44 and 48 each carried it forward: recreating
   *   this policy with only the new condition quietly drops the others. This is
   *   the sixth rewrite, and an assertion is cheaper than the fifth reading of
   *   the diff.
   */
  const policy = migration.split('create policy "sender creates own"')[1]?.split(');')[0] ?? '';

  for (const guard of [
    'sender_id = (select auth.uid())',
    'driver_id is null',
    'driver is null',
    "status = 'Booked'",
    'not public.is_erased()',
    'public.is_verified_sender()',
    'sender_photo_path is not null',
    "payment_status = 'pending'",
  ]) {
    check(
      `the insert policy still requires: ${guard}`,
      policy.includes(guard),
      'a guard dropped in a rewrite is a parcel posted pre-assigned, unverified, or with no selfie',
    );
  }

  check(
    'the column is added paid and only then defaults to pending',
    migration.indexOf("add column if not exists payment_status text not null default 'paid'") <
      migration.indexOf("alter column payment_status set default 'pending'"),
    'the other order marks every live parcel unpaid in one statement and empties the driver board',
  );

  check(
    'the payment guard is not security definer',
    !/create or replace function public\.bookings_guard_payment\(\)[\s\S]{0,200}security definer/.test(
      migration,
    ),
    "current_user inside a definer function is always the owner, so the guard would never fire",
  );

  check(
    'and dispatch on payment fires on the transition, not on the value',
    /old\.payment_status = 'pending'[\s\S]{0,120}new\.payment_status <> 'pending'/.test(migration),
    'firing on the value re-dispatches on every later edit of a paid parcel',
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

console.log('payments wiring holds.\n');
