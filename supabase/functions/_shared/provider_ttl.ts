// provider 由来データの TTL 判定 (#289 / spec.md §32, §44.3 L1)
// 旧 provider の API は #297 で撤去したが、L1 一次データを TTL 内のみ保存する
// 方針自体は provider 非依存の運用ルールとして残す (§44.3)。external_cache (§32) の 24h と揃える。
// DB 非依存の純関数のみを置く (tests/provider_ttl_test.ts)。
import type { SourceType } from "./types.ts";
import { ttlHours } from "./source_quality.ts";

export const PROVIDER_TTL_HOURS = 24;

// provider 由来の places 行を live 実行時に再取得すべきか (#289 暫定策)。
// - mock 行は外部 API を叩かない (§5.4 Fallback。mock デモ挙動を変えない)
// - persistent provider (ttlHours=null) は自動再取得しない。再検索は明示操作に限定する
// - refreshed_at が null / 不正 (migration 未適用期の行など) は安全側 = 再取得する
// - 境界 (ちょうど 24h) も安全側 = 再取得する
export function needsProviderRefresh(
  row: { provider: string; refreshed_at: string | null },
  now: Date = new Date(),
  refreshTtlHours: number | null = PROVIDER_TTL_HOURS,
): boolean {
  if (row.provider === "mock" || refreshTtlHours === null) return false;
  if (!Number.isFinite(refreshTtlHours) || refreshTtlHours <= 0) return true;
  if (!row.refreshed_at) return true;
  const refreshedAtMs = Date.parse(row.refreshed_at);
  if (!Number.isFinite(refreshedAtMs)) return true;
  return now.getTime() - refreshedAtMs >= refreshTtlHours * 3600_000;
}

// Evidence が §32 TTL 内 (再利用・knownClaims の対象) か。
// insertEvidenceIfStale の再利用判定 (observed_at > now - ttl) と同じ境界:
// TTL 外の行は再利用されず、再取得時に新しい行として再生成される (§32 追記型)。
// provider 由来 (source_type='major_place_provider') は 24h、other_public_page は 72h。
// observed_at が不正な行は安全側 = 期限切れ扱いにする。
export function isEvidenceWithinTtl(
  evidence: { source_type: string; observed_at: string },
  now: Date = new Date(),
): boolean {
  const observedAtMs = Date.parse(evidence.observed_at);
  if (!Number.isFinite(observedAtMs)) return false;
  // DB の text 値を受けるため cast する (未知の source_type は ttlHours が 24h に倒す)
  const ttl = ttlHours(evidence.source_type as SourceType);
  return now.getTime() - observedAtMs < ttl * 3600_000;
}

// 再取得対象の選別 (#530)。provider を切り替えた後は、過去の provider が作った
// places 行が同じ investigation に残る。その provider_place_id を現 provider の
// fetchByIds へ渡すと ID 体系が違うため失敗する (実測: legacy provider の ID を
// Geoapify place-details へ渡すと HTTP 400 Invalid Place ID)。fetchByIds は
// 最初の失敗で throw するため、1 件の legacy 行が同じ調査内の正当な再取得を
// 巻き添えにする。現 provider 由来の行だけを対象にし、他 provider 由来は skip する。
export function selectRefreshTargets<
  T extends { provider: string; refreshed_at: string | null },
>(
  rows: T[],
  currentProvider: string,
  now: Date = new Date(),
  refreshTtlHours: number | null = PROVIDER_TTL_HOURS,
): { targets: T[]; skipped: number } {
  const ownRows = rows.filter((r) => r.provider === currentProvider);
  return {
    targets: ownRows.filter((r) =>
      needsProviderRefresh(r, now, refreshTtlHours)
    ),
    skipped: rows.length - ownRows.length,
  };
}
