# Auth redirect URLs

Every authentication flow in this app hands Supabase a `redirectTo` and Supabase
checks it against a per-project allowlist before honouring it.

⚠ **A target that is not on the list is not rejected — it is silently replaced
by the project's Site URL.** There is no error, no console warning and nothing
in the network tab that says so. What you see is a person clicking "Continue
with Google", approving, and landing signed-out on production. That failure has
exactly one cause and it is never the client code.

The code is already environment-aware and needs no change per environment. What
follows is the dashboard configuration it depends on.

---

## What the code sends

| Flow | Web | Native |
|---|---|---|
| Google OAuth | `<current origin>/sign-in` | `Linking.createURL('/sign-in')` |
| Email confirmation | `<current origin>/confirm?email=…` | `https://<LINK_DOMAIN>/confirm`, or `parcelmobile://confirm` |
| Password reset | `<current origin>/update-password?email=…` | `https://<LINK_DOMAIN>/update-password`, or `parcelmobile://update-password` |

All three live in `src/constants/links.ts`.

Password reset used to fall back to the project Site URL, because
`resetPasswordForEmail` was called without a `redirectTo`. That is the same
failure email confirmation had: the marketing home reads no parameters, so the
recovery token was never exchanged, `PASSWORD_RECOVERY` never fired, and the
person landed on an ordinary home page believing the link had done something.

**No allowlist change was needed for it.** Every entry below is already a `/**`
pattern, which covers `/update-password?email=…` exactly as it covers
`/confirm?email=…`. A new *origin*, on the other hand, still needs adding.

**"Current origin" means `window.location.origin` — read at the moment of the
click, from the page the person is actually on.** That is the whole mechanism,
and it is why there is no `__DEV__` branch and no list of known hostnames in
that file. It is correct for `localhost` on whatever port Expo settled on (8081
is only the first choice — a busy port silently becomes 8082), for
`staging.pkrelay.com`, for `app.pkrelay.com`, and for the per-branch
`*.pages.dev` origin every Cloudflare Pages preview deploy gets. A hostname
allowlist in code has no entry for that last one, so previews would sign people
into production.

**Native is a scheme, never a universal link.** A universal link is caught by
the browser showing Google's consent screen, not by the app that opened it: the
person ends up on a web page inside a modal browser holding a session the app
never sees. The scheme is what closes that browser and returns the tokens.

**Which scheme is not fixed.** A release build and a dev client answer to
`parcelmobile://`. Expo Go is a different app and answers to
`exp://<lan-ip>:<port>/--/…`. `Linking.createURL` returns whichever is correct
for the binary currently running, so Google sign-in works in development and in
TestFlight from the same line.

---

## Staging project → Authentication → URL Configuration

Site URL:

```
https://staging.pkrelay.com
```

Redirect URLs:

```
https://staging.pkrelay.com/**
https://*.pkrelay-741.pages.dev/**      # per-branch preview deploys
https://pkrelay-741.pages.dev/**        # the branch-less preview origin
http://localhost:8081/**                # web dev server — the /** is required
http://localhost:8082/**                # the port Expo falls back to
parcelmobile://**                       # dev client and release builds
exp://**                                # Expo Go — see the note below
```

⚠ `exp://**` belongs on **staging only, and only while developing**. It allows
a redirect to any host on that scheme, which is acceptable against a database
holding test data and is not acceptable against production. Remove it from
production's list if it ever appears there.

## Production project → Authentication → URL Configuration

Site URL:

```
https://app.pkrelay.com
```

Redirect URLs:

```
https://app.pkrelay.com/**
parcelmobile://**
```

That is the entire list. No localhost, no `exp://`, no `*.pages.dev` — a
production session should not be reachable from a machine or a build that is
not production.

---

## Google Cloud Console

Separate from Supabase and easy to confuse with it. The **Authorised redirect
URI** there is Supabase's callback, not this app's:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

One entry per Supabase project, so staging and production each need their own —
in the same OAuth client, or in two, but they must be present. The client ID and
secret live in the Supabase dashboard under Authentication → Sign In / Providers
→ Google. **Neither ever appears in this repo**; the exchange happens between
Supabase and Google, and anything credential-shaped in `src/` ships to every
browser that loads the app. `scripts/verify-google-auth.ts` asserts that.

---

## ⚠ `supabase/config.toml` does not configure a hosted project

This trips people up, and it has already cost one debugging session:

```toml
[auth]
site_url = "http://localhost:8081"
additional_redirect_urls = ["http://localhost:8081", "parcelmobile://"]
```

That block applies **only to a local stack started with `supabase start`**. It is
not read by, uploaded to, or synced with a hosted project. Running against
staging or production from your laptop, it has no effect whatsoever.

So the repo can say localhost is allowed while the project your `.env` points at
has never heard of it. The file reads like a promise the hosted project never
made, and the symptom is a confirmation email that lands on staging.

Note also the shape: `http://localhost:8081` matches that URL and nothing else.
`/confirm?email=…` is a different URL. Path entries need `/**`, which is why the
lists above use it everywhere.

---

## When it breaks

Symptom: approving Google returns you to the site signed out, or to the wrong
environment.

1. Check the allowlist above for the project that build points at. This is the
   cause roughly every time.
2. Confirm which project it points at — `EXPO_PUBLIC_SUPABASE_URL` in the
   Cloudflare Pages environment for that deployment. Preview and Production hold
   separate values; a preview carrying production's URL will look like a
   redirect bug and is a credentials bug.
3. Only then look at `src/constants/links.ts`.

Symptom: the Google sheet opens on a phone, closes, and nothing happens.

That is the native return URL not resolving. In Expo Go it means `exp://**` is
missing from the staging list; in a dev client or release build it means
`parcelmobile://**` is.
