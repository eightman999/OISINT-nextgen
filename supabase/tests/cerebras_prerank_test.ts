// Issue #596: Cerebras GPT-OSS-120B のPre-Rank adapter契約。
// fixture / mock / live adapterの検証を同じ入力で行うが、実APIは一切呼ばない。
import { assert, assertEquals } from "@std/assert";
import {
  CEREBRAS_CHAT_COMPLETIONS_URL,
  CEREBRAS_DEFAULT_MODEL,
  CEREBRAS_NOT_CONFIGURED,
  CerebrasPreRankProvider,
} from "../functions/_shared/providers/cerebras.ts";
import {
  DeterministicPreRankProvider,
  MockPreRankProvider,
} from "../functions/_shared/providers/prerank_deterministic.ts";
import { getPreRankProvider } from "../functions/_shared/providers/index.ts";
import type {
  PreRankCandidate,
  PreRankRequirement,
} from "../functions/_shared/prerank.ts";

interface FixtureCase {
  id: string;
  candidateCount: number;
  candidates: PreRankCandidate[];
}

interface PrerankFixture {
  schemaVersion: string;
  source: string;
  privacy: {
    containsLiveQueries: boolean;
    containsProviderResponses: boolean;
    containsPersonalData: boolean;
    containsRealPlaceIdentifiers: boolean;
  };
  requirements: PreRankRequirement[];
  cases: FixtureCase[];
}

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/cerebras-prerank-596.json", import.meta.url),
  ),
) as PrerankFixture;

