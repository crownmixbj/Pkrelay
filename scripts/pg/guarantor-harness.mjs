/**
 * Runs the guarantor verification rules against a real Postgres.
 *
 * ⚠ This is the only endpoint in Package Relay an anonymous stranger may call.
 *
 *   Everything else is behind `auth.uid()`. The guarantor has no account and
 *   will not make one, so `open_guarantor_invitation` and
 *   `complete_guarantor_verification` are granted to `anon` — and what stands
 *   between an emailed URL and a table of national identifiers is entirely the
 *   token rules below. They cannot be asserted by reading SQL: expiry,
 *   single use, hashing and the attempt ceiling are all behaviour.
 *
 * ⚠ The other half is that nobody gets stranded.
 *
 *   A driver whose guarantor never answers has done everything asked and has
 *   no lever. That is the same failure as a verification gate with no way
 *   past it, and it is tested here as carefully as the security is.
 *
 * Usage: node scripts/pg/guarantor-harness.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) return;
  failures += 1;
  console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
};

async function run(label, fn) {
  try {
    await fn();
  } catch (error) {
    failures += 1;
    console.error(`FAIL — ${label}`);
    console.error(`       ${error.message}`);
  }
}

const db = await PGlite.create();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

console.log('\nrunning the guarantor rules against Postgres…\n');

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;

  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create table public.who (id uuid);

  create function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1;
  $fn$;

  create function public.is_admin() returns boolean language sql stable as $fn$
    select false;
  $fn$;

  /*
   * ⚠ Supabase's own default grants, which no migration performs.
   *
   *   The platform grants execute on public functions to anon and
   *   authenticated; the project's SQL only ever revokes. Without this the
   *   grant assertions below would pass on a database where nothing was ever
   *   granted, which proves nothing about the real one — and 51's revokes would
   *   land on nothing.
   */
  alter default privileges in schema public grant execute on functions
    to anon, authenticated, service_role;

  /*
   * Storage, in the shape 51 needs: a bucket row to upsert and a table to put
   * one policy on. Nothing here uploads — the bytes go to Storage from the
   * client over a signed URL, and the only thing the database knows about them
   * is the guarantor_documents row.
   */
  create schema storage;
  create table storage.buckets (
    id text primary key, name text, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text, name text,
    owner uuid, created_at timestamptz default now(), metadata jsonb
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $fn$
    select string_to_array(name, '/')
  $fn$;

  /*
   * The notification spine from 49, reduced to what 51 calls. Both
   * guarantor_pending and guarantor_completed have been permitted kinds
   * since 49 with nothing emitting them; 51 is what emits them, so the harness
   * has to be able to see that it did.
   */
  create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    kind text not null,
    subject_id text,
    title text not null,
    body text default '',
    metadata jsonb default '{}'::jsonb,
    push_requested boolean default true,
    created_at timestamptz not null default now(),
    unique (user_id, kind, subject_id)
  );

  create function public.queue_notification(
    p_user uuid, p_kind text, p_subject_id text, p_title text,
    p_body text default '', p_metadata jsonb default '{}'::jsonb,
    p_push boolean default true
  ) returns uuid language plpgsql as $fn$
  declare new_id uuid;
  begin
    if p_user is null or p_kind is null or btrim(coalesce(p_title, '')) = '' then
      return null;
    end if;
    insert into public.notifications
      (user_id, kind, subject_id, title, body, metadata, push_requested)
    values (p_user, p_kind, p_subject_id, btrim(p_title), coalesce(p_body, ''),
            coalesce(p_metadata, '{}'::jsonb), coalesce(p_push, true))
    on conflict (user_id, kind, subject_id) do nothing
    returning id into new_id;
    return new_id;
  end;
  $fn$;

  create table public.driver_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    reference text,
    full_name text,
    email text,
    guarantor_name text,
    guarantor_phone text,
    /* The columns kept but no longer written — see the migration. */
    guarantor_nin text,
    guarantor_address text,
    guarantor_relationship text,
    status text not null default 'pending',
    review_note text,
    submitted_at timestamptz not null default now()
  );

  create table public.email_outbox (
    id uuid primary key default gen_random_uuid(),
    kind text not null,
    subject_id text not null,
    recipient text not null,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    sent_at timestamptz,
    unique (kind, subject_id)
  );

  create function public.queue_email(p_kind text, p_subject_id text, p_recipient text, p_payload jsonb)
  returns void language plpgsql as $fn$
  begin
    if p_recipient is null or btrim(p_recipient) = '' then return; end if;
    insert into public.email_outbox (kind, subject_id, recipient, payload)
    values (p_kind, p_subject_id, btrim(p_recipient), coalesce(p_payload, '{}'::jsonb))
    on conflict (kind, subject_id) do nothing;
  end;
  $fn$;
