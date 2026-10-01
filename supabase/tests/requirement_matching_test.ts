// requirement_matching.ts (issue #312 是正案1) のユニットテスト。
// 予算・時間帯要件と structured claim (§13) の決定論突合が、
// §12 Critical Rule (Evidence 無しの断定禁止) と §17 (mismatch の降格) に整合することを検証する。
// 全て純関数 (外部 API / DB 非依存)。
import { assert, assertEquals } from "@std/assert";
import {
  BUDGET_TOLERANCE_RATIO,
  type ClaimWithEvidence,
  compareBudget,
  compareTimeWindow,
  deterministicEvaluations,
  normalizeBudgetRequirement,
  normalizeTimeRequirement,
  parseOpeningHours,
  VAGUE_CHEAP_MAX_YEN,
} from "../functions/_shared/requirement_matching.ts";
import { computeScore } from "../functions/_shared/ranking.ts";
import {
  applyClaimMatchingOverrides,
  type EvaluationRow,
} from "../functions/_shared/pipeline.ts";

// ============================================================
// normalizeBudgetRequirement (§11 kind=budget → 上限金額)
// ============================================================

Deno.test("budget正規化: 「安い」等のあいまい語は保守的な定数上限になる", () => {
  const tolerance = Math.round(VAGUE_CHEAP_MAX_YEN * BUDGET_TOLERANCE_RATIO);
  assertEquals(normalizeBudgetRequirement("安い"), {
    maxYen: VAGUE_CHEAP_MAX_YEN,
    toleranceYen: tolerance,
  });
  // issue #312 実ユーザー報告の表記
  assertEquals(normalizeBudgetRequirement("お手頃な価格帯"), {
    maxYen: VAGUE_CHEAP_MAX_YEN,
    toleranceYen: tolerance,
  });
  assertEquals(normalizeBudgetRequirement("リーズナブルな店"), {
    maxYen: VAGUE_CHEAP_MAX_YEN,
    toleranceYen: tolerance,
  });
});

Deno.test("budget正規化: 明示上限 (以内/以下/まで/未満) は許容幅なし", () => {
  assertEquals(normalizeBudgetRequirement("3000円以内"), {
    maxYen: 3000,
    toleranceYen: 0,
  });
  assertEquals(normalizeBudgetRequirement("予算は4,000円以下"), {
    maxYen: 4000,
    toleranceYen: 0,
  });
  assertEquals(normalizeBudgetRequirement("5000円まで"), {
    maxYen: 5000,
    toleranceYen: 0,
  });
  assertEquals(normalizeBudgetRequirement("3000円未満"), {
    maxYen: 2999,
    toleranceYen: 0,
  });
});

Deno.test("budget正規化: 「前後」や裸の金額は 2 割の許容幅がつく (mock の「予算 3000円前後」を含む)", () => {
  assertEquals(normalizeBudgetRequirement("予算 3000円前後"), {
    maxYen: 3000,
    toleranceYen: 600,
  });
  assertEquals(normalizeBudgetRequirement("一人3000円くらい"), {
    maxYen: 3000,
    toleranceYen: 600,
  });
});

Deno.test("budget正規化: 万円・全角数字・範囲表記を解釈する", () => {
  assertEquals(normalizeBudgetRequirement("1万円以内"), {
    maxYen: 10000,
    toleranceYen: 0,
  });
  assertEquals(normalizeBudgetRequirement("３０００円以内"), {
    maxYen: 3000,
    toleranceYen: 0,
  });
  // 範囲表記は最後の金額を明示上限とみなす
  assertEquals(normalizeBudgetRequirement("2000〜3000円"), {
    maxYen: 3000,
    toleranceYen: 0,
  });
});

