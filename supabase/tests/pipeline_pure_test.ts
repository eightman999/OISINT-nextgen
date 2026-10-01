// pipeline.ts の「純粋エクスポート」のみのテスト (spec.md §15 評価への影響 / §16.3 768 次元固定)
// 対象: parseVector / CLAIM_TO_KIND。DB を触る関数 (loadCandidates / investigateAndPersist /
// rankInvestigation 等) はここでは扱わない (supabase クライアント必須のため対象外)。
import { assert, assertEquals } from "@std/assert";
import {
  CLAIM_TO_KIND,
  guardRankingMatchAgainstContradictions,
  parseVector,
} from "../functions/_shared/pipeline.ts";
import {
  contradictedKeys,
  detectCombinedContradictions,
} from "../functions/_shared/contradiction.ts";
import { filterEvidenceForInvestigation } from "../functions/_shared/evidence_content.ts";
import { requirementKindSchema } from "../functions/_shared/validation.ts";
import type { ClaimKey } from "../functions/_shared/types.ts";
import { computeScore } from "../functions/_shared/ranking.ts";

const vec768 = Array.from({ length: 768 }, (_, i) => (i % 7) / 10);

// ============================================================
// parseVector (§16.3: DB の vector(768) 文字列 → number[])
// ============================================================

Deno.test("parseVector: 768 次元の JSON 文字列はパースされる", () => {
  const out = parseVector(JSON.stringify(vec768));
  assert(out !== null);
  assertEquals(out.length, 768);
  assertEquals(out[0], 0);
  assertEquals(out[1], 0.1);
});

Deno.test("parseVector: 768 次元以外は null (次元固定 §16.3。'[0.1,0.2]' も弾かれる)", () => {
  assertEquals(parseVector("[0.1,0.2]"), null); // 2 次元
  assertEquals(parseVector(JSON.stringify(vec768.slice(0, 767))), null); // 767 次元
  assertEquals(parseVector(JSON.stringify([...vec768, 0.5])), null); // 769 次元
});

Deno.test("parseVector: null / undefined / 空文字は null", () => {
  assertEquals(parseVector(null), null);
  assertEquals(parseVector(undefined), null);
  assertEquals(parseVector(""), null);
});

Deno.test("parseVector: JSON として不正な文字列・配列でない JSON は null", () => {
  assertEquals(parseVector("not-json"), null);
  assertEquals(parseVector("{0.1,0.2}"), null);
  assertEquals(parseVector('{"a":1}'), null); // object
  assertEquals(parseVector("0.5"), null); // scalar
});

Deno.test("parseVector: 配列そのものを渡しても null (文字列形式のみ受け付ける)", () => {
  // pgvector の text 表現 (JSON 互換文字列) 前提。実配列は JSON.parse の
  // 暗黙 String() 変換で "0.1,0.2" となりパース失敗 → null。現状挙動をピン留め。
  assertEquals(parseVector(vec768 as unknown as string), null);
});

Deno.test("parseVector: string/null/NaN/Infinity要素をDB read-backでfail-closed拒否する", () => {
  for (const invalid of ["x", null, Number.NaN, Infinity, -Infinity]) {
    const dirty: unknown[] = [...vec768];
    dirty[767] = invalid;
    assertEquals(parseVector(JSON.stringify(dirty)), null);
  }
});

// ============================================================
// CLAIM_TO_KIND (§15: 矛盾キー → 評価へ影響する requirement kind)
// ============================================================

Deno.test("CLAIM_TO_KIND: マッピングは §15 のとおり (キーと kind の対応)", () => {
  assertEquals(CLAIM_TO_KIND.opening_hours, ["time"]);
  assertEquals(CLAIM_TO_KIND.closed_days, ["time"]);
  assertEquals(CLAIM_TO_KIND.budget_dinner, ["budget"]);
  assertEquals(CLAIM_TO_KIND.card_accepted, ["payment"]);
  assertEquals(CLAIM_TO_KIND.reservation, ["reservation"]);
  assertEquals(CLAIM_TO_KIND.private_room, ["reservation", "party_size"]);
  assertEquals(CLAIM_TO_KIND.capacity, ["party_size"]);
  assertEquals(CLAIM_TO_KIND.non_smoking, ["dietary", "atmosphere", "other"]);
  assertEquals(CLAIM_TO_KIND.wifi_available, ["access", "other"]);
  assertEquals(CLAIM_TO_KIND.child_friendly, ["atmosphere", "other"]);
  assertEquals(CLAIM_TO_KIND.nearest_station_walk_minutes, ["access"]);
});

Deno.test("CLAIM_TO_KIND: 全ての値は requirementKindSchema の kind に含まれる (捏造 kind なし)", () => {
  const validKinds = new Set<string>(requirementKindSchema.options);
  for (const kinds of Object.values(CLAIM_TO_KIND)) {
    for (const k of kinds ?? []) {
      assert(validKinds.has(k), `未知の kind: ${k}`);
    }
  }
});

