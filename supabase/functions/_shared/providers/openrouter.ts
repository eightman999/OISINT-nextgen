// OpenRouter Pre-Rank provider (issue #552)。
//
// OpenRouter を primary にする理由 (issue #552 §DeepSeek API Provider Decision の
// secondary 案を primary へ倒した判断):
//   - OpenAI 互換の単一 endpoint で DeepSeek V4 Flash / 他モデルを差し替えられる
//   - provider outage 時の自動 fallback があり可用性が高い
//   - A/B benchmark と将来の model routing を同じ経路で回せる
// ただし **pre-rank 品質の再現性を測るときは host provider を pin する**
// (OPENROUTER_PROVIDER_ORDER)。自動 routing のままだと host 差が benchmark に混ざる。
//
// 重要な前提: OpenRouter / DeepSeek の JSON Output は「valid JSON」までしか保証しない。
// Gemini の Structured Output と同格に扱わず、以下を必須にする (issue #552 Important caveat):
//   - local Zod validation (validation.ts preRankOutputSchema)
//   - empty response / truncation (finish_reason=length) の検出
//   - bounded retry (合計 2 回まで)
//   - fail-open。候補を全削除しない
//   - 失敗時は決定論 pre-rank へ fallback し、**throw しない**
import { preRankOutputSchema } from "../validation.ts";
import {
  deterministicPreRank,
  mergePreRankResults,
  type PreRankCandidate,
  type PreRankRequirement,
  type PreRankResult,
} from "../prerank.ts";
import type { PreRankOutcome, PreRankProvider } from "./types.ts";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 2; // 初回 + retry 1 回 (§30 無限リトライ禁止)

// pre-rank の出力上限。切り捨てられると JSON が壊れて丸ごと fallback になるので
// 候補数に応じて伸ばす (BROAD_CANDIDATE_LIMIT は 20〜50 まで上げる想定 #509)。
//   下限 10K … 候補が少なくてもここは削らない
//   +240/候補 … PreRankResult 1 件 (id + 4 配列 + 2 数値 + reason codes) の実測見積もりに余裕
//   上限 32K … 暴走保険。ここに当たるほどの候補数は pre-rank の前段で絞るべき
// OpenRouter は reasoning tokens も output tokens として課金し max_tokens の内枠に
// 数えるため、reasoning を切らないままこの枠を小さくすると thinking だけで枠を
// 食い潰し finish_reason=length → 毎回 deterministic fallback になる。
const MIN_MAX_OUTPUT_TOKENS = 10_240;
const MAX_MAX_OUTPUT_TOKENS = 32_768;
const TOKENS_PER_CANDIDATE = 240;

// DeepSeek V4 系は thinking が既定で有効・effort の既定が high。
// pre-rank は既知 claim を要件へ写す機械的な処理で推論を必要としないため、
// **コード側で明示的に切る**。既定任せにすると上記の枠食い潰しが起きる。
// A/B 比較をしたいときだけ env で上げる。
const DEFAULT_REASONING_EFFORT = "none";

function apiKey(): string {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY が未設定");
  return key;
}

function model(): string {
  return Deno.env.get("OPENROUTER_MODEL") ?? DEFAULT_MODEL;
}