Deno.test("budget正規化: 下限指定のみ・上限が読めない文面は null (AI 評価に任せる)", () => {
  assertEquals(normalizeBudgetRequirement("5000円以上"), null);
  assertEquals(normalizeBudgetRequirement("3000円〜"), null);
  assertEquals(normalizeBudgetRequirement("高級店がいい"), null);
  assertEquals(normalizeBudgetRequirement("おいしい店"), null);
});

Deno.test("budget正規化: 否定・除外・選言・例示を肯定上限へ部分一致させない", () => {
  for (
    const text of [
      "3000円以下ではない",
      "3000円以内を避けたい",
      "3000円または5000円",
      "予算を決めない（3000円など）",
      "3000円は安すぎる",
      "3000円より高い店がいい",
      "予算3000円にはしない",
      "3000円では足りない",
    ]
  ) assertEquals(normalizeBudgetRequirement(text), null, text);
});

// ============================================================
// compareBudget (budget_dinner claim {min,max} との突合)
// ============================================================

const cheap = { maxYen: 3000, toleranceYen: 600 }; // 「安い」相当

Deno.test("compareBudget: 夜6000〜7999円の店は「安い」に mismatch (issue #312 の実例)", () => {
  assertEquals(compareBudget(cheap, { min: 6000, max: 7999 }), "mismatch");
});

Deno.test("compareBudget: ちょうど上限までの帯は match (境界値)", () => {
  assertEquals(compareBudget(cheap, { min: 2001, max: 3000 }), "match");
  assertEquals(
    compareBudget({ maxYen: 3000, toleranceYen: 0 }, {
      min: 3000,
      max: 3000,
    }),
    "match",
  );
});

Deno.test("compareBudget: 上限をまたぐ帯は partial", () => {
  assertEquals(
    compareBudget({ maxYen: 3000, toleranceYen: 0 }, {
      min: 2500,
      max: 3500,
    }),
    "partial",
  );
  // 下限が上限を超えても許容幅 (600円) 以内なら断定しない
  assertEquals(compareBudget(cheap, { min: 3001, max: 4000 }), "partial");
});

Deno.test("compareBudget: 下限が上限+許容幅を超えたら mismatch (境界値)", () => {
  assertEquals(compareBudget(cheap, { min: 3600, max: 4000 }), "partial"); // ちょうど許容幅上
  assertEquals(compareBudget(cheap, { min: 3601, max: 4000 }), "mismatch");
});

// ============================================================
// normalizeTimeRequirement / compareTimeWindow (§11 kind=time)
// ============================================================

Deno.test("time正規化: 朝・昼・夜・深夜のキーワードを時間帯へ正規化する", () => {
  assertEquals(normalizeTimeRequirement("朝食営業している")?.label, "朝");
  assertEquals(normalizeTimeRequirement("モーニング")?.label, "朝");
  assertEquals(normalizeTimeRequirement("ランチ利用")?.label, "昼");
  assertEquals(normalizeTimeRequirement("夜ごはん")?.label, "夜");
  assertEquals(normalizeTimeRequirement("深夜まで営業")?.label, "深夜"); // 「夜」より先に判定
  assertEquals(normalizeTimeRequirement("駅から近い"), null);
});

Deno.test("time正規化: 明示時刻・範囲を分へ正規化し、深夜跨ぎを保持する", () => {
  assertEquals(normalizeTimeRequirement("18:00〜20:00"), {
    startMinute: 18 * 60,
    endMinute: 20 * 60,
    label: "18:00〜20:00",
  });
  assertEquals(normalizeTimeRequirement("午前8時から午前10時まで"), {
    startMinute: 8 * 60,
    endMinute: 10 * 60,
    label: "08:00〜10:00",
  });
  assertEquals(normalizeTimeRequirement("22時〜翌2時"), {
    startMinute: 22 * 60,
    endMinute: 26 * 60,
    label: "22:00〜翌02:00",
  });
  // 単独時刻・開店時刻だけでは滞在時間が分からないため断定しない。
  assertEquals(normalizeTimeRequirement("18時から"), null);
  assertEquals(normalizeTimeRequirement("18時以降"), null);
});

