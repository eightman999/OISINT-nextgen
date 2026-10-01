// データ提供元・ライセンスの表示内容（#559 / #473 / spec.md §27）。
//
// owner 決定（2026-08-21）: Overture のライセンス表示は共通フッターへ列挙せず、
// 設定とフッターから開ける「データ提供元・ライセンス」ページ 1 枚に集約する。
// 共通フッターに出すのは、そのページへのリンクだけ。
//
// 例外は地図表示のみ。地図の上には MAP_CREDIT_LINE を重ねる（下記）。
//
// 表示義務の根拠は docs/legal/provider-data-rights.md（#473 rights matrix）が正本。

// **いま配信している** Overture Places の release。
// promote 済みで discovery index に入っている実データの release と一致させる
// (正本: benchmark.promotion_runs.release)。ここを実データより新しくすると、
// 取り込んでいない release を利用者へ表示することになり虚偽表示になる。
//
// ingest 側の DEFAULT_RELEASE (tools/place-benchmark/placebench/ingest_overture.py) とは
// 別物なので同期させない。あちらは「次回取得する release」を指す。
// Overture の更新は release ごとに即追従せず月 1 回程度の定期更新とする方針
// (owner 決定 2026-08-21)。定期更新で promote が終わった時点でこの値を更新する。
export const OVERTURE_RELEASE = '2026-07-22.0';

export interface DataSourceLicense {
  id: string;
  label: string;
  url: string;
}

// Overture Places dataset に含まれるライセンス。
// release ごとに寄与元が変わりうるため、ingest 側で sources[].license を毎回集計し、
// ここに無いライセンスが混ざったら取り込みを止める（fail-closed）。
export const OVERTURE_LICENSES: DataSourceLicense[] = [
  {
    id: 'cdla-permissive-2-0',
    label: 'CDLA Permissive 2.0',
    url: 'https://cdla.dev/permissive-2-0/',
  },
  {
    id: 'apache-2-0',
    label: 'Apache License 2.0',
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
  },
  {
    id: 'cc0-1-0',
    label: 'CC0 1.0',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  },
];

// Foursquare 由来データの著作権表示。Overture が要求する原文をそのまま出す。
// 意訳・要約しない（表示義務の文言を変えない）。
export const FOURSQUARE_NOTICE = [
  'Copyright 2024 Foursquare Labs, Inc. All rights reserved.',
  'Foursquare data was transformed to the Overture schema.',
];

export const OVERTURE_SOURCE_LABEL = 'Overture Maps Foundation';
export const OVERTURE_SOURCE_URL = 'https://overturemaps.org/';

// 地図の上にだけ重ねるクレジット（owner 決定 2026-08-21）。
// 共通フッターには出さない。地図を描画する画面ができたら必ずこの 1 行を重ねる。
// 現時点の OISINT はアプリ内に地図を描画せず Google マップへ外部リンクするだけなので、
// この行を描画している画面はまだ無い。
export const MAP_CREDIT_LINE = '© OpenStreetMap contributors, Overture Maps Foundation';

export const DATA_SOURCES_PATH = '/data-sources';
