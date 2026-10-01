// Cerebras Pre-Rank provider (Issue #596)。
//
// Cerebras の gpt-oss-120b は OpenAI 互換 Chat Completions と Structured Outputs を
// 提供するが、返却値は外部入力である。OpenRouter と同じ PreRankProvider 契約へ閉じ込め、
// ローカル Zod 検証、bounded retry、決定論 fallback を必ず通す。
//
// API key が無い場合は fetch を一度も呼ばず、決定論結果と固定の未設定理由を返す。
// この adapter は非ストリーミング応答だけを使うため TTFT は測定できず null のままにする。
import { preRankOutputSchema } from "../validation.ts";
import { z } from "zod";
import {
  deterministicPreRank,
  mergePreRankResults,
  type PreRankCandidate,
  type PreRankRequirement,
  type PreRankResult,
} from "../prerank.ts";
import type { PreRankOutcome, PreRankProvider } from "./types.ts";

export const CEREBRAS_CHAT_COMPLETIONS_URL =
  "https://api.cerebras.ai/v1/chat/completions";
export const CEREBRAS_DEFAULT_MODEL = "gpt-oss-120b";
export const CEREBRAS_NOT_CONFIGURED = "cerebras_not_configured";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 2;
const MIN_MAX_OUTPUT_TOKENS = 10_240;
const MAX_MAX_OUTPUT_TOKENS = 32_768;
const TOKENS_PER_CANDIDATE = 240;

// Structured Output本文だけでなく、外部providerのenvelopeもローカルで検証する。
// 未知fieldは捨て、後段が参照する最小fieldだけを許容する。
const CEREBRAS_RESPONSE_SCHEMA = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
    }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().finite().nonnegative().optional(),
    completion_tokens: z.number().finite().nonnegative().optional(),
    completion_tokens_details: z.object({
      reasoning_tokens: z.number().finite().nonnegative().optional(),
    }).optional(),
    reasoning_tokens: z.number().finite().nonnegative().optional(),
  }).optional(),
});

