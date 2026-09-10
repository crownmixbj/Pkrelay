# Staging

A second, isolated Supabase project, reached by the Cloudflare Pages **Preview**
deployments and the EAS **preview** builds. Production is untouched by anything
done here.

Nothing in this document is done for you. It is the list of credentialed steps,
in the order that works, with the two places this setup goes wrong marked.

---

## What "isolated" means here, and what it does not

Splitting the database is the easy half, and it is the half everybody does. The
half that bites is that the edge functions reach *outward* — to Resend, Dojah
and Slack — and none of those three know which database a row came from.

| Integration | On production | On staging |
| ----------- | ------------- | ---------- |
| Supabase | production project | separate project, separate keys |
| Resend | delivers to the real recipient | redirected to `LOCI_STAGING_EMAIL`; refuses to send if that is unset |
| Dojah | `DOJAH_ENVIRONMENT` decides | forced to sandbox, whatever `DOJAH_ENVIRONMENT` says |
| Slack | posts when a webhook is set | never posts, webhook or not |

All three are decided in `supabase/functions/_shared/environment.ts` from one
secret, `LOCI_ENVIRONMENT`. `npm run verify:staging` asserts both that the guard
answers correctly and that every call site still goes through it — the failure
that actually ships is a ninth email template calling Resend directly, not a
wrong answer in the guard.

⚠ **`LOCI_ENVIRONMENT` is a server-side secret and must stay one.** As an
`EXPO_PUBLIC_` variable it would be compiled into the app bundle, where anyone
who installs the APK can change it. A guard the attacker sets is not a guard.

---

## Step 1 — create the staging Supabase project

Dashboard → New project, in the same organisation.

| Field | Value |
| ----- | ----- |
| Name | `loci-staging` |
| Region | the same region as production |
| Postgres version | 17.x, to match production |

Note the project ref from the dashboard URL — it is the `xxxx` in
`https://supabase.com/dashboard/project/xxxx`.

## Step 2 — apply the migrations

The 45 SQL files now live in `supabase/migrations/` under CLI-standard
timestamped names, so the CLI can replay them.

```bash
brew install supabase/tap/supabase     # npm install -g supabase does not work
supabase login
supabase link --project-ref <staging-ref>
supabase db push
```

⚠ **Production has the schema but no migration history.** Every one of those 45
files was pasted into the SQL editor by hand, so
`supabase_migrations.schema_migrations` on the production project is empty — I
checked. The first time you link production and run `db push`, the CLI will
believe none of them have been applied and try to run all 45 against a database
that already has them.

So before ever pushing to production, tell it what it already has:

```bash
supabase link --project-ref <production-ref>
for v in $(ls supabase/migrations | cut -d_ -f1); do
  supabase migration repair --status applied "$v"
done
supabase migration list        # local and remote should now agree
```

This writes history rows only. It runs no SQL against your tables.

## Step 3 — edge function secrets on staging

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.
Do not set them; `secrets set` rejects the `SUPABASE_` prefix anyway.

```bash
supabase secrets set --project-ref <staging-ref> \
  LOCI_ENVIRONMENT="staging" \
  LOCI_STAGING_EMAIL="you@yourdomain.com" \
  RESEND_API_KEY="re_..." \
  LOCI_FROM_EMAIL="LOCI staging <staging@yourdomain.com>" \
  LOCI_APP_URL="https://<preview>.pages.dev" \
  LOCI_SUPPORT_EMAIL="support@yourdomain.com" \
  GOOGLE_PLACES_KEY="..." \
  DOJAH_APP_ID="<sandbox app id>" \
  DOJAH_SECRET_KEY="<sandbox secret>"
```

Deliberately absent:

- **`SLACK_WEBHOOK_URL`** — staging skips Slack regardless, so setting it only
  creates the chance of it being read by something added later.
- **`DOJAH_ENVIRONMENT`** — staging forces sandbox. Setting it to `production`
  here does nothing, by design.

Then deploy the functions to staging:

```bash
supabase functions deploy --project-ref <staging-ref>
```

## Step 4 — EAS variables for preview builds

EAS environments are fixed: `development`, `preview`, `production`. There is no
`staging`, so **`preview` is staging** — `eas.json` already binds the `preview`
and `preview-testflight` profiles to it.

```bash
npx eas-cli env:set --name EXPO_PUBLIC_SUPABASE_URL      --value "https://<staging-ref>.supabase.co" --environment preview --visibility plaintext
npx eas-cli env:set --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "sb_publishable_..."                --environment preview --visibility plaintext
npx eas-cli env:list --environment preview
```

## Step 5 — Cloudflare Pages preview variables

Pages has two environments, **Production** and **Preview**, and Preview applies
to every branch that is not the production branch. The `staging` branch is
therefore already a Preview deployment.

Settings → Environment variables → **Preview**:

| Variable | Value |
| -------- | ----- |
| `EXPO_PUBLIC_SUPABASE_URL` | `https://<staging-ref>.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | the staging project's publishable key |
| `EXPO_PUBLIC_LINK_DOMAIN` | leave unset unless you host association files on a staging host |

⚠ **Check the Production column at the same time.** The two environments are
edited on one page and set independently. A staging URL saved into the
Production column points the live site at the test database, and nothing about
the deployment will look wrong.

## Step 6 — auth redirect URLs

On the **staging** project: Authentication → URL Configuration → Redirect URLs.
Add the preview origin (`https://*.<project>.pages.dev`) and `parcelmobile://`.
Email confirmation and password reset silently fail without this, and the
failure looks like a broken login rather than a missing setting.

---

## Adding a migration from here on

```bash
supabase migration new add_thing        # writes supabase/migrations/<timestamp>_add_thing.sql
# write the SQL
supabase db push --project-ref <staging-ref>
npm run verify                          # the pg harnesses replay migrations under pglite
# once it looks right on staging:
supabase db push --project-ref <production-ref>
```

Migrations go to staging first, always. That ordering is the only reason the
second project earns its cost.

---

## Checking the guard is on

After deploying to staging, submit a driver application against it. You should
see:

- the confirmation email in `LOCI_STAGING_EMAIL`, subject prefixed
  `[STAGING -> <the address it was aimed at>]`
- nothing in Slack
- a liveness verdict labelled "test mode — not a real verification"

If the email arrives at the applicant's own address, `LOCI_ENVIRONMENT` is not
set on that project. Stop and fix that before testing anything else.