Deno.test("time正規化: 曜日付き要件は曜日別claimがないためunknownへ倒す", () => {
  for (
    const text of [
      "月曜の朝",
      "平日の18時〜20時",
      "土日の夜に営業している",
      "毎日朝食営業している",
    ]
  ) assertEquals(normalizeTimeRequirement(text), null, text);
});

Deno.test("time正規化: 否定・除外・選言を肯定時間帯へ部分一致させない", () => {
  for (
    const text of [
      "朝は避けたい",
      "朝以外",
      "朝食は不要",
      "夜ではない",
      "朝または夜",
      "朝は無理",
      "朝には行かない",
      "朝は早すぎる",
      "夜遅くは困る",
    ]
  ) assertEquals(normalizeTimeRequirement(text), null, text);
});

Deno.test("parseOpeningHours: 深夜越え (18:00-1:00) は閉店を +24h で扱う", () => {
  assertEquals(parseOpeningHours("18:00-1:00"), { open: 1080, close: 1500 });
  assertEquals(parseOpeningHours("11:30-23:00"), { open: 690, close: 1380 });
  assertEquals(parseOpeningHours("無休"), null);
  assertEquals(parseOpeningHours("24:00-2:00"), { open: 1440, close: 1560 });
  assertEquals(parseOpeningHours("25:00-26:00"), null);
  assertEquals(parseOpeningHours("09:99-10:99"), null);
  assertEquals(parseOpeningHours("99:99-99:59"), null);
});

const morning = normalizeTimeRequirement("朝")!;

Deno.test("compareTimeWindow: 昼開店の店は「朝」に mismatch (issue #312 の実例)", () => {
  assertEquals(compareTimeWindow(morning, "11:30-23:00"), "mismatch");
});

Deno.test("compareTimeWindow: 朝の時間帯と 1 時間以上重なれば match、1 時間未満は partial", () => {
  assertEquals(compareTimeWindow(morning, "8:00-15:00"), "match"); // 8:00-10:00 の 2h
  assertEquals(compareTimeWindow(morning, "6:00-10:00"), "match"); // ちょうど時間帯全体
  assertEquals(compareTimeWindow(morning, "9:30-14:00"), "partial"); // 30 分のみ
});

Deno.test("compareTimeWindow: 閉店後の時間帯は断定しない (最初の営業時間帯のみの claim による取りこぼし対策)", () => {
  // ランチ帯しか claim に無い店の「夜」要件 → 夜営業が別枠の可能性があるため null
  const night = normalizeTimeRequirement("夜")!;
  assertEquals(compareTimeWindow(night, "11:30-14:00"), null);
});

Deno.test("compareTimeWindow: 深夜要件は深夜越え営業・翌日早朝営業の両方に match する", () => {
  const late = normalizeTimeRequirement("深夜")!;
  assertEquals(compareTimeWindow(late, "18:00-1:00"), "match"); // 23:00-1:00 の 2h
  assertEquals(compareTimeWindow(late, "0:00-6:00"), "match"); // 翌日 0:00-5:00
});

Deno.test("compareTimeWindow: 明示範囲と深夜跨ぎ範囲を安全に突合する", () => {
  const evening = normalizeTimeRequirement("18:00-20:00")!;
  const earlyMorning = normalizeTimeRequirement("0:00-2:00")!;
  const overnight = normalizeTimeRequirement("22:00-翌2:00")!;
  assertEquals(compareTimeWindow(evening, "17:00-23:00"), "match");
  assertEquals(compareTimeWindow(evening, "20:00-23:00"), "mismatch");
  assertEquals(compareTimeWindow(earlyMorning, "22:00-2:00"), "match");
  assertEquals(compareTimeWindow(overnight, "18:00-1:00"), "match");
});

