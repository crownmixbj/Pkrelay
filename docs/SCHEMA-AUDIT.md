# LOCI — live Supabase schema audit

Read directly from the project on 30 August 2026, via the Supabase MCP connection
(`pg_catalog`, `information_schema`, `storage.buckets`). Nothing here is inferred
from the files in `supabase/` — every statement below was queried.

---

## 0. The headline: the database is no longer behind the code

Every migration this session shipped is **already applied**. I probed for the
object each one creates rather than trusting a version table:

| Migration | Probe | Present |
| --- | --- | --- |
| 30 driver wallet | `request_payout` | yes |
| 31 document expiry | `record_document` | yes |
| 32 dispatch mode | `set_dispatch_mode` | yes |
| 34 identity handoff | `attach_identity_result` | yes |
| 36 parcel photos | `attach_parcel_photo` | yes |
| 37 admin sender identity | `admin_reveal_sender_identity` | yes |
| 38 transactional email | `queue_email` | yes |
| 39 guarantor verification | `open_guarantor_invitation` | yes |
| 40 review controls | `guard_application_decision` | yes |
| 41 sender ID review | `admin_identity_queue`, `admin_review_identity` | yes |
| 42 verified senders only | `is_verified_sender` | yes |
| 43 review sees the selfie | `sender_selfie_path` | yes |
| 44 selfie with the parcel | `attach_capture_on_insert` + trigger `on_booking_attach_capture` | **partly — see §5.0** |
| 45 Google identities | `handle_new_user` reads `full_name` | yes |

Confirmed at the policy level too: the `bookings` insert `WITH CHECK` contains
`is_verified_sender()` (42), and the `driver_applications` insert policy accepts
`pending` **and** `pending_guarantor` (40). Both were the fixes that unblocked
signup and posting.

> `supabase_migrations.schema_migrations` is **empty**. That is expected — these
> were run by hand in the SQL editor, which does not register there. It does mean
> the CLI has no idea what state the project is in, which matters the day you want
> `supabase db diff`. See §6.

The 45 backfill also took: **0 profiles have a blank `full_name`** and **0 have a
blank `phone`**.

---

## 1. Tables

20 tables in `public`. **RLS is enabled on all 20.** 33 policies total.

| Table | Rows | Policies | Purpose |
| --- | ---: | ---: | --- |
| `profiles` | 9 | 3 | account, admin flag, driving ban, erasure tombstone |
| `bookings` | 6 | 3 | the parcel |
| `driver_applications` | 5 | 3 | driver onboarding, incl. NIN / bank / guarantor |
| `driver_documents` | 25 | 1 | uploaded documents, expiry, review state |
| `document_kinds` | 5 | 1 | reference list; which kinds block dispatch |
| `driver_journeys` | 12 | 3 | scheduled routes and flash shifts |
| `dispatch_offers` | 10 | 1 | offer rotation |
| `driver_earnings` | 1 | 1 | per-delivery ledger |
| `payout_requests` | 0 | 1 | withdrawal |
| `payout_change_requests` | 0 | 1 | 48-hour bank-change cooling window |
| `sender_identity` | 3 | 1 | NIN, slip, reference + candidate selfie, review |
| `photo_capture_sessions` | 26 | 2 | QR handoff selfie sessions, liveness verdicts |
| `guarantor_invitations` | 0 | **0** | token digests (deny-all by design) |
| `guarantor_verifications` | 0 | **0** | guarantor NIN + consent (deny-all by design) |
| `driver_edit_history` | 0 | 1 | before/after trail for profile edits |
| `email_outbox` | 2 | 1 | deduplicated transactional mail |
| `hubs` | 17 | 3 | pickup/dropoff locations |
| `push_tokens` | 0 | 4 | Expo device tokens |
| `role_grants` | 1 | 1 | admin promote/demote audit |
| `app_events` | 94 | 2 | application log |

The two tables with **zero policies** are correct, not an oversight: RLS is on and
nothing matches, so they are unreachable from any client key. They are read and
written only by `SECURITY DEFINER` functions (`open_guarantor_invitation`,
`complete_guarantor_verification`), which is exactly how a signed-out guarantor
portal should work.

---

## 2. Columns

### `bookings` (50 columns)

