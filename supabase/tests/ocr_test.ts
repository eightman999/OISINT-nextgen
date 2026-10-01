// #120 メニュー画像 OCR の入力/出力境界と mock-first 評価。
// 外部 API・Storage・検索画像は使わず、合成 fixture と deterministic mock のみで検証する。
import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  MOCK_OCR_FIXTURES,
  MockOcrProvider,
} from "../functions/_shared/providers/mock_ocr.ts";
import { summarizeOcrEvaluation } from "../functions/_shared/providers/ocr_evaluation.ts";
import {
  OCR_ALLOWED_MIME_TYPES,
  OCR_CLAIM_CONFIDENCE_THRESHOLD,
  OCR_MAX_IMAGE_BYTES,
  ocrExtractionSchema,
  type OcrInput,
  parseOcrExtraction,
  runOcrStructuredWithRetry,
  validateOcrInput,
} from "../functions/_shared/providers/ocr_types.ts";

interface FixtureClaim {
  key: string;
  value: unknown;
}

interface MenuFixture {
  id: string;
  image: string;
  scenario: string;
  expectedClaims: FixtureClaim[];
  notes: string;
}

const fixtures = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/ocr/menu-scenarios.json", import.meta.url),
  ),
) as MenuFixture[];

const PNG_HEADER = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

function imageBytes(mimeType = "image/png", size = 16): Uint8Array {
  const bytes = new Uint8Array(size);
  if (mimeType === "image/png") {
    bytes.set(PNG_HEADER);
  } else if (mimeType === "image/jpeg") {
    bytes.set([0xff, 0xd8, 0xff]);
  } else if (mimeType === "image/webp" && size >= 12) {
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  }
  return bytes;
}

function inputFor(
  fileId = "menu-3000",
  options: {
    bytes?: Uint8Array;
    mimeType?: string;
    sourceKind?: string;
    page?: number;
    inputFileId?: string;
  } = {},
): OcrInput {
  return {
    image: {
      bytes: options.bytes ?? imageBytes(options.mimeType),
      mimeType: options.mimeType ?? "image/png",
      fileId: options.inputFileId ?? fileId,
    },
    meta: {
      sourceKind:
        (options.sourceKind ?? "fixture") as OcrInput["meta"]["sourceKind"],
      page: options.page ?? 1,
    },
  };
}

function validRaw(fileId = "menu-3000") {
  return {
    rawText: "夕食 3000円",
    claims: [{
      key: "budget_dinner",
      value: { min: 3000, max: 3000 },
      rawText: "夕食 3000円",
      confidence: 0.9,
      provenance: { fileId, page: 1, bbox: null },
    }],
  };
}

Deno.test("OCR mock: 必須シナリオを同じ契約で決定論的に評価する", async () => {
  assertEquals(
    Object.keys(MOCK_OCR_FIXTURES).sort(),
    fixtures.map((f) => f.id).sort(),
  );
  const provider = new MockOcrProvider();
  let expectedCount = 0;
  let returnedCount = 0;
  let matchedCount = 0;

  for (const fixture of fixtures) {
    const first = await provider.extract(inputFor(fixture.id));
    const second = await provider.extract(inputFor(fixture.id));
    assertEquals(first, second, fixture.scenario);
    assertEquals(first.status, "ok", fixture.scenario);
    if (first.status !== "ok") continue;
    const claims = first.extraction.claims.map(({ key, value }) => ({
      key,
      value,
    }));
    assertEquals(claims, fixture.expectedClaims, fixture.scenario);
    assert(first.extraction.rawText.length > 0);
    expectedCount += fixture.expectedClaims.length;
    returnedCount += claims.length;
    matchedCount += claims.filter((claim) =>
      fixture.expectedClaims.some((expected) =>
        expected.key === claim.key &&
        JSON.stringify(expected.value) === JSON.stringify(claim.value)
      )
    ).length;
  }

  // field accuracy = 1.0、claim precision = 1.0（低品質画像の過剰抽出もない）。
  assertEquals(matchedCount, expectedCount);
  assertEquals(returnedCount, expectedCount);
  assertEquals(
    fixtures.find((f) => f.id === "menu-low-quality")?.expectedClaims,
    [],
  );
});

