import { Check, CircleAlert, HelpCircle } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SectionLabel } from '@/components/ui/screen';
import { Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fetchDeployment, missingCount, type Deployment } from '@/store/deployment';

/**
 * Which build this is, and which migrations the database behind it has.
 *
 * ⚠ This panel exists because of a specific, repeated failure, and it is worth
 *   naming so nobody removes it as clutter.
 *
 *   Three separate fixes have been reported as not working when they were in
 *   fact working — the code was right, and either the bundle on the device or
 *   the schema in the database was older than the code. There are three clocks
 *   on this project: the native binary (no EAS Update, so every JS change needs
 *   a new build), the web deploy, and migrations run by hand. None of them was
 *   visible from inside the app, so the only way to tell them apart was another
 *   round trip and another day.
 *
 *   The panel answers both halves at a glance. That it renders at all proves
 *   the bundle is recent enough to contain it; the list proves what the
 *   database has. When something is missing it names the file to run, which is
 *   the same thing the hub notice below already does for `20250101000008_hubs.sql`.
 */
export function DeploymentPanel() {
  const theme = useTheme();

  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setDeployment(await fetchDeployment());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const missing = deployment ? missingCount(deployment.capabilities) : 0;

  return (
    <>
      <SectionLabel>Build and schema</SectionLabel>

      <Card style={styles.card}>
        {loading || !deployment ? (
          <ActivityIndicator color={theme.primary} />
        ) : (
          <>
            <View style={styles.headline}>
              {missing === 0 ? (
                <Check color={theme.success} size={16} />
              ) : (
                <CircleAlert color={theme.warningOnSoft} size={16} />
              )}
              <Text style={[styles.headlineText, { color: theme.text }]}>
                {missing === 0
                  ? 'The database has everything this build expects'
                  : `${missing} ${missing === 1 ? 'migration has' : 'migrations have'} not been run`}
              </Text>
            </View>

            <Text style={[styles.build, { color: theme.textMuted }]}>Build {deployment.build}</Text>

            {deployment.error && (
              <Text style={[styles.note, { color: theme.textMuted }]}>
                {deployment.error} The list below cannot be trusted until it can.
              </Text>
            )}

            <View style={styles.list}>
              {deployment.capabilities.map((capability) => (
                <View key={capability.migration} style={styles.row}>
                  {capability.present === true ? (
                    <Check color={theme.success} size={14} />
                  ) : capability.present === false ? (
                    <CircleAlert color={theme.warningOnSoft} size={14} />
                  ) : (
                    <HelpCircle color={theme.textMuted} size={14} />
                  )}

                  <View style={styles.labelBlock}>
                    <Text style={[styles.label, { color: theme.text }]}>{capability.label}</Text>
                    {/*
                      "Missing" is not always the useful half. An edge function
                      that is deployed but has no API key needs a different
                      action from one that was never deployed, and the panel is
                      the only place that difference is visible.
                    */}
                    {!!capability.note && (
                      <Text style={[styles.note, { color: theme.warningOnSoft }]}>
                        {capability.note}
                      </Text>
                    )}
                  </View>

                  {/*
                    The file name, not a status word.

                    "Missing" tells somebody there is a problem; the file name
                    tells them what to do about it, and is the only part of this
                    row they will need once they are in the SQL editor.
                  */}
                  <Text
                    style={[
                      styles.file,
                      {
                        color: capability.present === true ? theme.textMuted : theme.warningOnSoft,
                      },
                    ]}
                    numberOfLines={1}>
                    {capability.migration}
                  </Text>
                </View>
              ))}
            </View>

            <Button label="Check again" variant="secondary" size="md" onPress={() => void load()} />
          </>
        )}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.three,
  },
  headline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headlineText: {
    ...Typography.meta,
    ...font(700),
    flex: 1,
  },
  build: {
    ...Typography.caption,
  },
  note: {
    ...Typography.caption,
    lineHeight: 18,
  },
  list: {
    gap: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Radius.sm,
  },
  labelBlock: {
    flex: 1,
  },
  label: {
    ...Typography.caption,
  },
  file: {
    ...Typography.caption,
    ...font(600),
  },
});
