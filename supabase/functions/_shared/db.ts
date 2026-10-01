// Supabase クライアント生成と認証ヘルパ (spec.md §25 冒頭)
// Edge Functions は service role で動作し、クライアントの JWT で本人確認する。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { throwIfDatabaseError } from "./database_error.ts";
import {
  LOCATION_SCOPE_MAX_ITEMS,
  LOCATION_SCOPE_TEXT_MAX,
} from "./rail_scope.ts";

export function createServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface AuthResult {
  userId: string | null;
  isServiceRole: boolean;
}

const AUTH_TOKEN_MAX_LENGTH = 8192;

function constantTimeTextEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^
      (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

// Authorization ヘッダを検証する。
// - service role key（運用者の直接呼出し互換。自己再呼出しには使用しない）→ isServiceRole
// - ユーザー JWT → auth.getUser() で本人確認
export async function authenticate(
  req: Request,
  db: SupabaseClient,
): Promise<AuthResult> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) return { userId: null, isServiceRole: false };
  if (token.length > AUTH_TOKEN_MAX_LENGTH) {
    return { userId: null, isServiceRole: false };
  }
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (
    serviceRoleKey.length > 0 &&
    serviceRoleKey.length <= AUTH_TOKEN_MAX_LENGTH &&
    constantTimeTextEqual(token, serviceRoleKey)
  ) {
    return { userId: null, isServiceRole: true };
  }
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return { userId: null, isServiceRole: false };
  return { userId: data.user.id, isServiceRole: false };
}

export async function isMember(
  db: SupabaseClient,
  investigationId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("investigation_members")
    .select("user_id")
    .eq("investigation_id", investigationId)
    .eq("user_id", userId)
    .maybeSingle();
  throwIfDatabaseError(error, "investigation_members.membership_select");
  return data !== null;
}

// JSON レスポンスヘルパ。CORS は allow-list 方式にし、Origin をそのまま反射しない。
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://oisint.com",
  "https://www.oisint.com",
  "http://localhost:3000",
  "http://localhost:8081",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:8081",
]);

function allowedOrigins(): Set<string> {
  const configured = Deno.env.get("ALLOWED_ORIGINS")
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured && configured.length > 0
    ? new Set(configured)
    : DEFAULT_ALLOWED_ORIGINS;
}

export function json(
  body: unknown,
  status = 200,
  req?: Request,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(req?.headers.get("Origin")),
      ...extraHeaders,
    },
  });
}

export function corsHeaders(origin?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, idempotency-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins().has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req.headers.get("Origin")),
    });
  }
  return null;
}

// 調査イベントは joined member の進捗画面から読めるため、deny-list ではなく
// event_type ごとの closed allow-list で扱う (#151 / spec.md §33)。未知キー、別名、
// 深い object/array、raw query・GPS・health・provider error は fail-closed で落とす。
type EventMetadataSanitizer = (value: unknown) => unknown;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP_VALUES = new Set([
  "recalling",
  "searching",
  "collecting_evidence",
  "evaluating",
  "ranking",
  "complete",
]);
const ERROR_CODE_VALUES = new Set([
  "lease_lost",
  "location_anchor_required",
  "timeout",
  "provider_error",
  "provider_refresh_error",
  "step_error",
]);
const PROVIDER_VALUES = new Set([
  "geoapify",
  "overture",
  "mock",
  "gemini",
  "serper",
  "fetch",
  "openrouter",
  "deterministic",
]);

function isEventMetadataRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeBoundedString(value: unknown, maxLength: number): unknown {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : undefined;
}

function safeUuid(value: unknown): unknown {
  return typeof value === "string" && UUID_RE.test(value) ? value : undefined;
}

function safeCount(value: unknown): unknown {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 100_000
    ? value
    : undefined;
}

function safeSignedUnit(value: unknown): unknown {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 &&
      value <= 1
    ? value
    : undefined;
}

// 類似調査RPCが返すのは place identity と集計値だけ。名前・時刻・調査本文は
// 再利用候補の内部境界に不要なので保存しない。配列要素ごとに検証し、不正要素は
// 全体を壊さず落とすが、利用者入力から新しいIDを受け取る経路にはしない。
function safeRecallPlaces(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 32).flatMap((entry) => {
    if (!isEventMetadataRecord(entry)) return [];
    const placeId = safeUuid(entry.placeId);
    const avgVote = safeSignedUnit(entry.avgVote);
    const similarity = safeSignedUnit(entry.similarity);
    if (
      placeId === undefined || avgVote === undefined || similarity === undefined
    ) {
      return [];
    }
    return [{ placeId, avgVote, similarity }];
  });
}

const REQUIREMENT_KIND_VALUES = new Set([
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
]);

function safeRecallKinds(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 32).flatMap((entry) => {
    if (!isEventMetadataRecord(entry)) return [];
    const kind = typeof entry.kind === "string" &&
        REQUIREMENT_KIND_VALUES.has(entry.kind)
      ? entry.kind
      : undefined;
    const priority = typeof entry.priority === "string" &&
        ["must", "should", "nice"].includes(entry.priority)
      ? entry.priority
      : undefined;
    const count = safeCount(entry.count);
    if (kind === undefined || priority === undefined || count === undefined) {
      return [];
    }
    return [{ kind, priority, count }];
  });
}

