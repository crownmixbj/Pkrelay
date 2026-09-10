/*
  20250101000031_document_expiry.sql — documents that go out of date, and what that costs.

  Until now a driver's documents were a jsonb blob on the application:

      documents = {"licence": "u1/licence.jpg", "insurance": "u1/insurance.pdf"}

  A path and nothing else. No expiry, no verification state, no history of
  replacement. That was adequate while the only question was "did they attach
  one", and it stops being adequate the moment the answer has to be "is it still
  valid" — a key/value map has nowhere to put a date, and bolting one on as
  `{"licence": {"path": ..., "expires": ...}}` makes every existing reader wrong
  at once with no type to catch it.

  So documents become rows. The jsonb stays where it is and is backfilled from,
  not deleted: an application submitted last year is the evidence a reviewer
  approved, and rewriting it to fit a new shape would edit the record of a
  decision somebody already made.

  ⚠ THE ONE CONSEQUENTIAL DECISION IN THIS FILE

    An expired *licence or insurance* stops a driver being offered parcels.
    Chosen deliberately over warn-only: the alternative is LOCI knowingly
    dispatching an uninsured rider, and "we sent them a reminder" is not a
    defence anyone would want to make after a crash.

    It is also the decision most likely to hurt somebody. A driver who does not
    open the app for a fortnight can find themselves silently unable to earn.
    Everything below is shaped by that risk rather than in spite of it:

      · reminders start 30 days out, not on the day
      · they escalate, and they repeat daily *after* expiry rather than stopping
      · the driver is told the specific document and the specific date
      · the block is stated on their own screens, not left to be inferred from
        an absence of offers
      · `dispatch_blockers()` exists so the reason is always retrievable

    A block whose reason a driver cannot see is indistinguishable from the app
    being broken, and they will conclude the second thing.

  Requires: 20250101000002_driver_applications.sql, 20250101000007_admin.sql, 20250101000026_departure_time.sql.
*/

do $$
begin
  if to_regclass('public.driver_applications') is null then
    raise exception 'Run 20250101000002_driver_applications.sql first.';
  end if;
  if to_regprocedure('public.dispatch_booking(uuid)') is null then
    raise exception 'Run 20250101000015_dispatch.sql and its successors first.';
  end if;
end
$$;

-- ------------------------------------------------------------- the policy --

/**
 * Which document slots exist, and what each one's expiry means.
 *
 * A table rather than a CHECK constraint or an enum, because this is
 * operational policy and not structure: a regulator adding a roadworthiness
 * certificate next year is an insert, and turning an enum into a migration for
 * that is how a schema ends up with `document_kind_v2`.
 *
 * `blocks_dispatch` is the whole point. Only two of the five documents have any
 * force on the road — a stale vehicle photograph is untidy, an expired
 * insurance certificate is a liability — so only two of them can stop a driver
 * working. Making all five blocking would idle a driver over the age of a
 * photograph, which is the kind of rule that gets worked around rather than
 * followed.
 */
create table if not exists public.document_kinds (
  key text primary key,
  label text not null,

  /*
    Whether an expiry date must be supplied at upload.

    False for slots that do not meaningfully expire. Asking for a date on a
    photo of a motorbike produces a date somebody invented, which is worse than
    no date: a reminder will then fire about it, on a schedule derived from
    fiction.
  */
  expiry_required boolean not null default false,

  /** Whether the date may be given at all. False means the field is not shown. */
  expiry_allowed boolean not null default true,

  /** Past expiry, this document stops the driver receiving offers. */
  blocks_dispatch boolean not null default false,

  sort_order integer not null default 0
);

