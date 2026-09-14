/**
 * The only write surface a person with no account may reach.
 *
 * ⚠ This function exists so that `anon` does not have to.
 *
 *   A guarantor holds a link and nothing else — no account, no session, no
 *   password. Before this, the way that person's submission reached the
 *   database was a PostgREST call made as the `anon` role, and the way their
 *   photographs would have reached Storage was an insert policy granted to that
 *   same role. Both work. Both also mean the token is a credential the client
 *   spends directly against the platform, and the platform cannot tell a
 *   guarantor from a script holding the same string.
 *
 *   Everything moves behind this function instead. It holds the service role,
 *   so the client is granted nothing; it re-checks the token on every action,
 *   because it is the only caller today and "the only caller today" is not a
 *   rule worth relying on; and it is the first thing in this feature that can
 *   see who is actually calling.
 *
 * ⚠ Bytes do not pass through here, and that is deliberate.
 *
 *   The obvious shape is a multipart POST that this function forwards to
 *   Storage. A government ID photographed on a mid-range Android is commonly
 *   4–8MB, base64 inflates it by a third, and a Deno function holding that in
 *   memory to hand it straight on is a memory limit waiting to be found by
 *   somebody in a hurry.
 *
 *   So this mints a *signed upload URL* for one exact path and the client
 *   uploads to Storage directly. The URL is scoped to that path, so it cannot
 *   be re-pointed; the bucket's own size and MIME limits still apply; and the
 *   guarantor's phone talks to the CDN rather than to a function.
 *
 * ⚠ And the size and type are read back from Storage, never believed from the
 *   client.
 *
 *   `confirm-upload` asks Storage what actually landed. A client that uploaded
 *   nothing and claimed 2MB of JPEG would otherwise produce a `guarantor_documents`
 *   row pointing at an object that does not exist — and `complete_guarantor_verification`
 *   counts those rows to decide whether the submission is complete.
 *
 * Actions:
 *
 *   upload-url      { token, kind }                     -> { path, uploadToken }
 *   confirm-upload  { token, kind, path }               -> { ok }
 *   submit          { token, payload }                  -> { ok } | { reason }
 *
 * Deploy:
 *
 *   supabase functions deploy guarantor-portal
 *
 * It needs no new secrets: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
 * injected into every function by the platform.
 */

import { json, preflight } from '../_shared/cors.ts';

const env = (key: string) => Deno.env.get(key) ?? null;

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const BUCKET = 'guarantor-identity';

/** What a document may be, mirrored by the check constraint on the table. */
const KINDS = ['government_id', 'live_photo'] as const;
type Kind = (typeof KINDS)[number];

/*
 * ⚠ Six megabytes, under the bucket's ten.
 *
 *   The bucket is the backstop and this is the rule. Two files per guarantor at
 *   the bucket's limit is 20MB for one submission, which is a lot of somebody
 *   else's mobile data for a favour, and the client already compresses. A file
 *   over this is refused here rather than stored and regretted.
 */
const MAX_BYTES = 6 * 1024 * 1024;

/** A live photograph is a photograph. A PDF of one is a scan of a screen. */
const LIVE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];

async function rpc(name: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`${name} failed: ${response.status}`);
  return await response.json();
}

/** The first row of a `returns table (…)` function, which is how all of these answer. */
function firstRow(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] ?? null) as Record<string, unknown> | null;
  return (value ?? null) as Record<string, unknown> | null;
}

/**
 * The caller's address, as far as anything here can know it.
 *
 * ⚠ Taken from the left of `x-forwarded-for`, and worth what that is worth.
 *
 *   The platform appends to this header; the leftmost entry is what the edge
 *   reported and the rest are hops. A client can send its own `x-forwarded-for`
 *   and have the real one appended after it, so this is a trace rather than
 *   proof — which is exactly how `submitted_ip` is described in 39 and how it
 *   should be presented to anybody reviewing a submission.
 */
function clientIp(request: Request): string | null {
  const header = request.headers.get('x-forwarded-for') ?? '';
  const first = header.split(',')[0]?.trim() ?? '';
  return first.length > 0 ? first.slice(0, 64) : null;
}

function asKind(value: unknown): Kind | null {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
    ? (value as Kind)
    : null;
}

