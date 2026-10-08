-- ============================================================================
-- 20250101000081_nin_visibility.sql — the reviewer sees the number they are checking
-- ============================================================================
--
-- Run after 80. Re-runnable. Apply to BOTH staging and production.
--
-- ⚠ The review screens hand over the photograph of a national ID card and
--   withhold the number typed off it.
--
--   `admin_reveal_sender_identity` (37) and `admin_reveal_identity_for_user`
--   (41, 43) return `slip_path` — the scan of the slip, with the NIN printed on
--   it in full — and `right(i.nin, 4)`. `admin_guarantor_summary` (51) returns
--   `government_id_path` and `right(v.nin, 4)`. So a reviewer is shown the
--   document and then asked to check it against four digits.
--
--   That is not a privacy control. The number is legible in the image the same
--   screen just opened; masking the typed copy only stops the reviewer doing
--   the one thing the review is for, which is noticing that the two disagree.
--   A transposed digit — the single most common way a real NIN is entered
--   wrongly — is invisible unless it falls in the last four.
--
-- ⚠ What this file does NOT do: put NINs on a list.
--
--   The queue stays masked. The full number comes back only from a reveal —
--   the same call that opens the slip and the selfie, which writes a
--   'privacy' line into `app_events` naming the administrator and their
--   reason, in the same transaction as the read. 37's rule stands: working a
--   list and looking at a person are different acts, and only the second is
--   logged. This changes what the second act returns, not what the first does.
--
-- ⚠ And the inconsistency it closes.
--
--   Driver applications have been showing the applicant's full NIN in the
--   review list since 02 — no click, no audit line, straight off the table
--   through `select('*')`. Sender identities have been masked to four digits
--   even behind the reveal. The same number, in the same console, under two
--   opposite rules. After this file both go through the reveal, and the
--   console no longer pulls the column at all.
--
-- The four surfaces, after this file:
--
--   sender ID review list         •••• •••• 4747
--   sender reveal                 full, audited
--   driver application list       •••• •••• 4747   (was: full, unaudited)
--   driver application reveal     full, audited    (applicant and guarantor)
--   a person's own profile        •••• •••• 4747   (unchanged)
--   a person's own edit form      full             (unchanged — it is theirs)

-- ⚠ 79 carries an older copy of `admin_reveal_identity_for_user` — 43's, which
--   masks the number. It is a repair file, so its body is 43's by design. That
--   makes 79 a replay hazard for this file specifically: running 79 again after
--   this one puts the mask back. `stale_definitions` reports it (the manifest
--   below names 81 as the owner), and the fix is to run this file again.

do $$
begin
  if to_regprocedure('public.admin_reveal_identity_for_user(uuid,text)') is null then
    raise exception 'Run 20250101000041_sender_identity_review.sql first.';
  end if;

  if to_regprocedure('public.admin_reveal_sender_identity(uuid,text)') is null then
    raise exception 'Run 20250101000037_admin_sender_identity.sql first.';
  end if;

  if to_regclass('public.guarantor_verifications') is null then
    raise exception 'Run 20250101000039_guarantor_verification.sql first.';
  end if;
end
$$;

-- ------------------------------------------- 1. the sender reveal, by user --

/**
 * Everything about one sender's identity check, for an administrator who has
 * said why they are looking.
 *
 * Replaces 43's version. One new column: `nin`, in full. `nin_last4` stays so
 * that a caller which only wants to confirm the tail does not have to carry the
 * whole number around to do it.
 *
 * Everything else is 43's, including the reason it returns the candidate photo
 * first and the audit line it writes before reading.
 */
drop function if exists public.admin_reveal_identity_for_user(uuid, text);

create function public.admin_reveal_identity_for_user(
  target uuid,
  reason text default null
)
returns table (
  selfie_path text,
  slip_path text,
  /** In full. The reviewer is looking at the slip it was copied from. */
  nin text,
  nin_last4 text,
  identity_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'privacy',
    'admin revealed sender identity',
    jsonb_build_object(
      'subject', target,
      'reason', left(coalesce(reason, ''), 200)
    ),
    actor
  );

  return query
    select
      /*
       * The candidate first: it is the photo the verdict was reached about.
       * Falling back to the reference means an already-verified account still
       * shows a face, which is the point of being able to look one up.
       */
      coalesce(i.candidate_path, i.reference_path),
      i.slip_path,
      i.nin,
      right(i.nin, 4),
      i.status
    from public.sender_identity i
    where i.user_id = target;