/*
  ⚠ Three of the five slots carry no expiry date at all, and the government ID
    slots are the ones worth explaining.

    They accept a NIN slip, a National ID card or a Voter's Card — none of which
    expires — and a NIN is what almost everybody uploads. An optional date field
    on a document with no date printed on it does not produce an empty field; it
    produces a date somebody invented, and the reminder ladder then runs on
    fiction and chases a driver about a document that cannot lapse.

    The cost is real and small: a driver who uploads an International Passport
    into that slot loses expiry tracking on it. That slot never blocks dispatch,
    so nothing stops working — the loss is a reminder LOCI would have sent about
    a document it does not gate on. Cheaper than the alternative, which is a
    field five drivers in six should leave blank and will not.

  ⚠ The key is `license`, US spelling, and the label is `licence`, British.

    That looks like a mistake and is not. The key must match what
    `src/app/(tabs)/driver-signup.tsx` has been writing into the `documents`
    jsonb and into the storage path `<uid>/license.jpg` since the form shipped.
    Spelling it `licence` here would leave the backfill matching nothing, every
    existing licence unmodelled, and — because a document that does not exist
    cannot be expired — the dispatch block silently inert for the one document
    it most needs to cover.

    The label is what a Nigerian driver reads, so that stays British. Renaming
    the key is a data migration, not a spelling fix, and is not worth doing.
*/
/*
  ⚠ The licence is two rows, and only the front one gates anything.

    The back carries the expiry date and the vehicle class, so it is required
    evidence — but `blocks_dispatch` and `expiry_allowed` are both false on it.
    One licence has one expiry, recorded on the front row, which is the row that
    stops a driver working. Marking both blocking would idle somebody twice over
    one card; giving both a date would give LOCI two answers to reconcile.

  ⚠ The government ID slots are NIN only now.

    They used to accept a passport or a voter's card. Only the NIN is checked
    against a government record — `verify-liveness` matches a selfie against the
    NIMC photo for the applicant's NIN — so anything else in that slot was a
    document nobody could verify.

  ⚠ Comments belong OUT here, not between the value rows.

    `scripts/pg/documents-harness.mjs` extracts this statement by slicing to the
    first semicolon. A comment inside it containing one truncates the insert, and
    the harness then fails on an unterminated block comment rather than on
    anything real. Cheap to avoid, confusing to diagnose.
*/
insert into public.document_kinds (key, label, expiry_required, expiry_allowed, blocks_dispatch, sort_order)
values
  ('license',     'Driver''s licence (front)',    true,  true,  true,  1),
  ('licenseBack', 'Driver''s licence (back)',     false, false, false, 2),
  ('insurance',   'Car insurance',                true,  true,  true,  3),
  ('id',          'Your NIN slip',                false, false, false, 4),
  ('guarantorId', 'Guarantor''s NIN slip',        false, false, false, 5),
  ('vehicle',     'Vehicle picture',              false, false, false, 6)
on conflict (key) do update set
  label = excluded.label,
  expiry_required = excluded.expiry_required,
  expiry_allowed = excluded.expiry_allowed,
  blocks_dispatch = excluded.blocks_dispatch,
  sort_order = excluded.sort_order;

alter table public.document_kinds enable row level security;

drop policy if exists "anyone signed in reads document kinds" on public.document_kinds;
create policy "anyone signed in reads document kinds"
  on public.document_kinds for select
  to authenticated
  using (true);

/* No write policy. Policy changes are migrations, not client calls. */

-- ------------------------------------------------------------- the records --

