# LOCI

Parcel delivery across Nigeria — senders post parcels, drivers claim them.

Built with Expo SDK 56, React Native 0.85, expo-router and TypeScript. The same
codebase targets iOS, Android and the web.

---

## Running locally

```bash
npm install
cp .env.example .env.local   # then paste your Supabase values
npx expo start -c
```

The `-c` clears the Metro cache. Expo reads `.env*` files **only at bundler
startup**, so after changing one you must restart the dev server — a hot reload
won't pick it up.

## Environment

| Variable                        | Where to find it                              |
| ------------------------------- | --------------------------------------------- |
| `EXPO_PUBLIC_SUPABASE_URL`      | Supabase dashboard → Project Settings → API   |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Same page — the **publishable / anon** key     |

Anything prefixed `EXPO_PUBLIC_` is compiled into the app bundle and is readable
by anyone who installs the app. That is correct for the anon key, which is
designed to be public — Row Level Security on your tables is what protects the
data, not the secrecy of this key.

**Never put the `service_role` / `sb_secret_` key in this project.**

`.env` and `.env.*` are git-ignored; only `.env.example` is committed.

## Supabase setup

**Run the SQL first, in order.** Dashboard -> SQL Editor -> New query, paste,
Run:

1. `supabase/01_bookings.sql` — the bookings table and its access policies.
2. `supabase/02_driver_applications.sql` — profiles, the admin flag, driver
   applications, and the "approved drivers only" rule on bookings.

The second file extends the first, so running it alone fails with
`relation "public.bookings" does not exist`. It now checks for that and says so.

Then make yourself an admin — the review dashboard is invisible without it:

```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'your@email.com');
```

`is_admin` cannot be set from the app: a trigger refuses the change when the
caller is `authenticated` or `anon`, which is every request from the client. The
SQL editor runs as `postgres` and is allowed, so admin is granted out-of-band.

If you already ran an earlier version of `02_driver_applications.sql` and the
update above fails with `is_admin can only be changed by a database
administrator`, run `supabase/03_fix_admin_guard.sql` — the first version of
that trigger raised unconditionally and locked out the SQL editor too.

Then, in the dashboard:

- **Authentication → Sign In / Providers → Email** — enabled.
- **Authentication → URL Configuration → Redirect URLs** — add your dev origin
  (`http://localhost:8081`) and your deployed origin, or confirmation links will
  bounce somewhere unhelpful.
- **Authentication → Emails → SMTP Settings** — the built-in mailer only sends to
  members of your own Supabase organisation, and only **2 emails per hour across
  the whole project**. Add a provider (Resend, Postmark, SendGrid) before real
  users, or turn off "Confirm email" while developing.

## Checks

```bash
npm run typecheck   # tsc --noEmit --noUnusedLocals
npm run lint
npm run build:web   # produces dist/ — run this before pushing a deploy
```

---

## Deploying to Cloudflare Pages

Connect the GitHub repo, then use these settings:

| Setting                | Value                        |
| ---------------------- | ---------------------------- |
| Framework preset       | **None**                     |
| Build command          | `npm run build:web`          |
| Build output directory | `dist`                       |
| Node version           | `22` (also set in `.nvmrc`)  |

Add both `EXPO_PUBLIC_` variables under **Settings → Environment variables**, for
Production *and* Preview. They are not in the repo, so the build will produce an
app that reports "accounts are not configured" without them.

### Why `public/_redirects` exists

`app.json` sets `web.output: "static"`, so Expo pre-renders one HTML file per
known route. Dynamic routes can't be pre-rendered — there's no way to know every
parcel id at build time — so `/parcel/abc123` has no file and Pages would answer
404. The `_redirects` rule rewrites unmatched paths to `index.html` with a 200,
which keeps the URL intact so expo-router can read the id from it. Cloudflare
serves real files first, so the pre-rendered pages are unaffected.

### After the first deploy

Add the Pages URL to Supabase's **Redirect URLs**, or email confirmation and
password reset links will fail in production.

---

