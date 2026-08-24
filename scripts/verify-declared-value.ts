/**
 * Assertions for the declared value, now that a parcel cannot be posted without one.
 *
 * ⚠ This rule decides two things at once, and only one of them is a form field.
 *
 *   It gates the wizard, which is what was asked for. It also sets the
 *   insurance — 1% of this number — and therefore the payout ceiling if the
 *   parcel is lost. A bug that lets a blank through does not show up as a
 *   validation problem; it shows up months later as a parcel with no cover and
 *   nothing to pay out against.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  declaredValueError,
  DECLARED_VALUE_CEILING,
  estimateFee,
  PRICING,
} from '../src/store/bookings';

let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

// ---------------------------------------------------------- what it refuses --

/*
 * ⚠ Every shape of "nothing", not just the empty string.
 *
 *   The field formats as you type, so what reaches the rule can be a stray
 *   comma, a lone naira sign, or spaces from a paste. Each of these parses to
 *   zero and each would have travelled uninsured.
 */
for (const blank of ['', '   ', '\t', '0', '0.00', '₦0', ',', '₦', '00']) {
  check(
    `${JSON.stringify(blank)} is refused`,
    declaredValueError(blank) !== null,
    'this parses to nothing, and a parcel worth nothing has no cover and no payout',
  );
}

check(
  'a negative value is refused',
  declaredValueError('-5000') !== null,
  'a negative declared value would subtract from the fare',
);
check(
  'text is refused',
  declaredValueError('a lot') !== null,
  'NaN reaching the insurance multiplication makes the whole fare NaN',
);
check(
  'and so is a value above the ceiling',
  declaredValueError(String(DECLARED_VALUE_CEILING + 1)) !== null,
  'above this it is an underwriting conversation, not a form',
);

// ----------------------------------------------------------- what it allows --

for (const good of ['1', '500', '45,000', '₦45,000', '45000.50', String(DECLARED_VALUE_CEILING)]) {
  check(`${JSON.stringify(good)} is accepted`, declaredValueError(good) === null);
}

/*
 * ⚠ No invented floor.
 *
 *   ₦500 is a real declaration for a document or a returned charger, and
 *   refusing it would push somebody into overstating a parcel's value to get
 *   past the form. Under-declaring is deterred by the payout being capped at
 *   what was declared, not by a minimum here.
 */
check(
  'a genuinely cheap parcel is not forced upwards',
  declaredValueError('500') === null,
  'a floor would make somebody overstate a parcel to get past the form',
);

// ------------------------------------------------ the wizard actually stops --

const book = read('src/app/(tabs)/book.tsx');

/*
 * ⚠ Being in `STEP_FIELDS[0]` is what turns an error into a closed gate.
 *
 *   `goNext` validates the whole form and then keeps only the errors belonging
 *   to the current step. A `declaredValue` error on a field listed under step
 *   two would be computed, discarded, and Next would open anyway — the rule
 *   working perfectly and the gate wide open.
 */
/*
 * The first inner array, sliced from the `= [` rather than from the
 * declaration — the type annotation is `(keyof BookingForm)[][]`, so searching
 * for the first `]` lands inside the types and slices away the whole list.
 * That version failed against correct code.
 */
const arrayAt = book.indexOf('= [', book.indexOf('const STEP_FIELDS'));
const firstStep = book.slice(arrayAt, book.indexOf('],', arrayAt));
check(
  'declaredValue belongs to the step it is rendered on',
  firstStep.includes("'declaredValue'"),
  'an error on another step is filtered out by errorsForStep and Next opens regardless',
);

check(
  'the form asks the shared rule rather than repeating it',
  book.includes('declaredValueError(form.declaredValue)'),
  'a second copy of this rule is a second one to forget to tighten',
);
check(
  'and refuses on its answer',
  /const badValue = declaredValueError\(form\.declaredValue\);[\s\S]{0,120}errors\.declaredValue = badValue/.test(
    book,
  ),
  'computing the error without assigning it is the shape this bug takes',
);

/*
 * ⚠ The old wording said the wrong thing about what it was for.
 *
 *   "For insurance" reads as a note about an optional extra. It is the basis of
 *   the cover *and* the ceiling on any payout, and somebody choosing a number
 *   needs to know the second part.
 */
check(
  'the field says what the number does',
  book.includes('sets the cover and the payout'),
  'somebody picking a number to get past the form should know it caps their claim',
);

// -------------------------------------- and the quote admits it is short ----

/*
 * ⚠ The quick quote does not ask for a declared value, so it now under-quotes.
 *
 *   Three fields is the point of that form, and a fourth would defeat it. But
 *   a quote that is systematically below the price charged is the kind of thing
 *   somebody discovers at the moment they are asked to pay, so it says so.
 */
const quote = read('src/components/ui/quick-quote.tsx');
check(
  'the quick quote says it excludes insurance',
  quote.includes('Before insurance'),
  'the booking now always adds 1%, so a silent quote is always a little low',
);

const insured = estimateFee({
  deliveryType: 'local',
  weight: 2,
  declaredValue: 45_000,
});
const uninsured = estimateFee({ deliveryType: 'local', weight: 2, declaredValue: 0 });
check(
  'and the gap it is warning about is the insurance, exactly',
  insured.total - uninsured.total === 45_000 * PRICING.insuranceRate,
  `₦${insured.total - uninsured.total} against ₦${45_000 * PRICING.insuranceRate} — if these ever diverge the footnote is describing something else`,
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(
  'PASS — a parcel cannot leave the first step without a declared value above zero,\n' +
    '       every shape of blank is refused, a genuinely cheap parcel is not forced upwards,\n' +
    '       the rule is listed on the step it is rendered on so Next actually stops, and\n' +
    '       the quick quote admits it is quoted before insurance.',
);
