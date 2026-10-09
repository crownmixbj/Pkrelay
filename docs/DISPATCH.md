# Dispatch: the two directions

**Admin → Dashboard → Dispatch** (`/admin?section=dispatch`) now answers the
matching question from both ends.

| Direction | Question | Built from |
| --- | --- | --- |
| Parcel-first | "Why has this parcel not moved?" | `unassigned_parcels` → `assignable_drivers` → `admin_assign_parcel` (25, 32) |
| Driver-first | "Why is this driver idle?" | `admin_driver_availability` → `admin_waiting_drivers` → `admin_parcels_for_driver` → `admin_assign_parcel` (70) |

Both write through the same function. There is deliberately no second
assignment path: `admin_assign_parcel` holds the four refusals, the offer
settling and the audit line, and a parallel writer would drift from all of them.

## What "waiting" means

A driver is in the list when **all** of these hold:

```
approved application, not banned, not erased
no expired document that blocks dispatch
an open journey whose window has not closed
no offer outstanding to them
nothing undelivered in their hands
```

The window test is `coalesce(departure_time, departs_before) > now()` — the
same expression `journey_matches` (26) gates on, character for character. A
second definition would drift, and the symptom is a driver listed as available
whom dispatch has already written off, which reads as dispatch being broken.

`is_approved_driver()` (09) reads `auth.uid()` and can only answer about the
caller, so 70 writes out its three conditions instead. `assignable_drivers` (32)
checks neither the ban nor the erasure — a gap in that function, not a precedent.

## What the list means depends on the mode

- **Manual mode** — nobody is being offered anything, so every driver on shift
  sits here until somebody places a parcel. This is the work queue.
- **Automatic mode** — declaring a shift sweeps the unassigned queue
  immediately (20), so a driver who comes online beside a matching parcel has an
  offer within the same transaction. A driver who reaches this list *with*
  matching parcels is therefore the matcher failing to place them — cooldown,
  capacity, an expired document — not an idle driver. The panel says so on the
  row.

`matching_parcels` is counted by calling `journey_matches` itself rather than
comparing cities, so the number cannot disagree with the automation.

## The tiles

`waiting` is the list. `deciding`, `carrying`, `off_shift` and `blocked` are the
four reasons a driver is absent from it — the question somebody asks the moment
the list is shorter than they expected. Without them an empty list and a broken
query look identical.

`blocked` gets its own banner: a driver on shift whose document has expired
thinks they are working, and neither the matcher nor hand assignment will use
them.

## The assignment repair (69)

`admin_assign_parcel` had never worked against the real schema. Three faults in
one nine-line UPDATE:

1. **It raised before writing.** `set driver_id = driver` — the parameter is
   named `driver` and `bookings` has a column called `driver`, so plpgsql's
   default `variable_conflict = error` produced `column reference "driver" is
   ambiguous`. Manual mode could not place a single parcel, from 25 to 69.
2. **It would have broken `driver_pair_consistent`** (`driver_id is null or
   driver is not null`) — it set the id and left the denormalised carrier name
   null.
3. **Nobody was told.** It wrote `status = 'Booked'`, the status the parcel
   already had. 50's notifier is `after update of status` and keys the driver's
   `job_assigned` push and the sender's status email on the move to `'Assigned'`,
   so a hand assignment notified neither side.

69 qualifies the parameter (`admin_assign_parcel.driver`), fills the name from
the profile with the same `'Driver'` fallback `respond_to_offer` uses, and sets
`'Assigned'`. `accepted_at` stays null: nobody accepted it.

⚠ `documents-harness.mjs` reported this function working for eight migrations
because it builds its own `bookings` table with no `driver` column — nothing to
be ambiguous with, no constraint to violate.
`scripts/pg/driver-availability-harness.mjs` uses the real chain and is the
regression test.

## Retries: there is no once-per-driver rule

`dispatch_offers_once_per_driver` (15) was dropped by **20**, and its successor
`dispatch_offers_no_repeat_decline` by **23**. The only unique index left is
`dispatch_offers_one_live_per_booking` — one outstanding offer per parcel.

What governs re-offering is a rolling per-pair cooldown inside `dispatch_booking`:

```sql
and not exists (
  select 1 from dispatch_offers o
  where o.booking_id = <parcel> and o.driver_id = j.driver_id
    and o.status in ('declined','expired')
    and coalesce(case when o.status = 'expired' then o.expires_at else o.responded_at end,
                 o.expires_at) > now() - public.offer_cooldown()
)
```

`offer_cooldown()` is **15 minutes**. With the 10-minute hold and the
`loci-redispatch` cron every 5 minutes, a parcel comes back to the same driver
roughly every 25 minutes, indefinitely, for as long as it stays unassigned. The
matcher also prefers untried drivers first and logs `repeat: true` when it comes
back round.

