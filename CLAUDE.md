@AGENTS.md

# Project brief

Read this before touching anything. It exists so a fresh session starts with
the context the last one had, instead of rediscovering it from a grep.

## What this is

A parcel-delivery marketplace for Nigeria. Senders post a parcel, drivers
already making that journey claim it, the two meet at a hub or a handover
point. One Expo codebase targets iOS, Android and the web; Supabase is the
entire backend.

The app ships under the brand **Package Relay**, written **PKRELAY** in the
wordmark and in identifiers. Two spellings, one rule — see "Brand naming
convention" below; get it wrong and `npm run verify` will tell you. It was
called **LOCI** until Sep 2026; the identifiers that still say `loci` are
deliberate — see "The LOCI residue" at the bottom before you rename any.

Bolaji is the sole developer. Treat him as the product owner and expect to
act as lead technical architect: propose the approach, name the trade-off,
then implement. He runs anything credentialed (Supabase dashboard, EAS,
Cloudflare) himself — prepare the change in the repo and hand him the steps.

## Stack

| Layer | What |
| --- | --- |
| App | Expo SDK **56**, React Native 0.85.3, React 19.2, expo-router (typed routes, React Compiler on) |
| Language | TypeScript ~6.0, strict; `@/` aliases `src/` |
| Backend | Supabase — Postgres + RLS, Storage, Edge Functions (Deno), pg_cron |
| Identity | Dojah (liveness + document verification) |
| Email | Resend, via the `notify-*` edge functions |
| Push | Expo push, via `notify-offer` |
| Web deploy | Cloudflare Pages (`npm run build:web` → `dist/`); Preview env carries staging credentials |
| Native builds | EAS (`eas.json` profiles: development, preview, preview-testflight) |

Expo 56 is recent and the APIs moved. `AGENTS.md` is not decoration — check
the versioned docs before writing Expo code from memory.

## Layout

```
src/app/            expo-router routes — (tabs), (auth), capture, guarantor, parcel
src/components/ui/  the whole component library, flat
src/constants/      brand-facing content lives here: contact, links, legal,
                    theme, services, hubs, driver-guidelines
src/lib/            supabase client, data access
src/hooks/ store/ utils/
supabase/migrations/  timestamped CLI migrations (20250101000001 … 45)
supabase/functions/   Deno edge functions + _shared/
scripts/            the test suite (see below)
docs/               STAGING, DEEP-LINKS, DOJAH, DISTRIBUTION, PUSH-DEPLOY,
                    PRIVACY-NOTES, SCHEMA-AUDIT
```

## Commands that matter

```bash
npm run verify      # THE test suite — ~50 assertion scripts + typecheck
npm run typecheck   # tsc --noEmit --noUnusedLocals
npm run lint
npx expo start -c   # -c clears Metro cache; .env is read only at bundler start
```

`npm run verify` is not a formality. Each `scripts/verify-*.ts` bundles part
of the app with esbuild and asserts on it under node; each
`scripts/pg/*-harness.mjs` runs the migrations against pglite and asserts on
real SQL behaviour. **Many of them assert on literal user-facing strings**,
including the word "LOCI". A rename that does not update the assertions will
turn the suite red. Run `npm run verify` before declaring anything done.

## Conventions worth keeping

- Brand strings are centralised in `src/constants/` on purpose — change them
  there, not in screens. That includes what the *web* says about itself:
  `src/constants/site.ts` holds the tab title, the meta description and the
  share-card image, read by both `src/app/+html.tsx` (the head tags a crawler
  sees) and the root layout (which owns the one and only `<title>`).
- `src/constants/contact.ts` has `CONTACT_IS_PLACEHOLDER = true`; the
  addresses on `pkrelay.ng` are placeholders on a domain nobody owns, and
  `verify-about.ts` fails if the flag lies.
- `supabase/functions/_shared/environment.ts` is the single source of truth
  for which deployment a function is in. Nothing else may read `Deno.env`
  for it — the verify harnesses run under node, where `Deno` does not exist.
  Staging skips Slack, forces the Dojah sandbox, and redirects outbound email.
- Migrations are append-only, CLI-standard timestamped files. Never edit a
  migration that has been pushed; add a new one.
- Never put a `service_role` / `sb_secret_` key in this repo. Anything
  prefixed `EXPO_PUBLIC_` is compiled into the bundle and is public.
- Comments in this codebase explain *why*, at length, and often name the
  failure they prevent. Match that register rather than stripping it.

## Current state (Sep 2026)

- Branch: `staging`. The working tree has ~150 uncommitted files — the
  staging-environment work: migrations moved to CLI-standard names, the
  `LOCI_ENVIRONMENT` guard, and the docs that go with it. Do not assume a
  clean tree, and do not `git checkout .` anything.
- An isolated staging Supabase project is being stood up; `docs/STAGING.md`
  is the runbook, including the repair step the existing hand-built project
  needs before the CLI will accept a `db push`.
- Staging is `ublqzvuzbyodjstzjvja`; production is `ymfdnzeonkhvzncqcezo`.
  `.env` and the CLI link both point at staging. Migrations 01-45 and 47 are
  applied there. **48 is written but not yet pushed.**

## Migration numbering: the gap at 46

There is no 46. It was reserved for `rls_hardening` while the hub rebrand
shipped as 47; once 47 was applied on staging, a file numbered 46 would have
sorted before the last applied migration and `db push` would have skipped it
without `--include-all`. So RLS hardening is **48**. Do not fill the 46 gap —
anything numbered below 47 needs `--include-all` to ever reach staging.

## Still owed: the `is_admin()` pass (migration 49)

