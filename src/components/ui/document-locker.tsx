import { CircleAlert, FileCheck2, FileText, Lock, TriangleAlert } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ExpiryField } from '@/components/ui/expiry-field';
import { showToast } from '@/components/ui/toast';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { expiryMessage, isoToInput, parseExpiry } from '@/lib/expiry';
import {
  canEditExpiry,
  EXPIRY_LOCK_REASON,
  fetchMyDocuments,
  headlineTone,
  setDocumentExpiry,
  statusLabel,
  type DriverDocument,
} from '@/store/documents';

/**
 * Your documents — what Package Relay holds, where each one stands, and when it lapses.
 *
 * Everything a driver uploaded during their application was, until now, write-
 * only: it went into a private bucket and a reviewer looked at it. A driver
 * could not see what had been received, whether it had been accepted, or that
 * one of them was about to stop them working.
 *
 * ⚠ The list comes from `my_documents()`, which is a LEFT JOIN from the policy
 *   table — so a slot that was never filled arrives as a row saying "missing"
 *   rather than as an absence. That matters: a driver who never uploaded their
 *   guarantor's ID needs to see the gap, and computing it on the client would
 *   mean every screen deriving the same difference slightly differently.
 *
 * ⚠ Expiry outranks review status in the headline. A licence can be verified
 *   and expired at once — approved in March, lapsed in August — and leading
 *   with "Verified" on that row would reassure a driver about the exact
 *   document that has stopped their work.
 */
/**
 * ⚠ TWO components, not one, and the split is deliberate.
 *
 *   `DocumentAlerts` renders the urgent banners and lives on the Be a Driver /
 *   Updates page. `DocumentList` renders every document and lives inside the
 *   Edit your details sheet, where the rest of the submitted application is.
 *
 *   The obvious build is one component in both places. That would put "you are
 *   not being offered parcels" behind a button — a driver whose work has
 *   stopped would have to open an editing sheet to find out why — or duplicate
 *   the whole card on the page and in the sheet, which is the redundancy this
 *   project keeps having to undo.
 *
 *   Alerts are status: they belong where they are seen without asking. The list
 *   is submitted information: it belongs with the rest of the submitted
 *   information. Neither repeats the other.
 */
function useDocuments() {
  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setDocuments(await fetchMyDocuments());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { documents, loading, refresh };
}

