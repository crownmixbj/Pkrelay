-- ============================================================================
-- 20250101000059_support_tickets.sql — the support queue, and the thread under it
-- ============================================================================
--
-- Run after 01–58. Re-runnable.
--
-- Support arrives today as an email to support@pkrelay.ng and a phone call, and
-- both of those are somebody's inbox and somebody's memory. This migration is
-- the record: one row per inquiry, one thread per row, and a status an operator
-- moves through Open → In Progress → Waiting on customer → Resolved.
--
-- ⚠ Four statuses, not three, and the fourth is the one that earns its keep.
--
--   "Waiting on customer" is where a ticket sits when the next move is not
--   ours. Without it those tickets live in In Progress, and the two numbers an
--   operator actually needs — how many are waiting on *us*, and how long the
--   oldest has waited — become meaningless the first busy week. Adding it later
--   means a new migration to widen a check constraint on a live table, so it is
--   here from the start.
--
-- ⚠ No admin select policy on either table. Same call as 49.
--
--   The thread carries internal notes ("the driver says the recipient's number
--   is dead, do not refund yet") and free text a customer typed, which is the
--   one place in this schema where a phone number or an address can arrive
--   without a column to put it in. A blanket admin read policy would expose all
--   of it through PostgREST to any phished admin session. Everything an
--   operator sees comes from a `security definer` function that checks
--   `is_admin()` and returns a fixed shape.
--
-- ⚠ Internal notes are a `visibility` column, not a second table.
--
--   Two tables means two inserts to order correctly, two policies to keep in
--   step, and a merge in the client to get one chronological thread — and the
--   thread *is* the product here. One table with a check constraint that
--   forbids a customer authoring an internal note keeps the ordering free and
--   the mistake impossible.
--
-- ⚠ The notification kind is the existing `message_received`.
--
--   49's `kind` check constraint is in a pushed migration and already carries
--   exactly the right value. Widening it for `support_reply` would mean
--   altering a constraint on the busiest table in the schema to say a second
--   word for one concept — 49 argued that case for `kind` vs `type` and the
--   answer has not changed.
--
-- Applies cleanly on a project that has never had support tickets. Nothing here
-- alters an existing table; the one trigger it adds is on `profiles`, and it
-- only fires on erasure.

do $$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'Run 20250101000001_bookings.sql first.';
  end if;

  if to_regclass('public.notifications') is null then
    raise exception 'Run 20250101000049_notifications.sql first.';
  end if;

  if to_regprocedure('public.is_admin()') is null then
    raise exception 'Run 20250101000002_driver_applications.sql first.';
  end if;
end
$$;

-- --------------------------------------------------------------- reference --

/*
 * The human-readable handle: PKR-S-00001.
 *
 * A sequence rather than a random string, because this number is read down a
 * phone line. "Your reference is PKR-S-00412" survives a bad connection;
 * "pkr_t8v2qh" does not. It leaks the ticket count, which is not a secret worth
 * paying for a worse support call.
 */
create sequence if not exists public.support_ticket_reference_seq;

-- ------------------------------------------------------------- the tickets --

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),

  reference text not null unique
    default ('PKR-S-' || lpad(nextval('public.support_ticket_reference_seq')::text, 5, '0')),

  /*
   * Whose problem this is — always the customer or driver, never the admin who
   * typed it in.
   *
   * ⚠ This is the column the whole screen hangs off, so it does not shift
   *   meaning for a phone call. An admin logging an inquiry picks the account
   *   it belongs to and lands here; who did the typing is `opened_by_admin_id`.
   *   The tempting shortcut — requester is "whoever created the row" — puts the
   *   admin's own id on a quarter of the queue, and then "every ticket this
   *   person has ever raised" silently answers a different question.
   *
   * `on delete cascade` for 49's reason: this thread is free text about a
   * person, and an inbox left behind after the login is gone is a leak with no
   * owner.
   */
  requester_id uuid not null references auth.users (id) on delete cascade,

  /** Set when an admin logged this on someone's behalf. Null for self-serve. */
  opened_by_admin_id uuid references auth.users (id) on delete set null,

  /*
   * How it arrived. Checked, because "app" and "in-app" and "mobile" would
   * otherwise all appear in the same column within a month and the only
   * question this column answers — is the in-app form actually being used —
   * would need a `group by` nobody trusts.
   */
  channel text not null default 'app' check (channel in ('app', 'phone', 'email')),

  category text not null default 'other' check (category in (
    'parcel',
    'payment',
    'driver_application',
    'account',
    'other'
  )),

  subject text not null check (btrim(subject) <> ''),

  /*
   * The parcel this is about, when it is about a parcel.
   *
   * ⚠ Both columns, and they are not redundant.
   *
   *   `booking_id` is the live link an operator follows into the parcel drawer;
   *   it goes null if the parcel is ever removed. `booking_tracking_id` is the
   *   string the customer quoted, snapshotted at intake — so a resolved ticket
   *   still says which parcel it was about, which is the whole value of the
   *   record six months later. 49 snapshots its metadata for the same reason.
   */
  booking_id uuid references public.bookings (id) on delete set null,
  booking_tracking_id text,

  status text not null default 'open' check (status in (
    'open',
    'in_progress',
    'waiting_on_customer',
    'resolved'
  )),
  status_changed_at timestamptz not null default now(),

  /** Who owns it. Null is unassigned, which is a state and not a mistake. */
  assigned_admin_id uuid references auth.users (id) on delete set null,

  /*
   * When somebody first answered, and the timestamp is the metric.
   *
   * Set once, by the first *public* admin reply. An internal note is not an
   * answer, and counting one as a first response is how a support team ends up
   * reporting a median response time of four minutes while nobody outside the
   * building has heard anything.
   */
  first_response_at timestamptz,

  /*
   * The last thing said, and which side said it.
   *
   * Maintained by the reply functions rather than derived with a lateral join
   * on every queue load: this is the column the list sorts on and the one that
   * answers "is the ball in our court", and a queue that scans the whole
   * message table to sort itself gets slower every week it works.
   */
  last_message_at timestamptz not null default now(),
  last_message_from text not null default 'customer'
    check (last_message_from in ('customer', 'admin')),

  /** What we told them we did. Required to resolve; cleared if it reopens. */
  resolution text,
  resolved_at timestamptz,

  created_at timestamptz not null default now(),

  /*
   * Resolved and `resolved_at` move together, in both directions.
   *
   * The half that matters is the reverse one: reopening a ticket without
   * clearing `resolved_at` leaves a row that is open and also closed, and every
   * count built on either column disagrees with the other from then on.
   */
  constraint support_resolution_consistent check (
    (status = 'resolved') = (resolved_at is not null)
  )
);