`schema-gap.ts` describes the hardening work as including "a handful of
policies rewritten to stop calling `is_admin()` once per row". That half was
deliberately left out of 48, because it is **21 distinct live policies across
14 tables**, six of them on `storage.objects`, and it is a performance change
rather than a security one. Nothing in `rls-hardening-harness.mjs` tests it.

Each one has to be recreated verbatim with only the `(select ...)` wrap added.
Recreating a policy while dropping one of its conditions is the failure this
codebase has hit most often — `sender creates own` alone has been rewritten
five times, carrying the warning forward each time. Do that pass as its own
migration, one table at a time, with the existing definition open beside it.

## Brand naming convention

Two spellings, and which one you use is decided by where the text appears, not
by how it sounds.

**`PKRELAY`** — all caps, no space. Reserved for:

- the compact wordmark: the nav header (`app-nav-bar.tsx`), the `styles.brand`
  mark on `screen.tsx` and the guarantor page, and the header of both HTML
  email layouts;
- `app.json` `name` — the label under the app icon. `Package Relay` is 13
  characters and iOS truncates it to `Package Rela…`, so the short form wins
  here even though a user reads it;
- the build stamp in `settings-menu.tsx` that people copy into bug reports;
- domains and addresses, which are lower case: `pkrelay.ng`, `support@`,
  `business@`, `privacy@`, and the `pkrelay.example` / `pkrelay.test` fixtures;
- code identifiers, variables and file names.

**`Package Relay`** — title case, one space. Everything a user reads as
prose: UI copy, page titles and headings, alerts, toasts, validation messages,
push notifications, email subjects and bodies, the sign-off line at the foot
of the plain-text emails, hub names, legal and privacy copy, README and docs.

Code comments follow the prose rule when they are talking about the company
("Package Relay does not charge extra for fragile items") and the identifier
rule when they are naming a thing in the codebase ("the PKRELAY wordmark").

The verify suite asserts on both forms. `verify-build-config.ts` requires the
iOS permission strings to say `Package Relay`; `verify-push.ts`,
`verify-wallet.ts`, `verify-auth.ts`, `verify-about.ts`, `verify-delivery.ts`
and `verify-changes.ts` each pin a specific user-facing sentence. Change the
copy and the assertion together, in the same commit.

⚠ The domain placeholders stayed on `.ng`, not `.com`. The app is Nigeria-only
and cites the NDPR, so the addresses stay local. `CONTACT_IS_PLACEHOLDER` in
`src/constants/contact.ts` is still `true` — nobody owns the domain yet, and
`verify-about.ts` fails if that flag lies.

## The LOCI residue

The brand rename LOCI → PKRELAY was completed in Sep 2026, and the two-token
convention above was applied over it in the same week. Together they covered
the visible brand and the placeholder contact/domain strings: `app.json`
`name` and the permission strings, every UI string, email and push template,
the wordmark in `app-nav-bar.tsx`, `src/constants/*`, the `*@loci.ng`
addresses, README, `.env.example` and `docs/`. Verify assertions moved in the
same pass, both times.

Everything below still says `loci` **on purpose.** None of it is a missed
find-and-replace. Renaming any of it is a separate, riskier job:

1. **Config identifiers** — `LOCI_ENVIRONMENT`, `LOCI_FROM_EMAIL`,
   `LOCI_STAGING_EMAIL`, `LOCI_SUPPORT_EMAIL`, `LOCI_APP_URL`, the
   `LociEnvironment` type. Renaming these means re-setting secrets in
   Supabase, EAS and Cloudflare Pages in step with the deploy, or staging
   silently falls back to production behaviour.
2. **Hard identity** — `com.loci.parcel` (iOS bundle id + Android package),
   the `parcelmobile` scheme, associated domains, the `loci-*` pg_cron job
   names, `LOCI-` reference prefixes in seed and test data. Changing the
   bundle id creates a new app on both stores and invalidates existing
   installs and deep links.
3. **Persisted client state** — the AsyncStorage keys `loci.draft.booking`,
   `loci.draft.driver-application` (`src/hooks/use-form-draft.ts`) and
   `loci.activeView.${userId}` (`src/store/session.tsx`). These are storage
   addresses, not copy. Renaming a key does not migrate what is stored under
   the old one: every in-progress booking and half-finished driver
   application on an existing install would silently vanish. If they ever
   move, the change needs a read-old-write-new migration in the same commit.
4. **Postgres GUC names** — `loci.erasing` and `loci.attaching_identity`, set
   with `set_config` in 20250101000033 and 20250101000034 and read by RLS
   policies. Both live in pushed migrations, which are append-only.
5. **Pushed migration comments** — 43 migration files explain themselves in
   prose that says LOCI. They were left byte-identical to what was applied,
   which is the append-only rule doing its job. Expect to read LOCI there.
6. **`loci.pages.dev`** — the live Cloudflare Pages hostname, asserted as a
   fixture in `verify-application-email.ts`. It changes when the Pages
   project is renamed, not before.
7. **`LOCI Logistics Technologies Limited`** in `Footer.tsx` — the registered
   company name, which is a different thing from the app brand and has not
   been changed at the CRO.

Hub names read `Package Relay Ikeja Hub` and were rebranded in the database by
`20250101000047_hub_rebrand.sql`, guarded with `where name like 'LOCI %'` so
admin-corrected names are not clobbered. `SEED_HUBS` in
`src/constants/hubs.ts` was renamed to match, but remember that constant is a
fallback — the table is what users see.

Known pre-existing inconsistency, unrelated to the rename: `STORE_LINKS` in
`src/components/ui/app-store-modal.tsx` points Android at
`?id=com.loci.app`, but the actual package in `app.json` is
`com.loci.parcel`. That Play Store link resolves to nothing. Fixing it is a
one-word change to the correct bundle id, not a rebrand.
