-- LOCI — document storage, and a Slack alert on every new application.
--
-- Run after 01–04. Re-runnable.

do $$
begin
  if to_regclass('public.driver_applications') is null then
    raise exception 'Run 20250101000002_driver_applications.sql first.';
  end if;
end
$$;

-- ------------------------------------------------------------- storage ----

/*
  A PRIVATE bucket. `public: false` is the single most important line in this
  file: a public bucket hands out a permanent, unauthenticated URL for every
  object, and these objects are driver's licences, government IDs and insurance
  certificates. Anyone who ever saw such a URL — in a log, a screenshot, a
  browser history — would keep access forever.

  Everything is read through short-lived signed URLs instead.
*/
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'driver-documents',
  'driver-documents',
  false,
  10485760, -- 10 MB, matching the client-side cap
  array['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/*
  Path convention: `<user_id>/<document_key>.<ext>`

  The policies below compare the first path segment to `auth.uid()`, which is
  what confines an applicant to their own folder. It also means the path itself
  carries the ownership — there is no separate table to consult and no way for
  the two to disagree.

  `storage.foldername(name)` returns the segments; `[1]` is the first.
*/

drop policy if exists "own documents: read" on storage.objects;
create policy "own documents: read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'driver-documents'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      -- Reviewers must see what they are reviewing.
      or public.is_admin()
    )
  );

drop policy if exists "own documents: upload" on storage.objects;
create policy "own documents: upload"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

/*
  Replacing a document is an update to an existing object, which an applicant
  needs while their application is still open — a blurry licence photo should be
  fixable without starting again.
*/
drop policy if exists "own documents: replace" on storage.objects;
create policy "own documents: replace"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

/*
  No delete policy. Deleting evidence after submitting it is not something an
  applicant should be able to do, and an admin who needs to purge a rejected
  application can do it from the dashboard as the service role. This also gives
  you somewhere to hang a retention job later.
*/

-- --------------------------------------------------- new-application alert --

/*
  Calls an Edge Function whenever an application is inserted.

  Why a trigger rather than Supabase's dashboard "Database Webhooks": this
  lives in the repo, so it is reviewable, versioned and deployed with everything
  else. A webhook configured by hand in a dashboard is invisible to anyone
  reading the code and vanishes if the project is recreated.

  `pg_net` sends the request asynchronously, so a slow or dead Slack does not
  hold open the transaction that is inserting the application. An alert failing
  must never stop someone applying.
*/
create extension if not exists pg_net with schema extensions;

/*
  The function URL and the service key live in a settings table rather than
  being hardcoded, so this file carries no secrets and can be committed.

  Populate it once (values from Project Settings -> API):

    insert into private.app_settings (key, value) values
      ('edge_url', 'https://<project-ref>.supabase.co/functions/v1'),
      ('service_key', '<your service_role key>')
    on conflict (key) do update set value = excluded.value;

  ⚠ The service_role key belongs ONLY here and in Edge Function secrets. It must
    never appear in the app bundle or in `.env` — it bypasses every RLS policy
    in this project.
*/
create schema if not exists private;

create table if not exists private.app_settings (
  key   text primary key,
  value text not null
);

-- No policies, and RLS on: nothing reachable through the API can read this.
alter table private.app_settings enable row level security;
revoke all on private.app_settings from anon, authenticated;

create or replace function public.notify_new_driver_application()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  edge_url text;
  service_key text;
begin
  select value into edge_url from private.app_settings where key = 'edge_url';
  select value into service_key from private.app_settings where key = 'service_key';

  -- Not configured yet: applications must still succeed.
  if edge_url is null or service_key is null then
    return new;
  end if;

  perform extensions.net.http_post(
    url := edge_url || '/notify-application',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'reference', new.reference,
      'full_name', new.full_name,
      'phone', new.phone,
      'email', new.email,
      'state', new.state,
      'base_city', new.base_city,
      'vehicle_type', new.vehicle_type,
      'submitted_at', new.submitted_at
      -- Deliberately NOT sent: NIN, bank account, guarantor details. A Slack
      -- channel is not an appropriate home for identity documents, and this
      -- payload crosses a third-party boundary.
    )
  );

  return new;
exception
  when others then
    -- An alert is a nice-to-have. Never let it roll back an application.
    raise warning 'notify_new_driver_application failed: %', sqlerrm;
    return new;
end;
$$;

drop trigger if exists on_driver_application_created on public.driver_applications;
create trigger on_driver_application_created
  after insert on public.driver_applications
  for each row execute function public.notify_new_driver_application();
