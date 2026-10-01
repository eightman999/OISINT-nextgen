import { describe, expect, it } from 'vitest';

import { attributionsFor, attributionsForPolicies, placeProviderId } from '@/lib/attribution';

// provider 切替時にクレジット表記が取り残されないことの回帰テスト（#530 / #297）。
// 表示義務の根拠は docs/legal/provider-data-rights.md
describe('attribution', () => {
  it('未設定・未知の値も現行 Geoapify のクレジットへ倒す', () => {
    for (const raw of [undefined, null, '', 'unknown-provider']) {
      expect(placeProviderId(raw)).toBe('geoapify');
      expect(attributionsFor(raw).map((a) => a.id)).toEqual(['openstreetmap', 'geoapify']);
    }
  });

  it('geoapify は OpenStreetMap と Geoapify の 2 件を出す（Free プランは両方必須）', () => {
    const list = attributionsFor('geoapify');

    expect(list.map((a) => a.label)).toEqual(['© OpenStreetMap contributors', 'Powered by Geoapify']);
    expect(list[0].url).toBe('https://www.openstreetmap.org/copyright');
    expect(list[1].url).toBe('https://www.geoapify.com/');
  });

  it('attribution_policy は重複を除き、未知の値を無視する', () => {
    expect(attributionsForPolicies(['osm_odbl_attribution', 'osm_odbl_attribution', 'unknown']).map((a) => a.id))
      .toEqual(['openstreetmap', 'geoapify']);
    expect(attributionsForPolicies(['hotpepper_credit_required', 'osm_odbl_attribution']).map((a) => a.id))
      .toEqual(['openstreetmap', 'geoapify']);
  });

  // owner 決定 2026-08-21 (#559): Overture の表示義務は「データ提供元・ライセンス」
  // ページ 1 枚で果たす。共通フッターへライセンスを列挙しない。
  it('overture は共通フッターにクレジットを出さない（#559）', () => {
    expect(placeProviderId('overture')).toBe('overture');
    expect(attributionsFor('overture')).toEqual([]);
    expect(attributionsForPolicies(['overture_cdla_attribution'])).toEqual([]);
  });

  it('Overture と Geoapify が混在しても Geoapify の表記義務だけがフッターに残る', () => {
    expect(
      attributionsForPolicies(['overture_cdla_attribution', 'osm_odbl_attribution']).map((a) => a.id),
    ).toEqual(['openstreetmap', 'geoapify']);
  });

  it('N02の加工データ帰属表記を返す', () => {
    const list = attributionsForPolicies(['mlit_n02_attribution']);
    expect(list.map((a) => a.id)).toEqual(['mlit-n02']);
    expect(list[0].label).toContain('国土交通省');
  });

  it('どの provider でもクレジットが空にならない（表示義務違反の防止）', () => {
    for (const raw of [undefined, 'geoapify', 'なにか']) {
      expect(attributionsFor(raw).length).toBeGreaterThan(0);
    }
  });
});
