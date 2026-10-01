// Zod schemas (spec.md §30): AI 出力・外部 API レスポンスは必ず safeParse してから DB へ書く。
// 検証失敗時のリトライは 1 回だけ。無限リトライ禁止。
import { z } from "zod";
import { parsePublicHttpUrl } from "./public_url.ts";
import { parseOpeningHoursValue } from "./opening_hours.ts";
import { locationScopeSchema } from "./rail_scope.ts";
export {
  currentLocationScopeSchema,
  locationScopeSchema,
} from "./rail_scope.ts";
export type { LocationScope } from "./rail_scope.ts";

// GPS は run request の処理中だけ使う一時 anchor。raw_query、共有 URL、
// investigation_events、DB 列、ログやキャッシュへ保存してはならない。
export const locationAnchorSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
}).strict();

export type LocationAnchor = z.infer<typeof locationAnchorSchema>;

// 時間超過時の自己再呼出しは、検証済み anchor だけを request body に再梱包する。
// DB/event/log へ退避する代替経路は持たない。
export function buildRunReinvokeBody(
  investigationId: string,
  searchAnchor?: LocationAnchor,
): { investigationId: string; searchAnchor?: LocationAnchor } {
  return {
    investigationId,
    ...(searchAnchor ? { searchAnchor } : {}),
  };
}

// ============================================================
// StructuredClaim (§13) — key ごとに value を検証。失敗した claim は破棄する (Evidence は残す)
// ============================================================

const claimValueSchemas = {
  opening_hours: z.string().refine(
    (value) => parseOpeningHoursValue(value) !== null,
    "opening_hours must be a valid H:MM-H:MM range",
  ), // 例: "17:00-23:00"
  closed_days: z.union([z.string(), z.array(z.string())]),
  budget_dinner: z.object({
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }).refine((range) => range.min <= range.max, "budget min must be <= max"),
  card_accepted: z.boolean(),
  reservation: z.boolean(),
  private_room: z.boolean(),
  capacity: z.number().positive(),
  genre: z.array(z.string()),
  noise_level: z.enum(["quiet", "moderate", "loud"]),
  time_limit: z.number().positive().nullable(), // 分。null = 制限なしと明記あり
  non_smoking: z.boolean(),
  wifi_available: z.boolean(),
  child_friendly: z.boolean(),
  // 公開情報に明記された最寄り駅からの徒歩分数だけを保存する。
  // 座標から徒歩時間を推測した値はこのclaimへ入れない。
  nearest_station_walk_minutes: z.number().int().nonnegative(),
  // 複数ドメインで使う分類・料金・設備。料金単位を値に含め、
  // restaurant の budget_dinner を宿泊/時間貸しへ流用しない (#125)。
  category: z.array(z.string().min(1).max(80)).min(1).max(32),
  price_range: z.object({
    min: z.number().finite().nonnegative(),
    max: z.number().finite().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unit: z.enum(["per_person", "per_night", "per_hour", "per_day", "flat"]),
  }).strict().refine(
    (range) => range.min <= range.max,
    "price min must be <= max",
  ),
  amenities: z.array(z.string().min(1).max(80)).max(64),
  "lodging.room_type": z.string().min(1).max(80),
  "lodging.check_in_time": z.string().refine(
    isValidClockTime,
    "invalid lodging check-in time",
  ),
  "lodging.check_out_time": z.string().refine(
    isValidClockTime,
    "invalid lodging check-out time",
  ),
  "rental_space.equipment": z.array(z.string().min(1).max(80)).max(64),
} as const;

function isValidClockTime(value: string): boolean {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 24 && minute >= 0 && minute <= 59 &&
    (hour < 24 || minute === 0);
}

export type ValidClaimKey = keyof typeof claimValueSchemas;

export const structuredClaimSchema = z.object({
  key: z.enum([
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
  ]),
  value: z.unknown(),
  rawText: z.string(),
}).strict();

// z.infer だと z.unknown() が optional 扱いになるため明示定義 (types.ts の StructuredClaim と同形)
export interface StructuredClaimInput {
  key: z.infer<typeof structuredClaimSchema>["key"];
  value: unknown;
  rawText: string;
}