`);

await db.exec(read('supabase/migrations/20250101000039_guarantor_verification.sql'));

/*
 * ⚠ 51 on top of 39, in order, because that is the only arrangement that is
 *   ever deployed.
 *
 *   51 drops and replaces four of 39's functions. Running it alone would leave
 *   `mint_guarantor_invitation` and the token rules undefined; running only 39
 *   would test a version of this feature that no longer exists.
 */
await db.exec(read('supabase/migrations/20250101000051_guarantor_full_form.sql'));

const DELE = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users (id) values ('${DELE}');`);
await db.exec(`insert into public.who (id) values ('${DELE}');`);

/**
 * A complete, valid submission — the shape every failure test starts from and
 * then breaks one field of.
 *
 * ⚠ Kept as one object rather than spelled out per test.
 *
 *   There are fourteen required fields. A test for "a short NIN is refused"
 *   that lists all of them is a test that fails for a reason nobody can find
 *   when a fifteenth is added, and it is how a suite comes to assert the wrong
 *   refusal while looking green.
 */
const GOOD = {
  nin: '12345678901',
  full_name: 'Bisi Olawale',
  whatsapp_phone: '+2348012345678',
  email: 'bisi@example.test',
  residential_address: '12 Allen Avenue, Ikeja, Lagos',
  relationship: 'Employer',
  known_duration: '3-5 years',
  employment_status: 'Employed',
  company_name: 'Zenith Bank',
  job_title: 'Branch Manager',
  signature_name: 'Bisi Olawale',
  consent_text:
    'I confirm that I agree to act as a guarantor for this driver on Package Relay, that the ' +
    'National Identification Number I have entered is my own, and that Package Relay may verify ' +
    'it with NIMC for this purpose.',
  /*
   * ⚠ Over 200 characters, because the function refuses anything shorter.
   *
   *   That floor exists so a client bug cannot store a row that looks complete
   *   and proves nothing about what a person accepted liability under. A short
   *   fixture here would test the floor rather than the feature.
   */
  declaration_text:
    'I agree to stand as guarantor for this driver. If Package Relay proves that this driver ' +
    'stole goods entrusted to them, deliberately kept or sold goods that were not theirs, or ' +
    'lost goods through gross negligence, I accept that I can be held jointly responsible with ' +
    'them for the value of those goods, up to the value declared for the parcel concerned.',
};

/**
 * Records both uploads for an invitation, the way `guarantor-portal` does.
 *
 * The bytes never reach the database — the client uploads them to Storage on a
 * signed URL and the edge function reports what landed. What is asserted here is
 * the half the database owns: the path it derives, and its refusal to accept one
 * it did not.
 */
const attach = async (token) => {
  for (const kind of ['government_id', 'live_photo']) {
    const [slot] = await q('select * from public.guarantor_document_slot($1,$2)', [token, kind]);
    if (!slot?.ok) return slot;
    await q('select * from public.guarantor_document_recorded($1,$2,$3,$4,$5)', [
      token,
      kind,
      slot.path,
      'image/jpeg',
      120000,
    ]);
  }
  return { ok: true };
};

/** Completes a verification, with `overrides` breaking one field at a time. */
const complete = async (token, overrides = {}, ip = null) => {
  const [row] = await q(
    'select * from public.complete_guarantor_verification($1,$2::jsonb,$3,$4)',
    [token, JSON.stringify({ ...GOOD, ...overrides }), ip, 'harness/1.0'],
  );
  return row;
};

/*
 * `attach` by default: both photographs are required, and a test about a NIN
 * should not be quietly passing on a missing-file refusal instead. The one test
 * that is about the files passes `{ attach: false }`.
 */
const submit = async (email = 'bisi@example.test', { attach: withFiles = true } = {}) => {
  const [app] = await q(
    `insert into public.driver_applications
       (user_id, reference, full_name, email, guarantor_name, guarantor_phone, guarantor_email)
     values ($1, 'LOCI-G', 'Tunde A', 'tunde@example.test', 'Bisi O', '+2348012345678', $2)
     returning id, status`,
    [DELE, email],
  );
  const [mail] = await q(
    `select * from public.email_outbox where kind = 'guarantor_invitation'
      and subject_id = $1`,
    [app.id],
  );
  const token = mail?.payload?.token ?? null;
  if (withFiles && token) await attach(token);
  return { app, token, mail };
};

