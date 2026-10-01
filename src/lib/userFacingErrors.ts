export type JoinErrorKind = 'invalid' | 'expired' | 'capacity' | 'network';

/** 外部応答の詳細をUIへ渡さず、参加導線で必要な分類だけを返す。 */
export function classifyJoinError(error: unknown): JoinErrorKind {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/(期限|expired|有効期限|失効)/u.test(message)) return 'expired';
  if (/(見つかりません|無効|invalid|not found|404)/u.test(message)) return 'invalid';
  if (/(上限|capacity|too many|full)/u.test(message)) return 'capacity';
  return 'network';
}

export function joinErrorMessage(kind: JoinErrorKind): string {
  switch (kind) {
    case 'expired':
      return '共有URLの有効期限が切れています。発行した人に新しいURLを依頼してください。';
    case 'capacity':
      return 'この調査は参加人数の上限に達しています。発行した人にご相談ください。';
    case 'network':
      return '共有調査に接続できませんでした。通信状態を確認して、もう一度お試しください。';
    case 'invalid':
    default:
      return '共有URLが無効です。発行した人に新しいURLを依頼してください。';
  }
}
