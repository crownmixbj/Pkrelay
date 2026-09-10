-- LOCI — the partner hub network, moved out of source and into a table.
--
-- Run after 01–07. Re-runnable, and safe to re-run after editing hubs in the
-- app: the seed uses `on conflict do nothing`, so it never overwrites a change
-- someone made through the Admin area.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'Run 20250101000002_driver_applications.sql first.';
  end if;
  if to_regclass('public.app_events') is null then
    raise exception 'Run 20250101000007_admin.sql first — hub edits are audited into app_events.';
  end if;
end
$$;

-- ------------------------------------------------------------------ table ---

/*
  Text ids, not uuids, and deliberately the same ones the constant used
  ('lag-1', 'ib-3'). The booking form stores a hub id against a parcel, so
  regenerating them would orphan every existing booking's pickup hub.
*/
create table if not exists public.hubs (
  id         text primary key,
  name       text not null,
  area       text not null,
  city       text not null,
  address    text not null,
  hours      text not null,
  phone      text not null,
  services   text[] not null default '{}',
  flagship   boolean not null default false,

  /*
    A surveyed position, or null to fall back to the neighbourhood centre in
    `constants/hubs.ts`. Null is the honest default: nothing has been surveyed.
  */
  lat numeric,
  lng numeric,

  /*
    Closing a hub without deleting it. A deleted row would break any booking
    that references it; `active = false` hides it from senders while keeping
    the history readable.
  */
  active boolean not null default true,

  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,

  /*
    Nigeria's bounding box, the same check `20250101000004_realtime_and_coordinates.sql`
    applies to parcel coordinates. It catches the two mistakes that actually
    happen: swapped lat/lng, which lands in the Gulf of Guinea, and a missing
    decimal point, which lands in Chad.
  */
  constraint hub_lat_in_nigeria check (lat is null or (lat between 3.5 and 14.5)),
  constraint hub_lng_in_nigeria check (lng is null or (lng between 2.5 and 15.5)),
  -- Half a coordinate is not a position.
  constraint hub_coords_paired check ((lat is null) = (lng is null))
);

create index if not exists hubs_city_idx on public.hubs (city) where active;

alter table public.hubs enable row level security;

/*
  Readable by everyone, signed in or not.

  Hub addresses and opening hours are public information — they are printed on
  the Hubs page for anyone deciding where to drop a parcel, and gating them
  behind sign-in would make that page useless to the people it is for.
*/
drop policy if exists "hubs are public" on public.hubs;
create policy "hubs are public"
  on public.hubs for select
  to anon, authenticated
  using (true);

/*
  Written by admins only.

  Three separate policies rather than `for all`, so each verb is visible. An
  admin who can edit an address can also close a hub, and both are worth being
  able to see at a glance.
*/
drop policy if exists "admins insert hubs" on public.hubs;
create policy "admins insert hubs"
  on public.hubs for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "admins update hubs" on public.hubs;
create policy "admins update hubs"
  on public.hubs for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

/*
  No delete policy. Deactivating is the supported way to close a hub — a delete
  would orphan the bookings that reference it, and there is no reason an
  operations task needs to destroy history.
*/

-- ------------------------------------------------------------ audit trail ---

/*
  Stamps who changed a hub, and records it.

  `updated_by` is set from `auth.uid()` here rather than trusted from the
  client, which could otherwise attribute its edit to someone else. The
  `app_events` row means hub changes show up in System Logs & Errors alongside
  everything else, without a second audit table to build a viewer for.
*/
create or replace function public.hubs_stamp_and_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changes text := '';
begin
  new.updated_at := now();
  new.updated_by := auth.uid();

  if tg_op = 'UPDATE' then
    -- Only the fields worth reading back. A diff of every column would bury
    -- the address change that someone is actually looking for.
    if new.address is distinct from old.address then
      changes := changes || format('address: %s -> %s; ', old.address, new.address);
    end if;
    if new.area is distinct from old.area then
      changes := changes || format('area: %s -> %s; ', old.area, new.area);
    end if;
    if new.hours is distinct from old.hours then
      changes := changes || format('hours: %s -> %s; ', old.hours, new.hours);
    end if;
    if new.phone is distinct from old.phone then
      changes := changes || format('phone: %s -> %s; ', old.phone, new.phone);
    end if;
    if new.active is distinct from old.active then
      changes := changes || format('active: %s -> %s; ', old.active, new.active);
    end if;
    if (new.lat, new.lng) is distinct from (old.lat, old.lng) then
      changes := changes || 'coordinates changed; ';
    end if;

    -- Nothing meaningful moved — a save with no edits is not worth a log row.
    if changes = '' then
      return new;
    end if;
  else
    changes := 'created';
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'info',
    'hubs',
    format('%s %s: %s', lower(tg_op), new.id, changes),
    jsonb_build_object('hub_id', new.id, 'city', new.city),
    auth.uid()
  );

  return new;
end;
$$;

drop trigger if exists hubs_stamp on public.hubs;
create trigger hubs_stamp
  before insert or update on public.hubs
  for each row execute function public.hubs_stamp_and_audit();

