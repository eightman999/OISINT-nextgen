// OISI共通層とNT層のドメイン境界 (#125 / spec.md §1.1, §44.6)
//
// Place / Evidence / StructuredClaim / freshness / contradiction は OISI 共通層に
// 残し、どの用途へ順位付けするかは NT 側の識別子で表す。ここには外部 provider
// や実データを置かない。未接続のドメインは「対応済み」とみなさず、呼び出し側が
// mock-only / contract-only を見て unknown へ倒せるようにする。
import {
  filterValidClaims,
  type StructuredClaimInput,
  structuredClaimSchema,
} from "./validation.ts";
import type { ClaimKey, StructuredClaim } from "./types.ts";

/** spec.md §3 P2 に列挙された対象。IDはコード用の安定した語彙とする。 */
export const OISI_DOMAIN_IDS = [
  "restaurant",
  "lodging",
  "rental_space",
  "destination",
  "secondhand",
  "event",
] as const;

export type OisiDomain = (typeof OISI_DOMAIN_IDS)[number];

/** spec.md §1.1 の NT 表現。自然言語ラベルではなく保存可能なIDだけを持つ。 */
export const NT_PROFILE_IDS = [
  "navigation_taste",
  "novelty_taste",
  "needs_trends",
  "networks_trends",
  "navigation_tourism",
  "network_taste",
] as const;

export type NtProfileId = (typeof NT_PROFILE_IDS)[number];

/** 実providerのcoverageではなく、現在のローカル契約の到達範囲を表す。 */
export type DomainAvailability = "baseline" | "mock_only" | "contract_only";

export type DomainRunMode = "mock" | "live";

/** 宿泊adapterが受け取る正規化前フィールド。live providerの実装を意味しない。 */
export type LodgingClaimSourceField =
  | "category"
  | "price_range"
  | "reservation"
  | "capacity"
  | "amenities"
  | "room_type"
  | "check_in_time"
  | "check_out_time";

/** validation.ts の固定schemaへ結び付ける宿泊claimの型ID。 */
export type LodgingClaimSchemaId =
  | "category_array"
  | "price_range"
  | "boolean"
  | "positive_number"
  | "amenities_array"
  | "room_type"
  | "clock_time";

export type LodgingClaimKey =
  | "category"
  | "price_range"
  | "reservation"
  | "capacity"
  | "amenities"
  | "lodging.room_type"
  | "lodging.check_in_time"
  | "lodging.check_out_time";

export interface DomainClaimMapping {
  sourceField: LodgingClaimSourceField;
  targetKey: LodgingClaimKey;
  schema: LodgingClaimSchemaId;
  uiLabel: string;
}

export interface DomainPromptFragment {
  domainInstruction: string;
  claimRules: readonly string[];
}

export interface DomainFailClosedPolicy {
  liveMode: "deny";
  invalidClaim: "reject";
  unknownClaim: "retain_unknown";
  missingExplicitDomain: "deny";
}

/** domain adapterが実装前に固定する、schema/mapping/prompt/UI/停止条件。 */
export interface DomainAdapterContract {
  id: OisiDomain;
  availability: DomainAvailability;
  claimMappings: readonly DomainClaimMapping[];
  promptFragment: DomainPromptFragment;
  uiLabels: Readonly<Partial<Record<ClaimKey, string>>>;
  failClosed: DomainFailClosedPolicy;
}

/**
 * 無印のClaimKeyは複数ドメインで共有し、domain固有の値だけを名前空間へ
 * 置く。旧restaurant keyは既存Evidenceとの後方互換のため profile に残すが、
 * 新ドメインの契約へは持ち込まない。
 */
const SHARED_CLAIM_KEYS: readonly ClaimKey[] = [
  "opening_hours",
  "closed_days",
  "card_accepted",
  "reservation",
  "capacity",
  "category",
  "price_range",
  "amenities",
];

const LEGACY_RESTAURANT_CLAIM_KEYS: readonly ClaimKey[] = [
  "budget_dinner",
  "private_room",
  "genre",
  "noise_level",
  "time_limit",
  "non_smoking",
  "wifi_available",
  "child_friendly",
  "nearest_station_walk_minutes",
];

const LODGING_CLAIM_KEYS: readonly ClaimKey[] = [
  ...SHARED_CLAIM_KEYS,
  "lodging.room_type",
  "lodging.check_in_time",
  "lodging.check_out_time",
];

