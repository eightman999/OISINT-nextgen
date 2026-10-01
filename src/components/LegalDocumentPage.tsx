import { router } from 'expo-router';
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Footer, type FooterLocale } from '@/components/Footer';
import { colors, fonts, radius } from '@/theme';

const BRAND_LOGO = require('../../assets/branding/oisint-logo-horizontal.png');

export type LegalDocumentSection = {
  number: string;
  title: string;
  lead?: string;
  details?: { label: string; value: string }[];
  bullets?: string[];
  notes?: string[];
};

type LegalDocumentPageProps = {
  testID: string;
  eyebrow: string;
  title: string;
  copy: string;
  draftTitle: string;
  draftBody: string;
  sections: LegalDocumentSection[];
  updatedAt: string;
  footerLocale?: FooterLocale;
};

export function LegalDocumentPage({
  testID,
  eyebrow,
  title,
  copy,
  draftTitle,
  draftBody,
  sections,
  updatedAt,
  footerLocale = 'ja',
}: LegalDocumentPageProps) {
  const { width } = useWindowDimensions();
  const isWide = width >= 780;

  return (
    <View testID={testID} style={styles.wrapper}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={[styles.container, isWide && styles.containerWide]}>
          <View style={styles.topBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={footerLocale === 'en' ? 'Return to the OISINT home page' : 'OISINTのトップへ戻る'}
              onPress={() => router.replace('/')}
              style={styles.backButton}
            >
              <Text style={styles.backArrow}>←</Text>
              <Image
                source={BRAND_LOGO}
                resizeMode="contain"
                accessibilityLabel="OISINTロゴ"
                style={styles.topLogoImage}
              />
            </Pressable>
          </View>

          <View style={styles.intro}>
            <Text style={styles.eyebrow}>{eyebrow}</Text>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.copy}>{copy}</Text>
          </View>

          <View style={styles.draftBanner}>
            <Text style={styles.draftBannerTitle}>{draftTitle}</Text>
            <Text style={styles.draftBannerBody}>{draftBody}</Text>
          </View>

          <View style={styles.sectionList}>
            {sections.map((section) => (
              <View key={section.number} style={styles.card}>
                <View style={styles.cardHeading}>
                  <Text style={styles.cardNumber}>{section.number}</Text>
                  <Text style={styles.cardTitle}>{section.title}</Text>
                </View>
                {section.lead ? <Text style={styles.cardLead}>{section.lead}</Text> : null}
                {section.bullets ? (
                  <View style={styles.detailList}>
                    {section.bullets.map((bullet) => (
                      <Text key={bullet} style={styles.detailValue}>
                        ・{bullet}
                      </Text>
                    ))}
                  </View>
                ) : null}
                {section.details ? (
                  <View style={styles.detailList}>
                    {section.details.map((detail) => (
                      <View key={detail.label} style={styles.detailRow}>
                        <Text style={styles.detailLabel}>{detail.label}</Text>
                        <Text style={styles.detailValue}>{detail.value}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {section.notes?.map((note) => (
                  <Text key={note} style={styles.cardNote}>
                    ※ {note}
                  </Text>
                ))}
              </View>
            ))}
          </View>

          <Text style={styles.updatedAt}>{updatedAt}</Text>
        </View>
      </ScrollView>
      <Footer locale={footerLocale} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: colors.bg },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32 },
  container: { width: '100%', maxWidth: 860, alignSelf: 'center', gap: 24 },
  containerWide: { gap: 30 },
  topBar: { minHeight: 42, flexDirection: 'row', alignItems: 'center' },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 42, paddingRight: 8 },
  backArrow: { color: colors.textSecondary, fontSize: 20, lineHeight: 22 },
  topLogoImage: { width: 112, height: 34 },
  intro: { maxWidth: 680, gap: 5 },
  eyebrow: { color: colors.orange, fontSize: 9, fontWeight: '800', letterSpacing: 1.3, fontFamily: fonts.brand },
  title: { color: colors.text, fontSize: 30, lineHeight: 41, fontWeight: '800', letterSpacing: -1.1 },
  copy: { marginTop: 6, color: colors.textSecondary, fontSize: 12, lineHeight: 20 },
  draftBanner: { gap: 4, padding: 14, borderRadius: radius.md, backgroundColor: colors.warningSoft, borderWidth: 1, borderColor: colors.warning },
  draftBannerTitle: { color: colors.warning, fontSize: 13, fontWeight: '800' },
  draftBannerBody: { color: colors.text, fontSize: 11, lineHeight: 18 },
  sectionList: { gap: 14 },
  card: { gap: 12, padding: 17, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSoft },
  cardHeading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardNumber: { color: colors.orange, fontSize: 11, fontWeight: '800', fontFamily: fonts.brand },
  cardTitle: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '800', letterSpacing: -0.3 },
  cardLead: { color: colors.textSecondary, fontSize: 12, lineHeight: 20 },
  detailList: { gap: 8 },
  detailRow: { gap: 2 },
  detailLabel: { color: colors.textTertiary, fontSize: 10, fontWeight: '700' },
  detailValue: { color: colors.text, fontSize: 12, lineHeight: 20 },
  cardNote: { color: colors.textSecondary, fontSize: 11, lineHeight: 18 },
  updatedAt: { color: colors.textTertiary, fontSize: 11 },
});