end;
$$;

revoke all on function public.admin_reveal_identity_for_user(uuid, text) from public, anon;
grant execute on function public.admin_reveal_identity_for_user(uuid, text) to authenticated;

-- ---------------------------------------- 2. the sender reveal, by parcel --

/**
 * The same reveal, reached from a parcel rather than from a person.
 *
 * Replaces 37's version, with the same one new column. The two are deliberately
 * the same door with different keys — one audit line each, into the same table,
 * at the same level.
 */
drop function if exists public.admin_reveal_sender_identity(uuid, text);

create function public.admin_reveal_sender_identity(
  booking_id uuid,
  reason text default null
)
returns table (
  selfie_path text,
  slip_path text,
  nin text,
  nin_last4 text,
  identity_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  /*
    Logged in the same transaction as the read, which is the property that
    matters: if this insert fails, nothing is returned.
  */
  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'privacy',
    'admin revealed sender identity',
    jsonb_build_object(
      'booking', booking_id,
      'reason', left(coalesce(reason, ''), 200)
    ),
    actor
  );

  return query
    select
      b.sender_photo_path,
      i.slip_path,
      i.nin,
      right(i.nin, 4),
      i.status
    from public.bookings b
    left join public.sender_identity i on i.user_id = b.sender_id
    where b.id = booking_id;
end;
$$;

revoke all on function public.admin_reveal_sender_identity(uuid, text) from public, anon;
grant execute on function public.admin_reveal_sender_identity(uuid, text) to authenticated;

-- ------------------------------------- 3. the driver application, masked --

/**
 * What the review console reads instead of the table.
 *
 * ⚠ `select('*')` was the problem, not the rendering.
 *
 *   The console fetched every column of every application, so the applicant's
 *   NIN and their guarantor's arrived in the browser whether or not anything
 *   drew them. Masking in the component would have left both numbers in the
 *   network response of a screen an operator leaves open all day.
 *
 * ⚠ `security_invoker = on`, so the view is not a way around RLS.
 *
 *   Without it a view runs with its owner's rights and would hand every
 *   application to anybody who selected from it. With it, the policies on
 *   `driver_applications` decide exactly as they do today; this changes which
 *   columns come back, and nothing about who may ask.
 *
 * `guarantor_nin` is dropped rather than shortened: 39 stopped collecting it,
 * 52 made it nullable, and the review screen has read the guarantor's own
 * submission since — so on every application submitted in the last year the
 * column is empty and nothing renders it.
 */
create or replace view public.driver_applications_admin
with (security_invoker = on) as
  select
    a.id,
    a.user_id,
    a.reference,
    a.full_name,
    a.phone,
    a.email,
    /** Four digits for the list. The rest comes from the reveal below. */
    right(a.nin, 4) as nin_last4,
    a.address,
    a.state,
    a.base_city,
    a.vehicle_type,
    a.vehicle_colour,
    a.plate_number,
    a.license_id,
    a.guarantor_name,
    a.guarantor_phone,
    a.guarantor_email,
    a.guarantor_relationship,
    a.guarantor_address,
    a.bank_name,
    a.account_number,
    a.account_name,
    a.kin_name,
    a.kin_phone,
    a.kin_relationship,
    a.documents,
    a.status,
    a.review_note,
    a.reviewed_by,
    a.reviewed_at,
    a.submitted_at,
    a.confirmation_email_sent_at,
    a.confirmation_email_error,
    a.identity_status,
    a.identity_confidence,
    a.identity_environment,
    a.identity_checked_at
  from public.driver_applications a;

comment on view public.driver_applications_admin is
  'driver_applications with the two NINs reduced to four digits. The console reads this (81).';

