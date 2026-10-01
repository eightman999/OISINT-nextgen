import { assertEquals } from "@std/assert";
import {
  EMBEDDING_DIMENSION,
  parseEmbeddingVector,
  validateEmbedding,
  validateEmbeddingVectorString,
} from "../functions/_shared/embedding_validation.ts";

const validVector = () =>
  Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => index / 1000);

Deno.test("validateEmbedding: 期待次元のfinite numberだけを受理しcopyを返す", () => {
  const raw = validVector();
  const checked = validateEmbedding(raw);
  assertEquals(checked.ok, true);
  if (!checked.ok) return;
  assertEquals(checked.value, raw);
  assertEquals(checked.value === raw, false);
});

Deno.test("validateEmbedding: string/null/NaN/Infinityをfail-closedで拒否する", () => {
  for (const invalid of ["0.1", null, Number.NaN, Infinity, -Infinity]) {
    const raw: unknown[] = validVector();
    raw[321] = invalid;
    assertEquals(validateEmbedding(raw), {
      ok: false,
      reason: "invalid_value",
      actualLength: EMBEDDING_DIMENSION,
    });
  }
});

Deno.test("validateEmbedding: sparse配列、非配列、wrong dimensionを拒否する", () => {
  const sparse = validVector();
  delete sparse[10];
  assertEquals(validateEmbedding(sparse).ok, false);
  assertEquals(validateEmbedding(null), {
    ok: false,
    reason: "not_array",
    actualLength: null,
  });
  assertEquals(validateEmbedding(validVector().slice(1)), {
    ok: false,
    reason: "wrong_dimension",
    actualLength: EMBEDDING_DIMENSION - 1,
  });
});

Deno.test("parseEmbeddingVector: DB textも同じvalidatorを通しinvalidはnullにする", () => {
  const valid = validVector();
  assertEquals(parseEmbeddingVector(JSON.stringify(valid)), valid);
  const stringValue: unknown[] = [...valid];
  stringValue[0] = "0";
  assertEquals(parseEmbeddingVector(JSON.stringify(stringValue)), null);
  const nullValue: unknown[] = [...valid];
  nullValue[0] = null;
  assertEquals(parseEmbeddingVector(JSON.stringify(nullValue)), null);
  assertEquals(parseEmbeddingVector(JSON.stringify(valid.slice(1))), null);
  assertEquals(parseEmbeddingVector("not-json"), null);
  assertEquals(validateEmbeddingVectorString("not-json"), {
    ok: false,
    reason: "not_array",
    actualLength: null,
  });
  assertEquals(validateEmbeddingVectorString(JSON.stringify(valid.slice(1))), {
    ok: false,
    reason: "wrong_dimension",
    actualLength: EMBEDDING_DIMENSION - 1,
  });
});