Deno.test("compareTimeWindow: 深夜跨ぎclaimの閉店後はmismatchへ偽装せずunknown", () => {
  const morningWindow = normalizeTimeRequirement("朝")!;
  assertEquals(compareTimeWindow(morningWindow, "22:00-2:00"), null);
  assertEquals(compareTimeWindow(morningWindow, "22:00-"), null);
});

// ============================================================
// deterministicEvaluations (requirement × claims → 上書き用評価)
// ============================================================

const evidenceId = "ev-geoapify-0";

function claimOf(
  key: string,
  value: unknown,
  rawText: string,
  ids: string[] = [evidenceId],
): ClaimWithEvidence {
  return { key, value, rawText, evidenceIds: ids };
}

// issue #312 の mock 再現シナリオ: 「安い × 朝」× 夜 6000〜7999 円・17:00 開店の店
const issueRequirements = [
  {
    id: "r-budget",
    kind: "budget",
    originalText: "安い価格帯",
    normalizedText: "安い価格帯",
  },
  {
    id: "r-time",
    kind: "time",
    originalText: "朝の時間帯に営業している",
    normalizedText: "朝の時間帯に営業している",
  },
];
const issueClaims = [
  claimOf(
    "budget_dinner",
    { min: 6000, max: 7999 },
    "予算 6,000～7,999円",
  ),
  claimOf("opening_hours", "17:00-23:30", "営業時間 17:00～23:30"),
];

Deno.test("突合: 予算超過候補で「安い」が mismatch、「朝」も mismatch になり evidenceId が紐づく (issue #312)", () => {
  const out = deterministicEvaluations(issueRequirements, issueClaims);
  const budget = out.get("r-budget");
  assertEquals(budget?.state, "mismatch");
  assertEquals(budget?.evidenceIds, [evidenceId]); // §12: 根拠 Evidence を必ず紐付ける
  assert((budget?.explanation ?? "").includes("上回ります"));
  const time = out.get("r-time");
  assertEquals(time?.state, "mismatch");
  assertEquals(time?.evidenceIds, [evidenceId]);
});

Deno.test("突合: mismatch はスコア降格する (§17 hard_penalty。unknown 温存より下がる)", () => {
  const requirements = [
    { id: "r-budget", priority: "must" as const, weight: 1.0 },
  ];
  const base = {
    requirements,
    evidenceQualities: [0.7],
    evidenceFreshness: [1.0],
    voteValues: [],
    memberCount: 1,
    semanticMatch: 0.5,
  };
  // 従来 (コード突合なし): AI が判断保留 → unknown のまま
  const unknownScore = computeScore({
    ...base,
    evaluations: [{
      requirementId: "r-budget",
      state: "unknown",
      confidence: 0,
    }],
  });
  // 本修正後: 予算超過 claim があるため mismatch → must の hard_penalty で降格
  const det = deterministicEvaluations(issueRequirements, issueClaims).get(
    "r-budget",
  )!;
  const mismatchScore = computeScore({
    ...base,
    evaluations: [{
      requirementId: "r-budget",
      state: det.state,
      confidence: det.confidence,
    }],
  });
  assert(
    mismatchScore < unknownScore,
    `mismatch (${mismatchScore}) が unknown (${unknownScore}) より降格していない`,
  );
  // 予算内の候補 (match) は上に残る
  const matchScore = computeScore({
    ...base,
    evaluations: [{
      requirementId: "r-budget",
      state: "match",
      confidence: 0.9,
    }],
  });
  assert(matchScore > unknownScore);
});

