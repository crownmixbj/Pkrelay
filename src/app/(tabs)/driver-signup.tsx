import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import {
  Bike,
  Building2,
  Car,
  Check,
  CheckCircle2,
  CircleCheckBig,
  ClipboardCheck,
  Clock,
  FileCheck2,
  Banknote,
  Hash,
  HeartPulse,
  Landmark,
  LayoutDashboard,
  LogIn,
  MapPin,
  IdCard,
  Mail,
  PhoneCall,
  Truck,
  Upload,
  UserCheck,
  UserRound,
  Phone,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { errorMessage } from '@/lib/errors';
import { Footer } from '@/components/Footer';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import {
  ConfirmCheckbox,
  WizardNav,
  WizardProgress,
  type WizardStep,
} from '@/components/ui/form-wizard';
import { ExpiryField } from '@/components/ui/expiry-field';
import { parseExpiry } from '@/lib/expiry';
import { LiveSelfieCard } from '@/components/ui/live-selfie-card';
import {
  attachIdentityResult,
  identityLabel,
  runIdentityCheck,
  type IdentityOutcome,
} from '@/store/capture-session';
import { showDialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipGroup } from '@/components/ui/chip';
import { Dropdown } from '@/components/ui/dropdown';
import { AddressLookup } from '@/components/ui/address-lookup';
import { Field } from '@/components/ui/field';
import { ValidatedEmailInput } from '@/components/ValidatedEmailInput';
import { ValidatedPhoneInput } from '@/components/ValidatedPhoneInput';
import { isValidNigerianPhone, nigerianPhoneError } from '@/utils/validation';
import { SectionLabel } from '@/components/ui/screen';
import {
  FontSize,
  MaxContentWidth,
  PageCanvas,
  Radius,
  Spacing,
  Typography,
  font,
} from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  isValidEmail,
  isValidLicenceId,
  isValidNin,
  isValidNuban,
  isValidPlateNumber,
  GUARANTOR_RELATIONSHIPS,
  LICENCE_LENGTH,
  NEXT_OF_KIN_RELATIONSHIPS,
  NIGERIAN_BANKS,
  NUBAN_LENGTH,
  NIN_LENGTH,
} from '@/constants/driver-validation';
import { DEFAULT_STATE, NIGERIA_STATES, type NigeriaState } from '@/constants/nigeriaStates';
import { cityForState } from '@/store/bookings';
import { useSession } from '@/store/session';
import {
  submitApplication as insertApplication,
  STATUS_LABELS,
  workingDaysSince,
  REVIEW_WORKING_DAYS,
} from '@/store/driver-applications';
import { isSupabaseConfigured } from '@/lib/supabase';
import { uploadDocument } from '@/store/driver-documents';
import { recordDocument } from '@/store/documents';
import { useAuthGate } from '@/hooks/use-auth-gate';
import {
  displayRegisteredPhone,
  hasRegisteredPhone,
  phoneLockMessage,
  PHONE_LOCK_TITLE,
} from '@/store/registered-phone';
import { useFormDraft } from '@/hooks/use-form-draft';

const VEHICLE_TYPES = ['Motorcycle', 'Car', 'Van', 'Truck'] as const;
type VehicleType = (typeof VEHICLE_TYPES)[number];

const VEHICLE_ICONS: Record<VehicleType, typeof Truck> = {
  Motorcycle: Bike,
  Car: Car,
  Van: Truck,
  Truck: Truck,
};

/**
 * Documents the applicant must attach, in the order they're shown. Mocked — no
 * file picker is wired up.
 *
 * The list drives the rows, the state map, the validation loop and the mock
 * filenames, so adding one here is enough — there is nowhere else to register
 * a document.
 */
const DOCUMENTS = [
  {
    /*
      ⚠ Two slots, not one photo of both sides.

        This asked for "front and back, clearly readable" in a single upload,
        which in practice produces one of three things: the front only, a photo
        of both sides laid out on a table at an angle that renders neither
        readable, or two images the applicant could only attach one of. A
        reviewer then has to reject and re-ask, which costs days.

        Two slots also mean the *back* can be checked independently — it carries
        the expiry date and the class of vehicle, which is what the licence is
        being collected for.

      ⚠ The key stays `license`, US spelling. It has been the storage path and
        the jsonb key since the form shipped; see the note in `document_kinds`.
    */
    key: 'license',
    label: "Driver's licence — front",
    hint: 'The side with your photo. All four corners in frame.',
    file: 'drivers-licence-front',
    /*
      `expiry` mirrors `public.document_kinds` in 31_document_expiry.sql, and
      the server is the authority — `record_document` refuses a missing required
      date and refuses a date on a slot that has none. This copy exists so the
      form can show the right field rather than discover the rule by being told
      off after an upload.

        'required'  a lapsed one stops dispatch, so LOCI must know the date
        'optional'  it expires, but nothing breaks if it does
        'none'      no meaningful date; asking invites an invented one
    */
    expiry: 'required',
  },
  {
    /*
      The back of the licence, as its own slot.

      ⚠ No expiry field here, even though the date is printed on this side.

        One licence has one expiry, and it is already collected on the front
        slot above — which is also the row `document_kinds` marks as blocking
        dispatch. Asking again here would give a driver two boxes for one date
        and LOCI two answers to reconcile.
    */
    expiry: 'none',
    key: 'licenseBack',
    label: "Driver's licence — back",
    hint: 'The side with the expiry date and vehicle class.',
    file: 'drivers-licence-back',
  },
  {
    /*
      ⚠ NIN only, where this used to accept three documents.

        The hint offered "NIN slip, International Passport, or Voter's Card".
        Only the NIN is checked against a government record — `verify-liveness`
        matches a selfie against the NIMC photo for the applicant's NIN — so a
        passport in this slot produced a document nobody could verify and a
        reviewer approving on a glance.

        Narrowing it means some applicants have to go and find their slip. That
        is the cost, and it buys the difference between a document that was
        looked at and one that was checked.

      A NIN slip has no expiry printed on it. See `document_kinds`.
    */
    expiry: 'none',
    key: 'id',
    label: 'Your NIN slip',
    hint: 'NIN slip or NIN card only — the number must match the NIN you entered.',
    file: 'driver-nin-slip',
  },
  {
    expiry: 'none',
    key: 'guarantorId',
    label: "Guarantor's NIN slip",
    hint: 'NIN slip or NIN card only.',
    file: 'guarantor-nin-slip',
  },
  {
    expiry: 'none',
    key: 'vehicle',
    label: 'Vehicle picture',
    hint: 'Side-on, with the plate visible',
    file: 'vehicle-photo',
  },
  {
    expiry: 'required',
    key: 'insurance',
    label: 'Car insurance',
    hint: 'Valid certificate, showing the policy expiry date',
    file: 'car-insurance',
  },
] as const;

type DocumentKey = (typeof DOCUMENTS)[number]['key'];

type SignupForm = {
  fullName: string;
  phone: string;
  email: string;
  /** Required — pairs with the Government ID upload. */
  nin: string;
  /** The applicant's own residential address. */
  address: string;
  /** One of the 37, from `NIGERIA_STATES`. */
  state: NigeriaState;
  vehicleType: VehicleType;
  plateNumber: string;
  licenseId: string;

  // Guarantor — someone who vouches for the applicant.
  guarantorName: string;
  guarantorPhone: string;
  guarantorRelationship: GuarantorRelationship;
  guarantorAddress: string;
  /** Optional — blank is valid; 11 digits when supplied. */
  guarantorNin: string;

  // Where payouts land.
  bankName: BankName;
  accountNumber: string;
  accountName: string;

  // Next of kin, for emergencies.
  kinName: string;
  kinPhone: string;
  kinRelationship: KinRelationship;
};

type GuarantorRelationship = (typeof GUARANTOR_RELATIONSHIPS)[number];
type KinRelationship = (typeof NEXT_OF_KIN_RELATIONSHIPS)[number];
type BankName = (typeof NIGERIAN_BANKS)[number];

/** An attached document. `uri` is a local file path — nothing is uploaded yet. */
type AttachedDocument = { fileName: string; uri: string; size: number | null } | null;

/** Rejected client-side so a 40 MB scan doesn't sit in memory waiting for a backend. */
const MAX_DOCUMENT_MB = 10;
const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_MB * 1024 * 1024;

/**
 * Empty attachment map, derived from `DOCUMENTS` rather than written out. Two
 * hand-written copies of this had already drifted apart once; deriving it means
 * adding a slot can't leave one of them short a key.
 */
const NO_DOCUMENTS = Object.fromEntries(DOCUMENTS.map((doc) => [doc.key, null])) as Record<
  DocumentKey,
  AttachedDocument
>;

/**
 * Expiry errors get their own keys, `<documentKey>Expiry`.
 *
 * Sharing the document's key would mean a valid file with a bad date replaced
 * the attachment error and vice versa — one field, two independent problems,
 * and only ever one of them visible.
 */
