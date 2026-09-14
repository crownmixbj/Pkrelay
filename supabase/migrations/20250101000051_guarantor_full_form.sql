-- ============================================================================
-- 20250101000051_guarantor_full_form.sql — the guarantor says who they are
-- ============================================================================
--
-- 39 built the hard part: a stranger with no account, holding a hashed,
-- single-use, expiring token, can tell us their NIN and consent to it being
-- checked. Read that file first — every token rule here is its rule, and none
-- of them are restated.
--
-- This migration widens what that person is asked for, and there are only two
-- reasons to widen it at all:
--
--   1. A NIN and a tick prove that *somebody* holds the link. They do not say
--      who is standing behind this driver, how the two know each other, or how
--      to reach them when a parcel goes missing. An admin reviewing an
--      application had a number and nothing to read.
--
--   2. A guarantee that carries no stated liability is a character reference
--      with a national identifier attached. If Package Relay is ever going to
--      recover the value of converted goods from a guarantor, the wording that
--      person agreed to has to exist, be specific, and be on file with the
--      time they agreed to it.
--
-- ⚠ GUARANTOR_SURETYSHIP_REVIEW_REQUIRED — the clause this migration stores is
--   a suretyship: it makes a third party jointly liable for somebody else's
--   conduct up to the value of the goods. Whether a click-through suretyship,
--   accepted by a person with no account and no separate consideration, is
--   enforceable in Nigeria is a question for a Nigerian lawyer and not for this
--   file. Nothing here asserts that it is. What this migration guarantees is
--   narrower and is the part that is actually achievable in software: the exact
--   wording shown, the name typed under it, and the moment it was submitted are
--   recorded and cannot drift apart afterwards. See `docs/GUARANTOR.md`.
--
-- ⚠ Two things the guarantor now hands over that are not text, and the whole
--   upload design follows from them.
--
--   A photograph of a government ID, and a photograph of the person taken at
--   that moment. Neither can go through the anonymous PostgREST surface, and
--   granting `anon` an insert policy on `storage.objects` to let a token holder
--   upload directly was the first design and is not the one below. It would
--   have made the token a storage credential: good for as many objects as the
--   holder cared to push, with the bucket's size limit as the only ceiling and
--   no server-side view of who was doing it.
--
--   So uploads go through the `guarantor-portal` edge function, which holds the
--   service role, and `anon` gains nothing here at all. That has a second
--   benefit 39 asked for in a comment and could not have: `submitted_ip` is
--   finally filled by something that knows the address rather than by a client
--   reporting its own.
--
-- ⚠ And `complete_guarantor_verification` is taken *away* from `anon`.
--
--   It is now reachable only by the service role, through that same function.
--   After this migration `anon` may call exactly one thing in this database —
--   `open_guarantor_invitation` — which is a smaller anonymous surface than the
--   feature had when it did less.

-- --------------------------------------------------- what the guarantor says --

/*
 * ⚠ Every column is nullable, and that is not laziness.
 *
 *   Rows written between 39 and this migration have a NIN and a consent string
 *   and nothing else. A `not null` on `full_name` would either refuse this
 *   migration or require inventing a value for a real person's record, and an
 *   invented value in a file meant for a dispute is worse than a null.
 *
 *   The requirement lives in `complete_guarantor_verification` below, which is
 *   the only writer. New rows are complete; old rows stay honest about what was
 *   never asked.
 */