comment on table public.support_tickets is
  'One customer or driver support inquiry. Written only by security-definer functions; a requester reads their own rows, an admin reads through admin_support_* RPCs.';

-- ------------------------------------------------------------ the messages --

create table if not exists public.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),

  ticket_id uuid not null references public.support_tickets (id) on delete cascade,

  /*
   * `on delete set null`, unlike the ticket's cascade.
   *
   * A reply is part of the thread's meaning — "we told them to collect from the
   * hub on Tuesday" has to survive the admin who wrote it leaving. The name is
   * resolved at read time from `profiles`, so a null author reads as "Package
   * Relay" rather than as a gap.
   */
  author_id uuid references auth.users (id) on delete set null,

  author_role text not null check (author_role in ('customer', 'admin')),

  visibility text not null check (visibility in ('public', 'internal')),

  body text not null check (btrim(body) <> ''),

  created_at timestamptz not null default now(),

  /*
   * ⚠ A customer cannot author an internal note.
   *
   *   Not a hypothetical: the reply functions both take a body and a
   *   visibility, and one transposed argument would file a customer's own
   *   message where they can never see it again — a thread that silently loses
   *   half of itself, with no error anywhere. The constraint makes that a write
   *   failure instead of a support mystery.
   */
  constraint support_internal_is_staff_only check (
    author_role = 'admin' or visibility = 'public'
  )
);

comment on table public.support_ticket_messages is
  'One entry in a support thread. visibility = internal is staff-only; a customer may only author public messages.';

-- ---------------------------------------------------------------- indexes --

/* The queue: one status, oldest movement first. */
create index if not exists support_tickets_queue_idx
  on public.support_tickets (status, last_message_at asc);

/* A person's own list, and the rate limit's count. */
create index if not exists support_tickets_requester_idx
  on public.support_tickets (requester_id, created_at desc);

/* "Is there a ticket open on this parcel", asked from the parcel drawer. */
create index if not exists support_tickets_booking_idx
  on public.support_tickets (booking_id)
  where booking_id is not null;

/* One admin's workload. Partial: most tickets are unassigned. */
create index if not exists support_tickets_assigned_idx
  on public.support_tickets (assigned_admin_id, last_message_at asc)
  where assigned_admin_id is not null;

/* The thread, in order. The only query the message table ever serves. */
create index if not exists support_ticket_messages_thread_idx
  on public.support_ticket_messages (ticket_id, created_at asc);

-- -------------------------------------------------------------------- RLS --

alter table public.support_tickets enable row level security;
alter table public.support_ticket_messages enable row level security;

/*
 * Own tickets only. `(select auth.uid())` is 48's initplan wrap — evaluated
 * once per statement rather than once per row.
 */
drop policy if exists "own support tickets" on public.support_tickets;
create policy "own support tickets"
  on public.support_tickets for select
  to authenticated
  using (requester_id = (select auth.uid()));

/*
 * Own thread, public entries only.
 *
 * ⚠ The `visibility` test is first for a reason beyond taste: it is the
 *   cheapest condition and the one that must never be reachable around. An
 *   internal note is written on the assumption that the customer cannot read
 *   it, and a policy that leaked them would turn every honest operational note
 *   into a disclosure.
 */
drop policy if exists "own support messages" on public.support_ticket_messages;
create policy "own support messages"
  on public.support_ticket_messages for select
  to authenticated
  using (
    visibility = 'public'
    and exists (
      select 1
        from public.support_tickets t
       where t.id = support_ticket_messages.ticket_id
         and t.requester_id = (select auth.uid())
    )
  );

/*
 * ⚠ No insert, update or delete policy on either table, deliberately.
 *
 *   A client that could insert into `support_tickets` could set its own
 *   `status`, `first_response_at` and `reference` — which turns the queue's
 *   response-time numbers into whatever the client says they are. A client that
 *   could insert a message could set `author_role = 'admin'` and write a reply
 *   from Package Relay into their own thread. Both go through the functions
 *   below, which decide those columns themselves.
 */