`id` uuid PK · `tracking_id` text UNIQUE · `delivery_type` text CHECK(local|interstate) ·
`pickup_mode`/`dropoff_mode` text CHECK(hub|meetpoint|doorstep) · `origin_city` ·
`destination_city` · `pickup_area` · `dropoff_area` · `pickup_address` ·
`dropoff_address` · `pickup_contact_name` · `sender_phone` · `recipient_name` ·
`recipient_phone` · `item_description` · `item_photo_uri` (dead — never populated) ·
`category` · `weight` numeric CHECK(0 < w ≤ 100) · `declared_value` numeric CHECK(≥0) ·
`fragile` bool · `notes` · `estimated_fee` numeric CHECK(≥0) · `sender_id` uuid FK ·
`status` text CHECK(Booked|Assigned|Picked Up|In Transit|Out for Delivery|Delivered|Cancelled) ·
`driver` text · `driver_id` uuid FK · `accepted_at` · `created_at` ·
`pickup_lat`/`pickup_lng`/`dropoff_lat`/`dropoff_lng` numeric · `picked_up_at` ·
`delivered_at` · `received_by` · `proof_path` · `proof_note` · `cancelled_at` ·
`cancelled_by` uuid FK · `cancelled_role` CHECK(sender|driver) · `cancellation_reason` ·
`sender_photo_path` · `sender_photo_at` · `liveness_status` CHECK(passed|failed|unavailable) ·
`liveness_probability` · `liveness_environment` CHECK(sandbox|production) ·
`liveness_checked_at` · `item_photo_path` · `capture_session_id` uuid FK **(44)**

### `profiles` (8)

`id` uuid PK→auth.users · `full_name` · `phone` · `is_admin` bool · `created_at` ·
`driving_banned_at` · `driving_ban_reason` · `deleted_at`

### `driver_applications` (39)

`id` PK · `user_id` UNIQUE FK · `reference` UNIQUE · `full_name` · `phone` · `email` ·
**`nin`** · `address` · `state` · `base_city` · `vehicle_type` · `vehicle_colour` ·
`plate_number` · `license_id` · `guarantor_name` · `guarantor_phone` ·
`guarantor_relationship` · `guarantor_address` · **`guarantor_nin`** ·
`guarantor_email` · `bank_name` · **`account_number`** · `account_name` · `kin_name` ·
`kin_phone` · `kin_relationship` · `documents` jsonb · `status` CHECK(pending_guarantor|
ready_for_review|pending|under_review|approved|rejected) · `review_note` ·
`reviewed_by` FK · `reviewed_at` · `submitted_at` · `confirmation_email_sent_at` ·
`confirmation_email_error` · `identity_status` CHECK(matched|mismatch|unavailable|skipped) ·
`identity_confidence` · `identity_environment` · `identity_checked_at`

### `sender_identity` (14)

`user_id` PK/FK · `nin` CHECK(`^[0-9]{11}$`) · `slip_path` · `reference_path` ·
`candidate_path` **(41)** · `status` CHECK(unverified|pending|verified|flagged|**rejected**) ·
`confidence` · `environment` · `verified_at` · `checked_at` · `created_at` ·
`review_note` · `reviewed_by` FK · `reviewed_at` **(all 41)**

### `photo_capture_sessions` (16)

`id` PK · `owner_id` FK · `created_at` · `expires_at` (now + 10 min) · `photo_path` ·
`completed_at` · `consumed_at` · `liveness_*` (4) · `identity_*` (4)

### `driver_journeys` (12)

`id` PK · `driver_id` FK · `origin_city` · `destination_city` · `departs_after` ·
`departs_before` · `capacity_kg` CHECK(>0) · `vehicle_type` ·
`status` CHECK(open|paused|completed|cancelled) · `created_at` ·
`mode` CHECK(scheduled|flash) · `departure_time`

### `dispatch_offers` (8)

`id` PK · `booking_id` FK · `journey_id` FK · `driver_id` FK ·
`status` CHECK(offered|accepted|declined|expired) · `offered_at` ·
`expires_at` (now + 10 min) · `responded_at`

### `driver_documents` (13)

