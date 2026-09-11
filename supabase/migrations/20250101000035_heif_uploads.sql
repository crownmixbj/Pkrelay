-- LOCI — accepting the second format an iPhone produces.
--
-- Run after 01–34. Re-runnable.
--
-- ⚠ A one-word mismatch that fails an upload after the photo is taken.
--
--   `src/lib/upload.ts` maps a file's extension to the content type it is
--   stored under, and it has always known two HEIC-family extensions:
--
--       heic: 'image/heic',
--       heif: 'image/heif',
--
--   Every bucket allowed the first and none allowed the second. So a `.heif`
--   file — which iOS produces for some captures, and which some Android
--   gallery apps write — was read successfully, labelled honestly, sent, and
--   refused by Storage with:
--
--       mime type image/heif is not supported
--
--   That is the same shape as the `text/plain` rejection this codebase has
--   already been bitten by twice: the client is right about what the file is,
--   and the bucket has simply never been told. The alternative fix — dropping
--   `heif` from the client map — would store a HEIF file labelled as a JPEG,
--   which is the mislabelling `upload.ts` exists to prevent, and would leave a
--   reviewer with a document their browser refuses to draw.
--
-- Four buckets, because all four can receive a photograph straight from a
-- camera roll. `driver-documents` and `sender-identity` keep `application/pdf`;
-- the two photo-only buckets still refuse it, which is what `assertImageBytes`
-- enforces on the client before the request is built.

do $$
declare
  bucket text;
  photo_types text[] := array[
    'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'
  ];
begin
  foreach bucket in array array['sender-photo', 'delivery-proof'] loop
    update storage.buckets set allowed_mime_types = photo_types where id = bucket;

    if not found then
      raise exception 'Bucket % is missing — run the migration that creates it first.', bucket;
    end if;
  end loop;

  foreach bucket in array array['driver-documents', 'sender-identity'] loop
    update storage.buckets
       set allowed_mime_types = photo_types || array['application/pdf']
     where id = bucket;

    if not found then
      raise exception 'Bucket % is missing — run the migration that creates it first.', bucket;
    end if;
  end loop;
end
$$;

/*
  A record that this happened, so the next person reading the bucket list can
  see it was widened deliberately rather than drifting.
*/
insert into public.app_events (level, area, message, context, actor_id)
values (
  'info',
  'storage',
  'allowed upload types widened to include image/heif',
  jsonb_build_object('buckets', array['sender-photo', 'delivery-proof', 'driver-documents', 'sender-identity']),
  null
);
