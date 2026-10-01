import { describe, expect, it } from 'vitest';

import {
  calculateHackathonScore,
  evaluateReleaseReadiness,
  HACKATHON_SCORE_WEIGHTS,
  RELEASE_EVIDENCE_GATE_PHASES,
  type ReleaseEvidenceGates,
} from './hackathonScorecard';

describe('hackathon scorecard', () => {
  it('uses the documented 25/25/20/15/15 weighting without over-scoring', () => {
    expect(Object.values(HACKATHON_SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBe(100);
    const evidence = (points: number) => ({ points, status: 'VERIFIED' as const, evidence: ['artifact.json'] });
    expect(calculateHackathonScore({
      sponsorTools: evidence(25),
      completeness: evidence(25),
      idea: evidence(20),
      impact: evidence(15),
      presentation: evidence(15),
    }).total).toBe(100);
    const clamped = calculateHackathonScore({
      sponsorTools: evidence(99),
      completeness: evidence(-1),
      idea: evidence(Number.NaN),
    });
    expect(clamped.total).toBe(25);
    expect(clamped.validationErrors).toContain('sponsorTools: 配点上限を超えています');
  });

  it('keeps unverified or evidence-free claims at zero instead of inferring a jury score', () => {
    const score = calculateHackathonScore({
      idea: { points: 16, status: 'NOT_VERIFIED', evidence: [] },
      impact: { points: 8, status: 'VERIFIED', evidence: [] },
      presentation: { points: 7, status: 'VERIFIED', evidence: ['demo-timing.json'] },
    });
    expect(score.total).toBe(7);
    expect(score.breakdown.find((item) => item.dimension === 'idea')?.points).toBe(0);
    expect(score.breakdown.find((item) => item.dimension === 'impact')?.points).toBe(0);
    expect(score.validationErrors).toEqual([
      'idea: NOT_VERIFIEDの点数は加点できません',
      'impact: VERIFIEDには証拠参照が必要です',
    ]);
  });

  it('separates deploy-candidate readiness from post-deploy verification', () => {
    const candidatePasses = Object.fromEntries(
      RELEASE_EVIDENCE_GATE_PHASES.candidate.map((gate) => [gate, 'PASS']),
    ) as ReleaseEvidenceGates;
    const result = evaluateReleaseReadiness(candidatePasses);

    expect(result.status).toBe('NO-GO');
    expect(result.candidateStatus).toBe('READY');
    expect(result.productionStatus).toBe('NOT_VERIFIED');
    expect(result.failedGates).toEqual([]);
    expect(result.notVerifiedGates).toEqual([...RELEASE_EVIDENCE_GATE_PHASES.production]);
  });

  it('reports FAIL separately from NOT_VERIFIED and only returns GO when every gate passes', () => {
    const allPass = Object.fromEntries([
      ...RELEASE_EVIDENCE_GATE_PHASES.candidate,
      ...RELEASE_EVIDENCE_GATE_PHASES.production,
    ].map((gate) => [gate, 'PASS'])) as ReleaseEvidenceGates;
    expect(evaluateReleaseReadiness(allPass).status).toBe('GO');

    const failed = evaluateReleaseReadiness({
      ...allPass,
      releaseSecurity: 'FAIL',
      liveE2E: 'NOT_VERIFIED',
    });
    expect(failed).toMatchObject({
      status: 'NO-GO',
      candidateStatus: 'NO-GO',
      productionStatus: 'NOT_VERIFIED',
      failedGates: ['releaseSecurity'],
      notVerifiedGates: ['liveE2E'],
    });
  });

  it('never lets a perfect evidence score override a release NO-GO', () => {
    const evidence = (points: number) => ({
      points,
      status: 'VERIFIED' as const,
      evidence: ['artifact.json'],
    });
    const perfectScore = calculateHackathonScore({
      sponsorTools: evidence(25),
      completeness: evidence(25),
      idea: evidence(20),
      impact: evidence(15),
      presentation: evidence(15),
    });
    const release = evaluateReleaseReadiness({ releaseSecurity: 'FAIL' });

    expect(perfectScore.total).toBe(100);
    expect(release.status).toBe('NO-GO');
    expect(release.failedGates).toContain('releaseSecurity');
  });
});