alter table public.guarantor_verifications
  /* Who they are, in their own words rather than the driver's. */
  add column if not exists full_name text,
  /*
   * ⚠ WhatsApp, specifically, and asked for as such.
   *
   *   Recovery conversations in Nigeria happen on WhatsApp. A landline or a
   *   number that is not on it is a number nobody will reach, so the label on
   *   the field says WhatsApp and this column records what was given for it.
   */
  add column if not exists whatsapp_phone text,
  /*
   * Their own address for correspondence, which may differ from the one the
   * invitation was sent to — a driver mistypes it, or names a work address for
   * a person who would rather use a personal one. Both are kept: this column
   * and `guarantor_invitations.guarantor_email`. A mismatch is a thing an admin
   * should see, not a thing this table should silently resolve.
   */
  add column if not exists email text,
  add column if not exists residential_address text,
  add column if not exists relationship text,
  add column if not exists known_duration text,

  /* Professional background: what an admin weighs the guarantee against. */
  add column if not exists employment_status text,
  add column if not exists company_name text,
  add column if not exists job_title text,

  /*
   * ⚠ The suretyship wording, stored beside the consent wording rather than
   *   replacing it.
   *
   *   They are two different agreements to two different things — "you may
   *   check my identity" and "I am liable for the value of the goods" — and a
   *   person can reasonably be shown to have agreed to one and not the other.
   *   Collapsing them into one string would destroy that distinction at exactly
   *   the moment somebody needs it.
   */
  add column if not exists declaration_text text,
  add column if not exists declared_at timestamptz,

  /*
   * The signature: a typed full name, and the time it was typed.
   *
   * ⚠ Not a drawn signature, and not presented as more than it is.
   *
   *   A typed name is an electronic signature under the Nigeria Data
   *   Protection Act's neighbouring evidence rules only to the extent that the
   *   surrounding record supports it. What makes this worth anything is the
   *   company it keeps in this row — the wording, the timestamp, the IP, the
   *   live photograph and the ID — not the characters themselves.
   */
  add column if not exists signature_name text,
  add column if not exists signed_at timestamptz,

  /* Alongside `submitted_ip`, for a dispute about who filled this in. */
  add column if not exists user_agent text;

/*
 * ⚠ Checked as vocabularies, because these two are closed sets and short.
 *
 *   `relationship` and `known_duration` are offered from
 *   `src/constants/driver-validation.ts`, and `employment_status` from
 *   `src/constants/guarantor.ts`. Pinning all three here would guarantee the
 *   drift this codebase has been bitten by before: the list grows in TypeScript,
 *   the constraint does not, and a real guarantor picking a newly added option
 *   gets an error nobody can reproduce.
 *
 *   So only the two whose values the *review* reads as data are constrained,
 *   and `relationship` — the one certain to grow — is length-checked instead.
 */
alter table public.guarantor_verifications
  drop constraint if exists guarantor_verifications_employment_check;
alter table public.guarantor_verifications
  add constraint guarantor_verifications_employment_check
  check (
    employment_status is null
    or employment_status in (
      'Employed', 'Self-employed', 'Business owner', 'Civil servant',
      'Retired', 'Unemployed', 'Student'
    )
  );

alter table public.guarantor_verifications
  drop constraint if exists guarantor_verifications_duration_check;
alter table public.guarantor_verifications
  add constraint guarantor_verifications_duration_check
  check (
    known_duration is null
    or known_duration in (
      'Under 1 year', '1-2 years', '3-5 years', '6-10 years', 'Over 10 years'
    )
  );

-- ------------------------------------------------------------ the two photos --

/*
 * Where an uploaded file is recorded. The bytes are in Storage; this is the
 * index, and the only thing that says an upload belongs to an invitation.
 *
 * ⚠ Keyed on (invitation, kind), so a retake replaces rather than accumulates.
 *
 *   A guarantor whose first photograph was dark will take another. Two rows for
 *   one live photo means an admin choosing which of two faces to believe, and
 *   `complete_guarantor_verification` counting an attachment twice.
 */
create table if not exists public.guarantor_documents (
  invitation_id uuid not null
    references public.guarantor_invitations (id) on delete cascade,

  kind text not null check (kind in ('government_id', 'live_photo')),

  /*
   * ⚠ Derived by `guarantor_document_slot`, never accepted from a caller.
   *
   *   The same rule as `complete_capture_session` in 13, for the same reason: a
   *   caller that can name the path can point an invitation at an object
   *   belonging to a different one.
   *
   *   It deliberately carries no file extension. `<invitation>/live_photo` is
   *   one address for one thing, so a JPEG retaken as a PNG overwrites the
   *   first rather than orphaning it in a bucket nothing can garbage-collect.
   *   The type travels in `content_type` and in Storage's own metadata.
   */
  path text not null unique,
  content_type text not null,
  bytes integer not null check (bytes > 0),

  uploaded_at timestamptz not null default now(),

  primary key (invitation_id, kind)
);

alter table public.guarantor_documents enable row level security;
/* No policies, for anybody. Definer functions and the service role only. */

