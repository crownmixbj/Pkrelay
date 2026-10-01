# Parcel payments

How a sender's fare is collected, what stops a parcel moving before it is, and
what you have to set up per project.

Provider: **Paystack**. Nigeria-only app, naira-only fares, and its hosted
checkout works in a WebView and a browser without a native SDK. The gateway is
reached from three edge functions and from nowhere else; swapping to
Flutterwave means rewriting `supabase/functions/_shared/paystack.ts` and
nothing above it.

---

## The shape of it

```
book.tsx                   the parcel is inserted — payment_status 'pending'
  │                        invisible to drivers, not dispatched
  ├─► payments-initialize   reads the fare from the row, opens an attempt,
  │                         asks Paystack for a checkout URL
  ├─► PaymentSheet          native: WebView on that URL
  │                         web:    full navigation to it
  │
  │   ┌── Paystack ───────────────────────────────────────────┐
  │   │  the sender types a card number into Paystack's page  │
  │   └──────────────────────────────────────────────────────┘
  │
  ├─► payments-webhook      Paystack → us, signed, server to server.
  │                         THE authority. Arrives whether or not the
  │                         sender's browser came back.
  └─► payments-verify       the sender's browser came back. The fast path,
                            so nobody watches a spinner waiting for a webhook.

both call settle_parcel_payment(), which is idempotent
  → parcel_payments.status = 'success'
  → bookings.payment_status = 'paid'
  → AFTER UPDATE triggers, in name order:
      bookings_dispatch_on_payment  → dispatch_booking()      — once
      bookings_email_on_payment     → queue_email(...)        — once
                                       → on_email_queued → notify-events → Resend
                                       → missed one? loci-unsent-emails sweeps it
```

The sender lands on `/my-packages?section=active`, where the parcel is already
in the list because the store is refreshed before the navigation.

## What actually stops an unpaid parcel

Four things, and each one is load-bearing. `scripts/pg/payments-harness.mjs`
breaks each in turn and asserts that the failure shows.

1. **The insert policy** — `sender creates own` requires
   `payment_status = 'pending'`. A parcel may only be born unpaid.
2. **`bookings_guard_payment`** — a BEFORE UPDATE trigger that refuses any
   change to `payment_status` or `paid_at` from `authenticated` or `anon`.
   Without it, `advance own parcel` (which lets a sender edit their own
   unassigned parcel) is enough to PATCH a parcel to paid through PostgREST and
   the gateway is never contacted. This is the one that matters most.
3. **The select policy** — an approved driver's view of the open board now ends
   `and payment_status <> 'pending'`. An unpaid parcel is not hidden from its
   own sender, who has to see what they are being asked to pay for.
4. **`dispatch_new_booking`** — returns early on a pending parcel;
   `dispatch_paid_booking` runs the matcher when the payment settles, on the
   *transition* rather than the value, so it fires exactly once.

The amount is never sent by the client. `parcel_fare_kobo` reads
`estimated_fee` off the parcel row, which `bookings_guard_immutable` (migration
01) has frozen since the insert, and `settle_parcel_payment` compares what the
gateway says was paid against what that function said was owed. An
underpayment fails the attempt and leaves the parcel unpaid.

---

## The confirmation email (57)

Paystack emails the sender itself, and that email is about a *charge*: an
amount, a card, a merchant name. It cannot name the parcel, the route or the
tracking id, so a sender who paid for two shipments in a morning gets two
near-identical messages and no way to tell them apart. `parcel_payment_received`
is the one that answers "what did I just pay for, and what happens now".

- Queued by `email_on_parcel_paid`, an AFTER UPDATE trigger on **`bookings`**,
  on the `pending → paid` transition — the same transition dispatch watches, so
  the two can never disagree about whether a parcel went live.
- **Not** on `parcel_payments`. A charge that lands on a parcel cancelled
  mid-checkout settles and is logged as a refund owed, and that sender must not
  be told their parcel is on its way. Watching the booking is what makes that
  case silent.
- Keyed on the payment **reference**, not the booking id, so a second genuine
  charge would get its own confirmation rather than being swallowed by
  `on conflict do nothing`.
- `'paid'` only. A `waived` parcel was not paid for, so "we have received your
  payment" would be false.
- Amount is divided to naira in the trigger; `amount_kobo` is the stored truth.
  The harness asserts this, because 280000 in that field emails somebody that
  they were charged ₦280,000.
- The template shows the reference in full and the *method* (`card`, `bank
  transfer`) — never a card number or a last four, which this system never
  receives.
