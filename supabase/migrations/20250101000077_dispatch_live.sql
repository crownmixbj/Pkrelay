-- ============================================================================
-- 20250101000077_dispatch_live.sql — Dispatch & Assignment updates itself
-- ============================================================================
--
-- Run after 76. Re-runnable. Apply to BOTH staging and production.
--
-- The admin Dispatch screen now listens for changes instead of waiting for a
-- manual reload (`src/hooks/use-live-refresh.ts`). Everything it shows is
-- computed from three tables, and Realtime needs two things for each:
--
--   1. The table in the `supabase_realtime` publication. `bookings` has been
--      since 04; `dispatch_offers` and `driver_journeys` never were.
--
--   2. A SELECT policy that lets the listener read the row. Realtime applies
--      RLS to `postgres_changes`: a subscriber only receives rows they could
--      select. `dispatch_offers` and `driver_journeys` already allow
--      `is_admin()` (15). `bookings` does not — admins have always read
--      parcels through `security definer` RPCs — so an admin's subscription
--      received nothing when a parcel was booked.
--
-- ⚠ The new bookings policy widens nothing an admin cannot already see.
--
--   `admin_parcel_detail`, `dispatch_health`, `admin_unassigned_parcels` and
--   the In Transit tab all return every booking to `is_admin()` already. This
--   gives the same people the same rows through a second door, and policies
--   are OR'd, so nobody else's reach changes by a single row.
--
-- The client ignores the payload and re-asks the RPCs, so these events are a
-- doorbell, not a data feed. Default replica identity is therefore enough.
-- ============================================================================

drop policy if exists "admin reads all bookings" on public.bookings;
create policy "admin reads all bookings"
  on public.bookings for select
  to authenticated
  using (public.is_admin());

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication missing; skipping (local Postgres?)';
    return;
  end if;

  foreach t in array array['bookings', 'dispatch_offers', 'driver_journeys'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
