import { colors } from '@/theme';
import type { MatchState, InvestigationStatus, VoteValue } from '@/types';

export function matchStateSymbol(state: MatchState): string {
  switch (state) {
    case 'match':
      return '○';
    case 'partial':
      return '△';
    case 'mismatch':
      return '×';
    case 'unknown':
    default:
      return '?';
  }
}

export function matchStateColor(state: MatchState): string {
  switch (state) {
    case 'match':
      return colors.success;
    case 'partial':
      return colors.warning;
    case 'mismatch':
      return colors.danger;
    case 'unknown':
    default:
      return colors.textTertiary;
  }
}

export function matchStateAccessibilityLabel(state: MatchState): string {
  switch (state) {
    case 'match':
      return '条件を満たす';
    case 'partial':
      return '一部満たす';
    case 'mismatch':
      return '条件を満たさない';
    case 'unknown':
    default:
      return '判定不明';
  }
}

export const statusOrder: InvestigationStatus[] = [
  'parsing',
  'recalling',
  'searching',
  'collecting_evidence',
  'evaluating',
  'ranking',
  'complete',
];

export function statusLabel(status: InvestigationStatus): string {
  switch (status) {
    case 'draft':
      return '下書き';
    case 'parsing':
      return '条件解析';
    case 'recalling':
      return '類似調査の確認';
    case 'searching':
      return '候補店探索';
    case 'collecting_evidence':
      return 'Evidence収集';
    case 'evaluating':
      return '条件評価';
    case 'ranking':
      return 'ランキング';
    case 'complete':
      return '完了';
    case 'failed':
      return '失敗';
  }
}

export function statusSymbol(status: InvestigationStatus, current: InvestigationStatus): string {
  const currentIndex = statusOrder.indexOf(current);
  const stepIndex = statusOrder.indexOf(status);

  if (status === 'failed') return '!';
  if (stepIndex < currentIndex) return '✓';
  if (stepIndex === currentIndex) return status === 'complete' ? '✓' : '●';
  return '○';
}

export function voteSymbol(value: VoteValue): string {
  switch (value) {
    case 1:
      return '👍';
    case 0:
      return '🤔';
    case -1:
      return '👎';
  }
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
