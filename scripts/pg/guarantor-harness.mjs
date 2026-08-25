/**
 * Runs the guarantor verification rules against a real Postgres.
 *
 * ⚠ This is the only endpoint in LOCI an anonymous stranger may call.
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

await db.exec(read('supabase/39_guarantor_verification.sql'));

const DELE = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users (id) values ('${DELE}');`);
await db.exec(`insert into public.who (id) values ('${DELE}');`);

const submit = async (email = 'bisi@example.test') => {
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
  return { app, token: mail?.payload?.token ?? null, mail };
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
  check(
    'and nothing else',
    Object.keys(answer).sort().join(',') ===
      ['valid', 'reason', 'driver_name', 'guarantor_name', 'expires_at'].sort().join(','),
    'a phone number or an address here would leak to whoever opened the email',
  );
});

await run('completing it moves the driver on, once', async () => {
  const { app, token } = await submit('ngozi@example.test');

  const [done] = await q('select * from public.complete_guarantor_verification($1,$2,$3,$4)', [
    token,
    '12345678901',
    'I agree to stand as guarantor for this driver.',
    '10.0.0.1',
  ]);
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
  const [again] = await q('select * from public.complete_guarantor_verification($1,$2,$3,$4)', [
    token,
    '99999999999',
    'I agree.',
    null,
  ]);
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

  const [done] = await q('select * from public.complete_guarantor_verification($1,$2,$3,$4)', [
    token,
    '12345678901',
    'I agree.',
    null,
  ]);
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

  const [badNin] = await q('select * from public.complete_guarantor_verification($1,$2,$3,$4)', [
    token,
    '123',
    'I agree.',
    null,
  ]);
  check('a short NIN is refused', badNin.ok === false && badNin.reason === 'bad-nin');

  /*
   * ⚠ "They agreed" is not a record of anything.
   *
   *   What they agreed to is the part that has to survive a dispute, so an
   *   empty consent string is a failure rather than a default.
   */
  const [noConsent] = await q(
    'select * from public.complete_guarantor_verification($1,$2,$3,$4)',
    [token, '12345678901', '   ', null],
  );
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

  await q('select * from public.complete_guarantor_verification($1,$2,$3,$4)', [
    token,
    '12345678901',
    'I agree.',
    null,
  ]);

  const [row] = await q('select status from public.driver_applications where id = $1', [app.id]);
  check(
    'a rejected application stays rejected',
    row?.status === 'rejected',
    'an admin decision must not be undone by a guarantor answering a week late',
  );
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
    '       answers can re-invite — killing the old link as they do.',
);