/*
 * A private bucket of its own.
 *
 * ⚠ Not `sender-identity`, and not `driver-documents`.
 *
 *   Those hold files belonging to account holders who can be shown a retention
 *   notice and can exercise a deletion right through the app. These belong to
 *   people with no account, collected once, whose only relationship with
 *   Package Relay is a link they were emailed. When a retention decision is
 *   finally made it will not be the same decision, and a shared bucket would
 *   force it to be.
 */
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'guarantor-identity',
  'guarantor-identity',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/*
 * ⚠ One policy, and it is a read for admins. Nothing else, for anyone.
 *
 *   No insert policy exists because nothing signed in is meant to write here —
 *   the edge function holds the service role and bypasses RLS. No policy for
 *   `anon` exists because the token must not become a storage credential. And
 *   no policy for the driver: a driver who could read this bucket could read
 *   their own guarantor's ID, which is the disclosure 39 exists to prevent.
 */
drop policy if exists "admins read guarantor identity files" on storage.objects;
create policy "admins read guarantor identity files"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'guarantor-identity' and (select public.is_admin()));

-- ------------------------------------------------- where an upload may land --

/**
 * Reserves the path for one document and returns it.
 *
 * ⚠ Service role only, called by `guarantor-portal` after it has been handed a
 *   token. The token is re-checked here rather than trusted: the function is
 *   the only caller today, and "the only caller today" is not a rule the
 *   database can rely on.
 *
 * The row is written before the bytes exist, with `bytes = 0` meaning reserved
 * — no, it cannot: the check refuses it. So nothing is written here at all, and
 * `guarantor_document_recorded` below is what commits. This function's whole
 * job is to answer "where", having first answered "may you".
 */
create or replace function public.guarantor_document_slot(
  p_token text,
  p_kind text
)
returns table (ok boolean, reason text, path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
begin
  if p_kind not in ('government_id', 'live_photo') then
    return query select false, 'bad-kind'::text, null::text;
    return;
  end if;

  select * into invite
    from public.guarantor_invitations
   where token_hash = public.guarantor_token_hash(coalesce(p_token, ''));

  /* The same three refusals, in the same order, as everything else here. */
  if invite.id is null then
    return query select false, 'invalid'::text, null::text;
    return;
  end if;

  if invite.completed_at is not null then
    return query select false, 'completed'::text, null::text;
    return;
  end if;

  if invite.expires_at <= now() then
    return query select false, 'expired'::text, null::text;
    return;
  end if;

  return query select true, null::text, invite.id::text || '/' || p_kind;
end;
$$;

/**
 * Records an upload that has landed.
 *
 * ⚠ The path is checked against the one this invitation is entitled to, not
 *   merely stored. Otherwise the caller could report a path under a different
 *   invitation and attach somebody else's ID to this application.
 */
create or replace function public.guarantor_document_recorded(
  p_token text,
  p_kind text,
  p_path text,
  p_content_type text,
  p_bytes integer
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
  expected text;
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

  expected := invite.id::text || '/' || p_kind;

  if p_path is distinct from expected then
    return query select false, 'bad-path'::text;
    return;
  end if;

  if coalesce(p_bytes, 0) <= 0 then
    return query select false, 'empty-file'::text;
    return;
  end if;

  insert into public.guarantor_documents
    (invitation_id, kind, path, content_type, bytes)
  values (invite.id, p_kind, expected, coalesce(p_content_type, 'image/jpeg'), p_bytes)
  on conflict (invitation_id, kind) do update
    set path = excluded.path,
        content_type = excluded.content_type,
        bytes = excluded.bytes,
        uploaded_at = now();

  return query select true, null::text;
end;
$$;

-- ------------------------------------ telling the driver it has gone out --

/*
 * Replaces 39's version to add one line: the driver is told that the
 * invitation was sent, and to whom.
 *
 * ⚠ `guarantor_pending` has been a permitted notification kind since 49 and
 *   nothing has ever emitted it.
 *
 *   A driver pressed Submit and landed on a dashboard saying "Waiting on
 *   guarantor" with no record of anything having happened. The commonest reason
 *   a guarantor never answers is a mistyped address, and the moment to catch
 *   that is now — while the driver still remembers what they typed — not in a
 *   week when the link expires. The notification names the address for exactly
 *   that reason.
 *
 * Everything else about this function is 39's, unchanged.
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
      /* The token travels in the payload, and this is the one place it may — see 39. */
      'token', raw_token,
      'expires_at', now() + public.guarantor_invitation_window()
    )
  );

  perform public.queue_notification(
    new.user_id,
    'guarantor_pending',
    new.id::text,
    'We have emailed your guarantor',
    'We sent ' || coalesce(new.guarantor_name, 'your guarantor') || ' a link at '
      || new.guarantor_email || '. Check the address is right — you can correct it and '
      || 'send again from your driver portal.',
    jsonb_build_object(
      'guarantor_email', new.guarantor_email,
      'application_reference', new.reference
    )
  );

  return new;
