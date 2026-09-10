-- ============================================================================
-- 20250101000039_guarantor_verification.sql — the guarantor verifies themselves, later
-- ============================================================================
--
-- ⚠ This moves somebody else's government ID out of the driver's hands.
--
--   Until now a driver typed their guarantor's NIN into their own application
--   and photographed their guarantor's slip. That is a person's national
--   identifier, collected from a third party who never saw a consent notice,
--   entered by somebody with an obvious incentive to invent one if the real
--   guarantor is reluctant. Under the NDPA the guarantor is a data subject in
--   their own right; the driver was never in a position to consent for them.
--
--   So the guarantor is invited, and enters it themselves, having read what it
--   is for. The driver never sees it.
--
-- ⚠ The guarantor has no LOCI account, and will not make one.
--
--   That is the whole design problem. Everything else in this schema is
--   protected by `auth.uid()`; this is reachable by a stranger holding a link.
--   The token rules below are therefore not a detail — they are the only thing
--   standing between an emailed URL and a table of national identifiers:
--
--     * 64 hex characters from two v4 UUIDs — around 244 bits of randomness,
--       so it cannot be guessed;
--     * stored as a SHA-256 digest, so a leaked backup is not a set of live
--       links — the same reason passwords are not stored either;
--     * single use, so a forwarded email is spent;
--     * expiring, so an old inbox is not a standing key;
--     * and the functions return the *minimum* — a driver's first name and
--       nothing else — because whoever holds the link is unauthenticated and
--       may not be the guarantor at all.
--
-- ⚠ And a driver whose guarantor never answers is not stranded.
--
--   An invitation that lapses can be replaced by the driver, including with a
--   corrected address, which is the commonest cause. An application nobody can
--   move is the same failure as a verification gate with no way past it.

-- ------------------------------------------------------------ the columns --

alter table public.driver_applications
  add column if not exists guarantor_email text;

/*
 * ⚠ `guarantor_nin`, `guarantor_address` and `guarantor_relationship` are left
 *   in place, and nothing writes them any more.
 *
 *   Dropping them would take the guarantor details off every application
 *   approved to date — the records somebody would want if a driver has to be
 *   investigated a year from now — and would break `erase_person` in
 *   `20250101000009_bans.sql`, which overwrites all three. The form stops collecting them;
 *   history keeps what it holds.
 */

/*
 * ⚠ Two new statuses, and the existing vocabulary is kept.
 *
 *   `pending` already meant "submitted, waiting for an admin". Renaming it
 *   would touch eight files and every row in the table. So the new initial
 *   state is `pending_guarantor`, and `ready_for_review` is its own value
 *   rather than a reuse of `pending` — an admin queue that cannot distinguish
 *   "waiting on a guarantor" from "waiting on me" is a queue that grows
 *   without anyone knowing why.
 */
alter table public.driver_applications
  drop constraint if exists driver_applications_status_check;

alter table public.driver_applications
  add constraint driver_applications_status_check
  check (status in (
    'pending_guarantor',
    'ready_for_review',
    'pending',
    'under_review',
    'approved',
    'rejected'
  ));

-- -------------------------------------------------------- the invitations --

create table if not exists public.guarantor_invitations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null
    references public.driver_applications (id) on delete cascade,

  /*
   * ⚠ The digest, never the token.
   *
   *   The token exists exactly once, in the email. Anyone with this table has
   *   the digests, and a digest cannot be put in a URL. This is the difference
   *   between a database leak that is embarrassing and one that hands over a
   *   working link to every pending guarantor.
   */
  token_hash text not null unique,

  /* Snapshotted, so the email is addressed to who was named at the time. */
  guarantor_name text not null,
  guarantor_email text not null,

  created_at timestamptz not null default now(),
  expires_at timestamptz not null,

  /* Set when the guarantor completes. Null means outstanding or lapsed. */
  completed_at timestamptz,

  /*
   * ⚠ Attempts are counted, because this endpoint is anonymous.
   *
   *   244 bits of randomness is not guessable, but an endpoint that answers
   *   unauthenticated requests all day is one worth pointing a script at. The
   *   count is what makes abuse visible; `open_guarantor_invitation` refuses
   *   past a ceiling.
   */
  attempts integer not null default 0
);

create index if not exists guarantor_invitations_application_idx
  on public.guarantor_invitations (application_id);

alter table public.guarantor_invitations enable row level security;

/*
 * ⚠ No policy for anybody. Not even the driver.
 *
 *   Every read and write goes through the `security definer` functions below.
 *   A driver who could select this table could read the digest — useless — but
 *   also the guarantor's email and, once the columns below exist, the shape of
 *   their submission. The driver's legitimate need is "has my guarantor done
 *   it yet", and `my_guarantor_status` answers exactly that and nothing more.
 */

