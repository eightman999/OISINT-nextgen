import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';
import type { Requirement } from '@/types';

interface RequirementListProps {
  requirements: Requirement[];
  onAddPress?: () => void;
  onRemovePress?: (requirement: Requirement) => void;
  removingRequirementId?: string | null;
}

export function RequirementList({
  requirements,
  onAddPress,
  onRemovePress,
  removingRequirementId,
}: RequirementListProps) {
  return (
    <View testID="inv-requirements" style={styles.container}>
      <Text style={styles.heading}>条件</Text>
      <View style={styles.chipRow}>
        {requirements.map((req) => (
          <View key={req.id} style={styles.chip}>
            <Text style={styles.chipText}>{req.normalizedText}</Text>
            {onRemovePress ? (
              <Pressable
                testID={`inv-requirement-remove-${req.id}`}
                accessibilityRole="button"
                accessibilityLabel={`条件「${req.normalizedText}」を削除`}
                accessibilityHint="この条件を削除して候補を再評価します"
                accessibilityState={{
                  disabled: !!removingRequirementId,
                  busy: removingRequirementId === req.id,
                }}
                disabled={!!removingRequirementId}
                hitSlop={8}
                onPress={() => onRemovePress(req)}
                style={[
                  styles.removeButton,
                  removingRequirementId === req.id && styles.removeButtonBusy,
                ]}
              >
                <Text style={styles.removeButtonText}>×</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        {onAddPress && (
          <Pressable
            testID="inv-requirement-open"
            accessibilityRole="button"
            accessibilityLabel="条件を追加"
            onPress={onAddPress}
            style={styles.addChip}
          >
            <Text style={styles.addChipText}>＋ 条件を追加</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  heading: {
    fontSize: 16,
    fontWeight: 'bold',
    color: colors.text,
    marginBottom: 2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  chip: {
    minHeight: 28,
    paddingVertical: 5,
    paddingLeft: 12,
    paddingRight: 5,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.pill,
    backgroundColor: colors.chipBg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    justifyContent: 'center',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  removeButton: {
    minWidth: 28,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  removeButtonBusy: {
    opacity: 0.45,
  },
  removeButtonText: {
    color: colors.textTertiary,
    fontSize: 16,
    lineHeight: 18,
    fontWeight: '700',
  },
  addChip: {
    minHeight: 28,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    justifyContent: 'center',
  },
  addChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.orange,
  },
});
