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

## Tests

```bash
npm run verify:availability      # source assertions
npm run verify:pg-availability   # 69 and 70 against real Postgres under RLS
```

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