revoke all on public.driver_applications_admin from public, anon;
grant select on public.driver_applications_admin to authenticated;

-- ------------------------------ 4. the driver application reveal, audited --

/**
 * The applicant's NIN and their guarantor's, in full, for one application.
 *
 * ⚠ One call for both numbers, because reviewing an application is one act of
 *   looking.
 *
 *   The reviewer checks the applicant's slip and the guarantor's government ID
 *   in the same sitting — `admin_guarantor_summary` already hands over
 *   `government_id_path` — and two reveals would mean two log lines for one
 *   decision and a reason box that becomes a formality. 41 made the same call
 *   about the selfie and the slip.
 *
 * Nulls where there is nothing: an application whose guarantor has not
 * submitted yet returns the applicant's number and null for the other.
 */
create or replace function public.admin_reveal_application_nin(
  application uuid,
  reason text default null
)
returns table (
  applicant_nin text,
  guarantor_nin text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can read this';
  end if;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'privacy',
    'admin revealed application identity numbers',
    jsonb_build_object(
      'application', application,
      'reason', left(coalesce(reason, ''), 200)
    ),
    actor
  );

  return query
    select
      a.nin,
      (
        select v.nin
        from public.guarantor_verifications v
        where v.application_id = a.id
        order by v.created_at desc nulls last
        limit 1
      )
    from public.driver_applications a
    where a.id = admin_reveal_application_nin.application;
end;
$$;

revoke all on function public.admin_reveal_application_nin(uuid, text) from public, anon;
grant execute on function public.admin_reveal_application_nin(uuid, text) to authenticated;

-- ------------------------------------------------------------------ probe --

/**
 * Deployment panel probe (src/lib/schema-gap.ts).
 *
 * ⚠ Asserts the masked view as well as the reveals.
 *
 *   The reveals returning the number is half of it. The other half is the
 *   console no longer pulling the column — and that half is invisible on
 *   screen, because an application list looks identical whether the NIN was
 *   left out of the response or merely left undrawn.
 */
create or replace function public.nin_reveal_installed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    to_regclass('public.driver_applications_admin') is not null
    and to_regprocedure('public.admin_reveal_application_nin(uuid,text)') is not null
    and pg_get_functiondef('public.admin_reveal_identity_for_user(uuid,text)'::regprocedure)
        like '%nin text,%'
    and pg_get_functiondef('public.admin_reveal_sender_identity(uuid,text)'::regprocedure)
        like '%nin text,%'
    /* And the view really has dropped it, rather than renaming it. */
    and not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'driver_applications_admin'
        and column_name in ('nin', 'guarantor_nin')
    );
$$;

comment on function public.nin_reveal_installed() is
  'True when an admin gets the full NIN from an audited reveal and nowhere else (81).';

revoke all on function public.nin_reveal_installed() from public, anon;
grant execute on function public.nin_reveal_installed() to authenticated;

-- ------------------------------------------- 5. and the manifest grows --

/**
 * Objects defined in more than one migration, and whether the live database
 * still has the newest definition.
 *
 * Replaces 80's version. The manifest gains the two reveals this file
 * redefines, so a replay of 37, 41 or 43 over it is reported rather than
 * quietly masking the number again.
 *
 * See 79 for why a marker string rather than a body comparison, and why
 * functions are matched by name across every overload.
 */
