import type { PlaceFact } from '@/types';

// place_facts のダミーデータ（issue #333 / §44.5）。mock の place（p-a / p-b / p-c）に対応する。
// - opening_hours: conflicting=true。mock.ts の contradictions（e-a-1 と e-a-2 の食い違い）と整合し、
//   矛盾キーの警告表示を mock で確認できる
// - card_accepted: confidence 高（複数調査で裏取り済みの例）
// - reservation: confidence 低。現在の Evidence には無いキー＝複数調査を跨いだ集積の例
// - noise_level: evidence_count 1 の「薄い」fact（表示されず Evidence 表示へフォールバックする例）
// - p-b / p-c: place_facts 無し（候補単位のフォールバック確認用）
export const mockPlaceFacts: Record<string, PlaceFact[]> = {
  'p-a': [
    {
      placeId: 'p-a',
      key: 'opening_hours',
      value: '17:00-23:00',
      confidence: 0.55,
      evidenceCount: 2,
      conflicting: true,
      lastVerifiedAt: '2026-08-14T10:00:00Z',
    },
    {
      placeId: 'p-a',
      key: 'card_accepted',
      value: true,
      confidence: 1,
      evidenceCount: 3,
      conflicting: false,
      lastVerifiedAt: '2026-08-14T10:00:00Z',
    },
    {
      placeId: 'p-a',
      key: 'reservation',
      value: true,
      confidence: 0.4,
      evidenceCount: 2,
      conflicting: false,
      lastVerifiedAt: '2026-08-01T09:00:00Z',
    },
    {
      placeId: 'p-a',
      key: 'noise_level',
      value: { value: 'quiet', count: 1, share: 1 },
      confidence: 0.3,
      evidenceCount: 1,
      conflicting: false,
      lastVerifiedAt: '2026-08-10T09:00:00Z',
    },
  ],
};