⚠ Reading 15's comment and concluding a pair is blocked for ever is an easy
mistake — it was made in October 2026, and the proposed "fix" was to widen the
window to an hour, which would have *halved* the retries. Check 20 and 23 before
believing any statement about that index.

## Attempts are not drivers (71)

`unassigned_parcels`, `admin_parcels_for_driver` and `admin_parcel_detail` all
returned `offers_made` as `count(*)` over the offer rows, and three screens
rendered it as "Offered to N drivers already".

On production, PKG-483203 read "Offered to 5 drivers already". The truth was
**seven offers to one driver, every one a timeout, not a single decline** — the
matcher doing its job all day at a driver who was never notified, because
migration 50 is not applied there and `notify_on_dispatch_offer` does not exist.
Five drivers refusing a parcel is a pricing or routing problem; one driver never
answering is a notification problem. The sentence pointed at the first.

71 adds `offer_attempts(parcel)` — attempts, distinct drivers, declined, expired,
live — and the three lists read their counts from it. `attemptsLabel()` in
`src/store/dispatch-mode.ts` is the one place the sentence is written.
`offersGoingUnanswered()` flags the shape worth noticing: three or more attempts
with no declines at all, which is nobody seeing the parcel rather than nobody
wanting it.

`admin_parcel_detail` was deliberately not recreated — thirty columns rewritten
to add three is how a condition goes missing. The drawer calls `offer_attempts`
directly.

## In transit: collected, and not collected (73)

**Admin → Dashboard → In transit.** Two groups, because one list of "parcels
with a driver" hides the failure that matters:

| Group | What it is |
| --- | --- |
| Awaiting collection | A driver claimed it and has not picked it up. `picked_up_at is null`. |
| Collected and in transit | Taken from the sender and moving. |

Nothing happens when a collection does not happen — no event, no notification,
no row anywhere — so the only way an uncollected parcel surfaces is if somebody
is looking for it. That group is somebody looking for it.

`collected` is the **pickup timestamp**, not the status. The two agree today and
would not keep agreeing: a stage inserted before Picked Up, or a correction that
moves a status without a collection, would silently reclassify half the board.

73 adds `bookings.status_changed_at`, written by a trigger on the status change,
because the two middle stages record no timestamp of their own — In Transit and
Out for Delivery have neither an `accepted_at` nor a `picked_up_at` of their
own, so "how long has this sat here" could not be asked of a parcel in either.
Rows flag amber at 12 hours without a move and red at 24; the totals are window
counts over the whole set, so a truncated list cannot understate them.

The board is **read-only**. Migration 10 lets only the carrying driver advance a
parcel, so that the record of who handled it is never ambiguous; an admin
override would be a different act needing its own audit trail, not a button on a
monitoring screen. Rows open the existing parcel drawer (`focusId`), which
already carries the audited contact reveal.

## Closing a delivery the driver never recorded (74)

`advance_booking` (10) refuses everybody but the carrying driver, and says why:
an admin correcting a stuck delivery is *a different action with a different
audit trail*. 74 is that action.

On production, PKG-483203 ran accepted 13:57 → collected 14:05 → In Transit
14:06 → Out for Delivery 14:33, and then nothing. No attempt, no error. The
parcel reached its recipient; the driver never tapped the last step, and nobody
else could — so the sender's delivery email could never send and the driver's
fare could never be credited.

`admin_record_delivery(parcel, received_by_name, reason)` closes it. It refuses:

- a parcel that was never collected — closing it would assert a collection
  nobody recorded, on the word of somebody who witnessed neither;
- one already delivered or cancelled;
- one with no driver;
- a missing recipient name (10's rule, which does not stop applying because an
  admin is typing);
- a missing account of how they know it arrived.

Everything downstream fires exactly as it does for a driver's own delivery — the
sender's email (38), the in-app notification (50) and the driver's earnings
(30). The driver did the work; suppressing the fare because an operator typed
the last step would be a punishment for a flat phone battery. The admin screen
names all three before the button does anything.

`bookings.delivery_recorded_by` is null for every delivery a driver recorded and
set for every one an admin closed — the only thing that tells them apart six
months later. The parcel drawer renders it as "Closed by <name> — the driver
never recorded it", read through `admin_delivery_attribution`. The override logs
at **warning**: one is a flat battery, a run of them is the delivery flow failing
on real phones, and the log is where that shows up before anybody thinks to ask.

## A finished parcel is not being dispatched

The parcel drawer filed everything under **Dispatch** — the carrier and the
offer history — whatever the parcel's status. On a delivered parcel that heading
reads as though the platform is still trying to place it.

Once a parcel is Delivered or Cancelled the section is headed **Delivery** (or
**Carrier** for a cancellation), and the offer-attempt line is gone: how a parcel
got matched is not part of how it ended. Who carried it stays, because that is
the delivery record. The attempts themselves are not lost — every offer writes an
`app_events` row, which the System Logs screen reads.

