import { IdCard, Image as ImageIcon, ShieldCheck } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Linking, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChipGroup } from '@/components/ui/chip';
import { showDialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { ConfirmCheckbox } from '@/components/ui/form-wizard';
import { EmptyState, SectionLabel } from '@/components/ui/screen';
import { showToast } from '@/components/ui/toast';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { errorMessage } from '@/lib/errors';
import { useTheme } from '@/hooks/use-theme';
import { maskNin } from '@/store/identity';
import {
  confidenceLabel,
  fetchIdentityQueue,
  IDENTITY_STATUS_LABELS,
  isAwaitingIdentityReview,
  reviewIdentity,
  type IdentityReview,
} from '@/store/identity-review';
import { revealIdentityForUser } from '@/store/parcel-photos';

/**
 * Sender identity review: the queue, the documents, and the verdict.
 *
 * ⚠ Until this existed, nothing but Dojah could move a sender's status.
 *
 *   `admin_flagged_identities` returned a list an admin could read and nothing
 *   they could act on. A flagged sender stayed flagged forever and a sender
 *   whose check never ran stayed `pending` forever — which, until
 *   `verify-identity` is deployed, is every sender there is.
 *
 * ⚠ Looking is separate from listing, and only looking is audited.
 *
 *   The queue carries the last four digits and two booleans saying whether the
 *   documents exist. The slip and the face come from a second call that writes
 *   a privacy line naming the operator and their reason. Working a list all
 *   afternoon should not produce an afternoon of audit noise; opening one
 *   person's face should produce exactly one line.
 */

const FILTERS = ['awaiting', 'verified', 'rejected', 'all'] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABELS: Record<Filter, string> = {
  awaiting: 'Waiting on you',
  verified: 'Verified',
  rejected: 'Not accepted',
  all: 'All',
};

/*
 * ⚠ Long enough that "no" cannot be the whole message.
 *
 *   The sender reads this word for word, in the app and in an email, and it is
 *   the only thing telling them what to fix. Same floor as the driver rejection
 *   reason, for the same reason — and no validation can stop somebody
 *   determined to type twelve useless characters.
 */
const MIN_REASON = 12;

function matches(review: IdentityReview, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'awaiting') return isAwaitingIdentityReview(review.status);
  return review.status === filter;
}