end;
$$;

-- ------------------------------------------------- what the portal may read --

/*
 * ⚠ Two fields added to what a link holder is told, and no more than two.
 *
 *   39 returned the driver's name and the guarantor's own first name and argued
 *   at length for the minimum. That argument still holds, and these two do not
 *   weaken it:
 *
 *     `reference`      — the application's own reference, so a guarantor
 *                        telephoning about this can quote something. It
 *                        identifies an application, not a person.
 *     `guarantor_email` — the address this invitation was sent to. Whoever is
 *                        reading the page opened it from that inbox, so it
 *                        discloses nothing they do not already have, and it
 *                        lets the form show the address read-only instead of
 *                        asking a second time.
 *
 *   Still not returned: the driver's phone, address, NIN, vehicle or city.
 */
drop function if exists public.open_guarantor_invitation(text);

create or replace function public.open_guarantor_invitation(p_token text)
returns table (
  valid boolean,
  reason text,
  driver_name text,
  guarantor_name text,
  guarantor_email text,
  reference text,
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

  /* One shape of answer for "no such token" — see 39. */
  if invite.id is null then
    return query select false, 'invalid'::text,
      null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  update public.guarantor_invitations
     set attempts = attempts + 1
   where id = invite.id;

  if invite.attempts >= public.guarantor_attempt_ceiling() then
    return query select false, 'invalid'::text,
      null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if invite.completed_at is not null then
    return query select false, 'completed'::text,
      null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if invite.expires_at <= now() then
    return query select false, 'expired'::text,
      null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  /*
   * ⚠ Aliased, because `reference` is also an OUT parameter of this function.
   *
   *   Unqualified, `reference` in this query is ambiguous between the column and
   *   the output column of the same name — an error at call time, not at create
   *   time, so it passes `db push` and fails on the first guarantor who opens a
   *   link. The alias is what disambiguates it.
   */
  select a.full_name, a.reference into app
    from public.driver_applications a
   where a.id = invite.application_id;

  return query select
    true, null::text,
    app.full_name, invite.guarantor_name, invite.guarantor_email, app.reference,
    invite.expires_at;
end;
$$;

-- -------------------------------------------------- completing the check --

/*
 * ⚠ The four-argument version of this function is dropped, not kept beside the
 *   new one.
 *
 *   Postgres would happily hold both — different argument lists, different
 *   functions — and `anon` had execute on the old one. Leaving it in place
 *   would leave a live anonymous endpoint that completes a guarantor check with
 *   a NIN and a tick, skipping the declaration, the signature and both
 *   photographs. A gate with a second door is not a gate.
 */
drop function if exists public.complete_guarantor_verification(text, text, text, text);

/*
 * ⚠ One `jsonb` payload rather than eighteen parameters.
 *
 *   Fourteen fields arrived in this migration and more will. Each new one as a
 *   parameter is a new function signature, a new set of grants, and an older
 *   client calling the older signature — which is precisely the second-door
 *   problem above. A payload changes shape without changing identity.
 *
 * ⚠ `p_ip` and `p_user_agent` are separate arguments on purpose.
 *
 *   They are not things the guarantor said; they are things the server
 *   observed. Mixing them into the payload would put a client-supplied value
 *   in the same shape as an observed one, and a record that cannot distinguish
 *   the two is not evidence of anything. Only the edge function may call this,
 *   so only the edge function can fill them.
 */
create or replace function public.complete_guarantor_verification(
  p_token text,
  p_payload jsonb,
  p_ip text default null,
  p_user_agent text default null
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
  driver uuid;
  app_reference text;
  digits text;
  phone text;
  employment text;
  signature text;
  name text;
  attachments integer;
  declaration text;
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

  /* ----------------------------------------------------------- identity -- */

  digits := regexp_replace(coalesce(p_payload->>'nin', ''), '[^0-9]', '', 'g');
  if digits !~ '^[0-9]{11}$' then
    return query select false, 'bad-nin'::text;
    return;
  end if;

  name := btrim(coalesce(p_payload->>'full_name', ''));
  /*
   * Two words, which is the same floor the driver application applies to a
   * guarantor's name. It rejects "Bisi" and accepts everything real.
   */
  if array_length(regexp_split_to_array(name, '\s+'), 1) < 2 then
    return query select false, 'bad-name'::text;
    return;
  end if;

  /*
   * ⚠ Digits, not a format.
   *
   *   The client enforces +234 and a Nigerian network prefix, because it can
   *   say so helpfully while somebody is typing. Repeating that regex here
   *   would put the definition of a valid Nigerian mobile number in two places
   *   and guarantee they disagree the week a new prefix is allocated. This
   *   floor catches what actually reaches a database — a blank, a name typed
   *   into the wrong box, seven digits — and nothing else.
   */
  phone := regexp_replace(coalesce(p_payload->>'whatsapp_phone', ''), '[^0-9]', '', 'g');
  if length(phone) < 10 or length(phone) > 15 then
    return query select false, 'bad-phone'::text;
    return;
  end if;

  if coalesce(p_payload->>'email', '') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    return query select false, 'bad-email'::text;
    return;
  end if;

  /*
   * Ten characters, the same floor the driver application uses for an address.
   * It rejects "Lagos" and accepts a real line of one.
   */
  if length(btrim(coalesce(p_payload->>'residential_address', ''))) < 10 then
    return query select false, 'bad-address'::text;
    return;
  end if;

  if btrim(coalesce(p_payload->>'relationship', '')) = ''
     or length(btrim(p_payload->>'relationship')) > 80 then
    return query select false, 'bad-relationship'::text;
    return;
  end if;

  if btrim(coalesce(p_payload->>'known_duration', '')) = '' then
    return query select false, 'bad-duration'::text;
    return;
  end if;

  /* ------------------------------------------------------- professional -- */

  employment := btrim(coalesce(p_payload->>'employment_status', ''));
  if employment = '' then
    return query select false, 'bad-employment'::text;
    return;
  end if;

  /*
   * ⚠ An employer is required of people who have one, and not of people who do
   *   not.
   *
   *   Requiring a company name of everybody would make a retired guarantor
   *   type something untrue into a form that is about to ask them to sign it.
   */
  if employment not in ('Retired', 'Unemployed', 'Student') then
    if btrim(coalesce(p_payload->>'company_name', '')) = ''
       or btrim(coalesce(p_payload->>'job_title', '')) = '' then
      return query select false, 'bad-employer'::text;
      return;
    end if;
  end if;

  /* ------------------------------------------------ consent and liability -- */

  /*
   * Both wordings are required, and for the reason 39 gave about the first:
   * "they agreed" is not a record of anything. What they agreed to is the part
   * that has to survive.
   */
  if btrim(coalesce(p_payload->>'consent_text', '')) = '' then
    return query select false, 'no-consent'::text;
    return;
  end if;

  declaration := btrim(coalesce(p_payload->>'declaration_text', ''));
  if declaration = '' then
    return query select false, 'no-declaration'::text;
    return;
  end if;

  /*
   * ⚠ A floor on the length of the clause itself.
   *
   *   This column is the only evidence of what a person accepted liability
   *   under. A client bug that posted 'true', or an empty template, would store
   *   a row that looks complete and proves nothing — and it would look
   *   complete a year later, to somebody who no longer has the page.
   */
  if length(declaration) < 200 then
    return query select false, 'no-declaration'::text;
    return;
  end if;

  /*
   * ⚠ The signature has to be the name they just gave.
   *
   *   A typed name is worth something only as an act of adoption: this person,
   *   having read that, wrote their own name under it. Accepting any string
   *   would make the field decorative, and accepting "yes" would make it
   *   misleading. Compared case- and space-insensitively, because people type
   *   their own names with inconsistent spacing and capitals and being pedantic
   *   about it would fail honest submissions.
   */
  signature := lower(regexp_replace(coalesce(p_payload->>'signature_name', ''), '\s+', ' ', 'g'));
  if btrim(signature) is distinct from lower(regexp_replace(name, '\s+', ' ', 'g')) then
    return query select false, 'signature-mismatch'::text;
    return;
  end if;

  /* ----------------------------------------------------------- the files -- */

  /*
   * ⚠ Counted from the table, not taken from the payload.
   *
   *   The client cannot be the authority on whether an upload happened. This
   *   asks the only thing that knows.
   */
  select count(*) into attachments
    from public.guarantor_documents
   where invitation_id = invite.id
     and kind in ('government_id', 'live_photo');

  if attachments < 2 then
    return query select false, 'missing-documents'::text;
    return;
  end if;

  /* ------------------------------------------------------------- the row -- */

  insert into public.guarantor_verifications (
    invitation_id, application_id, nin,
    consent_text, submitted_ip,
    full_name, whatsapp_phone, email, residential_address,
    relationship, known_duration,
    employment_status, company_name, job_title,
    declaration_text, declared_at,
    signature_name, signed_at,
    user_agent
  ) values (
    invite.id, invite.application_id, digits,
    btrim(p_payload->>'consent_text'), p_ip,
    name,
    btrim(p_payload->>'whatsapp_phone'),
    lower(btrim(p_payload->>'email')),
    btrim(p_payload->>'residential_address'),
    btrim(p_payload->>'relationship'),
    btrim(p_payload->>'known_duration'),
    employment,
    nullif(btrim(coalesce(p_payload->>'company_name', '')), ''),
    nullif(btrim(coalesce(p_payload->>'job_title', '')), ''),
    declaration,
    now(),
    btrim(p_payload->>'signature_name'),
    now(),
    /* Truncated: a user agent string is unbounded and this is a footnote. */
    left(coalesce(p_user_agent, ''), 400)
  );

  /* Spent. A forwarded email is now worthless. */
  update public.guarantor_invitations
     set completed_at = now()
   where id = invite.id;

  /* Only out of `pending_guarantor` — see 39. */
  update public.driver_applications
     set status = 'ready_for_review'
   where id = invite.application_id
     and status = 'pending_guarantor';

  /*
   * ⚠ The driver is told, which nothing did before.
   *
   *   `guarantor_completed` has been a permitted notification kind since 49 and
   *   nothing has ever emitted it. The driver was left refreshing a card. This
   *   is the event they are actually waiting on.
   */
  /*
   * ⚠ Selected into `app_reference`, not into a variable called `reference`.
   *
   *   `reference` is also the column's name, and a plpgsql variable that shadows
   *   a column in its own query is an "ambiguous column" error at call time —
   *   the kind that passes `create function` and fails on the first real
   *   guarantor.
   */
  select a.user_id, a.reference into driver, app_reference
    from public.driver_applications a
   where a.id = invite.application_id;

  perform public.queue_notification(
    driver,
    'guarantor_completed',
    invite.id::text,
    'Your guarantor has completed their check',
    invite.guarantor_name || ' has verified themselves. Your application is now with our review team.',
    jsonb_build_object('application_reference', app_reference)
  );

  return query select true, null::text;
end;
$$;

-- --------------------------------------------------------- for the driver --

/*
 * ⚠ Replaced to add two timestamps, and the reason is that a driver watching
 *   this card could not tell a typo from a slow guarantor.
 *
 *   The old answer was a state, an address and an expiry. What it left out was
 *   *when anything happened*, which is the only way somebody can reason about
 *   silence. Three days of nothing means one thing if the invitation went out
 *   three days ago and another if the email is still sitting unsent in the
 *   outbox.
 *
 *     invited_at     when the invitation was minted — the link's birthday.
 *     email_sent_at  when the provider actually accepted it, or null while it
 *                    is still queued. These are different facts and the card
 *                    says so rather than presenting the first as the second.
 *     invitations    how many have been sent, so a driver on their third
 *                    attempt sees that rather than a card that looks unchanged.
 *
 * Still never returned: the token, the NIN, or anything the guarantor typed.
 */
drop function if exists public.my_guarantor_status();

create or replace function public.my_guarantor_status()
returns table (
  state text,
  guarantor_name text,
  guarantor_email text,
  invited_at timestamptz,
  email_sent_at timestamptz,
  expires_at timestamptz,
  completed_at timestamptz,
  invitations integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select i.*, a.id as app_id
      from public.guarantor_invitations i
      join public.driver_applications a on a.id = i.application_id
     where a.user_id = (select auth.uid())
     order by i.created_at desc
     limit 1
  )
  select
    case
      when m.completed_at is not null then 'completed'
      when m.expires_at <= now() then 'expired'
      else 'waiting'
    end,
    m.guarantor_name,
    m.guarantor_email,
    m.created_at,
    /*
     * ⚠ Matched on the address and the subject prefix, because a re-invitation
     *   does not key the outbox on the application id alone.
     *
     *   `reinvite_guarantor` appends a timestamp to `subject_id` so the outbox's
     *   unique constraint does not swallow the second invitation. A join on
     *   equality would therefore find the first email and never any later one —
     *   and a driver who corrected a typo would be shown the send time of the
     *   message that went to the wrong address.
     */
    (
      select o.sent_at
        from public.email_outbox o
       where o.kind = 'guarantor_invitation'
         and o.recipient = m.guarantor_email
         and o.subject_id like m.app_id::text || '%'
       order by o.created_at desc
       limit 1
    ),
    m.expires_at,
    m.completed_at,
    (select count(*)::integer from public.guarantor_invitations g where g.application_id = m.app_id)
  from mine m;
$$;

-- ------------------------------------------------------------ for an admin --

/*
 * The whole guarantor record, for the person deciding on the application.
 *
 * ⚠ Still last four of the NIN, and the paths rather than the files.
 *
 *   The reveal rule from 39 is unchanged: a review queue is a screen somebody
 *   leaves open, and it should not be a list of national identifiers. The
 *   document paths are returned because an admin client needs something to ask
 *   for a signed URL with; the objects themselves are only readable by an admin
 *   or the service role.
 *
 * ⚠ `email_matches_invite` is computed here rather than left to the client.
 *
 *   A guarantor who gives a different address from the one the driver typed is
 *   the single most useful signal on this screen — it is what a driver using a
 *   friend's inbox looks like. Computing it in the client would mean each
 *   caller deciding how to compare two strings.
 */
drop function if exists public.admin_guarantor_summary(uuid);

create or replace function public.admin_guarantor_summary(p_application uuid)
returns table (
  verified boolean,
  nin_last4 text,
  consented_at timestamptz,
  full_name text,
  whatsapp_phone text,
  email text,
  invited_email text,
  email_matches_invite boolean,
  residential_address text,
  relationship text,
  known_duration text,
  employment_status text,
  company_name text,
  job_title text,
  declaration_text text,
  signature_name text,
  signed_at timestamptz,
  submitted_ip text,
  government_id_path text,
  live_photo_path text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    true,
    right(v.nin, 4),
    v.consented_at,
    v.full_name,
    v.whatsapp_phone,
    v.email,
    i.guarantor_email,
    lower(btrim(coalesce(v.email, ''))) = lower(btrim(coalesce(i.guarantor_email, ''))),
    v.residential_address,
    v.relationship,
    v.known_duration,
    v.employment_status,
    v.company_name,
    v.job_title,
    v.declaration_text,
    v.signature_name,
    v.signed_at,
    v.submitted_ip,
    (select d.path from public.guarantor_documents d
      where d.invitation_id = v.invitation_id and d.kind = 'government_id'),
    (select d.path from public.guarantor_documents d
      where d.invitation_id = v.invitation_id and d.kind = 'live_photo')
  from public.guarantor_verifications v
  join public.guarantor_invitations i on i.id = v.invitation_id
  where v.application_id = p_application
    and (select public.is_admin());
$$;

-- ----------------------------------------------------------------- grants --

/*
 * ⚠ `anon` is left with exactly one function, and it is read-only.
 *
 *   Before this migration `anon` could open an invitation *and* complete it.
 *   Completion now goes through `guarantor-portal`, which holds the service
 *   role, sees the real client address, and is the only thing that can write
 *   into this feature. The anonymous surface has got smaller while the feature
 *   got bigger, which is the only direction it should ever move.
 */
grant execute on function public.open_guarantor_invitation(text) to anon, authenticated;

revoke all on function public.complete_guarantor_verification(text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_guarantor_verification(text, jsonb, text, text)
  to service_role;

revoke all on function public.guarantor_document_slot(text, text) from public, anon, authenticated;
grant execute on function public.guarantor_document_slot(text, text) to service_role;

revoke all on function public.guarantor_document_recorded(text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.guarantor_document_recorded(text, text, text, text, integer)
  to service_role;

revoke all on function public.my_guarantor_status() from public, anon;
grant execute on function public.my_guarantor_status() to authenticated;

revoke all on function public.admin_guarantor_summary(uuid) from public, anon;
grant execute on function public.admin_guarantor_summary(uuid) to authenticated;