function safeNonNegativeNumber(value: unknown): unknown {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
      value <= 1_000_000_000
    ? value
    : undefined;
}

function safeEnum(values: Set<string>): EventMetadataSanitizer {
  return (value: unknown) =>
    typeof value === "string" && values.has(value) ? value : undefined;
}

function safeLocationScope(value: unknown): unknown {
  if (!isEventMetadataRecord(value)) return undefined;
  const type = value.type;
  if (typeof type !== "string") return undefined;
  const fieldsByType: Record<string, string[]> = {
    current_location: [],
    point: ["place"],
    any_of: ["places"],
    multi_origin: ["origins"],
    line: ["line", "operator"],
    between: ["from", "to", "line"],
    corridor: ["from", "to", "line"],
    station_hops: ["origin", "line"],
    travel_time: ["origin"],
  };
  const allowed = fieldsByType[type];
  if (!allowed) return undefined;
  const result: Record<string, unknown> = { type };
  for (const key of allowed) {
    if (!(key in value)) continue;
    if (type === "any_of" || type === "multi_origin") {
      const rawItems = value[key];
      if (
        !Array.isArray(rawItems) || rawItems.length < 2 ||
        rawItems.length > LOCATION_SCOPE_MAX_ITEMS
      ) return undefined;
      const safeItems = rawItems.map((item) =>
        safeBoundedString(item, LOCATION_SCOPE_TEXT_MAX)
      );
      // 配列要素の一部だけを落とすと、AかB/AとBの意味を変えてしまうため、
      // 1件でも不正ならscope全体を保存しない。
      if (safeItems.some((item) => item === undefined)) return undefined;
      result[key] = safeItems;
      continue;
    }
    const safe = safeBoundedString(value[key], LOCATION_SCOPE_TEXT_MAX);
    if (safe !== undefined) result[key] = safe;
  }
  if (type === "station_hops" || type === "travel_time") {
    const limit = safeCount(value.maxStops ?? value.maxMinutes);
    if (limit === undefined || limit === 0) return undefined;
    result[type === "station_hops" ? "maxStops" : "maxMinutes"] = limit;
  }
  return result;
}

const COMMON_FIELDS: Record<string, EventMetadataSanitizer> = {
  request_id: safeUuid,
  candidateId: safeUuid,
  step: safeEnum(STEP_VALUES),
  code: safeEnum(ERROR_CODE_VALUES),
  reason: safeEnum(new Set(["location_anchor_required"])),
  status: safeEnum(new Set(["resolved", "invalid", "absent", "unresolved"])),
  provider: safeEnum(PROVIDER_VALUES),
  trigger: safeEnum(
    new Set(["vote", "requirement_added", "requirement_removed"]),
  ),
  count: safeCount,
  placeCount: safeCount,
  kindCount: safeCount,
  places: safeRecallPlaces,
  kinds: safeRecallKinds,
  citationCount: safeCount,
  findingCount: safeCount,
  requirementCount: safeCount,
  broadCandidateCount: safeCount,
  preRankCandidateCount: safeCount,
  hardFilterCount: safeCount,
  researchCandidateCount: safeCount,
  explorationCount: safeCount,
  hardFilterDropped: safeCount,
  aiAcceptedCount: safeCount,
  aiRejectedCount: safeCount,
  attempts: safeCount,
  inputTokens: safeCount,
  outputTokens: safeCount,
  reasoningTokens: safeCount,
  latencyMs: safeNonNegativeNumber,
  researchPoolCount: safeCount,
  unresolvedCount: safeCount,
  refreshedCount: safeCount,
  missingCount: safeCount,
  skipped: safeCount,
  conflictCount: safeCount,
  anchorCount: safeCount,
  maxProviderCalls: safeCount,
  perAnchorLimit: safeCount,
  broadLimit: safeCount,
  candidateCount: safeCount,
  providerCallLimit: safeCount,
  missingConfigCount: safeCount,
  budgetMax: safeNonNegativeNumber,
  area: (value) => safeBoundedString(value, 120),
  datasetVersionId: (value) => safeBoundedString(value, 128),
  locationScope: safeLocationScope,
};