export function IdentityReviewPanel() {
  const theme = useTheme();

  const [rows, setRows] = useState<IdentityReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('awaiting');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await fetchIdentityQueue());
    } catch (thrown) {
      setError(errorMessage(thrown, 'Could not load the identity queue.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const waiting = useMemo(
    () => rows.filter((row) => isAwaitingIdentityReview(row.status)).length,
    [rows],
  );

  const visible = useMemo(() => rows.filter((row) => matches(row, filter)), [rows, filter]);

  const decide = async (
    review: IdentityReview,
    decision: { verdict: 'verified' } | { verdict: 'rejected'; note: string },
  ) => {
    setBusyId(review.userId);
    try {
      await reviewIdentity(review.userId, decision);
      /*
       * Reloaded rather than patched in place. Approving promotes the selfie to
       * a reference photo server-side, so the row that comes back is not one
       * this screen could have constructed.
       */
      await load();
      showToast(decision.verdict === 'verified' ? 'Identity verified' : 'Identity not accepted', {
        message: review.fullName ?? review.email ?? '',
      });
    } catch (thrown) {
      showDialog('Could not save the decision', errorMessage(thrown, 'Try again.'));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  return (
    <>
      <SectionLabel>
        {waiting > 0 ? `Sender identity · ${waiting} waiting on you` : 'Sender identity'}
      </SectionLabel>

      {error !== null && (
        <Card style={styles.card}>
          <Text style={[styles.body, { color: theme.dangerOnSoft }]}>{error}</Text>
          <Button label="Try again" variant="secondary" size="md" onPress={() => void load()} />
        </Card>
      )}

      <ChipGroup
        options={FILTERS}
        selected={filter}
        onSelect={setFilter}
        renderLabel={(value) => FILTER_LABELS[value]}
      />

      {visible.length === 0 ? (
        <Card style={styles.card}>
          <EmptyState
            icon={(color, size) => <ShieldCheck color={color} size={size} />}
            title={filter === 'awaiting' ? 'Nothing waiting' : 'Nobody here'}
            message={
              filter === 'awaiting'
                ? 'Every submitted ID has been decided. New ones appear here as senders verify.'
                : 'Try another filter.'
            }
          />
        </Card>
      ) : (
        visible.map((review) => (
          <IdentityCard
            key={review.userId}
            review={review}
            busy={busyId === review.userId}
            onDecide={(decision) => void decide(review, decision)}
          />
        ))
      )}
    </>
  );
}

type Revealed = {
  selfieUrl: string | null;
  slipUrl: string | null;
  slipIsPdf: boolean;
};

function IdentityCard({
  review,
  busy,
  onDecide,
}: {
  review: IdentityReview;
  busy: boolean;
  onDecide: (decision: { verdict: 'verified' } | { verdict: 'rejected'; note: string }) => void;
}) {
  const theme = useTheme();

  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  /**
   * ⚠ Reset on the account, so a tick cannot outlive the card it was made on.
   *
   *   The list is re-fetched after every decision and the default chip hides
   *   what was just decided, so the card in a given position becomes a
   *   *different person* a moment later. A tick that survived that would
   *   approve the next account on an attestation somebody made about somebody
   *   else — which is worse than no checkbox, because it manufactures a record
   *   of a comparison that never happened.
   *
   *   Keyed on `userId` rather than done on save, because React may reuse this
   *   component instance for a different row without unmounting it. The reveal
   *   is cleared for the same reason: a signed URL to one person's face must
   *   not still be on screen under another person's name.
   */
  const [attested, setAttested] = useState(false);
  useEffect(() => {
    setAttested(false);
    setRevealed(null);
    setRejecting(false);
    setReason('');
  }, [review.userId]);

  const decidable = isAwaitingIdentityReview(review.status);
  const who = review.fullName ?? review.email ?? 'Unnamed account';
  const firstName = (review.fullName ?? '').trim().split(/\s+/)[0] || 'They';

  const reveal = async () => {
    setRevealing(true);
    try {
      const outcome = await revealIdentityForUser(
        review.userId,
        'Sender identity review queue — deciding whether to verify this account',
      );
      if (!outcome.ok) {
        showDialog('Could not open the documents', outcome.error);
        return;
      }
      setRevealed({
        selfieUrl: outcome.identity.selfieUrl,
        slipUrl: outcome.identity.slipUrl,
        slipIsPdf: outcome.identity.slipIsPdf,
      });
    } finally {
      setRevealing(false);
    }
  };

  return (
    <Card style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.heading}>
          <Text style={[styles.name, { color: theme.text }]}>{who}</Text>
          <Text style={[styles.meta, { color: theme.textMuted }]}>
            {review.email ?? '—'} · NIN {maskNin(review.ninLast4)}
          </Text>
        </View>

        <Badge
          label={IDENTITY_STATUS_LABELS[review.status]}
          tone={
            review.status === 'verified'
              ? 'success'
              : review.status === 'rejected'
                ? 'danger'
                : review.status === 'flagged'
                  ? 'danger'
                  : 'warning'
          }
        />
      </View>

      <Text style={[styles.body, { color: theme.textSecondary }]}>
        {confidenceLabel(review.confidence)}
      </Text>

      {/*
        ⚠ Said out loud when a document is missing.

          A reviewer who taps through to a blank square has to guess whether the
          sender never uploaded it or the reveal is broken — and one of those
          guesses ends in an account being refused for a system fault.
      */}
      {!(review.hasSlip && review.hasSelfie) && (
        <Text style={[styles.body, { color: theme.dangerOnSoft }]}>
          {review.hasSlip ? 'No selfie on file.' : 'No NIN slip on file.'} There may be nothing to
          compare.
        </Text>
      )}

      {revealed === null ? (
        <Button
          label={revealing ? 'Opening…' : 'View slip & selfie'}
          variant="secondary"
          size="md"
          disabled={revealing || !(review.hasSlip || review.hasSelfie)}
          icon={(color, size) => <ImageIcon color={color} size={size} />}
          onPress={() => void reveal()}
        />
      ) : (
        <View style={styles.evidence}>
          {revealed.selfieUrl !== null && (
            <View style={styles.shot}>
              <Text style={[styles.shotLabel, { color: theme.textMuted }]}>Selfie</Text>
              <Image
                source={{ uri: revealed.selfieUrl }}
                style={[styles.photo, { borderColor: theme.border }]}
                resizeMode="cover"
                accessibilityLabel={`Selfie submitted by ${who}`}
              />
            </View>
          )}

          {revealed.slipUrl !== null && (
            <View style={styles.shot}>
              <Text style={[styles.shotLabel, { color: theme.textMuted }]}>NIN slip</Text>
              {revealed.slipIsPdf ? (
                <Button
                  label="Open slip (PDF)"
                  variant="secondary"
                  size="md"
                  icon={(color, size) => <IdCard color={color} size={size} />}
                  onPress={() => void Linking.openURL(revealed.slipUrl as string)}
                />
              ) : (
                <Image
                  source={{ uri: revealed.slipUrl }}
                  style={[styles.photo, { borderColor: theme.border }]}
                  resizeMode="contain"
                  accessibilityLabel={`NIN slip submitted by ${who}`}
                />
              )}
            </View>
          )}
        </View>
      )}

      {decidable ? (
        rejecting ? (
          <View style={styles.rejectBox}>
            <Field
              label="Why is this not accepted?"
              hint={`${firstName} is sent this word for word, in the app and by email. Say what was wrong with it.`}
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={3}
              editable={!busy}
              placeholder="e.g. The slip photo is too blurry to read the number."
            />
            <View style={styles.actions}>
              <Button
                label={busy ? 'Saving…' : 'Confirm'}
                size="md"
                style={styles.action}
                disabled={busy || reason.trim().length < MIN_REASON}
                onPress={() => onDecide({ verdict: 'rejected', note: reason.trim() })}
              />
              <Button
                label="Cancel"
                variant="secondary"
                size="md"
                style={styles.action}
                disabled={busy}
                onPress={() => {
                  setRejecting(false);
                  setReason('');
                }}
              />
            </View>
          </View>
        ) : (
          <View style={styles.decide}>
            {/*
              ⚠ The consequence, stated where the decision is made.

                Approving does not only unblock them: it promotes this selfie to
                the master reference photo that every future shipment of theirs
                is compared against. An operator who does not know that is
                making a smaller decision than the one they are actually making.
            */}
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              Approving keeps this selfie as {firstName === 'They' ? 'their' : `${firstName}'s`}{' '}
              reference photo — every later parcel is matched against it.
            </Text>

            <ConfirmCheckbox
              checked={attested}
              onChange={setAttested}
              disabled={busy}
              /*
               * ⚠ Names the act, not an agreement.
               *
               *   "I confirm this is correct" is ticked without looking. "I
               *   have compared" is a claim about something the operator either
               *   did or did not do, and the button above it is the one that
               *   opens the documents.
               */
              label="I have compared the selfie against the NIN slip"
            />

            <View style={styles.actions}>
              <Button
                label={busy ? 'Saving…' : 'Approve'}
                size="md"
                style={styles.action}
                disabled={busy || !attested}
                icon={(color, size) => <ShieldCheck color={color} size={size} />}
                onPress={() => onDecide({ verdict: 'verified' })}
              />
              <Button
                label="Reject"
                variant="secondary"
                size="md"
                style={styles.action}
                /*
                 * ⚠ Not gated, deliberately — see the driver card for the
                 *   argument. Rejecting already costs a written reason, and a
                 *   tick performed on every card is a tick that has stopped
                 *   meaning anything on the one that matters.
                 */
                disabled={busy}
                onPress={() => setRejecting(true)}
              />
            </View>
          </View>
        )
      ) : (
        <View style={styles.decided}>
          <Text style={[styles.meta, { color: theme.textMuted }]}>
            {IDENTITY_STATUS_LABELS[review.status]}
            {review.reviewedAt
              ? ` on ${new Date(review.reviewedAt).toLocaleDateString()}`
              : ' by the automated check'}
          </Text>
          {(review.reviewNote ?? '').length > 0 && (
            <Text style={[styles.note, { color: theme.textSecondary }]}>“{review.reviewNote}”</Text>
          )}
          {/*
            ⚠ The way back in, stated rather than implied.

              A decided row has no buttons, and an operator asked to change one
              needs to know that the route is the sender resubmitting — not a
              second decision here, which would overwrite who made the first.
          */}
          {review.status === 'rejected' && (
            <Text style={[styles.meta, { color: theme.textMuted }]}>
              They can submit again from their profile, which reopens this for review.
            </Text>
          )}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: Spacing.six, alignItems: 'center' },
  card: { gap: Spacing.two },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two },
  heading: { flex: 1, gap: 2 },
  name: { ...Typography.body, ...font(700) },
  meta: { ...Typography.meta },
  body: { ...Typography.meta, lineHeight: 20 },
  evidence: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.three },
  shot: { gap: Spacing.one, minWidth: 160, flexGrow: 1, flexBasis: 160 },
  shotLabel: { ...Typography.meta, ...font(600) },
  photo: {
    width: '100%',
    height: 190,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rejectBox: { gap: Spacing.one, marginTop: Spacing.one },
  decide: { gap: Spacing.two, marginTop: Spacing.one },
  actions: { flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.one },
  action: { flexGrow: 1, flexBasis: 130 },
  decided: { gap: Spacing.half, marginTop: Spacing.one },
  note: { ...Typography.meta, fontStyle: 'italic' },
});
