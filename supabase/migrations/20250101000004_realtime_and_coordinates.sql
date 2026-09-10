-- LOCI — realtime application status, and coordinates for the map.
--
-- Run after 01, 02 and 03. Re-runnable.

do $$
begin
  if to_regclass('public.driver_applications') is null then
    raise exception 'Run 20250101000002_driver_applications.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------- realtime ----

/*
  Realtime broadcasts row changes over a websocket. Two things matter here:

  1. The table must be in the `supabase_realtime` publication, or no events are
     emitted at all.
  2. `replica identity full` makes Postgres include the *old* row in the change
     payload. Without it the client receives only the new values and cannot tell
     `pending -> approved` from `approved -> approved`, so it would toast on
     every unrelated edit.

  RLS still applies to realtime: a subscriber only receives rows they could have
  read with a select. An applicant therefore cannot listen to anyone else's
  application, even by removing the client-side filter.
*/
alter table public.driver_applications replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'driver_applications'
  ) then
    alter publication supabase_realtime add table public.driver_applications;
  end if;
end
$$;

-- Bookings too, so a sender sees a parcel move to Assigned without a refresh.
alter table public.bookings replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'bookings'
  ) then
    alter publication supabase_realtime add table public.bookings;
  end if;
end
$$;

-- ---------------------------------------------------------- coordinates ----

/*
  Where the parcel is actually collected and delivered.

  Nullable because every parcel posted before this column existed has no pin,
  and because a sender may skip the map. The UI falls back to the text address,
  which is what it did before — a missing pin is a missing pin, not a broken
  screen.

  Stored as two numerics rather than PostGIS geography: the app only needs to
  drop markers and draw a straight line, and adding an extension for that would
  be weight without benefit. Revisit if you ever need "jobs within 5km of me".
*/
alter table public.bookings
  add column if not exists pickup_lat  numeric,
  add column if not exists pickup_lng  numeric,
  add column if not exists dropoff_lat numeric,
  add column if not exists dropoff_lng numeric;

/*
  Bounds check rather than a bare -90..90: a coordinate outside Nigeria is
  almost certainly a swapped lat/lng pair, which is the classic mapping bug and
  otherwise shows a parcel somewhere off the coast of Africa.

  Nigeria spans roughly 4.2°N to 13.9°N and 2.6°E to 14.7°E. The margin is
  deliberate.
*/
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_coords_in_nigeria'
  ) then
    alter table public.bookings add constraint bookings_coords_in_nigeria check (
      (pickup_lat is null or (pickup_lat between 3.5 and 14.5))
      and (pickup_lng is null or (pickup_lng between 2.0 and 15.5))
      and (dropoff_lat is null or (dropoff_lat between 3.5 and 14.5))
      and (dropoff_lng is null or (dropoff_lng between 2.0 and 15.5))
    );
  end if;
end
$$;

/* A pin is a pair. Half of one is a bug, not a partial answer. */
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_coords_paired'
  ) then
    alter table public.bookings add constraint bookings_coords_paired check (
      (pickup_lat is null) = (pickup_lng is null)
      and (dropoff_lat is null) = (dropoff_lng is null)
    );
  end if;
end
$$;
