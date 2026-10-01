import { router } from 'expo-router';
import { Linking, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import {
  activeAttributions,
  attributionsForPolicies,
  FOOTER_CREDIT_TEST_ID,
  type Attribution,
} from '@/lib/attribution';
import { DATA_SOURCES_PATH } from '@/lib/dataSources';
import { colors } from '@/theme';

export type FooterLocale = 'ja' | 'en';

export function Footer({
  locale = 'ja',
  attributionPolicies,
}: {
  locale?: FooterLocale;
  attributionPolicies?: readonly string[] | null;
}) {
  const { width } = useWindowDimensions();
  // 実データの attribution_policy が分かっているならそれを正とする。
  // policy が「フッターには何も出さない」provider (#559 Overture) を指しているとき、
  // 件数 0 を「未指定」と取り違えて環境変数側の provider (既定 Geoapify) へ
  // fallback すると、使っていない provider をクレジットしてしまう。
  const hasPolicies = (attributionPolicies?.length ?? 0) > 0;
  const attributions: Attribution[] = hasPolicies
    ? attributionsForPolicies(attributionPolicies)
    : activeAttributions();
  const isCompact = width < 720;
  const isEnglish = locale === 'en';

  const links = isEnglish
    ? [
        ['footer-data-sources', 'Data sources', 'Open the data sources and licenses page', DATA_SOURCES_PATH],
        ['footer-external-transmission', 'External transmission', 'Open the external transmission notice', '/en/external-transmission'],
        ['footer-privacy', 'Privacy', 'Open the privacy notice', '/en/privacy'],
        ['footer-account-deletion', 'Account deletion', 'Open the OISINT account deletion page', '/en/account-deletion'],
        ['footer-terms', 'Terms of service', 'Open the OISINT terms of service', '/en/terms'],
        ['footer-commercial-transactions', 'Specified Commercial Transactions', 'Open the specified commercial transactions notice', '/en/commercial-transactions'],
        ['footer-language', '日本語', '日本語版のプライバシー通知を開く', '/privacy'],
      ]
    : [
        ['footer-help', '使い方', 'OISINTの使い方ガイドを開く', '/help'],
        ['footer-support', 'サポート', 'OISINTのサポートを開く', '/support'],
        ['footer-contact', 'お問い合わせ', 'OISINTにお問い合わせする', '/contact'],
        ['footer-feedback', 'フィードバック', 'OISINTにフィードバックを送る', '/feedback'],
        ['footer-data-sources', 'データ提供元・ライセンス', 'データ提供元とライセンス表示のページを開く', DATA_SOURCES_PATH],
        ['footer-external-transmission', '外部送信について', '外部送信・端末保存情報の公表ページを開く', '/external-transmission'],
        ['footer-privacy', 'プライバシー', 'プライバシーポリシー（個人情報の公表事項）を開く', '/privacy'],
        ['footer-account-deletion', 'アカウント削除', 'OISINTの公開アカウント削除ページを開く', '/account-deletion'],
        ['footer-terms', '利用規約', 'OISINTの利用規約を開く', '/terms'],
        ['footer-commercial-transactions', '特商法表記', '特定商取引法に基づく表示を開く', '/commercial-transactions'],
        ['footer-language', 'English', 'Open the English privacy notice', '/en/privacy'],
      ];

  return (
    <View testID="footer-credit" style={[styles.container, isCompact && styles.containerCompact]}>
      <View style={[styles.inner, isCompact && styles.innerCompact]}>
        <View style={styles.credits}>
          {attributions.map((attribution) => (
            <Pressable
              key={attribution.id}
              testID={FOOTER_CREDIT_TEST_ID}
              accessibilityRole="link"
              accessibilityLabel={attribution.accessibilityLabel}
              onPress={() => {
                Linking.openURL(attribution.url).catch(() => {});
              }}
              style={styles.creditLink}
            >
              <Text style={styles.text}>{attribution.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={[styles.links, isCompact && styles.linksCompact]}>
          {links.map(([testID, label, accessibilityLabel, path]) => (
            <FooterLink
              key={testID}
              testID={testID}
              label={label}
              accessibilityLabel={accessibilityLabel}
              path={path}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

function FooterLink({
  testID,
  label,
  accessibilityLabel,
  path,
}: {
  testID: string;
  label: string;
  accessibilityLabel: string;
  path: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => router.push({ pathname: path } as never)}
      style={styles.helpButton}
    >
      <Text style={styles.helpText}>{label} ↗</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 16,
    paddingHorizontal: 24,
    backgroundColor: colors.surfaceSoft,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  containerCompact: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  inner: {
    width: '100%',
    maxWidth: 1100,
    minWidth: 0,
    flexDirection: 'row',
    // links may wrap when the viewport is narrower than the full contract;
    // align the first row with the credit row while retaining document flow.
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  innerCompact: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
  },
  links: {
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 2,
  },
  linksCompact: {
    width: '100%',
  },
  credits: {
    minWidth: 0,
    flexShrink: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
  },
  // WCAG 2.5.8 (axe target-size): タップ対象は最小 24x24px を確保する
  creditLink: {
    minHeight: 32,
    justifyContent: 'center',
  },
  text: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  helpButton: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  helpText: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '700',
  },
});
