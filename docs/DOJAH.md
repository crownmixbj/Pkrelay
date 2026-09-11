# Dojah liveness — sandbox integration

Wired and running in **sandbox**. Nothing works until you add the keys; see
"What I need from you" below.

## What this check actually is

`POST /api/v1/ml/liveness` is a **passive** liveness check. Dojah is handed one
still image and reports how likely it is to be a live person.

**What that closes:** a printed photograph held up to the lens. The old bare
selfie accepted those; this rejects them. That is a real improvement and it is
the reason to do this.

**What it does not close:** a video replayed on a second screen. Nothing asks
the person to blink, turn their head, or follow a prompt, so a good-quality
replay is a route that stays open.

**Active liveness exists**, but through Dojah's EasyOnboard widget rather than
this endpoint — their dashboard calls it Basic and Advanced Liveness. Adopting
it means replacing Package Relay's own capture screen with Dojah's hosted UI, which is a
bigger change to the flow you designed. Worth doing if replay attacks turn out
to matter; not worth doing on a guess.

## Sandbox is mock data

Dojah's documentation is explicit:

> Sandbox results are not real verifications. Never use mock data to make a live
> trust decision.

So every verdict records which environment produced it, and a sandbox pass reads
**"Liveness check passed (test mode — not a real verification)"** wherever a
sender or an admin sees it. `npm run verify:liveness` fails if that label is
removed.

Sandbox calls never draw from your wallet, so you can test as much as you like.

## Where the secret lives

**Not in the app.** Anything prefixed `EXPO_PUBLIC_` is compiled into the bundle
and readable by anyone who installs it — a Dojah key there is a key someone else
can spend your wallet with.

The check runs in a Supabase Edge Function:

```
client  →  session id only
             ↓
edge function  →  reads the photo from the private bucket (service role)
               →  calls Dojah with the secret
               →  writes the verdict where no client can
```

The client never re-sends the image, so it cannot upload one photo and submit a
different one for checking.

A verify assertion walks the whole of `src/` and fails if `DOJAH_SECRET_KEY` or
`DOJAH_APP_ID` appears anywhere in it.

---

## What I need from you

Your sandbox **App ID** and **secret key**, from the dashboard under
Developers → API keys. Then:

```bash
supabase functions deploy verify-liveness
supabase secrets set DOJAH_APP_ID="..."
supabase secrets set DOJAH_SECRET_KEY="..."
supabase secrets set DOJAH_ENVIRONMENT="sandbox"
```

Run `supabase/migrations/20250101000014_liveness.sql` as well — the function writes columns that file
creates.

`DOJAH_ENVIRONMENT` **defaults to sandbox when unset**, and only the exact word
`production` switches it. A misconfigured deploy that silently called production
would spend real money on every parcel posted.

## Going live, later

1. Fund the wallet — production returns `402` on a low balance.
2. `supabase secrets set DOJAH_ENVIRONMENT="production"` and swap in the live
   keys.
3. Watch `admin_liveness_summary()` for a few days.

## The threshold

`LIVENESS_THRESHOLD = 70`, in `supabase/functions/verify-liveness/dojah.ts`.

Dojah's own example of a clean capture scores 98, so a genuine selfie in
reasonable light clears 70 comfortably. Setting it at 90 would start rejecting
people in poor light — on a Nigerian street at dusk, that is most of them. A
false reject means a sender who cannot post a parcel at all, which is worse than
a marginal photo reaching a record nobody may ever read.

Both Dojah's own `liveness_check` boolean and this threshold have to agree
before a photo passes.

## Failed is not the same as unavailable

| Verdict | Means | Blocks posting |
|---|---|---|
| `passed` | Dojah says live, above threshold | No |
| `failed` | No face, several faces, or below threshold | **Yes** |
| `unavailable` | Dojah down, key wrong, wallet empty, not configured | No |

**This distinction is the most important thing in the integration.** A 401 from
a wrong key and a 402 from an empty wallet are statements about Package Relay, not about
the person holding the phone. Treating them as failures would mean a lapsed
Dojah subscription silently stops every parcel in the country.

The cost is that an outage produces parcels with unchecked photos. That is
visible — `admin_liveness_summary()` groups by status, and a rising
`unavailable` count is the signal that something is quietly broken.

## Still outstanding

- **`docs/PRIVACY-NOTES.md` needs updating and re-reviewing.** This changes the
  NDPA position materially: the photo is now processed by a third party for the
  purpose of assessing whether it is a real person. That is closer to biometric
  processing than a stored photograph was, and Dojah becomes a data processor
  you need an agreement with.
- **Retention.** Unchanged and still unresolved.
- **The provider payload is discarded.** Dojah returns estimated age, gender,
  emotion and facial hair. None is needed to post a parcel and none is kept —
  only the verdict, the probability and the environment leave the function.

## Sources

- [Environments — base URLs](https://docs.dojah.io/api-reference/get-started/environments)
- [Liveness Check endpoint](https://docs.dojah.io/api-reference/biometrics-liveness/liveness-check)
- [Sandbox & test data](https://docs.dojah.io/api-reference/get-started/sandbox-test-data)
- [Authentication — the Bearer gotcha](https://docs.dojah.io/api-reference/get-started/authentication)