/** The banners. Page-level, because a stopped driver must not have to hunt. */
export function DocumentAlerts() {
  const theme = useTheme();
  const { documents } = useDocuments();

  const blocking = documents.filter((doc) => doc.blocksDispatch && doc.state === 'expired');
  const expiring = documents.filter((doc) => doc.state === 'expiring');

  /*
   * Documents carried over from before expiry tracking existed.
   *
   * The migration deliberately backfills them without dates — none was ever
   * collected, and inventing one would be fabricating a compliance record. So
   * the app has to ask, and this is the prompt that asks.
   */
  const undated = documents.filter(
    (doc) => doc.path !== null && doc.expiryAllowed && doc.expiresAt === null,
  );

  if (blocking.length === 0 && expiring.length === 0 && undated.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {/*
        The blocking notice leads.

        A driver whose offers have stopped is looking for the reason, and it is
        the only thing on this screen that is costing them money right now.
      */}
      {blocking.length > 0 && (
        <View style={[styles.alert, { backgroundColor: theme.dangerSoft }]}>
          <CircleAlert color={theme.dangerOnSoft} size={18} />
          <View style={styles.alertText}>
            <Text style={[styles.alertTitle, { color: theme.dangerOnSoft }]}>
              You are not being offered parcels
            </Text>
            <Text style={[styles.alertBody, { color: theme.dangerOnSoft }]}>
              {blocking.map((doc) => doc.label).join(' and ')}{' '}
              {blocking.length === 1 ? 'has' : 'have'} expired. Upload a current one and you will
              start receiving trips again straight away — nothing else about your account has
              changed.
            </Text>
          </View>
        </View>
      )}

      {blocking.length === 0 && expiring.length > 0 && (
        <View style={[styles.alert, { backgroundColor: theme.warningSoft }]}>
          <TriangleAlert color={theme.warningOnSoft} size={18} />
          <View style={styles.alertText}>
            <Text style={[styles.alertTitle, { color: theme.warningOnSoft }]}>
              {expiring.length === 1 ? 'A document is' : 'Documents are'} due for renewal
            </Text>
            <Text style={[styles.alertBody, { color: theme.warningOnSoft }]}>
              Renew before the date and nothing changes. Let it lapse and Package Relay has to stop offering
              you parcels.
            </Text>
          </View>
        </View>
      )}

      {undated.length > 0 && (
        <View style={[styles.alert, { backgroundColor: theme.primarySoft }]}>
          <FileText color={theme.primaryOnSoft} size={18} />
          <View style={styles.alertText}>
            <Text style={[styles.alertTitle, { color: theme.primaryOnSoft }]}>
              Add the expiry dates
            </Text>
            <Text style={[styles.alertBody, { color: theme.primaryOnSoft }]}>
              Package Relay did not ask for these when you applied, so we cannot remind you before something
              lapses. Open Edit your details and type the date printed on each one — you do not need
              to upload anything again.
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

/** Every document, with its status and expiry. Shown inside the edit sheet. */
export function DocumentList() {
  const theme = useTheme();
  const { documents, loading, refresh } = useDocuments();

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const openEditor = (doc: DriverDocument) => {
    setEditing(doc.kind);
    setDraft(isoToInput(doc.expiresAt));
    setError('');
  };

  const save = async (doc: DriverDocument) => {
    const parsed = parseExpiry(draft);
    if (parsed.ok !== true) {
      setError(parsed.ok === false ? parsed.error : 'Enter the full date as DD/MM/YYYY.');
      return;
    }

    setBusy(true);
    const outcome = await setDocumentExpiry(doc.kind, parsed.iso);
    setBusy(false);

    if (!outcome.ok) {
      // The server's sentence. It refuses a past date with the document name
      // and the date in it, which is more useful than anything generic here.
      setError(outcome.error);
      return;
    }

    showToast('Expiry date saved', { message: `${doc.label}: ${parsed.pretty}.` });
    setEditing(null);
    void refresh();
  };

  return (
    <View style={styles.wrap}>
      <Card style={styles.card}>
        {/*
          Its own header rather than a group label above the card.

          Every other section in the edit sheet is a titled card with a caption;
          a bare label plus a card that also titles itself would say "documents"
          twice in two type styles.
        */}
        <View style={styles.head}>
          <View style={[styles.headIcon, { backgroundColor: theme.primarySoft }]}>
            <FileCheck2 color={theme.primaryOnSoft} size={17} />
          </View>
          <View style={styles.headText}>
            <Text style={[styles.title, { color: theme.text }]}>Documents submitted</Text>
            <Text style={[styles.caption, { color: theme.textMuted }]}>
              What Package Relay holds, where each one stands, and when it lapses.
            </Text>
          </View>
        </View>

        <View style={[styles.rule, { backgroundColor: theme.border }]} />

        {/*
          Three states, not two.

          This card rendered a header, a rule and a footnote with nothing
          between them whenever the list came back empty — which is what a
          driver saw before the migration had run, and it reads as a broken
          screen rather than as a missing backend. An empty list now says so.
        */}
        {loading && documents.length === 0 ? (
          <Text style={[styles.muted, { color: theme.textMuted }]}>Loading…</Text>
        ) : documents.length === 0 ? (
          <Text style={[styles.muted, { color: theme.textMuted }]}>
            Package Relay could not load your documents just now. They are safe — try again in a moment, and
            contact support if this keeps happening.
          </Text>
        ) : (
          documents.map((doc, index) => (
            <View key={doc.kind}>
              {index > 0 && <View style={[styles.rule, { backgroundColor: theme.border }]} />}

              <View style={styles.row}>
                <View style={styles.rowText}>
                  <View style={styles.rowHead}>
                    <Text style={[styles.rowLabel, { color: theme.text }]}>{doc.label}</Text>
                    {doc.blocksDispatch && (
                      <Text style={[styles.required, { color: theme.textMuted }]}>Required</Text>
                    )}
                  </View>

                  <Text style={[styles.rowMeta, { color: theme.textSecondary }]}>
                    {expiryMessage({
                      state: doc.state,
                      daysLeft: doc.daysLeft,
                      expiresAt: doc.expiresAt,
                      blocksDispatch: doc.blocksDispatch,
                      expiryAllowed: doc.expiryAllowed,
                    })}
                  </Text>

                  {!!doc.reviewNote && (
                    <Text style={[styles.note, { color: theme.dangerOnSoft }]}>
                      {doc.reviewNote}
                    </Text>
                  )}
                </View>

                <Badge label={statusLabel(doc.status)} tone={headlineTone(doc)} />
              </View>

              {/*
                Editing is inline and only where a date is meaningful.

                `expiryAllowed` is false for the vehicle photograph, so no field
                appears against it — an optional date on a photo of a bike is a
                date somebody invents, and the reminder ladder would then run on
                fiction.
              */}
              {/*
                Read-only while the document is in date.

                `canEditExpiry` holds the rule and explains the one place it is
                wider than "only once expired" — a driver who renews early must
                be able to say so before their old date stops them working.
              */}
              {doc.path !== null && doc.expiryAllowed && !canEditExpiry(doc) && (
                <View style={[styles.lockRow, { backgroundColor: theme.surfaceMuted }]}>
                  <Lock color={theme.textMuted} size={13} />
                  <Text style={[styles.lockText, { color: theme.textMuted }]}>
                    {EXPIRY_LOCK_REASON}
                  </Text>
                </View>
              )}

              {canEditExpiry(doc) &&
                (editing === doc.kind ? (
                  <View style={styles.editor}>
                    <ExpiryField
                      label={doc.label}
                      value={draft}
                      onChange={setDraft}
                      required={doc.expiryRequired}
                      error={error || undefined}
                    />
                    <View style={styles.editorActions}>
                      <Button
                        label={busy ? 'Saving…' : 'Save date'}
                        size="md"
                        onPress={() => void save(doc)}
                        disabled={busy}
                      />
                      <Button
                        label="Cancel"
                        size="md"
                        variant="secondary"
                        onPress={() => setEditing(null)}
                        disabled={busy}
                      />
                    </View>
                  </View>
                ) : (
                  <Button
                    label={doc.expiresAt ? 'Change expiry date' : 'Add expiry date'}
                    variant="secondary"
                    size="md"
                    onPress={() => openEditor(doc)}
                    style={styles.editCta}
                  />
                ))}
            </View>
          ))
        )}

        {/*
          Where to replace a file, said plainly.

          Re-uploading is a fresh application submission today, and pretending
          otherwise — a "Replace" button that does nothing useful — would be
          worse than pointing at the real route.
        */}
        <Text style={[styles.footnote, { color: theme.textMuted }]}>
          To replace a document itself, contact support with the new file. Adding or correcting a
          date here does not need a new upload.
        </Text>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.three },
  alert: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
  },
  alertText: { flex: 1, gap: Spacing.half },
  alertTitle: { ...Typography.meta, ...font(700) },
  alertBody: { ...Typography.caption, lineHeight: 18 },
  card: { gap: Spacing.three - 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two + 2 },
  headIcon: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1, gap: 1 },
  title: { ...Typography.meta, ...font(700) },
  caption: { ...Typography.caption, lineHeight: 17 },
  muted: { ...Typography.caption },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: Spacing.two },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  rowText: { flex: 1, gap: Spacing.half },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  rowLabel: { ...Typography.meta, ...font(700) },
  required: { ...Typography.caption },
  rowMeta: { ...Typography.caption, lineHeight: 17 },
  note: { ...Typography.caption, lineHeight: 17 },
  editCta: { marginTop: Spacing.two },
  lockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
    paddingVertical: Spacing.one + 2,
    paddingHorizontal: Spacing.two,
    borderRadius: Radius.sm,
    marginTop: Spacing.two,
  },
  lockText: { ...Typography.caption, flex: 1, lineHeight: 16 },
  editor: { gap: Spacing.two, marginTop: Spacing.two },
  editorActions: { gap: Spacing.two },
  footnote: { ...Typography.caption, lineHeight: 17, marginTop: Spacing.two },
});
