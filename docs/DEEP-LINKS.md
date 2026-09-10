# Universal links — making the QR code work from a phone's camera

The cross-device photo handoff shows a QR code on the web dashboard that a phone
scans. **What that code contains decides whether the standard flow actually
works.**

Right now it contains `parcelmobile://capture/<id>` — the app's private scheme.
That has two problems, and they are the reason this file exists:

- A phone's **stock camera app will not offer it**. Camera scanners surface
  http(s) URLs and stay quiet on arbitrary schemes.
- With the app **not installed it fails silently** — no page, no store link,
  nothing.

An https universal link fixes both: the camera offers it because it is an
ordinary web address, the OS routes it to the app when installed, and to the
website when not. This is what Coinbase, Binance and Uber use for the same
handoff.

**Until a domain is configured the app knows it is on the weaker path and says
so** — the instruction under the QR reads "open Package Relay and scan from inside the
app" rather than "point your phone camera at it", because the second sentence
would be false. See `captureInstruction()` in `src/constants/links.ts`.

---

## What I need from you

**The domain.** A host you control and can put files on, e.g. `pkrelay.ng`. Tell me
and I will fill in the placeholders — or do it yourself with the steps below.

---

## Step 1 — set the domain

```bash
npx eas-cli env:set --name EXPO_PUBLIC_LINK_DOMAIN --value "pkrelay.ng" --environment preview --visibility plaintext
npx eas-cli env:set --name EXPO_PUBLIC_LINK_DOMAIN --value "pkrelay.ng" --environment production --visibility plaintext
```

Bare host. No `https://`, no trailing slash — it goes into both a URL and an
`applinks:` entry, which want different shapes around the same host.

Also add it to your local `.env` so `npm run web` behaves the same.

## Step 2 — replace the placeholders in `app.json`

```json
"ios":     { "associatedDomains": ["applinks:REPLACE_WITH_LINK_DOMAIN"] },
"android": { "intentFilters": [{ "data": [{ "host": "REPLACE_WITH_LINK_DOMAIN" }] }] }
```

These are baked into the native build, so they cannot come from an environment
variable read at runtime — they have to be literal, and changing them means a
new build.

## Step 3 — host the two association files

Both are already written, with placeholders, in `public/.well-known/`.

**`apple-app-site-association`**

- Replace `REPLACE_WITH_APPLE_TEAM_ID` with your Team ID from
  <https://developer.apple.com/account> → Membership.
- Result looks like `A1B2C3D4E5.com.loci.parcel`.
- Served at `https://<domain>/.well-known/apple-app-site-association`
- **No `.json` extension**, served as `application/json`, **no redirects**. Apple
  fetches it directly and a redirect fails the check silently.

**`assetlinks.json`**

- Replace `REPLACE_WITH_SHA256_FINGERPRINT` with your app signing certificate's
  SHA-256. EAS holds it:

  ```bash
  npx eas-cli credentials --platform android
  ```

  Take the **App signing key** fingerprint, not the upload key, if you are using
  Play App Signing — those differ and using the wrong one is the usual reason
  Android link verification fails.
- Served at `https://<domain>/.well-known/assetlinks.json`

Both must be reachable over HTTPS with a valid certificate, no authentication,
and no redirect.

## Step 4 — rebuild and check

```bash
npm run verify:build
npm run build:preview:android
```

Verify the association files are being served correctly:

- Android: <https://developers.google.com/digital-asset-links/tools/generator>
- iOS: fetch the AASA URL and confirm it returns JSON with no redirect.

Then scan the QR with the phone's ordinary camera app. If it opens Package Relay, it is
working. If it opens the browser and shows the "Open this in the Package Relay app" page,
the files are wrong or the build predates step 2.

---

## How it degrades

| State | QR contains | Stock camera | No app installed |
|---|---|---|---|
| No domain set | `parcelmobile://` | Ignores it | Nothing happens |
| Domain set, files not hosted | `https://` | Opens browser | Web fallback page |
| Fully configured | `https://` | Opens Package Relay | Web fallback page |

The middle row is safe — a wrong or missing association file means the link
opens the website instead of the app, which is a worse experience but not a
broken one.

---

## Still not built

**Liveness detection.** You have described this flow three times as face
recognition with liveness. It is neither. The phone takes a photograph and
stores it; nothing checks that a live person is in front of the lens, and a
printed photo passes. The cross-device handoff described here is the *transport*
that a real liveness check would use — it is not the check itself.

Adding one means a vendor SDK on the capture screen: Smile ID, Dojah and Prembly
all cover Nigeria. That is a contract, a per-check cost, and — per
`docs/PRIVACY-NOTES.md` — it moves this data into the NDPA's *sensitive*
category, because at that point the face is being processed to identify a
person.

## Sources

- [Universal Links vs custom URL schemes and QR fallback behaviour](https://qrtrac.com/guides/qr-code-app-store-deep-linking/)
- [Apple: QR code recognition on iOS](https://developer.apple.com/videos/play/tech-talks/206/)
- [Expo: linking into your app](https://docs.expo.dev/linking/into-your-app/)