/* ======================== 1. submission invites ========================= */

await run('submitting an application invites the guarantor', async () => {
  const { app, mail, token } = await submit();

  check(
    'the application waits on the guarantor',
    app.status === 'pending_guarantor',
    `status was ${app.status} — an application that skips straight to review skips the guarantor`,
  );
  check('an invitation email is queued', Boolean(mail));
  check('addressed to the guarantor', mail?.recipient === 'bisi@example.test');
  check('naming the driver', mail?.payload?.driver_name === 'Tunde A');
  check('with a token', typeof token === 'string' && token.length >= 32);

  /*
   * ⚠ The digest is stored, never the token.
   *
   *   A leaked backup must not be a set of working links. This is the same
   *   reason a password column holds a hash.
   */
  const [row] = await q(
    'select token_hash from public.guarantor_invitations where application_id = $1',
    [app.id],
  );
  check(
    'the table holds a digest, not the token',
    row?.token_hash && row.token_hash !== token,
    'a token stored in plaintext is a live link in every backup',
  );
});

await run('an application with no guarantor email is not left waiting on one', async () => {
  const [app] = await q(
    `insert into public.driver_applications
       (user_id, reference, full_name, guarantor_name, guarantor_phone)
     values ($1, 'LOCI-NOEMAIL', 'No Guarantor', 'Someone', '+2348000000000')
     returning id, status`,
    [DELE],
  );
  /*
   * ⚠ Not `pending_guarantor`, because no guarantor can ever be invited.
   *
   *   Setting it anyway would create an application that can never leave that
   *   state — waiting forever on an email that was never sendable.
   */
  check(
    'it stays in the ordinary queue',
    app.status !== 'pending_guarantor',
    'an application waiting on an invitation that was never sent cannot ever move',
  );
});

/* ======================== 2. the token rules ============================ */

await run('a wrong token reveals nothing', async () => {
  const [answer] = await q('select * from public.open_guarantor_invitation($1)', ['nonsense']);
  check('refused', answer.valid === false);
  /*
   * ⚠ "invalid" for a token that does not exist *and* for one past its
   *   ceiling, so probing cannot distinguish a real invitation from a miss.
   */
  check('and says only that it is invalid', answer.reason === 'invalid');
  check('leaking no driver name', answer.driver_name === null);
});

await run('a valid token opens, and shows the minimum', async () => {
  const { token } = await submit('ada@example.test');
  const [answer] = await q('select * from public.open_guarantor_invitation($1)', [token]);

  check('it opens', answer.valid === true, `reason: ${answer.reason}`);
  check('naming the driver, which is what consent is about', answer.driver_name === 'Tunde A');
  check('and greeting the guarantor', answer.guarantor_name === 'Bisi O');
  /*
   * Whoever holds this link may not be the guarantor — email is forwarded and
   * addresses are mistyped. Nothing else about the driver travels.
   */
  /*
   * ⚠ The exact set, so a column added to this function has to be argued for
   *   here before the suite goes green.
   *
   *   51 added two: the application reference, so a guarantor telephoning about
   *   this can quote something, and the address the invitation was sent to,
   *   which whoever is reading the page already has. Still absent: the driver's
   *   phone, address, NIN, vehicle and city.
   */
  check(
    'and nothing else',
    Object.keys(answer).sort().join(',') ===
      ['valid', 'reason', 'driver_name', 'guarantor_name', 'guarantor_email', 'reference', 'expires_at']
        .sort()
        .join(','),
    'a phone number or an address here would leak to whoever opened the email',
  );
  check(
    'the reference travels, because a guarantor may telephone about it',
    answer.reference === 'LOCI-G',
  );
  check(
    'and the address it was sent to, which they already have',
    answer.guarantor_email === 'ada@example.test',
  );
});

await run('completing it moves the driver on, once', async () => {
  const { app, token } = await submit('ngozi@example.test');

  const done = await complete(token, {}, '10.0.0.1');
  check('it completes', done.ok === true, `reason: ${done.reason}`);

  const [row] = await q('select status from public.driver_applications where id = $1', [app.id]);
  check(
    'and the application is ready for review',
    row?.status === 'ready_for_review',
    `status was ${row?.status}`,
  );

  /*
   * ⚠ Single use. A forwarded email is spent the moment it is used once.
   */
  const again = await complete(token, { nin: '99999999999' });
  check('a second use is refused', again.ok === false && again.reason === 'completed');

  const rows = await q(
    'select nin from public.guarantor_verifications where application_id = $1',
    [app.id],
  );
  check('one verification recorded', rows.length === 1, `${rows.length} rows`);
  check('holding the first NIN, not the second', rows[0]?.nin === '12345678901');
});

