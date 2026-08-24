/**
 * Assertions for the two multi-step forms.
 *
 * A wizard has one failure mode that a single-page form cannot have: a field
 * that belongs to no step. It renders nowhere, so it can never be filled in;
 * `validate` still refuses it, so Submit fails; and because the message is
 * scoped to a step nobody can reach, the button appears to do nothing at all.
 * That is unfindable from the outside and trivially detectable from here.
 *
 * So the centrepiece is a partition check — every field on exactly one step,
 * derived from both files rather than transcribed. Everything else guards the
 * navigation around it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const driver = read('src/app/(tabs)/driver-signup.tsx');
const book = read('src/app/(tabs)/book.tsx');
const wizard = read('src/components/ui/form-wizard.tsx');

/**
 * The keys of a `type X = { … }` declaration.
 *
 * Read from the source rather than imported: these are local types in screen
 * files, and exporting them purely so a test could see them would change the
 * shape of the thing being tested.
 */
function typeKeys(source: string, typeName: string): string[] {
  const start = source.indexOf(`type ${typeName} = {`);
  if (start === -1) return [];
  const end = source.indexOf('\n};', start);
  const body = code(source.slice(start, end));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);
}

/** The arrays inside `const STEP_FIELDS: … = [ … ];`. */
function stepFields(source: string): string[][] {
  const start = source.indexOf('const STEP_FIELDS');
  const end = source.indexOf('\n];', start);
  const body = source.slice(start, end);

  return body
    .split('[')
    .slice(2)
    .map((chunk) => [...chunk.split(']')[0].matchAll(/'(\w+)'/g)].map((m) => m[1]))
    .filter((group) => group.length > 0);
}

// ------------------------------------------------ the driver application --

const signupKeys = typeKeys(driver, 'SignupForm');
const driverSteps = stepFields(driver);

/*
 * A floor, not an exact count.
 *
 * My first version said `> 20` and failed on the true figure of twenty, which
 * is the sort of assertion that gets "fixed" by loosening it until it means
 * nothing. The count is not the property — the partition below is — so this
 * only guards against the parser silently returning an empty list, which would
 * make every check after it vacuously true.
 */
check('SignupForm parsed', signupKeys.length >= 15, `${signupKeys.length} fields`);
check('the driver form has three steps', driverSteps.length === 3, `${driverSteps.length}`);

const driverAssigned = driverSteps.flat();

/*
 * ⚠ The partition. This is the assertion the file exists for.
 *
 *   A field on NO step is invisible and unfillable, while `validate` goes on
 *   refusing it — so Submit fails with a message on a page that does not exist.
 *   A field on TWO steps is validated twice and shown twice, which is merely
 *   confusing.
 *
 *   Checked in both directions because each catches a different mistake: adding
 *   a field to `SignupForm` and forgetting the step list, or renaming one in the
 *   step list and leaving the old name behind.
 */
const driverMissing = signupKeys.filter((key) => !driverAssigned.includes(key));
const driverUnknown = driverAssigned.filter((key) => !signupKeys.includes(key));
const driverDuplicated = driverAssigned.filter((key, i) => driverAssigned.indexOf(key) !== i);

check(
  'every driver field belongs to a step',
  driverMissing.length === 0,
  `${driverMissing.join(', ')} would render nowhere and still be validated on submit`,
);
check(
  'and no step claims a field that does not exist',
  driverUnknown.length === 0,
  driverUnknown.join(', '),
);
check('and none is claimed twice', driverDuplicated.length === 0, driverDuplicated.join(', '));

/*
 * The grouping asked for. Pinned loosely — the exact ordering within a step is
 * a design decision that may move — but the three headline groupings are the
 * brief and should not drift silently.
 */
check(
  'step one is the applicant and their vehicle',
  [
    'fullName',
    'phone',
    'email',
    'nin',
    'address',
    'state',
    'vehicleType',
    'plateNumber',
    'licenseId',
  ].every((key) => driverSteps[0].includes(key)),
  driverSteps[0].join(', '),
);
check(
  'step two is the two other people',
  driverSteps[1].every((key) => key.startsWith('guarantor') || key.startsWith('kin')),
  driverSteps[1].join(', '),
);
check(
  'step three is the money',
  ['bankName', 'accountNumber', 'accountName'].every((key) => driverSteps[2].includes(key)),
  driverSteps[2].join(', '),
);

/*
 * Documents live on the last step and are folded in by `errorsForStep` rather
 * than listed in `STEP_FIELDS` — they are not `SignupForm` keys. Without that
 * fold a missing licence would be refused by submit and reported nowhere.
 */
