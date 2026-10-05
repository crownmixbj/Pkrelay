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

## The delivery email already exists

`email_on_booking_status` (38) queues a `delivery_completed` email to the
**sender** on the move to Delivered, carrying the tracking id, the fare, who
received it and a flag that proof exists — never the storage path. The
`notify-events` edge function has the template, and both are live on production.

It has never fired there because the only delivered parcel predates the
migration. `scripts/pg/driver-availability-harness.mjs` now proves the whole
chain against the real schema — collect, move, deliver, assert the outbox row is
addressed to the sender — because `emails-harness.mjs` proves it over a schema
it builds itself, which is the arrangement that hid `admin_assign_parcel` being
broken for eight migrations.

⚠ One stale row on production: a `password_changed` email failed with *No
template for kind "password_changed"* against an older deployment of
`notify-events`. The current deployment has that template; the row has not been
retried.

## Tests

```bash
npm run verify:availability      # source assertions
npm run verify:pg-availability   # 69, 70 and 71 against real Postgres under RLS
```

The pg harness pins the retry loop as well: a lapsed offer is not re-offered
inside the cooldown, and *is* re-offered to the same driver once it has passed.

## Deploy

```bash
supabase link --project-ref <ref> && supabase db push
```

Both migrations are re-runnable. 70 creates three read-only functions and
touches no table; 69 replaces one function and changes no signature.

⚠ **The notification half of 69 needs migration 50.** On a database where 50 has
not been applied there is no `on_booking_status_notify` trigger, so moving a
parcel to `'Assigned'` tells nobody — by hand or by a driver accepting an offer.
Check with:

```sql
select to_regprocedure('public.notify_on_booking_status()') is not null;
```

If that is false, 50 has to go on first. Applying it late is safe — nothing in
51–70 re-creates any function or trigger it owns — but note that it schedules
three pg_cron jobs, and `sweep_unconfirmed_emails` notifies every account with a
driver application and an unconfirmed email from the last 30 days. Count them
before the first run:

```sql
select count(*) from auth.users u
 where u.email_confirmed_at is null
   and u.created_at < now() - interval '24 hours'
   and u.created_at > now() - interval '30 days'
   and exists (select 1 from public.driver_applications a where a.user_id = u.id);
```
