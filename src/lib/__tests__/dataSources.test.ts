import { describe, expect, it } from 'vitest';

import {
  FOURSQUARE_NOTICE,
  MAP_CREDIT_LINE,
  OVERTURE_LICENSES,
  OVERTURE_RELEASE,
  OVERTURE_SOURCE_LABEL,
} from '@/lib/dataSources';

// owner 決定 2026-08-21（#559）で確定した表示内容の回帰テスト。
// 表示義務の文言は提供元が求める原文なので、要約・意訳で書き換わったら落とす。
describe('dataSources', () => {
  it('data source と、いま配信している release を明示する', () => {
    expect(OVERTURE_SOURCE_LABEL).toBe('Overture Maps Foundation');
    // 表示する release は promote 済みの実データに合わせる。ingest の
    // DEFAULT_RELEASE (次回取得対象) とは別物なので同期させない (#559)
    expect(OVERTURE_RELEASE).toBe('2026-07-22.0');
  });

  it('Overture Places dataset のライセンス 3 件を原文の表記で列挙する', () => {
    expect(OVERTURE_LICENSES.map((license) => license.label)).toEqual([
      'CDLA Permissive 2.0',
      'Apache License 2.0',
      'CC0 1.0',
    ]);
    for (const license of OVERTURE_LICENSES) {
      expect(license.url.startsWith('https://')).toBe(true);
    }
  });

  it('Foursquare の著作権表示を原文のまま出す', () => {
    expect(FOURSQUARE_NOTICE).toEqual([
      'Copyright 2024 Foursquare Labs, Inc. All rights reserved.',
      'Foursquare data was transformed to the Overture schema.',
    ]);
  });

  it('地図に重ねるクレジットは 1 行に固定する', () => {
    // 共通フッターではなく地図の上にだけ出す行（#559 owner 決定）
    expect(MAP_CREDIT_LINE).toBe('© OpenStreetMap contributors, Overture Maps Foundation');
  });
});