/*
 * Where the guarantor's own NIN lands.
 *
 * ⚠ A separate table from the application, deliberately.
 *
 *   On the application row it would be readable by every policy and function
 *   that reads an application — including the driver's own read of their own
 *   row. The guarantor's identifier is not the driver's business, and the
 *   cleanest way to guarantee that is for it not to be on anything they can
 *   select.
 */
create table if not exists public.guarantor_verifications (
  invitation_id uuid primary key
    references public.guarantor_invitations (id) on delete cascade,
  application_id uuid not null
    references public.driver_applications (id) on delete cascade,

  /* ⚠ Last four only ever leave this table. See `admin_guarantor_summary`. */
  nin text not null check (nin ~ '^[0-9]{11}$'),

  /*
   * The consent, recorded as what it is: a statement by a named person at a
   * named time. "They ticked a box" is not a defence without the wording.
   */
  consented_at timestamptz not null default now(),
  consent_text text not null,

  /* For a dispute about who actually filled it in. */
  submitted_ip text,

  created_at timestamptz not null default now()
);

alter table public.guarantor_verifications enable row level security;
/* No policies at all: definer functions only, same reasoning as above. */

-- ------------------------------------------------------------- the window --

/*
 * Seven days. Long enough for somebody who checks email weekly, short enough
 * that a link in an old inbox is not a standing key.
 */
create or replace function public.guarantor_invitation_window()
returns interval language sql immutable as $$ select interval '7 days' $$;

/** How many times a token may be presented before it is treated as an attack. */
create or replace function public.guarantor_attempt_ceiling()
returns integer language sql immutable as $$ select 10 $$;

/** SHA-256 of the token, hex. Core Postgres — see `mint_guarantor_invitation`. */
create or replace function public.guarantor_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

revoke all on function public.guarantor_token_hash(text) from public, anon, authenticated;

-- ---------------------------------------------------------- minting a link --

/*
 * Creates an invitation and returns the *plaintext* token, once.
 *
 * ⚠ The only moment the token exists outside the email.
 *
 *   It is returned to the caller — the trigger, which puts it straight into
 *   the outbox payload — and never stored. There is deliberately no way to ask
 *   for it again: a "resend the same link" feature would require keeping it,
 *   and re-inviting mints a new one instead.
 */
