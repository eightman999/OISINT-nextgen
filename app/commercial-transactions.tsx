import Head from 'expo-router/head';
import { useEffect } from 'react';

import { LegalDocumentPage, type LegalDocumentSection } from '@/components/LegalDocumentPage';
import { legalProfile } from '@/lib/legalProfile';

const SECTIONS: LegalDocumentSection[] = [
  {
    number: '01',
    title: '販売事業者・役務提供事業者',
    details: [
      { label: '氏名または名称', value: legalProfile.businessName },
      { label: '屋号（開業届記載）', value: legalProfile.tradeName },
      { label: '住所', value: legalProfile.address },
      { label: '電話番号', value: legalProfile.phone },
      { label: '代表者または通信販売の業務責任者', value: legalProfile.representativeName },
      { label: 'メールアドレス', value: legalProfile.email },
    ],
    notes: ['個人事業者は本名または登記上の商号を基礎情報として表示し、開業届に記載した屋号は併記します。サービス名だけの表示にはしません。'],
  },
  {
    number: '02',
    title: '販売価格・役務の対価',
    details: [
      { label: '現在の提供状況', value: 'RevenueCat とストアの購入・entitlement 連携は実装しています。購入可能にする場合は、価格、提供地域、契約期間、更新などの条件を購入画面に表示します。' },
      { label: '購入可能にする場合', value: '申込前に、各購入画面で税込価格、契約期間、利用できる機能、更新条件、提供地域および必要な場合の総額を表示します。' },
    ],
  },
  {
    number: '03',
    title: '対価以外に必要となる費用',
    bullets: [
      '本ページは価格や支払額を固定表示しません。購入を有効化する場合は、実際の store / RevenueCat の商品表示を申込前に確認できるようにします。',
      '通信に必要なインターネット接続料金、通信機器、電気通信事業者の料金は利用者の負担です。',
      '有料化する場合に決済手数料、振込手数料、追加オプション料金などが発生する場合は、金額または算定方法を申込前に表示します。',
    ],
  },
  {
    number: '04',
    title: '支払方法・支払時期',
    details: [
      { label: '支払方法', value: '購入を有効化する場合は、RevenueCat を介した Apple App Store、Google Play または対応する Web Billing の実際の方法を購入画面に表示します。' },
      { label: '支払時期', value: '申込時、利用期間開始時、更新時など、実際の課金時期を購入画面に表示します。現時点で固定の支払時期は確定していません。' },
    ],
  },
  {
    number: '05',
    title: '役務の提供時期',
    details: [
      { label: '現在の提供状況', value: '無料の調査機能は、利用可能な状態である限り、申込操作後に提供します。' },
      { label: '有料化した場合', value: '利用開始日、機能の開放時期、予約代行等の提供時期を各申込ページに表示します。' },
    ],
  },
  {
    number: '06',
    title: 'キャンセル・解約・返品',
    details: [
      { label: '無料利用', value: '利用者は、アカウントや端末内に保存した情報を、サービス所定の方法またはブラウザの設定から削除できます。' },
      { label: '有料化した場合', value: 'キャンセル、解約、更新停止、返金の可否、申出期限、返金時の振込手数料負担などを、申込前に商品・役務ごとに表示します。' },
      { label: 'デジタル役務', value: '提供開始後のキャンセル・返金条件を、消費者にとって見やすい場所に表示します。法令上認められる利用者の解除権を制限するものではありません。' },
    ],
  },
  {
    number: '07',
    title: '申込み期間・利用条件',
    bullets: [
      '期間限定の申込み、定員、提供地域、対象端末、推奨ブラウザなどの条件を定める場合は、各申込ページに表示します。',
      'サービスの利用には、利用規約、プライバシーポリシー、外部送信についての内容が適用されます。',
    ],
  },
  {
    number: '08',
    title: 'お問い合わせ窓口',
    details: [
      { label: '窓口', value: `アプリ内の「お問い合わせ」画面 / ${legalProfile.email}` },
      { label: '受付時間', value: legalProfile.contactHours },
    ],
  },
];

export default function CommercialTransactionsScreen() {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', 'ja');
      document.title = 'OISINT | 特定商取引法に基づく表示';
    }
  }, []);

  return (
    <>
      <Head>
        <title>OISINT | 特定商取引法に基づく表示</title>
        <meta name="description" content="OISINTの有料サービスに関する特定商取引法上の表示を確認できます。" />
      </Head>
      <LegalDocumentPage
        testID="commercial-transactions-page"
        eyebrow="SPECIFIED COMMERCIAL TRANSACTIONS"
        title="特定商取引法に基づく表示"
        copy="通信販売で有料の商品・役務を提供する場合に表示する項目を、消費者庁の通信販売広告の項目に沿って整理しています。"
        draftTitle="購入前に確認する事項"
        draftBody="購入を有効化する場合は、購入画面に表示される価格、契約期間、更新、解約・返金条件、提供地域を申込前に確認してください。ストアの購入・解約・返金手続には各ストアの条件も適用されます。"
        sections={SECTIONS}
        updatedAt="最終更新日: 2026年8月18日"
      />
    </>
  );
}