check(
  'document errors are folded into the last step',
  /if \(step === STEPS\.length - 1\)/.test(code(driver)) && /\$\{doc\.key\}Expiry/.test(driver),
  'a missing document would otherwise fail submit with its message on no page at all',
);

// ------------------------------------------------------- post a parcel --

const bookingKeys = typeKeys(book, 'BookingForm');
const bookSteps = stepFields(book);

check('BookingForm parsed', bookingKeys.length >= 15, `${bookingKeys.length} fields`);
check('the booking form has three steps', bookSteps.length === 3, `${bookSteps.length}`);

const bookAssigned = bookSteps.flat();

/*
 * `deliveryType` is exempt, and it is the only exemption.
 *
 * It is the pill toggle at the top of the form — live on all three pages — and
 * a segmented control has no invalid state, so no step needs to validate it.
 * Named explicitly rather than filtered by a rule, so a second exemption has to
 * be argued for here rather than slipped in.
 */
const ALWAYS_VISIBLE_FIELDS = ['deliveryType'];

const bookMissing = bookingKeys.filter(
  (key) => !bookAssigned.includes(key) && !ALWAYS_VISIBLE_FIELDS.includes(key),
);
const bookUnknown = bookAssigned.filter((key) => !bookingKeys.includes(key));
const bookDuplicated = bookAssigned.filter((key, i) => bookAssigned.indexOf(key) !== i);

check(
  'every booking field belongs to a step',
  bookMissing.length === 0,
  `${bookMissing.join(', ')} would render nowhere and still be validated on submit`,
);
check(
  'and no step claims a field that does not exist',
  bookUnknown.length === 0,
  bookUnknown.join(', '),
);
check('and none is claimed twice', bookDuplicated.length === 0, bookDuplicated.join(', '));

/*
 * ⚠ The second half of this used to require the toggle to sit *above the
 *   scroller*. It scrolls with the form now — see `verify-layout` for why — so
 *   what is asserted is the property that survived the move: it is outside
 *   every step's conditional, and therefore on screen on all three pages.
 *
 *   Dropping it into a step would be the real failure. It changes the price and
 *   the shape of every question below it, so a copy that only exists on page
 *   one leaves pages two and three unable to say which delivery this is.
 */
check(
  'the delivery toggle is on every step rather than dropped onto one',
  !bookAssigned.includes('deliveryType') &&
    code(book).indexOf('<SegmentedControl') < code(book).indexOf('{step === 0 &&'),
  'it changes the price of every question below it, so it belongs above all three steps',
);

/*
 * ⚠ This asserted that the NIN was validated on the step that asked for it.
 *
 *   No step asks for it now — it moved to the profile, so a sender is never
 *   interrupted mid-booking by a government ID check. The guard the old
 *   assertion protected (reaching the last page and being sent back two) is
 *   preserved by there being nothing to be sent back *for*, which is what is
 *   asserted instead. `verify-liveness` covers where the check went.
 */
check(
  'no step gates on identity any more',
  !/identityPath/.test(code(book)),
  'a booking form that branches on verification will eventually branch into a refusal',
);

// -------------------------------------------- the rendered steps, not the list --

/*
 * ⚠ Everything above compares two hand-written lists. This compares the lists
 *   to the JSX, which is the only thing a person actually sees.
 *
 *   `STEP_FIELDS` saying `fullName` belongs to step one proves nothing about
 *   where the input is rendered. A field could be validated by step one and
 *   drawn on step three — so Next refuses it on a page where it does not exist,
 *   which is precisely the dead end this whole file is about, arrived at from
 *   the other direction.
 *
 * The slices are crude on purpose: from `{step === N && (` to the start of the
 * next step block. That is exactly what React renders for that step, so a field
 * outside its slice is a field on the wrong page.
 */
function stepBlocks(source: string): string[] {
  const body = code(source);
  const starts = [0, 1, 2].map((index) => body.indexOf(`{step === ${index} && (`));
  if (starts.some((at) => at === -1)) return [];

  return starts.map((at, index) => {
    const end = index === 2 ? body.indexOf('<WizardNav', at) : starts[index + 1];
    return body.slice(at, end);
  });
}

for (const [name, source, groups] of [
  ['driver', driver, driverSteps],
  ['booking', book, bookSteps],
] as const) {
  const blocks = stepBlocks(source);

  check(`${name}: three rendered step blocks`, blocks.length === 3, `${blocks.length}`);

  if (blocks.length !== 3) continue;

  const misplaced: string[] = [];
  for (const [index, keys] of groups.entries()) {
    for (const key of keys) {
      /*
       * `form.<key>` is how every input on both screens reads its value, so its
       * presence is a reliable proxy for the field being rendered. Fields the
       * form derives rather than binds — a mode toggle that writes two keys at
       * once — are skipped rather than guessed at.
       */
      const token = `form.${key}`;
      if (!source.includes(token)) continue;

      const renderedHere = blocks[index].includes(token);
      const renderedElsewhere = blocks.some((block, i) => i !== index && block.includes(token));

      if (!renderedHere && renderedElsewhere) {
        misplaced.push(`${key}: validated on step ${index + 1}, rendered on another`);
      }
    }
  }

  check(
    `${name}: no field is validated on one step and drawn on another`,
    misplaced.length === 0,
    misplaced.join('\n       '),
  );
}