export interface CerebrasPreRankProviderOptions {
  // null は明示的に未設定を意味し、テストで環境変数を参照しないために使う。
  apiKey?: string | null;
  model?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// Cerebras Structured Outputs に渡すwire schema。response_formatのstrict要件に合わせ、
// ネストしたobjectにもadditionalProperties=falseを付ける。
const PRE_RANK_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          pre_score: { type: "number" },
          known_match: { type: "array", items: { type: "string" } },
          known_mismatch: { type: "array", items: { type: "string" } },
          unknown: { type: "array", items: { type: "string" } },
          research_priority: { type: "number" },
          reason_codes: { type: "array", items: { type: "string" } },
        },
        required: [
          "id",
          "pre_score",
          "known_match",
          "known_mismatch",
          "unknown",
          "research_priority",
          "reason_codes",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

// 候補・要件に依存しない固定system prompt。未知情報を推測させず、raw queryやEvidence本文を
// このproviderへ渡さない。候補固有の値はuser messageのJSONだけに限定する。
const SYSTEM_PROMPT = [
  "あなたは飲食店候補の事前選抜 (pre-rank) を行うアシスタントです。",
  "目的は順位の確定ではなく、この後に高価な Web 調査へ回す候補を選ぶことです。",
  "",
  "厳守するルール:",
  "1. 与えられた既知情報 (known_claims / categories / distance_m) だけで判断する。",
  "   Web上の未知情報、店名からの連想、候補や要件の創作は禁止する。",
  "2. unknown は mismatch ではない。情報が無い要件は unknown にし、減点しない。",
  "3. known_mismatch は既知情報が要件と明確に矛盾する場合だけにする。",
  "4. pre_score と research_priority は 0..1。既知情報が無ければ pre_score は 0.5。",
  "5. 入力に無い id を作らず、自由文を返さない。理由は reason_codes で表す。",
].join("\n");

function userPrompt(
  candidates: PreRankCandidate[],
  requirements: PreRankRequirement[],
  previousError: string | null,
): string {
  const payload = {
    requirements: requirements.map((r) => ({
      rid: r.id,
      text: r.normalizedText,
      kind: r.kind,
      priority: r.priority,
      weight: r.weight,
    })),
    candidates: candidates.map((c) => ({
      id: c.id,
      name: c.name,
      distance_m: c.distanceM,
      categories: c.categories,
      known_claims: Object.fromEntries(
        c.knownClaims.map((claim) => [claim.key, claim.value]),
      ),
    })),
  };
  return [
    previousError
      ? `前回の出力を検証できませんでした。固定エラーコードを修正してください: ${previousError}`
      : "",
    JSON.stringify(payload),
  ].filter(Boolean).join("\n");
}

function configuredKey(options: CerebrasPreRankProviderOptions): string | null {
  const value = "apiKey" in options
    ? options.apiKey
    : Deno.env.get("CEREBRAS_API_KEY");
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function configuredModel(options: CerebrasPreRankProviderOptions): string {
  const value = "model" in options
    ? options.model
    : Deno.env.get("CEREBRAS_MODEL");
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : CEREBRAS_DEFAULT_MODEL;
}

function configuredTimeout(options: CerebrasPreRankProviderOptions): number {
  if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) {
    return options.timeoutMs > 0
      ? Math.min(options.timeoutMs, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  }
  const value = Number.parseInt(Deno.env.get("PRE_RANK_TIMEOUT_MS") ?? "", 10);
  return Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

function maxOutputTokens(candidateCount: number): number {
  const configured = Number.parseInt(
    Deno.env.get("PRE_RANK_MAX_OUTPUT_TOKENS") ?? "",
    10,
  );
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, MAX_MAX_OUTPUT_TOKENS);
  }
  return Math.min(
    MIN_MAX_OUTPUT_TOKENS + candidateCount * TOKENS_PER_CANDIDATE,
    MAX_MAX_OUTPUT_TOKENS,
  );
}

// gpt-oss-120b は low/medium/high を受け付ける。noneは別モデル向けなので、
// 不正値をそのまま送らず、最小のlowへ安全側に戻す。
function reasoningEffort(): "low" | "medium" | "high" {
  const value = Deno.env.get("CEREBRAS_REASONING_EFFORT");
  return value === "medium" || value === "high" ? value : "low";
}

export class CerebrasPreRankProvider implements PreRankProvider {
  readonly id = "cerebras";
  private readonly apiKey: string | null;
  private readonly modelName: string;
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CerebrasPreRankProviderOptions = {}) {
    this.apiKey = configuredKey(options);
    this.modelName = configuredModel(options);
    this.timeout = configuredTimeout(options);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async preRank(
    candidates: PreRankCandidate[],
    requirements: PreRankRequirement[],
  ): Promise<PreRankOutcome> {
    const started = Date.now();
    const deterministic = deterministicPreRank(candidates, requirements);
    const base = {
      provider: this.id,
      inputTokens: null as number | null,
      outputTokens: null as number | null,
      reasoningTokens: null as number | null,
    };

    if (candidates.length === 0 || requirements.length === 0) {
      return {
        ...base,
        results: deterministic,
        acceptedIds: [],
        rejectedIds: [],
        fallbackReason: "empty_input",
        attempts: 0,
        apiLatencyMs: null,
        ttftMs: null,
        latencyMs: Date.now() - started,
      };
    }

    // live adapterの未設定は通常障害と区別する。ここでreturnするため、秘密情報なしの
    // ローカル実行・CIでは外部I/Oが発生しない。
    if (!this.apiKey) {
      return {
        ...base,
        results: deterministic,
        acceptedIds: [],
        rejectedIds: [],
        fallbackReason: CEREBRAS_NOT_CONFIGURED,
        attempts: 0,
        apiLatencyMs: null,
        ttftMs: null,
        latencyMs: Date.now() - started,
      };
    }

    let lastError = "";
    let attempts = 0;
    let apiLatencyMs = 0;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let reasoningTokens: number | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      attempts++;
      const callStarted = Date.now();
      try {
        const response = await this.call(
          userPrompt(
            candidates,
            requirements,
            attempt === 0 ? null : lastError,
          ),
          candidates.length,
        );
        apiLatencyMs += Date.now() - callStarted;
        inputTokens = response.inputTokens;
        outputTokens = response.outputTokens;
        reasoningTokens = response.reasoningTokens;

        if (response.truncated) {
          lastError = "output_truncated";
          continue;
        }
        if (!response.content.trim()) {
          lastError = "empty_content";
          continue;
        }

        let decoded: unknown;
        try {
          decoded = JSON.parse(response.content);
        } catch {
          decoded = null;
        }
        const parsed = preRankOutputSchema.safeParse(decoded);
        if (!parsed.success) {
          lastError = "schema_invalid";
          continue;
        }
        if (parsed.data.candidates.length === 0) {
          lastError = "empty_output";
          continue;
        }

        // deterministic側でunknownだった要件を、AIの推測だけでmatch/mismatchへ
        // 昇格させない。known claimが無い候補を後段のResearch前に落とさないための
        // provider共通境界であり、unknown != mismatchをローカルでも再確認する。
        const safeAiResults = preserveDeterministicUnknown(
          deterministic,
          parsed.data.candidates.map(toPreRankResult),
        );
        const merged = mergePreRankResults(deterministic, safeAiResults);
        console.log(
          `[prerank] provider=cerebras candidates=${candidates.length} accepted=${merged.acceptedIds.length} rejected=${merged.rejectedIds.length} attempts=${attempts} inTok=${inputTokens} outTok=${outputTokens} reasoningTok=${reasoningTokens}`,
        );
        return {
          ...base,
          results: merged.merged,
          acceptedIds: merged.acceptedIds,
          rejectedIds: merged.rejectedIds,
          fallbackReason: null,
          attempts,
          inputTokens,
          outputTokens,
          reasoningTokens,
          apiLatencyMs,
          ttftMs: null,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        apiLatencyMs += Date.now() - callStarted;
        lastError = errorCode(error);
      }
    }

    console.log(
      `[prerank] provider=cerebras fallback=deterministic attempts=${attempts} reason=${
        lastError || "unknown_error"
      }`,
    );
    return {
      ...base,
      results: deterministic,
      acceptedIds: [],
      rejectedIds: [],
      fallbackReason: lastError || "unknown_error",
      attempts,
      inputTokens,
      outputTokens,
      reasoningTokens,
      apiLatencyMs,
      ttftMs: null,
      latencyMs: Date.now() - started,
    };
  }

  private async call(prompt: string, candidateCount: number): Promise<{
    content: string;
    truncated: boolean;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
  }> {
    const response = await this.fetchImpl(CEREBRAS_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(this.timeout),
      body: JSON.stringify({
        model: this.modelName,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_completion_tokens: maxOutputTokens(candidateCount),
        reasoning_effort: reasoningEffort(),
        temperature: 0,
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "pre_rank",
            strict: true,
            schema: PRE_RANK_SCHEMA,
          },
        },
      }),
    });

    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // API本文をログへ出さず、固定statusだけをretry/fallback理由にする。
      }
      throw new Error(`cerebras_http_${response.status}`);
    }

    const parsed = CEREBRAS_RESPONSE_SCHEMA.safeParse(await response.json());
    if (!parsed.success) throw new Error("cerebras_invalid_envelope");
    const data = parsed.data;
    const choice = data.choices[0];
    return {
      content: typeof choice?.message?.content === "string"
        ? choice.message.content
        : "",
      truncated: choice?.finish_reason === "length",
      inputTokens: nonNegativeNumberOrNull(data?.usage?.prompt_tokens),
      outputTokens: nonNegativeNumberOrNull(data?.usage?.completion_tokens),
      reasoningTokens: nonNegativeNumberOrNull(
        data?.usage?.completion_tokens_details?.reasoning_tokens ??
          data?.usage?.reasoning_tokens,
      ),
    };
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const status = error.message.match(/^cerebras_http_(\d{3})$/)?.[1];
    if (status) return `http_${status}`;
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timeout";
    }
  }
  return "provider_error";
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function preserveDeterministicUnknown(
  deterministic: PreRankResult[],
  aiResults: PreRankResult[],
): PreRankResult[] {
  const byId = new Map(deterministic.map((result) => [result.id, result]));
  return aiResults.map((result) => {
    const baseline = byId.get(result.id);
    if (!baseline || baseline.unknown.length === 0) return result;
    const unknown = new Set(baseline.unknown);
    return {
      ...result,
      knownMatch: result.knownMatch.filter((id) => !unknown.has(id)),
      knownMismatch: result.knownMismatch.filter((id) => !unknown.has(id)),
    };
  });
}

function toPreRankResult(c: {
  id: string;
  pre_score: number;
  known_match: string[];
  known_mismatch: string[];
  unknown: string[];
  research_priority: number;
  reason_codes: string[];
}): PreRankResult {
  return {
    id: c.id,
    preScore: c.pre_score,
    knownMatch: c.known_match,
    knownMismatch: c.known_mismatch,
    unknown: c.unknown,
    researchPriority: c.research_priority,
    reasonCodes: c.reason_codes,
  };
}
