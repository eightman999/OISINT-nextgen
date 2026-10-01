import { StyleSheet, Text, View } from 'react-native';

import { statusLabel, statusOrder, statusSymbol } from '@/lib/format';
import { colors, radius } from '@/theme';
import type { InvestigationStatus } from '@/types';

interface ProgressIndicatorProps {
  status: InvestigationStatus;
}

export function ProgressIndicator({ status }: ProgressIndicatorProps) {
  return (
    <View
      testID="progress-steps"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`調査の進行状況: ${statusLabel(status)}`}
      style={styles.container}
    >
      {statusOrder.map((step) => (
        <View key={step} style={styles.step}>
          <Text style={styles.symbol}>{statusSymbol(step, status)}</Text>
          <Text style={[styles.label, step === status && styles.activeLabel]}>
            {statusLabel(step)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 12,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.chipBg,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  symbol: {
    fontSize: 12,
  },
  label: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  activeLabel: {
    fontWeight: 'bold',
    color: colors.orange,
  },
});
