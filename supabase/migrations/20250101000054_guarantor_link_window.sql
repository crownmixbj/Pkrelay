-- ============================================================================
-- 20250101000054_guarantor_link_window.sql — thirty days to answer, not seven
-- ============================================================================
--
-- 39 set the window at seven days and argued it: "Long enough for somebody who
-- checks email weekly, short enough that a link in an old inbox is not a
-- standing key." The first half turned out to be optimistic.
--
-- A guarantor is not a customer. They are somebody's landlord or employer, they
-- did not ask for the email, and the thing it asks of them — find your ID,
-- photograph it, take a photo of your face, read a liability clause — is not a
-- two-minute job at a desk. Seven days expires a meaningful share of them
-- before they get to it, and an expired link costs the *driver* their
-- application while the guarantor never learns anything went wrong.
--
-- ⚠ The second half of 39's sentence is still true, and this does make it worse.
--
--   A live link in an inbox reaches a form that collects a national identifier,
--   a photograph of a government ID and a live photograph. Thirty days is four
--   times as long for that to sit in a forwarded thread or a shared mailbox.
--
--   What keeps it defensible is unchanged and is not the window: the token is
--   244 bits, stored only as a digest, single-use, refused past an attempt
--   ceiling, and retired the moment the driver re-invites. The window is the
--   weakest of those five controls, which is why it is the one that can move.
--
-- ⚠ Nothing else changes. `mint_guarantor_invitation` reads this function, so
--   this file is the whole change for every invitation minted from now on.

create or replace function public.guarantor_invitation_window()
returns interval language sql immutable as $$ select interval '30 days' $$;

/*
 * ⚠ Invitations already outstanding are extended. Lapsed ones are not.
 *
 *   `expires_at` is stamped at mint time, so without this the change applies
 *   only to invitations sent after the deploy — and the guarantor who is sitting
 *   on a seven-day link right now, the one who prompted this, would still lose
 *   it. Extending a live invitation gives that person the window the product now
 *   intends.
 *
 *   An invitation that has *already* lapsed stays lapsed. Resurrecting a dead
 *   link is a different act: somebody was told it had expired, the driver may
 *   have re-invited since, and a link coming back to life is precisely the
 *   behaviour a single-use token exists to prevent. Those are replaced by
 *   `reinvite_guarantor`, which mints a fresh one and retires the old.
 */
update public.guarantor_invitations
   set expires_at = created_at + public.guarantor_invitation_window()
 where completed_at is null
   and expires_at > now();
