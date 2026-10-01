// OpenRouter Pre-Rank provider のテスト (issue #552)。
// 検証したいのは「OpenRouter/DeepSeek の JSON Output は valid JSON までしか保証しない」
// 前提で、empty / truncated / invalid / 障害のどれでも Investigation を落とさないこと。
import { assert, assertEquals } from "@std/assert";
import { OpenRouterPreRankProvider } from "../functions/_shared/providers/openrouter.ts";
import {
  NEUTRAL_PRE_SCORE,
  type PreRankCandidate,
  type PreRankRequirement,
} from "../functions/_shared/prerank.ts";

const REQUIREMENTS: PreRankRequirement[] = [
  {
    id: "r1",
    kind: "budget",
    priority: "must",
    weight: 1,
    normalizedText: "予算は3000円以内",
    originalText: "予算は3000円以内",
  },
];

const CANDIDATES: PreRankCandidate[] = [
  {
    id: "geoapify:a",
    name: "店A",
    provider: "geoapify",
    distanceM: 320,
    categories: ["yakiniku"],
    knownClaims: [],
  },
  {
    id: "geoapify:b",
    name: "店B",
    provider: "geoapify",
    distanceM: 500,
    categories: ["izakaya"],
    knownClaims: [],
  },
];

// fetch をスタブして OpenRouter レスポンスを差し替える。
// 実 API は叩かない (テストはネットワーク不要)
function withFetch(
  responses: Array<() => Response | Promise<Response>>,
  fn: (calls: { bodies: unknown[] }) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: { bodies: unknown[] } = { bodies: [] };
  let i = 0;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    calls.bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const next = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve(next());
  }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

function chatResponse(
  content: string,
  finishReason = "stop",
): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function validPayload(): string {
  return JSON.stringify({
    candidates: [
      {
        id: "geoapify:a",
        pre_score: 0.82,
        known_match: [],
        known_mismatch: [],
        unknown: ["r1"],
        research_priority: 0.91,
        reason_codes: ["MISSING_BUDGET"],
      },
    ],
  });
}

Deno.env.set("OPENROUTER_API_KEY", "test-key");

Deno.test("OpenRouter: 正常応答を取り込み、返らなかった候補は決定論のまま残す", async () => {
  await withFetch([() => chatResponse(validPayload())], async (calls) => {
    const out = await new OpenRouterPreRankProvider().preRank(
      CANDIDATES,
      REQUIREMENTS,
    );
    assertEquals(out.fallbackReason, null);
    assertEquals(out.acceptedIds, ["geoapify:a"]);
    assertEquals(out.results.length, 2);
    assertEquals(out.results[0].preScore, 0.82);
    assertEquals(out.results[1].preScore, NEUTRAL_PRE_SCORE); // 決定論のまま
    assertEquals(out.inputTokens, 120);
    assertEquals(out.outputTokens, 45);
    assertEquals(out.reasoningTokens, 0);
    assertEquals(out.attempts, 1);

    // 既知情報しか送っていないこと (issue #552: 事実の発明者にしない)
    const body = calls.bodies[0] as {
      messages: Array<{ role: string; content: string }>;
      temperature: number;
    };
    const user = JSON.parse(body.messages[1].content);
    assertEquals(Object.keys(user).sort(), ["candidates", "requirements"]);
    assertEquals(Object.keys(user.candidates[0]).sort(), [
      "categories",
      "distance_m",
      "id",
      "known_claims",
      "name",
    ]);
    assertEquals(body.temperature, 0); // 再現性優先
  });
});

Deno.test("OpenRouter: empty content は 1 回だけ retry する", async () => {
  await withFetch(
    [() => chatResponse(""), () => chatResponse(validPayload())],
    async () => {
      const out = await new OpenRouterPreRankProvider().preRank(
        CANDIDATES,
        REQUIREMENTS,
      );
      assertEquals(out.attempts, 2);
      assertEquals(out.fallbackReason, null);
      assertEquals(out.acceptedIds, ["geoapify:a"]);
    },
  );
});

