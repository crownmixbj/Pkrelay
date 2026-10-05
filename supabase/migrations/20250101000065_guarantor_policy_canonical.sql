-- ============================================================================
-- 65 — the guarantor identity policy, in one canonical form
-- ============================================================================
--
-- 51 created this policy. It was then recreated by hand on a live project to
-- fix a reviewer who could not open the two photographs, and the hand-written
-- version differs from the repo's in two ways that matter. This migration makes
-- every environment agree with the file again, and leaves a probe behind so the
-- next divergence is visible instead of being discovered through a blank screen.
--
-- ⚠ Nothing here widens access. The policy is the same policy: select only,
--   `authenticated` only, one bucket, admins only. Both changes are to *how* the
--   predicate is written, not to who satisfies it.

-- ----------------------------------------------------------------- the policy --

/*
 * ⚠ `(select public.is_admin())`, not `is_admin()`.
 *
 *   Two separate reasons, and the first is the one that shows up in a graph.
 *
 *   1. The scalar subquery makes the call an InitPlan: Postgres evaluates it
 *      once for the whole statement and reuses the answer. Written bare, the
 *      planner is entitled to evaluate it per row — `is_admin()` is `stable`, so
 *      it *may* be cached within a scan, but "may" is not a plan. `storage.objects`
 *      is one table holding every object in every bucket, and a policy that
 *      re-asks "is this person an admin" once per row is the single commonest
 *      way an RLS predicate turns a fast listing into a slow one. This is the
 *      form Supabase's own RLS performance guidance recommends.
 *
 *   2. The schema qualification binds the call at creation time. A policy
 *      expression is stored as an OID, so once created it is pinned to whichever
 *      `is_admin` the `search_path` resolved to *then* — which makes an
 *      unqualified name a hazard at the moment you type it rather than later.
 *      Writing `public.` means the statement means the same thing whoever runs
 *      it, from whatever session, with whatever search_path.
 *
 * ⚠ Still exactly one policy, and still a read.
 *
 *   No insert, update or delete, for anybody. `guarantor-portal` holds the
 *   service role and bypasses RLS, which is why nothing signed in needs to write
 *   here. And no policy for the driver: a driver who could read this bucket
 *   could read their own guarantor's ID, which is the disclosure the whole
 *   feature exists to prevent.
 */
drop policy if exists "admins read guarantor identity files" on storage.objects;
create policy "admins read guarantor identity files"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'guarantor-identity' and (select public.is_admin()));

/*
 * The bucket itself, restated. 51 created it; this is here so a project that
 * somehow has the policy without the bucket, or a bucket that was flipped public
 * in the dashboard, is corrected by running migrations rather than by noticing.
 */
update storage.buckets
   set public = false
 where id = 'guarantor-identity'
   and public is distinct from false;

-- ------------------------------------------------------------------ the probe --

/**
 * Whether this database's guarantor-identity policy is the one in the repo.
 *
 * ⚠ Checks the shape, not just the name.
 *
 *   A policy called the right thing that reads the wrong bucket, is open to
 *   `anon`, or re-evaluates `is_admin()` per row is the failure this is for. The
 *   name alone was never the thing that was wrong.
 *
 *   `qual` is read back from `pg_policies`, where Postgres has already
 *   normalised the expression — a wrapped call prints as `( SELECT is_admin() ...`
 *   and a bare one as `is_admin()`, which is what makes the two distinguishable
 *   from SQL at all.
 *
 * ⚠ `(public\.)?` is not decoration, and it cost a debugging session.
 *
 *   `pg_get_expr` schema-qualifies a name that is not on the *reader's*
 *   `search_path`. This function sets `search_path = ''`, so from in here the
 *   same policy prints `public.is_admin()` while a session with `public` on the
 *   path sees `is_admin()`. A literal match on one spelling returns false for a
 *   policy that is perfectly correct — which is the worst possible behaviour in
 *   a probe whose entire job is to answer "is this right".
 */
create or replace function public.guarantor_identity_policy_canonical()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from pg_catalog.pg_policies p
     where p.schemaname = 'storage'
       and p.tablename  = 'objects'
       and p.policyname = 'admins read guarantor identity files'
       and p.cmd = 'SELECT'
       and p.roles::text = '{authenticated}'
       and p.qual like '%guarantor-identity%'
       and p.qual ~ 'SELECT (public\.)?is_admin\(\)'
  );
$$;

revoke all on function public.guarantor_identity_policy_canonical() from public, anon;
grant execute on function public.guarantor_identity_policy_canonical() to authenticated, service_role;