`id` PK · `driver_id` FK · `application_id` FK · `kind` FK→document_kinds ·
`path` · `expires_at` date · `status` CHECK(pending|verified|rejected) ·
`review_note` · `reviewed_by` FK · `reviewed_at` · `uploaded_at` ·
`reminder_stage` · `reminded_at`

### `document_kinds` (6)

`key` PK · `label` · `expiry_required` · `expiry_allowed` · `blocks_dispatch` · `sort_order`

### `driver_earnings` (8)

`id` PK · `driver_id` FK · `booking_id` FK **UNIQUE** · `gross` CHECK(≥0) ·
`commission_rate` CHECK(0 ≤ r < 1) · `commission` CHECK(≥0) · `net` CHECK(≥0) · `earned_at`

### `payout_requests` (10)

`id` PK · `driver_id` FK · `amount` CHECK(>0) · `bank_name` · `account_number` ·
`account_name` · `status` CHECK(requested|paid|failed|cancelled) · `reference` ·
`failure_reason` · `requested_at` · `settled_at`

### `payout_change_requests` (13)

`id` PK · `driver_id` FK · `bank_name` · `account_number` · `account_name` ·
`previous_*` (3) · `status` CHECK(pending|applied|cancelled) · `requested_at` ·
`effective_at` (now + 48h) · `settled_at` · `cancelled_by` FK

### `guarantor_invitations` (9)

`id` PK · `application_id` FK · `token_hash` **UNIQUE** (SHA-256 digest, never the token) ·
`guarantor_name` · `guarantor_email` · `created_at` · `expires_at` · `completed_at` · `attempts`

### `guarantor_verifications` (7)

`invitation_id` PK/FK · `application_id` FK · **`nin`** CHECK(`^[0-9]{11}$`) ·
`consented_at` · `consent_text` · `submitted_ip` · `created_at`

### `driver_edit_history` (9)

`id` PK · `driver_id` FK · `field` · `risk` CHECK(low|high) · `old_value` · `new_value` ·
`actor_id` FK · `suspended_approval` · `created_at`

### `email_outbox` (9)

`id` PK · `kind` CHECK — 12 kinds incl. `sender_verification_rejected` **(41)** ·
`subject_id` · `recipient` · `payload` jsonb · `created_at` · `sent_at` · `error` · `attempts` ·
UNIQUE(`kind`, `subject_id`) — this is the "nothing sends twice" guarantee

### `hubs` (14)

`id` text PK · `name` · `area` · `city` · `address` · `hours` · `phone` · `services` text[] ·
`flagship` · `lat` CHECK(3.5–14.5) · `lng` CHECK(2.5–15.5) · `active` · `updated_at` · `updated_by` FK

### `push_tokens` (5)

`token` text PK · `user_id` FK · `platform` CHECK(ios|android|web) · `created_at` · `last_seen_at`

### `role_grants` (7)

`id` PK · `subject_id` FK · `actor_id` FK · `role` CHECK(='admin') · `granted` bool ·
`reason` · `created_at`

### `app_events` (7)

`id` bigint identity PK · `level` CHECK(info|warning|error) · `area` · `message` ·
`context` jsonb · `actor_id` FK default `auth.uid()` · `created_at`

---

## 3. Foreign keys

24 constraints. Every one either points at `auth.users(id)` or at another
`public` table — there are no orphan references.

**To `auth.users(id)`** (16): `profiles.id` · `bookings.sender_id` ·
`bookings.driver_id` · `bookings.cancelled_by` · `driver_applications.user_id` ·
`driver_applications.reviewed_by` · `driver_documents.driver_id` ·
`driver_documents.reviewed_by` · `driver_journeys.driver_id` ·
`dispatch_offers.driver_id` · `driver_earnings.driver_id` ·
`payout_requests.driver_id` · `payout_change_requests.driver_id` ·
`payout_change_requests.cancelled_by` · `driver_edit_history.driver_id` ·
`driver_edit_history.actor_id` · `sender_identity.user_id` ·
`sender_identity.reviewed_by` · `photo_capture_sessions.owner_id` ·
`push_tokens.user_id` · `role_grants.subject_id` · `role_grants.actor_id` ·
`hubs.updated_by` · `app_events.actor_id`

**Between public tables** (8):

