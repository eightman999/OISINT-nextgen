// 「現在地」系の擬似エリア語の判定 (issue #317 / spec.md §29, §31)
//
// parse 結果の area が「現在地」等の場合、明示された run request の
// searchAnchor が検索アンカーになる。anchor が無い再試行では provider を呼ばず、
// location_anchor_required として地名入力へ戻す (#317)。
// 判定は純関数 (外部依存なし)。呼び出し側:
// - provider: 明示 anchor がある場合だけ座標検索、未解決なら呼び出し前に停止
// - run-investigation stepSearching: missing anchor を専用 reason/event で返す

// 完全一致で「現在地」扱いにする語 (地名の部分一致はしない)
const CURRENT_LOCATION_TOKENS = new Set([
  "現在地",
  "現在位置",
  "現在地点",
  "ここ",
  "ここら",
  "ここらへん",
  "この辺",
  "このへん",
  "この近く",
  "近く",
  "近所",
  "近場",
  "周辺",
  "付近",
  "今いる場所",
  "いまいる場所",
  "今いるところ",
  "いまいるところ",
]);

// 「現在地付近」「現在地のすぐ近く」等の接尾語ゆれ (末尾のみ 1 回剥がす)
const LOCATION_SUFFIX =
  /(?:の)?(?:すぐ)?(?:付近|周辺|近辺|辺り|あたり|近く|そば|エリア)$/;

// area が「現在地」系 (座標なしでは地名へ解決できない語) なら true。
// 「池袋周辺」のような実在地名 + 接尾語は現在地扱いにしない (接尾語を剥がした残りで判定)。
export function isCurrentLocationArea(
  area: string | null | undefined,
): boolean {
  const trimmed = (area ?? "").trim();
  if (trimmed === "") return false;
  if (CURRENT_LOCATION_TOKENS.has(trimmed)) return true;
  const stripped = trimmed.replace(LOCATION_SUFFIX, "");
  return stripped !== trimmed && CURRENT_LOCATION_TOKENS.has(stripped);
}
