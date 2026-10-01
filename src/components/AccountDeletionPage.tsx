import { router } from 'expo-router';
import { Linking, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Footer, type FooterLocale } from '@/components/Footer';
import { legalProfile, legalProfileEnglish } from '@/lib/legalProfile';
import { colors, fonts, radius } from '@/theme';

type AccountDeletionLocale = 'ja' | 'en';

type DeletionSection = {
  number: string;
  title: string;
  lead?: string;
  details?: readonly { label: string; value: string }[];
  bullets?: readonly string[];
  notes?: readonly string[];
};

type AccountDeletionCopy = {
  testID: string;
  footerLocale: FooterLocale;
  backLabel: string;
  eyebrow: string;
  title: string;
  copy: string;
  methodTestID: string;
  methodTitle: string;
  methodBody: string;
  steps: readonly string[];
  externalTitle: string;
  externalBody: string;
  emailLabel: string;
  contactLabel: string;
  contactPrefix: string;
  contactHoursPrefix: string;
  contactPath: string;
  mailSubject: string;
  sections: readonly DeletionSection[];
  updatedAt: string;
};

const COPY: Record<AccountDeletionLocale, AccountDeletionCopy> = {
  ja: {
    testID: 'account-deletion-page',
    footerLocale: 'ja',
    backLabel: 'OISINTのトップへ戻る',
    eyebrow: 'ACCOUNT DELETION / GOOGLE PLAY',
    title: 'アカウントと個人データを削除',
    copy:
      'OISINT（美味しント）のアカウント削除ページです。アプリ内の操作、またはアプリを使えない場合の外部からの削除依頼を案内します。',
    methodTestID: 'account-deletion-method',
    methodTitle: '削除方法を先に確認してください',
    methodBody:
      'OISINTを利用できる場合はアプリ内から削除できます。アプリを利用できない場合も、メールまたはお問い合わせフォームから削除を依頼できます。',
    steps: [
      'OISINT（美味しント）を開く',
      'アカウント画面を開く',
      '「アカウントと個人データを削除」を選ぶ',
      '確認表示を読み、削除を確定する',
    ],
    externalTitle: 'アプリを使えない場合',
    externalBody:
      '下の連絡先から削除依頼を送ってください。本人確認に必要な情報を案内します。パスワードは送らないでください。匿名アカウントの外部依頼は、本人であることを確認できない場合があります。',
    emailLabel: '削除依頼メールを作成 ↗',
    contactLabel: 'お問い合わせフォームを開く ↗',
    contactPrefix: '削除依頼先: ',
    contactHoursPrefix: '受付時間: ',
    mailSubject: 'OISINT アカウント削除依頼',
    contactPath: '/contact',
    sections: [
      {
        number: '01',
        title: '削除されるデータ',
        lead:
          '削除処理が完了すると、OISINTがアカウントに関連して保持する次のデータを削除します。',
        details: [
          {
            label: 'アカウントとプロフィール',
            value:
              'Supabase Authの対象アカウントと、OISINT側で保持するメールアドレス、Googleログイン由来のプロフィール情報、表示名、プロフィール画像URLを削除します。',
          },
          {
            label: '本人に紐づく調査データ',
            value:
              '本人が所有する調査、そこから生成された候補・評価、追加条件、投票、来店後フィードバック、参加メンバー行、本人に紐づく進行記録を削除します。',
          },
          {
            label: 'Taste Profileと個人属性ベクトル',
            value:
              '保存を選択した好みプロフィール、個人属性ベクトル（全モデル世代）、個人化に使った同意・重複排除記録を削除します。',
          },
          {
            label: 'Push通知に紐づく情報',
            value:
              '通知を利用していた場合は、OISINTの通知設定・通知outbox等を削除し、OneSignal Userの削除を先に要求します。OneSignal側の保持は同社の規約・DPA・運用設定に従います。',
          },
          {
            label: '購入・entitlementに紐づく情報',
            value:
              '購入・Plusを利用していた場合は、OISINT内のentitlement等を削除し、RevenueCat customerの削除を要求します。Google Play / App Storeの定期購入自体は解約されません。',
          },
        ],
        notes: [
          'Googleアカウントそのもの、Google Play / App Storeのアカウントそのものは削除しません。削除対象はOISINTが保持する関連情報です。',
        ],
      },
      {
        number: '02',
        title: '残る、または匿名化されるデータ',
        lead:
          'アカウントに直接ひも付かない共有資産や、記録の完全性・不正利用防止に必要な最小記録は、削除後も残る場合があります。',
        details: [
          {
            label: '共有店舗情報・Evidence',
            value:
              '共有資産であるplaces、evidence、place_facts、候補の集計値は一律削除しません。現行方針では自動的な期限を設けず、保持期間の上限は未確定です。',
          },
          {
            label: '他ユーザーの調査に残る参加記録',
            value:
              '他ユーザーが所有する共有調査の進行イベントは、本人の識別子や表示名を削除・匿名化して残る場合があります。進行イベント自体は作成から30日で削除します。',
          },
          {
            label: '監査・再発防止のための記録',
            value:
              '保存・削除などの監査イベントは本人識別子を匿名化して残る場合があります。保持期間は無期限ですが、運用上の保持上限は未確定です。HMAC化したレート制限値にも本人IDやIP平文は含めません。',
          },
          {
            label: '外部サービスのバックアップ・ログ',
            value:
              'Supabase、Cloudflare、OneSignal、RevenueCat等のバックアップや通信・運用ログは各事業者側の保持・消去手順に従います。OISINTが一律の期間を設定できないため、具体的な期間は各事業者の規約・契約で確認します。',
          },
        ],
      },
      {
        number: '03',
        title: '保持期間',
        lead: 'アカウント削除を行わない場合の、主なアプリ側データの保持期間です。',
        details: [
          {
            label: '完了した調査',
            value: '最終更新から6か月で匿名化します。依頼文・タイトルを消去し、整理済みの検索文・embedding・条件本文を匿名化または削除します。',
          },
          {
            label: '下書き・失敗・中断した調査',
            value: '最終更新から3か月で匿名化します。',
          },
          {
            label: '調査の進行イベント',
            value: '作成から30日で削除します。',
          },
          {
            label: '投票・条件・共有参加状態',
            value: '投票は親調査の匿名化と同時に削除し、条件本文と共有参加の最小状態は親調査の6か月または3か月を上限として処理します。',
          },
          {
            label: 'Push通知outbox',
            value: '固定イベント・UUID・送信/開封状態は作成から30日で削除します。通知設定はアカウント削除まで保持します。',
          },
          {
            label: '外部APIキャッシュ',
            value: '検索・取得・候補検索の一時キャッシュはTTL 24時間です。',
          },
          {
            label: '好みプロフィール・個人属性ベクトル',
            value: '本人が「好みだけ削除」またはアカウント削除を行うまで保持します。',
          },
          {
            label: '共有places・evidence・監査イベント',
            value: '共有資産と匿名化済み監査イベントは自動削除の期限を設けていません。保持期間の上限は未確定です。',
          },
        ],
      },
      {
        number: '04',
        title: '削除処理と定期購入について',
        bullets: [
          'アプリ内の削除操作では、本人JWTを確認したうえで、外部のOneSignal User・RevenueCat customerの削除要求、OISINT側の個人データ掃除、Supabase Auth削除を順に行います。',
          '外部課金データの削除を確認できない場合は、OISINT側の削除を完了せず、再試行できる状態で止まります。',
          'アカウント削除ではGoogle Play / App Storeの定期購入は解約されません。課金を止める場合は、先に各ストアの定期購入設定から解約してください。',
          '削除後も共有調査の店舗情報や根拠が残る場合があります。本人の識別子を残すものではありません。',
        ],
        notes: ['削除に関する問い合わせ先は、上の外部依頼方法またはお問い合わせフォームを利用してください。'],
      },
    ],
    updatedAt: '最終更新日: 2026年9月2日',
  },
  en: {
    testID: 'account-deletion-page-en',
    footerLocale: 'en',
    backLabel: 'Return to the OISINT home page',
    eyebrow: 'ACCOUNT DELETION / GOOGLE PLAY',
    title: 'Delete your account and personal data',
    copy:
      'This is the OISINT account-deletion page. It explains the in-app path and the external request path available when the app cannot be used.',
    methodTestID: 'account-deletion-method-en',
    methodTitle: 'Review the deletion methods first',
    methodBody:
      'If you can use OISINT, you can start deletion from the app. If you cannot use the app, you can request deletion by email or through the Contact form.',
    steps: [
      'Open OISINT',
      'Open the Account screen',
      'Choose “Delete account and personal data”',
      'Review the confirmation and confirm deletion',
    ],
    externalTitle: 'If you cannot use the app',
    externalBody:
      'Send a deletion request using the contact details below. We will explain any information needed to verify ownership. Do not send your password. An external request for an anonymous account may not be fulfillable if ownership cannot be verified.',
    emailLabel: 'Create a deletion request email ↗',
    contactLabel: 'Open the Contact form ↗',
    contactPrefix: 'Deletion request contact: ',
    contactHoursPrefix: 'Contact hours: ',
    mailSubject: 'OISINT account deletion request',
    contactPath: '/contact',
    sections: [
      {
        number: '01',
        title: 'Data deleted',
        lead: 'When deletion completes, OISINT deletes the following data associated with the account.',
        details: [
          {
            label: 'Account and profile',
            value:
              'The Supabase Auth account and the email address, Google-login profile information, display name, and profile-image URL held by OISINT are deleted.',
          },
          {
            label: 'Account-owned investigation data',
            value:
              'Investigations owned by the user, their generated candidates and evaluations, additional conditions, votes, post-visit feedback, membership rows, and account-linked progress records are deleted.',
          },
          {
            label: 'Taste Profile and personal attribute vectors',
            value:
              'A saved preference profile, all personal attribute-vector model generations, and personalization consent or deduplication records are deleted.',
          },
          {
            label: 'Push-notification data',
            value:
              'If push notifications were used, OISINT notification preferences and outbox data are deleted, and deletion of the OneSignal User is requested first. OneSignal-side retention follows its terms, DPA, and operational configuration.',
          },
          {
            label: 'Purchase and entitlement linkage',
            value:
              'If purchases or Plus were used, OISINT entitlement data is deleted and deletion of the RevenueCat customer is requested. The Google Play or App Store subscription itself is not cancelled.',
          },
        ],
        notes: [
          'The Google Account itself and the Google Play or App Store account itself are not deleted. The deletion scope is information held by OISINT about the account.',
        ],
      },
      {
        number: '02',
        title: 'Data that may remain or be anonymized',
        lead:
          'Shared assets and limited records needed for record integrity or abuse prevention may remain after account deletion.',
        details: [
          {
            label: 'Shared place information and Evidence',
            value:
              'Shared places, evidence, place facts, and candidate aggregate values are not deleted as a blanket rule. Under the current policy they have no automatic expiry; the maximum retention period is not yet determined.',
          },
          {
            label: 'Participation records in another user’s investigation',
            value:
              'Progress events in another user’s shared investigation may remain after the user identifier and display name are removed or anonymized. The progress event itself is deleted 30 days after creation.',
          },
          {
            label: 'Audit and abuse-prevention records',
            value:
              'Product audit events may remain with the user identifier anonymized. Their retention is currently indefinite and the operational maximum is not yet determined. Rate-limit values contain only HMAC-derived values, not a user ID or plaintext IP address.',
          },
          {
            label: 'Third-party backups and logs',
            value:
              'Backups and communication or operational logs held by Supabase, Cloudflare, OneSignal, RevenueCat, or other providers follow each provider’s retention and deletion procedures. OISINT does not set one uniform period; the specific period is confirmed from the applicable provider terms and contracts.',
          },
        ],
      },
      {
        number: '03',
        title: 'Retention periods',
        lead: 'These are the main application-side retention periods when an account has not been deleted.',
        details: [
          {
            label: 'Completed investigations',
            value: 'Anonymized six months after the last update. Request text and title are removed, and organized search text, embeddings, and condition text are anonymized or deleted.',
          },
          {
            label: 'Draft, failed, or interrupted investigations',
            value: 'Anonymized three months after the last update.',
          },
          {
            label: 'Investigation progress events',
            value: 'Deleted 30 days after creation.',
          },
          {
            label: 'Votes, conditions, and shared-investigation state',
            value: 'Votes are deleted with parent-investigation anonymization. Condition text and the minimal shared journey state are handled with a maximum of six months or three months based on the parent investigation.',
          },
          {
            label: 'Push-notification outbox',
            value: 'Fixed events, UUIDs, and sent/open state are deleted 30 days after creation. Notification preferences remain until account deletion.',
          },
          {
            label: 'External API cache',
            value: 'Temporary search, fetch, and place-discovery cache entries have a 24-hour TTL.',
          },
          {
            label: 'Preference profile and personal attribute vectors',
            value: 'Retained until the user chooses “Delete preferences only” or deletes the account.',
          },
          {
            label: 'Shared places, Evidence, and audit events',
            value: 'Shared assets and anonymized audit events have no automatic deletion deadline. The maximum retention period is not yet determined.',
          },
        ],
      },
      {
        number: '04',
        title: 'Deletion processing and subscriptions',
        bullets: [
          'The in-app flow verifies the user JWT, requests deletion of the external OneSignal User and RevenueCat customer, purges OISINT personal data, and then deletes the Supabase Auth account.',
          'If external billing data deletion cannot be confirmed, OISINT does not complete the local account deletion and stops in a retryable state.',
          'Deleting an account does not cancel a Google Play or App Store subscription. Cancel it from the applicable store subscription settings if you want billing to stop.',
          'Shared place information and Evidence may remain after deletion. They are not retained as the user’s identifying account data.',
        ],
        notes: ['Use the external request method above or the Contact form for deletion questions.'],
      },
    ],
    updatedAt: 'Last updated: September 2, 2026',
  },
};

