-- LOCI — only a verified sender may post a parcel.

/*
  Run after 01–41. Re-runnable.

  ⚠ Until now this rule did not exist anywhere a client could not skip.

    `postingGate` in the app decided who may publish, and an app is a
    suggestion. Anyone with the anon key and curl could POST to
    `/rest/v1/bookings` and the database would take it, because the insert
    policy asked four questions — is this your own row, is it unassigned, is it
    'Booked', are you un-erased — and none of them were about identity.

    So this is not a tightening of an existing rule. It is the first time the
    rule is enforced at all.

  ⚠ A deliberate reversal, and the earlier reasoning is worth keeping.

    28_sender_identity.sql and the original `postingGate` argued that a sender
    should *not* be blocked while a check was outstanding: a mismatch is as
    often an old NIMC photo or a dark room as it is a fraud, and refusing on
    that evidence locks real customers out with nothing they can do about it.
    That argument was correct while there was no way for a person to resolve a
    flag — the only path was automated, and it had already said no.

    41 built that path. A flagged or unchecked account now sits in a queue an
    administrator works, and can be approved by a human looking at the slip
    beside the face. The recourse the old reasoning was protecting now exists,
    which is what makes refusing defensible.

  ⚠ This stops everybody who is not verified today, and that is the point.

    Nothing moves a sender to 'verified' by itself unless `verify-identity` is
    deployed. On a database where it is not, every account is 'pending' and no
    parcel can be posted until an administrator approves each one in Sender ID
    Review. That is the chosen behaviour, not an oversight — but it is the
    reason this is its own migration rather than a line slipped into another.
*/

-- ------------------------------------------------------------ the predicate --

/*
 * ⚠ One definition, used by the policy and readable by the app.
 *
 *   The client needs to know the same thing in order to explain itself, and
 *   two implementations of "may this person post" drift — the usual result
 *   being a form that lets somebody fill three pages before the server refuses
 *   the submit.
 *
 * ⚠ 'verified' only. Not "has a row", not "has submitted".
 *
 *   `pending` means nobody has looked. `flagged` means a machine disagreed.
 *   `rejected` means a person said no. `unverified` means nothing was sent.
 *   None of those is an approval, and writing the predicate as
 *   `status <> 'rejected'` — which reads almost the same — would let three of
 *   the four straight through.
 */
create or replace function public.is_verified_sender()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select i.status = 'verified' from public.sender_identity i where i.user_id = auth.uid()),
    false
  );
$$;

revoke all on function public.is_verified_sender() from public, anon;
grant execute on function public.is_verified_sender() to authenticated;

-- --------------------------------------------------------------- the policy --

/*
  Replaces "sender creates own" from 09_bans.sql, which replaced 01's.

  ⚠ Every earlier guard is repeated verbatim.

    09 left this warning and it is worth repeating: dropping the policy and
    recreating it with only the new condition would quietly remove the others,
    letting a client post a parcel pre-assigned to a driver. The only addition
    is the last line.
*/
drop policy if exists "sender creates own" on public.bookings;
create policy "sender creates own"
  on public.bookings for insert
  to authenticated
  with check (
    sender_id = (select auth.uid())
    -- A parcel cannot be posted pre-assigned; claiming is a separate step.
    and driver_id is null
    and driver is null
    and status = 'Booked'
    and not public.is_erased()
    and public.is_verified_sender()
  );

/*
 * ⚠ What this deliberately does *not* touch.
 *
 *   Reading, tracking and cancelling a parcel already posted are untouched. A
 *   sender whose verification lapses into review still has parcels in the
 *   world, and cutting them off from watching or cancelling those would punish
 *   them for a decision LOCI has not finished making.
 *
 *   The update and select policies are therefore left exactly as they were.
 */

notify pgrst, 'reload schema';
