import { supabase } from '@/lib/supabase';

/**
 * The parcel fare, from the app's side of the gateway.
 *
 * ⚠ There is no Paystack key in this file, and there must never be one.
 *
 *   Not even the public key. The whole flow is initialized server-side —
 *   `payments-initialize` holds the secret, decides the amount from the
 *   parcel's own immutable `estimated_fee`, and hands back a one-time
 *   `authorization_url`. What this module does is open that URL and, when the
 *   sender comes back, ask the server what happened. It is never told an
 *   amount it could disagree with, and it is never in a position to claim a
 *   parcel was paid for.
 *
 * ⚠ And this module never decides anything either.
 *
 *   `verifyParcelPayment` reports what the server said. A returning browser,
 *   a closed modal and a dropped connection all look the same from here, which
 *   is why 'unknown' is a first-class outcome rather than an error: the
 *   webhook may well have settled the charge a second after the sender gave
 *   up, and telling them it failed would be a lie the database contradicts.
 */

/** Where Paystack sends a web sender back to. Also the route that verifies. */
export const PAYMENT_RETURN_PATH = '/payment-return';

export type CheckoutSession = {
  reference: string;
  authorizationUrl: string;
  amountKobo: number;
  trackingId: string;
};

export type InitializeOutcome =
  | { ok: true; session: CheckoutSession }
  /** The parcel is already settled — treat it as success, not as an error. */
  | { ok: false; alreadyPaid: true; error: string }
  | { ok: false; alreadyPaid?: false; error: string };

/**
 * What the server made of a reference.
 *
 *   success   the charge is verified and the parcel is on the board
 *   failed    the gateway said no, and the sender may try again
 *   unknown   nobody can say yet. Not a failure — see above.
 */
export type VerifyStatus = 'success' | 'failed' | 'unknown';

export type VerifyOutcome = {
  status: VerifyStatus;
  bookingId: string | null;
  error: string | null;
  /** Settled against a parcel that was cancelled meanwhile. Support's problem. */
  refundOwed: boolean;
};

const UNREACHABLE = 'Could not reach the payment service. Check your connection and try again.';

/** Naira, from the kobo the server quoted. For display only. */
export function koboToNaira(kobo: number): number {
  return kobo / 100;
}

export async function initializeParcelPayment(bookingId: string): Promise<InitializeOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke('payments-initialize', {
      body: { booking_id: bookingId },
    });

    if (error) {
      /*
       * ⚠ `FunctionsHttpError` keeps the body on `error.context`, and the body
       *   is where the useful sentence is.
       *
       *   `error.message` on a non-2xx is the generic "Edge Function returned a
       *   non-2xx status code" for every failure this function has — already
       *   paid, cancelled, no email, provider unreachable. Reading the response
       *   is the difference between telling the sender what happened and
       *   telling them nothing four times over.
       */
      const body = await readErrorBody(error);

      if (body?.already_paid) {
        return { ok: false, alreadyPaid: true, error: body.error ?? 'Already paid.' };
      }

      return { ok: false, error: body?.error ?? UNREACHABLE };
    }

    const payload = data as {
      reference?: string;
      authorization_url?: string;
      amount_kobo?: number;
      tracking_id?: string;
    } | null;

    if (!payload?.reference || !payload.authorization_url) {
      return { ok: false, error: 'The payment service sent back an unusable checkout.' };
    }

    return {
      ok: true,
      session: {
        reference: payload.reference,
        authorizationUrl: payload.authorization_url,
        amountKobo: Number(payload.amount_kobo ?? 0),
        trackingId: payload.tracking_id ?? '',
      },
    };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

export async function verifyParcelPayment(reference: string): Promise<VerifyOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke('payments-verify', {
      body: { reference },
    });

    if (error) {
      const body = await readErrorBody(error);
      /*
       * A 502 from that function means "we could not ask Paystack", which is
       * 'unknown' rather than 'failed' — the charge may be fine and the webhook
       * may already have settled it.
       */
      return {
        status: 'unknown',
        bookingId: null,
        error: body?.error ?? UNREACHABLE,
        refundOwed: false,
      };
    }

    const payload = data as {
      status?: string;
      booking_id?: string;
      error?: string;
      refund_owed?: boolean;
    } | null;

    const status = payload?.status ?? 'unknown';

    return {
      /* Paystack's vocabulary is wider than ours: 'abandoned', 'reversed' and
         the rest all mean "this parcel is not paid for" to this app. */
      status: status === 'success' ? 'success' : status === 'unknown' ? 'unknown' : 'failed',
      bookingId: payload?.booking_id ?? null,
      error: payload?.error ?? null,
      refundOwed: Boolean(payload?.refund_owed),
    };
  } catch {
    return { status: 'unknown', bookingId: null, error: UNREACHABLE, refundOwed: false };
  }
}

/** The JSON body behind a FunctionsHttpError, when there is one. */
async function readErrorBody(
  error: unknown,
): Promise<{ error?: string; already_paid?: boolean } | null> {
  const context = (error as { context?: unknown }).context;

  if (context instanceof Response) {
    try {
      return (await context.clone().json()) as { error?: string; already_paid?: boolean };
    } catch {
      return null;
    }
  }

  return null;
}
