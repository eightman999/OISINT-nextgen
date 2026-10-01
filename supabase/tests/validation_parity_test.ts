// issue #367: zod major を全レイヤ 4.4.3 へ統一した後、同一入力ベクタに対する
// 判定が edge (Deno zod) と front (Node zod) で一致し続けることを edge 側から固定する。
// 共有ベクタは scripts/fixtures/zod-parity-vectors.json。front 側の対になるテストは
// src/lib/__tests__/validation_parity.test.ts (vitest)。判定を変える場合は両方を更新する。
import { assertEquals } from "@std/assert";
import { z } from "zod";
import {
  groundedCandidateInvestigationSchema,
  joinInvestigationBodySchema,
  parsedRequirementsSchema,
  rerankInvestigationBodySchema,
  runInvestigationBodySchema,
} from "../functions/_shared/validation.ts";

interface StringCase {
  input: string;
  valid: boolean;
  note?: string;
}
interface NumberCase {
  input: number;
  valid: boolean;
  note?: string;
}
interface ParityVectors {
  uuid: StringCase[];
  shareToken: StringCase[];
  matchState: StringCase[];
  weight: NumberCase[];
}

const vectors: ParityVectors = JSON.parse(
  Deno.readTextFileSync(
    new URL("../../scripts/fixtures/zod-parity-vectors.json", import.meta.url),
  ),
);

Deno.test("parity(uuid): run/rerank の investigationId 判定が共有ベクタと一致", () => {
  for (const c of vectors.uuid) {
    assertEquals(
      runInvestigationBodySchema.safeParse({ investigationId: c.input })
        .success,
      c.valid,
      `run ${c.input}: ${c.note ?? ""}`,
    );
    assertEquals(
      rerankInvestigationBodySchema.safeParse({
        investigationId: c.input,
        trigger: "vote",
      }).success,
      c.valid,
      `rerank ${c.input}: ${c.note ?? ""}`,
    );
  }
});

Deno.test("parity(share_token): 契約表現 ^[0-9a-f]{32}$ の判定が共有ベクタと一致", () => {
  // share_token は DB 生成で edge に検証スキーマが無いため、front の
  // createInvestigationResponseSchema.shareToken と同一表現のプリミティブで比較する
  const shareTokenContract = z.string().regex(/^[0-9a-f]{32}$/);
  for (const c of vectors.shareToken) {
    assertEquals(
      shareTokenContract.safeParse(c.input).success,
      c.valid,
      `${c.input}: ${c.note ?? ""}`,
    );
  }
});

Deno.test("parity(share_token): joinInvestigationBodySchema は意図的に非空のみ要求 (非対称の明示)", () => {
  // join は mock の人間可読 token も受けるため 32-hex 契約より緩い min(1)。
  // 厳格化するときはこのテストと #367 の表・共有ベクタを同時に更新する
  for (const c of vectors.shareToken) {
    assertEquals(
      joinInvestigationBodySchema.safeParse({
        shareToken: c.input,
        displayName: "テスト",
      }).success,
      c.input.length > 0,
      `${c.input}: ${c.note ?? ""}`,
    );
  }
});

Deno.test("parity(enum): findings.state の判定が共有ベクタと一致", () => {
  const investigationOf = (state: string) => ({
    summary: "評価まとめ",
    searchQueries: [],
    citations: [],
    findings: [
      {
        requirementId: "r1",
        state,
        confidence: 0.5,
        explanation: "説明",
        sourceUrls: [],
        claims: [],
      },
    ],
  });
  for (const c of vectors.matchState) {
    assertEquals(
      groundedCandidateInvestigationSchema.safeParse(investigationOf(c.input))
        .success,
      c.valid,
      `${c.input}: ${c.note ?? ""}`,
    );
  }
});

Deno.test("parity(数値境界): requirements.weight (0..1) の判定が共有ベクタと一致", () => {
  const parsedOf = (weight: number) => ({
    title: "調査",
    normalizedQuery: "池袋 焼肉",
    area: "池袋",
    requirements: [
      {
        text: "予算4000円",
        normalizedText: "予算 4000 円以内",
        kind: "budget",
        priority: "must",
        weight,
      },
    ],
  });
  for (const c of vectors.weight) {
    assertEquals(
      parsedRequirementsSchema.safeParse(parsedOf(c.input)).success,
      c.valid,
      `${c.input}: ${c.note ?? ""}`,
    );
  }
});