await run('an expired token is refused, and says so', async () => {
  const { token } = await submit('lapsed@example.test');
  await q(`update public.guarantor_invitations set expires_at = now() - interval '1 day'`);

  const [opened] = await q('select * from public.open_guarantor_invitation($1)', [token]);
  check('opening says expired', opened.valid === false && opened.reason === 'expired');

  const done = await complete(token);
  /*
   * ⚠ Re-checked on submit, not only on open.
   *
   *   A page left open past the expiry, or reopened from history, would
   *   otherwise post successfully. The portal's view of validity is a render,
   *   not an authority.
   */
  check(
    'and so does completing',
    done.ok === false && done.reason === 'expired',
    'a tab left open overnight must not be able to submit',
  );
});

await run('consent and a real NIN are both required', async () => {
  const { token } = await submit('checks@example.test');

  const badNin = await complete(token, { nin: '123' });
  check('a short NIN is refused', badNin.ok === false && badNin.reason === 'bad-nin');

  /*
   * ⚠ "They agreed" is not a record of anything.
   *
   *   What they agreed to is the part that has to survive a dispute, so an
   *   empty consent string is a failure rather than a default.
   */
  const noConsent = await complete(token, { consent_text: '   ' });
  check('and so is empty consent', noConsent.ok === false && noConsent.reason === 'no-consent');

  /* Neither failure spent the token. */
  const [opened] = await q('select * from public.open_guarantor_invitation($1)', [token]);
  check(
    'a rejected attempt does not burn the invitation',
    opened.valid === true,
    'a guarantor who mistypes their NIN once must not be locked out',
  );
});

await run('repeated probing stops working', async () => {
  const { token } = await submit('probe@example.test');

  for (let i = 0; i < 12; i += 1) {
    await q('select * from public.open_guarantor_invitation($1)', [token]);
  }

  const [answer] = await q('select * from public.open_guarantor_invitation($1)', [token]);
  check(
    'past the ceiling it is treated as invalid',
    answer.valid === false,
    'an anonymous endpoint answering all day is one worth pointing a script at',
  );
});

/* ======================== 3. nobody is stranded ========================= */

await run('a driver whose guarantor never answers can re-invite', async () => {
  const { app, token: first } = await submit('typo@exmaple.test');

  await q(`update public.guarantor_invitations set expires_at = now() - interval '1 day'
            where application_id = $1`, [app.id]);

  const [status] = await q('select * from public.my_guarantor_status()');
  check('the driver can see it lapsed', status?.state === 'expired', `state: ${status?.state}`);

  /* The commonest cause is a mistyped address, so it can be corrected. */
  const [again] = await q('select * from public.reinvite_guarantor($1)', ['bisi@example.test']);
  check('re-inviting works', again.ok === true, `reason: ${again.reason}`);

  const mails = await q(
    `select * from public.email_outbox where kind = 'guarantor_invitation'
       and recipient = 'bisi@example.test' order by created_at desc`,
  );
  check('a new email goes to the corrected address', mails.length >= 1);

  const fresh = mails[0]?.payload?.token;
  check('with a new token', typeof fresh === 'string' && fresh !== first);

  /*
   * ⚠ The old link is dead, including the one sent to the wrong address.
   *
   *   Otherwise correcting a typo leaves a stranger holding a working link to
   *   a form that asks for a national identifier.
   */
  const [old] = await q('select * from public.open_guarantor_invitation($1)', [first]);
  check(
    'and the old one no longer opens',
    old.valid === false,
    'a mistyped address must not leave a stranger with a live link',
  );
});

/*
 * ⚠ Re-inviting while the old link is still live, which is the dangerous case.
 *
 *   My first version of the re-invite test expired the old invitation first, so
 *   the assertion that it "no longer opens" passed on expiry alone — removing
 *   the retire step from `mint_guarantor_invitation` left the suite green.
 *
 *   The case that matters is a driver who notices the typo straight away: the
 *   old link is live, and it is in a stranger's inbox. Correcting the address
 *   has to kill it.
 */