## Notes on the current state

- **Bookings and driver applications persist in Postgres**, with Row Level
  Security enforcing access server-side. Until you run the SQL above, the app
  falls back to in-memory seed data — a development convenience, not a feature;
  nothing persists in that mode.
- **Uploads are the weak link in the review process.** A reviewer sees the
  filenames an applicant attached but cannot open them, so nobody should be
  approved on the strength of that list alone. The dashboard says so.
- **Uploads aren't uploaded.** Parcel photos and driver documents are local file
  URIs; no storage bucket is wired up. Parcel photos are dropped on insert
  rather than stored as a dead `file://` path.
- **Driver applications hold sensitive personal data** — NINs, bank account
  numbers and addresses, for the applicant and their guarantor. Access is
  limited to the applicant and admins, but you need a retention policy for
  rejected applications before real applicants use this.
- **Notifications are queued, not sent.** `store/notifications.tsx` composes the
  driver's confirmation email and SMS and records them. Delivery needs a
  server-side sender — a client cannot hold provider credentials.
- **OTP collection** is described in the hub copy but not implemented.

### Email confirmation links

`signUp` sets `emailRedirectTo` to `<origin>/confirm?email=<address>`, so the
link lands on a route that reads the outcome instead of the marketing home.

Add that path to **Authentication → URL Configuration → Redirect URLs** for
every origin you serve:

```
https://loci-741.pages.dev/confirm
https://<production host>/confirm
parcelmobile://confirm
```

⚠ Supabase silently falls back to the Site URL for any target not on that list,
which looks identical to the app ignoring the parameters. If a confirmation link
drops somebody on the home page, check this list before the code.

The address on the query string is not something Supabase provides — it is added
at sign-up, and two behaviours depend on it: offering a resend to the right
address when a token has expired, and noticing that the link belongs to somebody
other than the account already signed in on that device. See
`src/lib/email-confirmation.ts`.

### Address suggestions on the quote form

`Get a Quick Quote` accepts a typed address and resolves it to one of the 37
cities the pricing knows. Suggestions come from Google Places through the
`places-lookup` edge function:

```
supabase secrets set GOOGLE_PLACES_KEY=…
supabase functions deploy places-lookup
```

⚠ The key stays server-side, as the Dojah secret does. A Places key in the
client bundle is one anybody can spend, and on a phone it cannot be
referrer-restricted — Autocomplete bills per session, so the failure mode is a
bill nobody notices for a month rather than an outage somebody reports in an
hour.

Without the secret the function answers `{ configured: false }` and the form
shows the city picker instead, so a deployment with no key still quotes. The
same fallback covers a network failure, Google rate-limiting, and an address in
a state LOCI does not serve.

⚠ The address does not change the price. `estimateFee` charges by band — same
city or not — with no distance term, so the address chooses the city and then
travels to the booking form as something a driver can find. If you want distance
to affect the fare, that is a pricing change, not a form change.

### Distance pricing

`estimateFee` charges `base + weight×perKg + distanceKm×perKm`, where the
distance comes from the two addresses on the quote form. Everything else — the
rate calculator, the booking form, the service catalogue — passes no distance
and is charged exactly what it was before.

⚠ The four rate constants in `PRICING` are a commercial decision, not a
technical one. They were calibrated so a typical trip costs what it cost under
the old flat bands:

| Journey             | Before  | Now     |
| ------------------- | ------- | ------- |
| Local, 8km, 2kg     | ₦1,900  | ₦1,900  |
| Ibadan→Lagos, 2kg   | ₦5,400  | ₦5,390  |
| Abuja→Lagos, 2kg    | ₦5,400  | ₦18,500 |

The third row is the point of the change and also its risk: long routes now
cost what they cost to run, and nobody has been charged that before. Check the
numbers before this reaches customers.

Distance is measured by Distance Matrix through the same `places-lookup`
function. When that cannot answer, a straight line multiplied by a 1.3 road
factor is used instead and the quote says "about" — an estimate presented to
the kilometre implies a precision it does not have.
