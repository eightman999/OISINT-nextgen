// 矛盾検出 (spec.md §15)。AI に投げず structured_claims の突き合わせで機械的に判定する。純関数。
// 異なる Evidence が食い違ったら両方保存し両方表示する。一方へ丸めない。
import type { ClaimKey, Contradiction, StructuredClaim } from "./types.ts";
import { parseOpeningHoursValue } from "./opening_hours.ts";

export interface EvidenceForContradiction {
  id: string;
  placeId: string;
  sourceQuality: number;
  structuredClaims: StructuredClaim[];
}

// §15 比較表:
//   card_accepted / reservation / private_room / filter feature … boolean 完全一致
//   opening_hours … 分単位に正規化し、閉店時刻が 30 分以上ずれたら矛盾
//   budget_dinner … 区間が重ならなければ矛盾
//   capacity      … 差が 2 倍以上なら矛盾
//   nearest_station_walk_minutes … 明示値が異なれば矛盾として両方を保持
//   price_range   … 同じ通貨・単位で区間が重ならなければ矛盾（換算はしない）
//   genre / noise_level … 比較しない (誤検知が多い)
//   (表にないキーも比較しない。安全側)
const BOOLEAN_KEYS: ClaimKey[] = [
  "card_accepted",
  "reservation",
  "private_room",
  "non_smoking",
  "wifi_available",
  "child_friendly",
];

// "17:00-23:00" → 閉店時刻 (分)。"翌1:00" 等は扱わない (パース不能は比較不能扱い)
export function closingMinutes(openingHours: string): number | null {
  return parseOpeningHoursValue(openingHours)?.close ?? null;
}

export function claimValuesConflict(
  key: ClaimKey,
  a: unknown,
  b: unknown,
): boolean {
  if (BOOLEAN_KEYS.includes(key)) {
    return typeof a === "boolean" && typeof b === "boolean" && a !== b;
  }
  if (key === "opening_hours") {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ca = closingMinutes(a);
    const cb = closingMinutes(b);
    if (ca === null || cb === null) return false;
    return Math.abs(ca - cb) >= 30;
  }
  if (key === "budget_dinner") {
    const ra = a as { min?: number; max?: number };
    const rb = b as { min?: number; max?: number };
    if (
      typeof ra?.min !== "number" || typeof ra?.max !== "number" ||
      typeof rb?.min !== "number" || typeof rb?.max !== "number"
    ) return false;
    return ra.max < rb.min || rb.max < ra.min; // 区間非重複のみ矛盾
  }
  if (key === "price_range") {
    const ra = a as {
      min?: number;
      max?: number;
      currency?: string;
      unit?: string;
    };
    const rb = b as {
      min?: number;
      max?: number;
      currency?: string;
      unit?: string;
    };
    // 単位・通貨が違う値は換算せず比較不能のまま残す。
    if (
      typeof ra?.min !== "number" || typeof ra?.max !== "number" ||
      typeof rb?.min !== "number" || typeof rb?.max !== "number" ||
      ra.currency !== rb.currency || ra.unit !== rb.unit ||
      ra.min > ra.max || rb.min > rb.max
    ) return false;
    return ra.max < rb.min || rb.max < ra.min;
  }
  if (key === "capacity") {
    if (typeof a !== "number" || typeof b !== "number" || a <= 0 || b <= 0) {
      return false;
    }
    return Math.max(a, b) / Math.min(a, b) >= 2;
  }
  if (key === "nearest_station_walk_minutes") {
    return Number.isSafeInteger(a) && Number.isSafeInteger(b) &&
      (a as number) >= 0 && (b as number) >= 0 && a !== b;
  }
  return false; // genre / noise_level / その他は比較しない
}

// 同一 place の Evidence 群から矛盾を検出する (§15)
export function detectContradictions(
  evidence: EvidenceForContradiction[],
): Contradiction[] {
  const contradictions: Contradiction[] = [];
  if (evidence.length < 2) return contradictions;
  const placeId = evidence[0].placeId;

  // key → [{evidenceId, value, sourceQuality}]
  const byKey = new Map<
    ClaimKey,
    { evidenceId: string; value: unknown; sourceQuality: number }[]
  >();
  for (const ev of evidence) {
    for (const claim of ev.structuredClaims) {
      const arr = byKey.get(claim.key) ?? [];
      arr.push({
        evidenceId: ev.id,
        value: claim.value,
        sourceQuality: ev.sourceQuality,
      });
      byKey.set(claim.key, arr);
    }
  }

  for (const [key, entries] of byKey) {
    if (entries.length < 2) continue;
    let conflicted = false;
    outer: for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[i].evidenceId === entries[j].evidenceId) continue;
        if (claimValuesConflict(key, entries[i].value, entries[j].value)) {
          conflicted = true;
          break outer;
        }
      }
    }
    if (conflicted) contradictions.push({ placeId, key, entries });
  }
  return contradictions;
}

// 同一 Evidence 行の中で同じ key に相反値が入った場合を検出する。
// detectContradictions の「異なる Evidence 間」契約は変えず、same-URL finding
// 集約などで生じる内部相反を必要な呼び出し経路だけが合成できるよう分離する。
export function detectInternalContradictions(
  evidence: EvidenceForContradiction[],
): Contradiction[] {
  const contradictions: Contradiction[] = [];
  for (const ev of evidence) {
    const byKey = new Map<
      ClaimKey,
      { evidenceId: string; value: unknown; sourceQuality: number }[]
    >();
    for (const claim of ev.structuredClaims) {
      const entries = byKey.get(claim.key) ?? [];
      entries.push({
        evidenceId: ev.id,
        value: claim.value,
        sourceQuality: ev.sourceQuality,
      });
      byKey.set(claim.key, entries);
    }
    for (const [key, entries] of byKey) {
      const conflicted = entries.some((entry, index) =>
        entries.slice(index + 1).some((other) =>
          claimValuesConflict(key, entry.value, other.value)
        )
      );
      if (conflicted) {
        contradictions.push({ placeId: ev.placeId, key, entries });
      }
    }
  }
  return contradictions;
}

export function detectCombinedContradictions(
  evidence: EvidenceForContradiction[],
): Contradiction[] {
  const combined = [
    ...detectContradictions(evidence),
    ...detectInternalContradictions(evidence),
  ];
  const byPlaceAndKey = new Map<string, Contradiction>();
  for (const contradiction of combined) {
    const identity = `${contradiction.placeId}\u0000${contradiction.key}`;
    const existing = byPlaceAndKey.get(identity);
    if (!existing) {
      byPlaceAndKey.set(identity, {
        ...contradiction,
        entries: [...contradiction.entries],
      });
      continue;
    }
    const signatures = new Set(
      existing.entries.map((entry) =>
        `${entry.evidenceId}\u0000${JSON.stringify(entry.value)}`
      ),
    );
    for (const entry of contradiction.entries) {
      const signature = `${entry.evidenceId}\u0000${
        JSON.stringify(entry.value)
      }`;
      if (!signatures.has(signature)) {
        existing.entries.push(entry);
        signatures.add(signature);
      }
    }
  }
  return [...byPlaceAndKey.values()];
}

// 矛盾キーの集合。対応する requirement の評価を match から降格するのに使う (§15 評価への影響)
export function contradictedKeys(
  contradictions: Contradiction[],
): Set<ClaimKey> {
  return new Set(contradictions.map((c) => c.key));
}
