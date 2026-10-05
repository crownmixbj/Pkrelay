-- ============================================================================
-- 68 — the pg_net probe was finding itself
-- ============================================================================
--
-- Run after 67. Re-runnable.
--
-- ⚠ A probe that scans function bodies for a string is itself a function body
--   containing that string.
--
--   67 added `pg_net_calls_are_resolvable()` to catch any function still
--   carrying `extensions.net.http_post` — the three-part name Postgres refuses
--   as database.schema.function. It works, except that its own definition
--   contains that text as a search pattern, so `pg_get_functiondef` matches it
--   and the probe answers false on every database, for ever, including ones
--   where every real call is correct.
--
--   On production it did exactly that: both notifiers had been repaired and the
--   probe still reported a problem, naming `public.pg_net_calls_are_resolvable`
--   as the offender. The deployment panel would have shown that line red
--   permanently, which is worse than not having the check — a panel that is
--   always wrong about one row teaches people to ignore the panel.
--
-- ⚠ Excluded by name, not by making the pattern cleverer.
--
--   Splitting the literal so it does not match itself would work and would be
--   unreadable, and the next person to tidy the string back together would
--   silently reintroduce this. Naming the exclusion says what is going on.

create or replace function public.pg_net_calls_are_resolvable()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and p.prokind = 'f'
       /*
         ⚠ This function's own body carries the pattern it searches for.
           Without this line it finds itself and never reports healthy.
       */
       and p.proname <> 'pg_net_calls_are_resolvable'
       and pg_catalog.pg_get_functiondef(p.oid) like '%extensions.net.http_post%'
  );
$$;

revoke all on function public.pg_net_calls_are_resolvable() from public, anon;
grant execute on function public.pg_net_calls_are_resolvable() to authenticated, service_role;

notify pgrst, 'reload schema';
