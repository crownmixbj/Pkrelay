# Edge Functions

Deno, not React Native. They run on Supabase's edge runtime and are excluded
from the app's `tsconfig.json` — type-checking them against React Native's libs
produces nonsense like "Cannot find name 'Deno'".

## payments-initialize / payments-verify / payments-webhook

The parcel fare, through Paystack. **`docs/PAYMENTS.md` is the runbook** — the
deploy commands, the secrets, the webhook URL and the cron sweep are all there
rather than duplicated here.

Two things worth knowing before you touch them:

```bash
supabase functions deploy payments-webhook --no-verify-jwt
```

The flag is not optional. Paystack's servers have no Supabase token, so with
JWT verification on they are refused at the gateway, the function logs nothing,
and every payment sits pending. The `x-paystack-signature` HMAC is what
protects it instead, checked over the raw body before anything is parsed.

And `PAYSTACK_SECRET_KEY` must be an `sk_test_` key on staging. A live key
there is refused outright by `_shared/paystack.ts` — staging shares this
directory with production, and a live key on a test parcel takes real money.

## notify-application

Runs the moment a driver application is inserted, called by the
`on_driver_application_created` trigger in `../20250101000005_storage_and_alerts.sql`. It
does two independent things:

1. **Emails the applicant a confirmation.** The app tells them on screen to
   check their inbox, so something has to actually arrive.
2. **Posts a Slack alert** so someone knows there is a queue to work.

They cannot break each other: a dead Slack webhook must not stop an applicant's
confirmation, and a missing mail provider must not silence ops.

`email.ts` holds the template and is deliberately free of Deno globals, so
`npm run verify:email` (see below) can render and assert on it under node.

### Install the CLI

⚠ `npm install -g supabase` does **not** work. Supabase deliberately blocks the
global npm install and the CLI errors with "Installing Supabase CLI as a global
module is not supported." On macOS, use Homebrew:

```bash
brew install supabase/tap/supabase
supabase --version
```

Or skip installing anything and prefix every command below with `npx`:

```bash
npx supabase --version
```

### Deploy

```bash
supabase login
supabase link --project-ref <your-project-ref>   # the ref is in your dashboard URL

supabase functions deploy notify-application
```

### Secrets

```bash
# --- Applicant confirmation email -------------------------------------------
supabase secrets set RESEND_API_KEY="re_..."
# LOCI_FROM_EMAIL is optional — defaults to DEFAULT_FROM in _shared/email.ts
# supabase secrets set LOCI_FROM_EMAIL="Package Relay <noreply@app.pkrelay.com>"

# Optional but strongly recommended: replies land somewhere a human reads.
supabase secrets set LOCI_SUPPORT_EMAIL="support@yourdomain.com"

# --- Ops alert ---------------------------------------------------------------
supabase secrets set SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."

# Shared: adds a "Track your application" button and links the Slack alert
# straight to the review dashboard.
supabase secrets set LOCI_APP_URL="https://your-app.pages.dev"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — you
do not set those.

Prefer not to use the CLI for this? The same secrets can be added in the
dashboard under **Edge Functions → Secrets**. Deploying the function itself
still needs the CLI.

#### Why a mail provider at all

Supabase's built-in mailer only sends the **auth** templates (confirm sign-up,
password recovery, magic link) and is rate-limited to a couple of messages an
hour on the free tier. It cannot send a driver-application confirmation. A
transactional provider is required.

[Resend](https://resend.com) is what this function calls. Sign up, **verify
your sending domain** (this is the step people skip, and unverified domains go
straight to spam), then create an API key.

Swapping to SendGrid or Postmark means editing `sendApplicantEmail` in
`index.ts` — one function. The template and the orchestration do not know which
provider is in use.

⚠ `LOCI_FROM_EMAIL` must be on a domain you have verified with the provider.
Sending as `@gmail.com` will fail DMARC and be rejected or junked.

### Point the trigger at the function

In the SQL editor, once:

```sql
insert into private.app_settings (key, value) values
  ('edge_url', 'https://<project-ref>.supabase.co/functions/v1'),
  ('service_key', '<your service_role key>')
on conflict (key) do update set value = excluded.value;
```

⚠ The `service_role` key belongs only here and in Edge Function secrets. It
bypasses every RLS policy — it must never reach `.env` or the app bundle.

### Check it

```bash
supabase functions logs notify-application
```

Submitting a driver application should email the applicant and post to Slack
within a second or two.

If nothing arrives, the trigger swallows its own errors by design — an alert
must never roll back an application — so look in three places:

1. **Postgres logs** for a `notify_new_driver_application failed` warning. That
   means the trigger never reached the function.
2. **Function logs**, as above. The response body names which half failed.
3. **The application row itself**:

   ```sql
   select reference, email, confirmation_email_sent_at, confirmation_email_error
   from public.driver_applications
   order by submitted_at desc
   limit 20;
   ```

   `confirmation_email_error` is also rendered in the admin dashboard, so
   whoever works the review queue sees that an applicant was never told their
   application arrived. Both columns null means no provider is configured yet —
   that is a deployment state, not a delivery failure.

Requires `../20250101000006_application_email.sql`, which adds those two columns and the
trigger that stops a client writing to them.
