# Getting Package Relay onto testers' phones

Everything in this file is a command **you** run — building requires accounts I
cannot log into on your behalf. The repo is configured for it; nothing has been
built yet.

Run `npm run verify:build` before any build. It checks the things that otherwise
fail twenty minutes into a cloud build, or worse, produce an artefact that
crashes the first time a tester opens the camera.

---

## The short version

| | Android | iOS |
|---|---|---|
| Account needed | None | Apple Developer Program, $99/yr |
| How testers install | Tap a link, install the APK | TestFlight app |
| Device limit | None | 100 internal / 10,000 external |
| Time to first tester | **Today** | ~2 days (enrolment) + build |

**Start with Android today.** It needs no developer account, no device
registration and no review. You can be collecting feedback while Apple processes
your enrolment.

---

## Step 0 — one-time setup

### Expo account

```bash
npx eas-cli login          # or: npm run eas:login
npx eas-cli init           # links this repo to an EAS project
```

`eas init` writes an `extra.eas.projectId` into `app.json`. Commit that — it is
an identifier, not a secret.

### Environment variables — the step that ruins test rounds

`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` live in your local
`.env`, which is git-ignored and therefore **not** uploaded to the build server.
A build without them does not crash — it falls back to sample data, and you get
the red "This build has no database" banner.

Two things have to be true. Both are needed; either alone does nothing.

**1. The values live on EAS**, not in the repo:

```bash
npx eas-cli env:set --name EXPO_PUBLIC_SUPABASE_URL      --value "https://xxxx.supabase.co"   --environment preview --visibility plaintext
npx eas-cli env:set --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "sb_publishable_..."         --environment preview --visibility plaintext
```

Repeat with `--environment development` and `--environment production` when you
want those builds connected too. Check with `eas env:list --environment preview`.

**2. The build profile names that environment.** This is in `eas.json` and is
already done:

```json
"preview": {
  "environment": "preview"
}
```

Without that line, variables stored on EAS never reach the build. An `env` block
in eas.json only carries literals that are committed to git — it is the right
home for something like `EXPO_PUBLIC_BUILD_CHANNEL` and the wrong home for
anything tied to your Supabase project.

**Why not paste the keys straight into eas.json?** The anon key is publishable
and ships inside the APK anyway, so this is not a catastrophe — but `eas.json`
is tracked, this repo has a GitHub remote, and once a value is in git history it
stays there. It also pins the repo to one Supabase project, which makes a
separate test database harder later. `npm run verify:build` fails if a Supabase
URL or key literal appears in committed config.

To pull the EAS values back down for local work:

```bash
npx eas-cli env:pull --environment preview
```

### Before your first build, decide the app identifier

```json
"ios":     { "bundleIdentifier": "com.loci.parcel" },
"android": { "package": "com.loci.parcel" }
```

I picked `com.loci.parcel` to replace Expo's placeholder `com.anonymous.*`,
which Apple will not accept. **Change it now if you want something else** —
ideally a domain you control reversed, e.g. `ng.loci.app`. After the first
TestFlight upload this value is permanent; changing it later means a new app
record and re-inviting every tester.

---

## Android — testers today

```bash
npm run build:preview:android
```

EAS builds an APK and gives you a URL. Send it to testers; they open it on the
phone and install. Android will warn about installing outside the Play Store —
that is expected for internal distribution.

Any Android device, any number of them, no registration.

Two profiles are available:

- `development` — includes the dev client, connects to your Metro server. For
  you and anyone debugging. Use `npm run build:dev:android`.
- `preview` — standalone, production-like, no dev tools. **This is the one for
  testers.**

---

## iOS — TestFlight

### 1. Enrol (do this first, it gates everything)

<https://developer.apple.com/programs/> — $99/year. Approval usually takes a day
or two, occasionally longer if Apple asks for verification. As an individual you
can enrol with just your Apple ID; as a company you need a D-U-N-S number, which
adds time.

### 2. Fill in the submit config

`eas.json` has three `REPLACE_WITH_*` placeholders under `submit`. Fill them in
once you have the account:

- `appleId` — your Apple ID email
- `appleTeamId` — from <https://developer.apple.com/account> → Membership
- `ascAppId` — the numeric App ID from App Store Connect. You can leave this out
  on the very first run and let `eas submit` create the app record for you.

### 3. Build and submit

```bash
npm run build:testflight
```

That runs `eas build --profile preview-testflight --platform ios --auto-submit`.
EAS creates the certificates and provisioning profile for you — you never touch
Xcode, and you do not need a Mac.

Apple then processes the build for 5–10 minutes and emails you.

### 4. Invite testers — read this part carefully

TestFlight has two tiers, and the difference will decide your timeline:

**Internal testing** — up to 100 testers, available the moment processing
finishes, no review. But every tester must be a member of your App Store Connect
team, which means adding each one as a user on your Apple account.

**External testing** — up to 10,000 testers, invited by email or a public link,
no Apple account needed on their side. But the first build of each version must
clear **Beta App Review**, which typically takes a day.

For a handful of colleagues, internal is faster. For testers outside your
organisation, external is the only practical option and you should budget a day
for that first review.

You must create an internal group before App Store Connect will let you create
an external one.

Once a group exists you can target it from the command line:

```bash
npx eas-cli submit --platform ios --groups "QA Team" --what-to-test "Driver Hub: proof of delivery"
```

Builds expire 90 days after upload, on both tiers.

---

## Testing on a simulator

```bash
npm run build:dev:simulator
```

Produces a `.app` for the iOS Simulator rather than an `.ipa`. Useful for
checking layout across screen sizes without a device — but a simulator has no
camera, so proof-of-delivery capture cannot be tested there.

---

## What testers should send you

Every build shows its identity at the bottom of the Settings sheet (the gear
icon), for example:

```
Package Relay preview · 1.0.0 (14)
```

Ask for that line in every report. Build numbers auto-increment on the server
(`appVersionSource: "remote"`), so with several builds in circulation it is the
only way to know which artefact a bug came from.

---

## Known limits of this setup

- **No over-the-air updates.** `expo-updates` is not installed, so every JS
  change needs a full rebuild and a fresh install for every tester. If iteration
  gets painful, adding EAS Update is the fix — it pushes JS-only changes to
  installed builds in seconds. It is a real addition, not a config flag, so it
  is not done here.
- **Staging is a separate Supabase project**, reached by the `preview` and
  `preview-testflight` profiles and by Cloudflare Pages preview deployments. Test
  parcels never touch production tables, and staging cannot email a real driver,
  post to Slack, or spend the live Dojah wallet — see `docs/STAGING.md` for the
  setup and `npm run verify:staging` for the assertions that keep it that way.
- **iPad shows a scaled iPhone app.** `supportsTablet` is false. Fine for a
  delivery app; worth knowing if a tester picks up an iPad.
- **The microphone permission is switched off.** `expo-image-picker` asks for
  `RECORD_AUDIO` by default because it can record video. Package Relay only ever picks
  images, so it is disabled — if video capture is ever added, that has to come
  back or the picker will fail on Android.
- **The migrations still need running.** `supabase/01`–`10` must be applied to
  whichever project the testers hit, or the app will fail against a schema that
  does not match.

---

## Sources

- [Configure EAS Build with eas.json](https://docs.expo.dev/build/eas-json/)
- [Distribute an iOS app with TestFlight](https://docs.expo.dev/submit/testflight/)
- [Internal distribution](https://docs.expo.dev/build/internal-distribution/)
