import { Camera, Check, RefreshCw, ShieldCheck } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import {
  resolveSenderPhoto,
  SenderPhotoSheet,
  type PhotoPurpose,
} from '@/components/ui/sender-photo-sheet';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * The live photo, taken on the last page of a form rather than after it.
 *
 * ⚠ This used to run *after* the submit button.
 *
 *   Both long forms ended the same way: press Post parcel / Submit application,
 *   and a sheet none of the copy had mentioned asked for a photograph of your
 *   face. Three things were wrong with that. It is a surprise at the one moment
 *   somebody believes they have finished; a face is sensitive data under the
 *   NDPA and asking for it inside a submit handler gives no chance to stop and
 *   read why; and a failure there — a refused camera, a liveness check that
 *   cannot reach its provider — arrived as an error on an action the person
 *   thought had already succeeded.
 *
 *   Here it is an item on the page with the other required items, above the
 *   confirmation checkbox, and the form knows whether it has been done before
 *   the button is ever pressed.
 *
 * ⚠ Camera only, never the gallery.
 *
 *   The whole value of the photo is that it was taken now, by the person
 *   holding the device. `SenderPhotoSheet` reaches the camera through
 *   `launchCameraAsync` on native and `getUserMedia` on web — neither can
 *   return a file already on the device, and `launchImageLibraryAsync` must not
 *   appear anywhere on this path. `verify-liveness-integration` asserts it.
 *
 * The upload and the liveness check both happen here, on capture, so a photo
 * that will be rejected is rejected while the form is still on screen and
 * editable. What the caller gets back is a capture session id, ready to be
 * spent on the parcel or the application.
 */
const COPY: Record<PhotoPurpose, { title: string; body: string; done: string }> = {
  sender: {
    title: 'Live photo of you',
    body: 'Taken now, with your camera — a saved picture cannot be used. It is matched against your NIN record and stored privately; the driver never sees it.',
    done: 'Live photo captured and checked.',
  },
  driver: {
    title: 'Live photo of you',
    body: 'Taken now, with your camera — a saved picture cannot be used. LOCI compares it with the photo on your NIN record.',
    done: 'Live photo captured and checked.',
  },
};

export function LiveSelfieCard({
  purpose,
  captured,
  note,
  onCaptured,
  onCleared,
  onError,
  gate,
  disabled,
}: {
  purpose: PhotoPurpose;
  /** The session id already banked, or null if the photo has not been taken. */
  captured: string | null;
  /**
   * What the check made of it, in the caller's words — shown under the tick.
   *
   * A verdict, not an error: a mismatch never stops the form, and the phrasing
   * is the caller's because only it knows whether a parcel or an application is
   * going ahead regardless.
   */
  note?: string;
  /**
   * Handed the session id once the photo is uploaded and has passed liveness.
   * Awaited, so a caller doing further work — the driver form runs the NIN
   * match here — keeps the card in its busy state until that finishes.
   */
  onCaptured: (sessionId: string) => void | Promise<void>;
  onCleared: () => void;
  /** Shown a failure the caller may also want to raise in a dialog. */
  onError?: (message: string) => void;
  /**
   * Runs before the sheet opens. Both forms need an account before a capture
   * session can exist, and each words that request differently.
   */
  gate?: (proceed: () => void) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const copy = COPY[purpose];

  const handleDone = async (result: { uri: string } | { sessionId: string }) => {
    setBusy(true);
    setError('');
    try {
      const resolved = await resolveSenderPhoto(result);

      if (!resolved.ok) {
        /*
         * Kept on the card rather than only in a dialog. A dialog is dismissed
         * and gone; this stays next to the button that has to be pressed again.
         */
        setError(resolved.error);
        onError?.(resolved.error);
        return;
      }

      await onCaptured(resolved.sessionId);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const openSheet = () => {
    setError('');
    if (gate) gate(() => setOpen(true));
    else setOpen(true);
  };

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: captured ? theme.successSoft : theme.surface,
          borderColor: captured ? theme.success : theme.borderStrong,
        },
      ]}>
      <View style={styles.head}>
        {captured ? (
          <Check color={theme.successOnSoft} size={18} />
        ) : (
          <ShieldCheck color={theme.primary} size={18} />
        )}
        <Text
          style={[styles.title, { color: captured ? theme.successOnSoft : theme.text }]}
          // The label carries the state, so it is never colour alone.
        >
          {captured ? copy.done : copy.title}
        </Text>
        {!captured && (
          <View style={[styles.required, { backgroundColor: theme.primarySoft }]}>
            <Text style={[styles.requiredText, { color: theme.primaryOnSoft }]}>Required</Text>
          </View>
        )}
      </View>

      {!captured && <Text style={[styles.body, { color: theme.textSecondary }]}>{copy.body}</Text>}

      {/*
        ⚠ `&&` on a string yields the string, not `false`.
        
          This read `{captured && note && note.length > 0 && (…)}`. When `note`
          is `''` — which it is for the moment between the photo being banked
          and the check answering — the chain short-circuits *on the empty
          string* and returns it. React renders that as a text node, and
          react-native-web refuses a text node inside a `<View>`:
          "Unexpected text node: . A text node cannot be a child of a <View>".
        
          The reported node is empty, which is what made it hard to place: the
          error names the offending text and the offending text is nothing.
        
          Every guard here is now a boolean.
      */}
      {captured !== null && (note ?? '').length > 0 && (
        <Text style={[styles.body, { color: theme.successOnSoft }]}>{note}</Text>
      )}

      {error.length > 0 && <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>}

      {busy ? (
        <View style={styles.busy}>
          <ActivityIndicator color={theme.primary} />
          <Text style={[styles.busyText, { color: theme.textSecondary }]}>Checking the photo…</Text>
        </View>
      ) : captured ? (
        <Button
          label="Retake photo"
          variant="secondary"
          icon={(color, size) => <RefreshCw color={color} size={size} />}
          onPress={() => {
            /*
             * Cleared before the sheet reopens, not after it returns.
             *
             * Otherwise backing out of the retake would leave the old session
             * banked while the card said nothing had changed — and the form
             * would submit a photo the person believed they had replaced.
             */
            onCleared();
            openSheet();
          }}
          disabled={disabled}
        />
      ) : (
        <Button
          label="Take live photo"
          icon={(color, size) => <Camera color={color} size={size} />}
          onPress={openSheet}
          disabled={disabled}
        />
      )}

      <SenderPhotoSheet
        visible={open}
        busy={busy}
        purpose={purpose}
        confirmLabel="Use this photo"
        onCancel={() => setOpen(false)}
        onDone={handleDone}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: 1,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  title: {
    ...Typography.meta,
    ...font(700),
    flex: 1,
  },
  required: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  requiredText: {
    ...Typography.caption,
    ...font(700),
    fontSize: 11,
    letterSpacing: 0.3,
  },
  body: {
    ...Typography.caption,
    lineHeight: 18,
  },
  error: {
    ...Typography.caption,
    lineHeight: 18,
  },
  busy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    // Matches the height of the button it stands in for, so the card does not
    // jump as the check runs.
    paddingVertical: Spacing.three - 2,
  },
  busyText: {
    ...Typography.caption,
  },
});
