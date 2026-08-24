/**
 * Removes the auth login of an already-erased account.
 *
 * The last step of erasure, and the only one that cannot be done from SQL: no
 * role a client can reach may write `auth.users`.
 *
 * ⚠ THIS IS THE MOST DANGEROUS ENDPOINT IN LOCI.
 *
 *   It holds the service key, and the service key bypasses every Row Level
 *   Security policy in the database. Three guards stand between a request and a
 *   deletion, and each refuses a different way of getting it wrong:
 *
 *     1. the caller is identified from their own JWT, never from the body
 *     2. the caller must be an admin, checked against the database
 *     3. the subject must ALREADY be erased — `profiles.deleted_at` set
 *
 *   The third is the one that is easy to leave out and expensive to omit.
 *   Deleting a login before `erase_person` has run destroys the only handle on
 *   the rows that still hold that person's data: their NIN, their bank details
 *   and their documents would remain, keyed to a user id that no longer
 *   resolves to anybody. The erasure would be permanently impossible to finish.
 *
 *   So this endpoint cannot start an erasure. It can only finish one.
 *
 * ⚠ Requires the foreign-key repair in `supabase/33_erase_repair.sql`.
 *
 *   Without it, deleting the login cascades away every parcel the person ever
 *   sent — taking the recipients' delivery history with it — or raises on
 *   anyone who has carried one. The function checks the repair has been applied
 *   rather than trusting the deployment order.
 */

/*
 * ⚠ This function had CORS and was still blocked on web.
 *
 *   It allowed `authorization, content-type`. supabase-js also sends `apikey`
 *   and `x-client-info`, and a preflight is refused if *any* requested header
 *   is missing from the list — so the partial list failed exactly as no list
 *   would have. The shared module is now the single place that stays correct.
 */
import { json, preflight } from '../_shared/cors.ts';

Deno.serve(async (request: Request) => {
  const options = preflight(request);
  if (options) return options;

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !serviceKey) {
    /*
      Unconfigured is a clear refusal, not a crash.

      A project that has not set these can still erase people — `erase_person`
      does the substantive work and does not come through here. What it cannot
      do is remove the login, and saying so is more useful than a 500.
    */
    return json({ error: 'This project has no service key configured.' }, 501);
  }

  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization) return json({ error: 'Not signed in' }, 401);

  /*
    Who is asking, from their token.

    Never from the body. A body-supplied caller id would let any account claim
    to be an admin, and this endpoint is the one where that claim is worth
    making.
  */
  const whoami = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: serviceKey },
  });
  if (!whoami.ok) return json({ error: 'Not signed in' }, 401);

  const caller = (await whoami.json()) as { id?: string };
  if (!caller.id) return json({ error: 'Not signed in' }, 401);

  let body: { user_id?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body' }, 400);
  }

  const subject = body.user_id;
  if (!subject) return json({ error: 'Which account?' }, 400);

  if (subject === caller.id) {
    return json({ error: 'You cannot remove your own login from here.' }, 400);
  }

  const rest = (path: string) =>
    fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });

  // 2. The caller is an admin. Checked against the database, not the token.
  const callerRow = await rest(`profiles?id=eq.${caller.id}&select=is_admin`);
  const [callerProfile] = (await callerRow.json()) as { is_admin?: boolean }[];
  if (!callerProfile?.is_admin) {
    return json({ error: 'Only an administrator can remove a login.' }, 403);
  }

  // 3. The subject is already erased. See the note at the top on why this is
  //    the guard that matters most.
  const subjectRow = await rest(`profiles?id=eq.${subject}&select=deleted_at,is_admin`);
  const [subjectProfile] = (await subjectRow.json()) as {
    deleted_at?: string | null;
    is_admin?: boolean;
  }[];

  if (!subjectProfile) return json({ error: 'No such account.' }, 404);

  if (subjectProfile.is_admin) {
    return json({ error: "Remove this person's admin role first." }, 400);
  }

  if (!subjectProfile.deleted_at) {
    return json(
      {
        error:
          'That account has not been erased yet. Erase it first — removing the login ' +
          'before the data is scrubbed leaves the data with no way to reach it.',
      },
      400,
    );
  }

  /*
    The foreign-key repair, checked rather than assumed.

    `bookings.sender_id` must be nullable. If 33_erase_repair.sql has not been
    run, it is `not null` with `on delete cascade`, and this delete would take
    every parcel the person sent — and their recipients' history — with it.

    PostgREST does not expose the catalog, so this asks the cheapest question
    that distinguishes the two: insert nothing, and read the OpenAPI description
    of the column. A simpler check would be a lie about a destructive operation.
  */
  const schema = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/openapi+json' },
  });

  if (schema.ok) {
    const spec = (await schema.json()) as {
      definitions?: Record<string, { required?: string[] }>;
    };
    const required = spec.definitions?.bookings?.required ?? [];
    if (required.includes('sender_id')) {
      return json(
        {
          error:
            'Run supabase/33_erase_repair.sql first. Until bookings.sender_id is nullable, ' +
            'removing this login would delete every parcel this person sent, along with the ' +
            "recipients' delivery history.",
        },
        409,
      );
    }
  }

  const deletion = await fetch(`${url}/auth/v1/admin/users/${subject}`, {
    method: 'DELETE',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });

  if (!deletion.ok) {
    const detail = await deletion.text();
    return json({ error: `Auth refused the deletion: ${detail.slice(0, 300)}` }, 502);
  }

  /*
    Audited, with the subject id and nothing else.

    Same rule as `erase_person`: an audit row naming the person removed would
    keep exactly what the removal was for.
  */
  await fetch(`${url}/rest/v1/app_events`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      level: 'warning',
      area: 'moderation',
      message: 'auth login removed',
      context: { subject },
      actor_id: caller.id,
    }),
  });

  return json({ ok: true });
});
