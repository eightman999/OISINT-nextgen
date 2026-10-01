// Hackathon の内部評価ロジック。
// 公式審査員の採点を再現するものではなく、入力された証拠を公式配点へ
// 透明に対応付けるための純関数。未検証の項目を自動加点しない。

export const HACKATHON_SCORE_WEIGHTS = {
  sponsorTools: 25,
  completeness: 25,
  idea: 20,
  impact: 15,
  presentation: 15,
} as const;

export type HackathonScoreDimension = keyof typeof HACKATHON_SCORE_WEIGHTS;

export type ScoreEvidenceStatus = 'VERIFIED' | 'NOT_VERIFIED';

export interface HackathonDimensionEvidence {
  points: number;
  status: ScoreEvidenceStatus;
  evidence: string[];
}

export type HackathonScoreInput = Partial<
  Record<HackathonScoreDimension, HackathonDimensionEvidence>
>;

export interface HackathonScoreBreakdown {
  dimension: HackathonScoreDimension;
  points: number;
  maxPoints: number;
  status: ScoreEvidenceStatus;
  evidence: string[];
}

export interface HackathonScore {
  total: number;
  breakdown: HackathonScoreBreakdown[];
  validationErrors: string[];
}

export const RELEASE_EVIDENCE_GATE_PHASES = {
  candidate: [
    'productionMockFree',
    'releaseSecurity',
    'rlsNegativeTests',
    'migrationDryRun',
    'costGuardConfigured',
    'rollbackReady',
    'deterministicE2E',
  ],
  production: [
    'productionDbAligned',
    'liveE2E',
    'productionMonitoring',
    'authRouteSmoke',
  ],
} as const;

export type ReleaseEvidenceStatus = 'PASS' | 'FAIL' | 'NOT_VERIFIED';
export type ReleaseEvidenceGate =
  (typeof RELEASE_EVIDENCE_GATE_PHASES)[keyof typeof RELEASE_EVIDENCE_GATE_PHASES][number];
export type ReleaseEvidenceGates = Partial<Record<ReleaseEvidenceGate, ReleaseEvidenceStatus>>;

export interface ReleaseReadiness {
  status: 'GO' | 'NO-GO';
  candidateStatus: 'READY' | 'NO-GO';
  productionStatus: 'VERIFIED' | 'FAIL' | 'NOT_VERIFIED';
  blockingGates: ReleaseEvidenceGate[];
  failedGates: ReleaseEvidenceGate[];
  notVerifiedGates: ReleaseEvidenceGate[];
}

export function calculateHackathonScore(input: HackathonScoreInput): HackathonScore {
  const validationErrors: string[] = [];
  const breakdown = (Object.keys(HACKATHON_SCORE_WEIGHTS) as HackathonScoreDimension[]).map((dimension) => {
    const item = input[dimension];
    const evidence = [...new Set((item?.evidence ?? []).map((value) => value.trim()).filter(Boolean))];
    const verified = item?.status === 'VERIFIED' && evidence.length > 0;
    if (item?.status === 'VERIFIED' && evidence.length === 0) {
      validationErrors.push(`${dimension}: VERIFIEDには証拠参照が必要です`);
    }
    if (item?.status !== 'VERIFIED' && (item?.points ?? 0) > 0) {
      validationErrors.push(`${dimension}: NOT_VERIFIEDの点数は加点できません`);
    }
    if ((item?.points ?? 0) > HACKATHON_SCORE_WEIGHTS[dimension]) {
      validationErrors.push(`${dimension}: 配点上限を超えています`);
    }
    const status: ScoreEvidenceStatus = verified ? 'VERIFIED' : 'NOT_VERIFIED';
    return {
      dimension,
      points: verified ? clamp(item?.points ?? 0, 0, HACKATHON_SCORE_WEIGHTS[dimension]) : 0,
      maxPoints: HACKATHON_SCORE_WEIGHTS[dimension],
      status,
      evidence,
    };
  });

  return {
    total: breakdown.reduce((sum, item) => sum + item.points, 0),
    breakdown,
    validationErrors,
  };
}

export function evaluateReleaseReadiness(gates: ReleaseEvidenceGates): ReleaseReadiness {
  const allGates = [
    ...RELEASE_EVIDENCE_GATE_PHASES.candidate,
    ...RELEASE_EVIDENCE_GATE_PHASES.production,
  ];
  const statusOf = (gate: ReleaseEvidenceGate): ReleaseEvidenceStatus =>
    gates[gate] ?? 'NOT_VERIFIED';
  const blockingGates = allGates.filter((gate) => statusOf(gate) !== 'PASS');
  const failedGates = allGates.filter((gate) => statusOf(gate) === 'FAIL');
  const notVerifiedGates = allGates.filter((gate) => statusOf(gate) === 'NOT_VERIFIED');
  const candidateStatus = RELEASE_EVIDENCE_GATE_PHASES.candidate.every(
    (gate) => statusOf(gate) === 'PASS',
  ) ? 'READY' : 'NO-GO';
  const productionStatuses = RELEASE_EVIDENCE_GATE_PHASES.production.map(statusOf);
  const productionStatus = productionStatuses.includes('FAIL')
    ? 'FAIL'
    : productionStatuses.every((status) => status === 'PASS')
      ? 'VERIFIED'
      : 'NOT_VERIFIED';

  return {
    status: blockingGates.length === 0 ? 'GO' : 'NO-GO',
    candidateStatus,
    productionStatus,
    blockingGates,
    failedGates,
    notVerifiedGates,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
