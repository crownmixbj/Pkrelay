# Shipping Package Relay to the App Store and Google Play

`docs/DISTRIBUTION.md` is about getting builds onto *testers'* phones. This file is
about the two store accounts, and about the things a public listing asks for that
a tester never does.

You have neither developer account yet, so this starts at enrolment. Everything in
the repo is already prepared — the first build runs the day the accounts exist.

⚠ **It starts with closed testing, because you had no preference and that is the
only answer that is cheap to be wrong about.** TestFlight and Play internal testing
put the real app on real phones in days instead of weeks, with one light review on
iOS and none on Android, and the build you promote to the public listing is the
same binary. Going straight to a public listing means fixing review rejections with
nobody using the app yet.

---

## What is already done

| | |
| --- | --- |
| `eas.json` | `production` profile: Android app-bundle, remote version source, auto-increment |
| | `preview` profile for staging, `preview-testflight` for iOS testers |
| `app.json` | name **Package Relay**, bundle `com.loci.parcel` on both platforms |
| | camera and photo-library purpose strings, and none for anything unused |
| Icons | `icon.png`, adaptive icon, favicon — see DISTRIBUTION.md for why it is three files |
| Staging | the `preview` profile carries staging credentials; production carries production's |

⚠ **The bundle identifier stays `com.loci.parcel`.** It is the app's identity on both
stores. Renaming it to something with `pkrelay` in it would be a *different app* —
a new listing, no reviews, no installed base. The LOCI residue is deliberate; see
CLAUDE.md.

---

## Step 1 — enrol (do this first, everything else waits on it)

### Apple Developer Program — $99/year

https://developer.apple.com/programs/enroll/

Enrol as an **organisation**, not an individual, if LOCI Logistics Technologies
Limited is the entity that should own the app. That needs a D-U-N-S number, which
is free and takes up to a fortnight to issue — start it today even if nothing else
moves. An individual enrolment is same-day but puts the app under your personal
name, and moving it later is a transfer request, not a setting.

### Google Play Console — $25, once

https://play.google.com/console/signup

Also choose organisation if the company should own it. Google now requires identity
verification and, for a new personal developer account, a period of closed testing
with at least 12 testers before a public release — another reason to start there.

---

## Step 2 — fill in what only you can

Three placeholders in `eas.json` under `submit.production.ios`:

```
"appleId":     your Apple ID email
"ascAppId":    the App Store Connect app ID (a number, created in step 3)
"appleTeamId": Membership details in the developer portal
```

For Android, EAS submits with a **service-account JSON key** from Google Cloud,
granted release permissions in Play Console. Put the file outside the repo and
point `EXPO_ANDROID_SERVICE_ACCOUNT_KEY_PATH` at it — never commit it.

⚠ The same rule as every other secret in this project: a repository is not a secret
store. There is already one service-role key in this repo's git history.

---

## Step 3 — create the two listings

**App Store Connect** → new app, bundle `com.loci.parcel`, name "Package Relay".
**Play Console** → new app, package `com.loci.parcel`.

Both will ask for things that do not exist yet:

- **Privacy policy URL** — must be publicly reachable. `https://app.pkrelay.com/legal`
  works once production is deployed; the content is in `src/constants/legal.ts`.
- **Support URL and contact email** — `support@pkrelay.com`.
- **Screenshots** — iPhone 6.7" and 6.5", Android phone. From a real build, not mockups.
- **Age rating / content questionnaire.**
- **Data safety (Play) and privacy nutrition labels (App Store)** — see below.

---

## Step 4 — build and submit

```bash
# staging, onto testers' phones
eas build --profile preview --platform all

# production
eas build --profile production --platform all
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

`appVersionSource: "remote"` with `autoIncrement` means EAS owns the build number
and the version code. Do not hand-edit them in `app.json`; you will fight it and
lose, and a duplicate build number is rejected at upload with a message that does
not say that.

---

## ⚠ The two things that will actually get this rejected

### 1. There is no way for a person to delete their own account

App Store Review Guideline 5.1.1(v): an app that lets you *create* an account must
let you *delete* it from inside the app. Pointing at support is explicitly not
enough, and this is a rejection every time, not a warning.

Package Relay has `erase_person`, it is granted to `authenticated`, and it is
reachable from the **admin** screens. There is no path for a sender or a driver to
erase themselves — and `src/constants/legal.ts` currently says *"You can ask us to
delete your account"*, which is the shape Apple refuses.

This is a build task, not a setting, and it is the one blocking item between here
and an App Store listing. It needs a screen, a confirmation, and an honest
statement of what survives deletion — some records tied to a completed delivery are
kept where the law requires, and the privacy copy has to match what the code does.

### 2. The data this app collects is the kind reviewers read carefully

Both stores want a declaration, and this app has an unusually heavy one: national
identification numbers, photographs of government ID, live selfies, bank account
details, home addresses, phone numbers and precise parcel movements.

Two specifics worth getting right before you are asked:

- **Identity documents are collected from a third party.** The guarantor is not a
  user of the app, has no account, and supplies their NIN, an ID photograph and a
  live photo through a web link. A data-safety form that describes only what *users*
  provide is incomplete, and the guarantor flow is the part a reviewer is most
  likely to ask about.
- **The NIN is held for manual review, not verified.** `docs/GUARANTOR.md` says so
  plainly. Do not let a store listing imply identity verification that is not
  happening.

Neither is a reason not to ship. Both are reasons to write the declarations from
what the code does rather than from what the product sounds like.

---

## Known limits of this setup

- **Push notifications do not work on web**, and there are currently zero push
  tokens on production. A driver on the website only sees a dispatch offer while
  the dashboard is open. A native build is what fixes that, and it is a real reason
  to want these store listings.
- **No EAS Update channel is configured** (`updates: {}` in `app.json`). Every
  change ships as a new store build. That is fine to start with and worth revisiting
  once the review cycle gets tedious.
- **No automated store screenshots.** They are taken by hand, and they go stale.

## Sources

- https://developer.apple.com/app-store/review/guidelines/ (5.1.1(v), account deletion)
- https://support.google.com/googleplay/android-developer/answer/14151465 (closed testing requirement)
- https://docs.expo.dev/submit/introduction/