Deno.test("mock再現: 夜営業のみの候補は朝の必須時間条件で降格し、根拠なしはunknown", () => {
  const requirements = [{
    id: "r-time",
    kind: "time",
    originalText: "朝",
    normalizedText: "朝",
    priority: "must" as const,
    weight: 1,
  }];
  const base = {
    requirements,
    evidenceQualities: [0.8],
    evidenceFreshness: [1],
    voteValues: [],
    memberCount: 1,
    semanticMatch: 0.5,
  };
  const nightCandidate = deterministicEvaluations(requirements, [
    claimOf("opening_hours", "17:00-23:30", "mock 夜営業", ["ev-night"]),
  ]).get("r-time")!;
  assertEquals(nightCandidate.state, "mismatch");
  const mismatchScore = computeScore({
    ...base,
    evaluations: [{
      requirementId: "r-time",
      state: nightCandidate.state,
      confidence: nightCandidate.confidence,
    }],
  });
  const unknown = deterministicEvaluations(requirements, []).get("r-time");
  assertEquals(unknown, undefined);
  const unknownScore = computeScore({
    ...base,
    evaluations: [{
      requirementId: "r-time",
      state: "unknown",
      confidence: 0,
    }],
  });
  assert(mismatchScore < unknownScore);
  assertEquals(
    deterministicEvaluations(requirements, [
      claimOf("budget_dinner", { min: 6000, max: 7999 }, "予算"),
    ]).get("r-time"),
    undefined,
  );
});

Deno.test("突合: claim が無い requirement は判定しない (朝×記載なし → unknown 維持)", () => {
  const out = deterministicEvaluations(issueRequirements, [
    claimOf("card_accepted", true, "カード利用可"),
  ]);
  assertEquals(out.size, 0);
  assertEquals(deterministicEvaluations(issueRequirements, []).size, 0);
});

Deno.test("突合: evidenceIds が空の claim では断定しない (§12 Critical Rule)", () => {
  const out = deterministicEvaluations(issueRequirements, [
    claimOf(
      "budget_dinner",
      { min: 6000, max: 7999 },
      "予算 6,000～7,999円",
      [],
    ),
  ]);
  assertEquals(out.get("r-budget"), undefined);
});

Deno.test("突合: 対応claimのない kind・正規化できない文面は上書き対象にしない", () => {
  const out = deterministicEvaluations(
    [
      {
        id: "r-pay",
        kind: "payment",
        originalText: "クレジットカード利用可能",
        normalizedText: "クレジットカード利用可能",
      },
      {
        id: "r-b2",
        kind: "budget",
        originalText: "予算は未定",
        normalizedText: "予算は未定",
      },
    ],
    issueClaims,
  );
  assertEquals(out.size, 0);
});

Deno.test("突合: claim 同士が食い違う場合は partial に留める (§15 と整合)", () => {
  const out = deterministicEvaluations(
    [{
      id: "r-budget",
      kind: "budget",
      originalText: "3000円以内",
      normalizedText: "3000円以内",
    }],
    [
      claimOf("budget_dinner", { min: 2001, max: 3000 }, "予算 2001～3000円", [
        "ev-a",
      ]),
      claimOf(
        "budget_dinner",
        { min: 6000, max: 7999 },
        "予算 6,000～7,999円",
        [
          "ev-b",
        ],
      ),
    ],
  );
  const budget = out.get("r-budget");
  assertEquals(budget?.state, "partial");
  assertEquals(budget?.evidenceIds, ["ev-a", "ev-b"]); // 両論の根拠を残す
});

Deno.test("突合: 予算・営業時間Evidence IDはclaim入力順によらず昇順", () => {
  const requirements = [
    {
      id: "r-budget",
      kind: "budget",
      originalText: "3000円以内",
      normalizedText: "3000円以内",
    },
    {
      id: "r-time",
      kind: "time",
      originalText: "朝",
      normalizedText: "朝",
    },
  ];
  const claims = [
    claimOf("budget_dinner", { min: 1000, max: 2000 }, "budget-b", ["ev-b"]),
    claimOf("budget_dinner", { min: 1200, max: 2200 }, "budget-a", ["ev-a"]),
    claimOf("opening_hours", "6:00-10:00", "hours-b", ["ev-b"]),
    claimOf("opening_hours", "6:30-9:30", "hours-a", ["ev-a"]),
  ];
  const forward = deterministicEvaluations(requirements, claims);
  const reversed = deterministicEvaluations(
    requirements,
    [...claims].reverse(),
  );

  assertEquals(forward, reversed);
  assertEquals(forward.get("r-budget")?.evidenceIds, ["ev-a", "ev-b"]);
  assertEquals(forward.get("r-time")?.evidenceIds, ["ev-a", "ev-b"]);
});

