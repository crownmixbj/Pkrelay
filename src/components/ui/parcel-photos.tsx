import { Image } from 'expo-image';
import { Eye, EyeOff, ImageOff } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { SectionLabel } from '@/components/ui/screen';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  revealSenderIdentity,
  signedParcelPhotoUrl,
  type SenderIdentity,
} from '@/store/parcel-photos';

/**
 * The three things a sender uploads, for the admin drawer.
 *
 * ⚠ Three uploads, two rules, and the split is the point.
 *
 *   The parcel is shown outright. It is a box on a table: it answers "what
 *   condition was this in when it was handed over", which is the same kind of
 *   question as its weight, and staff should not have to justify looking at it.
 *
 *   The selfie and the NIN slip are hidden until somebody asks and says why.
 *   One is a face and the other a government identity document — both sensitive
 *   personal data under the NDPA, and the sender was told the photo is "stored
 *   privately, visible only to you and to Package Relay staff". The reveal writes a line
 *   naming who looked before it hands anything back, the same door
 *   `admin_reveal_parcel_contacts` puts in front of a phone number.
 *
 *   ⚠ Both come through *one* reveal, not one each.
 *
 *     The question they answer — is the person in this photo the person on this
 *     document — is a single act of looking. Two reveals would mean two reason
 *     boxes and two log lines for it, and a reason box filled in twice to answer
 *     one question is a reason box people stop reading.
 *
 *   Making all three free would be careless. Making all three cost a reason
 *   would be worse than either: an operator typing "checking" six times a day to
 *   see a cardboard box produces an audit trail that proves nothing.
 */
