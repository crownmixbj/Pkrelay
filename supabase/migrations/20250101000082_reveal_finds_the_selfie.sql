-- ============================================================================
-- 20250101000082_reveal_finds_the_selfie.sql — the reveal looks where the queue looks
-- ============================================================================
--
-- Run after 81. Re-runnable. Apply to BOTH staging and production.
--
-- ⚠ The review screen promises a selfie and the reveal cannot produce one.
--
--   43 added `sender_selfie_path(target)` — "where this person's face is" —
--   because a sender's selfie does not always live in `sender_identity`. It is
--   banked into `photo_capture_sessions` when they take it, and only copied to
--   `sender_identity.reference_path` later. So the helper tries the identity
--   row first and falls back to the newest completed capture session.
--
--   43 then wired that helper into `admin_identity_queue`, so `has_selfie` is
--   true for anybody who has taken one — and left the *reveal* reading
--   `coalesce(i.candidate_path, i.reference_path)`, which is only the first
--   half of the question.
--
--   The result, on production today: a sender with twelve capture sessions,
--   three of them completed with a photo, and both identity columns null. The
--   queue says there is a selfie. The reveal returns null. The panel renders
--   the slip, renders nothing where the face should be, and says nothing about
--   it — because a null url is indistinguishable from a photograph that has
--   not loaded yet. The reviewer is asked to tick "I have compared the selfie
--   against the NIN slip" with no selfie on screen.
--
-- ⚠ One definition of where a face is, used by everything that asks.
--
--   That is the whole fix. `sender_selfie_path` is already the answer; this
--   file makes the reveals call it instead of carrying their own half of it.
--   The parcel-keyed reveal keeps the booking's own photo first — that one is
--   about a specific parcel, and the photo taken for it is the right answer
--   when there is one — and falls back to the same helper when there is not.
--
-- ⚠ The function must return a row even when there is no identity row at all.
--
--   `from public.sender_identity i where i.user_id = target` returns zero rows
--   for an account that has taken a selfie and never submitted a NIN, which the
--   client reads as "nothing to show" rather than "a selfie and no NIN". The
--   selects below start from the target and left join, so there is always
--   exactly one row and every column is separately null or not.

do $$
begin
  if to_regprocedure('public.sender_selfie_path(uuid)') is null then
    raise exception 'Run 20250101000043_review_sees_the_selfie.sql first.';
  end if;

  if to_regprocedure('public.admin_reveal_identity_for_user(uuid,text)') is null then
    raise exception 'Run 20250101000081_nin_visibility.sql first.';
  end if;
end
$$;

-- ------------------------------------------- 1. the reveal, keyed on a user --

/**
 * Everything about one sender's identity check, for an administrator who has
 * said why they are looking.
 *
 * Replaces 81's version. Two changes: the selfie comes from
 * `sender_selfie_path`, and the row survives a missing `sender_identity`.
 * The full NIN and the audit line are 81's, unchanged.
 */
create or replace function public.admin_reveal_identity_for_user(
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
       * ⚠ The same helper the queue counts with.
       *
       *   It tries `candidate_path`, then `reference_path`, then the newest
       *   completed capture session. The candidate first because it is the
       *   photo the verdict is being reached about; the capture session last
       *   because it is where a selfie lives before anything has been decided —
       *   which is the state every account in this queue is in.
       */
      public.sender_selfie_path(target),
      i.slip_path,
      i.nin,
      right(i.nin, 4),
      i.status
    /*
      Starts from the target, so an account with a selfie and no identity row
      still comes back as one row with nulls rather than as no answer at all.
    */
    from (select target as user_id) t
    left join public.sender_identity i on i.user_id = t.user_id;
end;
$$;

revoke all on function public.admin_reveal_identity_for_user(uuid, text) from public, anon;
grant execute on function public.admin_reveal_identity_for_user(uuid, text) to authenticated;

-- --------------------------------------- 2. the reveal, keyed on a parcel --

/**
 * The same reveal, reached from a parcel rather than from a person.
 *
 * Replaces 81's version. The booking's own photo still wins — this reveal is
 * about one parcel, and the face photographed when it was posted is the right
 * answer when there is one. `sender_selfie_path` is the fallback, so a parcel
 * posted before the photo was required still shows who sent it.
 */
create or replace function public.admin_reveal_sender_identity(
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
      coalesce(b.sender_photo_path, public.sender_selfie_path(b.sender_id)),
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

-- ------------------------------------------------------------------ probe --

/**
 * Deployment panel probe (src/lib/schema-gap.ts).
 *
 * ⚠ Asserts that the queue and the reveal ask the same question.
 *
 *   The bug was not that either was wrong on its own. It was that
 *   `admin_identity_queue` counted selfies with the helper and the reveal
 *   fetched them without it, so the two disagreed — and the disagreement was
 *   invisible, because the panel renders a missing photograph as nothing.
 *   Both using `sender_selfie_path` is the invariant worth probing.
 */
create or replace function public.reveal_finds_the_selfie()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    pg_get_functiondef('public.admin_reveal_identity_for_user(uuid,text)'::regprocedure)
      like '%sender_selfie_path%'
    and pg_get_functiondef('public.admin_reveal_sender_identity(uuid,text)'::regprocedure)
      like '%sender_selfie_path%'
    and pg_get_functiondef('public.admin_identity_queue()'::regprocedure)
      like '%sender_selfie_path%';
$$;

comment on function public.reveal_finds_the_selfie() is
  'True when the queue and both reveals look for a selfie in the same place (82).';

revoke all on function public.reveal_finds_the_selfie() from public, anon;
grant execute on function public.reveal_finds_the_selfie() to authenticated;

-- ------------------------------------------- 3. and the manifest grows --

/**
 * Objects defined in more than one migration, and whether the live database
 * still has the newest definition.
 *
 * Replaces 81's version, with the two reveals now owned by 82. See 79 for why
 * a marker string rather than a body comparison.
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
    ('admin_reveal_identity_for_user'   , '082', 'fn',   'public', 'admin_reveal_identity_for_user'   , 'select target as user_id'),
    ('admin_reveal_sender_identity'     , '082', 'fn',   'public', 'admin_reveal_sender_identity'     , 'public.sender_selfie_path(b.sender_id)'),
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
    ('stale_definitions'                , '082', 'fn',   'public', 'stale_definitions'                , 'select target as user_id'),
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
  'Objects defined in more than one migration, and whether the live database still has the newest (79, extended in 80, 81 and 82).';

revoke all on function public.stale_definitions() from public, anon;
grant execute on function public.stale_definitions() to authenticated;
