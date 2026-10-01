import { useRouter } from 'expo-router';
import { ChevronRight, Mail, Phone, ShieldQuestion, TriangleAlert } from 'lucide-react-native';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { Card } from '@/components/ui/card';
import { showDialog } from '@/components/ui/dialog';
import { SupportTicketPanel } from '@/components/ui/support-ticket-panel';
import { screenPadding, ScreenHeader, SectionLabel } from '@/components/ui/screen';
import { CHANNELS, CONTACT_IS_PLACEHOLDER, SELF_SERVE, type Channel } from '@/constants/contact';
import { MaxContentWidth, Radius, Spacing, Typography, font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Support / Contact Us.
 *
 * Self-serve first, then the channels. Most of what support gets asked is
 * already answered by a screen in the app, and a page that leads with an email
 * address makes someone wait a day for something they could have had in five
 * seconds.
 */
export default function SupportScreen() {
  const theme = useTheme();
  const router = useRouter();

  const open = (channel: Channel) => {
    Linking.openURL(channel.href).catch(() =>
      showDialog(
        'Could not open that',
        `No app on this device handles it. You can reach us at ${channel.value}.`,
      ),
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.container, screenPadding]}>
      <View style={styles.content}>
        <ScreenHeader
          brand={false}
          title="Support / Contact Us"
          subtitle="Most answers are already in the app. If yours isn't, here's how to reach a person."
        />

        {/*
          Not hidden in a code comment.

          These addresses are placeholders on a domain nobody has registered.
          Showing them as live contact channels would mean people email into a
          void and conclude they were ignored — worse than admitting the gap.
        */}
        {CONTACT_IS_PLACEHOLDER && (
          <View style={[styles.warning, { backgroundColor: theme.warningSoft }]}>
            <TriangleAlert color={theme.warningOnSoft} size={16} />
            <Text style={[styles.warningText, { color: theme.warningOnSoft }]}>
              These contact details are placeholders and are not monitored yet. Replace them in{' '}
              <Text style={font(700)}>src/constants/contact.ts</Text> before launch.
            </Text>
          </View>
        )}

        <SectionLabel>Answer it yourself, faster</SectionLabel>
        <Card style={styles.card}>
          {SELF_SERVE.map((item, index) => (
            <Pressable
              key={item.key}
              onPress={() => router.navigate(item.href as '/')}
              accessibilityRole="link"
              accessibilityLabel={`${item.question}. ${item.action}`}
              style={({ pressed }) => [
                styles.selfServe,
                index > 0 && {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: theme.border,
                },
                pressed && { backgroundColor: theme.surfaceMuted },
              ]}>
              <View style={styles.selfServeText}>
                <Text style={[styles.question, { color: theme.text }]}>{item.question}</Text>
                <Text style={[styles.action, { color: theme.primary }]}>{item.action}</Text>
              </View>
              <ChevronRight color={theme.textMuted} size={18} />
            </Pressable>
          ))}
        </Card>

        <SectionLabel>Talk to us</SectionLabel>
        <View style={styles.channels}>
          {CHANNELS.map((channel) => (
            <Pressable
              key={channel.key}
              onPress={() => open(channel)}
              accessibilityRole="button"
              accessibilityLabel={`${channel.label}: ${channel.value}`}
              style={({ pressed }) => [styles.channelWrap, pressed && styles.pressed]}>
              <Card style={styles.channel}>
                <View style={[styles.channelIcon, { backgroundColor: theme.primarySoft }]}>
                  {channel.key === 'phone' ? (
                    <Phone color={theme.primaryOnSoft} size={17} />
                  ) : channel.key === 'privacy' ? (
                    <ShieldQuestion color={theme.primaryOnSoft} size={17} />
                  ) : (
                    <Mail color={theme.primaryOnSoft} size={17} />
                  )}
                </View>
                <Text style={[styles.channelLabel, { color: theme.text }]}>{channel.label}</Text>
                <Text style={[styles.channelBest, { color: theme.textSecondary }]}>
                  {channel.bestFor}
                </Text>
                <Text style={[styles.channelValue, { color: theme.primary }]}>{channel.value}</Text>
                {/*
                  A response time on every channel, because the question behind
                  "has anyone seen this?" is almost always "how long should I
                  wait before chasing?".
                */}
                <Text style={[styles.channelTime, { color: theme.textMuted }]}>
                  {channel.responseTime}
                </Text>
              </Card>
            </Pressable>
          ))}
        </View>

        {/*
          Below the channels, not above them.

          Self-serve first is this screen's whole argument, and a ticket is not
          self-serve — it is the slowest path on the page. It sits here for the
          person who has read the rest and still needs somebody. Renders nothing
          at all for a signed-out visitor, who has no account for a reply to
          reach.
        */}
        <SupportTicketPanel />

        <Text style={[styles.footnote, { color: theme.textMuted }]}>
          If a parcel is in transit and something has gone wrong, call rather than email — email is
          answered in working hours and a parcel is not.
        </Text>
      </View>
      <Footer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  warning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three - 2,
    borderRadius: Radius.md,
    marginTop: Spacing.three,
  },
  warningText: {
    ...Typography.caption,
    ...font(600),
    flex: 1,
    lineHeight: 18,
  },
  card: {
    gap: 0,
    marginBottom: Spacing.three,
  },
  selfServe: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three - 2,
  },
  selfServeText: {
    flex: 1,
    gap: Spacing.half,
  },
  question: {
    ...Typography.meta,
    ...font(600),
  },
  action: {
    ...Typography.caption,
    ...font(700),
  },
  channels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three - 2,
  },
  /** Two up on a tablet, one on a phone, without a breakpoint to maintain. */
  channelWrap: {
    flexGrow: 1,
    flexBasis: 260,
  },
  channel: {
    gap: Spacing.one + 2,
    height: '100%',
  },
  channelIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  channelLabel: {
    ...Typography.meta,
    ...font(700),
  },
  channelBest: {
    ...Typography.caption,
    lineHeight: 18,
  },
  channelValue: {
    ...Typography.meta,
    ...font(700),
  },
  channelTime: {
    ...Typography.caption,
  },
  pressed: {
    opacity: 0.7,
  },
  footnote: {
    ...Typography.caption,
    lineHeight: 19,
    marginTop: Spacing.four,
  },
});