export function ParcelPhotos({
  bookingId,
  itemPhotoPath,
  hasSenderPhoto,
}: {
  bookingId: string;
  itemPhotoPath: string | null;
  hasSenderPhoto: boolean;
}) {
  const theme = useTheme();

  const [parcelUrl, setParcelUrl] = useState<string | null>(null);
  const [parcelLoading, setParcelLoading] = useState(Boolean(itemPhotoPath));

  const [identity, setIdentity] = useState<SenderIdentity | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!itemPhotoPath) {
      setParcelLoading(false);
      return;
    }

    let cancelled = false;
    setParcelLoading(true);

    void signedParcelPhotoUrl(itemPhotoPath).then((url) => {
      if (cancelled) return;
      setParcelUrl(url);
      setParcelLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [itemPhotoPath]);

  const reveal = async () => {
    setBusy(true);
    setError('');

    const result = await revealSenderIdentity(bookingId, reason);

    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    /*
     * Revealed even when nothing comes back.
     *
     * A parcel can have `has_sender_photo` true and still fail to sign — an
     * object cleaned up, a bucket misconfigured — and a sender who never
     * onboarded has no slip at all. The request was made and logged either way,
     * and showing the asking form again would invite somebody to ask twice for
     * something that is not there.
     */
    setRevealed(true);
    setIdentity(result.identity);
    setAsking(false);
  };

  return (
    <>
      <SectionLabel>Photos</SectionLabel>

      {/* ---------- the parcel ---------- */}
      {parcelLoading ? (
        <ActivityIndicator color={theme.primary} style={styles.loading} />
      ) : parcelUrl ? (
        <Image
          source={{ uri: parcelUrl }}
          style={[styles.photo, { backgroundColor: theme.surfaceMuted }]}
          contentFit="cover"
          accessibilityIgnoresInvertColors
          accessibilityLabel="Photo of the parcel, taken by the sender"
        />
      ) : (
        <View style={[styles.empty, { backgroundColor: theme.surfaceMuted }]}>
          <ImageOff color={theme.textMuted} size={16} />
          <Text style={[styles.note, { color: theme.textMuted }]}>
            {itemPhotoPath
              ? 'The photo is on file but could not be opened.'
              : /*
                  Named precisely, because "no photo" reads as the sender having
                  skipped something they were in fact required to do. Every
                  parcel posted before this shipped has none: the form asked for
                  one and nothing stored it.
                */
                'No parcel photo. Parcels posted before photos were stored have none.'}
          </Text>
        </View>
      )}

      {/* ---------- the sender ---------- */}
      <View style={[styles.senderBox, { borderColor: theme.border }]}>
        {revealed ? (
          <>
            <View style={styles.row}>
              <Eye color={theme.warningOnSoft} size={14} />
              <Text style={[styles.head, { color: theme.warningOnSoft }]}>
                Sender identity — this view has been logged
              </Text>
            </View>

            {/*
              The selfie and the slip together, because the question they answer
              is a comparison. Shown side by side on anything wide enough for
              two, stacked on a phone.
            */}
            <View style={styles.pair}>
              <Captioned caption="Selfie, when posted">
                {identity?.selfieUrl ? (
                  <Image
                    source={{ uri: identity.selfieUrl }}
                    style={[styles.paired, { backgroundColor: theme.surfaceMuted }]}
                    contentFit="cover"
                    accessibilityIgnoresInvertColors
                    accessibilityLabel="Photo of the sender, taken when the parcel was posted"
                  />
                ) : (
                  <Missing text="No selfie on this parcel." />
                )}
              </Captioned>

              <Captioned caption="NIN slip">
                {identity?.slipUrl && !identity.slipIsPdf ? (
                  <Image
                    source={{ uri: identity.slipUrl }}
                    style={[styles.paired, { backgroundColor: theme.surfaceMuted }]}
                    contentFit="contain"
                    accessibilityIgnoresInvertColors
                    accessibilityLabel="The NIN slip this sender uploaded"
                  />
                ) : identity?.slipUrl ? (
                  /*
                    A slip is as often a PDF as a photograph — the bucket allows
                    both — and a PDF in an <Image> renders as nothing at all
                    rather than as an error. Opened instead.
                  */
                  <Button
                    label="Open slip (PDF)"
                    variant="secondary"
                    size="md"
                    onPress={() => void Linking.openURL(identity.slipUrl as string)}
                  />
                ) : (
                  <Missing text="This sender has not uploaded a NIN slip." />
                )}
              </Captioned>
            </View>

            <Text style={[styles.note, { color: theme.textSecondary }]}>
              NIN {identity?.ninMasked ?? 'not on file'} · check {identity?.status ?? 'not run'}
            </Text>
          </>
        ) : asking ? (
          <>
            <Text style={[styles.head, { color: theme.text }]}>
              Why do you need to identify the sender?
            </Text>
            <Field
              label="Reason (optional)"
              placeholder="Driver reported the wrong person at pickup"
              value={reason}
              onChangeText={setReason}
            />
            <Button
              label={busy ? 'Opening…' : 'Show and log it'}
              size="md"
              onPress={reveal}
              disabled={busy}
            />
            <Button
              label="Cancel"
              variant="secondary"
              size="md"
              onPress={() => setAsking(false)}
              disabled={busy}
            />
          </>
        ) : (
          <>
            <View style={styles.row}>
              <EyeOff color={theme.textMuted} size={14} />
              <Text style={[styles.head, { color: theme.textMuted }]}>
                The sender’s selfie and NIN slip are hidden
              </Text>
            </View>
            <Text style={[styles.note, { color: theme.textMuted }]}>
              A person’s face and a government identity document. Opening them is recorded against
              your account.
              {hasSenderPhoto ? '' : ' This parcel has no selfie on file.'}
            </Text>
            {/*
              Offered even when the parcel has no selfie: the sender may still
              have a slip, and "no photo on this parcel" is not an answer to
              "who is this person".
            */}
            <Button
              label="Show sender identity"
              variant="secondary"
              size="md"
              onPress={() => setAsking(true)}
            />
          </>
        )}

        {error.length > 0 && <Text style={[styles.note, { color: theme.danger }]}>{error}</Text>}
      </View>
    </>
  );
}

/** A labelled slot in the comparison pair. */
function Captioned({ caption, children }: { caption: string; children: React.ReactNode }) {
  const theme = useTheme();

  return (
    <View style={styles.captioned}>
      <Text style={[styles.caption, { color: theme.textMuted }]}>{caption}</Text>
      {children}
    </View>
  );
}

/**
 * What is not there, said plainly.
 *
 * Distinct from a failure: a sender who never onboarded has no slip, and that
 * is an answer to the operator's question rather than something going wrong.
 */
function Missing({ text }: { text: string }) {
  const theme = useTheme();

  return (
    <View style={[styles.empty, { backgroundColor: theme.surfaceMuted }]}>
      <ImageOff color={theme.textMuted} size={14} />
      <Text style={[styles.note, { color: theme.textMuted }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    paddingVertical: Spacing.four,
  },
  photo: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: Radius.md,
  },
  empty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.md,
  },
  /*
    Two across when there is room, wrapping to one on a phone. `flexWrap` with a
    `minWidth` rather than a media query: the drawer is not the window, so its
    width is not something a breakpoint knows.
  */
  pair: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  captioned: {
    flexGrow: 1,
    flexBasis: 200,
    gap: Spacing.one,
  },
  caption: {
    ...Typography.caption,
    ...font(600),
  },
  paired: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: Radius.md,
  },
  senderBox: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  head: {
    ...Typography.caption,
    ...font(700),
    flex: 1,
  },
  note: {
    ...Typography.caption,
    lineHeight: 18,
    flex: 1,
  },
});
