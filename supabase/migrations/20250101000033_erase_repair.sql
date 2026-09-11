/*
  20250101000033_erase_repair.sql — make erasure work, and make it complete.

  Two problems, and the second is much larger than the first.

  ⚠ 1. IT DID NOT RUN AT ALL.

    `erase_person` scrubs `driver_applications.phone` to 'Erased'. Since
    20250101000016_driver_identity.sql, a BEFORE INSERT OR UPDATE trigger on that table
    refuses any phone that is not the account's sign-up number:

        Use the phone number you signed up with.

    So every erasure raised, and the admin screen reported "The database refused
    the change." The guard is right and the erasure is right; nobody had put
    them in the same room.

  ⚠ 2. IT WAS SCRUBBING A 2024 SCHEMA.

    `20250101000009_bans.sql` was written when the only personal data lived in `profiles`,
    `bookings` and `driver_applications`. Eight tables have been added since,
    and erasure knew about none of them. An "erased" account still had:

      sender_identity          NIN, and the path to a stored face photograph
      photo_capture_sessions   the selfies taken when posting a parcel
      payout_change_requests   bank name, account number, and the previous ones
      payout_requests          bank details snapshotted onto every payout
      driver_edit_history      old and new values of name, NIN and licence
      driver_documents         paths to the licence and ID scans
      push_tokens              a device this person can still be reached on

    For an NDPA erasure request that is not a partial success. It is a failure
    that reports success — the worst shape available, because the operator
    believes the obligation is discharged and it is not.

  ⚠ WHAT IS STILL DELIBERATELY KEPT

    · Delivered parcels keep their route, fare and proof photo. Those belong to
      the person at the *other* end of the delivery, who did not ask to be
      erased and still needs their receipt.
    · `driver_earnings` keeps its amounts. It is the ledger a payout was made
      against, and deleting the row would make LOCI's own books disagree with
      its bank statement. The bank details attached to it go; the numbers stay.
    · The auth login. See the note at the foot of this file — that genuinely
      needs a service-role call, and pretending otherwise in SQL would be worse
      than saying so.

  Requires: 20250101000009_bans.sql, 20250101000016_driver_identity.sql, and everything up to 32.
*/

do $$
begin
  if to_regprocedure('public.erase_person(uuid, text)') is null then
    raise exception 'Run 20250101000009_bans.sql first.';
  end if;
  if to_regprocedure('public.guard_application_phone()') is null then
    raise exception 'Run 20250101000016_driver_identity.sql first.';
  end if;
end
$$;

-- ------------------------------------------------- letting erasure through --

/**
 * The phone lock, with one exemption.
 *
 * ⚠ A transaction-local setting, not a string check and not an admin bypass.
 *
 *   Three ways to do this and two of them are wrong:
 *
 *   · `if new.phone = 'Erased' then return new` — sniffing a magic string. Any
 *     applicant could type "Erased" into the field and walk past the lock.
 *
 *   · `if public.is_admin() then return new` — far too wide. Erasure is the
 *     only legitimate reason to break the tie between an application and the
 *     account that made it; an admin editing an application for any other
 *     reason should still be refused, loudly.
 *
 *   · a GUC set with `is_local = true`, which is what this uses. It exists for
 *     the duration of one transaction, is set in exactly one place —
 *     `erase_person` below — and cannot be reached from a client: PostgREST
 *     exposes functions from the API schema, and `set_config` lives in
 *     `pg_catalog`.
 *
 * Everything else about the guard is unchanged, including the normalisation on
 * the way through.
 */
create or replace function public.guard_application_phone()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  account_phone text;
  claimed text;
begin
  -- The erasure exemption. See the note above on why it is a transaction-local
  -- setting rather than a value check or a role check.
  if coalesce(current_setting('loci.erasing', true), '') = 'on' then
    return new;
  end if;

  select public.normalize_ng_phone(
           coalesce(nullif(u.phone, ''), u.raw_user_meta_data ->> 'phone')
         )
    into account_phone
  from auth.users u
  where u.id = new.user_id;

  claimed := public.normalize_ng_phone(new.phone);

  /*
    No number on the account: let it through. Accounts created before sign-up
    captured a phone have nothing to compare against.
  */
  if account_phone is null then
    return new;
  end if;

  if claimed is distinct from account_phone then
    raise exception
      'Use the phone number you signed up with. Applications must match the account they are made from.'
      using errcode = 'check_violation';
  end if;

  new.phone := account_phone;
  return new;
