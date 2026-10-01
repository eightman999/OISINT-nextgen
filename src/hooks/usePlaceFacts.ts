import { useEffect, useState } from 'react';

import { getPlaceFacts } from '@/lib/api';
import type { PlaceFact } from '@/types';

// 対象 place の place_facts（§44.5 集約ビュー）を読み取る。
// place_facts は補助情報のため、取得失敗・0 件時は空配列のままにして
// 既存の Evidence ベース表示のみへフォールバックする（issue #333）。
export function usePlaceFacts(placeId: string | undefined): PlaceFact[] {
  const [facts, setFacts] = useState<PlaceFact[]>([]);

  useEffect(() => {
    let mounted = true;

    // effect 本体で同期 setState しない（useInvestigation.ts と同じ microtask 境界パターン）
    const load = async () => {
      await Promise.resolve();
      if (!mounted) return;

      setFacts([]);
      if (!placeId) return;

      try {
        const rows = await getPlaceFacts(placeId);
        if (mounted) setFacts(rows);
      } catch {
        // 失敗は握りつぶして Evidence 表示のみに任せる（エラー詳細を UI へ漏らさない）
      }
    };

    void load();

    return () => {
      mounted = false;
    };
  }, [placeId]);

  return facts;
}
