-- ============================================================================
-- 20250101000064_status_email_driver_name.sql — the driver's first name in status emails
-- ============================================================================
--
-- Adds `driver_first_name` to the payload of every `parcel_status_changed`
-- email, so the email a sender gets when a driver accepts their parcel
-- ('Assigned') can say who accepted it.
--
-- ⚠ Data only. The template does not use the new field yet, so emails look
--   exactly as they do today until notify-events is updated to read it.
--
-- ⚠ Replaces 38's `email_on_booking_status` with one change: the payload line
--   marked "new in 64". Everything else is copied verbatim, including the
--   delivered and cancelled branches — `create or replace` swaps the whole
--   function, so anything left out here would be lost.
--
-- ⚠ Only the first name, never the full name or phone. An email is forwarded
--   and stored by mail providers; the driver's full details stay behind the
--   sender's sign-in in the app.

create or replace function public.email_on_booking_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sender_email text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  /*
   * ⚠ `sender_id`, not `user_id`.
   *
   *   Written as `user_id` first, from memory. plpgsql resolves record fields
   *   at run time rather than at CREATE, so that would have thrown on the first
   *   real delivery instead of when the migration was applied. Checked against
   *   the table rather than trusted. (`sender_identity.user_id` above is
   *   correct — the two tables genuinely differ.)
   */
  sender_email := public.email_for_user(new.sender_id);

  if new.status = 'Delivered' then
    perform public.queue_email(
      'delivery_completed',
      new.id::text,
      sender_email,
      jsonb_build_object(
        'tracking_id', new.tracking_id,
        'delivered_at', now(),
        'recipient_name', new.recipient_name,
        'driver_name', new.driver,
        /*
         * The fare, so the email doubles as the summary the brief asked for as
         * a "receipt". It is what was owed, and it is labelled that way.
         */
        'fare', new.estimated_fee,
        'has_proof', new.proof_path is not null
      )
    );

  elsif new.status = 'Cancelled' then
    perform public.queue_email(
      'parcel_cancelled',
      new.id::text,
      sender_email,
      jsonb_build_object(
        'tracking_id', new.tracking_id,
        'cancelled_at', now(),
        'reason', new.cancellation_reason,
        'cancelled_by', new.cancelled_role
      )
    );

    /*
     * ⚠ And the driver, if one was carrying it.
     *
     *   A driver who has accepted a job and set off needs to know it is off
     *   before they arrive. This is the "delivery cancelled" half of the
     *   brief's driver lifecycle, and it fires from the same transition rather
     *   than from a second trigger that could disagree about when a
     *   cancellation happened.
     */
    if new.driver_id is not null then
      perform public.queue_email(
        'driver_job_cancelled',
        new.id::text,
        public.email_for_user(new.driver_id),
        jsonb_build_object(
          'tracking_id', new.tracking_id,
          'cancelled_at', now(),
          'route', coalesce(new.origin_city, '') || ' to ' || coalesce(new.destination_city, '')
        )
      );
    end if;

  else
    perform public.queue_email(
      'parcel_status_changed',
      new.id::text || ':' || new.status,
      sender_email,
      jsonb_build_object(
        'tracking_id', new.tracking_id,
        'status', new.status,
        'changed_at', now(),
        /*
         * ⚠ First name only — new in 64.
         *
         *   `bookings.driver` holds the name the driver signed up with, set by
         *   the same update that moves the parcel to 'Assigned'. A first name
         *   is enough for "Tunde has accepted your parcel" and is all an email
         *   that can be forwarded should carry. Null until a driver is on it.
         */
        'driver_first_name', nullif(split_part(btrim(coalesce(new.driver, '')), ' ', 1), '')
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists on_booking_status_email on public.bookings;
create trigger on_booking_status_email
  after update of status on public.bookings
  for each row execute function public.email_on_booking_status();

/*
 * Deployment panel probe (src/lib/schema-gap.ts). Reads the live function
 * body, so it turns false if 38 is ever re-run over this.
 */
create or replace function public.status_email_has_driver_name()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.prosrc like '%driver_first_name%'
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'email_on_booking_status'),
    false
  );
$$;

comment on function public.status_email_has_driver_name() is
  'True when parcel status emails carry the driver''s first name. Read by the deployment panel.';

revoke all on function public.status_email_has_driver_name() from public, anon;
grant execute on function public.status_email_has_driver_name() to authenticated;