export function AccountDeletionPage({
  locale = 'ja',
  title,
}: {
  locale?: AccountDeletionLocale;
  title?: string;
}) {
  const { width } = useWindowDimensions();
  const isCompact = width < 720;
  const content = title ? { ...COPY[locale], title } : COPY[locale];
  const profile = locale === 'en' ? legalProfileEnglish : legalProfile;
  const mailto = `mailto:${profile.email}?subject=${encodeURIComponent(content.mailSubject)}`;

  return (
    <View testID={content.testID} style={styles.wrapper}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={styles.container}>
          <View style={styles.topBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={content.backLabel}
              onPress={() => router.replace('/')}
              style={styles.backButton}
            >
              <Text style={styles.backArrow}>←</Text>
              <Text style={styles.backText}>OISINT</Text>
            </Pressable>
          </View>

          <View style={styles.intro}>
            <Text style={styles.eyebrow}>{content.eyebrow}</Text>
            <Text accessibilityRole="header" style={styles.title}>{content.title}</Text>
            <Text style={styles.copy}>{content.copy}</Text>
          </View>

          <View nativeID="deletion-method" testID={content.methodTestID} style={styles.methodCard}>
            <Text style={styles.methodKicker}>DELETE / REQUEST</Text>
            <Text style={styles.methodTitle}>{content.methodTitle}</Text>
            <Text style={styles.methodBody}>{content.methodBody}</Text>

            <View style={styles.stepList}>
              {content.steps.map((step, index) => (
                <View key={step} style={styles.stepRow}>
                  <View style={styles.stepNumber}>
                    <Text style={styles.stepNumberText}>{index + 1}</Text>
                  </View>
                  <Text style={styles.stepText}>{step}</Text>
                </View>
              ))}
            </View>

            <View style={styles.externalRequest}>
              <Text style={styles.externalTitle}>{content.externalTitle}</Text>
              <Text style={styles.externalBody}>{content.externalBody}</Text>
              <View style={[styles.actionRow, isCompact && styles.actionRowCompact]}>
                <Pressable
                  testID={`${content.testID}-email-link`}
                  accessibilityRole="link"
                  accessibilityLabel={content.emailLabel.replace(' ↗', '')}
                  onPress={() => Linking.openURL(mailto).catch(() => {})}
                  style={[styles.actionButton, isCompact && styles.actionButtonCompact]}
                >
                  <Text style={styles.actionButtonText}>{content.emailLabel}</Text>
                </Pressable>
                <Pressable
                  testID={`${content.testID}-contact-link`}
                  accessibilityRole="link"
                  accessibilityLabel={content.contactLabel.replace(' ↗', '')}
                  onPress={() => router.push({ pathname: content.contactPath } as never)}
                  style={[styles.actionButton, styles.actionButtonSecondary, isCompact && styles.actionButtonCompact]}
                >
                  <Text style={[styles.actionButtonText, styles.actionButtonSecondaryText]}>{content.contactLabel}</Text>
                </Pressable>
              </View>
              <Text style={styles.contactText}>
                {content.contactPrefix}{profile.email} / {content.contactHoursPrefix}{profile.contactHours}
              </Text>
            </View>
          </View>

          <View style={styles.sectionList}>
            {content.sections.map((section) => (
              <DeletionSectionView key={section.number} section={section} />
            ))}
          </View>

          <View style={styles.relatedLinks}>
            <Text style={styles.relatedTitle}>{locale === 'en' ? 'Related pages' : '関連ページ'}</Text>
            <View style={styles.relatedLinkRow}>
              <PageLink
                label={locale === 'en' ? 'Privacy notice ↗' : 'プライバシー ↗'}
                accessibilityLabel={locale === 'en' ? 'Open the OISINT privacy notice' : 'OISINTのプライバシーを開く'}
                path={locale === 'en' ? '/en/privacy' : '/privacy'}
              />
              <PageLink
                label={locale === 'en' ? 'Account screen ↗' : 'アカウント画面 ↗'}
                accessibilityLabel={locale === 'en' ? 'Open the OISINT account screen' : 'OISINTのアカウント画面を開く'}
                path="/account"
              />
            </View>
          </View>

          <Text style={styles.updatedAt}>{content.updatedAt}</Text>
        </View>
      </ScrollView>
      <Footer locale={content.footerLocale} />
    </View>
  );
}

function DeletionSectionView({ section }: { section: DeletionSection }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeading}>
        <Text style={styles.cardNumber}>{section.number}</Text>
        <Text accessibilityRole="header" style={styles.cardTitle}>{section.title}</Text>
      </View>
      {section.lead ? <Text style={styles.cardLead}>{section.lead}</Text> : null}
      {section.bullets ? (
        <View style={styles.detailList}>
          {section.bullets.map((bullet) => (
            <Text key={bullet} style={styles.detailValue}>・{bullet}</Text>
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
        <Text key={note} style={styles.cardNote}>※ {note}</Text>
      ))}
    </View>
  );
}

function PageLink({ label, accessibilityLabel, path }: { label: string; accessibilityLabel: string; path: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel}
      onPress={() => router.push({ pathname: path } as never)}
      style={styles.relatedLink}
    >
      <Text style={styles.relatedLinkText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: colors.bg },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32 },
  container: { width: '100%', maxWidth: 860, alignSelf: 'center', gap: 24 },
  topBar: { minHeight: 42, flexDirection: 'row', alignItems: 'center' },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 42, paddingRight: 8 },
  backArrow: { color: colors.textSecondary, fontSize: 20, lineHeight: 22 },
  backText: { color: colors.text, fontFamily: fonts.brand, fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
  intro: { maxWidth: 720, gap: 5 },
  eyebrow: { color: colors.orange, fontSize: 9, fontWeight: '800', letterSpacing: 1.3, fontFamily: fonts.brand },
  title: { color: colors.text, fontSize: 30, lineHeight: 41, fontWeight: '800', letterSpacing: -1.1 },
  copy: { marginTop: 6, color: colors.textSecondary, fontSize: 12, lineHeight: 20 },
  methodCard: { gap: 12, padding: 20, borderRadius: radius.lg, backgroundColor: colors.orangeFaint, borderWidth: 1, borderColor: colors.orangeSoft },
  methodKicker: { color: colors.orange, fontSize: 9, fontWeight: '800', letterSpacing: 1.2, fontFamily: fonts.brand },
  methodTitle: { color: colors.text, fontSize: 19, lineHeight: 27, fontWeight: '800' },
  methodBody: { color: colors.textSecondary, fontSize: 12, lineHeight: 20 },
  stepList: { gap: 9, marginTop: 3 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  stepNumber: { width: 27, height: 27, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.orange },
  stepNumberText: { color: colors.surface, fontFamily: fonts.brand, fontSize: 11, fontWeight: '800' },
  stepText: { flex: 1, paddingTop: 3, color: colors.text, fontSize: 12, lineHeight: 20, fontWeight: '700' },
  externalRequest: { gap: 7, marginTop: 5, paddingTop: 15, borderTopWidth: 1, borderTopColor: colors.orangeSoft },
  externalTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  externalBody: { color: colors.textSecondary, fontSize: 11, lineHeight: 19 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 3 },
  actionRowCompact: { flexDirection: 'column' },
  actionButton: { minHeight: 45, flexGrow: 1, flexShrink: 1, minWidth: 220, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 15, borderRadius: radius.sm, backgroundColor: colors.orange },
  actionButtonCompact: { width: '100%', minWidth: 0 },
  actionButtonSecondary: { borderWidth: 1, borderColor: colors.orange, backgroundColor: colors.surface },
  actionButtonText: { color: colors.surface, fontSize: 11, fontWeight: '800', textAlign: 'center' },
  actionButtonSecondaryText: { color: colors.orange },
  contactText: { color: colors.textTertiary, fontSize: 10, lineHeight: 17 },
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
  relatedLinks: { gap: 8, padding: 16, borderRadius: radius.md, backgroundColor: colors.surfaceSoft },
  relatedTitle: { color: colors.textSecondary, fontSize: 11, fontWeight: '800' },
  relatedLinkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  relatedLink: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 11, borderRadius: radius.sm, backgroundColor: colors.surface },
  relatedLinkText: { color: colors.orange, fontSize: 11, fontWeight: '800' },
  updatedAt: { color: colors.textTertiary, fontSize: 11 },
});
