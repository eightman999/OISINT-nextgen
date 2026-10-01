import { router } from 'expo-router';
import Head from 'expo-router/head';
import { useEffect } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { legalProfile } from '@/lib/legalProfile';
import { colors, fonts, radius } from '@/theme';

const BRAND_LOGO = require('../assets/branding/oisint-logo-horizontal.png');

// APPI（個人情報の保護に関する法律）17条1項・21条1項・32条1項・施行令10条が求める公表事項ページ（#278）。
// 文面は docs/legal/external-transfer-map.md §5（外部送信先）と docs/legal/appi-request-procedure.md §6
// （請求手続）の下書きをベースに、保存項目・利用目的・保存期間は実装の実測
// （supabase/migrations/・src/lib/profile.ts・src/lib/personalizationConsent.ts・0017_data_retention.sql）へ合わせた。
// 事業者名・住所・連絡先・手数料など運営者にしか確定できない事実は、
// 入力用JSON（src/config/legal-profile.json）から読み込む。

type DetailItem = { label: string; value: string };

type Section = {
  number: string;
  title: string;
  lead?: string;
  details?: DetailItem[];
  bullets?: string[];
  notes?: string[];
};

const SECTIONS: Section[] = [
  {
    // 法32条1項1号（事業者の氏名・名称・住所、法人は代表者の氏名）
    number: '01',
    title: '事業者の名称・住所・連絡先',
    details: [
      { label: '事業者の氏名または名称', value: legalProfile.businessName },
      { label: '屋号', value: legalProfile.tradeName },
      { label: '住所', value: legalProfile.address },
      { label: '代表者氏名', value: legalProfile.representativeName },
      { label: '連絡先', value: `${legalProfile.phone} / ${legalProfile.email}（アプリ内の「お問い合わせ」画面からもご連絡いただけます）` },
    ],
  },
  {
    // 法32条1項2号の前提となる保有個人データの項目（保存する項目の実測一覧）
    number: '02',
    title: '取得・保存する情報',
    lead: 'OISINT がサーバ（データベース）に保存する情報は次のとおりです。',
    details: [
      {
        label: 'アカウントに関する情報',
        value:
          '・利用者を区別するための ID（匿名ではじめる場合も自動発行されます）\n・Google アカウントでログインした場合: メールアドレス、氏名、アイコン画像の URL\n・設定した表示名・アイコン画像の URL',
      },
      {
        label: '調査に関する情報',
        value:
          '・調査依頼として入力した文章と、そこから生成したタイトル・整理済みの検索文・検索用の数値データ（embedding）\n・調査に追加した条件の文章\n・候補への投票\n・共有調査への参加記録（参加日時・役割）と、参加時の表示名を含む進行イベント\n・共有リンクの発行に使う共有トークン',
      },
      {
        label: '来店後のフィードバック',
        value:
          '来店日・評価など、店舗について任意で送信した内容。これを今後のおすすめに反映する Taste Profile 学習は、保存後に表示する明示的な opt-in を選んだ場合だけ実行します。選ばない場合は学習せず、後からリセット・削除できます。',
      },
      {
        label: '運用メトリクス',
        value:
          '既存の調査・共有参加・進行イベントから、DB内で1日間・7日間・30日間の利用者数と件数を集計します。個別の行や識別子を運用画面・外部サービスへ渡さず、集計JSONだけを扱います。アカウント画面から集計対象外を選べます。',
      },
      {
        label: '共有から再訪までの利用状態（任意の運用集計）',
        value:
          '共有調査ごとに、利用者ID、初回閲覧・参加・初回行動・再訪・次回調査作成の初回時刻と、条件追加・投票・次回調査作成の件数をDB内だけに最小保存します。調査依頼文、条件本文、投票コメント、店名、表示名、Taste Profile、共有トークン、通知本文、IP・端末情報は保存しません。運用画面と外部サービスには個人行を渡さず、件数と率だけを扱います。永続アカウントはアカウント画面から集計対象外を選べます。',
      },
      {
        label: '好みプロフィール（任意）',
        value:
          'アカウント画面で「保存」を選んだ場合に限り、好みの傾向値・好きなもの・避けたいもの、属性別の検索用ベクトル（768次元）と、その同意記録を保存します。アレルギー・宗教上の制約・絶対NGなどのhard constraintはこのベクトルに混ぜません。保存・削除の操作記録（監査イベント）も保存します。',
      },
      {
        label: '不正利用防止のための情報',
        value: 'IP アドレスを復元できない形に変換した値（ハッシュ値）',
      },
      {
        label: 'Push通知に関する情報（任意）',
        value:
          '通知の有効/無効、OSの許可状態、グループ更新通知の設定、固定イベント種別、対象調査・通知のUUID、送信・開封時刻を保存します。通知本文には調査依頼文、条件本文、店名、表示名、Taste Profile、GPS、認証情報、共有トークンを保存しません。',
      },
      {
        label: '端末内（ブラウザ）にのみ保存する情報',
        value:
          'ログイン状態を保つための認証情報のほか、好き・避けたい・アレルギー・健康の目的の設定は、お使いのブラウザ（localStorage）に保存します。アレルギーと健康の目的はサーバへ送信しません。GPS座標は現在地検索の実行中だけ Geoapify へ送信し、OISINT の raw_query・共有URL・調査イベント・DB・ログには保存しません。',
      },
    ],
    notes: [
      'お問い合わせ・フィードバックは、お使いのメールアプリを通じて送信される仕組みのため、OISINT のサーバには保存されません。',
    ],
  },
  {
    // 法17条1項（利用目的の特定）・法21条1項（公表）・法32条1項2号（全ての保有個人データの利用目的）
    number: '03',
    title: '利用目的',
    lead: '取得・保存した情報は、次の目的でのみ利用します。',
    bullets: [
      'レストラン調査サービスの提供（調査依頼文の解析、候補店舗の検索、公開情報に基づく根拠（Evidence）の収集・評価、候補のランキング表示）',
      'ログイン状態の維持と、ご本人の調査データの表示・同期',
      '共有調査でのメンバー表示、投票の集計、進行状況の表示',
      '共有閲覧、参加、初回行動、順位変化、再訪、次回調査作成の最小状態から、共有調査の利用導線を個人本文なしで集計し改善すること（永続アカウントはアカウント画面から停止可能）',
      'ご本人が明示的に有効化した場合に限り、調査完了・参加中グループの更新・順位変化を通知し、対象調査へ戻る導線を提供すること',
      'サービスの安定運用のため、既存データから個人を識別しない1日間・7日間・30日間の集計値を作成すること（アカウント画面から停止可能）',
      'ご本人の明示的な opt-in に基づく、店舗候補と選定根拠の個人化（回答・選択行動・来店後 feedback などから作った、集約した好みと属性別ベクトルの利用）。opt-in がない feedback は学習に使いません。',
      '個人を逆引きできないと確認され、最低集計人数と再識別リスク評価を満たした場合に限る、属性別集計ベクトルの利用',
      '過度な連続リクエストの制限などの不正利用防止と、サービスの安定運用',
      'お問い合わせ・フィードバックへの対応',
      '店舗に関する事実の集計（特定の個人を識別しない統計値の作成）',
    ],
    notes: [
      '収集した根拠（Evidence）や集計値を将来のサービス改善へ再利用する範囲は、運営者が確定するまで利用目的に含めていません（確定した場合は本ページを更新してお知らせします）。',
    ],
  },
  {
    // 外部送信先の公表（docs/legal/external-transfer-map.md §5 の下書きを整形）
    number: '04',
    title: '外部送信先',
    lead:
      '調査機能の提供のために、入力された情報の一部を次の外部サービスへ送信します。GPS座標は現在地検索を実行するときだけ Geoapify へ送信し、OISINT の調査・共有データには保存しません。調査依頼の自由文に個人情報（氏名・連絡先・病歴など）を入力された場合は、その内容が下記 1. のとおり送信されます。自由文に個人情報を入力しないでください。',
    details: [
      {
        label: '1. Google Gemini API（Google）',
        value:
          '目的: 調査依頼文の解析、店舗情報の評価、類似調査の検索用データの生成\n送信される情報: 調査依頼の自由文、追加した条件の文章、調査対象店舗の名称・住所、収集した公開 Web ページの本文抜粋',
      },
      {
        label: '2. Serper（検索 API）',
        value:
          '目的: 調査対象店舗の公開情報の検索\n送信される情報: 店舗名・地域名などから機械的に生成した検索語のみ（あなたの入力文そのものは送信しません）',
      },
      {
        label: '3. Geoapify Places API（Geoapify）',
        value:
          '目的: 現在地または地名を中心とした候補店舗の検索\n送信される情報: GPSを許可した場合は検索実行中の緯度・経度、通常の地名検索では地名と検索条件\nOISINT側の扱い: raw_query・共有URL・調査イベント・DB・ログにはGPS座標を保存しません。Geoapify側の保持期間は同社規約・プライバシー通知に従います。契約・通知に基づく具体的な保持条件は公開前に確認します。',
      },
      {
        label: '4. 調査対象の公開 Web サイト',
        value:
          '目的: 店舗情報の根拠（Evidence）収集のための公開ページ取得\n送信される情報: 取得対象ページの URL への機械的なアクセスのみ（あなたの情報は送信しません）',
      },
      {
        label: '5. Supabase（データベース・認証基盤)',
        value:
          '目的: アカウント・調査データ・投票などの保存と同期（本サービスのデータ保存の本体）\n保存される情報: 「02 取得・保存する情報」に列挙した全項目',
      },
      {
        label: '6. Cloudflare（配信・API 中継）',
        value:
          '目的: 本サイトの配信、API リクエストの中継、外部ページ取得の中継\n通過する情報: 通信内容（調査依頼文を含む）・ログイントークン・IP アドレスなどの接続情報',
      },
      {
        label: '7. RevenueCat（購入・entitlement）',
        value:
          '目的: Plus の購入状態と利用権限の確認・同期\n送信される情報: 永続アカウントの UUID を App User ID として使い、購入・entitlement・更新状態を同期します。調査依頼の自由文、氏名、メールアドレス、GPS、アレルギー・健康情報は課金 provider へ送信しません。\nアカウント削除時: RevenueCat customer の削除要求を開始しますが、ストアの定期購入自体は解約しません。',
      },
      {
        label: '8. OneSignal（Push通知配送）',
        value:
          '目的: ご本人が有効化した調査完了・グループ更新・順位変化のPush通知をiOS/Androidへ配送すること\n送信される情報: 永続アカウントのUUID（external_id）、固定イベント種別、対象調査・通知のUUID、固定形式のアプリ内遷移先、およびSDKが配送に必要とするpush token・端末/OS・言語・timezone・利用時刻/回数・IP等。位置情報共有は無効化し、調査依頼文、条件本文、店名、表示名、Taste Profile、GPS、メールアドレス、認証情報、共有トークンは送信しません。\n停止・削除: アカウント画面で停止でき、logout/アカウント切替時は旧通知先を解除します。アカウント削除時はOneSignal Userの削除を先に要求します。',
      },
    ],
    notes: [
      'このほか、ブラウザから直接外部へ送信されるもの（Google アカウントでログインする際の Google への認証リクエスト、店舗の地図リンクを開いた際の Google マップへの遷移、アイコン画像の取得、問い合わせ送信時にお使いのメールアプリへ渡される内容）があります。店舗写真 CDN への自動接続はありません。',
      '端末内に保存する情報と送信先の詳細は、フッターの「外部送信について」のページでも公表しています。',
    ],
  },
  {
    // 保存期間（0017_data_retention.sql / 202608300007_privacy_safe_analytics.sql / docs/operations/data-retention.md の実測）
    number: '05',
    title: '保存期間',
    details: [
      {
        label: '完了した調査',
        value:
          '最終更新から 6 か月で匿名化します（依頼文・タイトルを消去し、整理済みの検索文と検索用の数値データを削除します。条件の文章も同時に匿名化します）。',
      },
      {
        label: '完了しなかった調査（下書き・失敗・中断）',
        value: '最終更新から 3 か月で同様に匿名化します。',
      },
      { label: '投票', value: '調査の匿名化と同時に削除します。' },
      { label: '調査の進行イベント', value: '作成から 30 日で削除します。' },
      {
        label: 'Push通知',
        value:
          'OISINTの通知outbox（固定イベント種別・UUID・送信/開封状態）は作成から30日で削除します。通知設定はアカウント削除まで保持します。OneSignal側のUser/Subscriptionはアカウント削除時にDelete User APIで削除を要求し、provider側の保持は同社の規約・DPA・運用設定に従います。',
      },
      {
        label: '運用メトリクス',
        value:
          'DB内の最新1日・7日・30日集計だけを保持し、ソース行の変更・アカウント削除・集計対象外設定でスナップショットを破棄します。集計値には個別の行や識別子を含めません。',
      },
      {
        label: '共有から再訪までの利用状態',
        value:
          '関連する調査の削除・匿名化、本人のアカウント削除、または集計対象外設定で削除します。完了調査は最終更新から6か月、それ以外は3か月の既存期限を上限とし、外部analyticsへ個人行を送信しません。',
      },
      {
        label: 'アカウント情報・好みプロフィール',
        value:
          '個人属性ベクトルと好みプロフィールは「好みだけ削除」またはアカウント削除で削除します。アカウント削除は匿名セッションからも実行できます。匿名化要件を満たすまで集計ベクトルは公開・ランキングに利用しません。保存・削除の監査イベントは個人識別子を匿名化して保持する場合があります。',
      },
      {
        label: '調査単位の削除',
        value:
          '調査画面の所有者は、確認操作を経てその調査を削除できます。調査本文・条件・投票・進行記録を削除し、共有店舗情報と根拠（Evidence）は共有資産として残します。削除後は元の調査URLへ戻りません。',
      },
      {
        label: '端末内（ブラウザ）の保存情報',
        value: 'お使いのブラウザの設定からこのサイトのサイトデータを削除することで、いつでも消去できます。',
      },
    ],
    notes: [
      '基盤事業者（Supabase / Cloudflare）側のバックアップ・通信ログの保持期間は、現在運営者が確認しています。',
    ],
  },
  {
    // 法32条1項3号（請求手続。手数料の額を含む）・法33〜35条。
    // 文面は docs/legal/appi-request-procedure.md §6 の下書きに基づく。
    number: '06',
    title: '開示・訂正・利用停止等の請求手続',
    lead:
      '運営者は、ご本人からの請求により、保有個人データについて次の対応を行います（個人情報の保護に関する法律 32〜35条）。',
    bullets: [
      '利用目的の通知（法32条2項）',
      '開示（法33条）: 保存されているご本人のデータの写しを、電磁的記録（CSV / JSON 等）の提供でお渡しします。他の方法をご希望の場合はお申し出ください（当該方法が困難な場合は書面の交付となります）。',
      '訂正・追加・削除（法34条）: データの内容が事実でないときに訂正等を行います。表示名・好みプロフィール・投票・調査の条件は、アプリ内の各画面からご自身でも変更できます。',
      '利用停止・消去・第三者提供の停止（法35条）: 法令の要件に該当する場合に、必要な限度で対応します。',
    ],
    details: [
      {
        label: '受付窓口',
        value:
          `${legalProfile.email} 宛に、件名を「開示等請求」としてご連絡ください。アプリ内の「お問い合わせ」画面からも送信できます。`,
      },
      {
        label: '本人確認',
        value:
          `なりすましによる漏えいを防ぐため、${legalProfile.disclosureIdentityVerification} によりご本人であることを確認します。メールアドレス等を登録していない匿名利用の場合、ご本人であることが確認できず、請求に応じられないことがあります。`,
      },
      {
        label: '回答',
        value:
          `請求を受け付けてから${legalProfile.disclosureResponseTime}を目安に、遅滞なく回答します。対応した内容、または対応しない旨の決定は、理由を付してご本人に通知します。`,
      },
      { label: '手数料', value: legalProfile.disclosureFee },
      {
        label: '開示できない場合',
        value:
          'ご本人または第三者の権利利益を害するおそれがある場合、業務の適正な実施に著しい支障を及ぼすおそれがある場合、他の法令に違反することとなる場合（法33条2項各号）は、全部または一部を開示できないことがあります。',
      },
    ],
    notes: [
      '共有調査に参加した記録の一部（他の参加者の画面に表示される参加履歴など）は、調査の記録の完全性のため、削除に代えて匿名化で対応する場合があります。また、外部の Web サイトや Geoapify / OpenStreetMap などの外部サービスに由来する店舗情報・統計化された集計値は、特定の個人を識別しないため削除の対象外です。',
    ],
  },
  {
    // 施行令10条1号（安全管理措置）と、その一環としての外的環境の把握（サーバ所在国）
    number: '07',
    title: '安全管理措置の概要',
    bullets: [
      '通信はすべて暗号化（HTTPS）しています。',
      'データベースは行単位のアクセス制御により、ご本人と調査の参加者だけが自分に関係するデータを読み取れるようにしています。',
      'データの書き込みと外部サービスの呼び出しはサーバ側の処理に限定し、API キーなどの秘密情報をブラウザ側に置いていません。',
      'IP アドレスは復元できない形に変換して保存しています。',
      'アレルギー・健康の目的は検索リクエストへ含めません。GPS座標は現在地検索の実行中だけ Geoapify へ送信し、OISINT の raw_query・共有URL・調査イベント・DB・ログには保存しません。',
      '保存期間（05）を定め、期限が来た調査データを自動的に匿名化・削除しています。',
    ],
    details: [
      {
        label: '外的環境の把握（サーバ所在国）',
        value:
          '個人データの保存には Supabase の設備を、本サイトの配信と通信の中継には Cloudflare の設備を利用しています。契約主体、処理国・リージョン、バックアップ・ログの保持条件は、各事業者との契約・一次証跡を公開前に確認します。',
      },
    ],
    notes: ['このほかの安全管理の詳細は、安全管理に支障を及ぼすおそれがあるため記載していません。'],
  },
  {
    // 施行令10条2号（苦情の申出先）・3号（認定個人情報保護団体）
    number: '08',
    title: '苦情の申出先',
    details: [
      {
        label: '苦情の申出先',
        value: `${legalProfile.email}（06 の受付窓口と同じ窓口とする場合はその旨を記載します）`,
      },
      {
        label: '公的な相談窓口',
        value:
          '上記のほか、個人情報保護委員会（https://www.ppc.go.jp/）の相談窓口も利用できます。',
      },
      {
        label: '認定個人情報保護団体',
        value:
          legalProfile.certifiedPrivacyOrganization,
      },
    ],
  },
];

