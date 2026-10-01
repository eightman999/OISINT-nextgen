import { router } from 'expo-router';
import Head from 'expo-router/head';
import { useEffect } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { colors, fonts, radius } from '@/theme';

const BRAND_LOGO = require('../assets/branding/oisint-logo-horizontal.png');

// 電気通信事業法 27 条の 12（外部送信規律）・施行規則 22 条の 2 の 28 / 29 に基づく公表ページ（#271）。
// 文面は docs/legal/audit-telecom.md §7.1 の案をベースに、実装の実測（保存箇所・送信経路）へ合わせて整形した。

type DetailItem = { label: string; value: string };

type Section = {
  number: string;
  title: string;
  details: DetailItem[];
  notes?: string[];
};

const SECTIONS: Section[] = [
  {
    number: '01',
    title: 'ログイン状態を保つための情報',
    details: [
      { label: '保存する場所', value: 'お使いのブラウザ（localStorage）' },
      { label: '内容', value: 'ログインのための認証情報（アクセストークン）' },
      { label: '送信先', value: 'Supabase（データベース・認証基盤の提供事業者）' },
      { label: '利用目的', value: 'ログイン状態の維持、あなたの調査データの表示' },
    ],
    notes: [
      '調査画面を開いている間は、候補や投票の変化をそろえるための同期通信も同じ送信先との間で行います。',
    ],
  },
  {
    number: '02',
    title: '好み・体調に関する設定（任意入力）',
    details: [
      {
        label: '保存する場所',
        value: 'お使いのブラウザ（localStorage）。原則としてこの端末にだけ保存します。',
      },
      { label: '内容', value: '好きなもの、避けたいもの、アレルギー、健康の目的' },
      {
        label: '送信先と送るもの',
        value:
          '「好きなもの」「避けたいもの」は、調査を開始するときの検索文に含めて送信します。「アレルギー」「健康の目的」は検索文に含めず、送信しません。アカウント画面で「保存」を選んだときに限り、Supabase の設備へ保存します。',
      },
      { label: '利用目的', value: 'あなた向けの候補の並び替え' },
    ],
  },
  {
    number: '03',
    title: 'その他のブラウザ起点の外部送信',
    details: [
      { label: '内容', value: '通信に伴う IP アドレス・ブラウザの種類など' },
      {
        label: '一時保存（sessionStorage）',
        value:
          '所有者が自分の過去の調査文を再入力するとき、本人のアカウントIDに結び付けた一回限りの調査文を同じタブ内へ一時保存します。読み出し後、期限切れ、アカウント不一致では削除します。',
      },
      {
        label: 'オフライン用保存（Cache API）',
        value:
          'Service WorkerがOISINTと同じドメインの静的ファイルだけを端末へ保存します。調査文、条件、投票、認証情報、外部API応答は保存対象にしません。',
      },
      {
        label: '候補店舗写真の送信先',
        value:
          'なし。現行の Geoapify Places API は店舗写真を提供しないため、候補画面では画像を表示せず、店舗写真 CDN へ自動接続しません。',
      },
      { label: '候補店舗写真の利用目的', value: '現行実装では店舗写真を表示しません。生成画像による代替表示も行いません。' },
    ],
    notes: [
      'このほか、Google ログインを選んだときは Google へ、地図を開くときは Google マップへ、アカウント画面でアイコン画像を表示するときはその画像の提供元へ、あなたの操作に応じて通信します。現行 provider の店舗写真 CDN への自動接続はありません。',
    ],
  },
  {
    number: '04',
    title: '混雑・不正利用を防ぐための情報',
    details: [
      { label: '内容', value: 'IP アドレスを復元できない形に変換した値（ハッシュ値）' },
      { label: '送信先', value: 'Supabase' },
      { label: '利用目的', value: '過度な連続リクエストの制限' },
    ],
  },
  {
    number: '05',
    title: 'あなたが入力した調査の文章',
    details: [
      {
        label: '送信先と送る情報',
        value:
          '調査依頼の自由文・追加条件は Supabase と Google（Gemini）へ送信します。Geoapify へは地名・構造化された検索条件、現在地検索時の GPS anchor を送信し、Serper へは店舗名・地域名などから生成した検索語を送信します。元の自由文を Geoapify / Serper へ直接送信しません。',
      },
      { label: '利用目的', value: '候補店舗の検索と、根拠（Evidence）の収集・評価。表示・共有する候補は OISINT の canonical Place と provider link で管理します。' },
    ],
    notes: [
      'Google Gemini への入力・出力の取扱いは、採用する Google API の契約・利用条件に従います。自由文に個人情報や要配慮情報を入力しないでください。',
    ],
  },
  {
    number: '06',
    title: '購入状態の確認に関する外部送信（RevenueCat）',
    details: [
      {
        label: '送信先と送る情報',
        value:
          '購入または購入状態の確認を選んだ場合、永続アカウントの UUID を RevenueCat の App User ID として使い、購入・entitlement・更新状態を RevenueCat、必要に応じて Apple App Store / Google Play と同期します。調査依頼の自由文、氏名、メールアドレス、GPS、アレルギー・健康情報は課金 provider へ送りません。',
      },
      { label: '利用目的', value: 'Plus の購入状態と利用権限の確認・同期' },
    ],
    notes: [
      'OISINTのアカウント削除は RevenueCat customer の削除要求を開始しますが、ストアの定期購入を解約する操作ではありません。解約・返金は各ストアの設定・サポート導線を利用してください。価格・契約期間・提供地域は購入画面に表示される条件を確認してください。',
    ],
  },
  {
    number: '07',
    title: 'Push通知に関する外部送信（OneSignal）',
    details: [
      {
        label: '送信先と送る情報',
        value:
          'アカウント画面でPush通知を有効にした場合だけ、OneSignalへ永続アカウントのUUID（external_id）、固定イベント種別、対象調査・通知のUUID、固定形式のアプリ内遷移先を送ります。SDKは配送に必要なpush token・端末/OS・言語・timezone・利用時刻/回数・IP等も扱い得ます。位置情報共有は無効化し、調査依頼文、条件本文、店名、表示名、Taste Profile、GPS、メールアドレス、認証情報、共有トークンは送信しません。',
      },
      { label: '利用目的', value: '調査完了・参加中グループの更新・順位変化をiOS/Androidへ配送し、対象調査へ戻るため' },
    ],
    notes: [
      '初回起動では通知許可を要求しません。アカウント画面で停止でき、logout/アカウント切替時は旧通知先を解除します。アカウント削除時はOneSignal Userの削除を先に要求します。',
    ],
  },
];