## The delivery email

`email_on_booking_status` (38, replaced by 64) queues a `delivery_completed`
email to the **sender** on the move to Delivered, carrying the tracking id, the
fare, who received it and a flag that proof exists — never the storage path. The
`notify-events` edge function has the template, and both are live on production.

`scripts/pg/driver-availability-harness.mjs` proves the whole chain against the
real schema — collect, move, deliver, assert the outbox row is addressed to the
sender — because `emails-harness.mjs` proves it over a schema it builds itself,
which is the arrangement that hid `admin_assign_parcel` being broken for eight
migrations.

⚠ **"Queued immediately" and "sent immediately" are different claims, and only
the first was ever true on production.** `dispatch_email` (53) is what POSTs the
row to `notify-events` the moment it is queued, and production was running 38's
version of it, which reads settings this project stopped using in 24. Every
email was therefore going out on the five-minute sweep instead. See *The chain
was replayed* below; 79 is the fix.

⚠ One stale row on production: a `password_changed` email failed with *No
template for kind "password_changed"* against an older deployment of
`notify-events`. The current deployment has that template; the row has not been
retried.

## Soonest departure wins (75)

Three lists answer "who should take this parcel", and until 75 only one of them
sorted by the clock.

| | ordered by, before 75 | after 75 |
|---|---|---|
| `dispatch_booking` (26) | untried first, then **soonest departure** | unchanged |
| `admin_waiting_drivers` (70) | matching *count*, then when the shift was declared | can-be-helped, then **soonest departure** |
| `assignable_drivers` (32) | documents, route, parcels in hand, **name** | documents, route, **soonest departure**, parcels in hand, name |

The automatic matcher has preferred the soonest departure since 26 — *"a driver
leaving in twenty minutes should be offered the parcel ahead of one leaving
tomorrow"* is that file's own sentence. What was wrong is that the two screens
an operator uses to assign **by hand** sorted on something else, so a human
working the queue silently undid the priority the automation applies.

All three now sort on the same expression, `coalesce(departure_time,
departs_before)`, which is also the expression `journey_matches` gates
liveness on. One definition of "leaving soonest", in one place, is the property
worth keeping.

⚠ **Departure is the second key on the waiting list, not the first.** A driver
leaving in ten minutes with nothing on their route is not a decision anybody can
make; the top row has to be actionable. So "is there anything this driver could
take" stays ahead of it — reduced from 70's *count* to a boolean, because a
count as the leading key is exactly how a driver with nine parcels leaving
tomorrow outranked one with a single parcel leaving within the hour.

### Saying it on screen

`departureLine()` in `src/store/dispatch-mode.ts`, built on `formatSoon()` in
`src/lib/when.ts`:

| journey | reads |
|---|---|
| scheduled, `departure_time` set | `Leaves Today, 14:35 WAT` |
| scheduled, leaving tomorrow | `Leaves Tomorrow, 06:00 WAT` |
| scheduled, further off | `Leaves 12 Oct, 06:00 WAT` |
| scheduled, declared before 26 | `Leaves by Today, 18:00 WAT` |
| flash shift | `On shift until Today, 18:00 WAT` |

Three things that line is careful about:

- **The countdown badge stays.** "Leaves in 40m" is what decides who gets the
  next parcel; the clock time is what gets read out on the phone and written on
  a handover note. A countdown cannot be repeated to anybody and a timestamp has
  to be subtracted from now first, so both are on the row.
- **A flash shift is worded differently.** `declare_journey` sets a flash
  journey's `departs_before` to `now() + hours` — when their availability
  *lapses*, not when they leave. Calling that a departure would tell an operator
  a driver is about to set off for somewhere when they are about to go off
  shift.
- **WAT, and the year dropped.** Everything it formats is inside
  `MAX_DEPARTURE_DAYS`, so the year carries no information; "today" means today
  in Lagos, which is why both instants are shifted before their dates are
  compared.

## The notification spine was never on production (76)

The delivery **email** has always been immediate: `email_on_booking_status` (38,
replaced in 64) queues `delivery_completed` to the sender in the same
transaction as the status change, and `dispatch_email` (53) is an `after insert`
trigger on `email_outbox` that POSTs it to `notify-events` through pg_net there
and then. `loci-unsent-emails` is a retry sweep, not the sender.

The in-app notification and the push beside it come from
`notify_on_booking_status`, and on production that function did not exist —
while `supabase_migrations.schema_migrations` carried a row saying 50 had been
applied. Checked 2026-10-06: of 50's thirteen objects, **one** was present
(`queue_notification`, which 49 owns). No `on_booking_status_notify` trigger, no
`private.naira`, and none of its three pg_cron jobs. `public.notifications` had
two rows, both from the guarantor path, after weeks of live deliveries.

