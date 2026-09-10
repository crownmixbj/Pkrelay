/**
 * Runs the driver-application insert and the admin decision against a real Postgres,
 * *as a non-owner role*, so row-level security is actually in force.
 *
 * ⚠ This exists because the guarantor harness proved the wrong half.
 *
 *   `guarantor-harness.mjs` inserts as the database owner, which skips RLS
 *   entirely. It therefore proved that 39's BEFORE INSERT trigger writes
 *   `pending_guarantor` — and could not see that 02's insert policy still said
 *   `with check (... status = 'pending' ...)`.
 *
 *   Postgres applies a policy's WITH CHECK to the row *after* BEFORE ROW
 *   triggers have modified it. So the two files, each correct alone, refused
 *   every driver application that named a guarantor. Not a bad row to find
 *   later — no row at all, and a green harness.
 *
 *   Everything below runs under `set role authenticated`. If a future migration
 *   makes an insert impossible again, that is a failure here rather than a
 *   support ticket.
 *
 * ⚠ And the decision itself is a server rule, not a hidden button.
 *
 *   An admin must not approve a driver whose guarantor never answered, and a
 *   rejection must say why. The screen enforces both, but a screen is a
 *   courtesy: the SQL editor, a script and a future component all bypass it.
 *
 * Usage: node scripts/pg/review-controls-harness.mjs
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

/**
 * ⚠ The statements are cut out of the shipped migrations, not retyped here.
 *
 *   A paraphrase of a policy is a second copy of it, and the whole failure this
 *   file exists for was two copies of one rule drifting apart. If the extraction
 *   finds nothing the harness fails rather than quietly testing an empty string.
 */
function extract(label, sql, pattern) {
  const found = sql.match(pattern);
  if (!found) {
    console.error(`FAIL — could not find ${label} in the migration`);
    process.exit(1);
  }
  return found.join('\n');
}

const m02 = read('supabase/migrations/20250101000002_driver_applications.sql');
const m39 = read('supabase/migrations/20250101000039_guarantor_verification.sql');
const m40 = read('supabase/migrations/20250101000040_review_controls.sql');

const insertPolicy02 = extract(
  "02's insert policy",
  m02,
  /create policy "applicant submits own"[\s\S]*?;\n/,
);
const statusFn39 = extract(
  "39's status default",
  m39,
  /create or replace function public\.default_application_status\(\)[\s\S]*?\$\$;\n/,
);
const statusTrigger39 = extract(
  "39's status trigger",
  m39,
  /create trigger on_application_status_default[\s\S]*?;\n/,
);
const statusFn40 = extract(
  "40's status default",
  m40,
  /create or replace function public\.default_application_status\(\)[\s\S]*?\$\$;\n/,
);
const insertPolicy40 = extract(
  "40's insert policy",
  m40,
  /drop policy if exists "applicant submits own"[\s\S]*?;\n\s*create policy "applicant submits own"[\s\S]*?\);\n/,
);
const decisionGuard40 = extract(
  "40's decision guard",
  m40,
  /create or replace function public\.guard_application_decision\(\)[\s\S]*?\$\$;\n/,
);
const triggers = [
  extract(
    'the status trigger',
    m40,
    /drop trigger if exists on_application_status_default[\s\S]*?create trigger on_application_status_default[\s\S]*?;\n/,
  ),
  extract(
    'the decision trigger',
    m40,
    /drop trigger if exists on_application_decision_guard[\s\S]*?create trigger on_application_decision_guard[\s\S]*?;\n/,
  ),
].join('\n');

const db = await PGlite.create();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

console.log('\nrunning the review controls against Postgres, under RLS…\n');

const APPLICANT = '11111111-1111-1111-1111-111111111111';
const ADMIN = '33333333-3333-3333-3333-333333333333';

await db.exec(`
  create role authenticated;

  create schema auth;
  create table public.who (id uuid);
  create function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1;
  $fn$;

  create table public.admins (id uuid primary key);
  create function public.is_admin() returns boolean language sql stable as $fn$
    select exists (select 1 from public.admins where id = auth.uid());
  $fn$;

  create table public.driver_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    reference text,
    full_name text,
    email text,
    guarantor_name text,
    guarantor_phone text,
    guarantor_email text,
    status text not null default 'pending',
    review_note text,
    reviewed_by uuid,
    reviewed_at timestamptz,
    submitted_at timestamptz not null default now()
  );

  alter table public.driver_applications enable row level security;

  create policy "applicant or admin reads"
    on public.driver_applications for select
    to authenticated
    using (user_id = (select auth.uid()) or public.is_admin());

  create policy "admin reviews"
    on public.driver_applications for update
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());

  grant usage on schema public, auth to authenticated;
  grant select, insert, update on public.driver_applications to authenticated;
  grant select on public.who, public.admins to authenticated;

  insert into public.admins (id) values ('${ADMIN}');
`);

/* The state of the world before 40: 02's policy, 39's function *and its trigger*. */
await db.exec(insertPolicy02);
await db.exec(statusFn39);
await db.exec(statusTrigger39);