type ExpiryErrorKey = `${DocumentKey}Expiry`;

type FieldErrors = Partial<Record<keyof SignupForm | DocumentKey | ExpiryErrorKey, string>>;

/**
 * The application, in three sittings.
 *
 * ⚠ The grouping is by *who is being asked about*, not by which card the field
 *   used to live in.
 *
 *   One page held every field, and the length of it was the problem: thirty
 *   inputs is a wall, and an applicant who gets halfway has no idea how much is
 *   left. Splitting it also lets the guarantor and next-of-kin questions sit
 *   together — they are the two people who are not the applicant, and asking
 *   for them in one place makes the reason obvious.
 *
 * ⚠ Every key here must appear in `SignupForm` or `DOCUMENTS`, and every one of
 *   those must appear here exactly once. A field on no step cannot be filled in
 *   and cannot be corrected; a field on two steps would be validated twice and
 *   shown twice. `verify-drivers` asserts the partition rather than trusting it.
 */
const STEPS: WizardStep[] = [
  { key: 'you', label: 'You & vehicle' },
  { key: 'people', label: 'Guarantor & kin' },
  { key: 'money', label: 'Payout & documents' },
];

/** Which form fields each step is responsible for validating. */
const STEP_FIELDS: (keyof SignupForm)[][] = [
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
  ],
  [
    'guarantorName',
    'guarantorPhone',
    'guarantorRelationship',
    'guarantorAddress',
    'guarantorNin',
    'kinName',
    'kinPhone',
    'kinRelationship',
  ],
  ['bankName', 'accountNumber', 'accountName'],
];

/**
 * Whether a step is complete, and what is wrong if it is not.
 *
 * Runs the whole `validate` and keeps only this step's keys, so the per-step
 * check and the submit check can never disagree about what a valid NIN is. The
 * alternative — a second, smaller validator per step — is how a form ends up
 * letting somebody past a field that submit then refuses.
 *
 * Documents belong to the last step, so their errors (and their expiry errors)
 * are folded in there rather than listed above.
 */
function errorsForStep(step: number, all: FieldErrors): FieldErrors {
  const keys = new Set<string>(STEP_FIELDS[step] ?? []);

  if (step === STEPS.length - 1) {
    for (const doc of DOCUMENTS) {
      keys.add(doc.key);
      keys.add(`${doc.key}Expiry`);
    }
  }

  const mine: FieldErrors = {};
  for (const [key, message] of Object.entries(all)) {
    if (keys.has(key)) mine[key as keyof FieldErrors] = message;
  }
  return mine;
}

const INITIAL_FORM: SignupForm = {
  fullName: '',
  phone: '',
  email: '',
  nin: '',
  address: '',
  state: DEFAULT_STATE,
  vehicleType: 'Motorcycle',
  plateNumber: '',
  licenseId: '',
  guarantorName: '',
  guarantorPhone: '',
  guarantorRelationship: 'Employer',
  guarantorAddress: '',
  guarantorNin: '',
  bankName: 'Access Bank',
  accountNumber: '',
  accountName: '',
  kinName: '',
  kinPhone: '',
  kinRelationship: 'Spouse',
};

function validate(
  form: SignupForm,
  documents: Record<DocumentKey, AttachedDocument>,
  expiries: Record<string, string>,
): FieldErrors {
  const errors: FieldErrors = {};

  const name = form.fullName.trim();
  if (!name) {
    errors.fullName = 'Full name is required';
  } else if (name.split(/\s+/).length < 2) {
    errors.fullName = 'Enter both your first and last name';
  }

  const phone = form.phone.trim();
  if (!phone) {
    errors.phone = 'Phone number is required';
  } else if (!isValidNigerianPhone(phone)) {
    errors.phone = nigerianPhoneError(phone) ?? 'Enter a valid Nigerian number';
  }

  const email = form.email.trim();
  if (!email) {
    errors.email = 'Email is required';
  } else if (!isValidEmail(email)) {
    errors.email = 'Enter a valid email address';
  }

  // Required. `isValidNin` treats blank as valid — it was written when this
  // field was optional — so emptiness is checked separately, same as the
  // guarantor's NIN below.
  if (!form.nin.trim()) {
    errors.nin = 'NIN is required';
  } else if (!isValidNin(form.nin)) {
    errors.nin = `NIN must be exactly ${NIN_LENGTH} digits`;
  }

  // Same 10-character floor as the guarantor's address: enough to reject "Lagos"
  // or "n/a" without demanding a format Nigerian addresses don't have.
  if (!form.address.trim()) {
    errors.address = 'Address is required';
  } else if (form.address.trim().length < 10) {
    errors.address = 'Enter your full residential address';
  }

  const plate = form.plateNumber.trim();
  if (!plate) {
    errors.plateNumber = 'Plate number is required';
  } else if (!isValidPlateNumber(plate)) {
    errors.plateNumber = 'Enter a valid plate, e.g. ABC-123DE';
  }

  const licenseId = form.licenseId.trim();
  if (!licenseId) {
    errors.licenseId = 'Licence ID is required';
  } else if (!isValidLicenceId(licenseId)) {
    errors.licenseId = `Licence ID must be exactly ${LICENCE_LENGTH} letters or numbers`;
  }

  // Guarantor
  if (!form.guarantorName.trim()) {
    errors.guarantorName = "Guarantor's name is required";
  } else if (form.guarantorName.trim().split(/\s+/).length < 2) {
    errors.guarantorName = 'Enter their first and last name';
  }
  if (!form.guarantorPhone.trim()) {
    errors.guarantorPhone = "Guarantor's phone is required";
  } else if (!isValidNigerianPhone(form.guarantorPhone)) {
    errors.guarantorPhone =
      nigerianPhoneError(form.guarantorPhone) ?? 'Enter a valid Nigerian number';
  }
  // Required. `isValidNin` treats blank as valid because the applicant's own
  // NIN is optional, so emptiness has to be checked separately here.
  if (!form.guarantorNin.trim()) {
    errors.guarantorNin = "Guarantor's NIN is required";
  } else if (!isValidNin(form.guarantorNin)) {
    errors.guarantorNin = `NIN must be exactly ${NIN_LENGTH} digits`;
  }

  if (form.guarantorAddress.trim().length < 10) {
    errors.guarantorAddress = 'Enter their full residential address';
  }

  // Payout account
  if (!form.accountNumber.trim()) {
    errors.accountNumber = 'Account number is required';
  } else if (!isValidNuban(form.accountNumber)) {
    errors.accountNumber = `NUBAN account numbers are ${NUBAN_LENGTH} digits`;
  }
  if (!form.accountName.trim()) {
    errors.accountName = 'Account name is required';
  }

  // Next of kin
  if (!form.kinName.trim()) {
    errors.kinName = "Next of kin's name is required";
  }
  if (!form.kinPhone.trim()) {
    errors.kinPhone = "Next of kin's phone is required";
  } else if (!isValidNigerianPhone(form.kinPhone)) {
    errors.kinPhone = nigerianPhoneError(form.kinPhone) ?? 'Enter a valid Nigerian number';
  }

  for (const doc of DOCUMENTS) {
    if (!documents[doc.key]) {
      errors[doc.key] = `Attach your ${doc.label.toLowerCase()}`;
      continue;
    }

    /*
      The date is only checked once the file is attached.

      Reporting "attach your licence" and "give the licence expiry date" at the
      same time on an empty slot is two errors for one omission, and the second
      one is unanswerable until the first is fixed.
    */
    if (doc.expiry === 'none') continue;

    const parsed = parseExpiry(expiries[doc.key] ?? '');

    /*
      Written without naming 'optional', which no slot currently uses.

      The previous version had a branch for it, and once the government ID slots
      became dateless TypeScript could prove that branch unreachable — dead code
      that would have quietly stopped validating the day somebody added an
      optional slot back. Phrased this way both rules hold whatever the slot is:
      a date that parses badly is always an error, and a missing one is an error
      only where it was required.
    */
    if (parsed.ok === false) {
      errors[`${doc.key}Expiry` as keyof FieldErrors] = parsed.error;
    } else if (doc.expiry === 'required' && parsed.ok !== true) {
      errors[`${doc.key}Expiry` as keyof FieldErrors] =
        `Give the expiry date on your ${doc.label.toLowerCase()}`;
    }
  }

  return errors;
}

/** Mock reference, e.g. DRV-4821. Stands in for a server-issued application ID. */
function generateReference(): string {
  return `DRV-${Math.floor(1000 + Math.random() * 9000)}`;
}