Deno.test("OpenRouter: retry しても empty なら決定論 fallback (候補を消さない)", async () => {
  await withFetch([() => chatResponse("")], async () => {
    const out = await new OpenRouterPreRankProvider().preRank(
      CANDIDATES,
      REQUIREMENTS,
    );
    assertEquals(out.attempts, 2); // 無限リトライしない (§30)
    assertEquals(out.fallbackReason, "empty content");
    assertEquals(out.results.length, 2); // fail-open
    assertEquals(out.acceptedIds, []);
  });
});

Deno.test("OpenRouter: truncation (finish_reason=length) を検出して fallback する", async () => {
  await withFetch(
    [() => chatResponse('{"candidates":[{"id":"hotpe', "length")],
    async () => {
      const out = await new OpenRouterPreRankProvider().preRank(
        CANDIDATES,
        REQUIREMENTS,
      );
      assert(out.fallbackReason?.includes("truncated"));
      assertEquals(out.results.length, 2);
    },
  );
});

Deno.test("OpenRouter: schema 不一致は棄却して決定論 fallback する", async () => {
  await withFetch(
    [() =>
      chatResponse(
        JSON.stringify({ candidates: [{ id: "geoapify:a" }] }),
      )],
    async () => {
      const out = await new OpenRouterPreRankProvider().preRank(
        CANDIDATES,
        REQUIREMENTS,
      );
      assert(out.fallbackReason !== null);
      assertEquals(out.results.length, 2);
      assertEquals(out.results[0].preScore, NEUTRAL_PRE_SCORE);
    },
  );
});

Deno.test("OpenRouter: HTTP エラーでも throw せず決定論 fallback する", async () => {
  await withFetch(
    [() => new Response("rate limited", { status: 429 })],
    async () => {
      const out = await new OpenRouterPreRankProvider().preRank(
        CANDIDATES,
        REQUIREMENTS,
      );
      assert(out.fallbackReason?.includes("429"));
      assertEquals(out.results.length, 2);
    },
  );
});

Deno.test("OpenRouter: 候補ゼロなら API を呼ばない", async () => {
  await withFetch([() => chatResponse(validPayload())], async (calls) => {
    const out = await new OpenRouterPreRankProvider().preRank([], REQUIREMENTS);
    assertEquals(calls.bodies.length, 0);
    assertEquals(out.fallbackReason, "empty_input");
    assertEquals(out.results, []);
  });
});

Deno.test("OpenRouter: OPENROUTER_PROVIDER_ORDER で host provider を pin する", async () => {
  Deno.env.set("OPENROUTER_PROVIDER_ORDER", "deepseek, novita");
  try {
    await withFetch([() => chatResponse(validPayload())], async (calls) => {
      await new OpenRouterPreRankProvider().preRank(CANDIDATES, REQUIREMENTS);
      const body = calls.bodies[0] as {
        provider?: { order: string[]; allow_fallbacks: boolean };
      };
      assertEquals(body.provider?.order, ["deepseek", "novita"]);
      assertEquals(body.provider?.allow_fallbacks, false);
    });
  } finally {
    Deno.env.delete("OPENROUTER_PROVIDER_ORDER");
  }
});

// ============================================================
// reasoning / max_tokens の制御 (#552 追補)
// DeepSeek V4 系は thinking が既定 ON・effort 既定 high。放置すると reasoning が
// max_tokens の枠を食い潰し、毎回 finish_reason=length → deterministic fallback になる。
// ============================================================

Deno.test("OpenRouter: 既定で thinking を切る", async () => {
  await withFetch([() => chatResponse(validPayload())], async (calls) => {
    await new OpenRouterPreRankProvider().preRank(CANDIDATES, REQUIREMENTS);
    const body = calls.bodies[0] as {
      reasoning: { effort: string; exclude: boolean; max_tokens?: number };
    };
    assertEquals(body.reasoning.effort, "none");
    assertEquals(body.reasoning.exclude, true);
    // effort=none のときは budget を送らない (thinking 自体が動かないため)
    assertEquals(body.reasoning.max_tokens, undefined);
  });
});