end;
$$;

-- ------------------------------------------------------ erasure, completed --

/**
 * Erase a person.
 *
 * Same audited, admin-only, `security definer` shape as before. What changed is
 * the surface: every table holding something identifying, and the storage
 * objects behind them.
 *
 * ⚠ Ordering matters in exactly one place, marked below.
 */
create or replace function public.erase_person(target_id uuid, note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Not signed in';
  end if;

  if not public.is_admin() then
    raise exception 'Only an administrator can erase an account';
  end if;

  if target_id = actor then
    raise exception 'You cannot erase your own account from here.';
  end if;

  if not exists (select 1 from public.profiles where id = target_id) then
    raise exception 'No such user';
  end if;

  if (select is_admin from public.profiles where id = target_id) then
    -- An admin's row is referenced by the audit trail as an actor. Demote
    -- first, so the decision to remove their powers is its own logged act.
    raise exception 'Remove this person''s admin role first.';
  end if;

  /*
    ⚠ Set BEFORE the driver_applications update, cleared by the transaction.

      This is the flag `guard_application_phone` looks for. `true` makes it
      local: it disappears when this statement's transaction ends, whether that
      is a commit or a rollback, so a failed erasure cannot leave the phone lock
      disarmed for anybody.
  */
  perform set_config('loci.erasing', 'on', true);

  -- ---------------------------------------------------------- deliveries --

  /*
    The carrier name on any parcel they delivered.

    A non-null placeholder rather than null: `driver_pair_consistent` requires
    `driver` and `driver_id` to move together, so nulling one alone raises.
  */
  update public.bookings
     set driver = 'Former driver'
   where driver_id = target_id;

  -- Their own sent parcels keep the route and the fare, lose the people.
  update public.bookings
     set pickup_contact_name = 'Removed',
         sender_phone = 'Removed',
         recipient_name = 'Removed',
         recipient_phone = 'Removed',
         pickup_address = 'Removed',
         dropoff_address = 'Removed',
         notes = ''
   where sender_id = target_id;

  -- ------------------------------------------------------- the application --

  update public.driver_applications
     set full_name = 'Erased',
         phone = 'Erased',
         email = 'Erased',
         nin = 'Erased',
         address = 'Erased',
         guarantor_name = 'Erased',
         guarantor_phone = 'Erased',
         guarantor_relationship = 'Erased',
         guarantor_address = 'Erased',
         guarantor_nin = 'Erased',
         bank_name = 'Erased',
         account_number = 'Erased',
         account_name = 'Erased',
         kin_name = 'Erased',
         kin_phone = 'Erased',
         kin_relationship = 'Erased',
         plate_number = 'Erased',
         license_id = 'Erased',
         documents = '{}'::jsonb
   where user_id = target_id;

  -- --------------------------------------------- everything added since 09 --

  /*
    Identity. The most sensitive row LOCI holds — a national identifier and the
    path to a stored photograph of a face — so it is deleted rather than
    overwritten. There is nothing here worth keeping a shell of.
  */
  delete from public.sender_identity where user_id = target_id;
  delete from public.photo_capture_sessions where owner_id = target_id;

  /*
    Documents. The rows go, and so do the files: `driver-documents` and
    `sender-identity` hold licence scans, NIN slips and reference photographs.
  */
  if to_regclass('public.driver_documents') is not null then
    delete from public.driver_documents where driver_id = target_id;
  end if;

  delete from storage.objects
   where bucket_id in ('driver-documents', 'sender-identity', 'sender-photo')
     and (storage.foldername(name))[1] = target_id::text;

  /*
    Bank details, wherever they were copied to.

    `payout_change_requests` keeps both the new and the previous account, and
    `payout_requests` snapshots the account onto every payout so a later change
    cannot rewrite where last month's money went. That snapshotting is right,
    and it means erasure has to reach both.

    ⚠ The payout rows are scrubbed, not deleted, and `driver_earnings` is left
      alone entirely. Those are the books a transfer was made against; deleting
      them would leave LOCI unable to reconcile its own bank statement, and an
      erasure request is not a request to destroy the other party's accounts.
  */
  if to_regclass('public.payout_change_requests') is not null then
    delete from public.payout_change_requests where driver_id = target_id;
  end if;

  if to_regclass('public.payout_requests') is not null then
    update public.payout_requests
       set bank_name = 'Erased',
           account_number = 'Erased',
           account_name = 'Erased'
     where driver_id = target_id;
  end if;

  /*
    The edit trail. `old_value` and `new_value` hold the very fields the rest of
    this function is scrubbing — a previous legal name, a previous NIN — so an
    audit row left intact would preserve exactly what was erased.

    The rows stay, with the values gone: that an account changed its NIN twice
    before being erased is a fact worth keeping; what it changed it to is not.
  */
  if to_regclass('public.driver_edit_history') is not null then
    update public.driver_edit_history
       set old_value = null, new_value = null
     where driver_id = target_id;
  end if;

  -- A device this person can still be reached on.
  if to_regclass('public.push_tokens') is not null then
    delete from public.push_tokens where user_id = target_id;
  end if;

  -- ------------------------------------------------------------ the profile --

  update public.profiles
     set full_name = 'Removed account',
         phone = '',
         deleted_at = now(),
         driving_banned_at = now(),
         driving_ban_reason = 'Account erased'
   where id = target_id;

  insert into public.app_events (level, area, message, context, actor_id)
  values (
    'warning',
    'moderation',
    'account erased',
    /*
      The subject id, and nothing about them. An audit row naming the person
      erased would keep exactly the data the erasure was meant to remove.
    */
    jsonb_build_object('subject', target_id, 'reason', note),
    actor
  );
end;
$$;

revoke all on function public.erase_person(uuid, text) from public, anon;
grant execute on function public.erase_person(uuid, text) to authenticated;

-- --------------------------------------- making the login safe to delete --

/*
  ⚠ The blocker on removing the auth login was never "we need an Edge Function".

    It is these two foreign keys, and an Edge Function written without fixing
    them first would be worse than the gap it closes:

      bookings.sender_id  on delete cascade
          Deleting the account deletes every parcel that person ever SENT —
          along with the recipients' own delivery history. People who never
          asked to be erased lose their receipts.

      bookings.driver_id  on delete set null
          Nulling it alone violates `driver_pair_consistent`, which requires
          `driver` and `driver_id` to move together. So the delete raises for
          anyone who has ever carried a parcel, which is every driver.

    One destroys other people's data silently; the other fails loudly. Both are
    fixed here, and only then is the login safe to remove.
*/

/*
  A parcel outlives the account that sent it.

  `sender_id` becomes nullable and nulls on delete. Every RLS policy comparing
  `sender_id = auth.uid()` keeps working unchanged — null never equals a uuid —
  so an orphaned parcel is readable by nobody except an admin, which is what it
  should be. `erase_person` has already removed the names and addresses on it;
  what survives is a route, a fare and a tracking id.
*/
alter table public.bookings
  alter column sender_id drop not null;

alter table public.bookings
  drop constraint if exists bookings_sender_id_fkey;

alter table public.bookings
  add constraint bookings_sender_id_fkey
  foreign key (sender_id) references auth.users (id) on delete set null;

/*
  And the carrier pair.

  The old rule was "both null or both set". The third state is now legitimate:
  a delivered parcel whose carrier's login has been removed keeps the display
  name `erase_person` wrote — 'Former driver' — with no id behind it. What is
  still refused is the reverse, an id with no name, which would be a row nobody
  can render.
*/
alter table public.bookings
  drop constraint if exists driver_pair_consistent;

alter table public.bookings
  add constraint driver_pair_consistent check (
    driver_id is null or driver is not null
  );

/*
  ⚠ STILL OUTSTANDING: the auth login.

    The foreign keys above make the delete *safe*. They do not make it
    *possible* from here: `auth.users` is not writable by any role a client can
    reach, so removing the login needs the service key, which means an Edge
    Function — `supabase/functions/erase-auth-user/`.

    Until that function is deployed, an erased person keeps a login that
    resolves to a scrubbed profile and is refused by every policy. That is not
    nothing, and it is not erasure. The admin dialog says which of the two
    happened rather than implying the account is gone.
*/