function timeoutMs(): number {
  const raw = parseInt(Deno.env.get("PRE_RANK_TIMEOUT_MS") ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

// env が入っていればそれを固定値として使う (benchmark 用に枠を固定したいことがある)。
// 未設定なら候補数から見積もる
function maxOutputTokens(candidateCount: number): number {
  const raw = parseInt(Deno.env.get("PRE_RANK_MAX_OUTPUT_TOKENS") ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const estimated = MIN_MAX_OUTPUT_TOKENS +
    candidateCount * TOKENS_PER_CANDIDATE;
  return Math.min(estimated, MAX_MAX_OUTPUT_TOKENS);
}

// OpenRouter の reasoning 制御 (provider 非依存の正規化パラメータ)。
// exclude: true は reasoning_content を応答へ返させない — pre-rank は使わないため。
// effort=none で thinking 自体を止める。none 以外を指定した場合でも、reasoning が
// max_tokens を食い潰して JSON 本体が切れないよう明示 budget を併せて送る。
function reasoningControl(outputTokens: number): Record<string, unknown> {
  const effort = Deno.env.get("PRE_RANK_REASONING_EFFORT") ??
    DEFAULT_REASONING_EFFORT;
  if (effort === "none") return { effort: "none", exclude: true };
  // 出力枠の 1/4 を上限にする。残りは JSON 本体のために必ず空けておく
  return {
    effort,
    exclude: true,
    max_tokens: Math.max(256, Math.floor(outputTokens / 4)),
  };
}

// host provider の pin (benchmark の再現性用)。未設定なら OpenRouter の自動 routing に任せる
function providerRouting(): Record<string, unknown> | undefined {
  const order = (Deno.env.get("OPENROUTER_PROVIDER_ORDER") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (order.length === 0) return undefined;
  return { order, allow_fallbacks: false };
}

// ============================================================
// JSON Schema (issue #552 §Pre-Rank Output Contract)
// ============================================================

const PRE_RANK_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "入力で渡された id をそのまま返す",
          },
          pre_score: {
            type: "number",
            description: "0..1。既知情報が無ければ 0.5 (中立)",
          },
          known_match: {
            type: "array",
            items: { type: "string" },
            description: "既知情報で満たすと判断できた requirement の rid",
          },
          known_mismatch: {
            type: "array",
            items: { type: "string" },
            description: "既知情報で明確に満たさないと判断できた rid のみ",
          },
          unknown: {
            type: "array",
            items: { type: "string" },
            description: "既知情報からは判断できない rid",
          },
          research_priority: {
            type: "number",
            description: "0..1。Web 調査で判明する価値が高いほど大きい",
          },
          reason_codes: {
            type: "array",
            items: { type: "string" },
            description: "例: CUISINE_MATCH / BUDGET_MISMATCH / MISSING_BUDGET",
          },
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

// system prompt は候補・requirement に依存しない固定文にする。
// OpenRouter/DeepSeek の prompt cache が効き、pre-rank の単価が実質 input 分だけになる
const SYSTEM_PROMPT = [
  "あなたは飲食店候補の事前選抜 (pre-rank) を行うアシスタントです。",
  "目的は順位の確定ではなく、この後に高価な Web 調査へ回す候補を選ぶことです。",
  "",
  "厳守するルール:",
  "1. 与えられた既知情報 (known_claims / categories / distance_m) だけで判断する。",
  "   Web 上にあるかもしれない未知の情報を推測・創作しない。店名からの連想も禁止。",
  "2. unknown は mismatch ではない。情報が無いだけの候補を減点しない。",
  "   判断できない requirement は unknown に入れ、research_priority を上げる材料にする。",
  "3. known_mismatch に入れてよいのは、既知情報が要件と明確に矛盾する場合だけ。",
  "4. pre_score は既知情報のみで 0..1。既知情報が 1 件も無ければ 0.5 とする。",
  "5. research_priority は 0..1。優先度の高い requirement が unknown なほど大きくする。",
  "6. 入力に無い id を作らない。全候補について 1 件ずつ返す。",
  "7. 自由文は返さない。理由は reason_codes (英大文字とアンダースコア) で表す。",
].join("\n");

function userPrompt(
  candidates: PreRankCandidate[],
  requirements: PreRankRequirement[],
  previousError: string | null,
): string {
  // モデルへ渡すのは既知情報のみ。investigation の生 query や Evidence 本文は渡さない
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
      ? `前回の出力は検証に失敗しました。同じ誤りを繰り返さないでください: ${previousError}`
      : "",
    JSON.stringify(payload),
  ].filter(Boolean).join("\n");
}

// ============================================================
// Provider
// ============================================================

export class OpenRouterPreRankProvider implements PreRankProvider {
  readonly id = "openrouter";

  async preRank(
    candidates: PreRankCandidate[],
    requirements: PreRankRequirement[],
  ): Promise<PreRankOutcome> {
    const started = Date.now();
    // 決定論結果を先に作る。AI が落ちても・部分的にしか返さなくても、
    // ここから候補が消えることは無い (issue #552 Fallback Rules)
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
        latencyMs: Date.now() - started,
      };
    }

    let lastError = "";
    let attempts = 0;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let reasoningTokens: number | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      attempts++;
      try {
        const res = await this.call(
          userPrompt(
            candidates,
            requirements,
            attempt === 0 ? null : lastError,
          ),
          candidates.length,
        );
        inputTokens = res.inputTokens;
        outputTokens = res.outputTokens;
        reasoningTokens = res.reasoningTokens;
        if (res.truncated) {
          lastError = "output_truncated";
          continue;
        }
        if (!res.content.trim()) {
          // DeepSeek 系 JSON Output は稀に空 content を返す (公式 docs 記載)
          lastError = "empty content";
          continue;
        }
        const parsed = preRankOutputSchema.safeParse(JSON.parse(res.content));
        if (!parsed.success) {
          // Zod message にはモデルが返した値が含まれ得るため保存しない。
          lastError = "schema_invalid";
          continue;
        }
        const merged = mergePreRankResults(
          deterministic,
          parsed.data.candidates.map(toPreRankResult),
        );
        console.log(
          `[prerank] provider=openrouter candidates=${candidates.length} accepted=${merged.acceptedIds.length} rejected=${merged.rejectedIds.length} attempts=${attempts} inTok=${inputTokens} outTok=${outputTokens} reasoningTok=${reasoningTokens}`,
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
          latencyMs: Date.now() - started,
        };
      } catch (e) {
        const status = e instanceof Error
          ? e.message.match(/^OpenRouter API error (\d{3})$/)?.[1]
          : null;
        lastError = status ? `http_${status}` : "provider_error";
      }
    }

    // 全滅しても Investigation は落とさない。決定論 pre-rank で先へ進む
    console.log(
      `[prerank] provider=openrouter fallback=deterministic attempts=${attempts} reason=${lastError}`,
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    };
    // OpenRouter のランキング表示用の任意ヘッダ。未設定なら送らない
    const referer = Deno.env.get("OPENROUTER_APP_URL");
    if (referer) headers["HTTP-Referer"] = referer;
    const title = Deno.env.get("OPENROUTER_APP_TITLE");
    if (title) headers["X-Title"] = title;

    const outputTokens = maxOutputTokens(candidateCount);
    const res = await fetch(API_URL, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs()),
      body: JSON.stringify({
        model: model(),
        provider: providerRouting(),
        max_tokens: outputTokens,
        reasoning: reasoningControl(outputTokens),
        temperature: 0, // pre-rank の再現性を優先
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "pre_rank",
            strict: true,
            schema: PRE_RANK_SCHEMA,
          },
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      // provider本文を例外へ混ぜず、statusだけを固定コードとして扱う。
      try {
        await res.body?.cancel();
      } catch {
        // 本文破棄失敗は固定のprovider_errorへ畳み込む。
      }
      throw new Error(`OpenRouter API error ${res.status}`);
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    const content = typeof choice?.message?.content === "string"
      ? choice.message.content
      : "";
    return {
      content,
      truncated: choice?.finish_reason === "length",
      inputTokens: numberOrNull(data?.usage?.prompt_tokens),
      outputTokens: numberOrNull(data?.usage?.completion_tokens),
      // reasoning を切れているかの実測 (#552)。既定設定なら 0 であるべき。
      // 0 でなければ枠食い潰しの兆候として live で気づけるようにする
      reasoningTokens: numberOrNull(
        data?.usage?.completion_tokens_details?.reasoning_tokens,
      ),
    };
  }
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// snake_case の wire format → 内部の camelCase 型。範囲チェックは
// mergePreRankResults 側で行う (§30: clamp せず候補ごとに破棄)
function toPreRankResult(
  c: {
    id: string;
    pre_score: number;
    known_match: string[];
    known_mismatch: string[];
    unknown: string[];
    research_priority: number;
    reason_codes: string[];
  },
): PreRankResult {
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
