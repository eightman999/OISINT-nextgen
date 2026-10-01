// GoogleAIClient (spec.md §5 / 2026-08-15 grounding 廃止)
// gemini-3.6-flash: requirement parsing / structured evaluation (検索ツールなし)
// gemini-embedding-2: embedding (output_dimensionality=768 固定 §16.3)
//
// - SDK は使わず REST を直接叩く (research.md R3)
// - google_search grounding は廃止 (高額 $14/1k + quota 即死のため §5)。
//   Web 検索・ページ取得は SearchFetchResearchProvider (Serper + 軽量フェッチャ) が担う
// - Gemini API の同時呼び出しは GEMINI_MAX_CONCURRENCY (既定 2) のセマフォで制限する
import { z } from "zod";
import {
  AI_OUTPUT_LIMITS,
  boundedStructuredClaimSchema,
  type ParsedRequirements,
  parsedRequirementsSchema,
} from "../validation.ts";
import { dedupeRequirements } from "../requirement_dedupe.ts";
import {
  EMBEDDING_DIMENSION,
  validateEmbedding,
} from "../embedding_validation.ts";
import type { ProviderInstrumentation } from "./types.ts";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function apiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY が未設定");
  return key;
}

function model(): string {
  return Deno.env.get("AI_MODEL") ?? "gemini-3.6-flash";
}

// 出力トークン削減 (§5 / #126):
// - thought は拾わず捨てている (下記 callInteraction) のに生成分は課金されるため、
//   thinking_level で生成量そのものを抑える (minimal | low | medium | high)
// - max_output_tokens は暴走保険。Structured Output が途中で切れると Zod 失敗 →
//   unknown 化するので、通常出力より十分大きい値にする
//
// 既定 16384 (#552 / #514): 8192 は候補 × requirement 数が増えると findings 配列が
// 収まらず、途中切断 → Zod 失敗 → unknown 化する。これは #514 で観測された
// 「unknown / Web Evidence 0 が目立つ」症状と同じ経路。pre-rank (#552) が Gemini を
// 呼ぶ候補数そのものを減らすため、1 回あたりの品質 budget はむしろ戻してよい。
// thinking_level の既定は low のまま — 引き上げは同一 fixture での A/B 実測後に
// 決める (#552 §Gemini A/B)。ここで推測で上げない
function generationConfig(): {
  thinking_level: string;
  max_output_tokens: number;
} {
  return {
    thinking_level: Deno.env.get("GEMINI_THINKING_LEVEL") ?? "low",
    max_output_tokens:
      parseInt(Deno.env.get("GEMINI_MAX_OUTPUT_TOKENS") ?? "16384", 10) ||
      16384,
  };
}

// ============================================================
// 同時呼び出しセマフォ (§5: RPM バーストとコストの抑制。paid でも 1〜2 に制限)
// ============================================================

// env はモジュールロード時でなく初回使用時に読む (テストが --allow-env なしで import できるように)
let maxConcurrency: number | null = null;
function limit(): number {
  maxConcurrency ??= Math.max(
    1,
    parseInt(Deno.env.get("GEMINI_MAX_CONCURRENCY") ?? "2", 10) || 2,
  );
  return maxConcurrency;
}
let active = 0;
const waiters: Array<() => void> = [];

async function withGeminiSlot<T>(
  fn: () => Promise<T>,
  instrumentation?: ProviderInstrumentation,
  operation = "structured_output",
  retryCount = 0,
  itemCount = 1,
  signal?: AbortSignal,
): Promise<T> {
  const waitStarted = Date.now();
  while (active >= limit()) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("aborted", "AbortError");
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
      };
      waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("aborted", "AbortError");
  }
  const semaphoreWaitMs = Date.now() - waitStarted;
  active++;
  const started = Date.now();
  let outcome: "ok" | "error" = "ok";
  try {
    return await fn();
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    active--;
    waiters.shift()?.();
    instrumentation?.onMetric({
      provider: "gemini",
      operation,
      durationMs: Date.now() - started,
      itemCount,
      semaphoreWaitMs,
      retryCount,
      outcome,
    });
  }
}