export default function DriverSignupScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { registerDriver, user, refreshDriverStatus, application } = useSession();

  /*
   * The account's number, and whether there is one to lock to.
   *
   * An account created before sign-up captured a phone has none — those keep an
   * editable field, because a locked empty field is a form nobody can submit.
   */
  const registeredPhone = user?.phone ?? '';
  const phoneLocked = hasRegisteredPhone(registeredPhone);
  const [phoneLockOpen, setPhoneLockOpen] = useState(false);

  /*
   * The live selfie and its NIN match, taken on page three.
   *
   * ⚠ Not written to the saved draft.
   *
   *   `useFormDraft` keeps thirty fields alive across a trip to sign-in, and a
   *   capture session must not be one of them: it belongs to the account that
   *   opened it and is spent once. A restored one would put a green tick on a
   *   photograph that no longer exists.
   */
  const [photoSession, setPhotoSession] = useState<string | null>(null);
  const [identityOutcome, setIdentityOutcome] = useState<IdentityOutcome | null>(null);
  const { requireAuth, isAuthenticated } = useAuthGate();

  const [form, setForm] = useState<SignupForm>(INITIAL_FORM);

  /*
   * Prepopulate from the account.
   *
   * Runs on the registered number rather than once on mount, because the
   * session restores asynchronously — on a cold start this component renders
   * before `user` exists, and a mount-only effect would leave the field empty
   * for exactly the people it is meant to fill it for.
   */
  useEffect(() => {
    if (!phoneLocked) return;
    setForm((previous) => {
      const wanted = displayRegisteredPhone(registeredPhone);
      return previous.phone === wanted ? previous : { ...previous, phone: wanted };
    });
  }, [phoneLocked, registeredPhone]);

  /*
   * The account's email, filled in for them.
   *
   * ⚠ Filled, not locked, and only when the field is empty.
   *
   *   The phone above *is* locked, because `guard_application_phone` refuses an
   *   application whose number differs from the account's — so offering an
   *   editable field there would be offering a refusal. Email has no such
   *   trigger: somebody who signed up with a personal address and wants LOCI's
   *   decision sent to a work one is making a reasonable request, and there is
   *   nothing on the server that objects.
   *
   *   The emptiness check is what makes it safe to run on every session change.
   *   Overwriting unconditionally would wipe an address they had just typed the
   *   moment a token refreshed.
   */
  useEffect(() => {
    const accountEmail = user?.email?.trim();
    if (!accountEmail) return;

    setForm((previous) =>
      previous.email.trim() ? previous : { ...previous, email: accountEmail },
    );
  }, [user?.email]);
  const [documents, setDocuments] = useState<Record<DocumentKey, AttachedDocument>>(NO_DOCUMENTS);

  /*
   * Expiry dates, as raw `DD/MM/YYYY` text.
   *
   * Held as typed rather than parsed, so a half-entered date survives a
   * re-render and the field does not fight the person filling it in. Parsing
   * happens in `validate` and again at submit; `src/lib/expiry.ts` is the one
   * place that knows how.
   */
  const [expiries, setExpiries] = useState<Record<string, string>>({});

  /*
   * Which sitting they are on, and whether they have confirmed.
   *
   * Not persisted with the draft. The answers survive a trip to sign-in — see
   * `useFormDraft` below — but the *position* deliberately does not: coming
   * back to a form on page three with no memory of pages one and two is
   * disorienting, and re-reading two pages of your own answers is cheap.
   */
  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState(false);

  /*
   * Back to the top whenever the step changes.
   *
   * ⚠ An effect on `step`, not a call inside `goNext`.
   *
   *   Three things move the step — Next, Back, and the indicator jumping to a
   *   completed page — and a failed submit moves it too. Scrolling in `goNext`
   *   alone would leave the other three landing mid-page: pressing Back from
   *   the documents card would drop somebody into the middle of the guarantor
   *   form, at whatever offset they happened to have been at.
   *
   *   `animated: false`. This is a page change, not a scroll: animating it
   *   makes the new step's fields fly past on the way, which reads as the form
   *   having lost its place rather than having turned a page.
   */
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [step]);

  /*
   * The answers outlive this component.
   *
   * Asking for an account at submit means the app navigates away mid-form, and
   * `useState` doesn't survive that — sign-in ends with `router.replace`, which
   * mounts a fresh screen, and signing up leaves the app entirely for an email
   * confirmation. Without this, a 30-field application vanishes at the last
   * step, which is exactly when it hurts most.
   */
  const {
    draft,
    ready: draftReady,
    save: saveDraft,
    clear: clearDraft,
  } = useFormDraft<{
    form: SignupForm;
    documents: Record<DocumentKey, AttachedDocument>;
  }>('loci.draft.driver-application');

  const restored = useRef(false);

  useEffect(() => {
    if (!draftReady || restored.current || !draft) return;
    restored.current = true;
    setForm(draft.form);
    // Local file URIs can expire between sessions. Restoring them anyway is
    // right: the upload reports "attach it again" if one has gone stale, which
    // beats silently dropping five attachments.
    setDocuments(draft.documents ?? NO_DOCUMENTS);
  }, [draftReady, draft]);

  useEffect(() => {
    // Don't write the empty initial state over a draft still being read.
    if (!draftReady) return;
    saveDraft({ form, documents });
  }, [draftReady, form, documents, saveDraft]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [reference, setReference] = useState('');

  const setField = <K extends keyof SignupForm>(key: K, value: SignupForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /**
   * Stands in for a file picker: picking produces a filename, which is what the
   * row shows back. Tapping an attached row clears it, so a mistake is
   * recoverable.
   */
  const clearDocumentError = (key: DocumentKey) =>
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const removeDocument = (key: DocumentKey) => {
    setDocuments((prev) => ({ ...prev, [key]: null }));
  };

  /**
   * Opens the OS file browser. Accepts images and PDFs — a licence is usually
   * photographed, an insurance certificate is usually a PDF.
   */
  const pickDocumentFile = async (key: DocumentKey) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;

      const asset = result.assets[0];
      if (!asset) return;
      if (asset.size && asset.size > MAX_DOCUMENT_BYTES) {
        showDialog('File too large', `Attachments must be under ${MAX_DOCUMENT_MB} MB.`);
        return;
      }

      setDocuments((prev) => ({
        ...prev,
        [key]: { fileName: asset.name, uri: asset.uri, size: asset.size ?? null },
      }));
      clearDocumentError(key);
    } catch {
      showDialog('Could not attach', 'Something went wrong opening the file browser.');
    }
  };

  /** Camera capture, for documents the applicant is holding rather than storing. */
  const captureDocument = async (key: DocumentKey) => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        showDialog(
          'Camera access needed',
          'Allow camera access in your settings to photograph this document.',
        );
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 0.7,
      });
      if (result.canceled) return;

      const asset = result.assets[0];
      if (!asset) return;

      /*
        ⚠ The same size check the file browser does.

          `pickDocumentFile` refuses anything over the cap before it reaches the
          form; this path did not, so a camera photo above it was accepted here
          and rejected at submit — after thirty other fields had been filled in,
          with the failure attached to the wrong action. A modern phone shooting
          at full resolution clears 10 MB without trying.
      */
      if (asset.fileSize && asset.fileSize > MAX_DOCUMENT_BYTES) {
        showDialog(
          'Photo too large',
          `That came out at ${Math.round(asset.fileSize / 1024 / 1024)} MB. Attachments must be under ${MAX_DOCUMENT_MB} MB.`,
        );
        return;
      }

      setDocuments((prev) => ({
        ...prev,
        [key]: {
          fileName: asset.fileName ?? `${key}-${new Date().toISOString().slice(0, 10)}.jpg`,
          uri: asset.uri,
          size: asset.fileSize ?? null,
        },
      }));
      clearDocumentError(key);
    } catch {
      showDialog('Could not attach', 'Something went wrong opening the camera.');
    }
  };

  /**
   * Camera isn't offered on web — there's no capture UI to fall back to, and the
   * file browser already covers picking an existing photo.
   */
  const attachDocument = (key: DocumentKey, label: string) => {
    if (Platform.OS === 'web') {
      void pickDocumentFile(key);
      return;
    }

    showDialog(label, 'How would you like to attach this?', [
      { text: 'Take photo', onPress: () => void captureDocument(key) },
      { text: 'Choose file', onPress: () => void pickDocumentFile(key) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  /**
   * Validates one field on blur so mistakes surface as you go, rather than all
   * at once at the end. Runs the same `validate` as submit and keeps only this
   * field's message, so the two can never disagree.
   */
  const validateField = (key: keyof SignupForm) => {
    const all = validate(form, documents, expiries);
    setErrors((prev) => {
      const next = { ...prev };
      if (all[key]) next[key] = all[key];
      else delete next[key];
      return next;
    });
  };

  /**
   * Forward, if this step is complete.
   *
   * ⚠ Only this step's errors are written.
   *
   *   Running `validate` and calling `setErrors(all)` would mark the guarantor
   *   fields red while somebody is still on page one — fields they have not
   *   seen, on a page they cannot currently reach. Scoping the write means the
   *   only messages on screen are about what is on screen.
   */
  const goNext = () => {
    const all = validate(form, documents, expiries);
    const mine = errorsForStep(step, all);

    if (Object.keys(mine).length > 0) {
      setErrors((previous) => ({ ...previous, ...mine }));
      return;
    }

    /*
     * Clear this step's messages on the way out. A field corrected after it
     * errored would otherwise keep its red text on the way back, because
     * nothing else re-runs validation for a step you have left.
     */
    setErrors((previous) => {
      const next = { ...previous };
      for (const key of Object.keys(errorsForStep(step, previous))) {
        delete next[key as keyof FieldErrors];
      }
      return next;
    });

    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const goBack = () => setStep((current) => Math.max(current - 1, 0));

  const handleSubmit = () => {
    const nextErrors = validate(form, documents, expiries);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      /*
       * ⚠ Sent back to the *first* step that has a problem, not left here.
       *
       *   Every earlier step was validated on the way past, so reaching submit
       *   with an error means something changed after — a field cleared on the
       *   way back, a draft restored from an older version of this form. Whatever
       *   the cause, the message is on a page the applicant is not looking at,
       *   and a Submit button that does nothing with no visible reason is the
       *   worst possible end to a thirty-field form.
       */
      const firstBad = STEPS.findIndex(
        (_, index) => Object.keys(errorsForStep(index, nextErrors)).length > 0,
      );
      if (firstBad >= 0) setStep(firstBad);
      return;
    }

    /*
     * ⚠ Checked here as well as by the disabled button.
     *
     *   The button already needs a photo, so this looks unreachable — until the
     *   applicant signs out between capture and submit, or a draft restores
     *   with the box ticked. A guard that lives only in a `disabled` prop is
     *   one path away from not existing.
     */
    if (!photoSession) {
      setStep(STEPS.length - 1);
      showDialog(
        'Take your live photo first',
        'It is the last item on this page. LOCI compares it with the photo on your NIN record before a reviewer sees your application.',
      );
      return;
    }

    /*
     * Validate first, then ask for an account — the same order as the booking
     * form. Gating on entry would send someone away before they'd seen what
     * driving for LOCI involves, and would throw away everything they'd typed.
     * Here the application is already complete and the state survives the trip
     * to sign-in, because this screen stays mounted underneath.
     */
    requireAuth(() => void submitApplication(), {
      title: 'Sign in to submit your application',
      reason:
        'Your application is tied to an account: it is how we tell you the outcome, and how you get into the driver dashboard once approved. Nothing you have typed will be lost.',
      next: '/driver-signup',
    });
  };

  /*
   * The identity check, run when the photo is taken rather than at submit.
   *
   * The selfie is captured, checked for liveness, and matched against the photo
   * held for the applicant's NIN — then the application is submitted *whatever
   * the answer was*. A mismatch is recorded on the row for a reviewer, not used
   * to refuse the applicant: NIMC photos can be a decade old, and a system that
   * auto-rejected on that number would turn "your face has aged" into "you
   * cannot work".
   *
   * ⚠ The verdict is stored here and written to the row by `submitApplication`
   *   below, so the reviewer never opens an application that looks unchecked.
   */
  const handlePhotoCaptured = async (sessionId: string) => {
    setPhotoSession(sessionId);
    setIdentityOutcome(await runIdentityCheck(sessionId, form.nin.trim()));
  };

  /** Runs only once we know whose application this is. */
  const submitApplication = async () => {
    if (!user) return;

    setIsSubmitting(true);
    const ref = generateReference();

    /*
     * The whole application now goes to the database. It used to be discarded
     * on submit apart from the location, which meant a reviewer had nothing to
     * review and an applicant had no record they had ever applied.
     */
    if (isSupabaseConfigured) {
      /*
       * Upload the documents BEFORE creating the application row.
       *
       * The other order would leave a reviewer with an application whose
       * evidence silently failed to arrive — worse than no application at all,
       * because it looks complete. If any upload fails we stop here with the
       * form intact and nothing written.
       */
      const uploaded: Record<string, string | null> = {};

      for (const doc of DOCUMENTS) {
        const attached = documents[doc.key];
        if (!attached) continue;

        const result = await uploadDocument({
          userId: user.id,
          key: doc.key,
          fileName: attached.fileName,
          uri: attached.uri,
        });

        if (!result.ok) {
          setIsSubmitting(false);
          showDialog(
            `Could not upload ${doc.label}`,
            `${result.error}\n\nNothing has been submitted — your answers and other files are still here.`,
          );
          return;
        }

        uploaded[doc.key] = result.path;

        /*
          The row, written after the bytes land.

          `record_document` is what makes this document expirable — the jsonb
          below still holds the path a reviewer approved, but it has nowhere to
          put a date. Recorded here rather than after `insertApplication` so a
          failure at that step does not leave documents with no records.

          ⚠ A failure here does NOT stop the submission.

            The application and its files are complete and reviewable without
            an expiry row; refusing the whole submission over a missing date
            would throw away a thirty-field form the applicant just filled in.
            The gap surfaces on Be a Driver / Updates as "add expiry date",
            which is a prompt they can answer in ten seconds.
        */
        const parsedExpiry = doc.expiry === 'none' ? null : parseExpiry(expiries[doc.key] ?? '');

        await recordDocument({
          kind: doc.key,
          path: result.path,
          expires: parsedExpiry?.ok === true ? parsedExpiry.iso : null,
        });
      }

      try {
        const created = await insertApplication({
          userId: user.id,
          reference: ref,
          fullName: form.fullName.trim(),
          phone: form.phone.trim(),
          email: form.email.trim().toLowerCase(),
          nin: form.nin.trim(),
          address: form.address.trim(),
          state: form.state,
          baseCity: cityForState(form.state),
          vehicleType: form.vehicleType,
          plateNumber: form.plateNumber.trim().toUpperCase(),
          licenseId: form.licenseId.trim(),
          guarantorName: form.guarantorName.trim(),
          guarantorPhone: form.guarantorPhone.trim(),
          guarantorRelationship: form.guarantorRelationship,
          guarantorAddress: form.guarantorAddress.trim(),
          guarantorNin: form.guarantorNin.trim(),
          bankName: form.bankName,
          accountNumber: form.accountNumber.trim(),
          accountName: form.accountName.trim(),
          kinName: form.kinName.trim(),
          kinPhone: form.kinPhone.trim(),
          kinRelationship: form.kinRelationship,
          // Storage paths now, not filenames — a reviewer can open these.
          documents: uploaded,
        });

        /*
         * The NIN verdict, brought across from the session onto the row that
         * now exists.
         *
         * ⚠ After the insert, and deliberately not inside the try that reports
         *   submission failures — this cannot fail the application. The
         *   photograph was taken, checked and recorded before this point; all
         *   that is at stake here is whether the reviewer sees the answer
         *   without going to look for it.
         */
        if (photoSession) {
          try {
            await attachIdentityResult(created.id, photoSession);
          } catch {
            // Deliberately silent. See above.
          }
        }
      } catch (thrown) {
        setIsSubmitting(false);

        const message = errorMessage(thrown, 'Something went wrong.');
        // The unique constraint is the common case and deserves its own words.
        showDialog(
          /duplicate key|one_open_application/i.test(message)
            ? 'You already have an application'
            : 'Could not submit your application',
          /duplicate key|one_open_application/i.test(message)
            ? 'There is already an application on this account. Check its status on the Drivers screen.'
            : `${message}\n\nYour answers are still here — try again.`,
        );
        return;
      }

      await refreshDriverStatus();
    }

    // Kept for the jobs feed, which reads the base city from the session.
    registerDriver({
      state: form.state,
      baseCity: cityForState(form.state),
      address: form.address.trim(),
      reference: ref,
      submittedAt: new Date().toISOString(),
    });

    // Submitted and stored — the draft has done its job.
    await clearDraft();

    setReference(ref);
    setIsSubmitting(false);
    setIsSubmitted(true);
  };

  /**
   * Clears the form and opens the driver dashboard. `replace`, not `push`, so
   * the back gesture can't return to a submitted application.
   */
  const goToDashboard = () => {
    void clearDraft();
    setForm(INITIAL_FORM);
    setDocuments(NO_DOCUMENTS);
    setErrors({});
    setIsSubmitted(false);
    setReference('');
    router.replace('/driver');
  };

  if (isSubmitted) {
    return (
      <ReviewStatus
        reference={reference}
        form={form}
        identity={identityOutcome}
        onGoToDashboard={goToDashboard}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: PageCanvas }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        <View style={styles.content}>
          {/* Full-width: the persistent nav bar is the way back out. */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text }]}>Be a Driver</Text>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              Tell us about yourself and your vehicle. Review usually takes 3–7 working days.
            </Text>
          </View>

          {/*
            Live status.
            
            An applicant is waiting up to seven working days, so the state has
            to be visible whenever they open the app — not only in the toast
            that fires the moment an admin decides. The toast is the interrupt;
            this is the record.
          */}
          {application && (
            <View
              style={[
                styles.liveStatusCard,
                {
                  backgroundColor:
                    application.status === 'approved'
                      ? theme.successSoft
                      : application.status === 'rejected'
                        ? theme.dangerSoft
                        : theme.warningSoft,
                },
              ]}>
              <View style={styles.liveStatusHeader}>
                <Text
                  style={[
                    styles.liveStatusTitle,
                    {
                      color:
                        application.status === 'approved'
                          ? theme.successOnSoft
                          : application.status === 'rejected'
                            ? theme.dangerOnSoft
                            : theme.warningOnSoft,
                    },
                  ]}>
                  {STATUS_LABELS[application.status]}
                </Text>
                <Text style={[styles.liveStatusRef, { color: theme.textSecondary }]}>
                  {application.reference}
                </Text>
              </View>

              <Text style={[styles.liveStatusBody, { color: theme.textSecondary }]}>
                {application.status === 'approved'
                  ? 'You can accept delivery jobs. Find Jobs is open to you.'
                  : application.status === 'rejected'
                    ? 'This application was not approved. Contact support if you think that is wrong.'
                    : `Submitted ${workingDaysSince(application.submittedAt)} working day(s) ago. Reviews take up to ${REVIEW_WORKING_DAYS}.`}
              </Text>
            </View>
          )}

          {/*
            Said up front rather than sprung at submit. Someone who knows an
            account is needed can create one before filling in a bank account
            number and a guarantor's NIN.
          */}
          {!isAuthenticated && (
            <View style={[styles.authNotice, { backgroundColor: theme.primarySoft }]}>
              <LogIn color={theme.primaryOnSoft} size={16} />
              <Text style={[styles.authNoticeText, { color: theme.primaryOnSoft }]}>
                You&apos;ll need a LOCI account to submit this application. Fill it in first —
                we&apos;ll ask you to sign in at the end. Your answers are saved on this device as
                you type, so they survive the trip.
              </Text>
            </View>
          )}

          {/* ------------------------------------------------- the wizard ---- */}
          <WizardProgress steps={STEPS} current={step} onJump={setStep} />

          {step === 0 && (
            <>
              {/* Personal details */}
              <Card style={styles.card}>
                <SectionHeading
                  icon={<UserRound color={theme.primary} size={18} />}
                  title="Your details"
                />

                <Field
                  label="Full name"
                  icon={(color, size) => <UserRound color={color} size={size} />}
                  placeholder="Chidi Okafor"
                  value={form.fullName}
                  onChangeText={(text) => setField('fullName', text)}
                  onBlur={() => validateField('fullName')}
                  error={errors.fullName}
                  autoCapitalize="words"
                />

                {/*
              Locked to the account, not merely prefilled.

              A prefilled-but-editable field would let someone change it and be
              refused by the trigger at submit — after four sections of typing.
              Refusing the keystroke and saying why is the same rule enforced
              somewhere the applicant can act on it.

              `editable={false}` is the visible half; the trigger in
              `16_driver_identity.sql` is the half that actually holds, because
              a disabled input still sends its value.
            */}
                <ValidatedPhoneInput
                  label="Phone number"
                  value={form.phone}
                  editable={!phoneLocked}
                  onChangeText={(text) => {
                    if (phoneLocked) {
                      setPhoneLockOpen(true);
                      return;
                    }
                    setField('phone', text);
                  }}
                  onBlur={() => validateField('phone')}
                  showError={Boolean(errors.phone)}
                  hint={
                    phoneLocked
                      ? 'From your LOCI account. Tap to see why this cannot be changed here.'
                      : undefined
                  }
                />

                <ValidatedEmailInput
                  label="Email address"
                  placeholder="chidi@example.com"
                  value={form.email}
                  onChangeText={(text) => setField('email', text)}
                  onBlur={() => validateField('email')}
                  showError={Boolean(errors.email)}
                />

                {/* Required, alongside the Government ID upload. */}
                <Field
                  label="National Identification Number (NIN)"
                  icon={(color, size) => <IdCard color={color} size={size} />}
                  placeholder="12345678901"
                  value={form.nin}
                  onChangeText={(text) =>
                    setField('nin', text.replace(/\D/g, '').slice(0, NIN_LENGTH))
                  }
                  onBlur={() => validateField('nin')}
                  error={errors.nin}
                  hint={`Required — ${NIN_LENGTH} digits`}
                  keyboardType="number-pad"
                  maxLength={NIN_LENGTH}
                />

                {/*
                  ⚠ Residential, not "residential or office".

                    Offering the choice meant an applicant could give a
                    workplace, and a workplace is the one address that does not
                    do what this field is for: it is what a background check is
                    run against, and where somebody would be traced to if a
                    parcel went missing. An office they left last month
                    verifies nothing.
                */}
                <AddressLookup
                  label="Residential address"
                  icon={(color, size) => <MapPin color={color} size={size} />}
                  placeholder="14 Awolowo Road, Ikoyi, Lagos"
                  value={form.address}
                  onChange={(next) => setField('address', next.address)}
                  onBlur={() => validateField('address')}
                  error={errors.address}
                  hint="Where you live. Used to verify you, and to match you with nearby jobs."
                  multiline
                />
              </Card>

              {/* Vehicle and coverage */}
              <Card style={styles.card}>
                <SectionHeading
                  icon={<Truck color={theme.primary} size={18} />}
                  title="Your vehicle"
                />

                <Dropdown
                  label="State of operation"
                  options={NIGERIA_STATES}
                  searchable
                  searchPlaceholder="Search state"
                  selected={form.state}
                  onSelect={(value) => setField('state', value)}
                  icon={(color, size) => <Building2 color={color} size={size} />}
                />

                <View style={styles.pickerField}>
                  <View style={styles.pickerLabelRow}>
                    <Bike color={theme.textSecondary} size={16} />
                    <Text style={[styles.pickerLabel, { color: theme.textSecondary }]}>
                      Vehicle type
                    </Text>
                  </View>
                  <ChipGroup
                    options={VEHICLE_TYPES}
                    selected={form.vehicleType}
                    onSelect={(value) => setField('vehicleType', value)}
                  />
                </View>

                <Field
                  label="Vehicle plate number"
                  icon={(color, size) => <Hash color={color} size={size} />}
                  placeholder="ABC-123DE"
                  value={form.plateNumber}
                  onChangeText={(text) => setField('plateNumber', text.toUpperCase())}
                  onBlur={() => validateField('plateNumber')}
                  error={errors.plateNumber}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={12}
                />

                <Field
                  label="Driver licence ID"
                  icon={(color, size) => <IdCard color={color} size={size} />}
                  placeholder="ABC123456789"
                  value={form.licenseId}
                  onChangeText={(text) => setField('licenseId', text)}
                  onBlur={() => validateField('licenseId')}
                  error={errors.licenseId}
                  hint={`${LICENCE_LENGTH} letters or numbers`}
                  maxLength={LICENCE_LENGTH}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              </Card>
            </>
          )}

          {step === 1 && (
            <>
              {/* Guarantor */}
              <Card style={styles.card}>
                <SectionHeading
                  icon={<UserCheck color={theme.primary} size={18} />}
                  title="Guarantor information"
                />
                <Text style={[styles.helper, { color: theme.textMuted }]}>
                  Someone who can vouch for you. We contact them only if we need to verify your
                  application.
                </Text>

                <Field
                  label="Guarantor's full name"
                  icon={(color, size) => <UserRound color={color} size={size} />}
                  placeholder="Ngozi Eze"
                  value={form.guarantorName}
                  onChangeText={(text) => setField('guarantorName', text)}
                  onBlur={() => validateField('guarantorName')}
                  error={errors.guarantorName}
                  autoCapitalize="words"
                />

                <ValidatedPhoneInput
                  label="Guarantor's phone number"
                  value={form.guarantorPhone}
                  onChangeText={(text) => setField('guarantorPhone', text)}
                  onBlur={() => validateField('guarantorPhone')}
                  showError={Boolean(errors.guarantorPhone)}
                />

                <Dropdown
                  label="Relationship"
                  options={GUARANTOR_RELATIONSHIPS}
                  selected={form.guarantorRelationship}
                  onSelect={(value) => setField('guarantorRelationship', value)}
                  icon={(color, size) => <UserCheck color={color} size={size} />}
                />

                {/*
                  ⚠ Changed with the applicant's, for the same reason.

                    A guarantor exists so there is somebody findable when the
                    driver cannot be found. A place of work is the address least
                    likely to still reach them — and leaving one field saying
                    "or office" while the other did not is the kind of drift
                    nobody notices until they need the address to be a home.
                */}
                <AddressLookup
                  label="Residential address"
                  icon={(color, size) => <MapPin color={color} size={size} />}
                  placeholder="14 Awolowo Road, Ikoyi, Lagos"
                  value={form.guarantorAddress}
                  onChange={(next) => setField('guarantorAddress', next.address)}
                  onBlur={() => validateField('guarantorAddress')}
                  error={errors.guarantorAddress}
                  multiline
                />

                {/*
              Required, unlike the applicant's own NIN above — a guarantor is
              only worth having if they can actually be identified.
            */}
                <Field
                  label="Guarantor's NIN"
                  icon={(color, size) => <IdCard color={color} size={size} />}
                  placeholder="12345678901"
                  value={form.guarantorNin}
                  onChangeText={(text) =>
                    setField('guarantorNin', text.replace(/\D/g, '').slice(0, NIN_LENGTH))
                  }
                  onBlur={() => validateField('guarantorNin')}
                  error={errors.guarantorNin}
                  hint={`Required — ${NIN_LENGTH} digits. Adds an extra layer of trust and security.`}
                  keyboardType="number-pad"
                  maxLength={NIN_LENGTH}
                />
              </Card>
              {/* Next of kin */}
              <Card style={styles.card}>
                <SectionHeading
                  icon={<HeartPulse color={theme.primary} size={18} />}
                  title="Emergency contact (next of kin)"
                />
                <Text style={[styles.helper, { color: theme.textMuted }]}>
                  Who we call if something happens while you are on a delivery.
                </Text>

                <Field
                  label="Next of kin's name"
                  icon={(color, size) => <UserRound color={color} size={size} />}
                  placeholder="Emeka Nwosu"
                  value={form.kinName}
                  onChangeText={(text) => setField('kinName', text)}
                  onBlur={() => validateField('kinName')}
                  error={errors.kinName}
                  autoCapitalize="words"
                />

                <ValidatedPhoneInput
                  label="Next of kin's phone number"
                  value={form.kinPhone}
                  onChangeText={(text) => setField('kinPhone', text)}
                  onBlur={() => validateField('kinPhone')}
                  showError={Boolean(errors.kinPhone)}
                />

                <Dropdown
                  label="Relationship"
                  options={NEXT_OF_KIN_RELATIONSHIPS}
                  selected={form.kinRelationship}
                  onSelect={(value) => setField('kinRelationship', value)}
                  icon={(color, size) => <HeartPulse color={color} size={size} />}
                />
              </Card>
            </>
          )}

          {step === 2 && (
            <>
              {/* Payout account */}
              <Card style={styles.card}>
                <SectionHeading
                  icon={<Banknote color={theme.primary} size={18} />}
                  title="Payout account details"
                />
                <Text style={[styles.helper, { color: theme.textMuted }]}>
                  Where your delivery earnings are paid. The account must be in your own name.
                </Text>

                <Dropdown
                  label="Bank name"
                  options={NIGERIAN_BANKS}
                  searchable
                  searchPlaceholder="Search bank"
                  selected={form.bankName}
                  onSelect={(value) => setField('bankName', value)}
                  icon={(color, size) => <Landmark color={color} size={size} />}
                />

                <Field
                  label="Account number"
                  icon={(color, size) => <Hash color={color} size={size} />}
                  placeholder="0123456789"
                  value={form.accountNumber}
                  onChangeText={(text) =>
                    setField('accountNumber', text.replace(/\D/g, '').slice(0, NUBAN_LENGTH))
                  }
                  onBlur={() => validateField('accountNumber')}
                  error={errors.accountNumber}
                  hint={`${NUBAN_LENGTH}-digit NUBAN`}
                  keyboardType="number-pad"
                  maxLength={NUBAN_LENGTH}
                />

                <Field
                  label="Account name"
                  icon={(color, size) => <UserRound color={color} size={size} />}
                  placeholder="As it appears on your bank statement"
                  value={form.accountName}
                  onChangeText={(text) => setField('accountName', text)}
                  onBlur={() => validateField('accountName')}
                  error={errors.accountName}
                  /*
                Typed by hand for now. A real build resolves this from the bank
                and account number via a name-enquiry call, then locks the field.
              */
                  hint="Typed for now — will be verified against your bank"
                  autoCapitalize="words"
                />
              </Card>
              {/* Documents */}
              <Card style={styles.card}>
                <SectionHeading
                  icon={<FileCheck2 color={theme.primary} size={18} />}
                  title="Documents"
                />
                <Text style={[styles.helper, { color: theme.textMuted }]}>
                  Your licence and insurance need the expiry date printed on them. LOCI reminds you
                  a month before either lapses — once one has, we have to stop offering you parcels
                  until it is renewed.
                </Text>

                {DOCUMENTS.map((doc) => (
                  <DocumentRow
                    key={doc.key}
                    label={doc.label}
                    hint={doc.hint}
                    document={documents[doc.key]}
                    error={errors[doc.key]}
                    onAttach={() => attachDocument(doc.key, doc.label)}
                    onRemove={() => removeDocument(doc.key)}
                    expiry={doc.expiry}
                    expiryValue={expiries[doc.key] ?? ''}
                    expiryError={errors[`${doc.key}Expiry` as keyof FieldErrors]}
                    onExpiryChange={(next) =>
                      setExpiries((current) => ({ ...current, [doc.key]: next }))
                    }
                  />
                ))}
              </Card>

              {/*
                The live photo, below the documents it is checked against.

                Reading order matters here: the applicant has just uploaded a
                NIN slip, and the next thing asked of them is a photograph to
                compare with it. Above the documents that sequence is backwards.
              */}
              <LiveSelfieCard
                purpose="driver"
                captured={photoSession}
                note={identityOutcome ? identityLabel(identityOutcome) : ''}
                onCaptured={handlePhotoCaptured}
                onCleared={() => {
                  setPhotoSession(null);
                  setIdentityOutcome(null);
                }}
                disabled={isSubmitting}
                gate={(proceed) =>
                  requireAuth(proceed, {
                    title: 'Sign in to take your photo',
                    reason:
                      'The photo is checked against your NIN and stored on your account, so we need to know whose it is. Nothing you have typed will be lost.',
                    next: '/driver-signup',
                  })
                }
              />

              {/*
                The confirmation, immediately above the button it gates.

                Far enough down that somebody has passed every field to reach
                it, and close enough to the button that the two read as one
                action. Placed between them rather than above the documents card
                so there is nothing to scroll past between ticking and pressing.
              */}
              <ConfirmCheckbox
                checked={confirmed}
                onChange={setConfirmed}
                disabled={isSubmitting}
                label="I confirm that all provided details, documents, and bank information are accurate and belong to me."
              />
            </>
          )}

          {/*
            Back and Next, or Back and Submit.

            ⚠ Submit is disabled by the checkbox, the live photo, and a
              malformed email — and by nothing else. Disabling it on incomplete
              fields would leave an applicant staring at a dead button with no
              indication of which of thirty inputs is at fault; `handleSubmit`
              runs the validation and sends them to the step that has the
              problem instead. The photo is the exception because it is on this
              page, a few inches above, showing its own state.
          */}
          <WizardNav
            onBack={step > 0 ? goBack : undefined}
            onNext={goNext}
            busy={isSubmitting}
            finalAction={
              step === STEPS.length - 1 ? (
                <Button
                  label={isSubmitting ? 'Submitting…' : 'Submit Application'}
                  icon={(color, size) =>
                    isSubmitting ? (
                      <ActivityIndicator color={color} size="small" />
                    ) : (
                      <ClipboardCheck color={color} size={size} />
                    )
                  }
                  onPress={handleSubmit}
                  disabled={
                    isSubmitting || !confirmed || !photoSession || !isValidEmail(form.email)
                  }
                />
              ) : undefined
            }
          />
        </View>
        <Footer />
      </ScrollView>

      {/*
        The refusal, as a sheet rather than an OS alert.

        `showDialog` would work, but this needs two paragraphs and a number the
        applicant has to read carefully — an alert that vanishes on any tap is a
        poor place to put the one piece of information that resolves the
        problem.
      */}
      <BottomSheet visible={phoneLockOpen} onClose={() => setPhoneLockOpen(false)} maxHeight="55%">
        <View style={styles.lockSheet}>
          <View style={[styles.lockIcon, { backgroundColor: theme.primarySoft }]}>
            <Phone color={theme.primaryOnSoft} size={22} />
          </View>
          <Text style={[styles.lockTitle, { color: theme.text }]}>{PHONE_LOCK_TITLE}</Text>
          <Text style={[styles.lockBody, { color: theme.textSecondary }]}>
            {phoneLockMessage(registeredPhone)}
          </Text>
          <Button label="Got it" onPress={() => setPhoneLockOpen(false)} />
        </View>
      </BottomSheet>
    </KeyboardAvoidingView>
  );
}

/** "2.4 MB" / "812 KB" — so an applicant can see the scan actually attached. */
function formatSize(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

function DocumentRow({
  label,
  hint,
  document,
  error,
  onAttach,
  onRemove,
  expiry,
  expiryValue,
  expiryError,
  onExpiryChange,
}: {
  label: string;
  hint: string;
  document: AttachedDocument;
  error?: string;
  onAttach: () => void;
  onRemove: () => void;
  /** Mirrors `document_kinds`. See the comment on DOCUMENTS. */
  expiry: 'required' | 'optional' | 'none';
  expiryValue: string;
  expiryError?: string;
  onExpiryChange: (next: string) => void;
}) {
  const theme = useTheme();
  const attached = document !== null;
  const size = attached ? formatSize(document.size) : null;

  /*
   * The date appears only once a file is attached.
   *
   * An expiry field under an empty slot is asking for the expiry of nothing.
   * It also halves the apparent length of this section for anyone scrolling it
   * before they have started attaching, which is everybody.
   */
  const wantsExpiry = attached && expiry !== 'none';

  return (
    <View style={styles.docBlock}>
      <Pressable
        onPress={attached ? onRemove : onAttach}
        accessibilityRole="button"
        accessibilityState={{ checked: attached }}
        accessibilityLabel={
          attached
            ? `${label}. Attached: ${document.fileName}. Tap to remove.`
            : `${label}. ${hint}. Tap to attach a photo or file.`
        }
        style={({ pressed }) => [
          styles.docRow,
          {
            backgroundColor: attached ? theme.successSoft : theme.surfaceMuted,
            borderColor: error ? theme.danger : attached ? theme.success : 'transparent',
          },
          pressed && styles.pressed,
        ]}>
        <View
          style={[
            styles.docIcon,
            { backgroundColor: attached ? theme.success : theme.backgroundSelected },
          ]}>
          {attached ? (
            <CheckCircle2 color={theme.successSoft} size={18} />
          ) : (
            <Upload color={theme.textSecondary} size={18} />
          )}
        </View>

        <View style={styles.docText}>
          <Text style={[styles.docLabel, { color: attached ? theme.successOnSoft : theme.text }]}>
            {label}
          </Text>
          {attached ? (
            <View style={styles.docFileRow}>
              <CheckCircle2 color={theme.success} size={13} />
              <Text style={[styles.docFileName, { color: theme.successOnSoft }]} numberOfLines={1}>
                {size ? `${document.fileName} · ${size}` : document.fileName}
              </Text>
            </View>
          ) : (
            <Text style={[styles.docHint, { color: theme.textMuted }]}>{hint}</Text>
          )}
        </View>

        <Text style={[styles.docAction, { color: attached ? theme.successOnSoft : theme.primary }]}>
          {attached ? 'Remove' : 'Upload'}
        </Text>
      </Pressable>
      {!!error && <Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text>}

      {wantsExpiry && (
        <View style={styles.docExpiry}>
          <ExpiryField
            label={label}
            value={expiryValue}
            onChange={onExpiryChange}
            required={expiry === 'required'}
            error={expiryError}
          />
        </View>
      )}
    </View>
  );
}

/**
 * What the applicant should do while the review runs.
 *
 * The first line names the address rather than saying "check your inbox",
 * because that is the one thing on this screen the applicant can act on and
 * verify. It is also the moment a typo in the email field becomes obvious —
 * before they spend a week waiting for a message that went nowhere.
 */
function nextSteps(email: string): { text: string; icon: (color: string) => React.ReactNode }[] {
  const address = email.trim();

  return [
    {
      text: address
        ? `We've emailed a confirmation to ${address}. It usually arrives within a minute — check spam if it doesn't.`
        : 'Check your inbox for a confirmation email.',
      icon: (c) => <Mail color={c} size={15} />,
    },
    {
      text: 'Stay available for a potential verification call.',
      icon: (c) => <PhoneCall color={c} size={15} />,
    },
    {
      text: 'Ensure your vehicle is ready for final inspection.',
      icon: (c) => <ClipboardCheck color={c} size={15} />,
    },
  ];
}

function ReviewStatus({
  reference,
  form,
  identity,
  onGoToDashboard,
}: {
  reference: string;
  form: SignupForm;
  /** Null when the check never ran — an older submission, or no provider. */
  identity: IdentityOutcome | null;
  onGoToDashboard: () => void;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const VehicleIcon = VEHICLE_ICONS[form.vehicleType];
  const firstName = form.fullName.trim().split(/\s+/)[0];
  // Four labels across need roughly 140px each before they start truncating.
  const wideTracker = width >= 620;

  /**
   * Four stages, one of which is current. `done` and `active` are derived from
   * position rather than stored per step, so the tracker can never show two
   * current stages or a completed step after a pending one.
   */
  const CURRENT_STEP = 1;
  const steps = useMemo(
    () =>
      ['Application Received', 'Document Review', 'Background Check', 'Approval & Activation'].map(
        (label, index) => ({
          key: label,
          label,
          done: index < CURRENT_STEP,
          active: index === CURRENT_STEP,
        }),
      ),
    [],
  );

  return (
    <ScrollView style={{ backgroundColor: PageCanvas }} contentContainerStyle={styles.container}>
      <View style={styles.content}>
        {/* ---------- Success header ---------- */}
        <View style={styles.statusHero}>
          <View style={[styles.statusIcon, { backgroundColor: theme.successSoft }]}>
            <CircleCheckBig color={theme.success} size={34} />
          </View>

          <Text style={[styles.statusTitle, { color: theme.text }]}>
            Application Submitted Successfully!
          </Text>
          {/*
            The identity verdict, told to the applicant rather than kept from
            them.

            A mismatch is not a rejection and the wording must not read like
            one — but somebody whose selfie failed to match a government photo
            has a right to know that is on their file before a reviewer sees it,
            not after they are turned down.
          */}
          {identity && identity.status !== 'matched' && (
            <View style={[styles.identityNote, { backgroundColor: theme.warningSoft }]}>
              <Text style={[styles.identityNoteText, { color: theme.warningOnSoft }]}>
                {identityLabel(identity)}
              </Text>
            </View>
          )}

          <Text style={[styles.statusBody, { color: theme.textSecondary }]}>
            Thank you for joining the LOCI network, {firstName}. Your application has been received.
          </Text>

          {/* Application ID, in a pill of its own so it can be read back over the phone. */}
          <View style={[styles.refPill, { backgroundColor: theme.primarySoft }]}>
            <Hash color={theme.primaryOnSoft} size={13} />
            <Text
              style={[styles.refPillText, { color: theme.primaryOnSoft }]}
              accessibilityLabel={`Application I D ${reference.split('').join(' ')}`}>
              #{reference}
            </Text>
          </View>
        </View>

        <Card style={styles.card}>
          <View style={styles.refRow}>
            <Text style={[styles.refLabel, { color: theme.textMuted }]}>Reference</Text>
            <Text style={[styles.refValue, { color: theme.primary }]}>#{reference}</Text>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <SummaryRow
            icon={<UserRound color={theme.textMuted} size={15} />}
            label="Applicant"
            value={form.fullName.trim()}
          />
          <SummaryRow
            icon={<Mail color={theme.textMuted} size={15} />}
            label="Email"
            value={form.email.trim()}
          />
          <SummaryRow
            icon={<Building2 color={theme.textMuted} size={15} />}
            label="State"
            value={form.state}
          />
          <SummaryRow
            icon={<Landmark color={theme.textMuted} size={15} />}
            label="Payout"
            value={`${form.bankName} · ${form.accountNumber.trim()}`}
          />
          <SummaryRow
            icon={<UserCheck color={theme.textMuted} size={15} />}
            label="Guarantor"
            value={`${form.guarantorName.trim()} (${form.guarantorRelationship})`}
          />
          <SummaryRow
            icon={<HeartPulse color={theme.textMuted} size={15} />}
            label="Next of kin"
            value={`${form.kinName.trim()} (${form.kinRelationship})`}
          />
          <SummaryRow
            icon={<Hash color={theme.textMuted} size={15} />}
            label="Plate"
            value={form.plateNumber.trim()}
          />
          <SummaryRow
            icon={<VehicleIcon color={theme.textMuted} size={15} />}
            label="Vehicle"
            value={form.vehicleType}
          />
          <SummaryRow
            icon={<IdCard color={theme.textMuted} size={15} />}
            label="Licence ID"
            value={form.licenseId.trim()}
          />
        </Card>

        {/* ---------- Status tracker ---------- */}
        <Card style={styles.card}>
          <SectionLabel>Application status</SectionLabel>

          {/*
            Horizontal on a wide screen, vertical on a phone. Four labels will
            not fit across 360px without truncating to the point of uselessness.
          */}
          <View style={[styles.tracker, wideTracker && styles.trackerRow]}>
            {steps.map((step, index) => {
              const tone = step.done
                ? theme.success
                : step.active
                  ? theme.warning
                  : theme.textMuted;
              const isLast = index === steps.length - 1;

              return (
                <View
                  key={step.key}
                  style={[styles.trackerStep, wideTracker && styles.trackerStepRow]}
                  accessibilityLabel={`Step ${index + 1} of ${steps.length}. ${step.label}. ${
                    step.done ? 'Completed' : step.active ? 'In progress' : 'Pending'
                  }`}>
                  <View style={[styles.trackerMarkRow, wideTracker && styles.trackerMarkRowWide]}>
                    {/* Glyph, not just a coloured dot — colour alone can't say "done" vs "waiting". */}
                    <View
                      style={[
                        styles.trackerDot,
                        { borderColor: tone, backgroundColor: step.done ? tone : theme.surface },
                      ]}>
                      {step.done ? (
                        <Check color={theme.surface} size={13} />
                      ) : step.active ? (
                        <Clock color={tone} size={13} />
                      ) : (
                        <View style={[styles.trackerPending, { backgroundColor: tone }]} />
                      )}
                    </View>

                    {!isLast && (
                      <View
                        style={[
                          wideTracker ? styles.trackerBarWide : styles.trackerBar,
                          { backgroundColor: step.done ? theme.success : theme.border },
                        ]}
                      />
                    )}
                  </View>

                  <Text
                    style={[
                      styles.trackerLabel,
                      wideTracker && styles.trackerLabelWide,
                      { color: step.active ? theme.text : theme.textSecondary },
                      step.active && styles.stepTextActive,
                    ]}
                    numberOfLines={2}>
                    {step.label}
                  </Text>
                </View>
              );
            })}
          </View>
        </Card>

        {/* ---------- Current status callout ---------- */}
        <View
          style={[
            styles.callout,
            { backgroundColor: theme.warningSoft, borderLeftColor: theme.warningOnSoft },
          ]}>
          <Clock color={theme.warningOnSoft} size={18} />
          <View style={styles.calloutText}>
            <Text style={[styles.calloutTitle, { color: theme.warningOnSoft }]}>
              Current Status: In Review
            </Text>
            <Text style={[styles.calloutBody, { color: theme.warningOnSoft }]}>
              Our compliance team is verifying your documents. This typically takes 3–7 working
              days. We&apos;ll notify you via SMS and email when it&apos;s complete.
            </Text>
          </View>
        </View>

        {/* ---------- Next steps ---------- */}
        <Card style={styles.card}>
          <SectionLabel>What happens next</SectionLabel>
          {nextSteps(form.email).map((item) => (
            <View key={item.text} style={styles.stepRow}>
              <View style={[styles.nextIcon, { backgroundColor: theme.primarySoft }]}>
                {item.icon(theme.primaryOnSoft)}
              </View>
              <Text style={[styles.stepText, { color: theme.textSecondary }]}>{item.text}</Text>
            </View>
          ))}
        </Card>

        <Button
          label="Go to Driver Dashboard"
          icon={(color, size) => <LayoutDashboard color={color} size={size} />}
          onPress={onGoToDashboard}
        />
      </View>
      <Footer />
    </ScrollView>
  );
}

function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeading}>
      {icon}
      <Text style={[styles.sectionTitle, { color: theme.text }]}>{title}</Text>
    </View>
  );
}

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.summaryRow}>
      <View style={styles.summaryLabel}>
        {icon}
        <Text style={[styles.summaryLabelText, { color: theme.textMuted }]}>{label}</Text>
      </View>
      <Text style={[styles.summaryValue, { color: theme.text }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  identityNote: {
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    marginBottom: Spacing.two,
  },
  identityNoteText: {
    ...Typography.caption,
    lineHeight: 18,
  },
  lockSheet: {
    gap: Spacing.three,
    alignItems: 'flex-start',
  },
  lockIcon: {
    width: 44,
    height: 44,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockTitle: {
    ...Typography.sectionTitle,
  },
  lockBody: {
    ...Typography.meta,
    lineHeight: 21,
  },
  flex: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    alignItems: 'center',
    padding: Spacing.four,
    paddingTop: Spacing.five,
    paddingBottom: Spacing.six,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    gap: Spacing.three,
  },
  /*
    The post-submit screen already owns `statusTitle` and `statusBody`; this is
    the persistent card on the form itself, so it gets its own names rather than
    silently overwriting them — a duplicate key in StyleSheet.create is legal
    JavaScript and would have taken the last definition.
  */
  liveStatusCard: {
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  liveStatusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  liveStatusTitle: {
    ...Typography.body,
    ...font(700),
  },
  liveStatusRef: {
    ...Typography.meta,
  },
  liveStatusBody: {
    ...Typography.meta,
    lineHeight: 19,
  },
  authNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    marginBottom: Spacing.three,
  },
  authNoticeText: {
    ...Typography.meta,
    flex: 1,
    lineHeight: 19,
  },
  header: {
    gap: Spacing.two - 2,
  },
  title: {
    ...Typography.screenTitle,
    fontSize: FontSize.title,
  },
  subtitle: {
    ...Typography.screenSubtitle,
  },
  card: {
    gap: Spacing.three,
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  sectionTitle: {
    ...Typography.sectionTitle,
  },
  pickerField: {
    gap: Spacing.two - 2,
  },
  pickerLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  pickerLabel: {
    ...Typography.label,
  },
  helper: {
    ...Typography.meta,
  },
  errorText: {
    ...Typography.meta,
  },
  pressed: {
    opacity: 0.75,
  },

  // Documents
  /** Indented under its document, so the pairing is visible without a label. */
  docExpiry: {
    paddingLeft: Spacing.three,
    paddingTop: Spacing.two,
  },
  docBlock: {
    gap: Spacing.one,
  },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 2,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  docIcon: {
    width: 38,
    height: 38,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  docText: {
    flex: 1,
    gap: Spacing.half,
  },
  docLabel: {
    ...Typography.body,
    ...font(700),
  },
  docFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  docFileName: {
    flex: 1,
    ...Typography.caption,
    ...font(600),
  },
  docHint: {
    ...Typography.meta,
  },
  docAction: {
    ...Typography.caption,
    ...font(700),
  },

  // Review status
  statusHero: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  refPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
    paddingVertical: Spacing.one + 2,
    paddingHorizontal: Spacing.three - 4,
    borderRadius: Radius.pill,
  },
  refPillText: {
    fontSize: FontSize.small,
    ...font(700),
    letterSpacing: 0.4,
  },
  /** Vertical by default; `trackerRow` turns it horizontal when there's room. */
  tracker: {
    gap: Spacing.three - 4,
  },
  trackerRow: {
    flexDirection: 'row',
    gap: 0,
  },
  trackerStep: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
  },
  trackerStepRow: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  trackerMarkRow: {
    alignItems: 'center',
  },
  trackerMarkRowWide: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  trackerDot: {
    width: 26,
    height: 26,
    borderRadius: Radius.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackerPending: {
    width: 7,
    height: 7,
    borderRadius: Radius.pill,
  },
  /** Connector between nodes: down the left when stacked, across when wide. */
  trackerBar: {
    width: 2,
    height: 18,
    marginTop: 2,
  },
  trackerBarWide: {
    flex: 1,
    height: 2,
    marginHorizontal: Spacing.two - 2,
  },
  trackerLabel: {
    flex: 1,
    ...Typography.body,
  },
  trackerLabelWide: {
    flex: 0,
    paddingRight: Spacing.three,
  },
  callout: {
    flexDirection: 'row',
    gap: Spacing.three - 4,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderLeftWidth: 3,
    marginBottom: Spacing.three,
  },
  calloutText: {
    flex: 1,
    gap: Spacing.one,
  },
  calloutTitle: {
    ...Typography.body,
    ...font(700),
  },
  calloutBody: {
    ...Typography.caption,
    lineHeight: 20,
  },
  nextIcon: {
    width: 28,
    height: 28,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusIcon: {
    width: 66,
    height: 66,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.one,
  },
  statusTitle: {
    ...Typography.screenTitle,
    fontSize: FontSize.title,
    textAlign: 'center',
  },
  statusBody: {
    ...Typography.body,
    textAlign: 'center',
    lineHeight: 22,
  },
  refRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  refLabel: {
    ...Typography.caption,
  },
  refValue: {
    fontSize: FontSize.subhead,
    ...font(800),
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  summaryLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  summaryLabelText: {
    ...Typography.meta,
  },
  summaryValue: {
    ...Typography.meta,
    ...font(700),
    flexShrink: 1,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
  },
  stepText: {
    ...Typography.body,
  },
  stepTextActive: {
    ...font(700),
  },
});
