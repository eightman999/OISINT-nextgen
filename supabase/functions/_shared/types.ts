// 共有ドメイン型 (spec.md §10–§13, §15)

// §10 Investigation States
export type InvestigationStatus =
  | "draft"
  | "parsing"
  | "recalling"
  | "searching"
  | "collecting_evidence"
  | "evaluating"
  | "ranking"
  | "complete"
  | "failed";

// §11 Requirement Model
export type RequirementKind =
  | "location"
  | "budget"
  | "cuisine"
  | "payment"
  | "reservation"
  | "atmosphere"
  | "party_size"
  | "time"
  | "access"
  | "dietary"
  | "other";

export type RequirementPriority = "must" | "should" | "nice";

export interface Requirement {
  id: string;
  text: string;
  normalizedText: string;
  kind: RequirementKind;
  priority: RequirementPriority;
  weight: number;
}

// §12 Candidate Evaluation
export type MatchState = "match" | "partial" | "mismatch" | "unknown";

export interface RequirementEvaluation {
  requirementId: string;
  state: MatchState;
  confidence: number;
  explanation: string;
  evidenceIds: string[];
}

// §13 Evidence / StructuredClaim
export type ClaimKey =
  | "opening_hours"
  | "closed_days"
  | "budget_dinner"
  | "card_accepted"
  | "reservation"
  | "private_room"
  | "capacity"
  | "genre"
  | "noise_level"
  | "time_limit"
  | "non_smoking"
  | "wifi_available"
  | "child_friendly"
  | "nearest_station_walk_minutes"
  // OISI共通層の汎用claim。旧restaurant keyとの互換を保ちつつ、
  // 新ドメインでは夕食専用の名前を使わない (#125)。
  | "category"
  | "price_range"
  | "amenities"
  // domain固有claimは名前空間へ隔離する。実provider未接続のものを
  // restaurant factへ変換せず、未対応ならunknownとして保持する。
  | "lodging.room_type"
  | "lodging.check_in_time"
  | "lodging.check_out_time"
  | "rental_space.equipment";

export interface StructuredClaim {
  key: ClaimKey;
  value: unknown; // key ごとに Zod schema で検証 (validation.ts)
  rawText: string; // 根拠となった原文の抜粋 (15語程度)
}

// §14 Source Reliability
export type SourceType =
  | "official_site"
  | "official_reservation"
  | "major_place_provider"
  | "major_review_platform"
  | "other_public_page"
  | "unknown";

// §15 Contradiction Detection
export interface Contradiction {
  placeId: string;
  key: ClaimKey;
  entries: { evidenceId: string; value: unknown; sourceQuality: number }[];
}