// ============================================================
// Structured Output 用 JSON Schema
// ============================================================

const PARSE_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "「<日付> <エリア> <シーン>」形式。例: 8/23 池袋 夜飯",
    },
    normalizedQuery: {
      type: "string",
    },
    area: {
      type: "string",
    },
    locationScope: {
      type: "object",
      description:
        "沿線・駅間・駅数指定または現在地の構造化scope。駅一覧・地名の推測・GPS座標は絶対に返さない",
      properties: {
        type: {
          type: "string",
          enum: [
            "current_location",
            "point",
            "any_of",
            "multi_origin",
            "line",
            "between",
            "corridor",
            "station_hops",
            "travel_time",
          ],
        },
        place: { type: "string" },
        places: {
          type: "array",
          items: {
            type: "string",
          },
        },
        origins: {
          type: "array",
          items: {
            type: "string",
          },
        },
        line: { type: "string" },
        operator: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        origin: { type: "string" },
        maxStops: { type: "integer" },
        maxMinutes: { type: "integer" },
      },
      required: ["type"],
      additionalProperties: false,
    },
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: {
            type: "string",
          },
          normalizedText: {
            type: "string",
          },
          kind: {
            type: "string",
            enum: [
              "location",
              "budget",
              "cuisine",
              "payment",
              "reservation",
              "atmosphere",
              "party_size",
              "time",
              "access",
              "dietary",
              "other",
            ],
          },
          priority: { type: "string", enum: ["must", "should", "nice"] },
          weight: { type: "number" },
        },
        required: ["text", "normalizedText", "kind", "priority", "weight"],
      },
    },
  },
  required: ["title", "normalizedQuery", "area", "requirements"],
} as const;

const CLAIM_SCHEMA = {
  type: "object",
  properties: {
    key: {
      type: "string",
      enum: [
        "opening_hours",
        "closed_days",
        "budget_dinner",
        "card_accepted",
        "reservation",
        "private_room",
        "capacity",
        "genre",
        "noise_level",
        "time_limit",
        "non_smoking",
        "wifi_available",
        "child_friendly",
        "nearest_station_walk_minutes",
        "category",
        "price_range",
        "amenities",
        "lodging.room_type",
        "lodging.check_in_time",
        "lodging.check_out_time",
        "rental_space.equipment",
      ],
    },
    value: {},
    rawText: {
      type: "string",
      description: "根拠となった原文の抜粋 (30字以内)",
    },
  },
  required: ["key", "value", "rawText"],
  additionalProperties: false,
} as const;

