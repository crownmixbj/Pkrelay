-- LOCI — bookings schema and access policies.
--
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query,
-- paste, Run. It is written to be re-runnable.
--
-- The rules this encodes, in plain terms:
--   * A parcel belongs to the sender who posted it.
--   * An unclaimed parcel is visible to any signed-in driver — that's the job feed.
--   * Once claimed, only the sender and the assigned driver can see it.
--   * Only the sender can create; only the assigned driver can advance status.
--   * Two drivers cannot claim the same job.
--
-- These are enforced by Postgres, not by the app. The app's gates are there so
-- the UI behaves sensibly; these policies are what actually stop a determined
-- client, because anyone can read the anon key out of the bundle.

-- ---------------------------------------------------------------- bookings --

create table if not exists public.bookings (
  id            uuid primary key default gen_random_uuid(),
  tracking_id   text not null unique,

  delivery_type text not null check (delivery_type in ('local', 'interstate')),
  pickup_mode   text not null check (pickup_mode in ('hub', 'meetpoint', 'doorstep')),
  dropoff_mode  text not null check (dropoff_mode in ('hub', 'meetpoint', 'doorstep')),

  origin_city      text not null,
  destination_city text not null,
  pickup_area      text not null default '',
  dropoff_area     text not null default '',
  pickup_address   text not null default '',
  dropoff_address  text not null default '',

  pickup_contact_name text not null default '',
  sender_phone        text not null default '',
  recipient_name      text not null default '',
  recipient_phone     text not null default '',

  item_description text not null,
  -- Storage path, once uploads exist. Local device URIs are meaningless to
  -- anyone else, so the client sends null rather than a file:// string.
  item_photo_uri   text,
  category         text not null,
  weight           numeric not null check (weight > 0 and weight <= 100),
  declared_value   numeric not null default 0 check (declared_value >= 0),
  fragile          boolean not null default false,
  notes            text not null default '',

  estimated_fee numeric not null check (estimated_fee >= 0),

  -- Ownership. `on delete cascade`: if an account is deleted its parcels go
  -- with it, rather than becoming orphans nobody can see or clean up.
  sender_id uuid not null references auth.users (id) on delete cascade,

  status text not null default 'Booked' check (
    status in ('Booked', 'Assigned', 'Picked Up', 'In Transit', 'Out for Delivery', 'Delivered')
  ),

  -- Driver name is denormalised so the sender can see who is carrying their
  -- parcel without being able to read the whole auth.users row.
  driver      text,
  driver_id   uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),

  -- The two move together or not at all. Without this a bug could leave a job
  -- with a driver_id and no name, which renders as a blank carrier.
  constraint driver_pair_consistent check (
    (driver is null and driver_id is null) or (driver is not null and driver_id is not null)
  ),

  -- A driver cannot carry their own parcel.
  constraint driver_is_not_sender check (driver_id is null or driver_id <> sender_id)
);

-- The job feed filters on these three, and My Jobs on driver_id.
create index if not exists bookings_open_feed_idx
  on public.bookings (origin_city, destination_city)
  where driver_id is null;
create index if not exists bookings_sender_idx on public.bookings (sender_id);
create index if not exists bookings_driver_idx on public.bookings (driver_id);

alter table public.bookings enable row level security;

-- ---------------------------------------------------------------- policies --

drop policy if exists "read own, carried, or unclaimed" on public.bookings;
create policy "read own, carried, or unclaimed"
  on public.bookings for select
  to authenticated
  using (
    sender_id = (select auth.uid())
    or driver_id = (select auth.uid())
    -- The open feed. Unclaimed parcels are visible to every signed-in user,
    -- which is the point — a driver has to see a job before taking it.
    or driver_id is null
  );

drop policy if exists "sender creates own" on public.bookings;
create policy "sender creates own"
  on public.bookings for insert
  to authenticated
  with check (
    sender_id = (select auth.uid())
    -- A parcel cannot be posted pre-assigned; claiming is a separate step.
    and driver_id is null
    and driver is null
    and status = 'Booked'
  );

/*
  Updates.

  `using` decides which rows you may attempt to update; `with check` decides
  what the row is allowed to look like afterwards. Both are needed here:

    * A driver may claim a row that is currently unclaimed (using), and the
      result must name them (with check). Because `using` re-evaluates against
      the row as it stands, two simultaneous claims cannot both succeed — the
      second sees driver_id already set and matches no row.

    * The assigned driver may advance an already-claimed row (using), but may
      not hand it to someone else (with check pins driver_id to themselves).

    * The sender may update their own row, but may not assign a driver — that
      is the driver's action, not theirs.
*/
drop policy if exists "claim or advance" on public.bookings;
create policy "claim or advance"
  on public.bookings for update
  to authenticated
  using (
    (driver_id is null and status = 'Booked')
    or driver_id = (select auth.uid())
    or sender_id = (select auth.uid())
  )
  with check (
    driver_id = (select auth.uid())
    or (sender_id = (select auth.uid()) and driver_id is null)
  );

-- No delete policy: with RLS enabled and no policy, deletes are refused for
-- everyone. Cancelling a parcel should be a status change with an audit trail,
-- not a row disappearing.

-- ------------------------------------------------------- immutable columns --

/*
  RLS says who may update a row; it cannot say which columns. Without this, a
  driver who can legitimately claim a job could also rewrite the fee, the
  addresses, or who sent it. This pins the fields nobody should be able to
  change after the fact.
*/
create or replace function public.bookings_guard_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sender_id     is distinct from old.sender_id
     or new.tracking_id  is distinct from old.tracking_id
     or new.estimated_fee is distinct from old.estimated_fee
     or new.created_at   is distinct from old.created_at then
    raise exception 'sender_id, tracking_id, estimated_fee and created_at are immutable';
  end if;

  -- A claimed job cannot be silently handed to a different driver.
  if old.driver_id is not null and new.driver_id is distinct from old.driver_id then
    raise exception 'a claimed job cannot be reassigned';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_guard_immutable on public.bookings;
create trigger bookings_guard_immutable
  before update on public.bookings
  for each row execute function public.bookings_guard_immutable();
