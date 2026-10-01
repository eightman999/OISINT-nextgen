import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { getInvestigationEvents } from '@/lib/api';
import { colors, radius } from '@/theme';
import type { Investigation, InvestigationEvent } from '@/types';

interface RecallPreferenceNoteProps {
  investigation: Investigation;
}

// recall_preference の metadata.kinds（run-investigation/index.ts:427-441）。
// 条件種別の分布を「静か」のような user-facing な粒度へ落とすための表記。
const KIND_PRIORITY_LABELS: Record<string, Record<string, string>> = {
  quiet: { must: '静か', should: '静かさ', nice: '落ち着いた雰囲気' },
  budget: { must: '予算', should: '予算', nice: 'コスト感' },
  location: { must: '場所', should: '場所', nice: '立地' },
  food: { must: '料理', should: '料理', nice: '食事内容' },
};

interface RecallKind {
  kind?: unknown;
  priority?: unknown;
  count?: unknown;
}

interface RecallPlace {
  name?: unknown;
  avgVote?: unknown;
}

export function recallPreferenceView(event: InvestigationEvent): {
  placeNames: string[];
  kindLabels: string[];
} | null {
  if (event.eventType !== 'recall_preference') return null;

  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  const places = Array.isArray(metadata['places']) ? (metadata['places'] as RecallPlace[]) : [];
  const kinds = Array.isArray(metadata['kinds']) ? (metadata['kinds'] as RecallKind[]) : [];

  // 高評価の証跡がある店（avgVote > 0）だけを並べる。集計値しか入らない設計（§33）。
  const placeNames = places
    .filter((place) => typeof place.name === 'string' && typeof place.avgVote === 'number' && place.avgVote > 0)
    .map((place) => place.name as string)
    .slice(0, 3);

  const seen = new Set<string>();
  const kindLabels = kinds
    .map((kind) => kindLabel(kind))
    .filter((label): label is string => {
      if (!label || seen.has(label)) return false;
      seen.add(label);
      return true;
    })
    .slice(0, 3);

  if (placeNames.length === 0 && kindLabels.length === 0) return null;
  return { placeNames, kindLabels };
}

function kindLabel(kind: RecallKind): string | null {
  if (typeof kind.kind !== 'string' || typeof kind.count !== 'number' || kind.count <= 0) {
    return null;
  }
  const priority = typeof kind.priority === 'string' ? kind.priority : '';
  const labels = KIND_PRIORITY_LABELS[kind.kind];
  return labels?.[priority] ?? labels?.['should'] ?? kind.kind;
}

// 「前回このメンバーは…」過去嗜好表示（issue #111 / §3 P1, §16.1）。
// recall_preference イベントの集計値だけを読む。他人の query 文面は backend が
// イベントに含めない設計（§33）のため、この画面も集計表示に留める。
export function RecallPreferenceNote({ investigation }: RecallPreferenceNoteProps) {
  const [view, setView] = useState<{ placeNames: string[]; kindLabels: string[] } | null>(null);

  useEffect(() => {
    let mounted = true;
    getInvestigationEvents(investigation.id)
      .then((events) => {
        if (!mounted) return;
        // backend は最新 1 件を保持するが、遅延追記に備えて新しい順から探す
        for (const event of [...events].reverse()) {
          const next = recallPreferenceView(event);
          if (next) {
            setView(next);
            return;
          }
        }
        setView(null);
      })
      .catch(() => {
        // 補助表示のため取得失敗は無表示（調査本体は壊さない）
      });
    return () => {
      mounted = false;
    };
  }, [investigation.id]);

  if (!view) return null;

  const parts: string[] = [];
  if (view.kindLabels.length > 0) {
    parts.push(`過去の類似調査では「${view.kindLabels.join('・')}」が重視されていました`);
  }
  if (view.placeNames.length > 0) {
    parts.push(`${view.placeNames.join('・')} などが高評価でした`);
  }

  return (
    <View
      testID="recall-preference-note"
      accessibilityLiveRegion="polite"
      style={styles.container}
    >
      <Text style={styles.title}>過去の好みの手がかり</Text>
      <Text style={styles.message}>{parts.join('。')}</Text>
      <Text style={styles.footnote}>
        同じメンバー構成の過去の調査から、集計した傾向だけを表示しています。
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 5,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
  },
  message: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  footnote: {
    fontSize: 10,
    lineHeight: 15,
    color: colors.textTertiary,
  },
});