await run('re-inviting kills a link that is still live', async () => {
  const { token: wrong } = await submit('stranger@example.test');

  const [before] = await q('select * from public.open_guarantor_invitation($1)', [wrong]);
  check('the mistyped link starts out working', before.valid === true);

  const [again] = await q('select * from public.reinvite_guarantor($1)', ['right@example.test']);
  check('the correction is accepted', again.ok === true, `reason: ${again.reason}`);

  const [after] = await q('select * from public.open_guarantor_invitation($1)', [wrong]);
  check(
    'and the stranger’s link stops working immediately',
    after.valid === false,
    'a mistyped address would otherwise leave somebody else holding a live form asking for a NIN',
  );

  const fresh = await q(
    `select * from public.email_outbox where kind = 'guarantor_invitation'
       and recipient = 'right@example.test'`,
  );
  check('and the new one was sent to the corrected address', fresh.length === 1);
});

await run('a driver sees whether their guarantor has finished, and nothing more', async () => {
  const columns = await q(`
    select column_name from information_schema.columns
     where table_name = 'guarantor_invitations'
  `);
  check(
    'the invitation table holds a token hash',
    columns.some((c) => c.column_name === 'token_hash'),
  );

  const [status] = await q('select * from public.my_guarantor_status()');
  /*
   * ⚠ A driver who could read the token could complete their own guarantor
   *   check, which is the entire fraud this feature prevents.
   */
  check(
    'the driver-facing view exposes no token',
    status !== undefined && !('token' in status) && !('token_hash' in status),
    'a driver holding the link is a driver guaranteeing themselves',
  );
});

await run('a late guarantor cannot drag a decided application back', async () => {
  const { app, token } = await submit('late@example.test');
  await q(`update public.driver_applications set status = 'rejected' where id = $1`, [app.id]);

  await complete(token);

  const [row] = await q('select status from public.driver_applications where id = $1', [app.id]);
  check(
    'a rejected application stays rejected',
    row?.status === 'rejected',
    'an admin decision must not be undone by a guarantor answering a week late',
  );
});

/* ================= 4. the fuller form, added by 51 ===================== */

/*
 * ⚠ One field broken at a time, from a submission that is otherwise valid.
 *
 *   The alternative — a test per field that builds its own payload — is how a
 *   suite comes to assert "refused" while the refusal is coming from a different
 *   field entirely. Every row here differs from a working submission in exactly
 *   one respect, so the reason returned is the reason under test.
 */
await run('every required field is required, and says which', async () => {
  const cases = [
    ['one name is not a name', { full_name: 'Bisi' }, 'bad-name'],
    ['a phone number has to be one', { whatsapp_phone: '0801' }, 'bad-phone'],
    ['an email has to be one', { email: 'bisi@' }, 'bad-email'],
    ['"Lagos" is not an address', { residential_address: 'Lagos' }, 'bad-address'],
    ['how they know them', { relationship: '' }, 'bad-relationship'],
    ['how long they have known them', { known_duration: '' }, 'bad-duration'],
    ['what they do', { employment_status: '' }, 'bad-employment'],
    ['and who they do it for', { company_name: '' }, 'bad-employer'],
    ['a job title with it', { job_title: '  ' }, 'bad-employer'],
    ['the declaration is not optional', { declaration_text: '' }, 'no-declaration'],
  ];

  for (const [label, override, reason] of cases) {
    const { token } = await submit(`field-${reason}-${label.length}@example.test`);
    const answer = await complete(token, override);
    check(`${label} — refused as ${reason}`, answer.ok === false && answer.reason === reason,
      `got ${answer.reason}`);
  }
});

/*
 * ⚠ A short clause is refused, which is not the same rule as an empty one.
 *
 *   `declaration_text` is the only evidence of what a person accepted liability
 *   under. A client bug posting 'true', or an empty template rendering to one
 *   line, would store a row that looks complete and proves nothing — and would
 *   still look complete a year later, to somebody who no longer has the page.
 */
await run('a declaration too short to be one is refused', async () => {
  const { token } = await submit('shortclause@example.test');
  const answer = await complete(token, { declaration_text: 'I agree.' });
  check(
    'a one-line declaration is not a declaration',
    answer.ok === false && answer.reason === 'no-declaration',
    'a row that looks signed and carries no wording is worse than no row',
  );
});

/*
 * ⚠ An employer is asked of people who have one, and not of people who do not.
 *
 *   Requiring a company name of everybody makes a retired guarantor type
 *   something untrue into a form that is about to ask them to sign it.
 */
await run('a retired guarantor is not asked who employs them', async () => {
  const { token } = await submit('retired@example.test');
  const answer = await complete(token, {
    employment_status: 'Retired',
    company_name: '',
    job_title: '',
  });
  check('it completes without an employer', answer.ok === true, `reason: ${answer.reason}`);
});

