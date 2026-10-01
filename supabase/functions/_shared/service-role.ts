/**
 * Deciding whether a caller is the service role, and saying so in the log.
 *
 * ⚠ Extracted because three functions had the same brittle check and one of
 *   them cost an evening.
 *
 *   `notify-events`, `notify-offer` and `notify-push` are all invoked by pg_net
 *   from a database trigger, all carrying the key stored in
 *   `private.app_settings`, and all compared it with `=== \`Bearer ${SERVICE_KEY}\``
 *   — the key *this deployment* happened to be injected with. Those two strings
 *   are the same only while nobody rotates a key, nobody uses the newer
 *   `sb_secret_…` format, and nobody pastes a value into the SQL editor with a
 *   trailing newline. When they differ the result is a 403 that writes nothing
 *   anywhere: the database believes it posted, the function believes it refused
 *   a stranger, and the row sits untouched.
 *
 * ⚠ Nothing here reads `Deno.env`, deliberately.
 *
 *   Same rule as `environment.ts`: the verify suite bundles these under node,
 *   where `Deno` does not exist. Callers pass what they have.
 */

/** Compares two strings without leaking the answer in how long it took. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The `role` claim out of a project JWT, or null if this is not one. */
export function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    /* base64url, which `atob` does not accept unaided. */
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const claims = JSON.parse(json) as { role?: unknown };
    return typeof claims.role === 'string' ? claims.role : null;
  } catch {
    return null;
  }
}

export type CallerVerdict = { ok: boolean; how: string };

/**
 * Whether this Authorization header belongs to the service role.
 *
 * ⚠ The question is "is this the service role", not "is this my copy of it".
 *
 *   Supabase's gateway already refuses a call with no valid project JWT, so the
 *   job here is narrower and sharper: keep out the *anon* key, which ships in
 *   the app bundle and would otherwise be enough to reach an endpoint that
 *   sends mail from a signed domain. A JWT states its role, so read it. A
 *   non-JWT secret cannot be inspected, so fall back to comparing it with this
 *   deployment's key.
 *
 * `how` is returned for the log rather than for the caller: `jwt-role:anon` and
 * `key-mismatch` are different problems with different fixes, and a bare 403
 * distinguishes neither.
 */
export function isServiceRole(header: string, serviceKey: string | null): CallerVerdict {
  const bearer = (header ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return { ok: false, how: 'no-token' };

  const role = jwtRole(bearer);
  if (role !== null) {
    return role === 'service_role'
      ? { ok: true, how: 'jwt-role' }
      : { ok: false, how: `jwt-role:${role}` };
  }

  const key = (serviceKey ?? '').trim();
  if (!key) return { ok: false, how: 'no-service-key-configured' };

  return timingSafeEqual(bearer, key) ? { ok: true, how: 'key-match' } : { ok: false, how: 'key-mismatch' };
}

/**
 * One structured line per decision, greppable in the function logs.
 *
 * ⚠ Never the key, and never the recipient.
 *
 *   The address belongs to a person who did not ask to be in a log aggregator,
 *   and the kind plus the row id are enough to find it. The service key is in
 *   scope in every caller of this and must not reach a log line by accident.
 */
export function logger(fn: string, requestId: string) {
  return (stage: string, detail: Record<string, unknown> = {}): void => {
    console.log(JSON.stringify({ fn, request: requestId, stage, ...detail }));
  };
}
