/**
 * A Supabase client that answers however the test tells it to.
 *
 * ⚠ Exists so the circuit breaker can be tested as behaviour, not as text.
 *
 *   The thing worth proving about it is a *count*: that fifteen keystrokes
 *   against a dead endpoint produce one request rather than fifteen. No amount
 *   of grepping the source establishes that, and the bug it guards against —
 *   an app quietly hammering a broken function — is one nobody notices until
 *   they open a console or a bill.
 *
 *   `globalThis.__invokes` records every call; `globalThis.__answer` decides
 *   what comes back. Both are set by the test immediately before it runs.
 */
globalThis.__invokes = [];
globalThis.__answer = () => ({ data: { configured: true, suggestions: [] }, error: null });

export const isSupabaseConfigured = true;

export const supabase = {
  functions: {
    invoke: async (name, options) => {
      globalThis.__invokes.push({ name, body: options?.body });
      return globalThis.__answer();
    },
  },
};

/*
 * ⚠ The rest of the module's surface, because a stub must be a whole module.
 *
 *   esbuild pulls in the entire import graph, and other files reached from it
 *   import these. A stub missing one of them fails the *bundle*, not the
 *   assertion — an error that looks like a broken test rather than a missing
 *   export. They are unreachable from what is under test here; if that ever
 *   changes, the thing to do is give them behaviour, not delete them.
 */
export const restEndpoint = { url: '', anonKey: '' };
export const EMAIL_TAKEN_CODES = ['email_exists', 'user_already_exists'];
export const isEmailTakenCode = (code) => EMAIL_TAKEN_CODES.includes(code);
export const authErrorMessage = (_code, message) => message;