So a sender got an email and nothing in the app, and nothing anywhere said so.

⚠ **A history row is not evidence that a migration ran.** That is the lesson,
and `notification_spine_live()` is the line on the deployment panel that would
have caught it. It asserts the two *triggers* rather than the functions,
deliberately: a function nothing is wired to is the precise shape of this
failure, and a `to_regprocedure` probe would have gone green on it.

76 re-establishes the spine. Its body is 50's, generated from that file rather
than retyped, and `verify:availability` asserts the two are byte-identical from
50's `hardening` marker onward — if either is ever edited, both must be.

⚠ **Why a new migration rather than clearing the history row.** `delete from
supabase_migrations.schema_migrations where version = '20250101000050'` followed
by a push would fix one database and leave no trace in the chain: any other
environment whose history got confused the same way stays broken, and nothing in
`npm run verify` would notice. 76 converges every environment on the next push.

### The burst that was not there

50 schedules three sweepers, two of which could in principle notify a backlog on
their first run. Both are window-bounded and dedupe on `subject_id`, and both
were counted against production before 76 was written:

```sql
-- unconfirmed signups with a driver application, 1–30 days old
select count(*) from auth.users u
 where u.email_confirmed_at is null
   and u.created_at < now() - interval '24 hours'
   and u.created_at > now() - interval '30 days'
   and u.deleted_at is null
   and exists (select 1 from public.driver_applications a where a.user_id = u.id);
-- assigned parcels not collected after 30 minutes, under 2 days old
select count(*) from public.bookings b
 where b.status = 'Assigned' and b.driver_id is not null
   and b.accepted_at < now() - interval '30 minutes'
   and b.accepted_at > now() - interval '2 days';
```

Both returned **0**. Worth re-running before applying 76 to any environment that
has been live longer.

## The chain was replayed, and three things went backwards (79)

`create or replace function` does not care that it is going backwards. Replay an
early range of migrations over a database that already has the later ones and
the older definitions win — silently, legally, and without touching
`supabase_migrations.schema_migrations`. That happened to production, and it
produced three separate bug reports before anyone saw the pattern:

| reported as | actually |
|---|---|
| "column reference \"driver\" is ambiguous" on hand assignment | 32's `admin_assign_parcel` over 69's |
| a driver cannot decline the same parcel twice | 20's unique index over 23's drop (fixed in 78) |
| *nobody reported this one* | 38's `dispatch_email` over 53's — every email five minutes late |

Checking all forty-two objects this repo defines in more than one migration
against production on 2026-10-07 found **seven** stale:

| object | overwritten | cost |
|---|---|---|
| `admin_assign_parcel` | 32 over 69 | hand assignment raises |
| `dispatch_email` | 38 over 53 | every email waits for the sweep |
| `email_on_booking_status` | 38 over 64 | no driver first name in status emails |
| `begin_identity_check` | 28 over 41 | identity review columns never set |
| `record_identity_result` | 28 over 41 | the same, from the verifier's side |
| `handle_new_user` | 02 over 45 | Google sign-ups get a blank name |
| `pg_net_calls_are_resolvable` | 67 over 68 | the probe matches itself, so it is always false |

⚠ **Reading that list by eye got it wrong in both directions.** A first pass
"found" `guarantor_invitation_window` stale — it is not; 54 only changes a
number, and the marker used to test it was wrong — and missed four of the seven.
That is why the manifest below exists rather than a shorter fix for the one bug
that was reported.

### The two nobody reported

`dispatch_email` is the expensive one. 53 exists because 38's version reads
`app.settings.functions_url` and `app.settings.service_role_key`, which this
project does not set — it moved to `private.app_settings` in 24. 38's version
therefore finds no endpoint, returns silently, and the row sits unsent until
`loci-unsent-emails` picks it up. Every email on production was going out **301
to 302 seconds** after it was queued:

```sql
select kind, round(extract(epoch from (sent_at - created_at))) as seconds
  from public.email_outbox order by created_at desc limit 10;
```

Five minutes looks like email, which is why it was invisible. It is also why a
delivery confirmation was reaching the sender up to five minutes after the
driver tapped the button, on a database where the trigger that makes it
immediate was sitting right there in the history.

`handle_new_user` is the quiet one. A Google sign-up puts the person's name in
`raw_user_meta_data ->> 'full_name'`; a password sign-up puts it in `'name'`. 45
reads both, 02 reads only the second. Every Google account created since the
replay has a blank `profiles.full_name` — which renders as "Unnamed driver" on
the waiting list and as nothing beside a parcel.

### Seeing it next time

`stale_definitions()` carries a manifest of every object the repo defines in more
than one migration, each with a marker string that only its newest definition
contains, and reports `current`, `STALE` or `MISSING` for each:

```sql
select * from public.stale_definitions() where state <> 'current';
select public.definitions_current();   -- the deployment panel reads this
```

Three decisions in it are worth knowing:

- **A marker, not a whole-body comparison.** `pg_get_functiondef` reformats what
  it returns, so a byte comparison against the .sql file fails on functions that
  are perfectly current. A short string that only the newest definition contains
  is weaker and reliable.
- **Looked up by name, with `bool_or` across overloads.** Writing signatures
  into the manifest would make it report MISSING the first time a migration
  changed one — a worse lie than the one it catches. `journey_matches` is the
  live example: 15 declared it with eight arguments and 26 with ten.
- **The manifest cannot fall behind.** `verify:availability` parses every
  migration, computes the at-risk set itself, and fails if one is missing from
  79 — and separately checks that every marker is present in the newest
  definition and absent from all the older ones. An early draft used a
  function's own name as its marker, which `pg_get_functiondef` always contains;
  that check is what caught it.

The pg harness goes further: it applies the chain, replays 32's
`admin_assign_parcel` over it, asserts the report flips to STALE, asserts the
reverted function fails with production's exact error message, then applies 79
and asserts a parcel can be placed by hand again.

## Handing a parcel back (80)

A claimed parcel that has not been collected can be taken off the driver — by
them, or by an administrator. Three separate things had to change for that.

### The driver's Release button has never worked

`cancel_booking` (11) clears `driver_id` to put the parcel back on the board.
`bookings_guard_immutable` (01) refuses *any* change to `driver_id` once it is
set:

```sql
if old.driver_id is not null and new.driver_id is distinct from old.driver_id
  then raise exception 'a claimed job cannot be reassigned';
```

01 predates 11 by ten migrations and nothing revisited it, so every Release a
driver has ever pressed came back as **"That did not go through. a claimed job
cannot be reassigned (P0001)"** — a rule nobody was breaking. The button on the
mobile driver hub was dead from the day it shipped, and the web driver screen
never had one at all.

⚠ **The same guard was aborting account erasure.** `bookings.driver_id` is `on
delete set null`, and a referential action fires row triggers, so deleting the
auth user of anybody who had ever carried a parcel ran this guard against
`new.driver_id is null` and raised. That is why 80 relaxes the guard rather than
special-casing `cancel_booking`.

What the guard still refuses is the thing it was written for: driver A's parcel
becoming driver B's in one UPDATE. A release goes *through* null — back to the
open board, where the next claim is a fresh decision by somebody who can see the
job — so there is no path that moves a parcel between two people silently.

### A release is not a decline

| | what it means | what the matcher does |
|---|---|---|
| offer declined or timed out | "not right now" | re-offers after `offer_cooldown()` — 15 minutes |
| **parcel released** | "I took this and I am giving it back" | **never offers it to them again** |

23 made a decline a cooldown rather than a permanent block, and 78 removed the
index still enforcing the old rule. None of that changes. But a driver who
*accepted* and then handed the parcel back has answered a stronger question, and
offering it to them again fifteen minutes later is the loop the brief asks to
close. So `parcel_releases` records the pair and `dispatch_booking` skips it from
then on, with no window on it.

It is skipped for **offers**, not for everything:

- the parcel stays on the open jobs board, and that driver can still claim it by
  hand if they change their mind back;
- an administrator can still assign it to them — `assignable_drivers` says
  *"Released this parcel — not offered it again"* in the row's note, ahead of the
  route, rather than hiding them. That is the call that function has made since
  32: an operator is on that screen because they know something the matcher does
  not.

### Both releases stop at collection

'Assigned' is the whole window, for the driver and for the administrator. Once
the parcel is 'Picked Up' somebody is holding another person's property, and
marking it unassigned would leave a parcel on the open board that is physically
in a bag in Ibadan. The refusal names the right tool instead:

> That parcel is Picked Up — the driver already has it. Reassigning stops at
> collection; record the delivery or cancel it instead

### The admin action

Admin → In transit → *Awaiting collection* → **Take off driver**. A reason is
required, because the driver is told nothing by the status change itself — their
parcel simply leaves their list — so that string in `app_events` is the only
record of why somebody's accepted job was taken away. Logged at `warning`, like
`admin_record_delivery`: one is an operator doing their job, a run of them is
dispatch handing parcels to drivers who do not collect them.

⚠ **`delete`-then-`insert`, not `on conflict do update`.** `cancel_booking`'s
parameters are named `booking_id` and `reason`; `parcel_releases`' columns are
named `booking_id` and `reason`. Inside `on conflict (booking_id, …) do update
set reason = …` plpgsql cannot tell which is meant and raises before writing
anything — the same trap 69 is about, one table along, and it cost a harness run
to find.

## Nothing is refused before it is known

The same bug happened three times, on three different flags, and the third one
is the reason the fix is now a rule the build enforces.