Deno.test("突合: 相反claimが同じmismatch方向でも断定せずpartialに留める", () => {
  const budget = deterministicEvaluations([{
    id: "r-budget",
    kind: "budget",
    originalText: "3000円以下",
    normalizedText: "3000円以下",
  }], [
    claimOf("budget_dinner", { min: 6000, max: 7000 }, "a", ["ev-a"]),
    claimOf("budget_dinner", { min: 8000, max: 9000 }, "b", ["ev-b"]),
  ]).get("r-budget");
  assertEquals(budget?.state, "partial");
  assertEquals(budget?.evidenceIds, ["ev-a", "ev-b"]);

  const time = deterministicEvaluations([{
    id: "r-time",
    kind: "time",
    originalText: "朝",
    normalizedText: "朝",
  }], [
    claimOf("opening_hours", "11:00-14:00", "a", ["ev-a"]),
    claimOf("opening_hours", "12:00-15:00", "b", ["ev-b"]),
  ]).get("r-time");
  assertEquals(time?.state, "partial");
  assertEquals(time?.evidenceIds, ["ev-a", "ev-b"]);
});

Deno.test("突合: range / maxのoperator不一致を上限額だけで同一視しない", () => {
  const out = deterministicEvaluations([{
    id: "r-budget",
    kind: "budget",
    originalText: "予算3000〜5000円",
    normalizedText: "予算5000円以下",
  }], [
    claimOf("budget_dinner", { min: 1000, max: 2000 }, "low"),
  ]);
  assertEquals(out.size, 0);

  const attestedRange = deterministicEvaluations([{
    id: "r-budget",
    kind: "budget",
    originalText: "予算3000〜5000円",
    normalizedText: "予算3000〜5000円",
  }], [
    claimOf("budget_dinner", { min: 1000, max: 2000 }, "low"),
  ]).get("r-budget");
  assertEquals(attestedRange?.state, "mismatch");
});

Deno.test("突合: 万円表現は正規化後の円表現と同じbudget intentとして判定する", () => {
  const out = deterministicEvaluations([{
    id: "r-budget-man",
    kind: "budget",
    originalText: "予算1万円以下",
    normalizedText: "予算10000円以下",
  }], [claimOf("budget_dinner", { min: 6000, max: 7999 }, "夕食予算")]);
  assertEquals(out.get("r-budget-man")?.state, "match");
});

Deno.test("突合: aroundは初回も再利用factsと同じくtargetを含む帯ならmatch", () => {
  const out = deterministicEvaluations([{
    id: "r-budget",
    kind: "budget",
    originalText: "予算3000円前後",
    normalizedText: "予算3000円前後",
  }], [
    claimOf("budget_dinner", { min: 2500, max: 3500 }, "range"),
  ]).get("r-budget");
  assertEquals(out?.state, "match");
});

Deno.test("突合: 時間帯 claim が判定不能 (閉店後) のみなら上書きしない", () => {
  const out = deterministicEvaluations(
    [{
      id: "r-time",
      kind: "time",
      originalText: "夜に営業している",
      normalizedText: "夜に営業している",
    }],
    [claimOf("opening_hours", "11:30-14:00", "営業時間 11:30～14:00")],
  );
  assertEquals(out.get("r-time"), undefined);
});

