-- ============================================================================
-- 20250101000055_guarantor_invite_payload_refresh.sql — the date in the email
-- ============================================================================
--
-- ⚠ 54 widened the window and extended live invitations, and the emails still
--   said seven days. Both facts are correct; they are about different rows.
--
--   `queue_email` snapshots everything the template needs into
--   `email_outbox.payload` at the moment the thing happened, and 38 argues that
--   at length — a parcel cancelled seconds after delivery must not produce a
--   "delivered" email describing a cancelled parcel. So the invitation email
--   carries the `expires_at` that was true when it was minted, and 54 changing
--   the row underneath it does not reach the snapshot.
--
--   For an email that has already gone out, that is exactly right and nothing
--   here touches it. For one still sitting unsent in the outbox, it is a
--   snapshot of something that is no longer true, about to be sent to somebody
--   who will plan around the date it states.
--
-- ⚠ Unsent rows only, and the date is taken from the invitation rather than
--   recomputed.
--
--   The invitation row is the authority — it is what `open_guarantor_invitation`
--   checks the link against. Recomputing `created_at + window` here would agree
--   today and drift the next time somebody changes the window by hand.

/*
 * ⚠ `to_jsonb(timestamptz)`, not `to_char`.
 *
 *   The first draft formatted with `OF`, which renders `+00` — and the template
 *   parses this field with `new Date(...)`, which does not reliably accept a
 *   two-character offset. The email would have rendered an empty expiry line:
 *   the same bug as a wrong date, wearing a better disguise. `to_jsonb` produces
 *   the same ISO 8601 with `+00:00` that `queue_email` stored in the first
 *   place, which is the only format this payload has ever had.
 */
update public.email_outbox o
   set payload = jsonb_set(o.payload, '{expires_at}', to_jsonb(i.expires_at))
  from public.guarantor_invitations i
  join public.driver_applications a on a.id = i.application_id
 where o.kind = 'guarantor_invitation'
   and o.sent_at is null
   /*
    * The outbox is keyed on the application id, and on `<id>:<timestamp>` for a
    * re-invitation — both start with the application id, which is how
    * `my_guarantor_status` matches them too.
    */
   and o.subject_id like a.id::text || '%'
   and i.completed_at is null
   and i.expires_at > now()
   /*
    * Only where it actually disagrees, so this is a no-op on a healthy project.
    * Compared as jsonb rather than cast to timestamptz: a payload holding
    * something uncastable would make the cast throw and take the whole migration
    * with it.
    */
   and o.payload->'expires_at' is distinct from to_jsonb(i.expires_at);

-- ------------------------------------------------- so the panel can tell ----

/**
 * Whether every unsent invitation email states the date its link actually dies.
 *
 * ⚠ A function whose job is to be askable, for the same reason 52 carries one.
 *
 *   The UPDATE above creates nothing, so the deployment panel — which probes by
 *   calling a function and reading PostgREST's "no such function" — is blind to
 *   it. And this particular absence is invisible by construction: the emails
 *   send, the links work, and the only symptom is a date in somebody else's
 *   inbox that is not the date the link expires.
 *
 * ⚠ It reads the live state rather than returning true.
 *
 *   A constant would prove only that this file ran once. This keeps answering
 *   afterwards — so if the window is changed again by hand and the snapshots are
 *   left behind, the panel says so instead of reporting a migration as applied
 *   and a system as healthy.
 */
create or replace function public.guarantor_invite_dates_current()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from public.email_outbox o
      join public.driver_applications a on o.subject_id like a.id::text || '%'
      join public.guarantor_invitations i on i.application_id = a.id
     where o.kind = 'guarantor_invitation'
       and o.sent_at is null
       and i.completed_at is null
       and i.expires_at > now()
       and o.payload->'expires_at' is distinct from to_jsonb(i.expires_at)
  );
$$;

revoke all on function public.guarantor_invite_dates_current() from public, anon;
grant execute on function public.guarantor_invite_dates_current() to authenticated;