create or replace function public.stale_definitions()
returns table (object text, owner_migration text, state text)
language sql
stable
security definer
set search_path = ''
as $$
  with manifest(object, owner_migration, kind, obj_schema, obj_name, marker) as (values
    ('admin_assign_parcel'              , '069', 'fn',   'public', 'admin_assign_parcel'              , 'admin_assign_parcel.driver'),
    ('admin_guarantor_summary'          , '051', 'fn',   'public', 'admin_guarantor_summary'          , 'public.guarantor_invitations'),
    ('admin_identity_queue'             , '043', 'fn',   'public', 'admin_identity_queue'             , 'public.sender_selfie_path'),
    ('admin_overview'                   , '072', 'fn',   'public', 'admin_overview'                   , 'parcels_on_the_way'),
    ('admin_parcel_detail'              , '036', 'fn',   'public', 'admin_parcel_detail'              , 'b.item_photo_path'),
    ('admin_parcels'                    , '072', 'fn',   'public', 'admin_parcels'                    , 'on_the_way'),
    ('admin_parcels_for_driver'         , '071', 'fn',   'public', 'admin_parcels_for_driver'         , 'public.offer_attempts'),
    ('admin_payment_totals'             , '060', 'fn',   'public', 'admin_payment_totals'             , 'p.initialized_at'),
    ('admin_payments_ledger'            , '060', 'fn',   'public', 'admin_payments_ledger'            , 'public.commission_rate'),
    ('admin_reveal_identity_for_user'   , '081', 'fn',   'public', 'admin_reveal_identity_for_user'   , 'nin text,'),
    ('admin_reveal_sender_identity'     , '081', 'fn',   'public', 'admin_reveal_sender_identity'     , 'nin text,'),
    ('admin_review_identity'            , '043', 'fn',   'public', 'admin_review_identity'            , 'public.sender_selfie_path'),
    ('admin_waiting_drivers'            , '075', 'fn',   'public', 'admin_waiting_drivers'            , 'coalesce(j.departure_time, j.departs_before) asc'),
    ('assignable_drivers'               , '080', 'fn',   'public', 'assignable_drivers'               , 'public.parcel_releases'),
    ('begin_identity_check'             , '041', 'fn',   'public', 'begin_identity_check'             , 'review_note'),
    ('bookings_guard_immutable'         , '080', 'fn',   'public', 'bookings_guard_immutable'         , 'handed to another driver'),
    ('cancel_booking'                   , '080', 'fn',   'public', 'cancel_booking'                   , 'public.parcel_releases'),
    ('complete_guarantor_verification'  , '051', 'fn',   'public', 'complete_guarantor_verification'  , 'public.guarantor_documents'),
    ('consume_capture_session'          , '014', 'fn',   'public', 'consume_capture_session'          , 'liveness_environment'),
    ('default_application_status'       , '040', 'fn',   'public', 'default_application_status'       , 'new.review_note'),
    ('dispatch_booking'                 , '080', 'fn',   'public', 'dispatch_booking'                 , 'public.parcel_releases'),
    ('dispatch_email'                   , '053', 'fn',   'public', 'dispatch_email'                   , 'public.email_dispatch_config'),
    ('dispatch_new_booking'             , '056', 'fn',   'public', 'dispatch_new_booking'             , 'new.payment_status'),
    ('email_on_booking_status'          , '064', 'fn',   'public', 'email_on_booking_status'          , 'driver_first_name'),
    ('erase_person'                     , '033', 'fn',   'public', 'erase_person'                     , 'public.payout_change_requests'),
    ('expire_dispatch_offers'           , '021', 'fn',   'public', 'expire_dispatch_offers'           , 'coalesce'),
    ('guarantor_invitation_window'      , '054', 'fn',   'public', 'guarantor_invitation_window'      , 'interval ''30 days'''),
    ('guard_application_phone'          , '033', 'fn',   'public', 'guard_application_phone'          , 'current_setting'),
    ('guard_identity_columns'           , '034', 'fn',   'public', 'guard_identity_columns'           , 'loci.attaching_identity'),
    ('handle_new_user'                  , '045', 'fn',   'public', 'handle_new_user'                  , 'nullif(new.raw_user_meta_data'),
    ('invite_guarantor_on_submit'       , '051', 'fn',   'public', 'invite_guarantor_on_submit'       , 'public.queue_notification'),
    ('is_approved_driver'               , '009', 'fn',   'public', 'is_approved_driver'               , 'p.driving_banned_at'),
    ('journey_matches'                  , '026', 'fn',   'public', 'journey_matches'                  , 'journey_departure'),
    ('my_guarantor_status'              , '051', 'fn',   'public', 'my_guarantor_status'              , 'public.email_outbox'),
    ('notify_dispatch_offer'            , '024', 'fn',   'public', 'notify_dispatch_offer'            , 'private.pg_net_post_fn'),
    ('notify_new_driver_application'    , '067', 'fn',   'public', 'notify_new_driver_application'    , 'private.pg_net_post_fn'),
    ('open_guarantor_invitation'        , '051', 'fn',   'public', 'open_guarantor_invitation'        , 'invite.guarantor_email'),
    ('pg_net_calls_are_resolvable'      , '068', 'fn',   'public', 'pg_net_calls_are_resolvable'      , 'p.proname <> ''pg_net_calls_are_resolvable'''),
    ('queue_notification'               , '076', 'fn',   'public', 'queue_notification'               , 'foreign_key_violation'),
    ('record_identity_result'           , '041', 'fn',   'public', 'record_identity_result'           , 'candidate_path'),
    ('stale_definitions'                , '081', 'fn',   'public', 'stale_definitions'                , 'nin text,'),
    ('sweep_for_journey'                , '026', 'fn',   'public', 'sweep_for_journey'                , 'new.departure_time'),
    ('unassigned_parcels'               , '071', 'fn',   'public', 'unassigned_parcels'               , 'public.offer_attempts'),
    /*
      ⚠ The manifest lists itself, two rows above, and that is not a joke.

        A replay that put an older `stale_definitions` back would leave a probe
        reporting on a manifest several objects short — green, and wrong, about
        the exact failure it exists to catch. Its marker is a name that only the
        newest row set contains, so it has to be updated every time this list
        grows. That is the cost of a self-describing manifest and it is cheaper
        than the alternative.
    */
    /*
      kind 'gone': the object must NOT exist. 23 dropped this index and 20 kept
      bringing it back with `create unique index if not exists`, so a replay of
      the early range resurrects it — which is how a driver came to be unable to
      decline the same parcel twice. 78 is the migration that found it; this row
      is what would have said so first.
    */
    ('dispatch_offers_no_repeat_decline', '078', 'gone', 'public', 'dispatch_offers_no_repeat_decline', ''),
    /*
      kind 'pol': the policy's expression must contain the marker. These two
      rows put the *table* in `obj_schema` — every policy here is on
      `public.bookings`, and giving the column a second meaning for three rows
      was cheaper than a sixth column that is null for the other forty.
    */
    ('bookings: sender creates own',             '056', 'pol', 'bookings', 'sender creates own',             'payment_status'),
    ('bookings: read own, carried, or unclaimed','056', 'pol', 'bookings', 'read own, carried, or unclaimed','payment_status')
  )
  select
    m.object::text,
    m.owner_migration::text,
    (case m.kind

      when 'gone' then
        case when to_regclass(m.obj_schema || '.' || m.obj_name) is null
             then 'current' else 'STALE' end

      when 'pol' then
        coalesce(
          (
            select case
              when coalesce(pg_get_expr(p.polqual, p.polrelid), '') ||
                   coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
                   like '%' || m.marker || '%'
              then 'current' else 'STALE' end
            from pg_policy p
            where p.polrelid = ('public.' || m.obj_schema)::regclass
              and p.polname = m.obj_name
          ),
          'MISSING'
        )

      /*
        ⚠ Looked up by name, not by signature, and `bool_or` across every
          overload.

          A signature would have to be written down here and would go wrong the
          first time a migration changed one — the probe would report MISSING on
          a function that is present and current, which is a worse lie than the
          one it exists to catch. `journey_matches` is the live example: 15
          declared it with eight arguments and 26 with ten, and both are in the
          database. A marker is absent from every older definition by
          construction, so "some overload contains it" is exactly "the newest
          definition is still there".
      */
      else
        coalesce(
          (
            select case
              when bool_or(pg_get_functiondef(p.oid) like '%' || m.marker || '%')
                then 'current'
              else 'STALE'
            end
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = m.obj_schema and p.proname = m.obj_name
          ),
          'MISSING'
        )
    end)::text
  from manifest m
  order by 3 desc, 1;
$$;

comment on function public.stale_definitions() is
  'Objects defined in more than one migration, and whether the live database still has the newest (79, extended in 80 and 81).';

revoke all on function public.stale_definitions() from public, anon;
grant execute on function public.stale_definitions() to authenticated;
