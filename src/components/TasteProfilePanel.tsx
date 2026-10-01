import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useState } from 'react';

import { colors, radius } from '@/theme';
import type { TasteHealthGoal, TasteProfile } from '@/types';

interface TasteProfilePanelProps {
  value: TasteProfile;
  onChange: (profile: TasteProfile) => void;
  /** 行ったお店からの取り込み導線（#323）。認証状態で文言を分ける。 */
  isAuthenticated?: boolean;
  onImportFromMaps?: () => void;
}

const LIKE_OPTIONS = ['肉', '寿司', 'ラーメン', 'カフェ', '野菜'];
const AVOID_OPTIONS = ['辛いもの', '混雑', '騒がしい', '高価格'];
const ALLERGY_OPTIONS = ['小麦', '乳製品', '卵', 'ナッツ'];
const HEALTH_OPTIONS: { value: TasteHealthGoal; label: string }[] = [
  { value: 'none', label: '指定なし' },
  { value: 'diet', label: 'ダイエット' },
  { value: 'high_protein', label: '高たんぱく' },
];

export function TasteProfilePanel({ value, onChange, isAuthenticated, onImportFromMaps }: TasteProfilePanelProps) {
  const [open, setOpen] = useState(false);
  const selectedCount = value.likes.length + value.avoid.length + (value.allergies ? 1 : 0);

  const toggleListValue = (key: 'likes' | 'avoid', option: string) => {
    const current = value[key];
    onChange({
      ...value,
      [key]: current.includes(option)
        ? current.filter((item) => item !== option)
        : [...current, option],
    });
  };

  const toggleAllergy = (option: string) => {
    const existing = value.allergies
      .split('、')
      .map((item) => item.trim())
      .filter(Boolean);
    const next = existing.includes(option)
      ? existing.filter((item) => item !== option)
      : [...existing, option];
    onChange({ ...value, allergies: next.join('、') });
  };

  return (
    <View style={styles.container}>
      <Pressable
        testID="taste-toggle"
        accessibilityRole="button"
        accessibilityLabel="好みの条件を設定"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={styles.header}
      >
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>02 / あなたの好み</Text>
          <Text style={styles.title}>好みを30秒で設定する</Text>
          <Text style={styles.description}>
            好き・避けたいは検索条件に、アレルギー・健康目的は候補確認の補助情報として使います。
          </Text>
          <Text style={styles.privacyNote}>
            アレルギー・健康目的は共有調査の検索文に含めず、この端末の補助情報として扱います。
          </Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.countText}>{selectedCount > 0 ? `${selectedCount}件` : '任意'}</Text>
          <Text style={styles.chevron}>{open ? '⌃' : '⌄'}</Text>
        </View>
      </Pressable>

      {open && (
        <View style={styles.body}>
          <TasteRow label="好きなもの" options={LIKE_OPTIONS} selected={value.likes} onPress={(option) => toggleListValue('likes', option)} testPrefix="taste-like" />
          <TasteRow label="避けたいもの" options={AVOID_OPTIONS} selected={value.avoid} onPress={(option) => toggleListValue('avoid', option)} testPrefix="taste-avoid" />

          <View style={styles.group}>
            <Text style={styles.groupLabel}>アレルギー・食事制限</Text>
            <View style={styles.chipRow}>
              {ALLERGY_OPTIONS.map((option) => {
                const active = value.allergies.split('、').includes(option);
                return (
                  <Pressable
                    key={option}
                    testID={`taste-allergy-${option}`}
                    accessibilityRole="checkbox"
                    accessibilityLabel={`アレルギー ${option}`}
                    accessibilityState={{ checked: active }}
                    aria-checked={active}
                    onPress={() => toggleAllergy(option)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option}</Text>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              testID="taste-allergy-input"
              accessibilityLabel="その他のアレルギーや食事制限"
              accessibilityHint="補足があれば入力してください"
              value={value.allergies}
              onChangeText={(allergies) => onChange({ ...value, allergies })}
              placeholder="その他・補足（例：甲殻類）"
              placeholderTextColor={colors.textTertiary}
              style={styles.textInput}
            />
            <Text style={styles.safetyNote}>アレルギーは候補の確認条件です。最終的には店舗へ直接確認してください。</Text>
          </View>

          <View style={styles.group}>
            <Text style={styles.groupLabel}>健康目的</Text>
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel="健康目的"
              style={styles.chipRow}
            >
              {HEALTH_OPTIONS.map((option) => {
                const active = value.healthGoal === option.value;
                return (
                  <Pressable
                    key={option.value}
                    testID={`taste-health-${option.value}`}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{ checked: active }}
                    aria-checked={active}
                    onPress={() => onChange({ ...value, healthGoal: option.value })}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.futureNote}>Appleヘルス / Google Health Connectとの連携はアプリ版で対応予定です。Web版では接続しません。</Text>
          </View>

          {onImportFromMaps ? (
            <View testID="taste-import-route" style={styles.importRoute}>
              <View style={styles.importRouteCopy}>
                <Text style={styles.importRouteTitle}>行ったお店から好みを作る</Text>
                <Text style={styles.importRouteText}>
                  Googleマップの保存リストを取り込むと、行った店の傾向から好みタグを提案します。解析はこの端末内で完結し、反映前に内容を確認できます。
                </Text>
              </View>
              <Pressable
                testID="taste-import-open"
                accessibilityRole="button"
                accessibilityLabel={
                  isAuthenticated
                    ? 'Googleマップの履歴から取り込む'
                    : 'ログインしてGoogleマップの履歴から取り込む'
                }
                onPress={onImportFromMaps}
                style={styles.importRouteButton}
              >
                <Text style={styles.importRouteButtonText}>
                  {isAuthenticated ? 'Googleマップの履歴から取り込む' : 'ログインして取り込む'}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

function TasteRow({
  label,
  options,
  selected,
  onPress,
  testPrefix,
}: {
  label: string;
  options: string[];
  selected: string[];
  onPress: (option: string) => void;
  testPrefix: string;
}) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((option) => {
          const active = selected.includes(option);
          return (
            <Pressable
              key={option}
              testID={`${testPrefix}-${option}`}
              accessibilityRole="checkbox"
              accessibilityLabel={`${label}: ${option}`}
              accessibilityState={{ checked: active }}
              aria-checked={active}
              onPress={() => onPress(option)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{option}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  headerCopy: {
    flex: 1,
    gap: 3,
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: colors.orange,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  description: {
    fontSize: 11,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  privacyNote: {
    marginTop: 3,
    fontSize: 10,
    lineHeight: 15,
    color: colors.textTertiary,
  },
  headerRight: {
    alignItems: 'center',
    gap: 1,
  },
  countText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.orange,
  },
  chevron: {
    fontSize: 20,
    color: colors.textSecondary,
    lineHeight: 22,
  },
  body: {
    gap: 16,
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  group: {
    gap: 7,
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  chip: {
    minHeight: 30,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.chipBg,
    justifyContent: 'center',
  },
  chipActive: {
    borderColor: colors.orange,
    backgroundColor: colors.activeBg,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: colors.orange,
    fontWeight: '700',
  },
  textInput: {
    minHeight: 38,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 13,
  },
  safetyNote: {
    fontSize: 10,
    lineHeight: 15,
    color: colors.warning,
  },
  futureNote: {
    fontSize: 10,
    lineHeight: 15,
    color: colors.textTertiary,
  },
  importRoute: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radius.sm,
    backgroundColor: colors.importSoft,
  },
  importRouteCopy: {
    flex: 1,
    minWidth: 220,
    gap: 3,
  },
  importRouteTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text,
  },
  importRouteText: {
    fontSize: 10,
    lineHeight: 15,
    color: colors.textSecondary,
  },
  importRouteButton: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  importRouteButtonText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.info,
  },
});
