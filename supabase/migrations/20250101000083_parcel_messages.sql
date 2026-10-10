-- ============================================================================
-- 20250101000083_parcel_messages.sql — driver ↔ sender chat on a parcel
-- ============================================================================
--
-- Run after 82. Re-runnable. Apply to BOTH staging and production.
--
-- Once a driver has a parcel, they and the sender can message each other in
-- the app — "I'm at the gate", "use the side entrance", "running 10 minutes
-- late" — instead of only phoning.
--
-- Shape of the rules:
--
--   * A message belongs to a parcel AND to the driver who held it when it was
--     sent (`driver_id`). If a driver releases the job and another takes it,
--     the first driver loses the thread and the second starts clean; the
--     sender keeps both.
--   * Reading: the sender, the driver the message was exchanged with, or an
--     admin. Nobody else, ever — RLS, not the client, decides.
--   * Writing: only through `send_parcel_message`, and only while the job is
--     live (Assigned, Picked Up, In Transit). A finished or cancelled parcel
--     keeps its history read-only. No direct INSERT policy exists.
--   * Each message notifies the other person through `queue_notification`
--     (`message_received`, already an allowed kind), which feeds the in-app
--     inbox and push. A burst is one push: while the recipient still has an
--     unread message notification for this parcel from the last 10 minutes,
--     no new one is queued.
-- ============================================================================

create table if not exists public.parcel_messages (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  driver_id   uuid not null references auth.users(id) on delete cascade,
  author_id   uuid not null references auth.users(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  constraint parcel_messages_body_length
    check (char_length(btrim(body)) between 1 and 1000)
);

create index if not exists parcel_messages_thread_idx
  on public.parcel_messages (booking_id, driver_id, created_at);

-- Unread lookups: "messages to me I have not read".
create index if not exists parcel_messages_unread_idx
  on public.parcel_messages (booking_id)
  where read_at is null;

alter table public.parcel_messages enable row level security;

drop policy if exists "parcel chat participants read" on public.parcel_messages;
create policy "parcel chat participants read"
  on public.parcel_messages for select
  to authenticated
  using (
    driver_id = (select auth.uid())
    or exists (
      select 1 from public.bookings b
      where b.id = parcel_messages.booking_id
        and b.sender_id = (select auth.uid())
    )
    or public.is_admin()
  );

-- No insert/update/delete policies: every write goes through the functions below.
revoke insert, update, delete on public.parcel_messages from anon, authenticated;
grant select on public.parcel_messages to authenticated;

-- --------------------------------------------------------------- sending ---

create or replace function public.send_parcel_message(p_booking uuid, p_body text)
returns public.parcel_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  parcel record;
  clean text := btrim(coalesce(p_body, ''));
  recipient uuid;
  saved public.parcel_messages;
  preview text;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if char_length(clean) = 0 then
    raise exception 'Type a message first';
  end if;
  if char_length(clean) > 1000 then
    raise exception 'Messages are limited to 1000 characters';
  end if;

  select b.id, b.sender_id, b.driver_id, b.driver, b.status, b.tracking_id
    into parcel
  from public.bookings b
  where b.id = p_booking;

  if parcel.id is null then
    raise exception 'No such parcel';
  end if;

  if actor <> parcel.sender_id and actor is distinct from parcel.driver_id then
    raise exception 'Only the sender and the driver on this parcel can message about it';
  end if;

  if parcel.driver_id is null then
    raise exception 'No driver has this parcel yet, so there is nobody to message';
  end if;

  if parcel.status not in ('Assigned', 'Picked Up', 'In Transit') then
    raise exception 'This parcel is %, so its chat is closed', lower(parcel.status);
  end if;

  insert into public.parcel_messages (booking_id, driver_id, author_id, body)
  values (parcel.id, parcel.driver_id, actor, clean)
  returning * into saved;

  recipient := case when actor = parcel.sender_id then parcel.driver_id else parcel.sender_id end;

  preview := case when char_length(clean) > 140 then left(clean, 137) || '…' else clean end;

  -- One push per burst: skip while an unread message notice for this parcel is recent.
  if not exists (
    select 1 from public.notifications n
    where n.user_id = recipient
      and n.kind = 'message_received'
      and n.metadata ->> 'booking_id' = parcel.id::text
      and n.read_at is null
      and n.created_at > now() - interval '10 minutes'
  ) then
    perform public.queue_notification(
      recipient,
      'message_received',
      saved.id::text,
      case
        when actor = parcel.sender_id then 'New message from the sender · #' || parcel.tracking_id
        else 'New message from ' || coalesce(nullif(btrim(parcel.driver), ''), 'your driver')
             || ' · #' || parcel.tracking_id
      end,
      preview,
      jsonb_build_object('booking_id', parcel.id::text, 'message_id', saved.id::text),
      true
    );
  end if;

  return saved;
end;
$$;

revoke all on function public.send_parcel_message(uuid, text) from public, anon;
grant execute on function public.send_parcel_message(uuid, text) to authenticated;

-- ------------------------------------------------------------ reading -------

/*
  Marks everything the caller has received on this parcel as read, and clears
  the matching inbox notifications so the bell agrees with the chat.
*/
create or replace function public.mark_parcel_messages_read(p_booking uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  touched integer;
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  update public.parcel_messages m
     set read_at = now()
   where m.booking_id = p_booking
     and m.read_at is null
     and m.author_id <> actor
     and (
       m.driver_id = actor
       or exists (
         select 1 from public.bookings b
         where b.id = m.booking_id and b.sender_id = actor
       )
     );
  get diagnostics touched = row_count;

  update public.notifications n
     set read_at = now()
   where n.user_id = actor
     and n.kind = 'message_received'
     and n.read_at is null
     and n.metadata ->> 'booking_id' = p_booking::text;

  return touched;
end;
$$;

revoke all on function public.mark_parcel_messages_read(uuid) from public, anon;
grant execute on function public.mark_parcel_messages_read(uuid) to authenticated;

-- ------------------------------------------------------------- realtime -----

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication missing; skipping (local Postgres?)';
    return;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'parcel_messages'
  ) then
    alter publication supabase_realtime add table public.parcel_messages;
  end if;
end
$$;
