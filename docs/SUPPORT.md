# Support ticketing

Everything behind **Admin → Support Tickets** (`/admin-support`) and the ticket
panel at the bottom of the public Support page.

Schema and functions: `supabase/migrations/20250101000059_support_tickets.sql`.
That file's header carries the design arguments; this one is the operational
picture and the deploy steps.

## What exists

| Piece | Where |
| --- | --- |
| Tables | `support_tickets`, `support_ticket_messages` |
| Admin screen | `src/app/(tabs)/admin-support.tsx` |
| Customer panel | `src/components/ui/support-ticket-panel.tsx`, rendered by `(tabs)/support.tsx` |
| Data access | `src/store/support-tickets.ts` |
| Tests | `scripts/verify-support-tickets.ts`, `scripts/pg/support-tickets-harness.mjs` |

```bash
npm run verify:support      # the source assertions
npm run verify:pg-support   # the migration, against real Postgres under RLS
```

## The four statuses

```
open  ──reply──▶  in_progress  ──▶  waiting_on_customer
  │                    │                    │
  └────────────────────┴─── resolve ────────┘
                            │
              customer replies → back to open
```

- **Open** — nobody has answered yet. A public admin reply moves it to In
  Progress automatically; nothing else moves on its own.
- **In Progress** — somebody is working it.
- **Waiting on customer** — the next move is not ours. This status exists so
  that "how many people are waiting on *us*" stays answerable; without it those
  tickets hide inside In Progress.
- **Resolved** — closed, with a resolution note the customer is sent. A reply
  from them reopens it and clears the note.

"Awaiting us" in the filter bar is **not** a status. It is `status <> 'resolved'
and last_message_from = 'customer'`, which crosses three of them, and it is the
queue's default view.

## Who can see what

- A customer reads their own tickets and the **public** entries of their own
  threads, straight from the table under RLS. There is no insert, update or
  delete policy — every write goes through a function.
- An admin reads through `admin_support_*`, each of which checks `is_admin()`.
  There is deliberately **no admin select policy** on either table:
  `admin_support_messages` is the only path to an internal note in the whole
  schema, and it is reachable exactly one way.
- Nothing in these functions returns a phone number, an address or a name
  beyond the requester's own display name. Contact details still come from
  `admin_reveal_parcel_contacts`, which writes an audit line naming who looked.
  The queue's *search* does match a phone number — the operator typing one
  already has it, because somebody is on the line.

## Intake

Two ways in, and they are not the same shape:

1. **In the app.** `create_support_ticket` — the person's own words, filed as a
   public customer message. Rate limited to five an hour per account. A parcel
   link is verified against their own parcels.
2. **By phone or email.** `admin_create_support_ticket` — the ticket belongs to
   the customer, `opened_by_admin_id` records who typed it, and the intake note
   is filed as an **internal** note authored by the admin. It is an operator's
   summary, not the customer's words, and it is not put in their mouth. Takes a
   tracking ID rather than a booking id, because that is what somebody reads out
   on the phone; it is resolved against that account's own parcels.

## Notifications

A public reply queues a `message_received` notification (49's spine) to the
requester and pushes it. An internal note queues nothing and does not set
`first_response_at` — that column is the response-time metric, and a note
nobody outside the building can read is not a response.

New tickets notify **every** admin; replies notify the assignee if there is one,
otherwise every admin.

**No email goes out.** The person who emailed `support@` is the least likely to
open the app, so this is the first thing to add: a new `kind` in 38's
`email_outbox` check constraint plus a template in `notify-events`, deployed in
step. See the end of the migration for the other three deliberate omissions
(no priority column, no SLA clock, no auto-close sweep).

## Erasure

`erase_person` is not edited by this migration. Instead, a trigger on
`profiles.deleted_at` (null → not null, which only an erasure does) deletes the
account's messages and blanks the subject and resolution, keeping the ticket
shell for operational history.

**A bug this work surfaced, now fixed in
`20250101000061_capture_session_fk_repair.sql`:** `erase_person` deletes the
target's `photo_capture_sessions`, and `20250101000044_selfie_with_the_parcel.sql`
added `bookings.capture_session_id` referencing that table with **no `on delete`
action**. From 44 onwards, erasing anybody who had posted a parcel raised

```
update or delete on table "photo_capture_sessions" violates foreign key
constraint "bookings_capture_session_id_fkey" on table "bookings"
```

and the exception aborted the whole function — so an NDPR erasure request for an
ordinary sender scrubbed nothing at all. 61 gives that key `on delete set null`:
the parcel survives with its pointer cleared, rather than being cascaded away
with a recipient's delivery history. `erase_person` itself is untouched.

61 also carries `capture_session_fk_repaired()`, a probe whose only job is to be
askable — the deployment panel translates a missing function into a filename, and
a migration that adds no function is invisible to it (migration 55 set this
precedent). It answers from the live catalog, so it goes false if somebody
re-adds that constraint without the clause.

Two harnesses cover it from here. `support-tickets-harness.mjs` erases a sender
who has posted a parcel against the real migration chain and reads the clause
out of `pg_constraint`; `erase-harness.mjs` now builds the pointer into its own
schema and seeds a parcel that uses it, so a future table that forgets to say
what happens to its pointer on erasure fails a test rather than an erasure
request.

## Deploy

Nothing credentialed is needed beyond the migration itself.

```bash
supabase db push            # applies 59 and 61 with the rest
npm run verify              # includes verify:support and verify:pg-support
```

Both migrations are re-runnable. 59 applies cleanly on a project that has never
had support tickets and alters no existing table; the only object it adds outside
its own two tables is the `scrub_support_on_erase` trigger on `profiles`. 61
drops and re-adds one foreign key on `bookings` — it takes a brief lock on that
table, so push it when nothing is mid-booking, and it no-ops on a database where
the key is already correct.

After pushing, the Hubs & Operations screen's deployment panel should show
**Support ticketing queue** and **Erasure: capture-session key repair** as
present. If either says missing on a database you have pushed to, the panel is
reading PostgREST's exposed-function list — check the grants at the end of each
migration rather than re-running it.