// ------------------------------------------------------------ navigation --

for (const [name, source] of [
  ['driver', driver],
  ['booking', book],
] as const) {
  check(
    `${name}: Next validates rather than being disabled`,
    /const goNext = \(\) => \{/.test(code(source)) &&
      !/onNext=\{goNext\}[\s\S]{0,120}disabled=\{[^}]*Object\.keys/.test(code(source)),
    'a dead Next on a form of thirty fields says nothing about which one is wrong',
  );
  check(
    `${name}: only this step's errors are written`,
    /setErrors\(\(previous\) => \(\{ \.\.\.previous, \.\.\.mine \}\)\)/.test(code(source)),
    'writing all of them marks fields red on pages the person has not reached',
  );
  check(
    `${name}: a failed submit lands on the step that has the problem`,
    /setStep\(firstBad\)/.test(code(source)),
    'otherwise the button appears to do nothing and the message is two pages away',
  );
  check(
    `${name}: Back exists from step two onward and not before`,
    /onBack=\{step > 0 \? goBack : undefined\}/.test(code(source)),
    'a disabled Back on step one is a control that exists to be refused',
  );
}

// ----------------------------------------------------------- confirmation --

check(
  'the driver confirmation says what it confirms',
  /I confirm that all provided details, documents, and bank information are accurate and belong to me\./.test(
    driver,
  ),
);
/*
 * Matched loosely on purpose.
 *
 * The gate has grown a third term — the live photo — and will plausibly grow a
 * fourth. What this check is for is that ticking the box is *necessary*, not
 * that the expression has a particular shape, so it asserts `!confirmed` is in
 * the disabled expression and leaves the rest of it alone.
 */
check(
  'and gates Submit',
  /disabled=\{[\s\S]{0,120}!confirmed/.test(code(driver)),
  'the checkbox is the whole point of the last step',
);
check(
  'as does the live photo',
  /disabled=\{[\s\S]{0,120}!photoSession/.test(code(driver)),
  'an application with no selfie is one nobody can match against a NIN',
);

check(
  'the booking confirmation says what it confirms',
  /I confirm that all provided parcel details, sender identification, and delivery information are accurate\./.test(
    book,
  ),
);
check(
  'and gates Post parcel',
  /onPress=\{handleSubmit\}\s*\n\s*disabled=\{!confirmed/.test(code(book)),
);
check(
  'as does the live photo',
  /disabled=\{[\s\S]{0,120}!photoSession/.test(code(book)),
  'every LOCI parcel is supposed to carry a photo of whoever posted it',
);

/*
 * Both checkboxes sit *after* the last thing worth reading — the documents on
 * the driver form, the live cost summary on the booking form. A confirmation
 * above the number it confirms is one that gets ticked before the number is
 * seen.
 */
check(
  'the booking checkbox comes after the cost summary',
  code(book).indexOf('4 — Summary') < code(book).indexOf('<ConfirmCheckbox'),
  'ticking before the estimate has been seen is confirming a number nobody read',
);

// --------------------------------------------------------- the indicator --

check(
  'the progress indicator says which step of how many',
  /Step \{current \+ 1\} of \{steps\.length\}/.test(wizard),
);
check(
  'a completed step is marked with a tick, not only a fill',
  /done \? \(\s*<Check/.test(wizard),
  'colour alone fails WCAG 1.4.1, and three small dots differ by fill almost invisibly',
);
check(
  'and it can only jump backwards',
  /const reachable = done && onJump;/.test(code(wizard)),
  'jumping forward skips the validation that gates Next',
);

check(
  'both forms use the one wizard rather than a copy each',
  /from '@\/components\/ui\/form-wizard'/.test(driver) &&
    /from '@\/components\/ui\/form-wizard'/.test(book),
  'written twice, the half that drifts is always the validation',
);

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failing assertion${failures === 1 ? '' : 's'}.`);
  process.exit(1);
}

console.log(
  'PASS — every field on both forms belongs to exactly one step, so none can render\n' +
    '       nowhere while still being refused on submit; Next validates instead of going\n' +
    '       dead, a failed submit lands on the step that has the problem, and each\n' +
    '       confirmation sits after the last thing worth reading and gates its button.',
);
