// OCR fixture 評価用の副作用なし集計 (#120)
// Evidence/DB/provider選択へ接続せず、構造化claimの期待値と実測値だけを集計する。
import type { StructuredClaim } from "../types.ts";

export interface OcrEvaluationCase {
  expectedClaims: readonly StructuredClaim[];
  actualClaims: readonly StructuredClaim[];
  latencyMs: number;
  costUnits: number;
}

export interface OcrEvaluationSummary {
  caseCount: number;
  matchedFields: number;
  expectedFields: number;
  returnedClaims: number;
  matchedClaims: number;
  fieldAccuracy: number;
  claimPrecision: number;
  totalCostUnits: number;
  costPerImage: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

function canonicalValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("OCR evaluation claim value is not serializable");
    }
    return serialized;
  } catch {
    // evaluation入力はJSON相当でなければ集計不能。別claimとの誤一致を防ぐ。
    throw new Error("OCR evaluation claim value is not serializable");
  }
}

function claimKey(claim: StructuredClaim): string {
  return `${claim.key}:${canonicalValue(claim.value)}`;
}

function matchedCount(
  expectedClaims: readonly StructuredClaim[],
  actualClaims: readonly StructuredClaim[],
): number {
  const remaining = new Map<string, number>();
  for (const claim of expectedClaims) {
    const key = claimKey(claim);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  let matched = 0;
  for (const claim of actualClaims) {
    const key = claimKey(claim);
    const count = remaining.get(key) ?? 0;
    if (count <= 0) continue;
    remaining.set(key, count - 1);
    matched++;
  }
  return matched;
}

function percentile(
  sorted: readonly number[],
  quantile: number,
): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(sorted.length * quantile));
  return sorted[rank - 1];
}

/**
 * fixtureごとの一致率・過剰抽出率・mock cost・latencyを決定論的に集計する。
 * 不正な計測値を0へ丸めず、harness自体をエラーにして結果の捏造を防ぐ。
 */
export function summarizeOcrEvaluation(
  cases: readonly OcrEvaluationCase[],
): OcrEvaluationSummary {
  for (const item of cases) {
    if (
      !Number.isFinite(item.latencyMs) || item.latencyMs < 0 ||
      !Number.isFinite(item.costUnits) || item.costUnits < 0
    ) {
      throw new Error("OCR evaluation measurement is invalid");
    }
  }

  const expectedFields = cases.reduce(
    (sum, item) => sum + item.expectedClaims.length,
    0,
  );
  const returnedClaims = cases.reduce(
    (sum, item) => sum + item.actualClaims.length,
    0,
  );
  const matchedClaims = cases.reduce(
    (sum, item) => sum + matchedCount(item.expectedClaims, item.actualClaims),
    0,
  );
  const totalCostUnits = cases.reduce((sum, item) => sum + item.costUnits, 0);
  const latencies = cases.map((item) => item.latencyMs).sort((a, b) => a - b);

  return {
    caseCount: cases.length,
    matchedFields: matchedClaims,
    expectedFields,
    returnedClaims,
    matchedClaims,
    fieldAccuracy: expectedFields === 0
      ? (returnedClaims === 0 ? 1 : 0)
      : matchedClaims / expectedFields,
    claimPrecision: returnedClaims === 0
      ? (expectedFields === 0 ? 1 : 0)
      : matchedClaims / returnedClaims,
    totalCostUnits,
    costPerImage: cases.length === 0 ? 0 : totalCostUnits / cases.length,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  };
}
