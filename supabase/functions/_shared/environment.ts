/**
 * Which deployment this function is running in, and what that forbids.
 *
 * ⚠ A staging environment is only useful if it cannot touch the real world.
 *
 *   Staging shares this repository, these functions and this Slack workspace
 *   with production. The database is separate — that part is easy, it is a
 *   different connection string. What is *not* separate by default is
 *   everything the functions reach outward to: Resend will happily deliver to a
 *   real applicant's inbox, Dojah will happily spend the real wallet, and Slack
 *   will happily wake whoever is on rota. None of those read the database, so
 *   pointing at a staging database protects none of them.
 *
 *   So the environment is named explicitly, and the three outbound integrations
 *   below are gated on it rather than on somebody remembering not to paste a
 *   production secret into the staging project.
 *
 * Set it with:
 *
 *   supabase secrets set LOCI_ENVIRONMENT="staging" --project-ref <staging-ref>
 *
 * ⚠ Nothing in this file reads `Deno.env` directly, and it must stay that way.
 *
 *   `_shared/email.ts` imports this, `notify-events/templates.ts` imports that,
 *   and `npm run verify:emails` bundles the lot to run under node — where
 *   `Deno` does not exist. Every function here takes the environment as a plain
 *   record so the callers do the reading and the assertions can pass one in.
 *
 * Production is the default when unset. That is the wrong way round for safety
 * and the right way round for compatibility: a deployment that has never heard
 * of this variable keeps behaving exactly as it does today. The staging project
 * is the one being created now, so it is the one that can be created correctly.
 */

export type LociEnvironment = 'production' | 'staging';

export type EnvRecord = Record<string, string | undefined>;

export function readEnvironment(env: EnvRecord): LociEnvironment {
  return (env.LOCI_ENVIRONMENT ?? '').trim().toLowerCase() === 'staging' ? 'staging' : 'production';
}

export function isStaging(env: EnvRecord): boolean {
  return readEnvironment(env) === 'staging';
}

/**
 * Where an email actually goes.
 *
 * ⚠ Fails closed, and that is deliberate.
 *
 *   On staging with no `LOCI_STAGING_EMAIL` set this returns null and the send
 *   is abandoned. The tempting alternative — fall back to the real recipient —
 *   turns one missing secret into a real driver receiving a real-looking "your
 *   application was approved" generated from a database full of test rows.
 *   Sending nothing is a bug somebody reports; sending that is an incident.
 *
 * On production the address is returned untouched and the prefix is empty, so
 * the call is a no-op on the path that matters most.
 */
export function resolveRecipient(
  to: string,
  env: EnvRecord,
): { to: string; subjectPrefix: string } | null {
  if (readEnvironment(env) === 'production') return { to, subjectPrefix: '' };

  const inbox = (env.LOCI_STAGING_EMAIL ?? '').trim();
  if (!inbox) return null;

  /*
   * The intended recipient is kept in the subject rather than dropped.
   *
   * Every staging email lands in one inbox, so "which of the eight templates is
   * this, and who was it aimed at" is otherwise unanswerable without reading
   * the outbox table.
   */
  return { to: inbox, subjectPrefix: `[STAGING -> ${to}] ` };
}

/**
 * Whether to post to Slack at all.
 *
 * Staging never does. An ops channel carrying test alerts is a channel people
 * learn to ignore, and that costs you the real alert some weeks later.
 */
export function slackEnabled(webhook: string | null | undefined, env: EnvRecord): boolean {
  if (readEnvironment(env) === 'staging') return false;
  return Boolean((webhook ?? '').trim());
}
