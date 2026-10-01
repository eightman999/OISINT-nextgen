// #122 Group Taste Vector
//
// 現在の個人属性ベクトルを検索時だけ合成する純粋な境界。
// 組合せvectorをDBへ保存したり、個人のhard constraintを平均化したりしない。
import {
  EMBEDDING_DIMENSION,
  validateEmbedding,
} from "./embedding_validation.ts";

// #544 の user_attribute_vectors / aggregateable allow-list と同じ集合。
// health と hard constraint は個人の別経路に残し、Group Tasteへ入れない。
export const GROUP_TASTE_ATTRIBUTE_KEYS = [
  "evidence",
  "quiet",
  "value",
  "novelty",
  "groupFit",
] as const;

export type GroupTasteAttributeKey =
  (typeof GROUP_TASTE_ATTRIBUTE_KEYS)[number];

/** 合成式を変更するとcache keyも変わる、再現可能な固定version。 */
export const GROUP_TASTE_ALGORITHM_VERSION = "group-taste-v1" as const;

// #544 の model_version / source_version と同じDB識別子規則を再利用する。
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WEIGHT_EPSILON = 1e-12;

/**
 * #515/#544 の current member profile から検索に使える一つの属性vector。
 * 同じグループでも属性キーごとに別々に合成し、異なる属性vectorを混ぜない。
 */
export interface CurrentMemberTasteProfile {
  /** 内部の不透明なmember identifier。raw queryや説明文には出さない。 */
  memberId: string;
  /** #544 の aggregateable attribute_key。healthは受け付けない。 */
  attributeKey: string;
  /** 既存の places.embedding と同じ768次元vector。 */
  vector: readonly number[];
  /** 個人vectorを生成したmodel_version。混在時はfail-closed。 */
  modelVersion: string;
  /** #515 current profile/vectorの版。更新時にcacheを無効化する。 */
  sourceProfileVersion: string;
}

export interface GroupTasteMemberInput {
  profile: CurrentMemberTasteProfile;
  /** context/group policyから呼び出し側が明示する未正規化weight。 */
  weight: number;
}

/**
 * hard constraintは既存requirement経路の参照だけを別に渡す。
 * raw allergy textや個人属性値をこの型へ入れず、vector計算には一切使わない。
 */
export interface GroupTasteHardConstraintBoundary {
  requirementIds: readonly string[];
}

export interface GroupTasteCompositionInput {
  members: readonly GroupTasteMemberInput[];
  /** 正規化後の各member weight上限。明示されない方針は受け付けない。 */
  dominanceCap: number;
  hardConstraints?: GroupTasteHardConstraintBoundary;
}

export interface GroupTasteContribution {
  memberId: string;
  sourceProfileVersion: string;
  modelVersion: string;
  requestedWeight: number;
  effectiveWeight: number;
}

export interface GroupTasteSourceProfileVersion {
  memberId: string;
  sourceProfileVersion: string;
  modelVersion: string;
}

export interface GroupTasteVector {
  /** current place vectorとの同一属性検索へ渡すキー。 */
  attributeKey: GroupTasteAttributeKey;
  vector: number[];
  algorithmVersion: typeof GROUP_TASTE_ALGORITHM_VERSION;
  /** member/version manifestを並べた決定論的なsource version。 */
  sourceProfileVersion: string;
  sourceProfileVersions: readonly GroupTasteSourceProfileVersion[];
  modelVersion: string;
  dominanceCap: number;
  weights: readonly GroupTasteContribution[];
  contributions: readonly GroupTasteContribution[];
  /** hard constraintはvector外で、candidate filterへ渡す参照として保持する。 */
  hardConstraints: GroupTasteHardConstraintBoundary;
  cacheKey: string;
}

/** current place vector RPCへ渡す、安全な最小入力。 */
export interface PlaceVectorCandidateSearchInput {
  queryEmbedding: number[];
  attributeKey: GroupTasteAttributeKey;
  algorithmVersion: typeof GROUP_TASTE_ALGORITHM_VERSION;
  sourceProfileVersion: string;
  /** filter側で適用し、queryEmbeddingへ混ぜない。 */
  hardConstraints: GroupTasteHardConstraintBoundary;
}