const RENTAL_SPACE_CLAIM_KEYS: readonly ClaimKey[] = [
  ...SHARED_CLAIM_KEYS,
  "rental_space.equipment",
];

/**
 * 宿泊はこの契約を満たすmockだけを使う。sourceFieldは将来のadapter入力名、
 * targetKeyはOISIへ保存する固定ClaimKeyであり、実provider接続を表さない。
 */
export const LODGING_ADAPTER_CONTRACT = {
  id: "lodging",
  availability: "mock_only",
  claimMappings: [
    {
      sourceField: "category",
      targetKey: "category",
      schema: "category_array",
      uiLabel: "カテゴリ",
    },
    {
      sourceField: "price_range",
      targetKey: "price_range",
      schema: "price_range",
      uiLabel: "料金帯",
    },
    {
      sourceField: "reservation",
      targetKey: "reservation",
      schema: "boolean",
      uiLabel: "予約",
    },
    {
      sourceField: "capacity",
      targetKey: "capacity",
      schema: "positive_number",
      uiLabel: "定員",
    },
    {
      sourceField: "amenities",
      targetKey: "amenities",
      schema: "amenities_array",
      uiLabel: "設備",
    },
    {
      sourceField: "room_type",
      targetKey: "lodging.room_type",
      schema: "room_type",
      uiLabel: "客室タイプ",
    },
    {
      sourceField: "check_in_time",
      targetKey: "lodging.check_in_time",
      schema: "clock_time",
      uiLabel: "チェックイン",
    },
    {
      sourceField: "check_out_time",
      targetKey: "lodging.check_out_time",
      schema: "clock_time",
      uiLabel: "チェックアウト",
    },
  ],
  promptFragment: {
    domainInstruction:
      "対象domain=lodging。宿泊ページに明記された値だけを返し、別domainの情報を混同しない。",
    claimRules: [
      "price_range は {min,max,currency(ISO 4217 3文字),unit} とし、通貨・単位を換算しない。",
      "lodging.room_type / lodging.check_in_time / lodging.check_out_time は宿泊情報に明記された値だけを返す。",
      "対象domainに該当しないclaimや根拠のない条件は返さず、unknownとして扱う。",
    ],
  },
  uiLabels: {
    category: "カテゴリ",
    price_range: "料金帯",
    reservation: "予約",
    capacity: "定員",
    amenities: "設備",
    "lodging.room_type": "客室タイプ",
    "lodging.check_in_time": "チェックイン",
    "lodging.check_out_time": "チェックアウト",
  },
  failClosed: {
    liveMode: "deny",
    invalidClaim: "reject",
    unknownClaim: "retain_unknown",
    missingExplicitDomain: "deny",
  },
} as const satisfies DomainAdapterContract;

export interface DomainProfile {
  id: OisiDomain;
  availability: DomainAvailability;
  /** このprofileで採用可能な、validator通過済みclaimのキー集合。 */
  claimKeys: readonly ClaimKey[];
  adapter?: DomainAdapterContract;
}

export const DOMAIN_PROFILES: Readonly<Record<OisiDomain, DomainProfile>> = {
  restaurant: {
    id: "restaurant",
    availability: "baseline",
    claimKeys: [...SHARED_CLAIM_KEYS, ...LEGACY_RESTAURANT_CLAIM_KEYS],
  },
  // 宿泊は schema drift を local mock で検証するための最小縦実証。
  // live provider / production coverage は別の owner gate が必要である。
  lodging: {
    id: "lodging",
    availability: "mock_only",
    claimKeys: LODGING_CLAIM_KEYS,
    adapter: LODGING_ADAPTER_CONTRACT,
  },
  rental_space: {
    id: "rental_space",
    availability: "contract_only",
    claimKeys: RENTAL_SPACE_CLAIM_KEYS,
  },
  destination: {
    id: "destination",
    availability: "contract_only",
    claimKeys: SHARED_CLAIM_KEYS,
  },
  secondhand: {
    id: "secondhand",
    availability: "contract_only",
    claimKeys: ["category", "price_range", "amenities"],
  },
  event: {
    id: "event",
    availability: "contract_only",
    claimKeys: SHARED_CLAIM_KEYS,
  },
};

