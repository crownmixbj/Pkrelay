/**
 * Assertions for the four driver-security changes.
 *
 * Each guards a failure that is silent rather than loud:
 *
 *   - A phone "lock" that is only a disabled input, which any HTTP client walks
 *     straight past.
 *   - A cooling window that pauses payouts, punishing the driver for the attack
 *     instead of stopping it.
 *   - An identity mismatch treated as a rejection, locking out drivers whose
 *     only offence is that their NIMC photo is ten years old.
 *   - An "unassigned" breakdown that counts parcels which are not unassigned.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hasRegisteredPhone, phoneMatchesAccount } from '../src/store/registered-phone';
import {
  hoursUntil,
  maskAccount,
  payoutChangeLabel,
  PAYOUT_COOLING_HOURS,
  type PayoutChange,
} from '../src/store/driver-applications';
import { waitedLabel } from '../src/store/admin';
import { IDENTITY_THRESHOLD, interpretIdentity } from '../supabase/functions/verify-liveness/dojah';

import { changedFields, fieldRisk } from '../src/store/driver-profile';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/*
 * ⚠ `/*` only counts as a comment when something could precede it.
 *
 *   `driver-signup.tsx` passes `type: ['image/*', 'application/pdf']` to the
 *   document picker. The old pattern saw the `/*` inside that string, ran to
 *   the next real `*\/` hundreds of lines below, and deleted everything in
 *   between — including a guard this file asserts the presence of, and,
 *   worse, code that other negative assertions were checking the *absence* of.
 *   Those passed for the best part of a day by examining a truncated file.
 *
 *   Requiring a boundary character in front distinguishes a comment opener
 *   from two characters in the middle of a string.
 */
