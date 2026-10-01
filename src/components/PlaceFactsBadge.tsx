import { StyleSheet, Text, View } from 'react-native';

import { percent } from '@/lib/format';
import { factKeyLabel, formatFactValue, selectDisplayFacts } from '@/lib/placeFacts';
import { colors, radius } from '@/theme';
import type { PlaceFact } from '@/types';

interface PlaceFactsBadgeProps {
  facts: PlaceFact[];
}

// 候補詳細の Evidence 表示に出す place_facts（§44.5 集約ビュー）の要約（issue #333）。
// 表示できる fact が 1 つも無ければ何も描画せず、既存の Evidence ベース表示のみ残す（フォールバック）。
export function PlaceFactsBadge({ facts }: PlaceFactsBadgeProps) {
  const displayFacts = selectDisplayFacts(facts);
  if (displayFacts.length === 0) return null;

  return (
    <View testID="place-facts" style={styles.container}>
      <Text style={styles.title}>蓄積済みの調査結果（複数調査の集約）</Text>
      {displayFacts.map((fact) => (
        <View
          key={fact.key}
          testID={`place-fact-${fact.key}`}
          style={[styles.row, fact.conflicting && styles.conflictRow]}
        >
          <Text style={styles.factText}>
            {factKeyLabel(fact.key)}: {formatFactValue(fact.key, fact.value)}
          </Text>
          <Text style={styles.metaText}>
            確度 {percent(fact.confidence)} ・ 根拠{fact.evidenceCount}件 ・ 最終確認{' '}
            {fact.lastVerifiedAt.slice(0, 10)}
          </Text>
          {fact.conflicting ? (
            <Text
              testID={`place-fact-conflict-${fact.key}`}
              accessibilityRole="alert"
              style={styles.conflictText}
            >
              ⚠ 複数の調査で矛盾があります。出典を確認してください。
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
    padding: 10,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSoft,
  },
  title: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  row: {
    gap: 2,
    padding: 8,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  conflictRow: {
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  factText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  metaText: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.textTertiary,
  },
  conflictText: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    color: colors.warning,
  },
});