// 出力トークン削減 (#126): requirementId は UUID でなく短縮 rid (r1..rN)、
// 根拠 URL は文字列でなくページ番号 (sourcePages) で返させ、コード側で復元する。
// §5 の「citation を S1, S2 と採番して参照させる」方式の search_fetch 適用。
export const INVESTIGATION_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "120字以内の日本語",
    },
    findings: {
      type: "array",
      maxItems: AI_OUTPUT_LIMITS.findings,
      items: {
        type: "object",
        properties: {
          rid: {
            type: "string",
            description: "評価対象の rid (渡されたものをそのまま返す)",
          },
          state: {
            type: "string",
            enum: ["match", "partial", "mismatch", "unknown"],
          },
          confidence: { type: "number" },
          explanation: {
            type: "string",
            description: "80字以内の日本語",
          },
          sourcePages: {
            type: "array",
            maxItems: AI_OUTPUT_LIMITS.sourceUrls,
            items: {
              type: "integer",
              minimum: 1,
              maximum: AI_OUTPUT_LIMITS.citations,
            },
            description: "根拠にしたページ番号のみ (例: 【ページ2】なら 2)",
          },
          claims: {
            type: "array",
            maxItems: AI_OUTPUT_LIMITS.claimsPerFinding,
            items: CLAIM_SCHEMA,
          },
        },
        required: [
          "rid",
          "state",
          "confidence",
          "explanation",
          "sourcePages",
          "claims",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
} as const;

// モデル出力 (Structured Output) 部分の Zod
export const modelInvestigationSchema = z.object({
  summary: z.string().min(1).max(AI_OUTPUT_LIMITS.summaryChars),
  findings: z.array(
    z.object({
      rid: z.string().regex(/^r(?:[1-9]|[1-9]\d|[1-4]\d{2}|500)$/),
      state: z.enum(["match", "partial", "mismatch", "unknown"]),
      confidence: z.number(),
      explanation: z.string().max(AI_OUTPUT_LIMITS.explanationChars),
      sourcePages: z.array(
        z.number().int().min(1).max(AI_OUTPUT_LIMITS.citations),
      ).max(AI_OUTPUT_LIMITS.sourceUrls),
      claims: z.array(boundedStructuredClaimSchema).max(
        AI_OUTPUT_LIMITS.claimsPerFinding,
      ),
    }).strict(),
  ).max(AI_OUTPUT_LIMITS.findings),
}).strict();

export type ModelInvestigation = z.infer<typeof modelInvestigationSchema>;

// ============================================================
// Interactions API 呼び出し (検索ツールなし。§5)
// レスポンス実形 (2026-08-15 実測):
//   { status: "completed", steps: [ {type:"thought", ...},
//                                   {type:"model_output", content:[{type:"text", text:"..."}]} ] }
// thought / reasoning ステップは拾わない (§5: DB保存・UI表示しない)
// ============================================================

// Structured Output の途中切断を観測できるようにする (#514 切り分け項目 2/3)。
// Interactions API のレスポンス形は provider 側で変わりうるため、status /
// incomplete_details / finish_reason / candidates のどれで来ても拾えるようにし、
// どれも無ければ usage の出力トークンが上限に達したかを二次シグナルにする。
// 本文・クエリは一切ログへ出さない (§34)。
export function describeInteractionCompletion(
  data: unknown,
  maxOutputTokens: number,
): { status: string; reason: string; truncated: boolean } {
  const root = (data ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value : null;
  const status = str(root.status) ?? "unknown";
  const incomplete =
    (root.incomplete_details ?? root.incompleteDetails ?? {}) as Record<
      string,
      unknown
    >;
  const candidate =
    (Array.isArray(root.candidates) ? root.candidates[0] : null) as
      | Record<string, unknown>
      | null;
  const reason = str(incomplete.reason) ?? str(root.finish_reason) ??
    str(root.finishReason) ?? str(candidate?.finishReason) ??
    str(candidate?.finish_reason) ?? "none";
  const usage = (root.usage ?? root.usageMetadata ?? {}) as Record<
    string,
    unknown
  >;
  const outputTokens = [
    usage.output_tokens,
    usage.outputTokens,
    usage.candidates_token_count,
    usage.candidatesTokenCount,
  ].find((value) => typeof value === "number") as number | undefined;
  const truncated = /max_output_tokens|max_tokens|MAX_TOKENS|length/i.test(
    reason,
  ) || status === "incomplete" ||
    (outputTokens !== undefined && maxOutputTokens > 0 &&
      outputTokens >= maxOutputTokens);
  return { status, reason, truncated };
}

function safeMetricLabel(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : "unknown";
}

function nonNegativeMetric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

// APIエラー本文にはプロンプトの一部が含まれる可能性があるため、本文は
// ログへ出さず、運用上必要な分類だけを記録する。
export function classifyGeminiHttpError(
  status: number,
  detail: string,
): "auth" | "rate_limit" | "request_schema" | "upstream" | "unknown" {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream";
  const normalized = detail.toLowerCase();
  if (
    normalized.includes("schema") ||
    normalized.includes("response_format") ||
    normalized.includes("mime_type") ||
    normalized.includes("invalid json") ||
    normalized.includes("invalid argument")
  ) return "request_schema";
  return "unknown";
}

const GEMINI_SCHEMA_FIELD_NAMES = [
  "minLength",
  "maxLength",
  "pattern",
  "additionalProperties",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "required",
  "properties",
  "items",
  "response_format",
  "mime_type",
  "generation_config",
] as const;

export function identifyGeminiSchemaField(detail: string): string {
  return GEMINI_SCHEMA_FIELD_NAMES.find((field) => detail.includes(field)) ??
    "none";
}

async function callInteraction(
  input: string,
  schema: unknown,
  instrumentation?: ProviderInstrumentation,
  retryCount = 0,
  signal?: AbortSignal,
): Promise<string> {
  return await withGeminiSlot(
    async () => {
      const res = await fetch(`${API_BASE}/interactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey(),
        },
        body: JSON.stringify({
          model: model(),
          input,
          generation_config: generationConfig(),
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema,
          },
        }),
        signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.warn(
          `[gemini-error] status=${res.status} class=${
            classifyGeminiHttpError(
              res.status,
              detail,
            )
          } field=${identifyGeminiSchemaField(detail)}`,
        );
        throw new Error(
          `Gemini API error ${res.status}: ${detail.slice(0, 300)}`,
        );
      }
      const data = await res.json();

      let text = "";
      const steps: unknown[] = Array.isArray(data.steps) ? data.steps : [data];
      for (const item of steps) {
        const o = item as Record<string, unknown>;
        if (o.type === "thought") continue; // §5: thought は一切拾わない
        const content = o.content as
          | Array<Record<string, unknown>>
          | string
          | undefined;
        if (typeof content === "string") text += content;
        else if (Array.isArray(content)) {
          for (const c of content) {
            if (typeof c.text === "string") text += c.text;
          }
        }
        if (typeof o.text === "string") text += o.text;
      }
      if (!text && typeof data.text === "string") text = data.text;
      if (!text) {
        throw new Error("Gemini レスポンスから本文を抽出できませんでした");
      }
      // トークン消費の実測ログ (server 側のみ。§34: client へは返さない)
      const usage = data.usage ?? data.usageMetadata ?? null;
      const completion = describeInteractionCompletion(
        data,
        generationConfig().max_output_tokens,
      );
      const usageRecord = usage && typeof usage === "object"
        ? usage as Record<string, unknown>
        : {};
      const inputTokens = nonNegativeMetric(
        usageRecord.input_tokens ?? usageRecord.inputTokenCount ??
          usageRecord.prompt_token_count ?? usageRecord.promptTokenCount,
      );
      const outputTokens = nonNegativeMetric(
        usageRecord.output_tokens ?? usageRecord.outputTokenCount ??
          usageRecord.candidates_token_count ??
          usageRecord.candidatesTokenCount,
      );
      const totalTokens = nonNegativeMetric(
        usageRecord.total_tokens ?? usageRecord.totalTokenCount ??
          usageRecord.total_token_count,
      );
      console.log(
        `[gemini-usage] input_chars=${input.length} output_chars=${text.length} status=${
          safeMetricLabel(completion.status)
        } reason=${
          safeMetricLabel(completion.reason)
        } input_tokens=${inputTokens} output_tokens=${outputTokens} total_tokens=${totalTokens}`,
      );
      // 途中切断は Zod 失敗 → unknown 化の主要経路 (#514)。usage ログに埋もれさせない
      if (completion.truncated) {
        console.warn(
          `[gemini-truncated] status=${
            safeMetricLabel(completion.status)
          } reason=${
            safeMetricLabel(completion.reason)
          } max_output_tokens=${generationConfig().max_output_tokens} output_chars=${text.length}`,
        );
      }
      return text;
    },
    instrumentation,
    "structured_output",
    retryCount,
    1,
    signal,
  );
}

// Zod の失敗内容を path + code だけへ落とす。message には受信値が入りうるため
// ログへは出さない (§34: 本文・private な調査内容をログへ出さない)。
export function zodIssueDigest(error: z.ZodError): string {
  const issues = error.issues.slice(0, 5).map((issue) =>
    `${issue.path.join(".") || "(root)"}:${issue.code}`
  );
  const rest = error.issues.length - issues.length;
  return issues.join(",") + (rest > 0 ? `,+${rest}` : "");
}

// Zod 失敗時はエラー内容を prompt に添えて 1 回だけ再要求 (§30)。無限リトライ禁止
export async function structuredCall<T>(
  buildPrompt: (previousError: string | null) => string,
  schema: unknown,
  validate: (raw: unknown) => z.ZodSafeParseResult<T>,
  instrumentation?: ProviderInstrumentation,
  signal?: AbortSignal,
  maxAttempts = 2,
): Promise<T> {
  if (
    !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2
  ) {
    throw new Error("Structured Output attempt policy is invalid");
  }
  let lastError: string | null = null;
  let lastDigest = "unknown";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const text = await callInteraction(
      buildPrompt(lastError),
      schema,
      instrumentation,
      attempt,
      signal,
    );
    try {
      const parsed = validate(JSON.parse(text));
      if (parsed.success) return parsed.data;
      lastError = parsed.error.message.slice(0, 500);
      lastDigest = zodIssueDigest(parsed.error);
    } catch (e) {
      lastError = e instanceof Error
        ? e.message.slice(0, 500)
        : "JSON parse error";
      lastDigest = "json_parse_error";
    }
    // どこで評価が失われたかを追えるようにする (#514)。値そのものは出さない (§34)
    console.warn(
      `[structured-${attempt === 0 ? "retry" : "failure"}] attempt=${
        attempt + 1
      } issues=${lastDigest}`,
    );
  }
  throw new Error(
    `Structured Output の検証に ${maxAttempts} 回失敗: ${lastError}`,
  );
}

// ============================================================
// Gemini クライアント (parse / embed。research は SearchFetchResearchProvider が担う)
// ============================================================

export class GoogleAIClient {
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly instrumentation?: ProviderInstrumentation,
  ) {}

  async parseRequirements(
    query: string,
    signal?: AbortSignal,
  ): Promise<ParsedRequirements> {
    // モデルは今日の日付を知らないため明示する (title の日付捏造防止。JST = UTC+9)
    const today = new Date(this.now().getTime() + 9 * 3600_000).toISOString()
      .slice(0, 10);
    const parsed = await structuredCall(
      (prevError) =>
        [
          "あなたはOISI対象探しの条件を構造化するアシスタントです。",
          "ユーザーの自然文から Requirement を抽出し、指定の JSON schema で返してください。",
          `今日の日付: ${today} (JST)。相対表現 (今日・明日・来週金曜 等) はこれを基準に解釈する`,
          "ルール:",
          "- 自由文出力 (normalizedText 等) は必ず日本語 (§Language Rule)",
          "- title は「<日付> <エリア> <シーン>」形式 (例: 8/23 池袋 夜飯)。日付が無ければ今日の日付",
          "- area は後方互換用の**短い地名 1 語** (駅名または市区町村名。例: 池袋、練馬) とする。",
          "  locationScope が point 以外の場合も、area だけを検索地点として使わず、入力の各 endpoint/候補/起点/路線を locationScope にそのまま保持する。",
          "  A〜B、沿線、AかB、複数起点を代表駅1つへ丸めたり、別の駅・経路を補ったりしない。",
          "- 「現在地」「ここ」等ユーザーの現在位置を指す表現が実際に入力文中にある場合のみ、area は「現在地」、locationScope.type は「current_location」とする。",
          "  実在の地名や point へ勝手に置き換えない。current_location に lat/lng やその他のGPS座標を絶対に含めない。",
          "- 「現在地」「ここ」自体も kind=location の requirement として保持する。徒歩時間・駅からの距離等は別の kind=access requirement とする。",
          "- 場所を示す語（地名・駅名・「現在地」「ここ」等）が入力文に一切無い場合、current_location を推測で補わない。area は「池袋」とし、locationScope は付与しない。",
          "- weight は 0..1。priority は must / should / nice",
          "- 同一内容・同一意味の条件が複数回出現した場合は1件に統合する",
          "- 統合時に weight を加算しない。同一条件の反復だけを理由に priority / weight を上げない",
          "- 「好き」は原則 should、「避けたい」も原則 should とし、「必須」「絶対」「NG」等の明示がある場合のみ must にする",
          "- 食材・料理のアレルギー、除外、回避（例:「魚は避けたい」）は kind=dietary とする。食べたい料理・選言は kind=cuisine として別に保持する。",
          "- filter chip相当は、禁煙=atmosphere、Wi-Fi/子連れOK=other、徒歩N分以内=accessとして、入力にある条件だけを独立Requirementで保持する。",
          "- 具体的な条件と抽象的な条件が併存する場合は両方保持してよいが、抽象条件の weight は具体条件を超えない",
          "- 推測で条件を追加しない",
          "- 沿線・駅間・駅数指定がある場合は locationScope にその入力だけを入れる。駅一覧やsequenceを生成しない。N02 resolverがDBから駅を解決する",
          "- 「AかB」「AまたはB」は type=any_of として places に入力順の原文を入れる。「AとBから」等の複数の出発地は type=multi_origin として origins に入れる。#146の公平性・所要時間・Transit計算は行わない。",
          "- 「Aから30分以内」は type=travel_time とし、origin と入力に明記された maxMinutes だけを入れる。所要時間や駅を推測しない。",
          "- requirement.text はユーザー入力に実在する最小の条件spanを一字一句そのまま写す。場所・日付contextは含めず、要約・言い換え・補完をしない",
          "- 否定・除外・選言 (〜ではない、避けたい、〜以外、AまたはB等) を肯定条件へ反転しない",
          prevError
            ? `前回の出力は検証に失敗しました。修正してください: ${prevError}`
            : "",
          `ユーザー入力: ${query}`,
        ].filter(Boolean).join("\n"),
      PARSE_SCHEMA,
      (raw) => parsedRequirementsSchema.safeParse(raw),
      this.instrumentation,
      signal,
      1,
    );
    return {
      ...parsed,
      requirements: dedupeRequirements(parsed.requirements),
    };
  }

  // gemini-embedding-2 / output_dimensionality=768 固定 (§16.3)。
  // 複数文字列を単一 Part 列で渡さず、文字列ごとに独立リクエスト (§5 Embedding Rule)
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const embeddingModel = Deno.env.get("EMBEDDING_MODEL") ??
      "gemini-embedding-2";
    const configuredDimension = Number(
      Deno.env.get("EMBEDDING_DIM") ?? EMBEDDING_DIMENSION,
    );
    if (configuredDimension !== EMBEDDING_DIMENSION) {
      throw new Error(
        `EMBEDDING_DIM は ${EMBEDDING_DIMENSION} に固定されています`,
      );
    }
    const dim = EMBEDDING_DIMENSION;
    const results: number[][] = [];
    for (const text of texts) {
      const values = await withGeminiSlot(
        async () => {
          const res = await fetch(
            `${API_BASE}/models/${embeddingModel}:embedContent`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey(),
              },
              body: JSON.stringify({
                content: { parts: [{ text }] },
                outputDimensionality: dim,
              }),
              signal,
            },
          );
          if (!res.ok) throw new Error(`Embedding API error ${res.status}`);
          const data = await res.json();
          const checked = validateEmbedding(data.embedding?.values, dim);
          if (!checked.ok) {
            const actual = checked.actualLength === null
              ? "なし"
              : String(checked.actualLength);
            throw new Error(
              checked.reason === "wrong_dimension" ||
                checked.reason === "not_array"
                ? `embedding 次元が不正: ${actual} (期待 ${dim})`
                : `embedding 要素が不正 (期待 ${dim} 個のfinite number)`,
            );
          }
          return checked.value;
        },
        this.instrumentation,
        "embedding",
        0,
        1,
        signal,
      );
      results.push(values);
    }
    return results;
  }
}