/*
 * ⚠ The signature has to be the name they just gave.
 *
 *   A typed name is worth something only as an act of adoption: this person,
 *   having read that, wrote their own name under it. Accepting any string makes
 *   the field decorative; accepting "yes" makes it misleading.
 */
await run('the signature has to be the name above it', async () => {
  const { token } = await submit('signature@example.test');

  const wrong = await complete(token, { signature_name: 'B. Olawale' });
  check(
    'a different name is refused',
    wrong.ok === false && wrong.reason === 'signature-mismatch',
    'a signature that need not match the name is not a signature',
  );

  /* Spacing and capitals are forgiven, because people type their own names badly. */
  const messy = await complete(token, { signature_name: '  bisi   OLAWALE ' });
  check('the same name typed untidily is accepted', messy.ok === true, `reason: ${messy.reason}`);
});

/* ------------------------------------------------------- the two photos -- */

await run('a submission with no files attached is refused', async () => {
  const { token } = await submit('nofiles@example.test', { attach: false });

  const answer = await complete(token);
  check(
    'both photographs are required',
    answer.ok === false && answer.reason === 'missing-documents',
    'counting the rows is the only way to know an upload happened',
  );

  /* One of the two is not both. */
  const [slot] = await q('select * from public.guarantor_document_slot($1,$2)', [
    token,
    'government_id',
  ]);
  await q('select * from public.guarantor_document_recorded($1,$2,$3,$4,$5)', [
    token, 'government_id', slot.path, 'image/jpeg', 90000,
  ]);

  const half = await complete(token);
  check(
    'an ID without a live photo is still refused',
    half.ok === false && half.reason === 'missing-documents',
  );
});

await run('the database decides where a file goes', async () => {
  const { app, token } = await submit('paths@example.test', { attach: false });

  const [invite] = await q(
    'select id from public.guarantor_invitations where application_id = $1',
    [app.id],
  );
  const [slot] = await q('select * from public.guarantor_document_slot($1,$2)', [
    token,
    'live_photo',
  ]);

  check('it answers with a path under the invitation', slot.path === `${invite.id}/live_photo`);
  /*
   * ⚠ No file extension, on purpose.
   *
   *   A retake is normal, and one address for one thing means the second attempt
   *   overwrites the first rather than orphaning a JPEG in a bucket nothing can
   *   garbage-collect.
   */
  check('and no extension', !slot.path.includes('.'));

  /*
   * ⚠ A path the caller invented is refused.
   *
   *   Otherwise a caller could report a path belonging to a different invitation
   *   and attach somebody else's ID to this application.
   */
  const [bad] = await q('select * from public.guarantor_document_recorded($1,$2,$3,$4,$5)', [
    token, 'live_photo', 'somebody-elses-invitation/live_photo', 'image/jpeg', 90000,
  ]);
  check(
    'a path from somewhere else is refused',
    bad.ok === false && bad.reason === 'bad-path',
    'a caller that can name the path can attach a stranger’s ID to this application',
  );

  const [unknown] = await q('select * from public.guarantor_document_slot($1,$2)', [
    token,
    'passport_scan',
  ]);
  check('an unknown kind is refused', unknown.ok === false && unknown.reason === 'bad-kind');
});

await run('a retake replaces rather than accumulates', async () => {
  const { app, token } = await submit('retake@example.test', { attach: false });

  for (const bytes of [90000, 110000]) {
    const [slot] = await q('select * from public.guarantor_document_slot($1,$2)', [
      token, 'live_photo',
    ]);
    await q('select * from public.guarantor_document_recorded($1,$2,$3,$4,$5)', [
      token, 'live_photo', slot.path, 'image/jpeg', bytes,
    ]);
  }

  const [invite] = await q(
    'select id from public.guarantor_invitations where application_id = $1',
    [app.id],
  );
  const rows = await q(
    `select * from public.guarantor_documents where invitation_id = $1 and kind = 'live_photo'`,
    [invite.id],
  );
  check('one row, not two', rows.length === 1, `${rows.length} rows`);
  check('holding the second attempt', rows[0]?.bytes === 110000);
});

await run('a spent link cannot be used to upload more files', async () => {
  const { token } = await submit('spent@example.test');
  const done = await complete(token);
  check('it completes', done.ok === true, `reason: ${done.reason}`);

  const [slot] = await q('select * from public.guarantor_document_slot($1,$2)', [
    token, 'live_photo',
  ]);
  check(
    'and the bucket is closed to it',
    slot.ok === false && slot.reason === 'completed',
    'a completed invitation that still accepts uploads is an open door with a sign on it',
  );
});