/** 検証済み入力からprofileが採用するclaimだけを取り出す結果。 */
export interface DomainClaimProjection {
  domain: OisiDomain;
  availability: DomainAvailability;
  claims: StructuredClaim[];
  /** profile外、または未接続domainで利用できずunknownとなるkey。 */
  unknownClaimKeys: string[];
  /** 型または値schemaに違反し、採用せず破棄したkey。値は保持しない。 */
  rejectedClaimKeys: string[];
}

export function getDomainProfile(value: unknown): DomainProfile | null {
  if (typeof value !== "string") return null;
  return Object.prototype.hasOwnProperty.call(DOMAIN_PROFILES, value)
    ? DOMAIN_PROFILES[value as OisiDomain]
    : null;
}

export function getNtProfile(value: unknown): NtProfileId | null {
  return typeof value === "string" &&
      (NT_PROFILE_IDS as readonly string[]).includes(value)
    ? value as NtProfileId
    : null;
}

/**
 * filterValidClaims() 後の値をdomain profileへ投影する。ここで値を補完したり、
 * 未知keyを別名へ変換したりしない。未採用keyは unknownClaimKeys に残るため、
 * 呼び出し側は「情報が無い」と「未対応」を match/mismatch と混同しない。
 */
export function projectClaimsForDomain(
  domain: unknown,
  claims: readonly StructuredClaim[],
): DomainClaimProjection | null {
  const profile = getDomainProfile(domain);
  if (!profile) return null;
  const allowed = new Set(profile.claimKeys);
  const validClaims: StructuredClaim[] = [];
  const rejectedClaimKeys: string[] = [];
  for (const candidate of claims as readonly unknown[]) {
    const candidateKey = typeof candidate === "object" && candidate !== null &&
        typeof (candidate as { key?: unknown }).key === "string"
      ? (candidate as { key: string }).key
      : null;
    const shape = structuredClaimSchema.safeParse(candidate);
    if (!shape.success) {
      if (candidateKey) rejectedClaimKeys.push(candidateKey);
      continue;
    }
    // 呼び出し元が「filterValidClaims済み」と型付けしても、ここで値schemaを再確認する。
    const [validated] = filterValidClaims([
      shape.data as StructuredClaimInput,
    ]);
    if (!validated) {
      rejectedClaimKeys.push(shape.data.key);
      continue;
    }
    validClaims.push(validated as StructuredClaim);
  }
  const projected = validClaims.filter((claim) => allowed.has(claim.key));
  const unknownClaimKeys = [
    ...new Set(
      validClaims
        .map((claim) => claim.key)
        .filter((key) => !allowed.has(key)),
    ),
  ].sort();
  return {
    domain: profile.id,
    availability: profile.availability,
    claims: projected.map((claim) => ({ ...claim })),
    unknownClaimKeys,
    rejectedClaimKeys: [...new Set(rejectedClaimKeys)].sort(),
  };
}

/** provider resultが要求domainを明示していない場合は別domainへ流さない。 */
export function acceptsDomainResult(
  domain: unknown,
  result: unknown,
): boolean {
  const profile = getDomainProfile(domain);
  if (!profile || typeof result !== "object" || result === null) return false;
  return (result as { domain?: unknown }).domain === profile.id;
}

/** live providerを未接続のdomainへ誤って向けないための一つの判定点。 */
export function canRunDomainInMode(
  domain: unknown,
  mode: DomainRunMode,
): boolean {
  const profile = getDomainProfile(domain);
  if (!profile) return false;
  if (profile.availability === "baseline") return true;
  return profile.availability === "mock_only" && mode === "mock";
}

/** NT profileは常に既存candidate/ranking入力へ乗る。domain別ranking分岐は持たない。 */
export interface NtRankingBoundary {
  ntProfile: NtProfileId;
  domain: OisiDomain;
  inputKind: "oisi_candidate";
}

export function buildNtRankingBoundary(
  ntProfile: unknown,
  domain: unknown,
): NtRankingBoundary | null {
  const profile = getNtProfile(ntProfile);
  const resolvedDomain = getDomainProfile(domain);
  if (!profile || !resolvedDomain) return null;
  return {
    ntProfile: profile,
    domain: resolvedDomain.id,
    inputKind: "oisi_candidate",
  };
}