Deno.test("OCR evaluation: field accuracy/precision/cost/latencyを集計する", () => {
  const summary = summarizeOcrEvaluation([
    {
      expectedClaims: [{
        key: "budget_dinner",
        value: { min: 3000, max: 3000 },
        rawText: "",
      }],
      actualClaims: [{
        key: "budget_dinner",
        value: { min: 3000, max: 3000 },
        rawText: "",
      }],
      latencyMs: 1,
      costUnits: 0,
    },
    {
      expectedClaims: [],
      actualClaims: [],
      latencyMs: 3,
      costUnits: 0,
    },
    {
      expectedClaims: [{
        key: "budget_dinner",
        value: { min: 4000, max: 4000 },
        rawText: "",
      }],
      actualClaims: [{
        key: "budget_dinner",
        value: { min: 4000, max: 4000 },
        rawText: "",
      }],
      latencyMs: 5,
      costUnits: 0,
    },
  ]);
  assertEquals(summary, {
    caseCount: 3,
    matchedFields: 2,
    expectedFields: 2,
    returnedClaims: 2,
    matchedClaims: 2,
    fieldAccuracy: 1,
    claimPrecision: 1,
    totalCostUnits: 0,
    costPerImage: 0,
    latencyP50Ms: 3,
    latencyP95Ms: 5,
  });
  assertEquals(
    summarizeOcrEvaluation([{
      expectedClaims: [],
      actualClaims: [{
        key: "budget_dinner",
        value: { min: 1, max: 1 },
        rawText: "",
      }],
      latencyMs: 0,
      costUnits: 0,
    }]).claimPrecision,
    0,
  );
});

Deno.test("OCR入力: 許可sourceKind・MIME・実体signature・サイズを全て確認する", () => {
  for (const mimeType of OCR_ALLOWED_MIME_TYPES) {
    const checked = validateOcrInput(inputFor("menu-3000", {
      mimeType,
      bytes: imageBytes(mimeType),
    }));
    assert(checked.ok, mimeType);
  }
  assert(
    validateOcrInput(inputFor("menu-3000", { sourceKind: "user_upload" })).ok,
    "認証/同意済みupload境界からのsourceKindは許可する",
  );

  const tooLarge = imageBytes("image/png", OCR_MAX_IMAGE_BYTES + 1);
  assertEquals(
    validateOcrInput(inputFor("menu-3000", { bytes: tooLarge })).ok,
    false,
  );
  assertEquals(
    validateOcrInput(inputFor("menu-3000", { bytes: tooLarge })),
    { ok: false, reason: "image_too_large" },
  );
  assert(
    validateOcrInput(
      inputFor("menu-3000", {
        bytes: imageBytes("image/png", OCR_MAX_IMAGE_BYTES),
      }),
    ).ok,
  );

  assertEquals(
    validateOcrInput(inputFor("menu-3000", { mimeType: "image/svg+xml" })),
    { ok: false, reason: "mime_not_allowed" },
  );
  assertEquals(
    validateOcrInput(inputFor("menu-3000", {
      mimeType: "image/png",
      bytes: imageBytes("image/jpeg"),
    })),
    { ok: false, reason: "image_signature_mismatch" },
  );
});

Deno.test("OCR入力の負例: 実体なし・未許可source・file/page偽装を拒否する", () => {
  const missingBytes = inputFor();
  delete missingBytes.image.bytes;
  assertEquals(validateOcrInput(missingBytes), {
    ok: false,
    reason: "bytes_required",
  });
  assertEquals(
    validateOcrInput(inputFor("menu-3000", { sourceKind: "search_result" })),
    { ok: false, reason: "permission_required" },
  );
  assertEquals(
    validateOcrInput(inputFor("menu-3000", { inputFileId: "../private/menu" })),
    { ok: false, reason: "file_id_invalid" },
  );
  assertEquals(
    validateOcrInput(inputFor("menu-3000", { page: 0 })),
    { ok: false, reason: "page_invalid" },
  );
  assertEquals(
    validateOcrInput(inputFor("menu-3000", { page: 1.5 })),
    { ok: false, reason: "page_invalid" },
  );
});

