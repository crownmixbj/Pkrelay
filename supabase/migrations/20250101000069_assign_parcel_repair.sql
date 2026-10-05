-- ============================================================================
-- 20250101000069_assign_parcel_repair.sql — hand assignment actually works
-- ============================================================================
--
-- Run after 01–68. Re-runnable.
--
-- ⚠ `admin_assign_parcel` has never worked against the real schema. Three
--   separate faults, in one nine-line UPDATE.
--
--   1. **It raises before it writes anything.**
--
--        update public.bookings set driver_id = driver ...
--
--      The function's second parameter is named `driver`, and `bookings` has a
--      column called `driver` — the denormalised carrier name. Inside an UPDATE
--      on that table the identifier belongs to both, and plpgsql's default
--      `variable_conflict = error` does exactly what it says:
--
--        column reference "driver" is ambiguous
--
--      So Manual dispatch mode has been unable to place a single parcel, and
--      the override an operator reaches for when the matcher finds nobody has
--      been dead on arrival since 25.
--
--   2. **It would break the row's own check constraint if it got that far.**
--
--      `driver_pair_consistent` (as 33 left it) is `driver_id is null or driver
--      is not null`: an id must come with a name, because a parcel with a
--      carrier nobody can render is a row every screen shows as blank. The
--      UPDATE set the id and left the name null.
--
--   3. **Nobody was told.** It set `status = 'Booked'` — the status the parcel
--      already had. 50's notifier is `after update of status` and keys the
--      driver's 'job_assigned' push and the sender's 'parcel_status_changed'
--      email on the transition to 'Assigned', so a hand assignment notified
--      neither side. The driver learned they had a job by opening the app.
--
-- ⚠ Why the harnesses were green: `documents-harness.mjs` builds its own
--   minimal `bookings` table with no `driver` column, so there was nothing to
--   be ambiguous with and no constraint to violate. It asserted that the
--   function places a parcel, and in that schema it does. The full-chain
--   harness added in 70 is the one that reproduces this.
--
-- ⚠ The signature is unchanged on purpose.
--
--   Renaming the parameter would be the tidier fix, and Postgres refuses it:
--   `create or replace function` cannot rename an input parameter, so it would
--   mean dropping and recreating the function — and the client calls it through
--   PostgREST by argument *name* (`{ parcel, driver }` in
--   `src/store/dispatch-mode.ts`), so the rename would have to land in the same
--   release as the app. Qualifying the parameter with the function name costs
--   one token and nothing else.
--
-- Nothing else about the function changes: the admin check, the four refusals,
-- the settling of a live offer, and the mode-dependent log level are all as 32
-- left them, repeated here verbatim rather than rewritten.

do $$
begin
  if to_regprocedure('public.admin_assign_parcel(uuid,uuid)') is null then
    raise exception 'Run 20250101000032_dispatch_mode.sql first.';
  end if;
end
$$;

create or replace function public.admin_assign_parcel(parcel uuid, driver uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  parcel_status text;
  parcel_driver uuid;
  driver_approved boolean;
  driver_name text;
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  select status, driver_id into parcel_status, parcel_driver
  from public.bookings where id = parcel;

  if parcel_status is null then
    raise exception 'No such parcel';
  end if;

  if parcel_driver is not null then
    raise exception 'That parcel already has a driver';
  end if;

  if parcel_status <> 'Booked' then
    raise exception 'That parcel is % and cannot be assigned', parcel_status;
  end if;

  select exists (
    select 1 from public.driver_applications
    where user_id = admin_assign_parcel.driver and status = 'approved'
  ) into driver_approved;

  if not driver_approved then
    raise exception 'That driver is not approved';
  end if;

  if not public.documents_permit_dispatch(admin_assign_parcel.driver) then
    raise exception
      'That driver has an expired document and cannot carry parcels until it is renewed';
  end if;

  /*
   * The carrier's name, resolved here rather than left to the client.
   *
   * ⚠ `coalesce(..., 'Driver')` matches `respond_to_offer` in 15 exactly. A
   *   profile with an empty name is not a reason to refuse an assignment, and
   *   the constraint will not take null — so both paths put the same placeholder
   *   in the same column rather than one of them inventing its own.
   */
  select coalesce(nullif(btrim(p.full_name), ''), 'Driver')
    into driver_name
  from public.profiles p
  where p.id = admin_assign_parcel.driver;

  update public.bookings
     set driver_id = admin_assign_parcel.driver,
         driver = coalesce(driver_name, 'Driver'),
         /*
          * 'Assigned', not 'Booked'.
          *
          * ⚠ This is what makes anybody hear about it. 50's notifier fires on
          *   `update of status` and keys both messages on the move to
          *   'Assigned' — the driver's push ("Head to the pickup") and the
          *   sender's ("<name> is handling your parcel"). Writing the status it
          *   already had meant the trigger fired on a no-op transition and sent
          *   nothing.
          *
          * It is also what the sender's tracking screen reads. A parcel with a
          * driver that still says Booked reads, to the person who sent it, as
          * nobody having picked it up yet.
          */
         status = 'Assigned'
   where id = parcel;

  /*
   * ⚠ `accepted_at` is deliberately left null.
   *
   *   Nobody accepted this. The column means "a driver took this job", and a
   *   hand assignment is the opposite — the record of a decision made for them.
   *   `admin_parcel_detail` renders it as a dash, which is accurate.
   */

  /*
    Any live offer on this parcel is settled, not left hanging.

    Otherwise a driver who was mid-countdown taps Accept on a parcel that now
    belongs to somebody else, and `respond_to_offer` refuses them with a message
    about a parcel they were legitimately offered thirty seconds earlier.
  */
  update public.dispatch_offers
     set status = 'expired', responded_at = now()
   where booking_id = parcel and status = 'offered';

  /*
    The level depends on the mode, and that is the honest reading.

    In manual mode a hand assignment is the *expected* thing — every parcel is
    placed this way, and logging each one as a warning would bury the ones that
    matter under the ones that do not. In auto mode it is an override: a run of
    them means the matcher is failing to place parcels, which is a dispatch bug
    somebody should see rather than an admin habit.
  */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    case when public.dispatch_mode() = 'manual' then 'info' else 'warning' end,
    'dispatch', 'admin assigned a parcel by hand',
    jsonb_build_object(
      'booking', parcel,
      'driver', admin_assign_parcel.driver,
      'mode', public.dispatch_mode()
    ),
    actor
  );
end;
$$;

revoke all on function public.admin_assign_parcel(uuid, uuid) from public, anon;
grant execute on function public.admin_assign_parcel(uuid, uuid) to authenticated;