interface PreparedMember extends GroupTasteMemberInput {
  profile: CurrentMemberTasteProfile & { vector: number[] };
}

interface PreparedComposition {
  members: PreparedMember[];
  attributeKey: GroupTasteAttributeKey;
  modelVersion: string;
  dominanceCap: number;
  hardConstraints: GroupTasteHardConstraintBoundary;
}

/**
 * current member profilesを合成する純関数。
 * 不明なattribute/model/source version、次元不一致、非finite値、weight不正は
 * 補完せずnullへ倒す。合成vector自体は永続化せず、呼び出し元の検索一回で使う。
 */
export async function composeGroupTasteVector(
  input: GroupTasteCompositionInput,
): Promise<GroupTasteVector | null> {
  const prepared = prepareComposition(input);
  if (!prepared) return null;

  const effectiveWeights = cappedNormalizedWeights(
    prepared.members.map((member) => member.weight),
    prepared.dominanceCap,
  );
  if (!effectiveWeights) return null;

  const vector = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  const contributions = prepared.members.map((member, index) => ({
    memberId: member.profile.memberId,
    sourceProfileVersion: member.profile.sourceProfileVersion,
    modelVersion: member.profile.modelVersion,
    requestedWeight: member.weight,
    effectiveWeight: effectiveWeights[index],
  }));

  for (
    let memberIndex = 0;
    memberIndex < prepared.members.length;
    memberIndex++
  ) {
    const memberVector = prepared.members[memberIndex].profile.vector;
    const weight = effectiveWeights[memberIndex];
    for (let dimension = 0; dimension < EMBEDDING_DIMENSION; dimension++) {
      vector[dimension] += memberVector[dimension] * weight;
      if (!Number.isFinite(vector[dimension])) return null;
    }
  }

  const checked = validateEmbedding(vector);
  if (!checked.ok) return null;

  const sourceProfileVersions = prepared.members.map((member) => ({
    memberId: member.profile.memberId,
    sourceProfileVersion: member.profile.sourceProfileVersion,
    modelVersion: member.profile.modelVersion,
  }));
  const sourceProfileVersion = sourceProfileVersions
    .map((entry) =>
      `${entry.memberId}=${entry.modelVersion}@${entry.sourceProfileVersion}`
    )
    .join(",");
  const cacheKey = await buildPreparedCacheKey(prepared);

  return {
    attributeKey: prepared.attributeKey,
    vector: checked.value,
    algorithmVersion: GROUP_TASTE_ALGORITHM_VERSION,
    sourceProfileVersion,
    sourceProfileVersions,
    modelVersion: prepared.modelVersion,
    dominanceCap: prepared.dominanceCap,
    // weights/contributionsは同じ決定論的manifestを、説明用途と計算追跡用途へ
    // 明示的に分ける。配列は外部から変更できないよう新しい値で返す。
    weights: contributions.map((contribution) => ({ ...contribution })),
    contributions: contributions.map((contribution) => ({ ...contribution })),
    hardConstraints: {
      requirementIds: [...prepared.hardConstraints.requirementIds],
    },
    cacheKey,
  };
}

/**
 * source/profile version・vector内容・member構成・weight・hard requirementが
 * 一つでも変われば別keyになる短期cache用key。DB row/vectorは作らない。
 */
export async function buildGroupTasteVectorCacheKey(
  input: GroupTasteCompositionInput,
): Promise<string | null> {
  const prepared = prepareComposition(input);
  return prepared ? await buildPreparedCacheKey(prepared) : null;
}

