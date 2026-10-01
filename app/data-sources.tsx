// データ提供元・ライセンス（#559 / #473 / spec.md §27）。
//
// owner 決定（2026-08-21）: Overture のライセンス表示は共通フッターへ列挙せず、
// 設定とフッターから開けるこのページ 1 枚に集約する。
// 共通フッターに出すのはこのページへのリンクだけで、地図の上にだけ
// MAP_CREDIT_LINE を重ねる。
//
// 表示義務の文言（Foursquare の著作権表示など）は原文をそのまま出す。意訳・要約しない。
import { LegalDocumentPage, type LegalDocumentSection } from '@/components/LegalDocumentPage';
import {
  FOURSQUARE_NOTICE,
  MAP_CREDIT_LINE,
  OVERTURE_LICENSES,
  OVERTURE_RELEASE,
  OVERTURE_SOURCE_LABEL,
} from '@/lib/dataSources';

const SECTIONS: LegalDocumentSection[] = [
  {
    number: '01',
    title: 'Data source',
    details: [
      { label: 'Data source', value: OVERTURE_SOURCE_LABEL },
      { label: 'Overture Places release', value: OVERTURE_RELEASE },
    ],
    notes: [
      '候補店舗の名称・住所・座標は、この Overture Places のリリースを定期取得した自前のインデックスから引いています。表示中のリリースと実際に取り込んだリリースは同じ値に揃えています。',
    ],
  },
  {
    number: '02',
    title: 'Licenses',
    lead: 'The Overture Places dataset includes data made available under:',
    bullets: OVERTURE_LICENSES.map((license) => license.label),
    notes: [
      '取り込みのたびにレコード単位のライセンスを集計し、上記に該当しないライセンスが混ざっていた場合は取り込みを停止します。',
    ],
  },
  {
    number: '03',
    title: 'Foursquare-derived data',
    bullets: FOURSQUARE_NOTICE,
  },
  {
    number: '04',
    title: '地図上の表示',
    lead: '地図を表示する画面では、地図の上に次のクレジットを重ねて表示します。',
    bullets: [MAP_CREDIT_LINE],
    notes: [
      'OISINT は現在アプリ内に地図を描画せず、道順や場所の確認は外部の地図サービスへのリンクで行っています。地図を描画する画面を追加した時点で、この行を地図上に表示します。',
    ],
  },
];

export default function DataSourcesScreen() {
  return (
    <LegalDocumentPage
      testID="data-sources-page"
      eyebrow="DATA SOURCES & LICENSES"
      title="データ提供元・ライセンス"
      copy="OISINT が候補店舗の基礎情報として利用しているデータの提供元と、そのライセンス表示をまとめています。"
      draftTitle="この表示はデータ提供元の規約に基づく義務表示です"
      draftBody="ライセンス名と著作権表示は提供元が求める原文のまま掲載しています。表示内容の変更が必要な場合は、先に提供元の規約を確認してください。"
      sections={SECTIONS}
      updatedAt={`最終更新日: 2026年8月21日 / Overture Places release ${OVERTURE_RELEASE}`}
    />
  );
}