/* -------------------------------------------- what is actually recorded -- */

await run('the row holds what was typed, and the wording they agreed to', async () => {
  const { app, token } = await submit('recorded@example.test');
  await complete(token, {}, '102.89.3.4');

  const [row] = await q(
    'select * from public.guarantor_verifications where application_id = $1',
    [app.id],
  );

  check('their own name', row?.full_name === 'Bisi Olawale');
  check('their WhatsApp number', row?.whatsapp_phone === '+2348012345678');
  check('their address', row?.residential_address === '12 Allen Avenue, Ikeja, Lagos');
  check('how they know the driver', row?.relationship === 'Employer');
  check('for how long', row?.known_duration === '3-5 years');
  check('what they do', row?.employment_status === 'Employed');
  check('and who for', row?.company_name === 'Zenith Bank' && row?.job_title === 'Branch Manager');

  /*
   * ⚠ The wording, not a flag.
   *
   *   "They ticked a box" is not a record of anything. What survives has to be
   *   the sentence that was on screen, which is why the client sends it and this
   *   column stores it.
   */
  check(
    'the declaration wording is on the row',
    typeof row?.declaration_text === 'string' && row.declaration_text.length > 200,
  );
  check('with the moment it was accepted', row?.declared_at !== null);
  check('the signature, and its timestamp', row?.signature_name === 'Bisi Olawale' && row?.signed_at !== null);

  /*
   * ⚠ The address is the server's, not the client's.
   *
   *   39 left `submitted_ip` for a server-side caller to fill and nothing filled
   *   it, because the only caller was the browser. It is the edge function's now,
   *   which is the whole reason the write moved behind one.
   */
  check('and the address the server saw', row?.submitted_ip === '102.89.3.4');
  check('and the user agent it reported', row?.user_agent === 'harness/1.0');

  /* The email they gave is kept next to the one the driver typed. */
  check('their own email', row?.email === 'bisi@example.test');
});

/* --------------------------------------------------- the driver's card --- */

await run('the driver can see when the invitation went out', async () => {
  const { app } = await submit('tracking@example.test');

  const [status] = await q('select * from public.my_guarantor_status()');

  check('it is waiting', status?.state === 'waiting', `state: ${status?.state}`);
  check('on a named address', status?.guarantor_email === 'tracking@example.test');
  check('and it says when the link was made', status?.invited_at !== null);
  /*
   * ⚠ Null while the outbox row is unsent, and that is the point of the column.
   *
   *   "Invitation created" and "email dispatched" are different facts. Showing
   *   the first as though it were the second is how a driver comes to believe an
   *   email went out an hour ago when nothing has left the building — and then
   *   blames their guarantor for the silence.
   */
  check(
    'but not that it was sent, because it has not been',
    status?.email_sent_at === null,
    'an unsent email presented as sent is a driver blaming the wrong person',
  );

  await q(
    `update public.email_outbox set sent_at = now()
      where kind = 'guarantor_invitation' and recipient = 'tracking@example.test'`,
  );
  const [sent] = await q('select * from public.my_guarantor_status()');
  check('once the provider takes it, the card says so', sent?.email_sent_at !== null);

  /* And a re-invitation is counted, so a third attempt does not look like a first. */
  await q('select * from public.reinvite_guarantor($1)', ['tracking2@example.test']);
  const [after] = await q('select * from public.my_guarantor_status()');
  check('invitations are counted', after?.invitations >= 2, `count: ${after?.invitations}`);
  check('and the card follows the newest one', after?.guarantor_email === 'tracking2@example.test');

  check(
    'still no token anywhere near the driver',
    !('token' in (after ?? {})) && !('token_hash' in (after ?? {})),
  );

  /* Quiet the application so later status assertions are not reading this one. */
  await q(`update public.driver_applications set status = 'approved' where id = $1`, [app.id]);
});

/* ------------------------------------------------------ the notifications -- */

await run('both sides of the wait are announced', async () => {
  const { app, token } = await submit('notified@example.test');

  const pending = await q(
    `select * from public.notifications where kind = 'guarantor_pending' and subject_id = $1`,
    [app.id],
  );
  check(
    'submitting tells the driver where the link went',
    pending.length === 1,
    'a driver who is never told the address cannot notice they mistyped it',
  );
  check(
    'naming the address, which is the thing they can fix',
    String(pending[0]?.body ?? '').includes('notified@example.test'),
  );

  await complete(token);

  const completed = await q(
    `select * from public.notifications where kind = 'guarantor_completed'`,
  );
  check(
    'and finishing tells them it is done',
    completed.length >= 1,
    'guarantor_completed has been a permitted kind since 49 with nothing emitting it',
  );
});

