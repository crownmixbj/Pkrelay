-- ============================================================================
-- 20250101000078_repeat_decline_repair.sql — a driver can decline twice
-- ============================================================================
--
-- Run after 77. Re-runnable. Apply to BOTH staging and production.
--
-- Symptom (production, 2026-10-06): a driver taps Decline and gets
--
--     duplicate key value violates unique constraint
--     "dispatch_offers_no_repeat_decline"
--
-- and the offer stays on screen until it times out.
--
-- Cause: `dispatch_offers_no_repeat_decline` — "a driver declines a parcel at
-- most once" — was created by 20 and dropped by 23, when a decline became a
-- 15-minute cooldown rather than permanent. Production's migration history
-- records 23 as applied, but the index is present, so 20 was re-run after it
-- (it uses `create unique index if not exists`). With the cooldown, the same
-- parcel comes back to the same driver; their second Decline writes a second
-- 'declined' row for the pair and the index refuses it, rolling back the whole
-- answer.
--
-- Today PKG-126401 was declined at 07:21, re-offered to the same driver every
-- half hour since, and every later Decline failed this way.
--
-- The guard that matters is untouched: `dispatch_offers_one_live_per_booking`
-- still allows only one outstanding offer per parcel.
-- ============================================================================

drop index if exists public.dispatch_offers_no_repeat_decline;

do $$
begin
  if to_regclass('public.dispatch_offers_no_repeat_decline') is not null then
    raise exception 'dispatch_offers_no_repeat_decline still exists after the drop';
  end if;
  if to_regclass('public.dispatch_offers_one_live_per_booking') is null then
    raise exception 'dispatch_offers_one_live_per_booking is missing; run 20 and 23 before this';
  end if;
end
$$;
