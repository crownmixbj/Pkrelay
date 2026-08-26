import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowRight,
  Banknote,
  Building2,
  MapPin,
  Navigation,
  PackageOpen,
  PackagePlus,
  Receipt,
  ShieldAlert,
  StickyNote,
  Store,
  Tag,
  UserRound,
  Weight,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Footer } from '@/components/Footer';
import { showDialog } from '@/components/ui/dialog';
import { useAuthGate } from '@/hooks/use-auth-gate';
import { mergeDraft, useFormDraft } from '@/hooks/use-form-draft';
import { AreaPicker, resolveArea } from '@/components/ui/area-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/chip';
import { Dropdown, ToggleRow } from '@/components/ui/dropdown';
import { Field } from '@/components/ui/field';
import { ModeSelector, type ModeOption } from '@/components/ui/mode-selector';
import {
  ConfirmCheckbox,
  WizardNav,
  WizardProgress,
  type WizardStep,
} from '@/components/ui/form-wizard';
import { PhotoPicker } from '@/components/ui/photo-picker';
import { LiveSelfieCard } from '@/components/ui/live-selfie-card';
import { SelectableUpgradeCard } from '@/components/ui/selectable-upgrade-card';
import { ValidatedPhoneInput } from '@/components/ValidatedPhoneInput';
import { FontSize, MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { findHub, hubLabel, hubsForCity, type Hub } from '@/constants/hubs';
import { useHubs } from '@/store/hubs';
import { useTheme } from '@/hooks/use-theme';
import { isSupabaseConfigured } from '@/lib/supabase';
import { consumeCaptureSession } from '@/store/capture-session';
import { uploadParcelPhoto } from '@/store/parcel-photos';
import { showToast } from '@/components/ui/toast';
import { fetchSenderIdentity, runIdentityCheck, type SenderIdentity } from '@/store/identity';
import {
  blockedMessage,
  canActNow,
  FORM_IS_SAVED,
  gateTitle,
  postingGate,
} from '@/lib/posting-gate';
import { isValidNigerianPhone, nigerianPhoneError } from '@/utils/validation';
import { AddressLookup } from '@/components/ui/address-lookup';
import { VerifyBanner } from '@/components/ui/verify-banner';
import { distanceLabel, type Distance, type Point } from '@/lib/distance';
import { measureDistance } from '@/store/places';
import {
  areasForCity,
  CATEGORIES,
  cityHubLabel,
  CITIES,
  declaredValueError,
  DEFAULT_CITY,
  DELIVERY_TYPES,
  estimateFee,
  formatAmountInput,
  dropoffSummaryLine,
  formatNaira,
  handoverFeeLabel,
  handoverModeLabel,
  parseAmountInput,
  pickupSummaryLine,
  PRICING,
  useBookings,
  type Category,
  type City,
  type DeliveryType,
  type HandoverMode,
} from '@/store/bookings';

/** Screen-local labels — more descriptive than the store's short badge labels. */
const DELIVERY_TYPE_TITLES: Record<DeliveryType, string> = {
  local: 'Local Delivery',
  interstate: 'Inter-State Delivery',
};

/**
 * Handover choices, with the price consequence stated on the option itself
 * rather than left to appear in the summary — the surcharge is the main reason
 * to pick one over the other.
 */
const SURCHARGE_BADGE = `+${formatNaira(PRICING.handoverSurcharge)}`;

/**
 * The two ways a parcel leaves the sender — and the surcharge now sits on the
 * hub, not on the driver run.
 *
 * That is the opposite of what it costs LOCI to serve, and deliberately so: a
 * hub drop-off means someone queueing at a counter LOCI has to staff, while a
 * driver already travelling the route can collect from a public place at no
 * extra cost. The fee steers senders towards the cheaper operation.
 *
 * The free option is listed first, because the first card is the one people
 * take when they are not reading closely.
 */
const PICKUP_MODES: readonly ModeOption<HandoverMode>[] = [
  {
    value: 'doorstep',
    label: 'Public location pickup',
    description: 'A driver collects from your proposed public location.',
    badge: 'Included',
  },
  {
    value: 'hub',
    label: 'LOCI hub',
    description: 'You bring the parcel to the selected LOCI hub yourself.',
    badge: SURCHARGE_BADGE,
  },
];

/**
 * The dropoff end is one selectable card with a paid upgrade inside it, rather
 * than a radio pair: hub collection is what happens by default, and this card
 * is the only thing a sender changes.
 *
 * The card copy describes the free version, the upgrade copy describes what the
 * charge buys — keeping the two apart is what makes the two controls legible.
 */
const DOORSTEP_DROPOFF = {
  label: 'Deliver to recipient',
  description: 'A driver delivers to recipient at the proposed public location.',
  upgradeLabel: 'Home/Office Drop-off',
  upgradeHint:
    'Applies a supplementary charge for direct-to-door delivery instead of meeting at a public location.',
} as const;

type BookingForm = {
  deliveryType: DeliveryType;
  /** Where the parcel is collected from, and where it's handed over. */
  pickupMode: HandoverMode;
  dropoffMode: HandoverMode;
  originCity: City;
  destinationCity: City;
  /** Chosen LOCI hub id, used only when pickupMode is 'hub'. */
  pickupHubId: string;
  /** Dropdown selection — either a preset area or OTHER_AREA. */
  pickupAreaSelection: string;
  /** Free text, used only when the selection is OTHER_AREA. */
  pickupAreaCustom: string;
  pickupAddress: string;
  pickupContactName: string;
  senderPhone: string;
  dropoffAreaSelection: string;
  dropoffAreaCustom: string;
  dropoffAddress: string;
  recipientName: string;
  recipientPhone: string;
  itemDescription: string;
  /** Local URI from the picker, or '' when no photo is attached. */
  itemPhotoUri: string;
  category: Category;
  weight: string;
  declaredValue: string;
  fragile: boolean;
  notes: string;
};

type FieldErrors = Partial<Record<keyof BookingForm, string>>;

/**
 * Posting a parcel, in three sittings.
 *
 * ⚠ The split follows the *questions*, not the old cards.
 *
 *   Page one is about the thing being sent, page two about the person sending
 *   it, page three about the person receiving it. Sender identity — the NIN and
 *   the slip — moves onto page two with the pickup details, because it belongs
 *   to the sender rather than to the parcel, and it was previously buried in
 *   the middle of a form that had already asked about weight and fragility.
 *
 * ⚠ `deliveryType` is on no step, deliberately.
 *
 *   It is the pill toggle pinned above the wizard, visible on all three pages,
 *   because it changes the price and the shape of every question after it. It
 *   is validated by having no invalid state — a segmented control cannot be
 *   empty — so it needs no step to own it.
 */
const STEPS: WizardStep[] = [
  { key: 'item', label: 'Item' },
  { key: 'pickup', label: 'Pickup & you' },
  { key: 'dropoff', label: 'Dropoff & review' },
];

/** Which booking fields each step is responsible for. */
const STEP_FIELDS: (keyof BookingForm)[][] = [
  ['itemDescription', 'itemPhotoUri', 'category', 'weight', 'declaredValue', 'fragile'],
  [
    'pickupMode',
    'originCity',
    'pickupHubId',
    'pickupAreaSelection',
    'pickupAreaCustom',
    'pickupAddress',
    'pickupContactName',
    'senderPhone',
  ],
  [
    'dropoffMode',
    'destinationCity',
    'dropoffAreaSelection',
    'dropoffAreaCustom',
    'dropoffAddress',
    'recipientName',
    'recipientPhone',
    'notes',
  ],
];

/**
 * This step's share of the errors.
 *
 * Runs the whole `validate` and filters, so a step cannot disagree with submit
 * about what a valid weight is. Sender identity is checked separately — see the
 * note in `handleSubmit` on why it is not inside `validate` — so it is folded
 * into step two here rather than being a fourth list.
 */
function errorsForStep(step: number, all: FieldErrors): FieldErrors {
  const keys = new Set<string>(STEP_FIELDS[step] ?? []);
  const mine: FieldErrors = {};
  for (const [key, message] of Object.entries(all)) {
    if (keys.has(key)) mine[key as keyof FieldErrors] = message;
  }
  return mine;
}

const INITIAL_FORM: BookingForm = {
  deliveryType: 'local',
  // Hub at both ends is the cheapest option, so it's the one we default to
  // rather than quietly opting people into a surcharge.
  pickupMode: 'hub',
  dropoffMode: 'hub',
  originCity: DEFAULT_CITY,
  destinationCity: DEFAULT_CITY,
  pickupHubId: '',
  pickupAreaSelection: '',
  pickupAreaCustom: '',
  pickupAddress: '',
  pickupContactName: '',
  senderPhone: '',
  dropoffAreaSelection: '',
  dropoffAreaCustom: '',
  dropoffAddress: '',
  recipientName: '',
  recipientPhone: '',
  itemDescription: '',
  itemPhotoUri: '',
  category: 'Electronics',
  weight: '',
  declaredValue: '',
  fragile: false,
  notes: '',
};

const normalizePhone = (value: string) => value.replace(/[\s()-]/g, '');

/**
 * `hubs` is passed in rather than read from a module constant.
 *
 * Hubs are live data now — an admin can close one — so validation has to see
 * the same list the picker offered, or it would accept a hub that no longer
 * exists.
 */
function validate(form: BookingForm, hubs: Hub[]): FieldErrors {
  const errors: FieldErrors = {};

  // --- Item details ---
  const itemDescription = form.itemDescription.trim();
  if (!itemDescription) {
    errors.itemDescription = 'Give the item a name';
  } else if (itemDescription.length < 3) {
    errors.itemDescription = 'Add a little more detail';
  }

  if (!form.itemPhotoUri) {
    errors.itemPhotoUri = 'A photo of the parcel is required to confirm handover condition';
  }

  const weight = Number(form.weight);
  if (!form.weight.trim()) {
    errors.weight = 'Weight is required';
  } else if (Number.isNaN(weight) || weight <= 0) {
    errors.weight = 'Must be greater than 0';
  } else if (weight > 100) {
    errors.weight = 'Cannot exceed 100 kg';
  }

  /*
   * Required since August 2026, and the reasoning is with the rule itself —
   * see `declaredValueError`. `declaredValue` is in step one of `STEP_FIELDS`,
   * so returning an error here is what stops Next.
   */
  const badValue = declaredValueError(form.declaredValue);
  if (badValue) errors.declaredValue = badValue;

  // --- Locations ---
  const pickupArea = resolveArea(form.pickupAreaSelection, form.pickupAreaCustom);
  const dropoffArea = resolveArea(form.dropoffAreaSelection, form.dropoffAreaCustom);

  if (form.pickupMode === 'hub') {
    // The area comes from the chosen hub, so the hub is what's validated.
    if (!hubsForCity(hubs, form.originCity).length) {
      errors.pickupHubId = `No LOCI hub in ${form.originCity} yet — use public location pickup`;
    } else if (!form.pickupHubId) {
      errors.pickupHubId = 'Choose a LOCI hub';
    }
  } else if (!form.pickupAreaSelection) {
    errors.pickupAreaSelection = 'Choose a pickup area';
  } else if (!pickupArea) {
    errors.pickupAreaCustom = 'Name the pickup area';
  }

  if (!form.dropoffAreaSelection) {
    errors.dropoffAreaSelection = 'Choose a dropoff area';
  } else if (!dropoffArea) {
    errors.dropoffAreaCustom = 'Name the dropoff area';
  }

  if (form.deliveryType === 'local' && pickupArea && dropoffArea) {
    if (pickupArea.toLowerCase() === dropoffArea.toLowerCase()) {
      errors.dropoffAreaSelection = 'Pickup and dropoff areas are the same';
    }
  }

  // Only a doorstep leg needs a street address — for a hub drop-off the area
  // and the hub itself are enough to route the parcel.
  if (form.pickupMode === 'doorstep' && !form.pickupAddress.trim()) {
    errors.pickupAddress = 'Pickup address is required';
  }
  if (!form.pickupContactName.trim()) {
    errors.pickupContactName = 'Contact person is required';
  }

  const senderPhone = form.senderPhone.trim();
  if (!senderPhone) {
    errors.senderPhone = 'Pickup phone is required';
  } else if (!isValidNigerianPhone(senderPhone)) {
    errors.senderPhone = nigerianPhoneError(senderPhone) ?? 'Enter a valid Nigerian number';
  }

  if (form.dropoffMode !== 'hub' && !form.dropoffAddress.trim()) {
    errors.dropoffAddress =
      form.dropoffMode === 'doorstep' ? 'Dropoff address is required' : 'Name the meeting point';
  }
  if (!form.recipientName.trim()) {
    errors.recipientName = 'Recipient name is required';
  }

  const recipientPhone = form.recipientPhone.trim();
  if (!recipientPhone) {
    errors.recipientPhone = 'Recipient phone is required';
  } else if (!isValidNigerianPhone(recipientPhone)) {
    errors.recipientPhone = nigerianPhoneError(recipientPhone) ?? 'Enter a valid Nigerian number';
  }

  if (form.deliveryType === 'interstate' && form.originCity === form.destinationCity) {
    errors.destinationCity = 'Pick a different city, or switch to Local Delivery';
  }

  return errors;
}

/** Narrow a raw query-param string to a known union member. */
const asOption = <T extends string>(options: readonly T[], value: unknown): T | undefined =>
  typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

export default function BookScreen() {
  const theme = useTheme();
  const { addBooking } = useBookings();
  const { requireAuth } = useAuthGate();
  const router = useRouter();
  const params = useLocalSearchParams<{
    service?: string;
    deliveryType?: string;
    focusDeclaredValue?: string;
    /** Set by "Select Hub" on the hub locations screen. */
    originCity?: string;
    pickupArea?: string;
  }>();

  const [form, setForm] = useState<BookingForm>(INITIAL_FORM);

  /*
   * Same reason as the driver application: the account is requested at submit,
   * so the app navigates away with a filled form and `useState` doesn't come
   * back. Four sections of typing is too much to lose at the last step.
   */
  const {
    draft,
    ready: draftReady,
    save: saveDraft,
    clear: clearDraft,
  } = useFormDraft<BookingForm>('loci.draft.booking');

  const restoredDraft = useRef(false);

  useEffect(() => {
    if (!draftReady || restoredDraft.current || !draft) return;
    restoredDraft.current = true;
    /* Merged onto the current shape — see `mergeDraft` for why never assigned. */
    setForm(mergeDraft(INITIAL_FORM, draft));
  }, [draftReady, draft]);

  useEffect(() => {
    if (!draftReady) return;
    saveDraft(form);
  }, [draftReady, form, saveDraft]);
  const [errors, setErrors] = useState<FieldErrors>({});

  /*
   * Which sitting, and whether they have confirmed.
   *
   * The step is not part of the saved draft: the answers survive a trip to
   * sign-in, the position does not. Landing back on page three with no memory
   * of one and two is disorienting, and re-reading your own answers is cheap.
   */
  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState(false);

  /*
   * ---------- Identity ----------
   *
   * ⚠ Held apart from `form`, deliberately, and this is the important part.
   *
   *   Everything in `form` is written to an on-device draft on every keystroke
   *   (`useFormDraft` above) so four sections of typing survive a sign-in
   *   redirect. A NIN in there would be a government identifier cached in
   *   AsyncStorage, unencrypted, on a phone that may be shared or resold — and
   *   it would sit there until the draft expired.
   *
   *   Identity also belongs to the *account*, not to the parcel. A second
   *   shipment does not re-ask for it, so it was never form state.
   */
  /*
   * ⚠ Read again, for the gate rather than for a form.
   *
   *   This fetch was removed when the NIN card moved to the profile — there was
   *   nothing left on this screen that depended on it. The just-in-time gate
   *   brings it back, but for a different purpose: the form does not change
   *   shape, and nothing here asks for a NIN. The record only decides whether
   *   Post Parcel goes through.
   */
  const [identity, setIdentity] = useState<SenderIdentity | null>(null);

  useEffect(() => {
    /*
     * Signed out is not "unverified" — it is "unknown". The gate is only
     * reached after `requireAuth`, so a signed-out visitor never sees it.
     */
    let cancelled = false;
    void fetchSenderIdentity().then((found) => {
      if (!cancelled) setIdentity(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const scrollRef = useRef<ScrollView>(null);
  /*
   * Back to the top on every step change.
   *
   * An effect rather than a call inside `goNext`, so Back and the progress
   * indicator get it too — and so does a failed submit, which jumps to whichever
   * step has the problem. `animated: false` because this is a page turn, not a
   * scroll; animating it flies the new step's fields past on the way.
   *
   * Reuses the existing `scrollRef`, which already scrolls to the item card
   * when a photo is rejected.
   */
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [step]);

  /*
   * The live photo, banked on page three before the parcel is posted.
   *
   * ⚠ Not part of the saved draft, and not part of `form`.
   *
   *   A capture session is single-use and tied to the account that opened it.
   *   Restoring one from a draft written yesterday would mean a Post button
   *   that looked ready and failed at the last statement — `consume_capture_
   *   session` refuses a session already spent — with nothing on screen
   *   explaining why. It is re-taken each sitting, which is also the honest
   *   thing for a photo whose whole claim is that it was taken just now.
   */
  const [photoSession, setPhotoSession] = useState<string | null>(null);
  /** What the identity check said, shown on the card. Never blocks the parcel. */
  const [identityNote, setIdentityNote] = useState('');
  const [posting, setPosting] = useState(false);
  const declaredValueRef = useRef<TextInput>(null);
  const itemCardY = useRef(0);
  /** Guards against re-applying the prefill on every re-render. */
  const appliedService = useRef<string | null>(null);
  const appliedHub = useRef<string | null>(null);

  /**
   * A hub chosen on the locations screen. Sets the origin city and the pickup
   * area, and switches the pickup end to hub drop-off — picking a hub is the
   * statement that you'll take the parcel there yourself.
   */
  useEffect(() => {
    const hubKey = `${params.originCity ?? ''}|${params.pickupArea ?? ''}`;
    if (!params.originCity || appliedHub.current === hubKey) return;
    appliedHub.current = hubKey;

    const originCity = asOption(CITIES, params.originCity);
    if (!originCity) return;

    setForm((prev) => {
      // Only offer the area if that city actually lists it; otherwise leave the
      // picker empty rather than selecting something that isn't in its options.
      const areas = areasForCity(originCity);
      const area = params.pickupArea && areas.includes(params.pickupArea) ? params.pickupArea : '';

      return {
        ...prev,
        pickupMode: 'hub',
        originCity,
        destinationCity: prev.deliveryType === 'local' ? originCity : prev.destinationCity,
        pickupAreaSelection: area,
        pickupAreaCustom: '',
      };
    });
  }, [params.originCity, params.pickupArea]);

  // Apply the service prefill handed over from the home screen's service sheet.
  useEffect(() => {
    const service = params.service;
    if (!service || appliedService.current === service) return;
    appliedService.current = service;

    const deliveryType = asOption(DELIVERY_TYPES, params.deliveryType);

    if (deliveryType) {
      setForm((prev) => ({
        ...prev,
        deliveryType,
        // Local keeps both ends on one city; see setDeliveryType.
        destinationCity: deliveryType === 'local' ? prev.originCity : prev.destinationCity,
      }));
    }

    if (params.focusDeclaredValue === '1') {
      // Wait for layout so the scroll target is measured.
      const timer = setTimeout(() => {
        scrollRef.current?.scrollTo({ y: Math.max(itemCardY.current - 12, 0), animated: true });
        declaredValueRef.current?.focus();
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [params.service, params.deliveryType, params.focusDeclaredValue]);

  const isLocal = form.deliveryType === 'local';

  // Resolved locations — these are what get stored and what the summary shows.
  const originArea = resolveArea(form.pickupAreaSelection, form.pickupAreaCustom);
  const destinationArea = resolveArea(form.dropoffAreaSelection, form.dropoffAreaCustom);
  const originLocation = originArea
    ? `${originArea}, ${form.originCity}`
    : cityHubLabel(form.originCity);
  const destinationLocation = destinationArea
    ? `${destinationArea}, ${isLocal ? form.originCity : form.destinationCity}`
    : cityHubLabel(isLocal ? form.originCity : form.destinationCity);

  /*
   * ⚠ Coordinates live outside the form, deliberately.
   *
   *   `BookingForm` is validated field by field, serialised into the draft and
   *   posted to the server. A coordinate belongs to none of that: it is not
   *   required, not validated, and not stored on the parcel. Keeping it here
   *   means the draft that a sender resumes tomorrow has an address and no
   *   stale point, which is the honest state — the address is what a driver
   *   reads, and re-measuring costs nothing.
   */
  const [pickupPoint, setPickupPoint] = useState<Point | null>(null);
  const [dropoffPoint, setDropoffPoint] = useState<Point | null>(null);
  const [distance, setDistance] = useState<Distance | null>(null);

  /*
   * ⚠ The booking and the quick quote have to agree about the same journey.
   *
   *   The quote on the landing page prices on the measured distance. Until
   *   this ran, the booking form did not — so a sender quoted ₦18,500 for
   *   Abuja→Lagos reached the booking form and was charged ₦5,400 for the
   *   identical parcel. Whichever number is right, two different numbers for
   *   one journey is the kind of thing people screenshot.
   *
   *   Only doorstep addresses have coordinates. A hub pickup or collection
   *   measures nothing and falls back to the flat band, exactly as before —
   *   `estimateFee` treats an absent distance as zero, which `verify-pricing`
   *   pins to the naira.
   */
  useEffect(() => {
    if (!pickupPoint || !dropoffPoint) {
      setDistance(null);
      return;
    }

    let cancelled = false;
    void measureDistance(pickupPoint, dropoffPoint).then((measured) => {
      if (!cancelled) setDistance(measured);
    });

    return () => {
      cancelled = true;
    };
  }, [pickupPoint, dropoffPoint]);

  // Live quote — recalculates as the sender types or flips any of the toggles.
  const fee = useMemo(
    () =>
      estimateFee({
        deliveryType: form.deliveryType,
        weight: Number(form.weight),
        declaredValue: parseAmountInput(form.declaredValue),
        pickupMode: form.pickupMode,
        dropoffMode: form.dropoffMode,
        distanceKm: distance?.km,
      }),
    [
      form.deliveryType,
      form.weight,
      form.declaredValue,
      form.pickupMode,
      form.dropoffMode,
      distance?.km,
    ],
  );

  const { hubs: allHubs } = useHubs();

  const cityHubs = useMemo(() => hubsForCity(allHubs, form.originCity), [allHubs, form.originCity]);

  /**
   * Picking a hub sets the area too. `pickupArea` is what the route label, the
   * driver feed and the local same-area check all read, so leaving it empty
   * would break them — the hub is the more specific fact, the area is derived.
   */
  const selectHub = (hubId: string) => {
    const hub = findHub(allHubs, hubId);
    if (!hub) return;

    setForm((prev) => ({
      ...prev,
      pickupHubId: hubId,
      pickupAreaSelection: hub.area,
      pickupAreaCustom: '',
    }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next.pickupHubId;
      delete next.pickupAreaSelection;
      return next;
    });
  };

  /**
   * How each end reads in the summary. The handover mode leads, because that's
   * what decides both where the parcel changes hands and what it costs; the
   * place follows.
   */
  const pickupSummary = useMemo(() => {
    const hub = form.pickupMode === 'hub' ? findHub(allHubs, form.pickupHubId) : undefined;
    if (form.pickupMode === 'hub' && !hub) {
      return `${handoverModeLabel('hub', 'pickup')} · not chosen yet (${form.originCity})`;
    }
    return pickupSummaryLine({
      mode: form.pickupMode,
      // In hub mode the hub itself is the address, stored on the booking in
      // exactly this shape — so this screen and the confirmation read alike.
      address: hub ? `${hub.name}, ${hub.address}` : form.pickupAddress,
      area: hub ? '' : originArea,
      city: form.originCity,
    });
  }, [form.pickupMode, form.pickupHubId, form.pickupAddress, form.originCity, originArea]);

  const dropoffSummary = useMemo(
    () =>
      dropoffSummaryLine({
        mode: form.dropoffMode,
        address: form.dropoffAddress,
        area: destinationArea,
        city: isLocal ? form.originCity : form.destinationCity,
      }),
    [
      form.dropoffMode,
      form.dropoffAddress,
      form.originCity,
      form.destinationCity,
      destinationArea,
      isLocal,
    ],
  );

  const setField = <K extends keyof BookingForm>(key: K, value: BookingForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /**
   * Switching to Local collapses both cities onto the origin. Any dropoff area
   * chosen for the old destination city is cleared, since area lists are
   * city-specific.
   */
  const setDeliveryType = (deliveryType: DeliveryType) => {
    setForm((prev) => {
      if (deliveryType === prev.deliveryType) return prev;

      const collapsing = deliveryType === 'local' && prev.destinationCity !== prev.originCity;
      return {
        ...prev,
        deliveryType,
        destinationCity: deliveryType === 'local' ? prev.originCity : prev.destinationCity,
        ...(collapsing && { dropoffAreaSelection: '', dropoffAreaCustom: '' }),
      };
    });
    setErrors({});
  };

  /** In Local mode the single city selector drives both ends of the route. */
  const setOriginCity = (city: City) => {
    // A hub in the old city can't survive the change.
    setForm((prev) => (prev.pickupHubId ? { ...prev, pickupHubId: '' } : prev));
    setForm((prev) => {
      if (city === prev.originCity) return prev;
      const isLocalMode = prev.deliveryType === 'local';

      return {
        ...prev,
        originCity: city,
        // Pickup areas belong to the origin city, so they can't survive the change.
        pickupAreaSelection: '',
        pickupAreaCustom: '',
        ...(isLocalMode && {
          destinationCity: city,
          dropoffAreaSelection: '',
          dropoffAreaCustom: '',
        }),
      };
    });
    setErrors({});
  };

  const setDestinationCity = (city: City) => {
    setForm((prev) => {
      if (city === prev.destinationCity) return prev;
      return { ...prev, destinationCity: city, dropoffAreaSelection: '', dropoffAreaCustom: '' };
    });
    setErrors((prev) => ({ ...prev, destinationCity: undefined }));
  };

  /**
   * Forward, if this step is complete.
   *
   * ⚠ Only this step's errors are written, and step two also runs the identity
   *   check.
   *
   *   `validate` is a pure function about parcels and knows nothing about NINs
   *   — see `handleSubmit` — so the sender's identity is checked alongside it
   *   rather than inside it. Step two is where the sender is asked about, so
   *   step two is where that check belongs; leaving it to submit would let
   *   somebody reach the last page and be sent back two.
   */
  const goNext = () => {
    const all = validate(form, allHubs);
    const mine = errorsForStep(step, all);

    if (Object.keys(mine).length > 0) {
      setErrors((previous) => ({ ...previous, ...mine }));
      return;
    }

    /*
     * Clear this step's messages on the way out, so a field corrected after it
     * errored does not keep its red text when somebody comes back to it.
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
    const nextErrors = validate(form, allHubs);
    setErrors(nextErrors);

    /*
     * Identity is validated beside the form, not inside `validate`.
     *
     * `validate` takes the booking and returns errors keyed on booking fields;
     * threading an account-level concern through it would mean every caller of
     * a pure function about parcels had to know about NINs. It also only
     * applies on the first parcel, which `validate` has no way to know.
     */
    if (Object.keys(nextErrors).length > 0) {
      /*
       * ⚠ Sent to the step that has the problem, not just told there is one.
       *
       *   "Some required details are missing or invalid" was tolerable on a
       *   single page where the red field was somewhere on screen. Across three
       *   pages it is a dead end: the offending field may be two steps back and
       *   nothing says so. The dialog now names the step and the form goes
       *   there.
       */
      /*
       * Only booking fields can be wrong now. The identity errors that used to
       * pin this to step one went with the card.
       */
      const firstBad = STEPS.findIndex(
        (_, index) => Object.keys(errorsForStep(index, nextErrors)).length > 0,
      );

      if (firstBad >= 0) setStep(firstBad);

      showDialog(
        'Check the form',
        firstBad >= 0
          ? `Something on "${STEPS[firstBad].label}" is missing or invalid. We have taken you back to it.`
          : 'Some required details are missing or invalid.',
      );
      return;
    }

    /*
     * ⚠ The photo is checked here as well as by the disabled button.
     *
     *   The button is disabled without one, so this looks unreachable — until
     *   the account signs out between capture and post, or a draft restores
     *   with the checkbox ticked. A guard that is only in the UI is a guard
     *   that holds until the first path nobody thought of.
     */
    if (!photoSession) {
      setStep(STEPS.length - 1);
      showDialog(
        'Take the live photo first',
        'Every LOCI parcel carries a photo of the person who posted it. It is the last item on this page.',
      );
      return;
    }

    /*
     * ⚠ The verification gate, checked here and nowhere earlier.
     *
     *   Just-in-time: the whole form is fillable by anybody, and this is the
     *   only refusal. Gating on entry would send somebody to a NIN form before
     *   they knew what the delivery costs, which is the pattern this replaced.
     *
     *   It stops one group — accounts that have never submitted a NIN. Somebody
     *   waiting on a check, or flagged for review, goes through; so does
     *   everybody if verification itself is unreachable. See `postingGate`.
     */
    const gate = postingGate(identity);

    if (!gate.allowed) {
      /*
       * ⚠ The reason travels with the refusal.
       *
       *   One fixed sentence was right while `unverified` was the only way to
       *   be stopped. A rejected sender needs to read what a reviewer actually
       *   said, here, at the moment they are stopped — not to go looking for
       *   it on another screen.
       */
      showDialog(
        gateTitle(gate),
        `${blockedMessage(gate, identity?.reviewNote ?? null)} ${FORM_IS_SAVED}`,
        /*
         * ⚠ The route out is offered only when there is one.
         *
         *   Somebody waiting on a review has nothing to do on the profile
         *   screen, and re-submitting there would reset their place in the
         *   queue. Sending them anyway would be a button that makes their
         *   situation worse.
         */
        canActNow(gate)
          ? [
              { text: 'Not now', style: 'cancel' },
              {
                text: 'Go to my profile',
                onPress: () => router.push('/(tabs)/profile'),
              },
            ]
          : [{ text: 'OK' }],
      );
      return;
    }

    /*
     * Validate first, then ask for an account. The other order — gate on entry —
     * makes someone sign in before they know whether their parcel is even
     * bookable, and loses everything they typed if they bounce out. Here the
     * form is already complete and the state survives the round trip.
     */
    requireAuth(() => void post(photoSession), {
      title: 'Sign in to post this parcel',
      reason:
        'A parcel needs an owner: it is how you track it, and how the driver knows who to call at pickup. Your details stay filled in.',
      next: '/book',
    });
  };

  const post = async (sessionId: string) => {
    setPosting(true);
    try {
      await postParcel(sessionId);
    } finally {
      setPosting(false);
    }
  };

  /*
   * The photo, taken on page three rather than after the button.
   *
   * ⚠ Two paths, because the sender may not have been checked before.
   *
   *   First parcel: the NIN and the slip from page two go up with the selfie,
   *   and a match promotes this photo to the account's master reference.
   *   Afterwards: the selfie alone, compared against that reference.
   *
   *   Neither outcome stops the parcel. A mismatch is recorded for a person to
   *   look at — a sender whose NIMC photo is eight years old has done nothing
   *   wrong, and a form that refused them would be wrong far more often than
   *   they are.
   */
  const handlePhotoCaptured = async (sessionId: string) => {
    /*
     * ⚠ The session is banked whatever the identity check says.
     *
     *   The parcel's requirement is the photograph, and it exists — it is
     *   uploaded and it has passed liveness. The NIN match is an account-level
     *   record that nothing in this form depends on, and the rule everywhere
     *   else in LOCI is that it never blocks a shipment. Withholding the
     *   session on a failed slip upload would turn "we could not reach the
     *   provider" into "you cannot send a parcel".
     */
    setPhotoSession(sessionId);

    /*
     * ⚠ One path now, where there were two.
     *
     *   The onboarding branch uploaded a NIN and slip collected on step two.
     *   Those are gathered on the profile instead, so this is always the plain
     *   check: matched against the account's reference photo when there is one,
     *   recorded when there is not.
     *
     * ⚠ The reassurance that used to be here was made false by 42.
     *
     *   It read "Your parcel is not held up", which was true while an
     *   unverified sender could post. Only a verified sender reaches this point
     *   now — the gate has already run — so a failure here is a failure to
     *   record *this shipment's* selfie, not a verification problem. Saying the
     *   parcel is fine would be guessing about a row the server has not written.
     */
    const outcome = await runIdentityCheck(sessionId);

    if (!outcome.ok) {
      setIdentityNote('We could not record that photo. Try taking it again.');
      return;
    }

    setIdentityNote(outcome.message);
  };

  /** Runs only once we know who is posting. */
  const postParcel = async (photoSessionId: string) => {
    // TODO: replace with an API call; the store is the local source of truth for now.
    const booking = await addBooking({
      deliveryType: form.deliveryType,
      pickupMode: form.pickupMode,
      dropoffMode: form.dropoffMode,
      originCity: form.originCity,
      destinationCity: isLocal ? form.originCity : form.destinationCity,
      pickupArea: originArea,
      // Hub legs have no address field on screen, so don't carry over a stale
      // one the sender typed before switching mode.
      /*
        A hub pickup does have an address — the hub's. Storing it means the
        driver's job card names the place rather than just the neighbourhood.
      */
      pickupAddress:
        form.pickupMode === 'doorstep'
          ? form.pickupAddress.trim()
          : (() => {
              const hub = findHub(allHubs, form.pickupHubId);
              return hub ? `${hub.name}, ${hub.address}` : '';
            })(),
      dropoffArea: destinationArea,
      dropoffAddress: form.dropoffMode === 'hub' ? '' : form.dropoffAddress.trim(),
      /*
        No coordinates from this form any more.

        Both map pickers are gone: a pin dropped on an OpenStreetMap tile in a
        Nigerian city is often off by a street or more, and a sender who placed
        one trusted it over the address they had typed. The written address is
        the thing a driver can actually act on.

        The columns stay, because parcels posted before this change carry real
        pins and the tracking map still draws those.
      */
      pickupLat: null,
      pickupLng: null,
      dropoffLat: null,
      dropoffLng: null,
      pickupContactName: form.pickupContactName.trim(),
      senderPhone: normalizePhone(form.senderPhone),
      recipientName: form.recipientName.trim(),
      recipientPhone: normalizePhone(form.recipientPhone),
      itemDescription: form.itemDescription.trim(),
      itemPhotoUri: form.itemPhotoUri || null,
      category: form.category,
      weight: Number(form.weight),
      declaredValue: parseAmountInput(form.declaredValue) || 0,
      fragile: form.fragile,
      notes: form.notes.trim(),
      estimatedFee: fee.total,
    });

    /*
     * The insert can fail — offline, RLS refusal, a duplicate tracking id. Bail
     * before clearing the form, or a network blip silently destroys four
     * sections of typing. `error` on the store carries the reason.
     */
    if (!booking) {
      showDialog(
        'Could not post the parcel',
        'Your details are still here. Check your connection and try again.',
      );
      return;
    }

    /*
     * Attach the photo, now that there is a parcel to attach it to.
     *
     * The upload already happened — `resolveSenderPhoto` did it against the
     * capture session, which exists precisely because there was no booking row
     * yet. All that is left is to spend the session on this parcel, which the
     * server allows exactly once.
     *
     * A failure here is swallowed rather than raised. The parcel is already
     * posted and the photo is already stored; sending the sender back to a
     * completed form would lose the parcel in order to save the link to it.
     * The orphaned session is visible in the admin log.
     */
    if (isSupabaseConfigured) {
      try {
        await consumeCaptureSession(photoSessionId, booking.id);
      } catch {
        // Photo stored, link not made. Recoverable by hand; the parcel is safe.
      }

      /*
       * And the photograph of the parcel itself, which until now was thrown
       * away.
       *
       * ⚠ The form has required this since it shipped and nothing ever stored
       *   it. `bookings-remote.ts` sent `item_photo_uri: null` on purpose —
       *   the picker returns a local `file://` URI that means nothing on
       *   another device — so a sender was asked for evidence of condition at
       *   handover and it was discarded at the door. See 36_parcel_photos.sql.
       *
       * Uploaded here rather than at capture, because the storage policy checks
       * the object's folder against a booking whose sender is the caller: there
       * has to be a parcel first. Same swallow as the session above, for the
       * same reason — the parcel is posted and has a tracking id, and a failed
       * photo upload must not send somebody back to a form they have finished.
       */
      if (form.itemPhotoUri) {
        const stored = await uploadParcelPhoto(booking.id, form.itemPhotoUri);
        if (!stored.ok) {
          showToast('Parcel photo not saved', {
            message: `${stored.error} Your parcel is posted — support can add the photo.`,
            tone: 'info',
          });
        }
      }
    }

    // Posted and stored — the draft has done its job.
    void clearDraft();
    setForm(INITIAL_FORM);
    setErrors({});

    /*
      A confirmation screen rather than an alert: this form is four sections
      long, and an OS dialog that vanishes on tap is a poor place to put the
      one number the sender needs to keep. `replace` so the back gesture can't
      return to a submitted form and post it twice.
    */
    router.replace({
      pathname: '/parcel-confirmed',
      params: { trackingId: booking.trackingId },
    });
  };

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={[styles.container, styles.scrollContent]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        <View style={styles.content}>
          {/*
            The title and the delivery type, scrolling with the form.

            ⚠ These used to be pinned — a sibling of the ScrollView rather than
              a child of it, which is the only arrangement that keeps a block
              still in React Native.

              The reasoning then was that the delivery type is not a form field:
              it sets the price line, decides which fields appear below, and
              limits which cities are selectable, so scrolling it away leaves
              you filling in a form with no visible sign of which of the two it
              is. That is all still true — and it bought about 140px of every
              screen, permanently, on the longest form in the app.

              The answer to "which of the two is this" is on screen twice more
              anyway: the price summary on page three names the delivery type,
              and the fields themselves differ. What a pinned strip cost was
              room to fill in the form it sat above.
          */}
          <View style={[styles.intro, { borderBottomColor: theme.border }]}>
            {/*
              A title, not a screen header.

              `ScreenHeader` renders at `screenTitle` — 28px with 24px of margin
              beneath — which is right for a page you arrive at and read, and
              heavy for the top of a three-step form. The delivery-type pills
              matter more than the title does: they change the price and the
              shape of every question below. So they get the space.
            */}
            <Text style={[styles.introTitle, { color: theme.text }]}>Post a Parcel</Text>

            <SegmentedControl
              options={DELIVERY_TYPES}
              selected={form.deliveryType}
              onSelect={setDeliveryType}
              renderLabel={(type) => DELIVERY_TYPE_TITLES[type]}
            />

            {/*
              The pricing line stays. It is the only place the base fare appears
              before the summary on page three, and somebody choosing between the
              two pills is choosing on price.
            */}
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              {isLocal
                ? `Within one city · base ${formatNaira(PRICING.base.local)} + ${formatNaira(PRICING.perKg.local)}/kg`
                : `Between two cities · base ${formatNaira(PRICING.base.interstate)} + ${formatNaira(PRICING.perKg.interstate)}/kg`}
            </Text>
          </View>

          {/*
            ⚠ Above the wizard, and it does not stop the wizard.

              The form stays entirely fillable — that is the point of a
              just-in-time gate. This is the warning that makes the refusal at
              Post Parcel unsurprising rather than a wall somebody hits after
              ten minutes of typing.
          */}
          <VerifyBanner />

          {/* --------------------------------------------- the wizard ---- */}
          <WizardProgress steps={STEPS} current={step} onJump={setStep} />

          {step === 0 && (
            <>
              {/* 2 — Item details */}
              <Card
                style={styles.card}
                onLayout={(event) => {
                  itemCardY.current = event.nativeEvent.layout.y;
                }}>
                <SectionHeading
                  icon={<PackageOpen color={theme.primary} size={18} />}
                  title="Item details"
                />

                <Field
                  label="Item title"
                  icon={(color, size) => <Tag color={color} size={size} />}
                  placeholder="Laptop charger and cables"
                  value={form.itemDescription}
                  onChangeText={(text) => setField('itemDescription', text)}
                  error={errors.itemDescription}
                />

                <Dropdown
                  label="Category"
                  options={CATEGORIES}
                  selected={form.category}
                  onSelect={(value) => setField('category', value)}
                  icon={(color, size) => <PackageOpen color={color} size={size} />}
                />

                {/*
              Required. This form marks optional fields and leaves required ones
              plain, so there is no asterisk here — adding one to a single field
              would imply everything else is optional.
            */}
                <PhotoPicker
                  label="Photo of the parcel"
                  hint="Confirms the parcel's condition at handover and collection."
                  value={form.itemPhotoUri}
                  onChange={(uri) => setField('itemPhotoUri', uri)}
                  error={errors.itemPhotoUri}
                />

                <View style={styles.row}>
                  <View style={styles.rowItem}>
                    <Field
                      label="Weight (kg)"
                      icon={(color, size) => <Weight color={color} size={size} />}
                      placeholder="2.5"
                      value={form.weight}
                      onChangeText={(text) => setField('weight', text)}
                      error={errors.weight}
                      keyboardType="decimal-pad"
                    />
                  </View>
                  <View style={styles.rowItem}>
                    <Field
                      inputRef={declaredValueRef}
                      label="Declared value (₦)"
                      icon={(color, size) => <Banknote color={color} size={size} />}
                      placeholder="45,000"
                      value={form.declaredValue}
                      onChangeText={(text) => setField('declaredValue', formatAmountInput(text))}
                      error={errors.declaredValue}
                      /*
                        "For insurance" read as an explanation of an optional
                        extra. It is what the cover and any payout are based
                        on, and saying so is what makes the 1% line on the
                        fare make sense.
                      */
                      hint={
                        errors.declaredValue
                          ? undefined
                          : 'What the parcel is worth — sets the cover and the payout'
                      }
                      keyboardType="number-pad"
                    />
                  </View>
                </View>

                <ToggleRow
                  label="Fragile / Handle with care"
                  description="Flags the job for drivers to ensure careful handling at no extra cost"
                  value={form.fragile}
                  onValueChange={(value) => setField('fragile', value)}
                  icon={(color, size) => <ShieldAlert color={color} size={size} />}
                />
              </Card>
            </>
          )}

          {step === 1 && (
            <>
              {/* 3 — Locations & route */}
              <Card style={styles.card}>
                <SectionHeading icon={<MapPin color={theme.primary} size={18} />} title="Pickup" />

                <ModeSelector
                  label="How should a driver pick up the item(s)?"
                  value={form.pickupMode}
                  options={PICKUP_MODES}
                  onChange={(value) => setField('pickupMode', value)}
                />

                <Dropdown
                  label={isLocal ? 'Select city' : 'Origin hub'}
                  options={CITIES}
                  selected={form.originCity}
                  onSelect={setOriginCity}
                  renderLabel={cityHubLabel}
                  icon={(color, size) => <Building2 color={color} size={size} />}
                  // 37 cities — scrolling to "Yola" is a long way down.
                  searchable
                  searchPlaceholder="Search city or state"
                />

                {/*
              Hub mode offers the actual partner hubs in the selected city, not
              neighbourhoods — the label promised LOCI locations, so the options
              have to be LOCI locations. Public-location pickup keeps the area
              picker, where naming a neighbourhood is the right question.
            */}
                {form.pickupMode === 'hub' ? (
                  cityHubs.length > 0 ? (
                    <Dropdown
                      label="Pickup LOCI area"
                      options={cityHubs.map((hub) => hub.id)}
                      selected={form.pickupHubId}
                      onSelect={selectHub}
                      renderLabel={(id) => {
                        const hub = findHub(allHubs, id);
                        return hub ? hubLabel(hub) : id;
                      }}
                      placeholder={`Choose a hub in ${form.originCity}`}
                      icon={(color, size) => <Store color={color} size={size} />}
                      /*
                    Matching runs on the rendered label — "LOCI Bodija Hub —
                    Bodija" — so typing either the hub name or the neighbourhood
                    finds it, which is how someone would actually look.
                  */
                      searchable
                      searchPlaceholder="Search hub or area"
                      error={errors.pickupHubId}
                    />
                  ) : (
                    /*
                  33 of the 37 cities have no hub yet. Rather than an empty
                  dropdown, say so and offer the one action that unblocks them.
                */
                    <View style={[styles.noHubs, { backgroundColor: theme.warningSoft }]}>
                      <Store color={theme.warningOnSoft} size={16} />
                      <View style={styles.noHubsText}>
                        <Text style={[styles.noHubsTitle, { color: theme.warningOnSoft }]}>
                          No LOCI hub in {form.originCity} yet
                        </Text>
                        <Text style={[styles.noHubsBody, { color: theme.warningOnSoft }]}>
                          Switch to public location pickup and a driver will collect from a spot you
                          choose, or pick a different origin city.
                        </Text>
                        <Button
                          label="Use public location pickup"
                          size="md"
                          variant="secondary"
                          style={styles.noHubsCta}
                          onPress={() => setField('pickupMode', 'doorstep')}
                        />
                      </View>
                    </View>
                  )
                ) : (
                  <AreaPicker
                    label="Pickup area"
                    city={form.originCity}
                    selection={form.pickupAreaSelection}
                    onSelectionChange={(value) => setField('pickupAreaSelection', value)}
                    customValue={form.pickupAreaCustom}
                    onCustomChange={(value) => setField('pickupAreaCustom', value)}
                    error={errors.pickupAreaSelection ?? errors.pickupAreaCustom}
                  />
                )}

                {/* A hub drop-off has no street address to collect from. */}
                {form.pickupMode === 'doorstep' && (
                  <AddressLookup
                    label="Pickup address"
                    icon={(color, size) => <MapPin color={color} size={size} />}
                    placeholder="12 Awolowo Avenue"
                    value={form.pickupAddress}
                    onChange={(next) => {
                      setField('pickupAddress', next.address);
                      setPickupPoint(next.point);
                    }}
                    error={errors.pickupAddress}
                    hint="Search for the address, or write it out in full."
                    multiline
                  />
                )}

                <Field
                  label={form.pickupMode === 'hub' ? 'Who is dropping it off?' : 'Contact person'}
                  icon={(color, size) => <UserRound color={color} size={size} />}
                  placeholder="Who hands over the parcel"
                  value={form.pickupContactName}
                  onChangeText={(text) => setField('pickupContactName', text)}
                  error={errors.pickupContactName}
                  autoCapitalize="words"
                />

                {/*
              At a hub the sender brings the parcel in, so "Pickup phone" names
              a collection that isn't happening. The number is the same contact
              either way.
            */}
                <ValidatedPhoneInput
                  label={form.pickupMode === 'hub' ? 'Phone number' : 'Pickup phone'}
                  value={form.senderPhone}
                  onChangeText={(text) => setField('senderPhone', text)}
                  showError={Boolean(errors.senderPhone)}
                />

                {/*
                  ---------- Identity ----------

                  ⚠ Nothing here any more, and the absence is the change.

                    A NIN and a photo of the NIN slip used to sit directly under
                    the phone number, asked of everybody posting their first
                    parcel. That put a government ID check in the middle of
                    somebody trying to send a package — the highest-intent
                    moment in the app and the worst place to interrupt.

                    It is on the profile screen now, where it belongs: the check
                    is about the *account*, and a second parcel never re-asked
                    for it anyway. Verifying is no longer a step on the way to
                    sending; it is something an account either has done or has
                    not.

                    The per-parcel selfie is untouched and still on step three.
                    That one really is about this parcel — it is the record of
                    who handed it over — and it is what makes the NIN check
                    worth anything, because it is compared against the reference
                    photo verification produces.
                */}
              </Card>
            </>
          )}

          {step === 2 && (
            <>
              <Card style={styles.card}>
                <SectionHeading
                  icon={<Navigation color={theme.success} size={18} />}
                  title="Dropoff"
                />

                {/*
              Hub collection is the default and needs no control — it's what
              happens unless the sender opts into a door run. The toggle below
              is the only choice, so a radio pair would have been two controls
              for one decision.
            */}
                <View style={[styles.defaultNote, { backgroundColor: theme.surfaceMuted }]}>
                  <Building2 color={theme.textSecondary} size={16} />
                  <Text style={[styles.defaultNoteText, { color: theme.textSecondary }]}>
                    <Text style={[styles.defaultNoteValue, { color: theme.text }]}>
                      LOCI hub (OTP Collection)
                    </Text>{' '}
                    — This only if uncollected, parcel will be moved to the LOCI hub. This transfer
                    may incur a mileage-based surcharge
                  </Text>
                </View>

                {/*
              Two independent states over one field:
                unselected        -> 'hub'        ₦0
                selected, off     -> 'meetpoint'  ₦0
                selected, on      -> 'doorstep'   +₦800
              Selecting the card never turns the switch on, so choosing delivery
              to the recipient cannot silently add a fee.
            */}
                <SelectableUpgradeCard
                  label={DOORSTEP_DROPOFF.label}
                  description={DOORSTEP_DROPOFF.description}
                  selected={form.dropoffMode !== 'hub'}
                  onSelectedChange={(on) => setField('dropoffMode', on ? 'meetpoint' : 'hub')}
                  upgraded={form.dropoffMode === 'doorstep'}
                  onUpgradedChange={(on) => setField('dropoffMode', on ? 'doorstep' : 'meetpoint')}
                  upgradeLabel={DOORSTEP_DROPOFF.upgradeLabel}
                  upgradeHint={DOORSTEP_DROPOFF.upgradeHint}
                  badge={SURCHARGE_BADGE}
                  icon={(color, size) => <Navigation color={color} size={size} />}
                />

                {isLocal ? (
                  <View style={[styles.lockedCity, { backgroundColor: theme.surfaceMuted }]}>
                    <Building2 color={theme.textSecondary} size={16} />
                    <Text style={[styles.lockedCityText, { color: theme.textSecondary }]}>
                      Same city —{' '}
                      <Text style={[styles.lockedCityValue, { color: theme.text }]}>
                        {cityHubLabel(form.originCity)}
                      </Text>
                    </Text>
                  </View>
                ) : (
                  <Dropdown
                    label="Destination hub"
                    options={CITIES}
                    selected={form.destinationCity}
                    onSelect={setDestinationCity}
                    renderLabel={cityHubLabel}
                    icon={(color, size) => <Building2 color={color} size={size} />}
                    searchable
                    searchPlaceholder="Search city or state"
                    error={errors.destinationCity}
                    // An inter-state trip can't start and end in the same hub.
                    disabledOptions={[form.originCity]}
                    disabledHint="Already your origin"
                  />
                )}

                <AreaPicker
                  label="Dropoff area"
                  city={isLocal ? form.originCity : form.destinationCity}
                  selection={form.dropoffAreaSelection}
                  onSelectionChange={(value) => setField('dropoffAreaSelection', value)}
                  customValue={form.dropoffAreaCustom}
                  onCustomChange={(value) => setField('dropoffAreaCustom', value)}
                  error={errors.dropoffAreaSelection ?? errors.dropoffAreaCustom}
                />

                {/*
              Hub collection needs no address — the recipient comes to us. Both
              other modes need somewhere to go, so the field follows the card's
              selected state rather than the upgrade switch.
            */}
                {form.dropoffMode !== 'hub' && (
                  <AddressLookup
                    label={form.dropoffMode === 'doorstep' ? 'Dropoff address' : 'Meeting point'}
                    icon={(color, size) => <Navigation color={color} size={size} />}
                    placeholder={
                      form.dropoffMode === 'doorstep'
                        ? '45 Allen Avenue'
                        : 'Total filling station, Allen Avenue'
                    }
                    value={form.dropoffAddress}
                    onChange={(next) => {
                      setField('dropoffAddress', next.address);
                      setDropoffPoint(next.point);
                    }}
                    error={errors.dropoffAddress}
                    hint={
                      form.dropoffMode === 'doorstep'
                        ? 'Search for the address, or write it out in full.'
                        : 'Search for the landmark, or describe where to meet.'
                    }
                    multiline
                  />
                )}

                <Field
                  label="Recipient name"
                  icon={(color, size) => <UserRound color={color} size={size} />}
                  placeholder="Ada Obi"
                  value={form.recipientName}
                  onChangeText={(text) => setField('recipientName', text)}
                  error={errors.recipientName}
                  autoCapitalize="words"
                />

                <ValidatedPhoneInput
                  label="Recipient phone"
                  value={form.recipientPhone}
                  onChangeText={(text) => setField('recipientPhone', text)}
                  showError={Boolean(errors.recipientPhone)}
                />

                <Field
                  label="Delivery notes (optional)"
                  icon={(color, size) => <StickyNote color={color} size={size} />}
                  placeholder="Call on arrival, leave with security..."
                  value={form.notes}
                  onChangeText={(text) => setField('notes', text)}
                  multiline
                />
              </Card>
              {/* 4 — Summary & cost estimate */}
              <Card style={[styles.card, styles.summaryCard, { borderColor: theme.primary }]}>
                <View style={styles.summaryHeader}>
                  <SectionHeading
                    icon={<Receipt color={theme.primary} size={18} />}
                    title="Delivery summary"
                  />
                  <Badge
                    label={isLocal ? 'Local' : 'Inter-State'}
                    tone={isLocal ? 'success' : 'primary'}
                  />
                </View>

                <View style={styles.summaryRouteRow}>
                  <Text style={[styles.summaryRoute, { color: theme.text }]} numberOfLines={2}>
                    {originLocation}
                  </Text>
                  <ArrowRight color={theme.primary} size={16} />
                  <Text style={[styles.summaryRoute, { color: theme.text }]} numberOfLines={2}>
                    {destinationLocation}
                  </Text>
                </View>

                <View style={[styles.divider, { backgroundColor: theme.border }]} />

                {/*
              A full read-back of the form, so the last thing before Confirm
              shows everything that's about to be posted rather than just the
              route and the price. Rows that have nothing to say are omitted —
              an empty "Notes: —" is noise, not reassurance.
            */}
                <ReviewRow
                  icon={<PackageOpen color={theme.textMuted} size={14} />}
                  label="Item"
                  value={
                    [
                      form.itemDescription.trim() || 'Not named yet',
                      form.category,
                      form.weight.trim() ? `${form.weight.trim()} kg` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') + (form.fragile ? ' · Fragile' : '')
                  }
                />
                <ReviewRow
                  icon={<Banknote color={theme.textMuted} size={14} />}
                  label="Declared"
                  value={
                    form.declaredValue.trim()
                      ? `${formatNaira(parseAmountInput(form.declaredValue))} — insured`
                      : 'Not declared — travels uninsured'
                  }
                />
                <ReviewRow
                  icon={<Tag color={theme.textMuted} size={14} />}
                  label="Photo"
                  value={form.itemPhotoUri ? 'Attached' : 'Not attached yet'}
                />

                <View style={[styles.divider, { backgroundColor: theme.border }]} />

                <ReviewRow
                  icon={<MapPin color={theme.textMuted} size={14} />}
                  label="Pickup"
                  value={pickupSummary}
                />
                {!!form.pickupContactName.trim() && (
                  <ReviewRow
                    icon={<UserRound color={theme.textMuted} size={14} />}
                    label={form.pickupMode === 'hub' ? 'Dropping off' : 'Contact'}
                    value={
                      form.pickupContactName.trim() +
                      (form.senderPhone.trim() ? ` · ${form.senderPhone.trim()}` : '')
                    }
                  />
                )}
                <ReviewRow
                  icon={<Navigation color={theme.textMuted} size={14} />}
                  label="Dropoff"
                  value={dropoffSummary}
                />
                {!!form.recipientName.trim() && (
                  <ReviewRow
                    icon={<UserRound color={theme.textMuted} size={14} />}
                    label="Recipient"
                    value={
                      form.recipientName.trim() +
                      (form.recipientPhone.trim() ? ` · ${form.recipientPhone.trim()}` : '')
                    }
                  />
                )}
                {!!form.notes.trim() && (
                  <ReviewRow
                    icon={<StickyNote color={theme.textMuted} size={14} />}
                    label="Notes"
                    value={form.notes.trim()}
                  />
                )}

                <View style={[styles.divider, { backgroundColor: theme.border }]} />

                <CostRow
                  label={`Base fare · ${isLocal ? 'Local' : 'Inter-State'}`}
                  value={fee.base}
                />
                <CostRow
                  label={`Weight · ${form.weight.trim() || 0} kg × ${formatNaira(PRICING.perKg[form.deliveryType])}`}
                  value={fee.weight}
                />
                {/*
              ⚠ Shown only when something was actually measured.

                A distance row reading ₦0 would tell a sender their journey has
                no length, when the truth is that nobody measured it — a hub
                pickup has no address to measure from. Silence is the accurate
                account of that.
            */}
                {fee.distance > 0 && (
                  <CostRow
                    label={`Distance · ${distanceLabel(distance)} × ${formatNaira(PRICING.perKm[form.deliveryType])}`}
                    value={fee.distance}
                  />
                )}
                {fee.insurance > 0 && (
                  <CostRow label="Insurance · 1% of declared value" value={fee.insurance} />
                )}
                {/*
              Absent entirely when neither leg is chargeable — a public-location
              pickup met at a hub, which is now the cheapest route through this
              form and the one the pricing is meant to steer people towards.
            */}
                {fee.handover > 0 && (
                  <CostRow
                    label={handoverFeeLabel(form.pickupMode, form.dropoffMode)}
                    value={fee.handover}
                  />
                )}

                <View style={[styles.divider, { backgroundColor: theme.border }]} />

                <View style={styles.totalRow}>
                  <Text style={[styles.totalLabel, { color: theme.text }]}>Estimated total</Text>
                  <Text style={[styles.totalValue, { color: theme.primary }]}>
                    {formatNaira(fee.total)}
                  </Text>
                </View>
                <Text style={[styles.disclaimer, { color: theme.textMuted }]}>
                  Estimate only. Final fare is confirmed when a driver accepts.
                </Text>
              </Card>

              {/*
                The live photo, as an item on the page.

                Above the confirmation on purpose: the checkbox says the sender
                identification is accurate, and it cannot honestly be ticked
                before the photograph that identification rests on has been
                taken.
              */}
              <LiveSelfieCard
                purpose="sender"
                captured={photoSession}
                note={identityNote}
                onCaptured={handlePhotoCaptured}
                onCleared={() => {
                  setPhotoSession(null);
                  setIdentityNote('');
                }}
                disabled={posting}
                gate={(proceed) =>
                  requireAuth(proceed, {
                    title: 'Sign in to take your photo',
                    reason:
                      'The photo is stored against your account, so we need to know whose it is. Your details stay filled in.',
                    next: '/book',
                  })
                }
              />

              {/*
                The confirmation, between the summary and the button.

                Deliberately after the live estimate rather than before it: the
                summary is the last thing worth reading, and a checkbox above it
                would be ticked before the number it is confirming had been
                seen.
              */}
              <ConfirmCheckbox
                checked={confirmed}
                onChange={setConfirmed}
                label="I confirm that all provided parcel details, sender identification, and delivery information are accurate."
              />
            </>
          )}

          {/*
            ⚠ Post parcel is gated by the checkbox and the photo, and by
              nothing else.

              Not by validation: a dead button on a three-page form tells
              somebody nothing about which of twenty fields is wrong, and they
              cannot even see most of them from here. `handleSubmit` runs the
              whole check and sends them to the step that has the problem.

              The photo is different — it is on *this* page, a foot above the
              button, with its own state visible. A disabled button there points
              at something the sender can see.
          */}
          <WizardNav
            onBack={step > 0 ? goBack : undefined}
            onNext={goNext}
            finalAction={
              step === STEPS.length - 1 ? (
                <Button
                  label={posting ? 'Posting…' : 'Confirm & Post Parcel'}
                  icon={(color, size) => <PackagePlus color={color} size={size} />}
                  onPress={handleSubmit}
                  disabled={!confirmed || !photoSession || posting}
                />
              ) : undefined
            }
          />
        </View>
        <Footer />
      </ScrollView>
    </KeyboardAvoidingView>
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

/** One read-back line in the summary. Wraps rather than truncating — a hub
 *  address or a set of delivery notes is worth seeing in full before posting. */
function ReviewRow({
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
    <View style={styles.reviewRow}>
      <View style={styles.reviewIcon}>{icon}</View>
      <Text style={[styles.reviewLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.reviewValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

function CostRow({ label, value }: { label: string; value: number }) {
  const theme = useTheme();
  return (
    <View style={styles.costRow}>
      <Text style={[styles.costLabel, { color: theme.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.costValue, { color: theme.text }]}>{formatNaira(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    alignItems: 'center',
  },
  /**
   * The title, the delivery type and the rate, as the first block of the page.
   *
   * No `zIndex`, no opaque fill, no horizontal padding: it is inside the
   * scroller now, so nothing passes under it and the content container already
   * supplies the gutters. The hairline stays — it separated the block from the
   * form when the block was pinned, and it still marks where the chrome ends
   * and the questions begin.
   */
  intro: {
    gap: Spacing.three,
    paddingBottom: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  /** 17px semi-bold, against `screenTitle`'s 28px extra-bold. */
  introTitle: {
    ...Typography.sectionTitle,
    marginBottom: Spacing.two,
  },
  scrollContent: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.six,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    gap: Spacing.three,
  },
  hint: {
    ...Typography.meta,
    marginTop: Spacing.two,
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
  row: {
    flexDirection: 'row',
    gap: Spacing.three - 4,
  },
  rowItem: {
    flex: 1,
  },
  noHubs: {
    flexDirection: 'row',
    gap: Spacing.three - 4,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderLeftWidth: 3,
    borderLeftColor: '#B45309',
  },
  noHubsText: {
    flex: 1,
    gap: Spacing.one,
  },
  noHubsTitle: {
    ...Typography.body,
    ...font(700),
  },
  noHubsBody: {
    ...Typography.caption,
    lineHeight: 19,
  },
  noHubsCta: {
    alignSelf: 'flex-start',
    marginTop: Spacing.two,
  },
  lockedCity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.three - 2,
    paddingVertical: Spacing.two + 2,
  },
  /** States the no-cost default that the doorstep toggle opts out of. */
  defaultNote: {
    flexDirection: 'row',
    // Top-aligned: this wraps to two or three lines, unlike lockedCity.
    alignItems: 'flex-start',
    gap: Spacing.two,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.three - 2,
    paddingVertical: Spacing.two + 2,
  },
  defaultNoteText: {
    flex: 1,
    ...Typography.meta,
    lineHeight: 18,
  },
  defaultNoteValue: {
    ...font(700),
  },
  lockedCityText: {
    ...Typography.meta,
  },
  lockedCityValue: {
    ...font(700),
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
  errorText: {
    ...Typography.meta,
  },
  summaryCard: {
    borderWidth: 1,
    gap: Spacing.two,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  reviewRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  reviewIcon: {
    width: 16,
    alignItems: 'center',
    paddingTop: 2,
  },
  reviewLabel: {
    ...Typography.caption,
    width: 76,
  },
  reviewValue: {
    flex: 1,
    ...Typography.caption,
    ...font(600),
  },
  summaryRouteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  summaryRoute: {
    ...Typography.body,
    ...font(600),
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Spacing.one,
  },
  costRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  costLabel: {
    ...Typography.meta,
    flexShrink: 1,
  },
  costValue: {
    ...Typography.meta,
    ...font(600),
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  totalLabel: {
    ...Typography.sectionTitle,
  },
  totalValue: {
    fontSize: FontSize.heading,
    ...font(700),
  },
  disclaimer: {
    ...Typography.meta,
  },
});
