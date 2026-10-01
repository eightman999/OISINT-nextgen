import { Pressable, StyleSheet, Text, View } from 'react-native';

import { voteSymbol } from '@/lib/format';
import { colors, radius } from '@/theme';
import type { VoteValue } from '@/types';

interface VoteButtonsProps {
  /**
   * 自分の現在の投票。undefined = 未投票（votes に行が無い状態）で、
   * どのボタンも選択状態にしない。value 0（どちらでも）は明示投票として
   * 選択状態を付ける（#346。CandidateCard の未投票行と区別を揃える）。
   */
  value?: VoteValue;
  onChange?: (value: VoteValue) => void;
}

export function VoteButtons({ value, onChange }: VoteButtonsProps) {
  const options: { value: VoteValue; label: string }[] = [
    { value: 1, label: '行きたい' },
    { value: 0, label: 'どちらでも' },
    { value: -1, label: '行きたくない' },
  ];

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="この候補への投票"
      style={styles.container}
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: active }}
            aria-checked={active}
            onPress={() => onChange?.(option.value)}
            style={[styles.button, active && styles.activeButton]}
          >
            <Text style={[styles.symbol, active && styles.activeText]}>
              {voteSymbol(option.value)}
            </Text>
            <Text style={[styles.label, active && styles.activeText]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.chipBg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  activeButton: {
    backgroundColor: colors.orange,
    borderColor: colors.orange,
  },
  symbol: {
    fontSize: 20,
  },
  label: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  activeText: {
    color: colors.surface,
  },
});
