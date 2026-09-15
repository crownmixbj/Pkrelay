-- ============================================================================
-- 20250101000052_guarantor_columns_nullable.sql — the three columns 39 orphaned
-- ============================================================================
--
-- ⚠ This is a one-line fix for a bug that has blocked every driver application
--   since 39 was applied, and the reason it was not caught is worth recording.
--
--   02 created `guarantor_relationship`, `guarantor_address` and `guarantor_nin`
--   as `not null`, because the driver typed all three into their own form.
--
--   39 stopped collecting them — a driver has no business entering somebody
--   else's national identifier — and says so in a comment: "`guarantor_nin`,
--   `guarantor_address` and `guarantor_relationship` are left in place, and
--   nothing writes them any more." Both halves of that sentence are true. What
--   it missed is that a column nothing writes is a column that must be allowed
--   to be null, and 39 left all three `not null` with no default.
--
--   So on any database where 39 has run, `submitApplication` — which correctly
--   stopped sending them — fails at the first one:
--
--     null value in column "guarantor_relationship" of relation
--     "driver_applications" violates not-null constraint (23502)
--
--   The applicant sees that string after filling in thirty fields, attaching
--   five documents and photographing their own face.
--
-- ⚠ The columns stay. Only the constraints go.
--
--   39's argument for keeping them is unchanged and still right: dropping them
--   would take the guarantor details off every application approved before 39 —
--   the records somebody would want if a driver has to be investigated a year
--   from now — and would break `erase_person` in `20250101000009_bans.sql` and
--   `20250101000033_erase_repair.sql`, both of which overwrite all three.
--
-- ⚠ No backfill, and no default.
--
--   A default would be worse than a null: `'Erased'` is already meaningful in
--   these columns, `''` reads as "asked and left blank", and anything else is a
--   value nobody supplied sitting in a compliance record. Null is the honest
--   answer to "what relationship did the driver state" when the driver was
--   never asked. Rows written before 39 keep what they hold.

alter table public.driver_applications
  alter column guarantor_relationship drop not null,
  alter column guarantor_address      drop not null,
  alter column guarantor_nin          drop not null;

/*
 * ⚠ `guarantor_email` is deliberately NOT given a `not null` in exchange.
 *
 *   It is the one guarantor field the driver still supplies, so the temptation
 *   is to require it here. 39 refuses that on purpose: an application with no
 *   guarantor address is allowed to exist and stays in the ordinary review
 *   queue rather than in `pending_guarantor`, because an application waiting on
 *   an invitation that was never sendable is one that can never move. The
 *   client requires the field; the schema does not have to.
 */

-- ------------------------------------------------- so the panel can tell ----

/**
 * Whether this database still refuses an application with no guarantor
 * relationship on it.
 *
 * ⚠ A function whose only job is to be askable.
 *
 *   Everything else on the deployment panel is probed by calling a function a
 *   migration created: absent, PostgREST answers PGRST202 and
 *   `src/lib/schema-gap.ts` names the file to run. A migration that only drops
 *   constraints creates nothing, so it is invisible to that mechanism — and
 *   this one is the difference between a working signup form and one that
 *   refuses every applicant with raw SQL at the last step. Worth being able to
 *   ask about.
 *
 * ⚠ And it reports the live state rather than returning `true`.
 *
 *   A constant would prove only that this file ran. This reads the catalogue,
 *   so it also answers correctly on a database where somebody restored an old
 *   dump over the top, or re-added a constraint by hand. The panel asks "is this
 *   database behind the code"; this is an answer rather than a receipt.
 */
create or replace function public.driver_application_guarantor_optional()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'driver_applications'
       and column_name in ('guarantor_relationship', 'guarantor_address', 'guarantor_nin')
       and is_nullable = 'NO'
  );
$$;

/* Nothing sensitive: it answers a question about the shape of a table. */
revoke all on function public.driver_application_guarantor_optional() from public, anon;
grant execute on function public.driver_application_guarantor_optional() to authenticated;
