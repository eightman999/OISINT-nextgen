export interface PendingInvestigationRun {
  investigationId: string;
  shareToken: string;
  inputFingerprint: string;
}

export interface InvestigationInputFingerprintSource {
  query: string;
  selectedChips: readonly string[];
  location: {
    label: string;
    source: string;
    latitude?: number;
    longitude?: number;
  } | null;
  displayName: string;
  tasteProfile: {
    likes: readonly string[];
    avoid: readonly string[];
    allergies: string;
    healthGoal: string;
  };
}

/** 機微な入力本文を保持せず、メモリ上の再試行判定用 fingerprint だけを作る。 */
export function buildInvestigationInputFingerprint(
  input: InvestigationInputFingerprintSource,
): string {
  const serialized = JSON.stringify({
    query: input.query,
    selectedChips: [...input.selectedChips],
    location: input.location,
    displayName: input.displayName,
    tasteProfile: {
      likes: [...input.tasteProfile.likes],
      avoid: [...input.tasteProfile.avoid],
      allergies: input.tasteProfile.allergies,
      healthGoal: input.tasteProfile.healthGoal,
    },
  });
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * create 成功後の再試行は同じ investigation を優先する。
 * create が失敗した場合だけ新規応答を採用し、二重作成を避ける。
 */
export function resolveInvestigationRunTarget(
  pending: PendingInvestigationRun | null,
  currentFingerprint: string,
  created: PendingInvestigationRun | null = null,
): PendingInvestigationRun | null {
  return pending?.inputFingerprint === currentFingerprint ? pending : created;
}