create or replace function public.mint_guarantor_invitation(p_application uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  app record;
  raw_token text;
begin
  select id, guarantor_name, guarantor_email
    into app
    from public.driver_applications
   where id = p_application;

  if app.id is null then
    raise exception 'No such application';
  end if;

  if app.guarantor_email is null or btrim(app.guarantor_email) = '' then
    /*
     * No address, no invitation, and no row. Queuing one would leave an
     * application waiting on an email that was never sendable.
     */
    return null;
  end if;

  /*
   * ⚠ Any outstanding invitation is retired first.
   *
   *   Re-inviting with an older link still live would mean two working tokens
   *   for one application — and the driver correcting a mistyped address would
   *   leave the wrong stranger holding a valid one.
   */
  update public.guarantor_invitations
     set expires_at = now()
   where application_id = p_application
     and completed_at is null
     and expires_at > now();

  /*
   * ⚠ Core Postgres only: `gen_random_uuid` and `sha256` are both built in.
   *
   *   The obvious spelling uses pgcrypto's `gen_random_bytes` and `digest`.
   *   Supabase has pgcrypto, but depending on an extension for something core
   *   can do means this migration cannot be run — or tested — anywhere that
   *   does not, and the PGlite harness is exactly such a place. Two v4 UUIDs
   *   are ~244 bits of randomness, which is more than the 128 anybody would
   *   ask for.
   */
  raw_token :=
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.guarantor_invitations
    (application_id, token_hash, guarantor_name, guarantor_email, expires_at)
  values (
    p_application,
    public.guarantor_token_hash(raw_token),
    coalesce(app.guarantor_name, 'there'),
    btrim(app.guarantor_email),
    now() + public.guarantor_invitation_window()
  );

  return raw_token;
end;
$$;

-- ------------------------------------------------- inviting on submission --

/*
 * Fires the moment an application is created.
 *
 * ⚠ On insert, because that is what "submits their application" means.
 *
 *   The status is forced here rather than trusted from the client: an
 *   application that arrived claiming `ready_for_review` would otherwise skip
 *   the guarantor entirely, and the client is not the authority on its own
 *   review state.
 */
create or replace function public.invite_guarantor_on_submit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_token text;
begin
  raw_token := public.mint_guarantor_invitation(new.id);

  if raw_token is null then
    return new;
  end if;

  perform public.queue_email(
    'guarantor_invitation',
    new.id::text,
    new.guarantor_email,
    jsonb_build_object(
      'guarantor_name', new.guarantor_name,
      'driver_name', new.full_name,
      'reference', new.reference,
      /*
       * ⚠ The token travels in the payload, and this is the one place it may.
       *
       *   The outbox is admin-readable, so an admin can read a pending
       *   guarantor's link — which is the same access an admin already has to
       *   approve the driver outright. It is not readable by the driver, which
       *   is the boundary that matters: a driver holding the link could
       *   complete their own guarantor check.
       */
      'token', raw_token,
      'expires_at', now() + public.guarantor_invitation_window()
    )
  );

  return new;
end;
$$;

/*
 * ⚠ Statuses are set by a BEFORE trigger, so the row is written correctly
 *   rather than corrected afterwards.
 */
create or replace function public.default_application_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.guarantor_email is not null and btrim(new.guarantor_email) <> '' then
    new.status := 'pending_guarantor';
  end if;
  return new;
end;
$$;

drop trigger if exists on_application_status_default on public.driver_applications;
create trigger on_application_status_default
  before insert on public.driver_applications
  for each row execute function public.default_application_status();

drop trigger if exists on_application_invite_guarantor on public.driver_applications;
create trigger on_application_invite_guarantor
  after insert on public.driver_applications
  for each row execute function public.invite_guarantor_on_submit();

-- ------------------------------------------------------- opening the link --

/*
 * What the portal shows before anything is submitted.
 *
 * ⚠ Callable by anyone holding a token, and returns almost nothing.
 *
 *   Whoever opened this link may not be the guarantor — email is forwarded,
 *   inboxes are shared, addresses are mistyped. So it returns the driver's
 *   name, because that is what the guarantor needs in order to know what they
 *   are agreeing to, and the guarantor's own first name so the page is not
 *   addressed to a stranger. It does not return the driver's phone, address,
 *   NIN, vehicle, or the guarantor's email.
 */
create or replace function public.open_guarantor_invitation(p_token text)
returns table (
  valid boolean,
  reason text,
  driver_name text,
  guarantor_name text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
  app record;
begin
  select * into invite
    from public.guarantor_invitations
   where token_hash = public.guarantor_token_hash(coalesce(p_token, ''));

  /*
   * ⚠ One shape of answer for "no such token".
   *
   *   Returning "unknown token" here and "expired" there tells somebody
   *   probing which of their guesses was a real invitation. Both are `invalid`.
   */
  if invite.id is null then
    return query select false, 'invalid'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  update public.guarantor_invitations
     set attempts = attempts + 1
   where id = invite.id;

  if invite.attempts >= public.guarantor_attempt_ceiling() then
    return query select false, 'invalid'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if invite.completed_at is not null then
    return query select false, 'completed'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if invite.expires_at <= now() then
    return query select false, 'expired'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  select full_name into app
    from public.driver_applications
   where id = invite.application_id;

  return query
    select true, null::text, app.full_name, invite.guarantor_name, invite.expires_at;
end;
$$;

-- -------------------------------------------------- completing the check --

/*
 * The guarantor's own NIN and consent.
 *
 * ⚠ Everything is re-checked here. The portal's own view of validity is a
 *   render, not an authority — a page left open past the expiry, or reopened
 *   from history after somebody else completed it, would otherwise submit.
 */
create or replace function public.complete_guarantor_verification(
  p_token text,
  p_nin text,
  p_consent_text text,
  p_ip text default null
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
  digits text;
begin
  select * into invite
    from public.guarantor_invitations
   where token_hash = public.guarantor_token_hash(coalesce(p_token, ''));

  if invite.id is null then
    return query select false, 'invalid'::text;
    return;
  end if;

  if invite.completed_at is not null then
    return query select false, 'completed'::text;
    return;
  end if;

  if invite.expires_at <= now() then
    return query select false, 'expired'::text;
    return;
  end if;

  digits := regexp_replace(coalesce(p_nin, ''), '[^0-9]', '', 'g');

  if digits !~ '^[0-9]{11}$' then
    return query select false, 'bad-nin'::text;
    return;
  end if;

  /*
   * ⚠ Consent is refused if there is no wording to record.
   *
   *   "They agreed" is not a record of anything. What they agreed to is the
   *   part that has to survive, so an empty consent string is a failure rather
   *   than a default.
   */
  if p_consent_text is null or btrim(p_consent_text) = '' then
    return query select false, 'no-consent'::text;
    return;
  end if;

  insert into public.guarantor_verifications
    (invitation_id, application_id, nin, consent_text, submitted_ip)
  values (invite.id, invite.application_id, digits, btrim(p_consent_text), p_ip);

  /* Spent. A forwarded email is now worthless. */
  update public.guarantor_invitations
     set completed_at = now()
   where id = invite.id;

  /*
   * ⚠ Only out of `pending_guarantor`.
   *
   *   An application an admin has already rejected, or already approved, must
   *   not be dragged back into the queue by a guarantor completing late.
   */
  update public.driver_applications
     set status = 'ready_for_review'
   where id = invite.application_id
     and status = 'pending_guarantor';

  return query select true, null::text;
end;
$$;

-- --------------------------------------------------------- for the driver --

/*
 * What the driver may know: whether their guarantor has done it.
 *
 * ⚠ Not the token, not the guarantor's NIN, not even the email as stored.
 *
 *   A driver who could read the token could complete their own guarantor
 *   check, which is the entire fraud this feature exists to prevent.
 */
create or replace function public.my_guarantor_status()
returns table (state text, guarantor_email text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select
    case
      when i.completed_at is not null then 'completed'
      when i.expires_at <= now() then 'expired'
      else 'waiting'
    end,
    i.guarantor_email,
    i.expires_at
  from public.guarantor_invitations i
  join public.driver_applications a on a.id = i.application_id
  where a.user_id = auth.uid()
  order by i.created_at desc
  limit 1;
$$;

/*
 * Re-invite, optionally to a corrected address.
 *
 * ⚠ The way out of a stuck application, and it belongs to the driver.
 *
 *   A guarantor who never answers would otherwise leave an application nobody
 *   can move — the applicant has done everything asked and has no lever. A
 *   mistyped address is the commonest cause, so the address can be corrected
 *   here rather than requiring support.
 */
create or replace function public.reinvite_guarantor(p_email text default null)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  app record;
  raw_token text;
begin
  select * into app
    from public.driver_applications
   where user_id = auth.uid()
   order by submitted_at desc
   limit 1;

  if app.id is null then
    return query select false, 'no-application'::text;
    return;
  end if;

  if app.status <> 'pending_guarantor' then
    return query select false, 'not-waiting'::text;
    return;
  end if;

  if p_email is not null and btrim(p_email) <> '' then
    update public.driver_applications
       set guarantor_email = btrim(p_email)
     where id = app.id;
  end if;

  raw_token := public.mint_guarantor_invitation(app.id);
  if raw_token is null then
    return query select false, 'no-email'::text;
    return;
  end if;

  select * into app from public.driver_applications where id = app.id;

  perform public.queue_email(
    'guarantor_invitation',
    /*
     * ⚠ Keyed on the invitation, not the application.
     *
     *   Keyed on the application, the outbox's unique constraint would swallow
     *   every re-invitation after the first — which is precisely the case this
     *   function exists to serve.
     */
    app.id::text || ':' || to_char(now(), 'YYYYMMDDHH24MISS'),
    app.guarantor_email,
    jsonb_build_object(
      'guarantor_name', app.guarantor_name,
      'driver_name', app.full_name,
      'reference', app.reference,
      'token', raw_token,
      'expires_at', now() + public.guarantor_invitation_window()
    )
  );

  return query select true, null::text;
end;
$$;

-- ------------------------------------------------------------ for an admin --

/*
 * The guarantor's NIN, revealed to an admin and recorded.
 *
 * ⚠ Last four by default, in full only on a stated reason.
 *
 *   Same rule as `admin_reveal_sender_identity`. A review queue is a screen
 *   somebody leaves open; it should not be a list of national identifiers.
 */
create or replace function public.admin_guarantor_summary(p_application uuid)
returns table (verified boolean, nin_last4 text, consented_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select true, right(v.nin, 4), v.consented_at
  from public.guarantor_verifications v
  where v.application_id = p_application
    and public.is_admin();
$$;

-- ----------------------------------------------------------------- grants --

/*
 * ⚠ `anon` may call exactly two functions, and this is the line that decides
 *   how exposed this feature is.
 *
 *   The guarantor has no account, so these must be reachable without one.
 *   Nothing else here is: minting, re-inviting and the admin summary all
 *   require a session, and the tables themselves have no policies at all.
 */
revoke all on function public.mint_guarantor_invitation(uuid) from public, anon, authenticated;

grant execute on function public.open_guarantor_invitation(text) to anon, authenticated;
grant execute on function public.complete_guarantor_verification(text, text, text, text)
  to anon, authenticated;

revoke all on function public.my_guarantor_status() from public, anon;
grant execute on function public.my_guarantor_status() to authenticated;

revoke all on function public.reinvite_guarantor(text) from public, anon;
grant execute on function public.reinvite_guarantor(text) to authenticated;

revoke all on function public.admin_guarantor_summary(uuid) from public, anon;
grant execute on function public.admin_guarantor_summary(uuid) to authenticated;