```
dispatch_offers.booking_id          -> bookings.id
dispatch_offers.journey_id          -> driver_journeys.id
driver_earnings.booking_id          -> bookings.id          (UNIQUE: one earning per parcel)
bookings.capture_session_id         -> photo_capture_sessions.id     (44)
driver_documents.application_id     -> driver_applications.id
driver_documents.kind               -> document_kinds.key
guarantor_invitations.application_id -> driver_applications.id
guarantor_verifications.invitation_id -> guarantor_invitations.id
guarantor_verifications.application_id -> driver_applications.id
```

---

## 4. Missing indexes

52 indexes exist. **15 foreign keys have no covering index.** Postgres does not
create one for you, and an unindexed FK costs twice: joins on it seq-scan, and
every `DELETE` on the parent must scan the whole child table to check the
constraint.

### Worth adding now — these are on the hot paths

```sql
-- Dispatch reads offers by journey on every sweep. 10 rows today, one row per
-- (parcel x driver) attempt forever.
create index if not exists dispatch_offers_journey_idx
  on public.dispatch_offers (journey_id);

-- The admin application drawer loads every document for one application.
create index if not exists driver_documents_application_idx
  on public.driver_documents (application_id);

-- 44 joins this on the parcel drawer and on the identity queue.
create index if not exists bookings_capture_session_idx
  on public.bookings (capture_session_id);

-- Read by application id when an admin opens a guarantor record.
create index if not exists guarantor_verifications_application_idx
  on public.guarantor_verifications (application_id);
```

### Worth adding for deletes, not for reads

Account erasure (`erase-auth-user`) deletes an `auth.users` row. Every one of the
unindexed FKs below forces a full seq-scan of its table to satisfy the
constraint. Cheap today; each is a table that only grows.

```sql
create index if not exists bookings_cancelled_by_idx            on public.bookings (cancelled_by);
create index if not exists app_events_actor_idx                 on public.app_events (actor_id);
create index if not exists driver_edit_history_actor_idx        on public.driver_edit_history (actor_id);
create index if not exists driver_applications_reviewed_by_idx  on public.driver_applications (reviewed_by);
create index if not exists driver_documents_reviewed_by_idx     on public.driver_documents (reviewed_by);
create index if not exists sender_identity_reviewed_by_idx      on public.sender_identity (reviewed_by);
create index if not exists payout_change_cancelled_by_idx       on public.payout_change_requests (cancelled_by);
create index if not exists role_grants_subject_idx              on public.role_grants (subject_id);
create index if not exists role_grants_actor_idx                on public.role_grants (actor_id);
create index if not exists hubs_updated_by_idx                  on public.hubs (updated_by);
```

### Deliberately not recommended

`driver_documents.kind` → `document_kinds.key` is a 5-row lookup table. An index
on the child would never be chosen by the planner and would only slow writes.

---

## 5. Security

### What is already right

Not faint praise — these are the four things that most commonly go wrong on a
Supabase project, and none of them is wrong here.

- **RLS on all 20 tables**, with policies on 18 and deliberate deny-all on the two
  guarantor tables.
- **All 104 `SECURITY DEFINER` functions pin `search_path`.** A definer function
  with a mutable search_path is a privilege-escalation primitive; there are zero.
- **Every policy wraps `auth.uid()` in `(select auth.uid())`**, so it is evaluated
  once per statement rather than once per row. This is the single most common
  Supabase performance advisory and it does not apply here.
- **No extensions installed in `public`.**
- **All five storage buckets are private**, MIME-restricted, capped at 10 MB:
  `sender-identity`, `sender-photo`, `driver-documents`, `parcel-photo`,
  `delivery-proof`. 13 storage policies. Nothing holding a face or a document is
  world-readable.
- **`anon` has no table grants at all** and can execute only 15 non-trigger
  functions: pure helpers (`normalize_ng_phone`, `journey_matches`,
  `next_booking_status`, `document_state`…), the three `is_*` predicates which
  return false for a signed-out caller, and the two guarantor-portal functions
  `open_guarantor_invitation` / `complete_guarantor_verification` — which is the
  point of a portal a guarantor reaches without an account, and both are gated on
  a single-use token digest.

### Findings

Each of the first four is fixed by `supabase/migrations/20250101000046_rls_hardening.sql` and proved by
`scripts/pg/rls-hardening-harness.mjs`, which applies the whole migration chain
to a real Postgres, exercises the rule under RLS, then breaks each guard on
purpose to confirm the assertion notices.

