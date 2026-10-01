export interface EvaluationCoverageRow {
  candidateId: string;
  requirementId: string;
}

// candidate × current requirement の全組が存在する時だけ完了扱いにする。
// 重複行、他候補、削除済み requirement は coverage を水増ししない。
export function pendingCandidateIdsForCoverage(
  candidateIds: readonly string[],
  requirementIds: readonly string[],
  rows: readonly EvaluationCoverageRow[],
): string[] {
  if (requirementIds.length === 0) return [];

  const currentCandidates = new Set(candidateIds);
  const currentRequirements = new Set(requirementIds);
  const covered = new Map<string, Set<string>>();
  for (const row of rows) {
    if (
      !currentCandidates.has(row.candidateId) ||
      !currentRequirements.has(row.requirementId)
    ) continue;
    const requirements = covered.get(row.candidateId) ?? new Set<string>();
    requirements.add(row.requirementId);
    covered.set(row.candidateId, requirements);
  }

  return candidateIds.filter((candidateId) =>
    (covered.get(candidateId)?.size ?? 0) !== currentRequirements.size
  );
}