-- ======================================================================== --
--                       telling the other side                             --
-- ======================================================================== --

/*
 * Notifies every admin about a ticket.
 *
 * ⚠ Every admin, not the assignee.
 *
 *   A new ticket has no assignee by definition, and the state this exists to
 *   prevent is a ticket nobody looks at because it arrived while the one person
 *   watching the queue was asleep. 49's unique key means one row per admin per
 *   subject, so a re-run cannot spam anybody.
 *
 * Internal. Callers are the functions below; nothing grants this to a client.
 */
create or replace function public.notify_support_admins(
  p_subject_id text,
  p_title text,
  p_body text,
  p_metadata jsonb default '{}'::jsonb,
  p_exclude uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_row record;
  queued integer := 0;
begin
  for admin_row in
    select p.id
      from public.profiles p
     where p.is_admin
       and p.deleted_at is null
       /*
        * Never notify the person who just acted. An operator who resolves a
        * ticket does not need a push telling them it was resolved, and a badge
        * that lights up for your own actions is a badge people stop reading.
        */
       and (p_exclude is null or p.id <> p_exclude)
  loop
    if public.queue_notification(
         admin_row.id, 'message_received', p_subject_id,
         p_title, p_body, coalesce(p_metadata, '{}'::jsonb), true
       ) is not null
    then
      queued := queued + 1;
    end if;
  end loop;

  return queued;
end;
$$;

-- ======================================================================== --
--                         the customer's side                              --
-- ======================================================================== --

/*
 * Opens a ticket, with its first message.
 *
 * ⚠ One call, one transaction, both rows. A ticket with no message is a subject
 *   line and nothing to act on, and the two-call version leaves one behind
 *   every time the network drops between them.
 */
create or replace function public.create_support_ticket(
  p_subject text,
  p_body text,
  p_category text default 'other',
  p_booking_id uuid default null
)
returns table (id uuid, reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  tracking text;
  ticket public.support_tickets;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  /*
   * An erased account cannot open a ticket.
   *
   * Its login still works — erasure blocks the policies, not the sign-in — and
   * a thread started from one would be free text attached to a person whose
   * data has already been destroyed on request.
   */
  if public.is_erased() then
    raise exception 'This account is closed. Email support instead.';
  end if;

  if btrim(coalesce(p_subject, '')) = '' then
    raise exception 'Give the ticket a subject so it can be found again.';
  end if;

  /*
   * Ten characters. Not arbitrary: "help" and "?" are the two most common
   * things typed into a support box, and both cost an operator a full
   * round trip to learn nothing.
   */
  if length(btrim(coalesce(p_body, ''))) < 10 then
    raise exception 'Tell us what happened — a few more words, so somebody can act on it.';
  end if;

  /*
   * The parcel link, verified against the caller.
   *
   * ⚠ This is an access check, not a convenience. `booking_id` is a uuid the
   *   client sends; without this, a ticket could be attached to a stranger's
   *   parcel, and the admin screen would then show that stranger's tracking id
   *   and route beside somebody else's name. A driver carrying it counts as
   *   theirs — a driver's support question is almost always about a job.
   */
  if p_booking_id is not null then
    select b.tracking_id into tracking
      from public.bookings b
     where b.id = p_booking_id
       and (b.sender_id = actor or b.driver_id = actor);

    if tracking is null then
      raise exception 'That parcel is not on your account.';
    end if;
  end if;

  /*
   * Five an hour.
   *
   * High enough that nobody legitimately hits it — a person with three
   * problems opens three tickets — and low enough that a retry loop in a
   * client cannot bury the queue before anybody notices.
   */
  if (
    select count(*)
      from public.support_tickets t
     where t.requester_id = actor
       and t.created_at > now() - interval '1 hour'
  ) >= 5 then
    raise exception 'You have opened several tickets in the last hour. Add to one of those instead.';
  end if;

  insert into public.support_tickets
    (requester_id, channel, category, subject, booking_id, booking_tracking_id,
     last_message_at, last_message_from)
  values (
    actor,
    'app',
    coalesce(nullif(btrim(p_category), ''), 'other'),
    btrim(p_subject),
    p_booking_id,
    tracking,
    now(),
    'customer'
  )
  returning * into ticket;

  insert into public.support_ticket_messages
    (ticket_id, author_id, author_role, visibility, body)
  values (ticket.id, actor, 'customer', 'public', btrim(p_body));

  /*
   * Logged as info, with no message body.
   *
   * `app_events` is readable by every admin and 07 says in so many words that
   * `context` must not carry personal data. What the customer wrote is
   * personal data; that a ticket exists is not.
   */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info',
    'support',
    'support ticket opened',
    jsonb_build_object('ticket', ticket.id, 'reference', ticket.reference,
                       'category', ticket.category, 'channel', 'app'),
    actor
  );

  perform public.notify_support_admins(
    ticket.id::text,
    'New support ticket: ' || ticket.reference,
    left(btrim(p_subject), 140),
    jsonb_build_object('ticket_id', ticket.id, 'reference', ticket.reference,
                       'category', ticket.category),
    actor
  );

  return query select ticket.id, ticket.reference;
end;
$$;

/*
 * The customer's reply.
 *
 * ⚠ A reply to a resolved ticket reopens it, and that is the point.
 *
 *   "That did not fix it" is the single most important thing a support system
 *   can hear, and the alternative is the customer opening a second ticket that
 *   nobody connects to the first. Reopening clears the resolution as well as
 *   the timestamp: a stale "we refunded you" sitting on an open ticket is worse
 *   than no note at all.
 */
create or replace function public.reply_support_ticket(p_ticket uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  ticket public.support_tickets;
  message_id uuid;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'Nothing to send.';
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket
     and t.requester_id = actor;

  if ticket.id is null then
    raise exception 'No such ticket';
  end if;

  insert into public.support_ticket_messages
    (ticket_id, author_id, author_role, visibility, body)
  values (p_ticket, actor, 'customer', 'public', btrim(p_body))
  returning id into message_id;

  update public.support_tickets
     set last_message_at = now(),
         last_message_from = 'customer',
         /*
          * Back into our court, from either of the two states where it was not.
          * `in_progress` is left alone — somebody is already on it, and moving
          * it backwards would take it off their screen.
          */
         status = case status
                    when 'waiting_on_customer' then 'open'
                    when 'resolved' then 'open'
                    else status
                  end,
         status_changed_at = case
                               when status in ('waiting_on_customer', 'resolved')
                               then now() else status_changed_at
                             end,
         resolved_at = null,
         resolution = case when status = 'resolved' then null else resolution end
   where id = p_ticket;

  /*
   * The assignee if there is one, everybody otherwise.
   *
   * An assigned ticket is somebody's job and telling the other three admins
   * about every reply on it is how a team learns to ignore the badge.
   */
  if ticket.assigned_admin_id is not null then
    perform public.queue_notification(
      ticket.assigned_admin_id, 'message_received', message_id::text,
      'Reply on ' || ticket.reference,
      left(btrim(p_body), 140),
      jsonb_build_object('ticket_id', p_ticket, 'reference', ticket.reference),
      true
    );
  else
    perform public.notify_support_admins(
      message_id::text,
      'Reply on ' || ticket.reference,
      left(btrim(p_body), 140),
      jsonb_build_object('ticket_id', p_ticket, 'reference', ticket.reference),
      actor
    );
  end if;

  return message_id;
end;
$$;

-- ======================================================================== --
--                           the admin's side                               --
-- ======================================================================== --

/*
 * The tiles at the top of the queue.
 *
 * ⚠ `awaiting_us` is not `open`.
 *
 *   A ticket can be In Progress and still be waiting on an answer from us, and
 *   an Open one whose last message was ours is not. The number an operator
 *   needs before lunch is "how many people are waiting to hear back", which is
 *   the last message's direction — not the status somebody last clicked.
 *
 * Aggregates only, 07's habit: counting tickets does not require handing
 * anybody the text inside them.
 */
create or replace function public.admin_support_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  select jsonb_build_object(
    'open', count(*) filter (where status = 'open'),
    'in_progress', count(*) filter (where status = 'in_progress'),
    'waiting_on_customer', count(*) filter (where status = 'waiting_on_customer'),
    'resolved', count(*) filter (where status = 'resolved'),
    'resolved_last_7_days', count(*) filter (
      where status = 'resolved' and resolved_at > now() - interval '7 days'
    ),
    'awaiting_us', count(*) filter (
      where status <> 'resolved' and last_message_from = 'customer'
    ),
    /*
      Never answered at all, which is a different failure from slow.

      A ticket with no first response is one nobody has spoken to; it is the
      only count on this screen that should be zero every evening.
    */
    'unanswered', count(*) filter (
      where status <> 'resolved' and first_response_at is null
    ),
    'oldest_waiting_hours', coalesce(
      round(
        extract(epoch from (
          now() - min(last_message_at) filter (
            where status <> 'resolved' and last_message_from = 'customer'
          )
        )) / 3600.0
      , 1),
      0
    ),
    'unassigned', count(*) filter (
      where status <> 'resolved' and assigned_admin_id is null
    )
  )
  into result
  from public.support_tickets;

  return result;
end;
$$;

/*
 * The queue itself.
 *
 * ⚠ No phone number and no address in the returned shape, even though this is
 *   a support screen and the operator is about to ring somebody.
 *
 *   17 made that call for parcels and the reason holds here: contact details
 *   come from `admin_reveal_parcel_contacts`, which writes an audit line naming
 *   who looked. A queue that printed a phone number on every row would put a
 *   hundred customers' numbers on screen to answer one of them, and would fill
 *   the audit log with entries nobody could act on.
 *
 *   The search *does* match a phone number, which is not a contradiction: the
 *   operator typing it already has it — somebody is on the line — and matching
 *   it is the difference between finding their ticket and asking them to spell
 *   a reference.
 */
create or replace function public.admin_support_queue(
  p_status text default 'all',
  p_search text default null,
  p_max_rows integer default 50
)
returns table (
  id uuid,
  reference text,
  status text,
  category text,
  channel text,
  subject text,
  requester_id uuid,
  requester_name text,
  requester_is_driver boolean,
  booking_id uuid,
  booking_tracking_id text,
  assigned_admin_id uuid,
  assigned_admin_name text,
  first_response_at timestamptz,
  last_message_at timestamptz,
  last_message_from text,
  message_count integer,
  created_at timestamptz,
  resolved_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  needle text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  return query
    select
      t.id,
      t.reference,
      t.status,
      t.category,
      t.channel,
      t.subject,
      t.requester_id,
      coalesce(nullif(btrim(requester.full_name), ''), 'Unnamed account')::text,
      /*
        Whether this person drives, so the queue can say which side of the
        marketplace is asking. A driver's "where is my money" and a sender's
        are different tickets with the same words in them.
      */
      exists (
        select 1
          from public.driver_applications a
         where a.user_id = t.requester_id
           and a.status = 'approved'
      ),
      t.booking_id,
      t.booking_tracking_id,
      t.assigned_admin_id,
      nullif(btrim(coalesce(assignee.full_name, '')), '')::text,
      t.first_response_at,
      t.last_message_at,
      t.last_message_from,
      (select count(*)::integer
         from public.support_ticket_messages m
        where m.ticket_id = t.id),
      t.created_at,
      t.resolved_at
    from public.support_tickets t
    left join public.profiles requester on requester.id = t.requester_id
    left join public.profiles assignee on assignee.id = t.assigned_admin_id
    where
      (
        p_status is null
        or p_status = 'all'
        /*
          'awaiting_us' is a filter, not a status.

          It is the queue's default view in the client — everything where the
          customer spoke last and nobody has answered — and it crosses three
          statuses. Expressing it as a status would have meant a fifth value in
          the check constraint that no operator ever sets by hand.
        */
        or (p_status = 'awaiting_us'
            and t.status <> 'resolved'
            and t.last_message_from = 'customer')
        or (p_status = 'unresolved' and t.status <> 'resolved')
        or t.status = p_status
      )
      and (
        needle is null
        or t.reference ilike '%' || needle || '%'
        or t.subject ilike '%' || needle || '%'
        or coalesce(t.booking_tracking_id, '') ilike '%' || needle || '%'
        or coalesce(requester.full_name, '') ilike '%' || needle || '%'
        or coalesce(requester.phone, '') ilike '%' || needle || '%'
      )
    /*
      Oldest movement first, and resolved ones last however recent.

      An operator opening this screen is looking for the person who has waited
      longest, the same argument 17 makes for the parcel list. Sorting by
      `created_at` instead would bury a two-week-old ticket that has been
      argued over twenty times under a fresh one nobody has read.
    */
    order by
      (t.status = 'resolved'),
      t.last_message_at asc
    limit greatest(1, least(coalesce(p_max_rows, 50), 200));
end;
$$;

/*
 * One ticket, in full. Same shape as a queue row plus the resolution text.
 *
 * A second call rather than widening the list, because `resolution` is prose
 * that only means anything next to the thread it belongs to.
 */
create or replace function public.admin_support_ticket(p_ticket uuid)
returns table (
  id uuid,
  reference text,
  status text,
  category text,
  channel text,
  subject text,
  requester_id uuid,
  requester_name text,
  requester_is_driver boolean,
  booking_id uuid,
  booking_tracking_id text,
  assigned_admin_id uuid,
  assigned_admin_name text,
  opened_by_admin_name text,
  first_response_at timestamptz,
  last_message_at timestamptz,
  last_message_from text,
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz,
  status_changed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  return query
    select
      t.id, t.reference, t.status, t.category, t.channel, t.subject,
      t.requester_id,
      coalesce(nullif(btrim(requester.full_name), ''), 'Unnamed account')::text,
      exists (
        select 1 from public.driver_applications a
         where a.user_id = t.requester_id and a.status = 'approved'
      ),
      t.booking_id, t.booking_tracking_id,
      t.assigned_admin_id,
      nullif(btrim(coalesce(assignee.full_name, '')), '')::text,
      nullif(btrim(coalesce(opener.full_name, '')), '')::text,
      t.first_response_at, t.last_message_at, t.last_message_from,
      t.resolution, t.resolved_at, t.created_at, t.status_changed_at
    from public.support_tickets t
    left join public.profiles requester on requester.id = t.requester_id
    left join public.profiles assignee on assignee.id = t.assigned_admin_id
    left join public.profiles opener on opener.id = t.opened_by_admin_id
    where t.id = p_ticket;
end;
$$;

/*
 * The thread, internal notes included.
 *
 * ⚠ The one function in this file whose output a customer must never see, which
 *   is why it is a definer function with an `is_admin()` gate rather than a
 *   widened RLS policy. The policy above cannot return an internal note; this
 *   is the only thing that can, and it is reachable exactly one way.
 */
create or replace function public.admin_support_messages(p_ticket uuid)
returns table (
  id uuid,
  author_id uuid,
  author_name text,
  author_role text,
  visibility text,
  body text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  return query
    select
      m.id,
      m.author_id,
      /*
        A departed admin reads as the company, not as a blank.

        `author_id` is `on delete set null`, so this is the ordinary state for
        any reply older than the person who wrote it.
      */
      coalesce(
        nullif(btrim(coalesce(author.full_name, '')), ''),
        case when m.author_role = 'admin' then 'Package Relay' else 'Unnamed account' end
      )::text,
      m.author_role,
      m.visibility,
      m.body,
      m.created_at
    from public.support_ticket_messages m
    left join public.profiles author on author.id = m.author_id
    where m.ticket_id = p_ticket
    order by m.created_at asc;
end;
$$;

/*
 * An admin's reply, public or internal.
 *
 * ⚠ A public reply moves an Open ticket to In Progress, and nothing else moves
 *   on its own.
 *
 *   That one transition is safe — answering something is starting work on it —
 *   and it saves the operator a click they would otherwise forget, which is how
 *   a queue fills up with Open tickets that have all been answered. Resolving
 *   stays manual, because only a person knows whether the answer worked.
 */
create or replace function public.admin_reply_support_ticket(
  p_ticket uuid,
  p_body text,
  p_internal boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  ticket public.support_tickets;
  message_id uuid;
  internal boolean := coalesce(p_internal, false);
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can reply to a support ticket';
  end if;

  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'Nothing to send.';
  end if;

  select * into ticket from public.support_tickets t where t.id = p_ticket;

  if ticket.id is null then
    raise exception 'No such ticket';
  end if;

  insert into public.support_ticket_messages
    (ticket_id, author_id, author_role, visibility, body)
  values (
    p_ticket, actor, 'admin',
    case when internal then 'internal' else 'public' end,
    btrim(p_body)
  )
  returning id into message_id;

  /*
   * An internal note leaves every dated column alone.
   *
   * `last_message_at` drives the queue's sort and `first_response_at` is the
   * response-time metric; letting a note nobody outside the building can read
   * touch either one would make a ticket look answered and drop it down the
   * queue, which is precisely the ticket that then goes cold.
   */
  if not internal then
    update public.support_tickets
       set last_message_at = now(),
           last_message_from = 'admin',
           first_response_at = coalesce(first_response_at, now()),
           status = case when status = 'open' then 'in_progress' else status end,
           status_changed_at = case when status = 'open' then now() else status_changed_at end
     where id = p_ticket;

    perform public.queue_notification(
      ticket.requester_id, 'message_received', message_id::text,
      'Package Relay replied to ' || ticket.reference,
      left(btrim(p_body), 140),
      jsonb_build_object('ticket_id', p_ticket, 'reference', ticket.reference),
      true
    );
  end if;

  return message_id;
end;
$$;

/*
 * Moves a ticket.
 *
 * ⚠ Resolving requires a note, and the note goes to the customer.
 *
 *   A ticket closed with no explanation is indistinguishable, from the outside,
 *   from one that was ignored — and from the inside, six months later, from one
 *   nobody can remember the outcome of. So the note is written into the thread
 *   as a public reply and pushed, rather than filed where only staff can read
 *   it. Every other transition is internal bookkeeping and stays silent.
 */
create or replace function public.admin_set_support_status(
  p_ticket uuid,
  p_status text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  ticket public.support_tickets;
  note text := btrim(coalesce(p_note, ''));
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change a support ticket';
  end if;

  if p_status not in ('open', 'in_progress', 'waiting_on_customer', 'resolved') then
    raise exception 'Unknown status: %', p_status;
  end if;

  select * into ticket from public.support_tickets t where t.id = p_ticket;

  if ticket.id is null then
    raise exception 'No such ticket';
  end if;

  if p_status = 'resolved' and length(note) < 4 then
    raise exception 'Say what resolved it — the customer is sent this note.';
  end if;

  if p_status = 'resolved' then
    update public.support_tickets
       set status = 'resolved',
           status_changed_at = now(),
           resolved_at = now(),
           resolution = note,
           last_message_at = now(),
           last_message_from = 'admin',
           first_response_at = coalesce(first_response_at, now())
     where id = p_ticket;

    insert into public.support_ticket_messages
      (ticket_id, author_id, author_role, visibility, body)
    values (p_ticket, actor, 'admin', 'public', note);

    perform public.queue_notification(
      ticket.requester_id, 'message_received', p_ticket::text || ':resolved',
      'Your support ticket ' || ticket.reference || ' is resolved',
      left(note, 140),
      jsonb_build_object('ticket_id', p_ticket, 'reference', ticket.reference),
      true
    );
  else
    update public.support_tickets
       set status = p_status,
           status_changed_at = now(),
           /* Reopening: the constraint and the stale note both have to go. */
           resolved_at = null,
           resolution = case when ticket.status = 'resolved' then null else resolution end
     where id = p_ticket;

    /* An internal note, when one was given. Optional outside resolving. */
    if length(note) > 0 then
      insert into public.support_ticket_messages
        (ticket_id, author_id, author_role, visibility, body)
      values (p_ticket, actor, 'admin', 'internal', note);
    end if;
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info',
    'support',
    'support ticket status changed',
    jsonb_build_object('ticket', p_ticket, 'reference', ticket.reference,
                       'from', ticket.status, 'to', p_status),
    actor
  );
end;
$$;

/*
 * Assign, reassign, or hand it back to the pile.
 *
 * `p_admin` null unassigns. Assigning to somebody who is not an admin is
 * refused rather than silently ignored: an assignee who cannot open the queue
 * is a ticket that has been quietly taken off everybody's screen.
 */
create or replace function public.admin_assign_support_ticket(
  p_ticket uuid,
  p_admin uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can assign a support ticket';
  end if;

  if p_admin is not null
     and not coalesce((select p.is_admin from public.profiles p where p.id = p_admin), false)
  then
    raise exception 'That person is not an administrator.';
  end if;

  update public.support_tickets
     set assigned_admin_id = p_admin
   where id = p_ticket;

  if not found then
    raise exception 'No such ticket';
  end if;
end;
$$;

/*
 * Logs an inquiry that arrived by phone or email.
 *
 * ⚠ The first message is filed as an internal note authored by the admin, not
 *   as the customer's own words.
 *
 *   Because it is not their words — it is an operator's summary of a phone
 *   call, and attributing it to the customer would put a sentence in their
 *   mouth inside the record we would rely on in a dispute. The customer sees
 *   the ticket and every public reply on it; what they do not see is somebody
 *   else's paraphrase of what they said.
 */
/*
 * ⚠ Dropped first, because an earlier cut of this file had one fewer argument.
 *
 *   `create or replace` with a changed signature makes an *overload*, not a
 *   replacement, and two overloads that differ by one defaulted argument make
 *   every call ambiguous — PostgREST included. Re-running this file on a project
 *   that applied the earlier version has to remove that one.
 */
drop function if exists public.admin_create_support_ticket(uuid, text, text, text, text, uuid);

create or replace function public.admin_create_support_ticket(
  p_requester uuid,
  p_subject text,
  p_body text,
  p_category text default 'other',
  p_channel text default 'phone',
  p_booking_id uuid default null,
  /*
   * The tracking id, because that is what an operator has.
   *
   * ⚠ A person on the phone reads out "PKR-4F2K9", never a uuid. Taking only
   *   `booking_id` here would mean the parcel link — the thing that makes this
   *   ticket findable from the parcel and the parcel readable from the ticket —
   *   could only ever be set by the in-app form, and every phoned-in ticket
   *   would arrive unlinked. Resolved against the requester below, so a mistyped
   *   id that happens to exist cannot attach a stranger's parcel.
   */
  p_tracking_id text default null
)
returns table (id uuid, reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  tracking text;
  booking_uuid uuid := p_booking_id;
  ticket public.support_tickets;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can log a support ticket';
  end if;

  if p_requester is null
     or not exists (select 1 from public.profiles p where p.id = p_requester)
  then
    raise exception 'Pick the account this is about.';
  end if;

  if btrim(coalesce(p_subject, '')) = '' then
    raise exception 'Give the ticket a subject so it can be found again.';
  end if;

  if coalesce(p_channel, '') not in ('phone', 'email', 'app') then
    raise exception 'Unknown channel: %', p_channel;
  end if;

  /*
   * The parcel has to belong to the person the ticket is about — the same check
   * the self-serve path makes, against the requester rather than the caller.
   * An operator typing a tracking id from a phone call gets the digits wrong
   * sometimes, and a mistyped one that happens to exist would attach a
   * stranger's parcel to this thread.
   */
  if p_booking_id is not null then
    select b.tracking_id into tracking
      from public.bookings b
     where b.id = p_booking_id
       and (b.sender_id = p_requester or b.driver_id = p_requester);

    if tracking is null then
      raise exception 'That parcel is not on that account.';
    end if;

  elsif nullif(btrim(coalesce(p_tracking_id, '')), '') is not null then
    /*
      Case-insensitively, because a tracking id is read down a phone line and
      typed back by hand. `tracking_id` is unique, so this matches one row or
      none.
    */
    select b.id, b.tracking_id into booking_uuid, tracking
      from public.bookings b
     where upper(b.tracking_id) = upper(btrim(p_tracking_id))
       and (b.sender_id = p_requester or b.driver_id = p_requester);

    if tracking is null then
      raise exception 'No parcel on that account has the tracking ID %.', btrim(p_tracking_id);
    end if;
  end if;

  insert into public.support_tickets
    (requester_id, opened_by_admin_id, channel, category, subject,
     booking_id, booking_tracking_id, last_message_at, last_message_from)
  values (
    p_requester, actor, coalesce(p_channel, 'phone'),
    coalesce(nullif(btrim(p_category), ''), 'other'),
    btrim(p_subject), booking_uuid, tracking, now(),
    /*
      'customer', because they are the ones waiting.

      The queue's "awaiting us" count is the last message's direction, and a
      phoned-in ticket is by definition something a customer is waiting on an
      answer for. Recording the intake note as ours would hide it from the one
      view an operator works from.
    */
    'customer'
  )
  returning * into ticket;

  if length(btrim(coalesce(p_body, ''))) > 0 then
    insert into public.support_ticket_messages
      (ticket_id, author_id, author_role, visibility, body)
    values (ticket.id, actor, 'admin', 'internal', btrim(p_body));
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info',
    'support',
    'support ticket logged by an admin',
    jsonb_build_object('ticket', ticket.id, 'reference', ticket.reference,
                       'subject_account', p_requester, 'channel', p_channel),
    actor
  );

  return query select ticket.id, ticket.reference;
end;
$$;

-- ======================================================================== --
--                             erasure                                      --
-- ======================================================================== --

/*
 * Scrubs the threads of an erased account.
 *
 * ⚠ A trigger on `profiles.deleted_at`, not an edit to `erase_person`.
 *
 *   `erase_person` lives in 33, a pushed migration, and it is 160 lines of
 *   statements each of which exists because something leaked. Recreating it
 *   here to append two deletes would mean retyping all of it — and this
 *   codebase's most repeated failure, called out in CLAUDE.md, is recreating
 *   something verbatim and quietly dropping one of its conditions.
 *
 *   Setting `profiles.deleted_at` is the last thing an erasure does and the
 *   only thing that does it (09 forbids a client from touching that column), so
 *   the transition null → not null is exactly the hook, and it cannot drift
 *   out of step with a function this file never edits.
 *
 * ⚠ The shell stays, the content goes.
 *
 *   That an account raised four tickets and had them resolved is operational
 *   history — the same argument 33 makes for keeping `driver_earnings` and the
 *   payout rows. What they typed is not: a support thread is the one place in
 *   this schema where an address or a phone number arrives as prose, and no
 *   column constraint can stop it.
 */
create or replace function public.scrub_support_tickets_on_erase()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.support_ticket_messages m
   where m.ticket_id in (
     select t.id from public.support_tickets t where t.requester_id = new.id
   );

  update public.support_tickets
     set subject = 'Removed',
         /* Staff prose about a person is still about that person. */
         resolution = case when resolution is null then null else 'Removed' end
   where requester_id = new.id;

  return new;
end;
$$;

drop trigger if exists scrub_support_on_erase on public.profiles;
create trigger scrub_support_on_erase
  after update of deleted_at on public.profiles
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.scrub_support_tickets_on_erase();

-- ======================================================================== --
--                              grants                                      --
-- ======================================================================== --

/*
 * ⚠ `anon` is revoked from every one of these.
 *
 *   The anon key ships inside the app bundle and inside the web build. A
 *   definer function granted to anon is a public HTTP endpoint with the
 *   database's owner rights behind it, and `admin_support_messages` is the
 *   worst possible one to leave open — it is the only path to an internal note.
 */
revoke all on function public.notify_support_admins(text, text, text, jsonb, uuid)
  from public, anon, authenticated;

revoke all on function public.create_support_ticket(text, text, text, uuid) from public, anon;
revoke all on function public.reply_support_ticket(uuid, text) from public, anon;
revoke all on function public.admin_support_counts() from public, anon;
revoke all on function public.admin_support_queue(text, text, integer) from public, anon;
revoke all on function public.admin_support_ticket(uuid) from public, anon;
revoke all on function public.admin_support_messages(uuid) from public, anon;
revoke all on function public.admin_reply_support_ticket(uuid, text, boolean) from public, anon;
revoke all on function public.admin_set_support_status(uuid, text, text) from public, anon;
revoke all on function public.admin_assign_support_ticket(uuid, uuid) from public, anon;
revoke all on function public.admin_create_support_ticket(uuid, text, text, text, text, uuid, text)
  from public, anon;

grant execute on function public.create_support_ticket(text, text, text, uuid) to authenticated;
grant execute on function public.reply_support_ticket(uuid, text) to authenticated;
grant execute on function public.admin_support_counts() to authenticated;
grant execute on function public.admin_support_queue(text, text, integer) to authenticated;
grant execute on function public.admin_support_ticket(uuid) to authenticated;
grant execute on function public.admin_support_messages(uuid) to authenticated;
grant execute on function public.admin_reply_support_ticket(uuid, text, boolean) to authenticated;
grant execute on function public.admin_set_support_status(uuid, text, text) to authenticated;
grant execute on function public.admin_assign_support_ticket(uuid, uuid) to authenticated;
grant execute on function public.admin_create_support_ticket(uuid, text, text, text, text, uuid, text)
  to authenticated;

/*
 * ⚠ The admin_* functions are granted to `authenticated`, not to some admin
 *   role, and that is not a gap.
 *
 *   Postgres has no way to grant execute to "rows of profiles where is_admin",
 *   and Supabase issues one JWT role for every signed-in person. So the gate is
 *   the `is_admin()` check at the top of each function — the same arrangement
 *   07 uses for `admin_overview` and 58 for the money. Any non-admin who calls
 *   one gets an exception, not an empty list, which is also what the screens
 *   above them expect.
 */

-- ======================================================================== --
--                      what this file does NOT do                          --
-- ======================================================================== --

/*
 * 1. No email. A public reply lights up the in-app inbox and sends a push (49's
 *    spine), and it does not put anything in `email_outbox`. It should: the
 *    person who emailed support@ is the person least likely to open the app.
 *    That needs a new `kind` in 38's check constraint and a template in
 *    `notify-events`, which is a migration and an Edge Function deploy — a
 *    separate change, deployed in step, rather than a half-wired one here.
 *
 * 2. No priority column. Urgency here is derivable — a parcel in transit with
 *    nobody answering is `awaiting_us` plus `oldest_waiting_hours` — and a
 *    priority field with no rule behind it becomes three operators' private
 *    conventions in the same column.
 *
 * 3. No SLA clock and no auto-close sweep. Both want `pg_cron` and a policy
 *    somebody has actually agreed to; inventing "closes after 7 days idle"
 *    would silently resolve tickets nobody answered, which is the failure this
 *    whole table exists to make visible.
 *
 * 4. No retention sweep, unlike 49. A notification is a nudge; a support thread
 *    is the record of what a customer was told, and the NDPR request that ends
 *    it is erasure, which is handled above.
 */