// spec.md §5 / create request境界 / creation checkpoint DB契約から
// 機械的に導くStructured Output上限。
// - title / normalizedQuery / area は
//   202608250001_investigation_creation_idempotency.sql と同値。
// - Requirement由来の自由文/condition数はrequest query上限500を越えて
//   正当な追加条件を生成できないため500。
// - search/page参照: search_fetchのHard Ruleどおり各3。
// - claim数: §13の固定ClaimKey集合から、1 finding あたり14件を安全上限とする。
export const AI_OUTPUT_LIMITS = {
  titleChars: 500,
  normalizedQueryChars: 2_000,
  areaChars: 120,
  requirementTextChars: 500,
  searchQueryChars: 500,
  requirements: 500,
  summaryChars: 120,
  explanationChars: 80,
  claimRawTextChars: 30,
  searchQueries: 3,
  citations: 3,
  sourceUrls: 3,
  findings: 500,
  claimsPerFinding: 14,
} as const;

export const boundedStructuredClaimSchema = structuredClaimSchema.extend({
  rawText: z.string().min(1).max(AI_OUTPUT_LIMITS.claimRawTextChars),
});

// claim 配列から「valueがkey別schemaを通ったものだけ」を残す (§13: 失敗claimは破棄)
export function filterValidClaims(
  claims: StructuredClaimInput[],
): StructuredClaimInput[] {
  return claims.filter((c) => {
    const schema = claimValueSchemas[c.key as ValidClaimKey];
    return schema ? schema.safeParse(c.value).success : false;
  });
}

// ============================================================
// ParsedRequirements (§11, §25.1 / contracts/providers.md)
// ============================================================