function withEnv(vars: Record<string, string | null>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = Deno.env.get(key);
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

async function withEnvAsync<T>(
  vars: Record<string, string | null>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = Deno.env.get(key);
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function unknownCandidate(testCase: FixtureCase): PreRankCandidate {
  const candidate = testCase.candidates.find((item) =>
    item.knownClaims.length === 0
  );
  if (candidate === undefined) {
    throw new Error(`${testCase.id} にunknown候補が必要`);
  }
  return candidate;
}

function validPayload(candidateId: string): string {
  return JSON.stringify({
    candidates: [{
      id: candidateId,
      pre_score: 0.5,
      known_match: [],
      known_mismatch: [],
      unknown: ["r-budget", "r-cuisine", "r-reservation", "r-atmosphere"],
      research_priority: 1,
      reason_codes: ["UNKNOWN_INPUT"],
    }],
  });
}

function chatResponse(
  content: string,
  finishReason = "stop",
  status = 200,
): Response {
  return new Response(
    status === 200
      ? JSON.stringify({
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 45,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      })
      : "provider error body is never logged",
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function stubFetch(
  responses: Array<Response | (() => Response | Promise<Response>)>,
  calls: Array<{ url: string; init?: RequestInit }>,
): typeof fetch {
  let index = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses[Math.min(index++, responses.length - 1)];
    return typeof response === "function" ? await response() : response;
  }) as typeof fetch;
}

Deno.test("fixture: 20/30/50候補、unknown候補、要件の日本語を固定する", () => {
  assertEquals(fixture.schemaVersion, "issue-596-prerank-fixture.v1");
  assertEquals(fixture.source, "synthetic/anonymized");
  assertEquals(fixture.privacy, {
    containsLiveQueries: false,
    containsProviderResponses: false,
    containsPersonalData: false,
    containsRealPlaceIdentifiers: false,
  });
  assertEquals(fixture.requirements.length, 4);
  assertEquals(
    fixture.requirements.map((requirement) => requirement.kind),
    ["budget", "cuisine", "reservation", "atmosphere"],
  );
  assertEquals(
    fixture.cases.map((testCase) => testCase.candidateCount),
    [20, 30, 50],
  );
  for (const testCase of fixture.cases) {
    assertEquals(testCase.candidates.length, testCase.candidateCount);
    assert(unknownCandidate(testCase).knownClaims.length === 0);
  }
});

Deno.test("mock E2E: deterministicと同じfixtureを外部I/Oなしで完走し、unknownをmismatchにしない", async () => {
  const mock = new MockPreRankProvider();
  const deterministic = new DeterministicPreRankProvider();
  for (const testCase of fixture.cases) {
    const [mockOut, deterministicOut] = await Promise.all([
      mock.preRank(testCase.candidates, fixture.requirements),
      deterministic.preRank(testCase.candidates, fixture.requirements),
    ]);
    assertEquals(mockOut.provider, "mock");
    assertEquals(mockOut.results, deterministicOut.results);
    assertEquals(mockOut.results.length, testCase.candidateCount);
    const unknown = mockOut.results.find((result) =>
      result.id === unknownCandidate(testCase).id
    );
    if (unknown === undefined) throw new Error("unknown結果が必要");
    assert(unknown.unknown.includes("r-budget"));
    assert(!unknown.knownMismatch.includes("r-budget"));
  }
});

Deno.test("factory: PRE_RANK_PROVIDER=cerebrasを選ぶが、mock modeでは外部providerを選ばない", () => {
  withEnv({
    DATA_PROVIDER_MODE: "live",
    PRE_RANK_PROVIDER: "cerebras",
    CEREBRAS_API_KEY: null,
  }, () => {
    assertEquals(getPreRankProvider().id, "cerebras");
  });
  withEnv({
    DATA_PROVIDER_MODE: "mock",
    PRE_RANK_PROVIDER: "cerebras",
    CEREBRAS_API_KEY: null,
  }, () => {
    assertEquals(getPreRankProvider().id, "mock");
  });
});

Deno.test("Cerebras: API key未設定ならfetchせず決定論fallbackする", async () => {
  let calls = 0;
  const forbiddenFetch = (() => {
    calls++;
    throw new Error("external I/O must not happen without a key");
  }) as typeof fetch;
  const testCase = fixture.cases[0];
  const out = await new CerebrasPreRankProvider({
    apiKey: null,
    fetchImpl: forbiddenFetch,
  }).preRank(testCase.candidates, fixture.requirements);
  const expected = await new DeterministicPreRankProvider().preRank(
    testCase.candidates,
    fixture.requirements,
  );
  assertEquals(calls, 0);
  assertEquals(out.provider, "cerebras");
  assertEquals(out.results, expected.results);
  assertEquals(out.fallbackReason, CEREBRAS_NOT_CONFIGURED);
  assertEquals(out.attempts, 0);
  assertEquals(out.inputTokens, null);
  assertEquals(out.outputTokens, null);
  assertEquals(out.reasoningTokens, null);
  assertEquals(out.apiLatencyMs, null);
  assertEquals(out.ttftMs, null);
});

Deno.test("Cerebras: 20/30/50 fixtureを同じwire契約へ送り、unknownを保持する", async () => {
  for (const testCase of fixture.cases) {
    const unknown = unknownCandidate(testCase);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new CerebrasPreRankProvider({
      apiKey: "fixture-key",
      fetchImpl: stubFetch([chatResponse(validPayload(unknown.id))], calls),
    });
    const out = await provider.preRank(
      testCase.candidates,
      fixture.requirements,
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, CEREBRAS_CHAT_COMPLETIONS_URL);
    const body = JSON.parse(String(calls[0].init?.body)) as {
      model: string;
      max_completion_tokens: number;
      reasoning_effort: string;
      temperature: number;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string; json_schema: { strict: boolean } };
    };
    assertEquals(body.model, CEREBRAS_DEFAULT_MODEL);
    assertEquals(
      body.max_completion_tokens,
      10_240 + testCase.candidateCount * 240,
    );
    assertEquals(body.reasoning_effort, "low");
    assertEquals(body.temperature, 0);
    assertEquals(body.stream, false);
    assertEquals(body.response_format.type, "json_schema");
    assertEquals(body.response_format.json_schema.strict, true);
    const user = JSON.parse(body.messages[1].content) as Record<
      string,
      unknown
    >;
    assertEquals(Object.keys(user).sort(), ["candidates", "requirements"]);
    assertEquals(out.fallbackReason, null);
    assertEquals(out.results.length, testCase.candidateCount);
    assert(
      out.results.every((result) =>
        testCase.candidates.some((candidate) => candidate.id === result.id)
      ),
    );
    const unknownResult = out.results.find((result) =>
      result.id === unknown.id
    );
    if (unknownResult === undefined) throw new Error("unknown結果が必要");
    assert(unknownResult.unknown.includes("r-budget"));
    assert(!unknownResult.knownMismatch.includes("r-budget"));
    assertEquals(out.inputTokens, 120);
    assertEquals(out.outputTokens, 45);
    assertEquals(out.reasoningTokens, 0);
    assert(out.apiLatencyMs !== null && out.apiLatencyMs !== undefined);
    assertEquals(out.ttftMs, null);

    const headers = new Headers(calls[0].init?.headers);
    const authorization = headers.get("authorization");
    assert(authorization?.startsWith("Bearer "));
    assert(authorization?.endsWith("fixture-key"));
    assertEquals(headers.get("content-type"), "application/json");
  }
});

Deno.test("Cerebras: envの出力token指定をprovider上限へ制限する", async () => {
  await withEnvAsync({ PRE_RANK_MAX_OUTPUT_TOKENS: "999999999" }, async () => {
    const testCase = fixture.cases[0];
    const unknown = unknownCandidate(testCase);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await new CerebrasPreRankProvider({
      apiKey: "fixture-key",
      fetchImpl: stubFetch([chatResponse(validPayload(unknown.id))], calls),
    }).preRank(testCase.candidates, fixture.requirements);
    const body = JSON.parse(String(calls[0].init?.body)) as {
      max_completion_tokens: number;
    };
    assertEquals(body.max_completion_tokens, 32_768);
  });
});

Deno.test("Cerebras: AIがunknown要件をmismatchへ変えても決定論境界で保持する", async () => {
  const testCase = fixture.cases[0];
  const unknown = unknownCandidate(testCase);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const output = JSON.stringify({
    candidates: [{
      id: unknown.id,
      pre_score: 0,
      known_match: [],
      known_mismatch: ["r-budget"],
      unknown: [],
      research_priority: 0,
      reason_codes: ["BUDGET_MISMATCH"],
    }],
  });
  const out = await new CerebrasPreRankProvider({
    apiKey: "fixture-key",
    fetchImpl: stubFetch([chatResponse(output)], calls),
  }).preRank(testCase.candidates, fixture.requirements);
  const unknownResult = out.results.find((result) => result.id === unknown.id);
  if (unknownResult === undefined) throw new Error("unknown結果が必要");
  assert(unknownResult.unknown.includes("r-budget"));
  assert(!unknownResult.knownMismatch.includes("r-budget"));
});

Deno.test("Cerebras: empty/truncated/schema/429はbounded retryし、失敗時も候補を消さない", async () => {
  const testCase = fixture.cases[0];
  const unknown = unknownCandidate(testCase);
  const scenarios: Array<{
    name: string;
    first: Response | (() => Response | Promise<Response>);
    second?: Response | (() => Response | Promise<Response>);
    expectedFallback: string | null;
  }> = [
    {
      name: "empty content",
      first: chatResponse(""),
      second: chatResponse(validPayload(unknown.id)),
      expectedFallback: null,
    },
    {
      name: "empty output",
      first: chatResponse(JSON.stringify({ candidates: [] })),
      second: chatResponse(validPayload(unknown.id)),
      expectedFallback: null,
    },
    {
      name: "truncated",
      first: chatResponse('{"candidates":[', "length"),
      second: chatResponse(validPayload(unknown.id)),
      expectedFallback: null,
    },
    {
      name: "schema invalid",
      first: chatResponse(JSON.stringify({ candidates: [{ id: unknown.id }] })),
      second: chatResponse(validPayload(unknown.id)),
      expectedFallback: null,
    },
    {
      name: "invalid provider envelope",
      first: new Response(JSON.stringify({ choices: "invalid" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      second: chatResponse(validPayload(unknown.id)),
      expectedFallback: null,
    },
    {
      name: "rate limited",
      first: chatResponse("", "stop", 429),
      second: chatResponse(validPayload(unknown.id)),
      expectedFallback: null,
    },
    {
      name: "server error",
      first: chatResponse("", "stop", 503),
      expectedFallback: "http_503",
    },
    {
      name: "timeout",
      first: () => {
        const error = new Error("fixture timeout");
        error.name = "TimeoutError";
        throw error;
      },
      second: chatResponse(validPayload(unknown.id)),
      expectedFallback: null,
    },
  ];

  for (const scenario of scenarios) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = scenario.second === undefined
      ? [scenario.first]
      : [scenario.first, scenario.second];
    const out = await new CerebrasPreRankProvider({
      apiKey: "fixture-key",
      fetchImpl: stubFetch(responses, calls),
    }).preRank(testCase.candidates, fixture.requirements);
    assertEquals(out.attempts, 2, scenario.name);
    assertEquals(out.fallbackReason, scenario.expectedFallback, scenario.name);
    assertEquals(out.results.length, testCase.candidateCount, scenario.name);
    if (scenario.expectedFallback === null) {
      assert(out.acceptedIds.includes(unknown.id), scenario.name);
    } else {
      assertEquals(out.acceptedIds, [], scenario.name);
    }
  }
});

Deno.test("Cerebras: empty inputでもAPIを呼ばず、provider response本文を保持しない", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const out = await new CerebrasPreRankProvider({
    apiKey: "fixture-key",
    fetchImpl: stubFetch([chatResponse("should not be called")], calls),
  }).preRank([], fixture.requirements);
  assertEquals(calls.length, 0);
  assertEquals(out.fallbackReason, "empty_input");
  assertEquals(out.results, []);
  assertEquals(out.apiLatencyMs, null);
  assertEquals(out.ttftMs, null);
});