| flag | what flashed | where |
|---|---|---|
| `status === 'loading'` | the sign-in card | nine screens, on every web reload |
| `isAdmin` | *"This area isn't available on your account"* | every admin page, at an administrator |
| `isApprovedDriver` | *"Nothing to pay out yet"*, *"Scheduling unlocks when you are approved"* | the driver wallet and the journey planner |
| `isAdmin`, again | **every counter at zero and *"Nothing waiting"*** | five admin screens, on every reload |

The first three are a screen rendering a **refusal** from a flag that has an
"unknown" phase and defaults to `false` during it. The fourth is the same
mistake producing something worse than a refusal — see *The empty dashboard*
below.

### Why fixing the first one did not fix the second

`SessionStatus` leaves `'loading'` as soon as the stored session is restored.
But `isAdmin` and `isApprovedDriver` come from a **second** round trip —
`refreshDriverStatus`, which runs after the session resolves — and both are
`false` until it lands. So there is a window, on every load, in which the app
knows exactly who somebody is and believes they are allowed nothing:

```
t0  status: 'loading'      isAdmin: false   → sign-in card        (fixed first)
t1  status: 'signedIn'     isAdmin: false   → "not available"     (this one)
t2  status: 'signedIn'     isAdmin: true    → the page
```

Gating on `status === 'loading'` closes t0 and leaves t1 wide open. That is
exactly what `AdminShell` did, correctly as far as it went, and it is why the
admin flash survived the first fix.

### One flag

`permissionsKnown` in `src/store/session.tsx`:

```ts
permissionsKnown: status !== 'loading' && (!user || driverStatusLoaded)
```

A signed-out visitor is known at once — there is no second lookup pending, and
holding every public page on one would make the site slower for everybody. A
signed-in person waits for the admin and driver answers.

Everything that decides what a person may see now waits on it: `SignedOutState`,
`AdminShell`, the admin dashboard, the driver wallet, the journey planner, and
`resolveExperience` — whose input was renamed from `authLoading` to
`accessLoading`, because keying it on the session alone meant an approved driver
on a phone resolved to the *sender* app for a moment and then flicked to the
driver one. That file's own comment already said that flick was the thing it
existed to prevent; it was only guarding half of it.

⚠ **`driverStatusLoaded` was read by the session memo and missing from its
dependency list**, so the context object did not change identity when the lookup
landed. Fixed in the same change.

### One refusal card

The admin dashboard carried its own copy of the not-available card, word for
word, inside its own copy of the three-state gate — and therefore its own copy
of the missing check. Two places to fix a bug is how one of them stays broken.
`AdminDenied` and `useAdminGate` are now exported from `admin-shell.tsx`, and a
test asserts the copy exists in exactly one module.

### The empty dashboard

The flash that survived all of the above, caught on a screen recording. Every
admin screen's loader guards on `isAdmin`:

```ts
useEffect(() => {
  if (!isAdmin) {
    setLoading(false);     // ← on mount, isAdmin is false
    return;
  }
  void load();
}, [isAdmin, load]);
```

On mount `isAdmin` is false, so that branch ran, **declared the load finished**,
and the screen painted its *empty* state — every counter at zero, "Nothing
waiting. Every application has been looked at." — before the fetch had started.
The flag then flipped, `load()` ran, and the real numbers appeared.

It is the same mistake as the refusals and it reads worse, because an empty
dashboard is a claim about *the business* rather than about the reader. For a
second, Package Relay had no applications, no parcels and nothing waiting.

The fix is one line above the guard, in all five screens:

```ts
if (!permissionsKnown) return;   // nothing known — stay loading
```

`loading` then stays true from mount until the fetch resolves, which is what it
was always supposed to mean.

### The wait must not blank the page

The readiness gate itself was a flash: it returned a bare spinner on an empty
background, so the brand, title and subtitle blinked out and back on every
reload. A blank screen between two painted ones reads as a flash whatever is
drawn in the middle of it. `AdminShell` now renders its spinner *inside* the
page frame, and the dashboard keeps its header, so only the content region
changes.

### The build refuses a new one

The part that matters for "not on any page, ever again" is a sweep in
`verify:availability` over every `.ts`/`.tsx` under `src/`:

- a render branch `if (!isAdmin)` or `if (!isApprovedDriver)` that returns JSX
  must be in a file that also consults `permissionsKnown` or `useAdminGate`;
- a branch on `!isAuthenticated` may render only `SignedOutState`, which does
  its own waiting;
- an effect that calls `setLoading(false)` under an `isAdmin` guard must return
  on `!permissionsKnown` **first** — checked by source position, not just
  presence, because the order is the whole bug;
- the gate must hold the page frame rather than replace it;
- the not-available copy may exist in one file.

Two details stop it being decorative:

- **`[^}]` in the pattern.** Without it the sweep matched every admin screen's
  `if (!isAdmin) { setLoading(false); return; }` effect guard and then found the
  component's own `return (` a few characters later. A sweep that reports four
  false positives gets switched off.
- **It tests itself first.** Two literal strings — the shape of the bug and the
  shape of an effect guard — are run through the pattern before the sweep uses
  it. A regex that quietly stops matching passes for ever otherwise.

Verified by reverting fixes one at a time and watching the build go red for each
— the refusal sweep against the journey planner, the loader sweep against the
system-logs screen.

⚠ One thing deliberately left: the nav bar still swaps its avatar for a sign-in
affordance during that window. It is one element rather than a full-page card,
and gating it means threading session state through a 1,300-line component.

## The reviewer sees the number they are checking (81)

Sender ID Review hands over a **scan of the NIN slip** and then shows four
digits of the number typed off it. So a reviewer can catch a wrong NIN only if
the error happens to land in the last four — which is not where a transposed
digit usually lands. Masking the typed copy of a number that is legible in the
image beside it protects nobody; it only prevents the comparison the review
exists to make.

Meanwhile the opposite rule was live in the same console: **driver applications
showed every applicant's full NIN in the list**, fetched with `select('*')`,
with no click and no record of who looked.

| surface | before | after |
|---|---|---|
| sender ID review list | `•••• •••• 4747` | unchanged |
| sender reveal | `•••• •••• 4747` | **full, audited** |
| driver application list | **full, unaudited** | `•••• •••• 4747` |
| driver application reveal | — | **full, audited** (applicant + guarantor) |
| a person's own profile | `•••• •••• 4747` | unchanged |
| a person's own edit form | full | unchanged — it is theirs |

### The list stops carrying it, not just stops drawing it

`fetchAllApplications` did `select('*')` on `driver_applications`, so both NINs
arrived in the browser whether or not anything rendered them — on a screen an
operator leaves open all day. Masking in the component would have been a label
over data already on the machine.

The console now reads `driver_applications_admin`, a view with the two NIN
columns replaced by `right(nin, 4)`. It is declared `security_invoker = on`, so
the row policies decide who may read it exactly as they do for the table — this
changes which *columns* come back, not who may ask. The harness asserts that by
reading the view as a driver and getting back one row: their own.

`fetchMyApplication` still selects from the table. An applicant's own NIN is
theirs, and their edit form has to prefill.

### One audited door per screen

- **Senders**: `admin_reveal_identity_for_user` and `admin_reveal_sender_identity`
  now return `nin` in full alongside `slip_path`. Both already wrote a
  `'privacy'` line into `app_events`, in the same transaction as the read — if
  the insert fails, nothing is returned. The reviewer presses the same button
  they already press to see the slip.
- **Driver applications**: `admin_reveal_application_nin` returns the
  applicant's number and the guarantor's in one call, because reviewing an
  application is one act of looking. Two reveals would mean two log lines for
  one decision and a reason box that becomes a formality — the same call 41 made
  about the selfie and the slip.

A revealed number is cleared when the card becomes a different person, the same
rule the selfie reveal already follows: a NIN on screen under the wrong name is
worse than no NIN at all.

### Where it is drawn

Next to the document, selectable. The slip is already open above it — that
adjacency is the whole point — and the next thing a reviewer does with a number
that does not match is paste it into the enquiry that settles it.

⚠ **79 is a replay hazard for this file.** It is a repair migration, so it
carries 43's copy of `admin_reveal_identity_for_user` — the one that masks.
Running 79 again after 81 puts the mask back. `stale_definitions` reports it
(the manifest names 81 as the owner) and the fix is to run 81 again. The pg
harness does exactly that and asserts the report comes back clean.

### What this does not do

It does not put a NIN on a list. The queue stays masked, and a sweep in
`verify:availability` fails the build if any screen renders `.nin` straight into
JSX from a list row, a profile or a queue fetch. A full NIN belongs to a reveal
result, which is audited; a list row is not one.

## The reveal looks where the queue looks (82)

A sender took their selfie; the review screen showed the slip, the number, and
**nothing** where the face should be — with no explanation, because a null image
url renders the same as a photograph that has not loaded yet.

### Where a selfie actually lives

It is banked into `photo_capture_sessions` the moment it is taken, and only
copied to `sender_identity.reference_path` once something decides. So while an
account is *waiting on review* — which is every account in this queue — the
identity columns are empty and the photo is in a capture session.

Migration 43 knew this. It added `sender_selfie_path(target)`:

```
candidate_path → reference_path → newest completed capture session
```

…and wired it into both `admin_identity_queue` (so `has_selfie` is true) **and**
`admin_reveal_identity_for_user`.

### How it came back