**5.0 — A parcel can be posted with no selfie at all. (Highest.)**
Migration 44 is half-applied. The column, the function and the trigger are on the
database; the policy at the end of that file is not — the live
`"sender creates own"` check ends at `is_verified_sender()` with no
`sender_photo_path is not null` term.

That would be a missing backstop on its own. It is worse, because the trigger was
written knowing the policy would be there:

```
if new.capture_session_id is null then
  -- Left for the policy to refuse rather than raised here.
  return new;
end if;
```

The trigger declines to raise and hands the refusal to a policy that was never
installed. An insert omitting `capture_session_id` passes both and becomes a
parcel with `sender_photo_path` null — the exact thing the selfie exists to
prevent. Three of the six existing rows have a null path. Neither half is wrong;
only the pair is a rule, and only one half is here.

**5.1 — A driver can mark a parcel delivered without delivering it, and be paid.**
`advance_booking` enforces four things: only the carrier, approval still active,
one stage at a time, and a name before `Delivered`. All four are real. None is
reachable, because the `"advance own parcel"` policy lets the carrier issue the
UPDATE directly, and `bookings_guard_immutable` locks only `sender_id`,
`tracking_id`, `estimated_fee` and `created_at` — not `status`.

`record_delivery_earning` fires on any transition into `Delivered` and inserts a
`driver_earnings` row for the full fee. So the shortest path to being paid for a
delivery that never happened was one request:

```
PATCH /rest/v1/bookings?id=eq.<parcel>   {"status": "Delivered"}
```

No pickup, no proof, no recipient name, and it works after the driver has been
banned. The same gap lets a client forge a cancellation record. RLS is row-level
and this is a column rule, so the fix is a trigger — the pattern
`profiles_guard_admin` already uses.

**5.2 — A ban only holds until the banned driver presses a button.**
`driver_journeys` requires `is_approved_driver()` to *create* a journey and only
ownership to *update* one. A driver banned or unapproved while holding an open
journey can set it back to `open`, and `sweep_for_journey` resumes offering them
parcels.

**5.3 — Any signed-in account can forge a system entry in the audit log.**
`app_events`' insert check is `actor_id is null or actor_id = auth.uid()`. Null is
how a genuine platform-side event is recorded, so this lets a user write an
unattributable entry — in the table an incident would be reconstructed from. The
column already defaults to `auth.uid()`, so honest inserts never send it.

**5.4 — `anon` and `authenticated` hold TRUNCATE on all 20 tables.**
The tail of Supabase's default `grant all`. TRUNCATE is **not subject to RLS** —
one statement empties `bookings` with no policy consulted. PostgREST never emits
TRUNCATE, so this was not reachable through the API and is not evidence of a
breach; it is a grant whose only protection is that the client is not currently
asking for it. Both roles also hold DELETE on every table, blocked only by the
absence of a DELETE policy, and `anon` holds INSERT and UPDATE on all 20.

**5.5 — `email_outbox`'s policy is the only one attached to PUBLIC.**
Every other policy names `authenticated`. `is_admin()` returns false for a
signed-out caller so nothing leaked, but a table of recipient addresses and
message payloads is the last one that should rest on a single function returning
the right answer.

**5.6 — Sensitive data concentrates in three places.** `driver_applications` holds
a plaintext NIN, a guarantor NIN, and a bank account number in one row, readable
by the applicant and by any admin. `guarantor_verifications` holds a NIN plus a
submitted IP. `sender_identity` holds a NIN and two selfie paths. All are
correctly gated, but this is the blast radius if a single admin account is taken
over — and `profiles.is_admin` is the only thing standing there. Consider:
requiring MFA on admin accounts, and logging admin reads of these tables the way
identity reveals already are.

**Withdrawn — the earlier claim that `hubs` has an `anon` read policy `anon`
cannot use.** That came from `information_schema.role_table_grants`, which only
shows grants visible to the querying role's own memberships and returned nothing
for `anon`. `has_table_privilege` is the authoritative check and says `anon` holds
SELECT on all 20 tables. The `"hubs are public"` policy works. The same bad query
also hid finding 5.4 above, which is the real one.