create table if not exists public.driver_documents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users (id) on delete cascade,
  application_id uuid references public.driver_applications (id) on delete cascade,

  kind text not null references public.document_kinds (key),

  /** Storage path in the private `driver-documents` bucket. */
  path text not null,

  /*
    Null where the kind does not carry one.

    A `date` and not a `timestamptz`: a licence expires on a day, in the
    driver's own calendar, and storing 00:00 UTC would expire a Lagos licence an
    hour before midnight local. Comparisons below use `current_date`.
  */
  expires_at date,

  /*
    Where the document stands with a human.

    'pending'  uploaded, nobody has looked
    'verified' a reviewer accepted it
    'rejected' a reviewer refused it, with a reason

    Deliberately NOT derived from the application's status. An approved driver
    who uploads a renewed insurance certificate has one new pending document and
    four verified ones; collapsing that into the application status would either
    un-approve them for a routine renewal or mark the new file verified because
    an old one was.
  */
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'rejected')),
  review_note text,
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,

  uploaded_at timestamptz not null default now(),

  /*
    How far the reminder ladder has climbed for *this* document.

    Null until the first reminder. Reset to null on every replacement, because
    a renewed certificate starts a new life and its ladder starts again — see
    `record_document`. This is what stops the daily sweep sending the same
    "expires in 30 days" notice thirty times.
  */
  reminder_stage integer,
  reminded_at timestamptz,

  /*
    One current document per slot, per driver.

    Re-uploading replaces rather than accumulates, matching the storage path
    convention in `src/store/driver-documents.ts` — the file at
    `<uid>/<kind>.<ext>` is overwritten, so a second row would point at the same
    bytes and a reviewer would have to guess which record was live.
  */
  unique (driver_id, kind)
);

create index if not exists driver_documents_driver_idx
  on public.driver_documents (driver_id);

/*
  The sweep's index.

  Partial, on the rows a sweep can possibly act on: a document with no expiry
  never expires, and the daily job should not walk past vehicle photographs to
  discover that.
*/
create index if not exists driver_documents_expiry_idx
  on public.driver_documents (expires_at)
  where expires_at is not null;

alter table public.driver_documents enable row level security;

drop policy if exists "read own documents" on public.driver_documents;
create policy "read own documents"
  on public.driver_documents for select
  to authenticated
  using (driver_id = (select auth.uid()) or public.is_admin());

/*
  No client write policy. `record_document` below is the only door, so a driver
  cannot set `status = 'verified'` on their own licence — which, without this,
  is a one-line PATCH away.
*/

-- ------------------------------------------------------------ the reading --

/**
 * How many days until this document lapses. Negative once it has.
 *
 * Null for a document with no expiry, which is not the same as zero and must
 * not be coalesced to it — `days_left = 0` means "today is the last day".
 */
create or replace function public.document_days_left(expires date)
returns integer
language sql
immutable
as $$
  select case when expires is null then null else expires - current_date end;
$$;

/**
 * How far ahead LOCI starts asking for a renewal.
 *
 * ⚠ Defined BEFORE `document_state`, which calls it, and the order is not
 *   cosmetic.
 *
 *   Postgres validates the body of a `language sql` function when it is
 *   created, so a forward reference to a function that does not exist yet fails
 *   outright with `42883: function ... does not exist`. plpgsql is lazier —
 *   it only parses — which is why every other forward reference in this project
 *   has been harmless and this one was not.
 *
 *   It shipped the wrong way round and failed on the first real run. The PGlite
 *   harness missed it because it loaded functions from a curated list that
 *   happened to be in dependency order rather than in file order; it now sorts
 *   by position in the file so the ordering under test is the ordering that
 *   will execute.
 */
create or replace function public.document_warning_days()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select value::integer from private.app_settings where key = 'document_warning_days'),
    30
  );
$$;

revoke all on function public.document_warning_days() from public, anon;
grant execute on function public.document_warning_days() to authenticated;

/**
 * One word for the state of a document.
 *
 *   ok        no expiry, or comfortably in date
 *   expiring  inside the warning window
 *   expired   past its date
 *
 * ⚠ `immutable` is wrong here and `stable` is right: it reads `current_date`.
 *   The same mislabelling on `journey_matches` produced a matcher that Postgres
 *   was entitled to constant-fold, which is the sort of bug that only appears
 *   under a plan you did not test. See 20250101000022_matcher_volatility.sql.
 */
create or replace function public.document_state(expires date)
returns text
language sql
stable
as $$
  select case
    when expires is null then 'ok'
    when expires < current_date then 'expired'
    when expires - current_date <= public.document_warning_days() then 'expiring'
    else 'ok'
  end;
$$;

-- -------------------------------------------------------------- the block --