export async function isGroupTasteVectorCacheValid(
  cached:
    | Pick<GroupTasteVector, "cacheKey" | "algorithmVersion" | "vector">
    | null
    | undefined,
  input: GroupTasteCompositionInput,
): Promise<boolean> {
  if (!cached || cached.algorithmVersion !== GROUP_TASTE_ALGORITHM_VERSION) {
    return false;
  }
  const checked = validateEmbedding(cached.vector);
  if (!checked.ok) return false;
  const currentKey = await buildGroupTasteVectorCacheKey(input);
  return currentKey !== null && cached.cacheKey === currentKey;
}

/**
 * Group vectorを既存 current-place-vector 検索へ渡せる形へ落とす。
 * hard constraintをquery embeddingへ連結せず、別のfilter経路として残す。
 */
export function toPlaceVectorCandidateSearchInput(
  group: GroupTasteVector | null | undefined,
): PlaceVectorCandidateSearchInput | null {
  if (!group || group.algorithmVersion !== GROUP_TASTE_ALGORITHM_VERSION) {
    return null;
  }
  if (!isGroupTasteAttributeKey(group.attributeKey)) return null;
  if (
    typeof group.modelVersion !== "string" ||
    !VERSION_PATTERN.test(group.modelVersion)
  ) return null;
  if (
    typeof group.sourceProfileVersion !== "string" ||
    !group.sourceProfileVersion ||
    group.sourceProfileVersion.length > 16_384
  ) {
    return null;
  }
  if (
    !Number.isFinite(group.dominanceCap) ||
    group.dominanceCap <= 0 ||
    group.dominanceCap > 1
  ) return null;
  if (
    typeof group.cacheKey !== "string" ||
    !new RegExp(
      `^group-taste:${GROUP_TASTE_ALGORITHM_VERSION}:[0-9a-f]{64}$`,
    ).test(group.cacheKey)
  ) return null;
  const checked = validateEmbedding(group.vector);
  if (!checked.ok) return null;
  const hardConstraints = normalizeHardConstraints(group.hardConstraints);
  if (!hardConstraints) return null;
  return {
    queryEmbedding: checked.value,
    attributeKey: group.attributeKey,
    algorithmVersion: GROUP_TASTE_ALGORITHM_VERSION,
    sourceProfileVersion: group.sourceProfileVersion,
    hardConstraints,
  };
}

function prepareComposition(
  input: GroupTasteCompositionInput,
): PreparedComposition | null {
  if (!input || !Array.isArray(input.members) || input.members.length === 0) {
    return null;
  }
  if (
    typeof input.dominanceCap !== "number" ||
    !Number.isFinite(input.dominanceCap) ||
    input.dominanceCap <= 0 ||
    input.dominanceCap > 1 ||
    input.dominanceCap * input.members.length < 1 - WEIGHT_EPSILON
  ) {
    return null;
  }

  const hardConstraints = normalizeHardConstraints(input.hardConstraints);
  if (!hardConstraints) return null;

  const members: PreparedMember[] = [];
  const memberIds = new Set<string>();
  let attributeKey: GroupTasteAttributeKey | undefined;
  let modelVersion: string | undefined;

  for (const member of input.members) {
    if (!member || typeof member !== "object") return null;
    if (
      typeof member.weight !== "number" ||
      !Number.isFinite(member.weight) ||
      member.weight <= 0
    ) return null;
    const profile = member.profile;
    if (!profile || typeof profile !== "object") return null;
    if (!isOpaqueId(profile.memberId) || memberIds.has(profile.memberId)) {
      return null;
    }
    if (!isGroupTasteAttributeKey(profile.attributeKey)) return null;
    if (!VERSION_PATTERN.test(profile.modelVersion)) return null;
    if (!VERSION_PATTERN.test(profile.sourceProfileVersion)) return null;
    const checked = validateEmbedding(profile.vector);
    if (!checked.ok) return null;

    if (attributeKey && profile.attributeKey !== attributeKey) return null;
    if (modelVersion && profile.modelVersion !== modelVersion) return null;
    attributeKey = profile.attributeKey;
    modelVersion = profile.modelVersion;
    memberIds.add(profile.memberId);
    members.push({
      profile: { ...profile, vector: checked.value },
      weight: member.weight,
    });
  }

  // 並び順を固定して、呼び出し側のmember取得順に依存しない結果へする。
  members.sort((left, right) =>
    compareOpaqueStrings(left.profile.memberId, right.profile.memberId)
  );
  if (!attributeKey || !modelVersion) return null;

  return {
    members,
    attributeKey,
    modelVersion,
    dominanceCap: input.dominanceCap,
    hardConstraints,
  };
}