**5.7 — `profiles` has two permissive SELECT policies** (`"read own profile"` and
`"admins read all profiles"`). Both are evaluated for every row for every caller.
Harmless at 9 rows; merge them into one `id = (select auth.uid()) or is_admin()`
when the table grows.

**5.8 — `is_admin()` is called unwrapped in 6 policies.** It is `STABLE` and
`SECURITY DEFINER`, so it is a per-row function call rather than a per-statement
InitPlan. On `app_events` (94 rows and growing fastest of any table) an admin's
read runs it 94 times. Wrapping it — `(select is_admin())` — makes it one call.
Same for `is_approved_driver()` in the `bookings` read policy, which runs on the
open-parcel feed.

**5.9 — Auth-level settings are outside the database and were not checked here.**
Leaked-password protection (HIBP), MFA enforcement, and OTP expiry live in the
Supabase Auth dashboard, not in `pg_catalog`. Given §5.6, admin MFA is the one I
would not leave off.

### On FORCE ROW LEVEL SECURITY — deliberately not recommended

All 20 tables are owned by `postgres` and none has `FORCE ROW LEVEL SECURITY`, so
RLS does not apply to the owner. That reads like a finding and is the opposite of
one: all 104 `SECURITY DEFINER` functions run as `postgres` and depend on
bypassing RLS to do their work — `admin_identity_queue`, `advance_booking`,
`sender_selfie_path` and the rest. Turning FORCE on would break every one of
them. It is listed here so it does not get "fixed" later.

### The search_path question, answered precisely

The request was whether the definer functions are safe from search_path
manipulation, so "proconfig is set" is not a sufficient answer — `search_path=public`
is set and still unsafe if a caller can create objects in `public`. Checking the
pinned value itself:

- All 104 functions pin `search_path=""`. Not `public`, not a mix. The empty
  search path resolves nothing implicitly, so every reference inside those bodies
  is schema-qualified or fails at creation.
- `has_schema_privilege` says `anon`, `authenticated` and `PUBLIC` all lack CREATE
  on `public`, so there is nowhere to plant a shadowing object even if a function
  were sloppy.
- There are no views at all in `public`, so the `security_definer_view` class of
  advisory does not apply.

That is the strongest of the three available postures, and it holds without
exception.

---

## 6. The migration, and how it was checked

`supabase/migrations/20250101000046_rls_hardening.sql` — re-runnable, safe to run twice. Sections 0–3 are
the security fixes above, 5–6 merge and wrap the policies, 7 revokes the grants,
8 adds the indexes from §4.

It was not checked by reading. `scripts/pg/rls-hardening-harness.mjs` (wired into
`npm run verify` as `verify:pg-rls-hardening`) applies all 46 migrations in order
to a real Postgres via PGlite — only `20250101000005_storage_and_alerts.sql` is skipped, for
`pg_net`, which PGlite has no build of — then, under `set role authenticated`
with RLS in force:

- refuses a parcel with no capture session, and still posts an honest one with the
  selfie bound to it;
- refuses a direct write to `status`, `received_by` and the cancellation columns
  from the carrying driver, while `advance_booking` still advances the parcel one
  stage;
- lets an approved driver reopen a journey and stops a banned one;
- refuses a null and an impersonated `actor_id` on `app_events` while an ordinary
  log line still writes.

Then each guard is broken on purpose — five mutants — and all five are caught.
Two of those mutants found bugs in the harness rather than in the migration: the
banned-driver check was asserting that the UPDATE *threw*, when a policy that
hides a row silently updates zero rows instead, so it would have passed against a
database with no policy at all; and a mutant reported as "killed" was only failing
to compile, because `String.replace` reads `$$` in a replacement as an escaped
`$` and had turned `as $$` into `as $`.

## 7. Housekeeping

`supabase_migrations.schema_migrations` is empty because everything was applied
through the SQL editor. The schema is right; the CLI just cannot see how it got
there. To make `supabase db diff` and `supabase db push` usable later, register
the files as already-applied rather than re-running them:

```
supabase migration repair --status applied <version>
```

…or accept the SQL editor as the process of record and keep `supabase/*.sql`
as the ordered, re-runnable log it already is. Either is fine; the current
in-between state is what is not.