/**
 * Why this driver cannot be offered parcels, as rows.
 *
 * Returns nothing when they are clear. Written to return the *reasons* rather
 * than a boolean, because every screen that has to tell a driver why they have
 * stopped receiving work needs the specific document and the specific date —
 * and a boolean forces each of those screens to re-derive it, differently.
 */
create or replace function public.dispatch_blockers(driver uuid default null)
returns table (
  kind text,
  label text,
  expires_at date,
  days_left integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.kind, k.label, d.expires_at, public.document_days_left(d.expires_at)
  from public.driver_documents d
  join public.document_kinds k on k.key = d.kind
  where d.driver_id = coalesce(driver, (select auth.uid()))
    and (
      coalesce(driver, (select auth.uid())) = (select auth.uid())
      or public.is_admin()
    )
    and k.blocks_dispatch
    and d.expires_at is not null
    and d.expires_at < current_date
  order by d.expires_at asc;
$$;

revoke all on function public.dispatch_blockers(uuid) from public, anon;
grant execute on function public.dispatch_blockers(uuid) to authenticated;

/**
 * Whether this driver's documents permit dispatch.
 *
 * ⚠ A driver with NO document rows passes.
 *
 *   This is the single most important line in the file to get right, and the
 *   obvious reading — "no valid documents, so refuse" — would have taken every
 *   existing approved driver off the road the moment this migration ran. Their
 *   documents live in the old jsonb; the backfill below creates rows without
 *   dates, because the dates were never collected and inventing them would be
 *   fabricating a compliance record.
 *
 *   So the rule is "no *expired* blocking document", not "has valid documents".
 *   The gap is real and is closed by asking drivers for the dates, not by
 *   locking them out until they answer.
 */
create or replace function public.documents_permit_dispatch(driver uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.driver_documents d
    join public.document_kinds k on k.key = d.kind
    where d.driver_id = driver
      and k.blocks_dispatch
      and d.expires_at is not null
      and d.expires_at < current_date
  );
$$;

revoke all on function public.documents_permit_dispatch(uuid) from public, anon;
grant execute on function public.documents_permit_dispatch(uuid) to authenticated;

-- ------------------------------------------------------------- the writing --

/**
 * Records an uploaded document, or replaces one.
 *
 * The only write path. Called after the bytes are in storage, so a failed
 * upload never produces a row claiming a file exists.
 */
create or replace function public.record_document(
  document_kind text,
  storage_path text,
  expires date default null,
  application uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  spec record;
  new_id uuid;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select * into spec from public.document_kinds where key = document_kind;
  if spec.key is null then
    raise exception 'Unknown document type: %', document_kind;
  end if;

  if expires is not null and not spec.expiry_allowed then
    raise exception '% does not have an expiry date', spec.label;
  end if;

  if expires is null and spec.expiry_required then
    raise exception 'Please give the expiry date on your %', spec.label;
  end if;

  /*
    A date already in the past is refused at the point of entry.

    Accepting it would create a document that is expired the instant it is
    uploaded, and — because the ladder resets on replacement — immediately fire
    a fresh "expired" reminder about the file the driver just sent. Better to
    say so while they are still looking at the certificate.
  */
  if expires is not null and expires < current_date then
    raise exception 'That % expired on %. Please upload a current one.',
      spec.label, to_char(expires, 'DD Mon YYYY');
  end if;

  insert into public.driver_documents
    (driver_id, application_id, kind, path, expires_at, status)
  values (actor, application, document_kind, storage_path, expires, 'pending')
  on conflict (driver_id, kind) do update set
    path = excluded.path,
    expires_at = excluded.expires_at,
    application_id = coalesce(excluded.application_id, public.driver_documents.application_id),
    uploaded_at = now(),
    /*
      A replacement is unreviewed, and its reminder ladder starts again.

      Carrying the old `verified` across would let a driver swap an approved
      licence for anything at all and keep the badge. Carrying the old
      `reminder_stage` across would mean a renewal that is now three years out
      still sits at "expires in 7 days" and sends nothing until it is nearly
      due — the reset is what makes the ladder describe *this* document.
    */
    status = 'pending',
    review_note = null,
    reviewed_by = null,
    reviewed_at = null,
    reminder_stage = null,
    reminded_at = null
  returning id into new_id;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'documents', 'driver uploaded a document',
    -- The kind and the date. Not the path: `app_events` is readable by more
    -- people than the document bucket is.
    jsonb_build_object('kind', document_kind, 'expires_at', expires), actor
  );

  return new_id;
end;
$$;

revoke all on function public.record_document(text, text, date, uuid) from public, anon;
grant execute on function public.record_document(text, text, date, uuid) to authenticated;

/**
 * Lets a driver correct or supply an expiry date without re-uploading.
 *
 * The backfill below leaves every existing document dateless, and requiring a
 * fresh scan of a licence somebody already sent — purely to type a date next to
 * it — is the kind of busywork that makes people ignore the prompt entirely.
 *
 * The file is untouched, so this does not reset `status`: a reviewer already
 * looked at those bytes and they have not changed.
 */
create or replace function public.set_document_expiry(document_kind text, expires date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  spec record;
  current_row record;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  select * into spec from public.document_kinds where key = document_kind;
  if spec.key is null or not spec.expiry_allowed then
    raise exception 'That document does not have an expiry date';
  end if;

  if expires is null then
    raise exception 'Give the date shown on the document';
  end if;

  select * into current_row
  from public.driver_documents
  where driver_id = actor and kind = document_kind;

  if current_row.id is null then
    raise exception 'Upload your % first', spec.label;
  end if;

  /*
    A document that is comfortably in date is read-only.

    ⚠ Enforced HERE as well as in the app, and that is the point of the check.

      The client hides the field, which stops the honest mistake. It stops
      nothing else: this is a `supabase.rpc` call, and anyone who can open the
      network tab can send it. Without this branch, "you cannot change the date
      on a valid licence" would be a statement about a form rather than about
      the system — and the whole reason for the rule is that a driver should
      renew the card rather than push the date out.

      The window matches `canEditExpiry` in `src/store/documents.ts`: unlocked
      with no date on file, once inside the renewal window, or after it lapses.
  */
  if current_row.expires_at is not null
     and current_row.expires_at - current_date > public.document_warning_days()
  then
    raise exception
      'Your % is valid until %. You can update the date once renewal is due.',
      spec.label, to_char(current_row.expires_at, 'DD Mon YYYY');
  end if;

  update public.driver_documents
     set expires_at = expires,
         -- New date, new ladder. Otherwise a correction from "last week" to
         -- "next year" leaves the document stuck at its final reminder stage.
         reminder_stage = null,
         reminded_at = null
   where driver_id = actor and kind = document_kind;
end;
$$;

revoke all on function public.set_document_expiry(text, date) from public, anon;
grant execute on function public.set_document_expiry(text, date) to authenticated;

/** A reviewer accepting or refusing one document. Admins only. */
create or replace function public.review_document(
  document_id uuid,
  outcome text,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  if outcome not in ('verified', 'rejected') then
    raise exception 'Outcome must be verified or rejected';
  end if;

  update public.driver_documents
     set status = outcome,
         review_note = note,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = document_id;

  if not found then
    raise exception 'No such document';
  end if;
end;
$$;

revoke all on function public.review_document(uuid, text, text) from public, anon;
grant execute on function public.review_document(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- the feed --

/**
 * Every document slot for the signed-in driver, uploaded or not.
 *
 * A LEFT JOIN from `document_kinds`, so a slot the driver has never filled
 * comes back as a row with a null path rather than as an absence. The screen
 * showing this has to render "Vehicle picture — not uploaded" as prominently as
 * the ones that are there; building that list from only what exists means
 * computing the difference against the policy table on the client, in every
 * client.
 */
create or replace function public.my_documents()
returns table (
  kind text,
  label text,
  path text,
  status text,
  review_note text,
  expires_at date,
  days_left integer,
  state text,
  expiry_required boolean,
  expiry_allowed boolean,
  blocks_dispatch boolean,
  uploaded_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    k.key,
    k.label,
    d.path,
    coalesce(d.status, 'missing'),
    d.review_note,
    d.expires_at,
    public.document_days_left(d.expires_at),
    case when d.path is null then 'missing' else public.document_state(d.expires_at) end,
    k.expiry_required,
    k.expiry_allowed,
    k.blocks_dispatch,
    d.uploaded_at
  from public.document_kinds k
  left join public.driver_documents d
    on d.kind = k.key and d.driver_id = (select auth.uid())
  order by k.sort_order;
$$;

revoke all on function public.my_documents() from public, anon;
grant execute on function public.my_documents() to authenticated;

/*
  Dates recorded against a slot that no longer allows one.

  Defensive rather than expected: expiry arrived in this same file, so on a
  first run there is nothing to clear. It matters on a *re-run* after the policy
  narrowed — a driver who typed a date into the government ID slot before the
  change would otherwise keep a date `record_document` now refuses to set and
  `set_document_expiry` now refuses to touch, leaving a value nobody can correct.
*/
update public.driver_documents d
   set expires_at = null, reminder_stage = null, reminded_at = null
  from public.document_kinds k
 where k.key = d.kind
   and not k.expiry_allowed
   and d.expires_at is not null;

-- ------------------------------------------------------------ the backfill --

/*
  Existing applications, moved across without dates.

  ⚠ Deliberately no dates, and deliberately `status = 'verified'` for approved
    drivers.

    There is no honest expiry to give: it was never asked for. Guessing one —
    "licences last five years, so five years from the application date" — would
    write a fabricated compliance record that later reads as fact, and the
    dispatch block would then fire on a date nobody ever saw on a document.

    The status, by contrast, is knowable: an approved application is one a human
    looked at and accepted, documents included. Marking those 'pending' would
    put every working driver back in a review queue on the day this ran.
*/
insert into public.driver_documents (driver_id, application_id, kind, path, status)
select
  a.user_id,
  a.id,
  entry.key,
  entry.value #>> '{}',
  case when a.status = 'approved' then 'verified' else 'pending' end
from public.driver_applications a
cross join lateral jsonb_each(coalesce(a.documents, '{}'::jsonb)) as entry(key, value)
where entry.value is not null
  and jsonb_typeof(entry.value) = 'string'
  and entry.value #>> '{}' <> ''
  and exists (select 1 from public.document_kinds k where k.key = entry.key)
on conflict (driver_id, kind) do nothing;

-- ------------------------------------------------------------- the ladder --

/**
 * The reminder schedule, as days before expiry.
 *
 * Stage 0 is 30 days out and stage 4 is the day it lapses; stage 5 and beyond
 * is "already expired", which repeats daily. The array is the schedule, so
 * changing the cadence is changing one line rather than five branches.
 *
 * ⚠ It repeats *after* expiry rather than falling silent.
 *
 *   A reminder ladder that stops at the last rung is a ladder that goes quiet
 *   at exactly the moment the driver has stopped being able to earn. The one
 *   notification they cannot afford to miss is the one telling them why the
 *   offers stopped, so that one is sent every day until they fix it.
 */
create or replace function public.document_reminder_days()
returns integer[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select string_to_array(value, ',')::integer[]
     from private.app_settings where key = 'document_reminder_days'),
    array[30, 14, 7, 1]
  );
$$;

revoke all on function public.document_reminder_days() from public, anon;

/**
 * Which rung a document is on, given how many days are left.
 *
 * Returns null when nothing is due yet. Pure, so the schedule can be tested
 * without a clock, a database row, or a document.
 */
create or replace function public.reminder_stage_for(days_left integer, ladder integer[])
returns integer
language sql
immutable
as $$
  select case
    when days_left is null then null
    -- Past expiry: one stage beyond the last rung, and it stays there. The
    -- sweep re-sends this one daily rather than treating it as already done.
    when days_left < 0 then array_length(ladder, 1) + 1
    else (
      select max(i) from generate_subscripts(ladder, 1) i
      where days_left <= ladder[i]
    )
  end;
$$;

/**
 * The daily sweep. Writes one notice per document per rung.
 *
 * Returns how many it sent, so a scheduled run leaves evidence of having done
 * nothing as well as of having done something — a cron job that silently
 * returns void is indistinguishable from a cron job that is not running.
 */
create or replace function public.sweep_document_expiry()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ladder integer[] := public.document_reminder_days();
  expired_stage integer := array_length(ladder, 1) + 1;
  doc record;
  sent integer := 0;
  stage integer;
begin
  for doc in
    select d.id, d.driver_id, d.kind, d.expires_at, d.reminder_stage, d.reminded_at,
           k.label, k.blocks_dispatch,
           public.document_days_left(d.expires_at) as days_left
    from public.driver_documents d
    join public.document_kinds k on k.key = d.kind
    where d.expires_at is not null
  loop
    stage := public.reminder_stage_for(doc.days_left, ladder);

    if stage is null then
      continue;
    end if;

    /*
      Already handled?

      Three cases, not two, and the third one is a bug I shipped and the harness
      caught.

        · before expiry — a rung is sent once, ever
        · the FIRST expired notice — sent unconditionally
        · after that — repeats, but at most once a day

      The middle case is the one that was missing. `reminded_at` is shared by
      the whole ladder, so throttling the expired notice on "have we sent
      anything today" meant a document that got its "expires in 10 days" notice
      in the morning and then had its date corrected to a past one would have
      its *first* "you are no longer being offered parcels" message silently
      swallowed — and it would not be retried until the next day.

      The one message a driver cannot afford to miss must not be suppressed by
      an earlier, different message. So the daily throttle applies only once the
      document is already at the expired rung.
    */
    if stage < expired_stage then
      if doc.reminder_stage is not null and doc.reminder_stage >= stage then
        continue;
      end if;
    elsif doc.reminder_stage = expired_stage then
      if doc.reminded_at is not null and doc.reminded_at::date >= current_date then
        continue;
      end if;
    end if;

    insert into public.app_events (level, area, message, context, actor_id)
    values (
      case when doc.days_left < 0 and doc.blocks_dispatch then 'warning' else 'info' end,
      'documents',
      case
        when doc.days_left < 0 and doc.blocks_dispatch then
          'document expired — driver is no longer being offered parcels'
        when doc.days_left < 0 then 'document expired'
        else 'document expiring soon'
      end,
      jsonb_build_object(
        'kind', doc.kind,
        'label', doc.label,
        'expires_at', doc.expires_at,
        'days_left', doc.days_left,
        'blocks_dispatch', doc.blocks_dispatch
      ),
      doc.driver_id
    );

    update public.driver_documents
       set reminder_stage = stage, reminded_at = now()
     where id = doc.id;

    sent := sent + 1;
  end loop;

  return sent;
end;
$$;

revoke all on function public.sweep_document_expiry() from public, anon, authenticated;

/*
  Scheduled, not documented as a thing somebody should schedule.

  The same reasoning as the offer sweeper in 20250101000021_offer_windows.sql: a reminder
  system whose trigger lives in a runbook is a reminder system that runs until
  the person who read the runbook leaves. Daily at 07:00 UTC — 08:00 in Lagos,
  which is a working hour rather than the middle of the night.
*/
do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule('loci-document-expiry')
      where exists (select 1 from cron.job where jobname = 'loci-document-expiry');

    perform cron.schedule(
      'loci-document-expiry', '0 7 * * *',
      'select public.sweep_document_expiry()'
    );
  else
    insert into public.app_events (level, area, message, context)
    values (
      'warning', 'documents',
      'pg_cron is not installed, so expiry reminders will not be sent',
      jsonb_build_object('function', 'sweep_document_expiry')
    );
  end if;
end
$$;

-- -------------------------------------------------------- the dispatch gate --

/**
 * Dispatch, now skipping drivers whose blocking documents have lapsed.
 *
 * Identical to the version in 20250101000026_departure_time.sql apart from one predicate in
 * the candidate query — `documents_permit_dispatch(j.driver_id)`.
 *
 * ⚠ Filtered in the candidate query, not checked after choosing.
 *
 *   Choosing first and rejecting after would make a blocked driver *consume*
 *   the dispatch: the function returns having offered nothing, and the parcel
 *   waits for the next sweep while a perfectly available driver sits behind the
 *   one who was skipped. Excluding them from the pool means the next-best
 *   driver is picked in the same pass, and the parcel moves.
 *
 * ⚠ The parcel is never stranded by this. An expired driver is invisible to the
 *   matcher, not a dead end in it — if nobody else matches, the parcel stays
 *   unassigned and is swept again exactly as it would be with no drivers at all.
 */
create or replace function public.dispatch_booking(booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  parcel record;
  chosen record;
  offer_id uuid;
  local_trip boolean;
  hold interval;
  cooldown interval := public.offer_cooldown();
begin
  select id, origin_city, destination_city, weight, status, driver_id
    into parcel
  from public.bookings where id = booking_id;

  if parcel.id is null then
    return null;
  end if;

  if parcel.status <> 'Booked' or parcel.driver_id is not null then
    return null;
  end if;

  local_trip := parcel.origin_city = parcel.destination_city;
  hold := public.offer_hold(local_trip);

  update public.dispatch_offers
     set status = 'expired', responded_at = coalesce(responded_at, now())
   where dispatch_offers.booking_id = dispatch_booking.booking_id
     and status = 'offered'
     and expires_at <= now();

  if exists (
    select 1 from public.dispatch_offers
    where dispatch_offers.booking_id = dispatch_booking.booking_id
      and status = 'offered'
      and expires_at > now()
  ) then
    return null;
  end if;

  select j.id, j.driver_id
    into chosen
  from public.driver_journeys j
  where j.status = 'open'
    and public.journey_matches(
      j.origin_city, j.destination_city, j.departs_after, j.departs_before,
      j.capacity_kg, parcel.origin_city, parcel.destination_city, parcel.weight,
      j.mode, j.departure_time
    )
    -- The new predicate. See the note above on why it lives here.
    and public.documents_permit_dispatch(j.driver_id)
    and not exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id
        and o.driver_id = j.driver_id
        and o.status in ('declined', 'expired')
        and coalesce(
              case when o.status = 'expired' then o.expires_at else o.responded_at end,
              o.expires_at
            ) > now() - cooldown
    )
  order by
    (exists (
      select 1 from public.dispatch_offers o
      where o.booking_id = dispatch_booking.booking_id and o.driver_id = j.driver_id
    )) asc,
    coalesce(j.departure_time, j.departs_before) asc,
    (j.capacity_kg - coalesce(parcel.weight, 0)) asc,
    j.created_at asc
  limit 1;

  if chosen.id is null then
    return null;
  end if;

  insert into public.dispatch_offers (booking_id, journey_id, driver_id, expires_at)
  values (booking_id, chosen.id, chosen.driver_id, now() + hold)
  on conflict do nothing
  returning id into offer_id;

  if offer_id is null then
    return null;
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info', 'dispatch', 'parcel offered to a driver',
    jsonb_build_object(
      'booking', booking_id,
      'journey', chosen.id,
      'hold_minutes', extract(epoch from hold) / 60,
      'cooldown_minutes', extract(epoch from cooldown) / 60,
      'repeat', exists (
        select 1 from public.dispatch_offers o
        where o.booking_id = dispatch_booking.booking_id
          and o.driver_id = chosen.driver_id
          and o.id <> offer_id
      )
    ),
    null
  );

  return offer_id;
end;
$$;

revoke all on function public.dispatch_booking(uuid) from public, anon, authenticated;