- It is headed a confirmation, never a receipt, for the reason 38 gives about
  `delivery_completed`: Paystack issues the document with legal standing.

Delivery rides the existing outbox, so nothing new has to be deployed or
scheduled for it: `on_email_queued` posts to `notify-events` immediately, and
`loci-unsent-emails` (every 5 minutes, from 53) retries anything that missed,
three attempts then stop. If the confirmation is not arriving, that is an
outbox problem rather than a payments one — `select * from email_outbox where
kind = 'parcel_payment_received'` tells you which: no row means the trigger did
not fire, a row with `sent_at` null and `attempts` climbing means the dispatch
is misconfigured, and `error` says why.

## Setting it up

### 1. Apply the migration

```bash
supabase db push --project-ref <ref>
```

`20250101000056_parcel_payments.sql`. It adds the column as `'paid'` and only
then changes the default to `'pending'` — the parcels already in the table were
posted before any gateway existed and are live. Do not reorder those two
statements.

### 2. Secrets

```bash
supabase secrets set PAYSTACK_SECRET_KEY="sk_test_..." --project-ref <staging-ref>
supabase secrets set PAYSTACK_SECRET_KEY="sk_live_..." --project-ref <prod-ref>

# Already set for the emails; the checkout callback is built from it.
supabase secrets set LOCI_APP_URL="https://staging.pkrelay.com" --project-ref <staging-ref>
```

⚠ A `sk_live_` key on a project where `LOCI_ENVIRONMENT=staging` is **refused**
by `readPaystackConfig`, and the functions answer 503. That is deliberate:
staging shares this repository and these functions with production, and the
only thing otherwise stopping a production secret from taking real money for a
test parcel is somebody remembering.

There is no `EXPO_PUBLIC_` variable for payments, and there should never be
one. Not even the Paystack public key — the whole transaction is initialized
server-side so the amount is never something the client can state.

### 3. Deploy the functions

```bash
supabase functions deploy payments-initialize
supabase functions deploy payments-verify
supabase functions deploy payments-webhook --no-verify-jwt
```

⚠ The `--no-verify-jwt` on the third one is not optional and not a relaxation
to be tidied up later. Paystack's servers have no Supabase token. Deployed
without that flag, every webhook is refused at the gateway, the function's own
logs stay empty, and payments sit pending until somebody notices. What
protects it instead is the `x-paystack-signature` HMAC, checked over the raw
body before anything is parsed or acted on.

### 4. Point Paystack at the webhook

Dashboard → Settings → API Keys & Webhooks → **Webhook URL**:

```
https://<project-ref>.supabase.co/functions/v1/payments-webhook
```

Set it on the **test** tab for the staging project and the **live** tab for
production. They are separate fields and it is easy to set one and believe you
have set both.

### 5. Sweep abandoned attempts

`parcel_payments` has a partial unique index allowing one live attempt per
parcel, so a checkout somebody closed and never came back to would otherwise
lock them out of paying for their own parcel. `expire_parcel_payments()`
abandons anything older than an hour. Schedule it beside the other `loci-*`
jobs:

```sql
select cron.schedule(
  'loci-expire-payments', '*/15 * * * *',
  $$ select public.expire_parcel_payments() $$
);
```

---

## Testing it

Paystack's test cards are at https://paystack.com/docs/payments/test-payments.
`4084 0840 8408 4081` with any future expiry and CVV `408` succeeds;
`5060 6666 6666 6666 666` triggers the OTP path. Both only work with an
`sk_test_` key.

Locally, against the staging project:

```bash
npm run verify:payments      # the module logic and what the functions must not do
npm run verify:pg-payments   # the gate, against real Postgres, under RLS
```

The second one applies the entire migration chain and then breaks the guards to
prove the assertions notice. It is the one to run after touching any policy on
`bookings`.

## Seeing it: /admin-finance

Migration 58 adds the operator's view, as two tabs on one screen.

**Inbound** lists every charge with its reference, the parcel it paid for, the
payer's name and the method — searchable by reference or tracking id, because
those are the two things somebody arrives holding. The tile worth watching is
**Refunds owed**: a charge that settled against a parcel cancelled mid-checkout.
Nothing in Package Relay refunds one, so that tile is the only place they
surface; issue the refund in Paystack against the reference shown.

**Outbound** is one row per driver — deliveries, fares, our fee, paid out, on
hold, available — in four states:

| State | Means |
| --- | --- |
| Pending | They asked to be paid; somebody has to make the transfer |
| Ready | No request, and their balance has cleared the hold and the minimum |
| Holding | Owed something, but too new or too small to withdraw |
| Paid | Everything earned has been paid out |