Deno.serve(async (request: Request) => {
  /*
   * ⚠ Before the method check. A preflight that reaches a 405 is reported by the
   *   browser as a CORS block, with nothing in this function's logs — and this
   *   function is called from a browser more than any other, because the
   *   guarantor portal is a web page.
   */
  const options = preflight(request);
  if (options) return options;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!SUPABASE_URL || !SERVICE_KEY) {
    /*
     * Answered rather than thrown, and vague to the caller on purpose: a
     * guarantor cannot act on a missing secret, and the detail belongs in the
     * logs rather than on a stranger's screen.
     */
    console.error('guarantor-portal is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return json({ error: 'Not configured' }, 503);
  }

  let action = '';
  let token = '';
  let kind: Kind | null = null;
  let path = '';
  let payload: Record<string, unknown> = {};

  try {
    const body = (await request.json()) as Record<string, unknown>;
    action = typeof body.action === 'string' ? body.action : '';
    token = typeof body.token === 'string' ? body.token : '';
    kind = asKind(body.kind);
    path = typeof body.path === 'string' ? body.path : '';
    payload =
      body.payload !== null && typeof body.payload === 'object'
        ? (body.payload as Record<string, unknown>)
        : {};
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  /*
   * ⚠ A missing token is a 400, not a 401.
   *
   *   There is no authentication here to fail. The token is the whole
   *   credential, and whether it is any good is a question only the database
   *   answers — every branch below asks it, and none of them decide on their
   *   own that a string looks plausible.
   */
  if (token.length === 0) return json({ error: 'A token is required' }, 400);

  try {
    // ------------------------------------------------------- upload-url ----

    if (action === 'upload-url') {
      if (!kind) return json({ error: 'Unknown document kind' }, 400);

      const slot = firstRow(await rpc('guarantor_document_slot', { p_token: token, p_kind: kind }));

      if (!slot?.ok) return json({ ok: false, reason: String(slot?.reason ?? 'invalid') }, 200);

      const objectPath = String(slot.path);

      /*
       * ⚠ Upsert, because a retake is normal — and it is a *header* on this
       *   request, not a field in the body.
       *
       *   A guarantor whose first photograph was dark takes another, and the
       *   path is deliberately the same one — `<invitation>/live_photo`, no
       *   extension — so the second upload has to overwrite the first or it
       *   fails as a duplicate and the person is told their camera is broken.
       *
       *   The first version of this sent `{ upsert: true }` as JSON, which the
       *   Storage API ignores in silence: signing succeeds, the upload then
       *   fails with "The resource already exists", and only on a retake. Read
       *   off supabase-js, which sets `x-upsert` here and documents that the
       *   same option passed to `uploadToSignedUrl` has no effect at all.
       */
      const signed = await fetch(
        `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${objectPath}`,
        {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'x-upsert': 'true',
          },
          body: JSON.stringify({}),
        },
      );

      if (!signed.ok) {
        console.error(`signing an upload failed: ${signed.status} ${await signed.text()}`);
        return json({ ok: false, reason: 'error' }, 200);
      }

      /*
       * The answer is `{ url: '/object/upload/sign/<bucket>/<path>?token=…' }`.
       * supabase-js wants the token alone, so it is lifted out here rather than
       * parsed on a phone.
       */
      const { url } = (await signed.json()) as { url?: string };
      const uploadToken = new URL(`${SUPABASE_URL}${url ?? ''}`).searchParams.get('token') ?? '';

      if (uploadToken.length === 0) {
        console.error('a signed upload URL came back without a token');
        return json({ ok: false, reason: 'error' }, 200);
      }

      return json({ ok: true, path: objectPath, uploadToken });
    }

    // --------------------------------------------------- confirm-upload ----

    if (action === 'confirm-upload') {
      if (!kind) return json({ error: 'Unknown document kind' }, 400);
      if (path.length === 0) return json({ error: 'A path is required' }, 400);

      /*
       * ⚠ Storage is asked what landed. The client is not.
       *
       *   This is the step that makes an attachment mean something. The
       *   database counts `guarantor_documents` rows to decide whether a
       *   submission is complete, so a row must not be able to exist without an
       *   object behind it.
       */
      const info = await fetch(`${SUPABASE_URL}/storage/v1/object/info/${BUCKET}/${path}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      });

      if (!info.ok) return json({ ok: false, reason: 'not-uploaded' }, 200);

      /*
       * ⚠ `size` and `content_type`, snake_case, read off supabase-js's own
       *   `FileObjectV2` rather than guessed.
       *
       *   The camelCase spelling parses to `undefined` without erroring, which
       *   would store every document as 0 bytes of application/octet-stream —
       *   and `bytes <= 0` would then refuse every upload with "that file came
       *   through empty" while the file sat in the bucket, intact.
       *
       *   `metadata.mimetype` is the older shape and is read as a fallback.
       */
      const meta = (await info.json()) as {
        size?: number;
        content_type?: string;
        metadata?: { size?: number; mimetype?: string };
      };
      const bytes = typeof meta.size === 'number' ? meta.size : (meta.metadata?.size ?? 0);
      const contentType = String(
        meta.content_type ?? meta.metadata?.mimetype ?? 'application/octet-stream',
      );

      if (bytes <= 0) return json({ ok: false, reason: 'empty-file' }, 200);
      if (bytes > MAX_BYTES) return json({ ok: false, reason: 'too-large' }, 200);

      if (kind === 'live_photo' && !LIVE_PHOTO_TYPES.includes(contentType)) {
        return json({ ok: false, reason: 'not-a-photo' }, 200);
      }

      const recorded = firstRow(
        await rpc('guarantor_document_recorded', {
          p_token: token,
          p_kind: kind,
          p_path: path,
          p_content_type: contentType,
          p_bytes: bytes,
        }),
      );

      if (!recorded?.ok) return json({ ok: false, reason: String(recorded?.reason ?? 'invalid') });

      return json({ ok: true, bytes, contentType });
    }

    // ------------------------------------------------------------ submit ----

    if (action === 'submit') {
      const done = firstRow(
        await rpc('complete_guarantor_verification', {
          p_token: token,
          p_payload: payload,
          /*
           * The two things the guarantor did not say, supplied by the only
           * participant in a position to observe them.
           */
          p_ip: clientIp(request),
          p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 400),
        }),
      );

      if (!done?.ok) return json({ ok: false, reason: String(done?.reason ?? 'error') });

      return json({ ok: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (thrown) {
    /*
     * ⚠ Logged in full, reported as nothing.
     *
     *   A stranger doing somebody a favour cannot act on "guarantor_document_slot
     *   failed: 500", and the string would be the first detail about this
     *   database that the anonymous surface has ever leaked.
     */
    console.error('guarantor-portal failed', thrown);
    return json({ ok: false, reason: 'error' }, 200);
  }
});