const asApplicant = async () => {
  await db.exec(`reset role; delete from public.who; insert into public.who values ('${APPLICANT}');
                 set role authenticated;`);
};
const asAdmin = async () => {
  await db.exec(`reset role; delete from public.who; insert into public.who values ('${ADMIN}');
                 set role authenticated;`);
};
const asOwner = () => db.exec('reset role;');

const submit = async (guarantorEmail) =>
  q(
    `insert into public.driver_applications
       (user_id, reference, full_name, email, guarantor_name, guarantor_phone, guarantor_email)
     values ($1, 'LOCI-R', 'Tunde A', 'tunde@example.test', 'Bisi O', '+2348012345678', $2)
     returning id, status`,
    [APPLICANT, guarantorEmail],
  );

const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

/* ============ 1. the collision 40 exists to resolve is a real one ========= */

/*
 * ⚠ Asserted as a failure *before* the fix, not merely as success after it.
 *
 *   A harness that only ran the fixed world would pass just as happily if 40
 *   were deleted and 02's policy had never been wrong — which would leave the
 *   next person free to reintroduce it. Pinning the collision is what makes the
 *   rest of this file mean something.
 */
await run('the pre-40 combination refuses the insert', async () => {
  await asApplicant();
  const message = await refusal(() => submit('bisi@example.test'));

  check(
    "02's policy rejects the status 39's trigger writes",
    message !== null && /row-level security/i.test(message ?? ''),
    message === null
      ? 'the insert succeeded, so the two files no longer disagree and 40 may be redundant'
      : message,
  );
});

/* Now apply 40, in the order a deployment would. */
await asOwner();
await db.exec(statusFn40);
await db.exec(insertPolicy40);
await db.exec(decisionGuard40);
await db.exec(triggers);

/* ===================== 2. an applicant can apply again =================== */

let withGuarantor;
let withoutGuarantor;

await run('a driver naming a guarantor can submit', async () => {
  await asApplicant();
  const [row] = await submit('bisi@example.test');
  withGuarantor = row;

  check('the insert is allowed', Boolean(row?.id), 'this is the bug, and it blocks every signup');
  check(
    'and the application waits on the guarantor',
    row?.status === 'pending_guarantor',
    `status was ${row?.status} — going straight to the queue would skip the vouching entirely`,
  );
});

await run('a driver naming nobody still lands in the queue', async () => {
  await asApplicant();
  const [row] = await submit(null);
  withoutGuarantor = row;

  check(
    'the insert is allowed',
    Boolean(row?.id),
    'the guarantor branch must not be the only one that works',
  );
  check(
    'and it is an admin’s to pick up',
    row?.status === 'pending',
    `status was ${row?.status} — parking it on a guarantor who was never named strands it forever`,
  );
});

/* ===================== 3. nobody submits themselves in =================== */

await run('an applicant cannot choose their own status', async () => {
  await asApplicant();
  const [row] = await q(
    `insert into public.driver_applications
       (user_id, reference, full_name, guarantor_email, status)
     values ($1, 'LOCI-X', 'Chancer B', 'bisi@example.test', 'approved')
     returning status`,
    [APPLICANT],
  );

  /*
   * ⚠ Normalised rather than refused, and that is the safer shape.
   *
   *   A policy that rejects `approved` and a trigger that overwrites it both
   *   stop this insert. But the trigger also covers the service role, which
   *   skips policies altogether — so a backfill script cannot write an approved
   *   application either.
   */
  check(
    'a status sent by the client is overwritten',
    row?.status === 'pending_guarantor',
    `status was ${row?.status} — an applicant who can name their own status is their own reviewer`,
  );

  /*
   * ⚠ The same insert with no guarantor, because the column default hid this.
   *
   *   The case above only exercises the branch that *has* a guarantor email.
   *   Deleting the trigger's `else` arm left the whole suite green, because
   *   every other insert here omits the status and the column default supplies
   *   `pending` anyway. The branch only earns its keep when a caller sends a
   *   status and there is no guarantor — which is precisely the shape an
   *   attacker would use.
   */
  const [plain] = await q(
    `insert into public.driver_applications (user_id, reference, full_name, status)
     values ($1, 'LOCI-X2', 'Chancer D', 'approved')
     returning status`,
    [APPLICANT],
  );
  check(
    'including when they name no guarantor at all',
    plain?.status === 'pending',
    `status was ${plain?.status} — leaving this branch to the column default means the first caller to send a status wins`,
  );
});

await run('nor can they arrive pre-reviewed', async () => {
  await asApplicant();
  const [row] = await q(
    `insert into public.driver_applications
       (user_id, reference, full_name, reviewed_by, reviewed_at, review_note)
     values ($1, 'LOCI-Y', 'Chancer C', $1, now(), 'Looks great to me')
     returning reviewed_by, reviewed_at, review_note`,
    [APPLICANT],
  );

  check(
    'the review fields are cleared',
    row?.reviewed_by === null && row?.reviewed_at === null && row?.review_note === null,
    'a row that claims it was reviewed is one no audit can distinguish from one that was',
  );
});