const DELETION_STEPS = [
  '好み・体調に関する設定は、アカウント画面の「好みだけ削除」からいつでも削除できます（この端末とアカウントの両方から削除されます）。',
  'ログイン情報を含むこの端末の保存情報は、お使いのブラウザの設定からこのサイトのサイトデータ（localStorage）を削除することでも消去できます。',
  'sessionStorageとCache APIを含むサイトデータも、ブラウザのサイトデータ削除から消去できます。',
];

export default function ExternalTransmissionScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 780;

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', 'ja');
      document.title = 'OISINT | 外部送信・端末保存情報';
    }
  }, []);

  return (
    <>
      <Head>
        <title>OISINT | 外部送信・端末保存情報</title>
        <meta name="description" content="OISINTがブラウザに保存し、外部サービスへ送信する情報を確認できます。" />
      </Head>
      <View testID="external-transmission-page" style={styles.wrapper}>
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
          <View style={[styles.container, isWide && styles.containerWide]}>
          <View style={styles.topBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="OISINTのトップへ戻る"
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
            <Text style={styles.eyebrow}>EXTERNAL TRANSMISSION</Text>
            <Text accessibilityRole="header" style={styles.title}>外部送信・端末保存情報について</Text>
            <Text style={styles.copy}>
              OISINTでは、サービスを提供するために、お使いのブラウザに次の情報を保存し、またOISINTが利用する事業者の設備へ次の情報を送信します。電気通信事業法の外部送信規律（法27条の12）の趣旨に基づき、その内容をこのページで公表します。
            </Text>
          </View>

          <View style={styles.sectionList}>
            {SECTIONS.map((section) => (
              <View key={section.number} style={styles.card}>
                <View style={styles.cardHeading}>
                  <Text style={styles.cardNumber}>{section.number}</Text>
                <Text accessibilityRole="header" style={styles.cardTitle}>{section.title}</Text>
                </View>
                <View style={styles.detailList}>
                  {section.details.map((detail) => (
                    <View key={detail.label} style={styles.detailRow}>
                      <Text style={styles.detailLabel}>{detail.label}</Text>
                      <Text style={styles.detailValue}>{detail.value}</Text>
                    </View>
                  ))}
                </View>
                {section.notes?.map((note) => (
                  <Text key={note} style={styles.cardNote}>
                    ※ {note}
                  </Text>
                ))}
              </View>
            ))}

            <View style={styles.card}>
              <View style={styles.cardHeading}>
                <Text style={styles.cardNumber}>08</Text>
                <Text accessibilityRole="header" style={styles.cardTitle}>保存した情報の削除方法</Text>
              </View>
              <View style={styles.detailList}>
                {DELETION_STEPS.map((step) => (
                  <Text key={step} style={styles.detailValue}>
                    ・{step}
                  </Text>
                ))}
              </View>
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeading}>
                <Text style={styles.cardNumber}>09</Text>
                <Text accessibilityRole="header" style={styles.cardTitle}>Cookie・広告・アクセス解析について</Text>
              </View>
              <View style={styles.detailList}>
                <Text style={styles.detailValue}>
                  OISINTのアプリ自体は、Cookieの読み書きを行っていません。また、広告のための情報収集や、広告事業者へのデータ送信は行っていません。
                </Text>
              </View>
              <Text style={styles.cardNote}>
                このページは OISINT アプリケーションの Cookie・広告・解析の挙動を記載しています。provider の契約条件と運用設定が適用される場合は、それらも確認してください。
              </Text>
            </View>
          </View>

          <Text style={styles.updatedAt}>最終更新日: 2026年8月30日</Text>
          </View>
        </ScrollView>
        <Footer />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 32,
  },
  container: {
    width: '100%',
    maxWidth: 860,
    alignSelf: 'center',
    gap: 24,
  },
  containerWide: {
    gap: 30,
  },
  topBar: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 42,
    paddingRight: 8,
  },
  backArrow: {
    color: colors.textSecondary,
    fontSize: 20,
    lineHeight: 22,
  },
  topLogoImage: {
    width: 112,
    height: 34,
  },
  intro: {
    maxWidth: 680,
    gap: 5,
  },
  eyebrow: {
    color: colors.orange,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.3,
    fontFamily: fonts.brand,
  },
  title: {
    color: colors.text,
    fontSize: 30,
    lineHeight: 41,
    fontWeight: '800',
    letterSpacing: -1.1,
  },
  copy: {
    marginTop: 6,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 20,
  },
  sectionList: {
    gap: 14,
  },
  card: {
    gap: 12,
    padding: 17,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  cardHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardNumber: {
    color: colors.orange,
    fontSize: 11,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  cardTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  detailList: {
    gap: 8,
  },
  detailRow: {
    gap: 2,
  },
  detailLabel: {
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: '700',
  },
  detailValue: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 20,
  },
  cardNote: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 18,
  },
  pendingBox: {
    gap: 4,
    padding: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pendingTitle: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '800',
  },
  pendingItem: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 18,
  },
  updatedAt: {
    color: colors.textTertiary,
    fontSize: 11,
  },
});