-- ------------------------------------------------------------------- seed ---

/*
  The network as it stood in `src/constants/hubs.ts`.

  `on conflict do nothing` is the important part: this file is re-runnable, and
  re-running it after an admin has corrected an address must not put the wrong
  one back.

  Coordinates are left null on purpose. The app falls back to the neighbourhood
  centres in the constant and labels those pins approximate; writing them here
  would make guesses look like surveyed positions.
*/
insert into public.hubs (id, name, area, city, address, hours, phone, services, flagship) values
  ('lag-1', 'LOCI Ikeja Hub', 'Ikeja', 'Lagos', '45 Allen Avenue, Ikeja, Lagos', 'Mon–Sat, 8:00am – 8:00pm', '+2348030001101', array['Drop-off','Collection','Packaging'], true),
  ('lag-2', 'LOCI Yaba Counter', 'Yaba', 'Lagos', '12 Herbert Macaulay Way, Yaba, Lagos', 'Mon–Fri, 9:00am – 6:00pm', '+2348030001102', array['Drop-off','Collection'], false),
  ('lag-3', 'LOCI Lekki Point', 'Lekki', 'Lagos', '3 Admiralty Way, Lekki Phase 1, Lagos', 'Mon–Sat, 9:00am – 7:00pm', '+2348030001103', array['Drop-off','Collection'], false),
  ('ib-1', 'LOCI Bodija Hub', 'Bodija', 'Ibadan', '18 Awolowo Avenue, Old Bodija, Ibadan', 'Mon–Sat, 8:00am – 7:00pm', '+2348030002201', array['Drop-off','Collection','Packaging'], true),
  ('ib-2', 'LOCI Dugbe Counter', 'Dugbe', 'Ibadan', '8 Lebanon Street, Dugbe, Ibadan', 'Mon–Fri, 9:00am – 6:00pm', '+2348030002202', array['Drop-off','Collection'], false),
  ('ib-3', 'LOCI Ring Road Point', 'Ring Road', 'Ibadan', '22 Ring Road, Challenge, Ibadan', 'Mon–Sat, 8:00am – 8:00pm', '+2348030002203', array['Drop-off'], false),
  ('ib-4', 'LOCI Mokola Counter', 'Mokola', 'Ibadan', '5 Mokola Roundabout, Ibadan', 'Mon–Sat, 8:00am – 7:00pm', '+2348030002204', array['Drop-off','Collection'], false),
  ('ib-5', 'LOCI Challenge Point', 'Challenge', 'Ibadan', '31 Challenge Road, Ibadan', 'Mon–Sat, 8:00am – 6:00pm', '+2348030002205', array['Drop-off'], false),
  ('ib-6', 'LOCI UI/Agbowo Counter', 'UI/Agbowo', 'Ibadan', '2 Agbowo Express, Beside UI Gate, Ibadan', 'Mon–Sat, 9:00am – 7:00pm', '+2348030002206', array['Drop-off','Collection'], false),
  ('ib-7', 'LOCI Iwo Road Hub', 'Iwo Road', 'Ibadan', '9 Iwo Road Interchange, Ibadan', 'Mon–Sat, 7:30am – 8:00pm', '+2348030002207', array['Drop-off','Collection'], false),
  ('ib-8', 'LOCI Apata Counter', 'Apata', 'Ibadan', '16 Apata Ganga Road, Ibadan', 'Mon–Fri, 9:00am – 6:00pm', '+2348030002208', array['Drop-off','Collection'], false),
  ('ib-9', 'LOCI Sango Point', 'Sango', 'Ibadan', '4 Sango–Eleyele Road, Ibadan', 'Mon–Sat, 8:00am – 6:00pm', '+2348030002209', array['Drop-off'], false),
  ('ib-10', 'LOCI Akobo Counter', 'Akobo', 'Ibadan', '27 Akobo Ojurin Road, Ibadan', 'Mon–Fri, 9:00am – 6:00pm', '+2348030002210', array['Drop-off','Collection'], false),
  ('abj-1', 'LOCI Wuse II Hub', 'Wuse II', 'Abuja', '14 Aminu Kano Crescent, Wuse II, Abuja', 'Mon–Sat, 8:00am – 7:00pm', '+2348030003301', array['Drop-off','Collection','Packaging'], true),
  ('abj-2', 'LOCI Garki Counter', 'Garki', 'Abuja', '9 Moshood Abiola Way, Garki, Abuja', 'Mon–Fri, 9:00am – 6:00pm', '+2348030003302', array['Drop-off','Collection'], false),
  ('abj-3', 'LOCI Gwarinpa Point', 'Gwarinpa', 'Abuja', '5th Avenue, Gwarinpa Estate, Abuja', 'Mon–Sat, 9:00am – 7:00pm', '+2348030003303', array['Drop-off'], false),
  ('ph-1', 'LOCI Port Harcourt Hub', 'GRA Phase 2', 'Port Harcourt', '3 Aba Road, GRA Phase 2, Port Harcourt', 'Mon–Fri, 9:00am – 6:00pm', '+2348030004401', array['Drop-off','Collection'], false)
on conflict (id) do nothing;