Deno.test("突合: 不正な claim value (型不一致) は無視して null 安全に扱う", () => {
  const out = deterministicEvaluations(issueRequirements, [
    claimOf("budget_dinner", "6000円", "予算 6000円"), // {min,max} でない
    claimOf("opening_hours", { open: "17:00" }, "営業時間"), // string でない
  ]);
  assertEquals(out.size, 0);
});

// ============================================================
// applyClaimMatchingOverrides (pipeline.ts evaluate ステップの上書き)
// ============================================================

function rowOf(
  requirementId: string,
  state: EvaluationRow["state"],
  confidence: number | null,
): EvaluationRow {
  return {
    investigation_id: "inv-1",
    candidate_id: "cand-1",
    requirement_id: requirementId,
    state,
    confidence,
    explanation: "AI による評価",
    evidence_ids: ["ev-ai"],
  };
}

const pipelineRequirements = issueRequirements.map((r) => ({
  ...r,
  originalText: r.normalizedText,
  priority: "must",
  sourceAttested: true,
}));

Deno.test("突合: attested originalTextとnormalizedTextが不一致・空なら全stateを上書きしない", () => {
  for (const originalText of ["3000円以下ではない", ""]) {
    const out = deterministicEvaluations([{
      id: "r-budget",
      kind: "budget",
      originalText,
      normalizedText: "3000円以下",
    }], [
      claimOf("budget_dinner", { min: 2000, max: 2800 }, "LEGACY_SECRET"),
    ]);
    assertEquals(out.size, 0, originalText);
  }
});

Deno.test("突合: explanationはclaim.rawTextを再掲せず検証済みvalueから生成する", () => {
  const sentinel = "LEGACY_SECRET_REQUIREMENT";
  const out = deterministicEvaluations(issueRequirements, [
    claimOf("budget_dinner", { min: 6000, max: 7999 }, sentinel),
    claimOf("opening_hours", "17:00-23:30", sentinel),
  ]);
  assertEquals(out.get("r-budget")?.explanation.includes(sentinel), false);
  assertEquals(out.get("r-time")?.explanation.includes(sentinel), false);
  assertEquals(out.get("r-budget")?.explanation.includes("6000〜7999円"), true);
  assertEquals(out.get("r-time")?.explanation.includes("17:00〜23:30"), true);
});

Deno.test("上書き: AI が match でもコード突合が mismatch なら mismatch を優先する (#312)", () => {
  const rows = [rowOf("r-budget", "match", 0.9), rowOf("r-time", "unknown", 0)];
  applyClaimMatchingOverrides(rows, pipelineRequirements, issueClaims);
  assertEquals(rows[0].state, "mismatch");
  assertEquals(rows[0].evidence_ids, [evidenceId]); // 根拠 claim の Evidence へ差し替え
  assert(rows[0].explanation.includes("予算条件"));
  // AI が unknown 止まりだった時間帯要件も claim から判定される
  assertEquals(rows[1].state, "mismatch");
});

Deno.test("上書き: claim が無い場合は AI 評価のまま (従来どおり)", () => {
  const rows = [rowOf("r-budget", "match", 0.9), rowOf("r-time", "unknown", 0)];
  applyClaimMatchingOverrides(rows, pipelineRequirements, [
    claimOf("card_accepted", true, "カード利用可"),
  ]);
  assertEquals(rows[0].state, "match");
  assertEquals(rows[0].confidence, 0.9);
  assertEquals(rows[0].evidence_ids, ["ev-ai"]);
  assertEquals(rows[1].state, "unknown");
});

Deno.test("上書き: 予算内の claim なら AI の unknown が match へ引き上がる", () => {
  const rows = [rowOf("r-budget", "unknown", 0)];
  applyClaimMatchingOverrides(rows, pipelineRequirements, [
    claimOf("budget_dinner", { min: 2001, max: 3000 }, "予算 2001～3000円"),
  ]);
  assertEquals(rows[0].state, "match");
  assertEquals(rows[0].evidence_ids, [evidenceId]);
});
