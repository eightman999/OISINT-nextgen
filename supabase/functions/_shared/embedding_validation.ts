// 外部provider応答とDB read-backの双方で使うembedding境界。
// 長さだけでなく、全要素の型とfinite性を検証してからnumber[]として扱う。

export const EMBEDDING_DIMENSION = 768;

export type EmbeddingValidationFailure =
  | "not_array"
  | "wrong_dimension"
  | "invalid_value";

export type EmbeddingValidationResult =
  | { ok: true; value: number[] }
  | {
    ok: false;
    reason: EmbeddingValidationFailure;
    actualLength: number | null;
  };

export function validateEmbedding(
  raw: unknown,
  expectedDimension = EMBEDDING_DIMENSION,
): EmbeddingValidationResult {
  if (!Number.isSafeInteger(expectedDimension) || expectedDimension <= 0) {
    throw new Error("embedding expected dimension is invalid");
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "not_array", actualLength: null };
  }
  if (raw.length !== expectedDimension) {
    return {
      ok: false,
      reason: "wrong_dimension",
      actualLength: raw.length,
    };
  }

  // Array#every はsparse arrayのholeを読み飛ばすため、indexで全要素を確認する。
  const value = new Array<number>(expectedDimension);
  for (let index = 0; index < expectedDimension; index++) {
    const item = raw[index];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return {
        ok: false,
        reason: "invalid_value",
        actualLength: raw.length,
      };
    }
    value[index] = item;
  }
  return { ok: true, value };
}

export function parseEmbeddingVector(
  raw: string | null | undefined,
  expectedDimension = EMBEDDING_DIMENSION,
): number[] | null {
  const checked = validateEmbeddingVectorString(raw, expectedDimension);
  return checked.ok ? checked.value : null;
}

export function validateEmbeddingVectorString(
  raw: string | null | undefined,
  expectedDimension = EMBEDDING_DIMENSION,
): EmbeddingValidationResult {
  if (!raw) return { ok: false, reason: "not_array", actualLength: null };
  try {
    return validateEmbedding(JSON.parse(raw), expectedDimension);
  } catch {
    return { ok: false, reason: "not_array", actualLength: null };
  }
}