const code = (source: string) =>
  source
    .replace(/(^|[\s{(=,;])\/\*[\s\S]*?\*\//g, '$1')
    .replace(/\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');

const flat = (source: string) => source.replace(/\s+/g, ' ');

const sql = read('supabase/migrations/20250101000016_driver_identity.sql');
const sqlCode = code(sql);
/* The handoff that carries the verdict from the session onto the application. */
const handoffCode = code(read('supabase/migrations/20250101000034_identity_handoff.sql'));
const signup = read('src/app/(tabs)/driver-signup.tsx');
const identityFn = read('supabase/functions/verify-identity/index.ts');

// ------------------------------------------------------- 1. the phone lock --

check(
  'the lock is enforced by a trigger, not only by the form',
  flat(sqlCode).includes('create trigger driver_applications_lock_phone'),
  'a disabled input still sends its value — the field is a suggestion, the trigger is the rule',
);
check(
  'and it compares against the account, not against anything in the request',
  flat(sqlCode).includes('from auth.users u where u.id = new.user_id'),
);
check(
  'it reads both the auth column and the sign-up metadata',
  flat(sqlCode).includes("coalesce(nullif(u.phone, ''), u.raw_user_meta_data ->> 'phone')"),
  'this app puts the number in metadata; a project that later enables phone auth uses the column',
);
check(
  'an account with no number on file is let through',
  flat(sqlCode).includes('if account_phone is null then return new;'),
  'accounts predating the sign-up phone field would otherwise be unable to apply at all',
);
check(
  'the stored number is normalised',
  flat(sqlCode).includes('new.phone := account_phone;'),
  'two records of the same person should not disagree because one has +234 and the other 0',
);

check(
  'the same number written three ways still matches',
  phoneMatchesAccount('08031234567', '+2348031234567') &&
    phoneMatchesAccount('+234 803 123 4567', '08031234567') &&
    phoneMatchesAccount('234-803-123-4567', '+2348031234567'),
  'a driver told their own phone is not their phone concludes the app is broken',
);
check('a genuinely different number does not', !phoneMatchesAccount('08031234567', '08039999999'));
check(
  'and an empty one never matches',
  !phoneMatchesAccount('', '+2348031234567') && !phoneMatchesAccount('08031234567', ''),
);
check(
  'an account with no usable number is not treated as locked',
  !hasRegisteredPhone('') && !hasRegisteredPhone(null) && hasRegisteredPhone('08031234567'),
  'a locked empty field is a form nobody can submit',
);

check('the field is not editable when locked', flat(signup).includes('editable={!phoneLocked}'));
check(
  'and a mismatching keystroke opens the modal rather than being swallowed',
  flat(signup).includes('if (phoneLocked) { setPhoneLockOpen(true); return; }'),
);
check(
  'the modal names the registered number',
  flat(read('src/store/registered-phone.ts')).includes(
    'This application has to use the phone number on your Package Relay account: ${displayRegisteredPhone(',
  ),
  '"that number does not match" leaves someone guessing which of their SIMs the account uses',
);
check(
  'the field is prepopulated from the account, and not only on mount',
  flat(signup).includes('}, [phoneLocked, registeredPhone]);'),
  'the session restores asynchronously — a mount-only effect leaves the field empty on a cold start',
);

// ------------------------------------------------ 2. the payout cooling window --

check(
  'the window is 48 hours',
  flat(sqlCode).includes(
    "effective_at timestamptz not null default (now() + interval '48 hours')",
  ) && PAYOUT_COOLING_HOURS === 48,
);
check(
  'the old account is what a payout run reads',
  flat(sqlCode).includes('create or replace function public.active_payout_account') &&
    flat(sqlCode).includes('from public.driver_applications a'),
  'reading the request table instead would defeat the entire mechanism',
);
check(
  'and the application row is only updated once the window has passed',
  flat(sqlCode).includes("where status = 'pending' and effective_at <= now()"),
);
check(
  'there is no client write path to the request table',
  !/create policy[^;]*for (insert|update|delete)[^;]*payout_change_requests/is.test(sqlCode),
  'a driver who could write the row could set effective_at to now and skip the wait',
);
check(
  'only one change can be pending at a time',
  flat(sqlCode).includes('create unique index if not exists payout_change_one_pending_per_driver'),
  'otherwise an attacker queues a second change to land after the first is noticed',
);
check(
  'the driver or an admin can stop it',
  flat(sqlCode).includes('if owner <> actor and not public.is_admin() then'),
);
check(
  'the sweeper is not callable by a driver',
  flat(sqlCode).includes(
    'revoke all on function public.apply_due_payout_changes() from public, anon, authenticated',
  ),
);
check(
  'account numbers stay out of the audit log',
  !/jsonb_build_object\([^)]*account_number/i.test(flat(sqlCode)),
  'app_events is read by every admin and does not need them — the request row has them, behind RLS',
);

const pending = (hoursAway: number): PayoutChange => ({
  id: 'p1',
  bankName: 'GTBank',
  accountNumber: '0123456789',
  accountName: 'A Driver',
  previousBankName: 'Access',
  previousAccountNumber: '9876543210',
  status: 'pending',
  requestedAt: new Date().toISOString(),
  effectiveAt: new Date(Date.now() + hoursAway * 3_600_000).toISOString(),
});

check('a fresh request reports about two days', hoursUntil(pending(47.5).effectiveAt) === 48);
check(
  'the countdown rounds up, never down',
  hoursUntil(pending(1.1).effectiveAt) === 2,
  'a driver watching for their money should never find it has not moved when the app said it had',
);
check('a passed window reports zero', hoursUntil(pending(-5).effectiveAt) === 0);
check(
  'a settled change does not show a countdown',
  payoutChangeLabel({ ...pending(10), status: 'applied' }) === 'Applied' &&
    payoutChangeLabel({ ...pending(10), status: 'cancelled' }) === 'Cancelled',
);

check(
  'account numbers are masked wherever they are shown',
  maskAccount('0123456789') === '••••6789' &&
    maskAccount('12') === '••••' &&
    maskAccount(null) === '••••',
);

const payoutCard = read('src/components/ui/payout-account.tsx');
check(
  'the driver is told their money is not paused',
  flat(payoutCard).includes('Until then your current account keeps receiving everything'),
  '"payout change pending" reads as money in limbo unless something says otherwise',
);
check(
  'and told what to do if they did not request it',
  flat(payoutCard).includes('Cancel it now and change your password'),
  'the window only helps someone who knows what the alert means',
);

// ------------------------------------------------------- 3. identity matching --

const matched = {
  entity: { selfie_verification: { confidence_value: 99.81, match: true } },
};

check('a confident match passes', interpretIdentity(matched, 'production').verdict === 'matched');
check(
  'a low score is a mismatch even when the provider says true',
  interpretIdentity(
    { entity: { selfie_verification: { confidence_value: IDENTITY_THRESHOLD - 1, match: true } } },
    'production',
  ).verdict === 'mismatch',
);
check(
  'the identity bar is higher than the liveness bar',
  IDENTITY_THRESHOLD === 90,
  'a false pass here approves an application in someone else’s name and no human sees it; a false reject is reviewed',
);
check(
  'an empty response is unavailable, never a mismatch',
  interpretIdentity({}, 'sandbox').verdict === 'unavailable' &&
    interpretIdentity({ entity: {} }, 'sandbox').verdict === 'unavailable',
  'a provider outage must not read as "this person is lying about who they are"',
);

check(
  'a mismatch does not stop the application being submitted',
  flat(code(signup)).includes('await runIdentityCheck(') &&
    !/if \(identity\w*\.status[^)]*\) return/.test(flat(code(signup))) &&
    !/disabled=\{[^}]*identityOutcome/.test(flat(code(signup))),
  'NIMC photos can be a decade old — auto-rejecting turns "your face has aged" into "you cannot work"',
);

/*
 * ⚠ This check used to say the opposite, and it was wrong.
 *
 *   It asserted `runIdentityCheck` ran *before* `submitApplication`, on the
 *   stated grounds that the other order leaves a window where the application
 *   looks unchecked. But the verdict's only home was
 *
 *     PATCH driver_applications?user_id=eq.<caller>&status=eq.pending
 *
 *   and running first meant there was no such row yet: the patch matched
 *   nothing and every first-time applicant's four identity columns stayed null
 *   forever. The window the assertion was protecting against was permanent, and
 *   the assertion was pinning the cause of it.
 *
 *   The verdict now lands on the capture session — which exists from the moment
 *   the camera opens — and `attach_identity_result` copies it across once the
 *   application row is there. So the order is reversed and the window is closed
 *   for real.
 */
/*
 * ⚠ Pinned to the PATCH, not to the table name.
 *
 *   My first version asked whether the file contained
 *   `photo_capture_sessions?id=eq....` — which the *lookup* at the top of the
 *   function already satisfies. Deleting the write entirely left the assertion
 *   green. This one requires the method as well, which is the part that makes
 *   it a write.
 */
check(
  'the verdict is parked on the session, which exists before the application does',
  /photo_capture_sessions\?id=eq\.\$\{encodeURIComponent\(sessionId\)\}`,\s*\{\s*method: 'PATCH'/.test(
    identityFn,
  ),
  'patching driver_applications alone drops the verdict of every first-time applicant',
);

/*
 * The sender half of the same function.
 *
 * `submitOnboarding` called this without a NIN and without a subject for as
 * long as it existed, so every sender check returned 'unavailable' and the NIN
 * and slip they were asked for were collected for nothing.
 */
check(
  'a sender check is asked for as a sender',
  flat(code(read('src/store/identity.ts'))).includes(
    "body: { session_id: sessionId, subject: 'sender' }",
  ),
  'without the subject the call is treated as a driver application and answers in the wrong vocabulary',
);
check(
  "and the sender's NIN is read from their row, not from the request",
  flat(identityFn).includes(
    'sender_identity?user_id=eq.${encodeURIComponent(userId)}&select=nin',
  ) && flat(identityFn).includes('Anything the client sent for a sender is ignored'),
  'a NIN supplied at call time is a NIN the person being checked chose to be checked against',
);
check(
  'and the verdict goes through the RPC that owns the promotion rules',
  flat(identityFn).includes("db('rpc/record_identity_result'"),
  'writing the columns directly would put a second copy of "only a match becomes the reference" here',
);
check(
  'and copied onto the application once there is one',
  code(signup).indexOf('await insertApplication') < code(signup).indexOf('attachIdentityResult('),
  'copying first would copy onto a row that does not exist yet',
);
check(
  'the copy cannot fail the application',
  /attachIdentityResult\([\s\S]{0,80}\);\s*\} catch \{/.test(code(signup)),
  'the photo was taken, checked and stored before this point — only the reviewer’s convenience is at stake',
);
check(
  'and the applicant cannot forge what is copied',
  flat(handoffCode).includes('attach_identity_result') &&
    flat(handoffCode).includes("current_setting('loci.attaching_identity', true) = 'on'") &&
    flat(handoffCode).includes('and owner_id = actor') &&
    flat(handoffCode).includes('and user_id = actor'),
  'an unscoped copy would let an applicant name a session, or an application, that is not theirs',
);
check(
  'the applicant is told the outcome',
  flat(signup).includes('identityLabel(identity)'),
  'someone whose selfie failed a government photo match has a right to know before a reviewer decides',
);
/*
 * ⚠ Repointed. This pinned "Your application has still been sent, and a person
 *   will review it." — a sentence that was true when the photo was taken inside
 *   the submit handler and false once `LiveSelfieCard` moved the capture above
 *   the confirmation checkbox. It told an applicant their application was in
 *   while they were still filling it, and on a submission that then failed it
 *   sat directly above "Could not submit your application".
 *
 *   The property being defended is the one worth keeping: a face that did not
 *   match a government photo is not a rejection, and a person decides. That is
 *   asserted here without pinning a claim about a row that may not exist yet.
 */
check(
  'and it is not phrased as a rejection',
  flat(read('src/store/capture-session.ts')).includes(
    'That does not stop your application — a person will review it.',
  ),
  'a mismatch is as often a ten-year-old NIMC photo as a fraud',
);

check(
  'the driver copy says this IS an identity check',
  flat(read('src/components/ui/sender-photo-sheet.tsx')).includes(
    'This is an identity check: your selfie is compared with the photo on your NIN record',
  ),
  'the applicant is handing over a face to be matched against a government record, and has to be told so',
);

check(
  'the applicant cannot write their own verdict',
  flat(sqlCode).includes('guard_identity_columns') &&
    flat(sqlCode).includes('Identity results are written by the verification service'),
);
check(
  'the verdict is written only against the caller’s own pending application',
  flat(identityFn).includes(
    'driver_applications?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending',
  ),
  'the service role bypasses RLS, so an unscoped patch would stamp a verdict on someone else’s file',
);
check(
  'a malformed NIN costs nothing',
  flat(identityFn).includes('if (nin.length !== 11)'),
  'a typo would otherwise buy a paid call and put a mismatch flag on an honest applicant',
);
check(
  'the government identity record is not stored',
  !/first_name|date_of_birth|birthdate/.test(code(identityFn)),
  'Package Relay has the name from the form; a second copy pulled from NIMC plus their photo serves no stateable purpose',
);
check(
  'the sensitive-data escalation is flagged',
  /LEGAL_REVIEW_REQUIRED/.test(sql) && /LEGAL_REVIEW_REQUIRED/.test(identityFn),
  'matching a face to establish who someone is, is the NDPA’s definition of sensitive personal data',
);

// -------------------------------------------- 4. the unassigned breakdown --

check(
  'the breakdown counts only genuinely unassigned parcels',
  flat(sqlCode).includes("where b.driver_id is null and b.status = 'Booked'"),
  'a cancelled or already-claimed parcel in this list sends an operator chasing a problem that is not there',
);
check(
  'it groups by destination, not origin',
  flat(sqlCode).includes('group by b.destination_city'),
  'a backlog is a shortage of drivers going somewhere; admin_city_volumes already covers origin',
);
check(
  'it reports how long the oldest has waited',
  flat(sqlCode).includes('max(extract(epoch from (now() - b.created_at)) / 3600)'),
  'a count alone cannot tell an operator whether this is a queue or a graveyard',
);
check(
  'and how many are already out with a driver',
  flat(sqlCode).includes("o.status = 'offered' and o.expires_at > now()"),
  'a backlog dispatch is working through looks identical to one nobody has seen',
);
check(
  'only an admin can read it',
  flat(sqlCode).includes('if not public.is_admin() then raise exception'),
);

check('waiting time reads in hours below a day', waitedLabel(5) === '5h');
check('and in days above one', waitedLabel(30) === '1 day' && waitedLabel(73) === '3 days');
check('a fresh parcel does not report 0h', waitedLabel(0.4) === 'under an hour');
check('a nonsense figure does not render as a number', waitedLabel(Number.NaN) === '—');

const overview = read('src/components/ui/admin-overview.tsx');
const drawer = read('src/components/ui/admin-parcel-drawer.tsx');

/*
 * These three assertions changed target rather than direction.
 *
 * The destination breakdown used to expand inline on the Unclaimed card. It now
 * lives in the parcel drawer as a filter over the list it describes — because
 * the inline expander made that one card behave differently from every other
 * parcel card, and a long press was the only way to reach the list from it.
 * The information is the same; where it lives is not.
 */
check(
  'the Unclaimed card opens the drawer on a plain click',
  flat(overview).includes(
    "onPress={() => setDrawer({ scope: 'unassigned', title: 'Unclaimed parcels' })}",
  ),
  'it used to toggle a list on click and hide the drawer behind a long press',
);
check(
  'the destination breakdown still exists, in the drawer',
  flat(drawer).includes('fetchUnassignedByDestination()'),
  'a count says there is a backlog; only the destinations say what to do about it',
);
check(
  'and it is still fetched on demand rather than with every dashboard load',
  flat(code(drawer)).includes("if (scope === 'unassigned') {"),
  'a query per dashboard load for a list nobody has opened is a cost with no reader',
);

// ------------------------------------------------------ the scheduled jobs --

check(
  'both sweeps are documented as needing a schedule',
  flat(sql).includes('apply_due_payout_changes();') && flat(sql).includes('hourly'),
  'without the sweep a payout change waits forever, which looks exactly like the feature working',
);

// ------------------------------------------ what a driver may change later --

const editsSql = read('supabase/migrations/20250101000029_driver_profile_edits.sql');
const editsCode = code(editsSql);
const profile = read('src/store/driver-profile.ts');

/*
 * The two classifications are compared field by field, not spot-checked.
 *
 * A client that thinks a field is low-risk while the server calls it high does
 * not fail loudly — it shows a driver a plain Save button and then suspends
 * their account. Parsing the SQL and diffing it against the TypeScript is the
 * only version of this check that cannot rot.
 */
const sqlRisks = new Map<string, string>();
for (const [, field, risk] of editsCode.matchAll(/when '(\w+)' then '(low|high|locked)'/g)) {
  sqlRisks.set(field, risk);
}

check(
  'the SQL classifies a meaningful number of fields',
  sqlRisks.size >= 18,
  'if the regex stopped matching, every comparison below would pass vacuously',
);
check(
  'and the client agrees with it on every one',
  [...sqlRisks].every(([field, risk]) => fieldRisk(field) === risk),
  [...sqlRisks]
    .filter(([field, risk]) => fieldRisk(field) !== risk)
    .map(([field, risk]) => `${field}: sql=${risk} client=${fieldRisk(field)}`)
    .join(', '),
);
check(
  'both default an unknown field to locked',
  fieldRisk('commission_rate') === 'locked' && flat(editsCode).includes("else 'locked' end"),
  'a column added next year would otherwise become editable by the driver it describes, on the day it is created',
);

check(
  'bank fields are refused here and pointed at the cooling window',
  flat(editsCode).includes('Bank details change through Payout settings'),
  'request_payout_change already keeps the old account receiving for 48 hours while the driver keeps working; a second mechanism would disagree with it',
);
check(
  'phone and email are refused rather than OTP-gated',
  flat(editsCode).includes('Contact support to change the % on a driver account'),
  'an OTP to a new number proves control of the new number, not of the old one — and guard_application_phone exists precisely to stop this',
);

check(
  'a high-risk edit is refused while a parcel is in hand',
  flat(editsCode).includes(
    "where driver_id = actor and status not in ('Delivered', 'Cancelled')",
  ) && flat(editsCode).includes('Finish or release your current trip'),
  'advance_booking requires is_approved_driver, so suspending mid-delivery strands a parcel the driver cannot deliver and a recipient is waiting for',
);
check(
  'and a high-risk edit sends the application back for review',
  flat(editsCode).includes("case when has_high then 'under_review' else app.status end"),
);
check(
  'the whole patch is classified before anything is written',
  editsCode.indexOf('raise exception') < editsCode.indexOf('update public.driver_applications set'),
  'a patch mixing a low-risk and a locked field must be wholly refused, never half-applied',
);

check(
  'there is a history table with before and after',
  flat(editsCode).includes('create table if not exists public.driver_edit_history') &&
    flat(editsCode).includes('old_value text, new_value text'),
);
check(
  'nobody can write or delete it',
  !/create policy[^;]*driver_edit_history[^;]*for (insert|update|delete)/is.test(editsSql),
  'a trail a driver can edit would look complete while missing exactly the row that mattered',
);
check(
  'a driver can read their own',
  flat(editsCode).includes('using (driver_id = (select auth.uid()) or public.is_admin())'),
  'seeing a change they did not make is the earliest anyone finds out an account was taken over',
);
check(
  'the driver-facing view truncates the values',
  flat(editsCode).includes("'…' || right(h.old_value, 4)"),
  'old_value holds a NIN or a licence number when those change, and a history screen gets screenshotted',
);
check(
  'the general audit log records field names and not values',
  flat(editsCode).includes("jsonb_build_object('fields'"),
  'app_events is readable by more people than driver_edit_history is',
);

check(
  'the driver is warned before saving, not after',
  code(profile).includes('export function editWarning') &&
    /sends your account back for review/.test(profile),
  'a driver who taps Save and then discovers they are suspended has been ambushed by their own app, and cannot undo it',
);

check(
  'the vehicle colour column is created rather than assumed',
  flat(editsCode).includes('add column if not exists vehicle_colour text'),
  'it was classified before it existed; running the migration is what found that',
);

// ------------------------------------------------- the form a driver sees --

const sheet = read('src/components/ui/profile-edit-sheet.tsx');
const updates = read('src/app/(tabs)/driver-updates.tsx');

check(
  'only an approved or re-reviewing driver is offered the button',
  code(updates).includes(
    "application.status === 'approved' || application.status === 'under_review'",
  ),
  'before approval the submitted form is still the way to change things, and two edit paths onto one row disagree',
);
check(
  'and it opens the sheet',
  code(updates).includes('<ProfileEditSheet') && code(updates).includes('setEditing(true)'),
);

/*
 * ⚠ The single most important assertion in this file.
 *
 *   `update_driver_profile` decides the consequence from the *keys* of the
 *   patch, before it reads a value. Posting the whole form back would put
 *   `full_name` in every patch, so a driver correcting a plate number would be
 *   suspended and unable to accept work — for a change they did not make.
 */
check(
  'only changed fields are sent',
  code(sheet).includes('changedFields(original, draft)'),
  'sending the whole form would suspend a driver for editing their vehicle colour',
);
check(
  'and the diff ignores whitespace and empty-vs-null',
  changedFields({ a: 'x ' }, { a: 'x' }).a === undefined &&
    changedFields({ a: null }, { a: '' }).a === undefined,
  'a stray space from a keyboard suggestion is not an edit, and suspending somebody over an invisible character is indefensible',
);
check(
  'a real change is still detected',
  changedFields({ a: 'x' }, { a: 'y' }).a === 'y' &&
    Object.keys(changedFields({ a: 'x', b: 'q' }, { a: 'x', b: 'r' })).length === 1,
);

check(
  'the risk shown is the risk of the diff, not of the form',
  code(sheet).includes('patchRisk(patch)') && code(sheet).includes('editWarning(patch)'),
);
/*
 * "States the cost *first*" is now tested as an ordering, not as a spelling.
 *
 * This pinned the literal words "changing these pauses your approval", and a
 * redesign that reworded it to "changing any of these pauses your approval"
 * failed the check while satisfying every word of its intent. The property that
 * matters is positional: the consequence appears in the always-visible header,
 * above the `identityOpen &&` guard, so it cannot be a sentence a driver only
 * reads after expanding the thing it warns about.
 */
const identityGate = code(sheet).search(/pauses your approval/i);
const identityBody = code(sheet).search(/identityOpen &&/);
check(
  'identity fields sit behind a disclosure that states the cost first',
  code(sheet).includes('setIdentityOpen') &&
    identityGate > 0 &&
    identityBody > 0 &&
    identityGate < identityBody,
  'a driver who never opens it cannot suspend themselves by tabbing through the form',
);
check(
  'the save button says which of the two things it will do',
  code(sheet).includes("'Save and send for review'") && code(sheet).includes("'Save changes'"),
);
check(
  'and is inert until something actually differs',
  code(sheet).includes('disabled={busy || !dirty}') && code(sheet).includes("'No changes yet'"),
);

/*
 * The destination moved, so this assertion had to.
 *
 * It pinned "Payout settings" against the *uncommented* file, and passed on a
 * stale code comment long after the payout card left the driver portal for the
 * Wallet. Checking `code(sheet)` means the sentence a driver reads is the one
 * under test, and the sentence now has to name where the control actually is.
 */
check(
  'locked fields are shown with somewhere to go, not hidden',
  /Driver Wallet/.test(code(sheet)) && /contact support/i.test(code(sheet)),
  'a driver hunting for bank details in a form that omits them concludes the app is broken',
);
/*
 * Each banner must give a *consequence*, not just a fact.
 *
 * The first version of this pinned "already assigned to", which survived
 * deleting the sentence that explains why that matters — the phrase sat on the
 * line above the one the mutation removed. "Your phone is locked because we use
 * it for parcels" is a rule; "a change mid-delivery can send a pickup alert to
 * a number that is no longer yours" is a reason, and only the second one makes
 * somebody accept the lock rather than resent it.
 */
/*
 * A locked field must show its VALUE, not merely be described.
 *
 * The first version of this sheet had two prose banners saying bank and contact
 * details are managed elsewhere. That answers "can I change this here?" and
 * leaves the commoner question — "what does Package Relay actually have on file for me?"
 * — unanswered, so a driver who suspected a wrong phone number had no way to
 * check it from the one screen about their own details.
 *
 * Asserted on the reader functions rather than on rendered strings: the values
 * come off the application object, and `read: (a) => a.phone` is the thing that
 * would be deleted if somebody reverted this to prose.
 */
const lockedReaders = [...code(sheet).matchAll(/read: \(a\) => ([\w.()]+)/g)].map((m) => m[1]);
check(
  'every locked field displays what is on file',
  ['a.phone', 'a.email', 'a.bankName', 'a.accountName', 'a.state'].every((reader) =>
    lockedReaders.includes(reader),
  ),
  `found: ${lockedReaders.join(', ')}`,
);
check(
  'the account number is masked rather than shown in full',
  /read: \(a\) => maskAccount\(a\.accountNumber\)/.test(code(sheet)),
  'this sheet is opened in hubs and on shared screens; the last four confirm the account without exposing it',
);
/*
 * Declared *and rendered*.
 *
 * The check above only proves the reader functions exist. Mutation testing
 * showed that passing `rows={[]}` to the payout group satisfied it completely —
 * every reader still declared, none of them on screen. What has to be asserted
 * is the wiring: each group receives its own list, and something actually draws
 * a row from it.
 */
check(
  'and both locked groups are handed their rows',
  /rows=\{CONTACT_ROWS\}/.test(code(sheet)) && /rows=\{PAYOUT_ROWS\}/.test(code(sheet)),
  'a group rendered with an empty list declares every value and shows none',
);
/*
 * Pinned to the map, not to the component name.
 *
 * `/<LockedValue/` passed while the two groups were gutted, because one lone
 * `<LockedValue>` survived elsewhere on the form — the state row inside
 * Personal details. The property under test is that a group turns *each of its
 * rows* into a displayed value.
 */
check(
  'a locked group draws every row as a value, not as a disabled input',
  /rows\.map\(\(row\) => \(?\s*<LockedValue/.test(code(sheet)) &&
    !/<Field[\s\S]{0,200}editable=\{false\}/.test(code(sheet)),
  'a greyed-out text box still reads as a box you should be able to type in',
);

check(
  'and each locked field is explained on its own terms',
  /verification window/i.test(code(sheet)) &&
    /no payment is ever paused|continues to receive/i.test(code(sheet)) &&
    /already assigned to/i.test(code(sheet)) &&
    /pickup alert|no longer belongs|mid-delivery/i.test(code(sheet)),
  'bank details are locked by a money control and contact details by an operational one; one merged paragraph makes the driver work out which applies to them',
);
check(
  'and no locked field is rendered as an input',
  (() => {
    /*
     * `key: 'x', label:` rather than `key: 'x'`.
     *
     * The looser pattern also swept up the *section* keys once the form grew
     * headings — 'vehicle', 'personal', 'kin' — which are unknown to
     * `fieldRisk` and therefore classify as locked, failing the check on a
     * form that was entirely correct. Only a spec carrying a `label` is a
     * rendered input.
     */
    const fields = [...code(sheet).matchAll(/key: '(\w+)',\s+label:/g)].map((m) => m[1]);
    return fields.length >= 8 && fields.every((field) => fieldRisk(field) !== 'locked');
  })(),
  'an editable box for a field the server refuses is a promise the save button cannot keep',
);

check(
  'the server refusal is shown verbatim',
  code(sheet).includes('setError(outcome.error)'),
  'each one names the next action: finish your trip, use Payout settings, contact support',
);
check(
  'the sheet does not nest a scroll container',
  !code(sheet).includes('ScrollView'),
  'BottomSheet already scrolls; nesting two collapses the inner one on web',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — the phone lock holds in the database and not just the form, the old payout account\n' +
    '       keeps receiving transfers for the whole 48 hours, an identity mismatch flags for a\n' +
    '       human instead of rejecting a driver whose NIMC photo has aged, and the unassigned\n' +
    '       breakdown counts only parcels that are genuinely unassigned.',
);