Deno.test("OpenRouter: max_tokens は候補数に応じて伸びる (下限 10K / 上限 32K)", async () => {
  // 候補 2 件 = 10240 + 2*240
  await withFetch([() => chatResponse(validPayload())], async (calls) => {
    await new OpenRouterPreRankProvider().preRank(CANDIDATES, REQUIREMENTS);
    assertEquals(
      (calls.bodies[0] as { max_tokens: number }).max_tokens,
      10_720,
    );
  });

  // 候補 50 件 (#509 の Broad Discovery 想定) でも 32K を超えない
  const many = Array.from({ length: 50 }, (_, i) => ({
    ...CANDIDATES[0],
    id: `geoapify:m${i}`,
  }));
  await withFetch([() => chatResponse(validPayload())], async (calls) => {
    await new OpenRouterPreRankProvider().preRank(many, REQUIREMENTS);
    const max = (calls.bodies[0] as { max_tokens: number }).max_tokens;
    assertEquals(max, 22_240); // 10240 + 50*240
    assert(max <= 32_768);
  });

  // 上限に当たるほどの候補数でも clamp される
  const huge = Array.from({ length: 500 }, (_, i) => ({
    ...CANDIDATES[0],
    id: `geoapify:h${i}`,
  }));
  await withFetch([() => chatResponse(validPayload())], async (calls) => {
    await new OpenRouterPreRankProvider().preRank(huge, REQUIREMENTS);
    assertEquals(
      (calls.bodies[0] as { max_tokens: number }).max_tokens,
      32_768,
    );
  });
});

Deno.test("OpenRouter: reasoning を有効化しても出力枠の 1/4 を超えさせない", async () => {
  Deno.env.set("PRE_RANK_REASONING_EFFORT", "low");
  try {
    await withFetch([() => chatResponse(validPayload())], async (calls) => {
      await new OpenRouterPreRankProvider().preRank(CANDIDATES, REQUIREMENTS);
      const body = calls.bodies[0] as {
        max_tokens: number;
        reasoning: { effort: string; max_tokens: number };
      };
      assertEquals(body.reasoning.effort, "low");
      assertEquals(body.reasoning.max_tokens, 2_680); // 10720 / 4
      // JSON 本体のための枠が必ず残る
      assert(body.reasoning.max_tokens < body.max_tokens);
    });
  } finally {
    Deno.env.delete("PRE_RANK_REASONING_EFFORT");
  }
});

Deno.test("OpenRouter: PRE_RANK_MAX_OUTPUT_TOKENS は候補数見積もりより優先する", async () => {
  Deno.env.set("PRE_RANK_MAX_OUTPUT_TOKENS", "20000");
  try {
    await withFetch([() => chatResponse(validPayload())], async (calls) => {
      await new OpenRouterPreRankProvider().preRank(CANDIDATES, REQUIREMENTS);
      assertEquals(
        (calls.bodies[0] as { max_tokens: number }).max_tokens,
        20_000,
      );
    });
  } finally {
    Deno.env.delete("PRE_RANK_MAX_OUTPUT_TOKENS");
  }
});

Deno.test("OpenRouter: 不正な PRE_RANK_MAX_OUTPUT_TOKENS は候補数見積もりへ戻す", async () => {
  Deno.env.set("PRE_RANK_MAX_OUTPUT_TOKENS", "0");
  try {
    await withFetch([() => chatResponse(validPayload())], async (calls) => {
      await new OpenRouterPreRankProvider().preRank(CANDIDATES, REQUIREMENTS);
      assertEquals(
        (calls.bodies[0] as { max_tokens: number }).max_tokens,
        10_720,
      );
    });
  } finally {
    Deno.env.delete("PRE_RANK_MAX_OUTPUT_TOKENS");
  }
});

Deno.test("OpenRouter: reasoning_tokens を計測して返す (枠食い潰しの検知用)", async () => {
  const withReasoning = () =>
    new Response(
      JSON.stringify({
        choices: [{
          message: { content: validPayload() },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 900,
          completion_tokens_details: { reasoning_tokens: 850 },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  await withFetch([withReasoning], async () => {
    const out = await new OpenRouterPreRankProvider().preRank(
      CANDIDATES,
      REQUIREMENTS,
    );
    assertEquals(out.reasoningTokens, 850);
  });
});
