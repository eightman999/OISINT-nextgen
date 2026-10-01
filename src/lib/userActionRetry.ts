export type AmbiguousMutation = 'add-requirement' | 'remove-requirement';

/**
 * 応答を失った追加・削除は、server側で既に適用済みか判定できない。
 * 同じ書込を再送せず、最新snapshotの取得だけで状態を収束させる。
 */
export function retryAfterAmbiguousMutation(_mutation: AmbiguousMutation): 'refresh' {
  return 'refresh';
}