⚠ **Migration 81 reverted it.** Writing 81 I rebuilt
`admin_reveal_identity_for_user` to add the full NIN, and copied the body from
**41** rather than **43** — losing the helper and going back to
`coalesce(candidate_path, reference_path)`. 81 is applied on production, so the
regression is a day old and mine.

The production account that prompted this: twelve capture sessions, three
completed with a photo, both identity columns null. Queue says there is a
selfie. Reveal returns null. The panel drew nothing, and the reviewer was asked
to tick *"I have compared the selfie against the NIN slip"* with no selfie on
screen.

⚠ **The drift detector should have caught it and did not.** 81's manifest marker
for that function was `nin text,` — it tested the thing 81 added, not the thing
81 broke. A marker proves the newest definition is present; it cannot know which
*other* definition you copied from. The structural answer is below.

### The fix

Both reveals call `sender_selfie_path`. The parcel-keyed one keeps the booking's
own photo first — that reveal is about one parcel, and the face photographed for
it is the right answer when there is one — and falls back to the helper.

`reveal_finds_the_selfie()` asserts the queue and both reveals all reference the
helper. Neither was wrong alone; the bug was that they disagreed, invisibly.

The reveal also now starts from the target and left joins:

```sql
from (select target as user_id) t
left join public.sender_identity i on i.user_id = t.user_id
```

An account with a selfie and no NIN returned **zero rows**, which the client
reads as "nothing to show" rather than "a selfie and no NIN".

### All three, always

The panel now renders the number, the slip and the selfie through one
`Evidence` component with exactly two outcomes: the thing, or a sentence saying
it is absent. A missing selfie reads *"No selfie on file. Ask them to take it
again before deciding — there is nothing here to compare the slip against."*

That is the structural half of the fix. A blank space is indistinguishable from
a slow page, which is why this went unreported for a day; a component that
cannot render nothing makes that un-writable. `verify:availability` asserts
there are exactly three `<Evidence>` blocks and that nothing draws an evidence
slot outside it.

### And the harness replays the whole tail

The drift test in `verify:pg-availability` replays 79 — a repair file carrying
older copies of several functions — and then **every migration after it, in
order**, rather than naming the newest one. Naming it is how this test would
quietly start asserting against a database two fixes behind.

## Tests

```bash
npm run verify:availability      # source assertions, including 75, 76 and 79-82
npm run verify:pg-availability   # 69-82 against real Postgres under RLS
```

The pg harness pins the retry loop as well: a lapsed offer is not re-offered
inside the cooldown, and *is* re-offered to the same driver once it has passed.

Three assertions in it are worth knowing about:

- **Declaration order is the reverse of departure order.** The three drivers
  seeded for 75 declare their shifts last-leaving-first, so the old ordering
  returns them backwards and a test seeded in departure order would have passed
  against either.
- **"Immediately" is measured, not asserted in prose.** The sender's delivery
  notification is written by an `after update` trigger inside the same
  transaction as the status change, so the harness compares its `created_at`
  against `delivered_at` and requires them within a second.
- **The drift test breaks the database on purpose.** See above. One expected
  exception is listed by name: `notify_dispatch_offer` is owned by 24, which the
  harness skips because pg_net cannot be installed in PGlite. A second
  unexpected row fails the run.
- **The release test presses the button that has never worked.** A driver
  accepts a parcel, releases it, and the harness asserts the parcel goes back on
  the board, that the matcher offers it to somebody else, and that it is still
  not offered to them long after any cooldown would have lapsed — while a driver
  whose offer merely timed out *is* tried again.

## Deploy

```bash
supabase link --project-ref <ref> && supabase db push
```

Every migration here is re-runnable. 70, 75 and 79 create or replace functions
and touch no data; 69 replaces one function and changes no signature; 76 is
`create or replace` throughout with `drop trigger if exists` before every
trigger.

⚠ **75 drops and recreates `assignable_drivers`.** `create or replace` cannot
change a function's output columns and it gains two. There is a moment inside
the transaction where the function does not exist; a push is one transaction, so
nothing outside it ever sees that.

⚠ **Push 76 and 79 even where the history claims the migrations they repair.**
That is the case both exist for. Afterwards, check the database rather than the
history:

```sql
select public.definitions_current();         -- must be true
select public.nin_reveal_installed();        -- must be true
select public.reveal_finds_the_selfie();     -- must be true
select public.notification_spine_live();     -- must be true
select public.departure_priority_live();     -- must be true
select public.release_controls_installed();  -- must be true
select * from public.stale_definitions() where state <> 'current';   -- must be empty
```

All six are on the deployment panel in the admin console, so the answer is one
screen away without opening the SQL editor.

⚠ **Never `supabase db push --include-all` against a live project**, and never
re-run an early migration by hand to "make sure it is there". That is what
caused all of this. If the history is wrong, fix the history row; do not replay
the file.
