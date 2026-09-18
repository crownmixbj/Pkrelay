# The guarantor portal

How a person with no Package Relay account, holding nothing but a link, tells us
who they are — and why the design is shaped the way it is.

Read `supabase/migrations/20250101000039_guarantor_verification.sql` first: it
holds the token rules, and nothing here repeats them.

## The shape of it

```
driver submits application
  └─ trigger  invite_guarantor_on_submit
       ├─ mint_guarantor_invitation   → plaintext token, returned once, never stored
       ├─ queue_email('guarantor_invitation', …, token)   → Resend, via notify-events
       └─ queue_notification('guarantor_pending')          → the driver's inbox

guarantor opens  <site>/guarantor/<token>          (expo-router web route)
  ├─ open_guarantor_invitation(token)              ← the ONLY thing anon may call
  ├─ POST guarantor-portal {action:'upload-url'}   → signed upload URL for one path
  ├─ PUT  → Storage (guarantor-identity bucket)    ← bytes never touch the function
  ├─ POST guarantor-portal {action:'confirm-upload'}
  │     └─ asks Storage what landed → guarantor_document_recorded(...)
  └─ POST guarantor-portal {action:'submit'}
        └─ complete_guarantor_verification(token, payload, ip, user_agent)
             ├─ guarantor_verifications row (NIN, details, both wordings, signature)
             ├─ invitation marked spent
             ├─ application → ready_for_review
             └─ queue_notification('guarantor_completed')

driver's dashboard
  └─ my_guarantor_status()  → state, address, invited_at, email_sent_at, expiry, count
  └─ reinvite_guarantor(corrected_email?)  → new token, old one dies
```

## The three decisions worth knowing

**The guarantor never signs in, and the token is the whole credential.** 64 hex
characters from two v4 UUIDs, stored as a SHA-256 digest, single use, expiring in
thirty days (seven until migration 54 — see the trade-off recorded there), with
an attempt ceiling. 39 argues all of that at length.

**`anon` may call one function, and it is a read.** Before migration 51,
`complete_guarantor_verification` was granted to `anon` and the obvious way to
let a token holder upload was an insert policy on `storage.objects` for that same
role. Both work, and both make the token a credential spent directly against the
platform, which cannot tell a guarantor from a script holding the same string.
Every write now goes through the `guarantor-portal` edge function, which holds
the service role. `guarantor-harness.mjs` asserts the grants, so a later
migration that hands the write back to `anon` turns the suite red.

**Bytes do not pass through the function.** It mints a signed upload URL scoped
to one exact path and the client uploads to Storage directly — a government ID
photographed on a mid-range Android is commonly 4–8MB, and base64 through a Deno
function is a memory limit waiting to be found. `confirm-upload` then asks
Storage what actually arrived; the size and type on the `guarantor_documents` row
are Storage's answer, never the client's claim.

Document paths are `<invitation_id>/<kind>`, derived by
`guarantor_document_slot` and never accepted from a caller, and deliberately
carry no file extension — so a retake overwrites the first attempt rather than
orphaning a JPEG in a bucket nothing can garbage-collect.

## What the driver sees, and what they do not

`my_guarantor_status` returns the address the invitation went to, when the link
was minted, when the provider actually accepted the email (null while it is still
in the outbox — two different facts, and the card says which is which), the
expiry, and how many invitations have been sent. It returns no token, no NIN, and
nothing the guarantor typed. A driver who could read the token could complete
their own guarantor check, which is the fraud the whole feature exists to prevent.

`reinvite_guarantor` is the way out of a stuck application and it belongs to the
driver, including with a corrected address — a typo is the commonest cause of
silence, and re-inviting retires the live link so a stranger is not left holding
one.

## ⚠ The suretyship has not been reviewed by a lawyer

`SURETYSHIP_CLAUSE` in `src/constants/guarantor.ts` asks a person with no
account, no separate consideration and no negotiation to accept joint liability
for somebody else's conduct, capped at the declared value of the goods, for three
named causes: theft, deliberate conversion, and gross negligence.

Whether a click-through suretyship of that kind is enforceable in Nigeria — and
against whom, and on what evidence — is a question for a Nigerian lawyer.
`GUARANTOR_SURETYSHIP_REVIEW_REQUIRED` is `true` and
`verify-guarantor-portal.ts` fails if it lies, on the same arrangement as
`CONTACT_IS_PLACEHOLDER`.

What the software does guarantee is narrower, and is the part that is actually
achievable in code: the exact wording shown on screen is the wording stored on
the row (the client posts the constant it rendered), the typed name must match
the full name given above it, and the timestamp, the observed IP, the user agent,
a photograph of a government ID and a live photograph taken at the moment of
signing all live in the same row and cannot be altered afterwards. That is a
record. Whether it is a remedy is not a claim this codebase makes, and the
portal's own copy does not make it either.

## Deploying it

Migration 51 and the edge function have to land together: 51 revokes
`complete_guarantor_verification` from `anon`, and until `guarantor-portal` is
deployed there is nothing else that can call it.

```bash
# 1. the schema (staging first)
supabase db push                      # 48, 49, 50, 51 in order

# 2. the function — no new secrets; SUPABASE_URL and
#    SUPABASE_SERVICE_ROLE_KEY are injected by the platform
supabase functions deploy guarantor-portal

# 3. the web build, because the portal is a web route
npm run build:web                     # → dist/, then Cloudflare Pages
```

The bucket is created by the migration (`guarantor-identity`, private, 10MB,
images plus PDF). Nothing needs to be clicked in the dashboard.

Check afterwards: submit an application on staging with a guarantor address you
control, confirm the email arrives with a `/guarantor/<token>` link, complete the
form, and confirm the driver's dashboard card moves to "Guarantor verified" and
the admin summary shows four digits of the NIN and both document paths.

## Still owed

- **Erasure.** `erase_person` in `20250101000009_bans.sql` overwrites the
  guarantor columns on `driver_applications`. It does not touch
  `guarantor_verifications` or `guarantor_documents`, and nothing deletes the
  objects in the bucket. A guarantor is a data subject in their own right under
  the NDPA with a deletion right of their own, and at the moment there is no way
  for them to exercise it. This wants its own migration and its own harness
  assertions; it was left out of 51 deliberately rather than bolted on, because
  the erasure path is pinned by `erase-harness.mjs` and is worth changing
  carefully.
- **Retention.** Nothing expires these records. Same open question as
  `sender-identity`, and `RETENTION_UNDECIDED` in `src/constants/legal.ts` is
  still true.
- **Admin review UI.** `admin_guarantor_summary` returns everything a reviewer
  needs, including both document paths and the flag for "gave a different
  address from the one the driver typed". Nothing renders it yet — the admin
  screens still show what 39 gave them.
- **Dojah on the guarantor's NIN.** The NIN is stored for manual review and
  compared by a person against the uploaded ID and the live photo. The columns
  and the edge function are shaped so a Dojah lookup can be dropped in without a
  migration, the way `verify-identity` does it for drivers and senders.