export const requirementKindSchema = z.enum([
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

export const parsedRequirementsSchema = z.object({
  title: z.string().min(1).max(AI_OUTPUT_LIMITS.titleChars),
  normalizedQuery: z.string().min(1).max(
    AI_OUTPUT_LIMITS.normalizedQueryChars,
  ),
  area: z.string().min(1).max(AI_OUTPUT_LIMITS.areaChars),
  // Optional rail scope. Resolver owns station/line expansion; the LLM never
  // supplies a station sequence.
  locationScope: locationScopeSchema.optional(),
  requirements: z
    .array(
      z.object({
        text: z.string().min(1).max(AI_OUTPUT_LIMITS.requirementTextChars),
        normalizedText: z.string().min(1).max(
          AI_OUTPUT_LIMITS.requirementTextChars,
        ),
        kind: requirementKindSchema,
        priority: z.enum(["must", "should", "nice"]),
        weight: z.number().min(0).max(1),
      }).strict(),
    )
    .min(1)
    .max(AI_OUTPUT_LIMITS.requirements),
}).strict();

export type ParsedRequirements = z.infer<typeof parsedRequirementsSchema>;

// ============================================================
// GroundedCandidateInvestigation (§5, §12 / contracts/providers.md)
// confidence の 0..1 範囲チェックは schema で弾かず、§30 に従い
// コード側で「破棄して unknown」にする (clamp しない)。
// ============================================================

const publicHttpUrlSchema = z.string().url().refine(
  (value) => parsePublicHttpUrl(value) !== null,
  "citation URL must use http or https without userinfo",
);

export const groundedCandidateInvestigationSchema = z.object({
  summary: z.string().min(1).max(AI_OUTPUT_LIMITS.summaryChars),
  searchQueries: z.array(
    z.string().min(1).max(AI_OUTPUT_LIMITS.searchQueryChars),
  ).max(AI_OUTPUT_LIMITS.searchQueries),
  citations: z.array(
    z.object({ url: publicHttpUrlSchema, title: z.string().nullable() })
      .strict(),
  ).max(AI_OUTPUT_LIMITS.citations),
  findings: z.array(
    z.object({
      requirementId: z.string().min(1),
      state: z.enum(["match", "partial", "mismatch", "unknown"]),
      confidence: z.number(),
      explanation: z.string().max(AI_OUTPUT_LIMITS.explanationChars),
      sourceUrls: z.array(publicHttpUrlSchema).max(
        AI_OUTPUT_LIMITS.sourceUrls,
      ),
      claims: z
        .array(boundedStructuredClaimSchema)
        .max(AI_OUTPUT_LIMITS.claimsPerFinding)
        .transform((cs) =>
          cs.map((c) => ({ key: c.key, value: c.value, rawText: c.rawText }))
        ),
    }).strict(),
  ).max(AI_OUTPUT_LIMITS.findings),
  // Web Research の歩留まり計測 (#514)。件数と失敗理由の分類のみで、
  // URL・本文・クエリ内容は含めない (§34)。provider 実装は任意で埋める
  diagnostics: z
    .object({
      serperResults: z.number().int().nonnegative(),
      fetchAttempted: z.number().int().nonnegative(),
      fetchSucceeded: z.number().int().nonnegative(),
      fetchFailures: z.record(z.string(), z.number().int().nonnegative()),
    })
    .strict()
    .optional(),
}).strict();

export type GroundedCandidateInvestigation = z.infer<
  typeof groundedCandidateInvestigationSchema
>;

export type GroundedReferenceFailure =
  | "unknown_requirement"
  | "duplicate_requirement"
  | "unknown_citation";

/**
 * モデル/providerが返す参照は部分除去で温存しない。1件でも入力Requirement集合や
 * 実citation集合の外を指した場合、候補調査結果全体をinvalidとして再試行/unknownへ
 * 送るためのDB非依存ガード。
 */
export function validateGroundedCandidateReferences(
  value: GroundedCandidateInvestigation,
  allowedRequirementIds: ReadonlySet<string>,
): { ok: true } | { ok: false; reason: GroundedReferenceFailure } {
  const citationUrls = new Set(value.citations.map((citation) => citation.url));
  const seenRequirementIds = new Set<string>();
  for (const finding of value.findings) {
    if (!allowedRequirementIds.has(finding.requirementId)) {
      return { ok: false, reason: "unknown_requirement" };
    }
    if (seenRequirementIds.has(finding.requirementId)) {
      return { ok: false, reason: "duplicate_requirement" };
    }
    seenRequirementIds.add(finding.requirementId);
    if (finding.sourceUrls.some((url) => !citationUrls.has(url))) {
      return { ok: false, reason: "unknown_citation" };
    }
  }
  return { ok: true };
}

// ============================================================
// Edge Functions request bodies (contracts/*.md)
// ============================================================

export const createInvestigationBodySchema = z.object({
  query: z.string().min(1).max(500),
  displayName: z.string().min(1).max(40),
});

export const runInvestigationBodySchema = z.object({
  investigationId: z.string().uuid(),
  searchAnchor: locationAnchorSchema.optional(),
}).strict();

export const resolveLocationBodySchema = z.object({
  scope: locationScopeSchema,
}).strict();

export const rerankInvestigationBodySchema = z.object({
  investigationId: z.string().uuid(),
  trigger: z.enum(["vote", "requirement_added", "requirement_removed"]),
});

export const joinInvestigationBodySchema = z.object({
  shareToken: z.string().min(1),
  displayName: z.string().min(1).max(40),
});

// アカウント削除の対象はJWTのsubjectだけ。bodyから削除対象を受け取らない。
export const deleteAccountBodySchema = z.object({}).strict();

// 調査単位の削除対象はURL/bodyの調査IDだけ。所有者(user id)はEdge Functionが
// 検証したJWT subjectをRPCへ渡し、bodyからは受け取らない。
export const deleteInvestigationBodySchema = z.object({
  investigationId: z.string().uuid(),
}).strict();

// ============================================================
// Pre-Rank 出力 (issue #552 §Pre-Rank Output Contract)
// OpenRouter 経由の JSON Output は「valid JSON」しか保証しないため、
// Gemini の Structured Output と同格には扱わず必ずここで検証する。
// preScore / researchPriority の範囲外は schema で弾かずコード側で
// 「その候補だけ決定論結果へ落とす」(§30: clamp しない)。
// ============================================================

export const preRankOutputSchema = z.object({
  candidates: z.array(
    z.object({
      id: z.string().min(1),
      pre_score: z.number(),
      known_match: z.array(z.string()).default([]),
      known_mismatch: z.array(z.string()).default([]),
      unknown: z.array(z.string()).default([]),
      research_priority: z.number(),
      reason_codes: z.array(z.string()).default([]),
    }),
  ),
});

export type PreRankOutput = z.infer<typeof preRankOutputSchema>;