export default function PrivacyScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 780;

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', 'ja');
      document.title = 'OISINT | プライバシーポリシー';
    }
  }, []);

  return (
    <>
      <Head>
        <title>OISINT | プライバシーポリシー</title>
        <meta name="description" content="OISINTの個人情報の取扱い、利用目的、外部送信、保存期間、請求手続を確認できます。" />
      </Head>
      <View testID="privacy-page" style={styles.wrapper}>
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
            <Text style={styles.eyebrow}>PRIVACY POLICY</Text>
            <Text accessibilityRole="header" style={styles.title}>プライバシーポリシー（個人情報の公表事項）</Text>
            <Text style={styles.copy}>
              OISINTにおける個人情報の取扱いについて、個人情報の保護に関する法律（17条・21条・32条）と同法施行令（10条）が求める公表事項をこのページに記載します。
            </Text>
          </View>

          <View testID="privacy-draft-banner" style={styles.draftBanner}>
            <Text style={styles.draftBannerTitle}>個人情報の取扱いを確認してください</Text>
            <Text style={styles.draftBannerBody}>
              取得項目、利用目的、外部送信先、保存期間、削除方法を利用前に確認してください。重要な変更はこのページで公表します。
            </Text>
          </View>

          <View style={styles.sectionList}>
            {SECTIONS.map((section) => (
              <View key={section.number} style={styles.card}>
                <View style={styles.cardHeading}>
                  <Text style={styles.cardNumber}>{section.number}</Text>
                <Text accessibilityRole="header" style={styles.cardTitle}>{section.title}</Text>
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

            <View style={styles.card}>
              <View style={styles.cardHeading}>
                <Text style={styles.cardNumber}>09</Text>
              <Text accessibilityRole="header" style={styles.cardTitle}>改定について</Text>
              </View>
              <Text style={styles.detailValue}>
                本ポリシーを改定する場合は、このページで公表します。重要な変更を行う場合は、アプリ内でわかりやすくお知らせします。
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
  draftBanner: {
    gap: 4,
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  draftBannerTitle: {
    color: colors.warning,
    fontSize: 13,
    fontWeight: '800',
  },
  draftBannerBody: {
    color: colors.text,
    fontSize: 11,
    lineHeight: 18,
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
  cardLead: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 20,
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