/* ------------------------------------------------------------- the grants -- */

/*
 * ⚠ The security claim of this feature, asserted rather than described.
 *
 *   Before 51, `anon` could open an invitation *and* complete it. Completion now
 *   goes through `guarantor-portal`, which holds the service role — so the
 *   anonymous surface is one read-only function. If a later migration grants
 *   `anon` the write back, this is the line that fails.
 */
await run('an anonymous stranger may read one function and write nothing', async () => {
  const may = async (role, signature) => {
    const [row] = await q('select has_function_privilege($1, $2, $3) as ok', [
      role,
      signature,
      'execute',
    ]);
    return row.ok;
  };

  check(
    'anon may open an invitation',
    await may('anon', 'public.open_guarantor_invitation(text)'),
    'the guarantor has no account and will not make one',
  );
  check(
    'anon may not complete one',
    !(await may('anon', 'public.complete_guarantor_verification(text,jsonb,text,text)')),
    'an anonymous write is a token spent directly against the database',
  );
  check(
    'anon may not ask where a file goes',
    !(await may('anon', 'public.guarantor_document_slot(text,text)')),
  );
  check(
    'anon may not record one',
    !(await may('anon', 'public.guarantor_document_recorded(text,text,text,text,integer)')),
  );
  check(
    'the service role may, because the edge function is it',
    await may('service_role', 'public.complete_guarantor_verification(text,jsonb,text,text)'),
  );
  check(
    'a signed-in driver cannot complete a guarantor check either',
    !(await may('authenticated', 'public.complete_guarantor_verification(text,jsonb,text,text)')),
    'a driver holding this call is a driver guaranteeing themselves',
  );
  check(
    'and nobody anonymous can mint a link',
    !(await may('anon', 'public.mint_guarantor_invitation(uuid)')),
  );
});

/* ------------------------------------------------------- the admin's view -- */

await run('an admin sees the record, and four digits of the NIN', async () => {
  const { app, token } = await submit('adminview@example.test');
  await complete(token, { email: 'different@example.test' });

  /* The stub says nobody is an admin; this makes the harness one. */
  await db.exec(`
    alter table public.who add column if not exists admin boolean default false;
    create or replace function public.is_admin() returns boolean language sql stable as $fn$
      select coalesce((select admin from public.who limit 1), false);
    $fn$;
    update public.who set admin = true;
  `);

  const [row] = await q('select * from public.admin_guarantor_summary($1)', [app.id]);

  check('the record is there', row?.verified === true);
  /*
   * ⚠ Four digits, not eleven. A review queue is a screen somebody leaves open;
   *   it should not be a list of national identifiers.
   */
  check('with four digits of the NIN', row?.nin_last4 === '8901');
  check('and no more than four', !Object.values(row ?? {}).includes('12345678901'));
  check('the declaration that was signed', String(row?.declaration_text ?? '').length > 200);
  check('and the paths to both photographs',
    String(row?.government_id_path ?? '').endsWith('/government_id') &&
      String(row?.live_photo_path ?? '').endsWith('/live_photo'));
  /*
   * ⚠ The mismatch is computed for the reviewer, not left to them.
   *
   *   A guarantor giving a different address from the one the driver typed is the
   *   single most useful signal on this screen — it is what a driver using a
   *   friend's inbox looks like.
   */
  check(
    'and it flags that they gave a different address',
    row?.email_matches_invite === false,
    'a driver using somebody else’s inbox is exactly what this catches',
  );

  await db.exec(`update public.who set admin = false;`);
  const none = await q('select * from public.admin_guarantor_summary($1)', [app.id]);
  check('and it answers nothing to somebody who is not an admin', none.length === 0);
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — submitting invites the guarantor and holds the application, the token is stored\n' +
    '       as a digest, opens once, expires, survives a mistyped NIN but not a second use,\n' +
    '       reveals nothing but the driver’s name, and a driver whose guarantor never\n' +
    '       answers can re-invite — killing the old link as they do. Every field of the\n' +
    '       fuller form is required and says which, the signature has to be the name above\n' +
    '       it, both photographs have to exist before anything is accepted, the database\n' +
    '       decides where they go, the driver is told when the link went out and when the\n' +
    '       email actually left — and the whole anonymous surface is one read-only call.',
);
