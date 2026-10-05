-- ============================================================================
-- guarantor-storage-health.sql — can a reviewer open the guarantor's photographs?
-- ============================================================================
--
-- Paste into the SQL editor of whichever project you are asking about. Read-only:
-- it writes nothing and returns no path, no key and no personal data.
--
-- ⚠ Answers on a project that is behind on migrations rather than failing.
--
--   Everything is probed with `to_regprocedure` / `exists` rather than selected
--   from, so a database missing 51 or 65 gets a diagnosis instead of "relation
--   does not exist" — which is the state you most need an answer in.
--
-- `next_step` names the FIRST thing standing in the way. Fix it, run this again.

with probe as (
  select
    exists (select 1 from storage.buckets where id = 'guarantor-identity')        as bucket_exists,
    coalesce((select not public from storage.buckets where id = 'guarantor-identity'), false)
                                                                                  as bucket_private,
    exists (
      select 1 from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and policyname = 'admins read guarantor identity files'
    )                                                                             as policy_exists,
    coalesce((
      select p.qual ~ 'SELECT (public\.)?is_admin\(\)'
        from pg_policies p
       where p.schemaname = 'storage' and p.tablename = 'objects'
         and p.policyname = 'admins read guarantor identity files'
    ), false)                                                                     as policy_canonical,
    /*
     * ⚠ Any policy on this bucket that is NOT the admin read one.
     *
     *   The bucket is meant to have exactly one, and the thing worth catching is
     *   a second one added by hand that lets somebody else in — a driver reading
     *   their own guarantor's ID is the disclosure the feature exists to prevent.
     */
    (
      select count(*) from pg_policies p
       where p.schemaname = 'storage' and p.tablename = 'objects'
         and coalesce(p.qual, '') like '%guarantor-identity%'
         and p.policyname <> 'admins read guarantor identity files'
    )                                                                             as extra_policies,
    to_regprocedure('public.admin_guarantor_summary(uuid)') is not null            as summary_fn,
    coalesce(
      has_function_privilege('authenticated', 'public.admin_guarantor_summary(uuid)', 'execute'),
      false)                                                                      as admin_can_read,
    coalesce(
      has_function_privilege('anon', 'public.admin_guarantor_summary(uuid)', 'execute'),
      false)                                                                      as anon_can_read,
    to_regprocedure('public.guarantor_identity_policy_canonical()') is not null    as m65_applied
)
select
  bucket_exists,
  bucket_private,
  policy_exists,
  policy_canonical,
  extra_policies,
  summary_fn,
  admin_can_read,
  anon_can_read,
  m65_applied,
  case
    when not bucket_exists    then 'Migration 51 has not been applied here — supabase db push.'
    when not bucket_private   then 'The bucket is PUBLIC. Anyone with a path can read an ID. Make it private now.'
    when not policy_exists    then 'No read policy — a reviewer gets a signed URL that 404s. Apply migration 65.'
    when anon_can_read        then 'anon can execute admin_guarantor_summary. Revoke it now: this leaks the whole form.'
    when extra_policies > 0   then 'Another policy touches this bucket. Read it: something besides admins may be able to.'
    when not summary_fn       then 'admin_guarantor_summary is missing — the review card will show nothing.'
    when not admin_can_read   then 'authenticated cannot execute admin_guarantor_summary — grant it (migration 51).'
    when not m65_applied      then 'Migration 65 has not been applied here — supabase db push.'
    when not policy_canonical then 'The policy was hand-written: is_admin() runs once per row. Apply migration 65.'
    else 'Healthy — a reviewer can open both photographs and nobody else can.'
  end as next_step
from probe;