const EVENT_FIELDS: Record<string, Set<string>> = {
  parse_completed: new Set([
    "area",
    "locationScope",
    "budgetMax",
    "requirementCount",
  ]),
  candidate_skipped: new Set(["candidateId"]),
  evidence_reused: new Set(["candidateId", "count", "unresolvedCount"]),
  candidate_failed: new Set(["candidateId", "code"]),
  search_executed: new Set(["candidateId", "citationCount", "findingCount"]),
  contradiction_found: new Set(["candidateId", "conflictCount"]),
  ranking_completed: new Set(["count", "researchPoolCount"]),
  reranked: new Set(["trigger"]),
  member_joined: new Set([]),
  location_anchor_required: new Set(["reason", "request_id"]),
  step_started: new Set(["step", "request_id"]),
  step_failed: new Set(["step", "code", "request_id"]),
  recall_preference: new Set([
    "placeCount",
    "kindCount",
    "places",
    "kinds",
  ]),
  recall_completed: new Set(["count"]),
  places_refreshed: new Set(["refreshedCount", "missingCount", "skipped"]),
  places_refresh_failed: new Set(["code"]),
  rail_scope_invalid: new Set([]),
  rail_scope_unresolved: new Set(["status"]),
  rail_scope_budget_invalid: new Set(["missingConfigCount"]),
  rail_scope_budget_exceeded: new Set([
    "anchorCount",
    "maxProviderCalls",
    "perAnchorLimit",
    "broadLimit",
  ]),
  rail_scope_resolved: new Set([
    "datasetVersionId",
    "anchorCount",
    "providerCallLimit",
    "perAnchorLimit",
    "broadLimit",
    "candidateCount",
  ]),
  search_completed: new Set([
    "count",
    "broadCandidateCount",
    "researchCandidateCount",
  ]),
  prerank_completed: new Set([
    "provider",
    "broadCandidateCount",
    "preRankCandidateCount",
    "hardFilterCount",
    "researchCandidateCount",
    "explorationCount",
    "hardFilterDropped",
    "aiAcceptedCount",
    "aiRejectedCount",
    "attempts",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "latencyMs",
  ]),
};

/**
 * investigation_events に保存してよい operational metadata のみを返す。
 * eventType を省略した直接利用も安全側の共通フィールドだけに限定する。
 */
export function sanitizeInvestigationEventMetadata(
  metadata: Record<string, unknown>,
  eventType?: string,
): Record<string, unknown> {
  const allowed = eventType
    ? EVENT_FIELDS[eventType] ?? new Set<string>()
    : null;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (allowed && !allowed.has(key)) continue;
    const sanitizer = COMMON_FIELDS[key];
    if (!sanitizer) continue;
    const safe = sanitizer(value);
    if (safe !== undefined) sanitized[key] = safe;
  }
  return sanitized;
}

const EVENT_MESSAGES: Record<string, string> = {
  parse_completed: "条件を整理しました",
  candidate_skipped: "候補をスキップしました",
  evidence_reused: "既存の根拠を再利用しました",
  candidate_failed: "候補の調査に失敗しました",
  search_executed: "候補を調査しました",
  contradiction_found: "情報源の相違を検出しました",
  ranking_completed: "ランキングを更新しました",
  reranked: "ランキングを再計算しました",
  member_joined: "メンバーが参加しました",
  location_anchor_required: "現在地の検索には位置情報の許可が必要です",
  step_started: "調査ステップを開始しました",
  step_failed: "調査ステップが失敗しました",
  recall_preference: "過去の嗜好情報を確認しました",
  recall_completed: "過去の類似調査を確認しました",
  places_refreshed: "店舗情報を更新しました",
  places_refresh_failed: "店舗情報の更新に失敗しました",
  rail_scope_invalid: "鉄道位置指定を検証できませんでした",
  rail_scope_unresolved: "鉄道位置指定を解決できませんでした",
  rail_scope_budget_invalid: "鉄道沿線探索の設定を確認できませんでした",
  rail_scope_budget_exceeded: "鉄道沿線探索の上限を超えました",
  rail_scope_resolved: "鉄道位置指定を駅アンカーへ解決しました",
  search_completed: "候補検索が完了しました",
  prerank_completed: "候補の優先順位を計算しました",
};

function sanitizeEventMessage(
  eventType: string,
  metadata: Record<string, unknown>,
): string {
  if (eventType === "step_started") {
    const step = metadata.step;
    const stepMessages: Record<string, string> = {
      recalling: "過去の類似調査を確認しています",
      searching: "候補店を探索しています",
      collecting_evidence: "根拠を集めています",
      evaluating: "条件を評価しています",
      ranking: "ランキングを計算しています",
      complete: "調査が完了しました",
    };
    return typeof step === "string" && stepMessages[step]
      ? stepMessages[step]
      : EVENT_MESSAGES.step_started;
  }
  if (eventType === "step_failed") {
    const step = metadata.step;
    return typeof step === "string" && STEP_VALUES.has(step)
      ? `調査ステップ ${step} が失敗しました`
      : EVENT_MESSAGES.step_failed;
  }
  return EVENT_MESSAGES[eventType] ?? "調査イベントを記録しました";
}

// investigation_events への記録 (§25.2)
export async function logEvent(
  db: SupabaseClient,
  investigationId: string,
  eventType: string,
  message: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  // The public event contract deliberately ignores caller-provided prose and
  // emits only the fixed, event-type-specific message below.
  void message;
  const { error } = await db.from("investigation_events").insert({
    investigation_id: investigationId,
    event_type: eventType,
    message: sanitizeEventMessage(
      eventType,
      sanitizeInvestigationEventMetadata(metadata, eventType),
    ),
    metadata: sanitizeInvestigationEventMetadata(metadata, eventType),
  });
  if (error) throw new Error("investigation event unavailable");
}
