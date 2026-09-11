/*
  LOCI → Package Relay: the hub names.

  Why this needs a migration at all.

  `src/constants/hubs.ts` carries SEED_HUBS, but that constant stopped being
  what anyone sees the moment 20250101000008_hubs.sql seeded `public.hubs`.
  The app reads the table through `useHubs()`; the constant is a fallback and a
  record of the original network. Renaming the constant alone would have left
  every user still reading "LOCI Ikeja Hub" off the database while the rest of
  the app said Package Relay — the rename would have looked done and not been.

  20250101000008 has been pushed, so it is not edited. This moves the data
  forward instead, which is the append-only rule working as intended.

  Why "Package Relay" and not "PKRELAY".

  A hub name is read as prose in the pickup picker — "Hand it over at a
  Package Relay hub" — so it takes the readable form. PKRELAY is reserved for
  the compact wordmark, domains and identifiers, none of which this is.

  Why the `like 'LOCI %'` guard.

  The seed is `on conflict (id) do nothing` precisely so an admin correcting a
  hub in the Admin area is never overwritten by a re-run. An unguarded
  `replace(name, ...)` here would break that promise in the other direction: a
  hub someone has since renamed to something without "LOCI" in it is left
  alone, and one renamed to e.g. "LOCI Ikeja (temp)" is not silently reverted
  to the seed spelling — only its brand word changes. Rows that never carried
  the brand are untouched.

  It is written to be re-runnable. Running it twice is a no-op: after the first
  pass no row matches `like 'LOCI %'` any more.

  Only the leading brand word moves. Areas, addresses, hours, phone numbers
  and the `id` values (`lag-1`, `ib-1`, …) are unchanged — the ids are
  referenced by bookings and are hard identity, not brand.
*/
update public.hubs
   set name = 'Package Relay' || substring(name from 5)
 where name like 'LOCI %';