function cappedNormalizedWeights(
  requestedWeights: readonly number[],
  dominanceCap: number,
): number[] | null {
  if (
    requestedWeights.length === 0 ||
    !Number.isFinite(dominanceCap) ||
    dominanceCap <= 0 ||
    dominanceCap > 1 ||
    dominanceCap * requestedWeights.length < 1 - WEIGHT_EPSILON
  ) return null;

  const result = new Array<number>(requestedWeights.length).fill(0);
  const remaining = new Set(requestedWeights.map((_, index) => index));
  let remainingMass = 1;

  while (remaining.size > 0) {
    let totalRequested = 0;
    for (const index of remaining) totalRequested += requestedWeights[index];
    if (!Number.isFinite(totalRequested) || totalRequested <= 0) return null;

    const capped: number[] = [];
    for (const index of remaining) {
      const proposed = remainingMass * requestedWeights[index] / totalRequested;
      if (!Number.isFinite(proposed)) return null;
      if (proposed > dominanceCap + WEIGHT_EPSILON) capped.push(index);
    }

    if (capped.length === 0) {
      for (const index of remaining) {
        result[index] = remainingMass * requestedWeights[index] /
          totalRequested;
      }
      break;
    }

    for (const index of capped) {
      result[index] = dominanceCap;
      remaining.delete(index);
      remainingMass -= dominanceCap;
    }
    if (remainingMass < -WEIGHT_EPSILON) return null;
    if (remaining.size > 0 && remainingMass <= WEIGHT_EPSILON) return null;
  }

  const sum = result.reduce((total, value) => total + value, 0);
  if (
    !Number.isFinite(sum) ||
    Math.abs(sum - 1) > 1e-9 ||
    result.some((value) =>
      !Number.isFinite(value) || value <= 0 || value > dominanceCap + 1e-9
    )
  ) return null;
  return result;
}

function normalizeHardConstraints(
  input: GroupTasteHardConstraintBoundary | null | undefined,
): GroupTasteHardConstraintBoundary | null {
  if (input === undefined || input === null) return { requirementIds: [] };
  if (!input || !Array.isArray(input.requirementIds)) return null;
  const ids = new Set<string>();
  for (const value of input.requirementIds) {
    if (!isOpaqueId(value)) return null;
    ids.add(value);
  }
  return {
    requirementIds: [...ids].sort(compareOpaqueStrings),
  };
}

function isGroupTasteAttributeKey(
  value: unknown,
): value is GroupTasteAttributeKey {
  return (
    typeof value === "string" &&
    (GROUP_TASTE_ATTRIBUTE_KEYS as readonly string[]).includes(value)
  );
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function compareOpaqueStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function buildPreparedCacheKey(
  prepared: PreparedComposition,
): Promise<string> {
  const descriptor = {
    algorithmVersion: GROUP_TASTE_ALGORITHM_VERSION,
    attributeKey: prepared.attributeKey,
    modelVersion: prepared.modelVersion,
    dominanceCap: prepared.dominanceCap,
    hardConstraintRequirementIds: prepared.hardConstraints.requirementIds,
    members: prepared.members.map((member) => ({
      memberId: member.profile.memberId,
      requestedWeight: member.weight,
      sourceProfileVersion: member.profile.sourceProfileVersion,
      modelVersion: member.profile.modelVersion,
      vector: member.profile.vector,
    })),
  };
  return `group-taste:${GROUP_TASTE_ALGORITHM_VERSION}:${await sha256Hex(
    JSON.stringify(descriptor),
  )}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