Deno.test("OCR output: safeParse後にClaimKey/value/provenance/confidenceをfail-closedで絞る", () => {
  const input = inputFor();
  const parsed = ocrExtractionSchema.safeParse(validRaw());
  assert(parsed.success);

  // unknown key と Evidence用 source_url は strict schema で受けない。
  assertFalse(
    ocrExtractionSchema.safeParse({
      ...validRaw(),
      claims: [{
        ...validRaw().claims[0],
        key: "menu_name",
        source_url: "https://example.invalid/menu",
      }],
    }).success,
  );

  const result = parseOcrExtraction({
    rawText: "抽出候補",
    claims: [
      validRaw().claims[0],
      {
        ...validRaw().claims[0],
        confidence: OCR_CLAIM_CONFIDENCE_THRESHOLD - 0.01,
      },
      { ...validRaw().claims[0], confidence: 1.01 },
      {
        ...validRaw().claims[0],
        value: { min: -1, max: 3000 },
      },
      {
        ...validRaw().claims[0],
        provenance: { fileId: "other-file", page: 1, bbox: null },
      },
    ],
  }, input);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.data.claims.length, 1);
  assertEquals(result.data.claims[0].confidence, 0.9);
  assertEquals(result.droppedClaims, 4);
  // 1.01 を 1.0 に丸めて採用していない。
  assertEquals(
    result.data.claims.some((claim) => claim.confidence === 1),
    false,
  );
});

Deno.test("OCR output: provenanceのpage偽装・bbox範囲外・rawText超過は採用しない", () => {
  const input = inputFor();
  const pageMismatch = parseOcrExtraction({
    rawText: "候補",
    claims: [{
      ...validRaw().claims[0],
      provenance: { fileId: "menu-3000", page: 2, bbox: null },
    }],
  }, input);
  assertEquals(pageMismatch.ok, true);
  if (pageMismatch.ok) assertEquals(pageMismatch.data.claims, []);

  assertFalse(
    ocrExtractionSchema.safeParse({
      rawText: "候補",
      claims: [{
        ...validRaw().claims[0],
        provenance: { fileId: "menu-3000", page: 1, bbox: [0, 0, 1.1, 1] },
      }],
    }).success,
  );
  assertFalse(
    ocrExtractionSchema.safeParse({
      rawText: "x".repeat(2001),
      claims: [],
    }).success,
  );
});

Deno.test("OCR structured output: schema失敗は最大1回だけ再試行し、詳細を返さない", async () => {
  const contexts: Array<{ attempt: number; previousFailure: string | null }> =
    [];
  const result = await runOcrStructuredWithRetry(
    inputFor(),
    (context) => {
      contexts.push(context);
      return Promise.resolve(
        context.attempt === 1 ? { malformed: true } : validRaw(),
      );
    },
  );
  assertEquals(result.status, "ok");
  if (result.status === "ok") {
    assertEquals(result.attempts, 2);
    assertEquals(result.extraction.claims.length, 1);
  }
  assertEquals(contexts, [
    { attempt: 1, previousFailure: null },
    { attempt: 2, previousFailure: "schema_invalid" },
  ]);

  let failedCalls = 0;
  const failed = await runOcrStructuredWithRetry(inputFor(), () => {
    failedCalls++;
    return Promise.resolve({ malformed: true, secret: "must-not-escape" });
  });
  assertEquals(failed, {
    status: "failed",
    reason: "schema_invalid",
    attempts: 2,
  });
  assertEquals(failedCalls, 2);

  let rejectedCalls = 0;
  const rejectedInput = inputFor("menu-3000", { sourceKind: "search_result" });
  const rejected = await runOcrStructuredWithRetry(rejectedInput, () => {
    rejectedCalls++;
    return Promise.resolve(validRaw());
  });
  assertEquals(rejected, {
    status: "rejected",
    reason: "input_invalid",
    attempts: 0,
  });
  assertEquals(rejectedCalls, 0);

  const providerError = await runOcrStructuredWithRetry(inputFor(), () => {
    throw new Error("private provider detail must not escape");
  });
  assertEquals(providerError, {
    status: "failed",
    reason: "provider_error",
    attempts: 1,
  });
});

Deno.test("MockOcrProvider: unknown fixtureとprovider例外は空claimへ丸めずfail-closed、fetchは0回", async () => {
  const provider = new MockOcrProvider();
  assertEquals(
    await provider.extract(inputFor("not-a-fixture")),
    { status: "failed", reason: "unknown_fixture", attempts: 0 },
  );
  assertEquals(
    await provider.extract(
      inputFor("not-a-fixture", { sourceKind: "search_result" }),
    ),
    { status: "rejected", reason: "input_invalid", attempts: 0 },
  );

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("network must not be called");
  }) as typeof fetch;
  try {
    const result = await provider.extract(inputFor("menu-3000"));
    assertEquals(result.status, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(fetchCalls, 0);
});