"Show account number" returns the full account and writes an audit line naming
who asked; the list itself shows four digits. "Mark as paid" calls 30's
`settle_payout` and requires a bank transfer reference — the database allows
none, this screen does not, because a settled payout with nothing recorded
cannot be matched against a statement when a driver says the money never
arrived. It records a transfer; it does not make one.

### Dates, export and row actions (60)

A **date range** sits above both tabs — Today, Last 7 days, Last 30 days, All
time, Custom — and is shared, so switching tabs keeps the window. Boundaries are
local midnight and the upper bound is exclusive, which is what stops a charge
made at exactly 00:00 appearing in two adjacent monthly exports.

It does different things on each side, deliberately:

- **Inbound** — filters the ledger and its totals, on `coalesce(paid_at,
  initialized_at)`. Ranging on `paid_at` alone would drop every pending and
  failed charge, which are the rows somebody opens this screen to find.
- **Outbound** — leaves the balances alone and drives a *transactions* table
  instead. A balance is an as-of-now figure; "available in March" is not a
  quantity, and recomputing one over a window produces a number that looks
  authoritative and is the one somebody would pay against.

**Export to CSV** on both tabs. Inbound exports the charges with the fee
breakdown; Outbound exports the transactions, signed — earnings positive,
payouts negative — so the column sums to what the month actually cost. The
writer quotes per RFC 4180, defuses formula injection (a field starting `=`,
`+`, `-` or `@` gets a leading tab), and emits a UTF-8 BOM so Excel on Windows
renders `₦` rather than `â‚¦`. It is **web only**: saving a file on native needs
a share sheet this project does not install, and the button says so rather than
writing something nothing can open.

**Fee breakdown per row**, on Inbound: gross fare, platform cut, driver share,
and the rate. The badge beside it is the important part — `Recorded` when the
parcel has been delivered and the numbers come from `driver_earnings`,
`Expected` when they are a projection at today's rate. Those are different
kinds of number: a projection changes if the rate changes, and shown unlabelled
it reads as a settled liability on a parcel nobody has carried. The row also
names an over- or underpayment when the amount charged differs from the fare.

**Verify with Paystack** on every row. This is for a dropped webhook — a deploy
in flight, a cold function, a key mid-rotation — where Paystack took the money
and we never heard, so our row says pending and the parcel sits invisible to
drivers long after the sender's own retry window closed. It calls the same
`payments-verify` the sender's checkout uses; 60 widens only *whose* reference
an admin may name, and logs the reach to `app_events` before doing the work. It
is offered on settled rows too, because the mirror case — our row says success,
the parcel still says unpaid — is the same failure from the other end, and the
call is idempotent.

⚠ `commission_rate` defaults to 0, so the platform-fee column reads ₦0 until it
is set:

```sql
insert into private.app_settings (key, value) values ('commission_rate', '0.15')
on conflict (key) do update set value = excluded.value;
```

## The return URL

`callbackUrl` builds `<origin>/payment-return` and **adds no query string of its
own**. Paystack appends `?trxref=X&reference=X` to whatever callback it is
given; a `reference` of ours made the key appear twice, expo-router represents a
repeated key as an array, and `.trim()` on an array threw
`A.trim is not a function` on the screen a sender sees one second after being
charged. `payment-return` also reads params through `firstParam()` now, because
the duplicate came from a third party and could come back.

`origin` is `LOCI_APP_URL`, with one exception: a **localhost** origin sent by
the client is honoured when the deployment is not production. Without it a
checkout started on `localhost:8081` returns you to staging — a different
origin, a different session, and a parcel you cannot see. It is safe because
nobody can serve anything on a victim's localhost; anything else the client asks
for is ignored, because a caller-chosen callback is an open redirect with a
payment attached.

## Things that are not done

- **Refunds.** A charge that lands on a parcel cancelled meanwhile is settled,
  logged to `app_events` as `area = 'payment'`, `level = 'warning'`, and left
  for a person. There is no refund call and no admin screen for it. Watch that
  query.
- **Receipts.** Paystack emails its own. Nothing goes through `email_outbox`.
- **Driver payouts.** Still a human making a bank transfer and recording it —
  58 gives them a screen, not an API. The money collected inbound does not flow
  to the driver wallet by any automated path; `driver_earnings` is written from
  the delivery, not from the charge, so the two sides are reconciled by eye.
- **`waived` and `refunded`.** In the column's vocabulary, with no path that
  writes them. They exist so the eventual admin action has something true to
  write rather than reusing `paid`.