Deno.test("CLAIM_TO_KIND: 評価に影響する比較対象キーを網羅し、比較しないキーを含まない", () => {
  // §15 で矛盾比較し評価へ影響する既存キーに、#334の4キーを加える。
  // genre / noise_level は比較しない (contradiction.ts と整合)。time_limit も対象外。
  const mapped = Object.keys(CLAIM_TO_KIND).sort();
  assertEquals(mapped, [
    "budget_dinner",
    "capacity",
    "card_accepted",
    "child_friendly",
    "closed_days",
    "nearest_station_walk_minutes",
    "non_smoking",
    "opening_hours",
    "private_room",
    "reservation",
    "wifi_available",
  ]);
  for (const excluded of ["genre", "noise_level", "time_limit"] as ClaimKey[]) {
    assertEquals(CLAIM_TO_KIND[excluded], undefined);
  }
});

Deno.test("CLAIM_TO_KIND: ランキングで矛盾降格の対象になる kind 側から見ても欠落がない", () => {
  // rankInvestigation は「矛盾キー → kind」の逆引きで match を partial に降格する (§15)。
  // 事実で評価できるkindすべてに
  // 少なくとも 1 つの claim キーが対応していることを保証する。
  const coveredKinds = new Set(
    Object.values(CLAIM_TO_KIND).flatMap((ks) => ks ?? []),
  );
  for (
    const kind of [
      "time",
      "budget",
      "payment",
      "reservation",
      "party_size",
      "dietary",
      "atmosphere",
      "other",
      "access",
    ]
  ) {
    assert(coveredKinds.has(kind), `kind ${kind} に対応する claim キーが無い`);
  }
});

Deno.test("ranking guard: 単一 Evidence 内部相反でもmatchを断定せずpartialへ降格", () => {
  const contradictions = detectCombinedContradictions([{
    id: "e1",
    placeId: "place-1",
    sourceQuality: 1,
    structuredClaims: [
      { key: "card_accepted", value: true, rawText: "true" },
      { key: "card_accepted", value: false, rawText: "false" },
    ],
  }]);
  const guarded = guardRankingMatchAgainstContradictions(
    "match",
    0.9,
    "payment",
    contradictedKeys(contradictions),
  );
  assertEquals(guarded, { state: "partial", confidence: 0.5 });
  assertEquals(
    guardRankingMatchAgainstContradictions(
      "mismatch",
      0.9,
      "payment",
      contradictedKeys(contradictions),
    ),
    { state: "partial", confidence: 0.5 },
  );
  assertEquals(
    guardRankingMatchAgainstContradictions(
      "partial",
      0.8,
      "payment",
      contradictedKeys(contradictions),
    ),
    { state: "partial", confidence: 0.5 },
  );
});

Deno.test("ranking guard: 旧要件依存shared rowの相反値をranking降格へ使わない", () => {
  const rows = filterEvidenceForInvestigation([
    {
      id: "unsafe",
      scope: "shared",
      investigation_id: null,
      source_url: "https://official.example/menu",
      source_type: "other_public_page",
      source_title: "以前の利用者条件",
      excerpt: "以前の利用者はカードを避けたい",
      source_quality: 1,
      structured_claims: [{
        key: "card_accepted" as const,
        value: false,
        rawText: "以前の利用者はカードを避けたい",
      }],
    },
    {
      id: "safe",
      scope: "shared",
      investigation_id: null,
      source_url: "https://official.example/menu",
      source_type: "other_public_page",
      source_title: "公開ページ (official.example)",
      excerpt: "クレジットカード利用可",
      source_quality: 0.4,
      structured_claims: [{
        key: "card_accepted" as const,
        value: true,
        rawText: "クレジットカード利用可",
      }],
    },
  ], "inv-current");
  const contradictions = detectCombinedContradictions(rows.map((row) => ({
    id: row.id,
    placeId: "place-1",
    sourceQuality: 1,
    structuredClaims: row.structured_claims,
  })));
  const guarded = guardRankingMatchAgainstContradictions(
    "match",
    0.9,
    "payment",
    contradictedKeys(contradictions),
  );
  assertEquals(rows.map((row) => row.id), ["safe"]);
  assertEquals(contradictions, []);
  assertEquals(guarded, { state: "match", confidence: 0.9 });
  const common = {
    requirements: [{ id: "r1", priority: "must" as const, weight: 1 }],
    evaluations: [{
      requirementId: "r1",
      state: "match" as const,
      confidence: 0.9,
    }],
    evidenceFreshness: [1],
    voteValues: [],
    memberCount: 1,
    semanticMatch: 0,
  };
  const filteredScore = computeScore({
    ...common,
    evidenceQualities: rows.map((row) => row.source_quality),
  });
  const safeOnlyScore = computeScore({ ...common, evidenceQualities: [0.4] });
  const unsafeInflatedScore = computeScore({
    ...common,
    evidenceQualities: [1, 0.4],
  });
  assertEquals(filteredScore, safeOnlyScore);
  assertEquals(unsafeInflatedScore > filteredScore, true);
});
