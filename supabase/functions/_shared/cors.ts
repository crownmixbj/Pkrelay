/**
 * The headers that let a browser talk to these functions at all.
 *
 * ⚠ Missing CORS does not look like missing CORS. It looks like the feature.
 *
 *   `supabase.functions.invoke` sends `content-type`, `authorization`, `apikey`
 *   and `x-client-info`. Any one of those makes the request "non-simple", so
 *   before the real call the browser sends an `OPTIONS` preflight and refuses
 *   to proceed unless the answer explicitly permits the origin and every
 *   header it intends to send.
 *
 *   A function without this replies to that preflight with whatever it does
 *   for an unexpected method — a 405, usually — and the browser reports
 *   "blocked by CORS policy", never sending the POST. The function's own logs
 *   stay empty, because from its side nothing was ever asked. That is what
 *   makes this expensive to diagnose: every layer looks healthy except the one
 *   nobody can see.
 *
 *   Native builds have no such rule and never hit it, so this fails on web
 *   only — which is also where the app is developed and demonstrated.
 *
 * ⚠ `apikey` and `x-client-info` are not optional entries in this list.
 *
 *   `erase-auth-user` allowed only `authorization, content-type` and was
 *   equally broken, silently, for the same reason: the preflight is refused if
 *   *any* requested header is unlisted, and supabase-js always sends all four.
 */
export const CORS: Record<string, string> = {
  /*
   * Anonymous origins are the point: this is a public app served from
   * Cloudflare Pages, from localhost during development, and from a native
   * shell with no origin at all. Every one of these functions authenticates
   * with the caller's JWT rather than trusting where the request came from,
   * so the origin is not what is keeping anybody out.
   */
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  /* A day, so a browser stops re-asking on every keystroke-driven lookup. */
  'Access-Control-Max-Age': '86400',
};

/** The preflight answer. Must come before any method check, or it gets a 405. */
export function preflight(request: Request): Response | null {
  if (request.method !== 'OPTIONS') return null;
  return new Response('ok', { headers: CORS });
}

/** A JSON response that a browser is allowed to read. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
