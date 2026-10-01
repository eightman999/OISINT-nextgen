// getPreRankProvider / preRankLimits の分岐テスト (issue #552)。
// provider 切替と候補数の既定値がここ 1 箇所に閉じていることを守る。
import { assertEquals, assertThrows } from "@std/assert";
import {
  type PreRankCandidate,
  type PreRankResult,
  selectResearchCandidates,
} from "../functions/_shared/prerank.ts";
import {
  getPreRankProvider,
  limitResearchProviderCalls,
  preRankLimits,
} from "../functions/_shared/providers/index.ts";
import {
  DEFAULT_RESEARCH_COST_MICROS,
  policyForTier,
} from "../functions/_shared/research_policy.ts";

function withEnv(vars: Record<string, string | null>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = Deno.env.get(k);
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("getPreRankProvider: 既定は deterministic (外部 API を増やさない)", () => {
  withEnv({ DATA_PROVIDER_MODE: "live", PRE_RANK_PROVIDER: null }, () => {
    assertEquals(getPreRankProvider().id, "deterministic");
  });
});

Deno.test("getPreRankProvider: PRE_RANK_PROVIDER=openrouter で切り替わる", () => {
  withEnv(
    { DATA_PROVIDER_MODE: "live", PRE_RANK_PROVIDER: "openrouter" },
    () => {
      assertEquals(getPreRankProvider().id, "openrouter");
    },
  );
});

Deno.test("getPreRankProvider: mock モードでは外部 API provider を選ばない", () => {
  withEnv(
    { DATA_PROVIDER_MODE: "mock", PRE_RANK_PROVIDER: "openrouter" },
    () => {
      assertEquals(getPreRankProvider().id, "mock");
    },
  );
});

Deno.test("getPreRankProvider: 未知の値は起動時に落とす", () => {
  withEnv({ DATA_PROVIDER_MODE: "live", PRE_RANK_PROVIDER: "deepseek" }, () => {
    assertThrows(() => getPreRankProvider(), Error, "未知の PRE_RANK_PROVIDER");
  });
});

Deno.test("preRankLimits: 未設定なら現行どおり 3 件固定 (§5.4 Hard Rule 2)", () => {
  withEnv({
    BROAD_CANDIDATE_LIMIT: null,
    EXPLORATION_SLOTS: null,
  }, () => {
    assertEquals(preRankLimits(), {
      broadLimit: 3,
      preRankLimit: 3,
      researchLimit: 3,
      explorationSlots: 0,
    });
  });
});

Deno.test("preRankLimits: policyなしのlegacy経路は従来設定を維持する", () => {
  withEnv({
    BROAD_CANDIDATE_LIMIT: "24",
    RESEARCH_CANDIDATE_LIMIT: "8",
    EXPLORATION_SLOTS: "99",
  }, () => {
    assertEquals(preRankLimits(), {
      broadLimit: 24,
      preRankLimit: 24,
      researchLimit: 3,
      explorationSlots: 3,
    });
  });
  withEnv({
    BROAD_CANDIDATE_LIMIT: "1",
    RESEARCH_CANDIDATE_LIMIT: "12",
    EXPLORATION_SLOTS: "1",
  }, () => {
    assertEquals(preRankLimits(), {
      broadLimit: 3,
      preRankLimit: 3,
      researchLimit: 3,
      explorationSlots: 1,
    });
  });
});

Deno.test("preRankLimits: 不正値は既定へ丸める", () => {
  withEnv({
    BROAD_CANDIDATE_LIMIT: "0",
    RESEARCH_CANDIDATE_LIMIT: "abc",
    EXPLORATION_SLOTS: "-5",
  }, () => {
    assertEquals(preRankLimits(), {
      broadLimit: 3,
      preRankLimit: 3,
      researchLimit: 3,
      explorationSlots: 0,
    });
  });
});

Deno.test("preRankLimits: Free/Plus policyのstage上限を実際の実行値へ渡す", () => {
  withEnv({
    BROAD_CANDIDATE_LIMIT: "100",
    EXPLORATION_SLOTS: "99",
  }, () => {
    assertEquals(
      preRankLimits(policyForTier("free")),
      {
        broadLimit: 3,
        preRankLimit: 3,
        researchLimit: 3,
        explorationSlots: 3,
      },
    );
    assertEquals(
      preRankLimits(policyForTier("plus", DEFAULT_RESEARCH_COST_MICROS, {
        broadCandidateLimit: 12,
        preRankCandidateLimit: 8,
        researchCandidateLimit: 6,
        providerCallLimit: 6,
      })),
      {
        broadLimit: 12,
        preRankLimit: 8,
        researchLimit: 6,
        explorationSlots: 6,
      },
    );
  });
  withEnv({
    BROAD_CANDIDATE_LIMIT: "3",
    EXPLORATION_SLOTS: "99",
  }, () => {
    assertEquals(
      preRankLimits(policyForTier("plus", DEFAULT_RESEARCH_COST_MICROS, {
        broadCandidateLimit: 12,
        preRankCandidateLimit: 8,
        researchCandidateLimit: 6,
        providerCallLimit: 6,
      })),
      {
        broadLimit: 3,
        preRankLimit: 8,
        researchLimit: 6,
        explorationSlots: 6,
      },
    );
  });
});

Deno.test("research selection: Plus policyは実際のResearch対象数をFreeより増やす", () => {
  const candidates: PreRankCandidate[] = Array.from(
    { length: 6 },
    (_, index) => ({
      id: `candidate-${index}`,
      name: `candidate-${index}`,
      provider: "fixture",
      distanceM: index,
      categories: [],
      knownClaims: [],
    }),
  );
  const results: PreRankResult[] = candidates.map((candidate) => ({
    id: candidate.id,
    preScore: 0.5,
    knownMatch: [],
    knownMismatch: [],
    unknown: [],
    researchPriority: 1,
    reasonCodes: [],
  }));
  const freePolicy = policyForTier("free");
  const plusPolicy = policyForTier("plus", DEFAULT_RESEARCH_COST_MICROS, {
    broadCandidateLimit: 12,
    preRankCandidateLimit: 8,
    researchCandidateLimit: 6,
    providerCallLimit: 6,
  });
  const free = preRankLimits(freePolicy);
  const plus = preRankLimits(plusPolicy);
  const freeSelection = selectResearchCandidates(candidates, results, free);
  const plusSelection = selectResearchCandidates(candidates, results, plus);
  assertEquals(freeSelection.selected.length, 3);
  assertEquals(plusSelection.selected.length, 6);
  assertEquals(limitResearchProviderCalls(candidates, freePolicy).length, 3);
  assertEquals(limitResearchProviderCalls(candidates, plusPolicy).length, 6);
});