await run('and cannot apply on somebody else’s behalf', async () => {
  await asApplicant();
  const message = await refusal(() =>
    q(
      `insert into public.driver_applications (user_id, reference, full_name)
       values ($1, 'LOCI-Z', 'Someone Else')`,
      [ADMIN],
    ),
  );
  check(
    'the insert is refused',
    message !== null && /row-level security/i.test(message ?? ''),
    'the user_id check is the only thing tying an application to an account',
  );
});

/* ======================= 4. the guarantor gate holds ===================== */

await run('an admin cannot approve while the guarantor has not confirmed', async () => {
  await asAdmin();
  const message = await refusal(() =>
    q(
      `update public.driver_applications
          set status = 'approved', reviewed_by = $2, reviewed_at = now()
        where id = $1`,
      [withGuarantor.id, ADMIN],
    ),
  );

  check(
    'the update is refused',
    message !== null && /guarantor/i.test(message ?? ''),
    message === null
      ? 'an approved driver with no guarantor record is indistinguishable from a vouched one'
      : message,
  );

  await asOwner();
  const [row] = await q('select status from public.driver_applications where id = $1', [
    withGuarantor.id,
  ]);
  check('and the application is untouched', row?.status === 'pending_guarantor');
});

await run('but may reject one on its face', async () => {
  await asAdmin();
  const message = await refusal(() =>
    q(
      `update public.driver_applications
          set status = 'rejected', review_note = 'The licence photo is of a different person.',
              reviewed_by = $2, reviewed_at = now()
        where id = $1`,
      [withGuarantor.id, ADMIN],
    ),
  );

  /*
   * ⚠ Waiting on the guarantor is not a reason to hold an obviously bad
   *   application. It would leave it in the list for a week and ask a stranger
   *   to vouch for somebody Package Relay has already decided against.
   */
  check('the rejection is allowed', message === null, message ?? '');
});

await run('and may approve once the guarantor has confirmed', async () => {
  await asOwner();
  await db.exec(
    `update public.driver_applications set status = 'ready_for_review' where id = '${withoutGuarantor.id}'`,
  );
  await asAdmin();
  const message = await refusal(() =>
    q(
      `update public.driver_applications
          set status = 'approved', reviewed_by = $2, reviewed_at = now()
        where id = $1`,
      [withoutGuarantor.id, ADMIN],
    ),
  );
  check('the approval goes through', message === null, message ?? '');

  await asOwner();
  const [row] = await q('select status from public.driver_applications where id = $1', [
    withoutGuarantor.id,
  ]);
  check(
    'and the driver is active',
    row?.status === 'approved',
    'approval is the only thing is_approved_driver() reads, so this is the whole role change',
  );
});

/* ==================== 5. a rejection has to say why ====================== */

await run('a rejection with no reason is refused', async () => {
  await asOwner();
  const [fresh] = await q(
    `insert into public.driver_applications (user_id, reference, full_name, status)
     values ($1, 'LOCI-N', 'Ada K', 'ready_for_review') returning id`,
    [APPLICANT],
  );

  await asAdmin();
  for (const note of [null, '', '   ']) {
    const message = await refusal(() =>
      q(
        `update public.driver_applications
            set status = 'rejected', review_note = $2, reviewed_by = $3, reviewed_at = now()
          where id = $1`,
        [fresh.id, note, ADMIN],
      ),
    );
    check(
      `a note of ${JSON.stringify(note)} is not a reason`,
      message !== null && /reason/i.test(message ?? ''),
      'the driver is shown this note on their timeline and in the rejection email; empty means they are told nothing they can act on',
    );
  }

  const ok = await refusal(() =>
    q(
      `update public.driver_applications
          set status = 'rejected', review_note = 'Your NIN did not match the selfie.',
              reviewed_by = $2, reviewed_at = now()
        where id = $1`,
      [fresh.id, ADMIN],
    ),
  );
  check('but a real one is', ok === null, ok ?? '');
});

/*
 * ⚠ An approval needs no note, and requiring one would be theatre.
 *
 *   There is nothing to explain and nobody to explain it to — the driver's
 *   email says they can start work. A required field with nothing to put in it
 *   gets filled with "ok", which then teaches everyone that the rejection field
 *   can be filled with "ok" too.
 */
await run('an approval needs no note', async () => {
  await asOwner();
  const [fresh] = await q(
    `insert into public.driver_applications (user_id, reference, full_name, status)
     values ($1, 'LOCI-A', 'Femi T', 'pending') returning id`,
    [APPLICANT],
  );
  await asAdmin();
  const message = await refusal(() =>
    q(
      `update public.driver_applications
          set status = 'approved', reviewed_by = $2, reviewed_at = now() where id = $1`,
      [fresh.id, ADMIN],
    ),
  );
  check('the approval goes through', message === null, message ?? '');
});

await db.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — under RLS, a driver naming a guarantor can submit and one naming nobody still\n' +
    '       reaches the queue; neither can choose their own status or arrive pre-reviewed;\n' +
    '       an admin cannot approve past an unanswered guarantor but may reject on the\n' +
    '       face of it; and no rejection is saved without a reason the driver can read.',
);
