const SITE_ORIGIN = 'https://oisint.com';

interface ShareUrlInput {
  /** 画面遷移で渡された shareToken（URL パラメータ） */
  paramToken?: string;
  /** 調査本体が持つ share_token（メンバーなら取得できる） */
  investigationShareToken?: string;
  investigationId: string;
}

/**
 * 共有・コピー用の URL を組み立てる（spec.md §25.4）。
 *
 * 参加導線になり得るのは share_token 付き URL だけで、`/investigations/<id>` は
 * RLS により未参加ユーザーが開いても何も見えない。よって URL パラメータが
 * 落ちている場合も調査本体の share_token を使い、どちらも無い場合に限り
 * id 形式へ退避する。
 */
export function buildShareUrl({
  paramToken,
  investigationShareToken,
  investigationId,
}: ShareUrlInput): string {
  const token = paramToken || investigationShareToken;
  return token ? `${SITE_ORIGIN}/i/${token}` : `${SITE_ORIGIN}/investigations/${investigationId}`;
}
