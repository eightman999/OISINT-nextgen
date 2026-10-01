import { describe, expect, it } from 'vitest';

import {
  assertInvestigationReadSucceeded,
  buildVoteMutationRow,
  mapCandidateRow,
  mapInvestigationMember,
  type CandidateRow,
} from '@/lib/providers/liveMapping';
import { prepareEvidenceForDisplay, safePublicEvidenceUrl } from '@/lib/evidenceSafety';
import type { Evidence } from '@/types';
import sourceDisplayVectors from '../../../scripts/fixtures/requirement-source-display-vectors.json';

describe('assertInvestigationReadSucceeded', () => {
  it('accepts complete query results', () => {
    expect(() =>
      assertInvestigationReadSucceeded([
        { label: 'requirements', error: null },
        { label: 'evaluations', error: null },
        { label: 'evidence', error: null },
      ])
    ).not.toThrow();
  });

  it('fails closed when evaluations query fails instead of mapping an empty array to ?', () => {
    expect(() =>
      assertInvestigationReadSucceeded([
        { label: 'requirements', error: null },
        { label: 'evaluations', error: { message: 'database unavailable' } },
        { label: 'evidence', error: null },
      ])
    ).toThrow('調査データの取得に失敗しました (evaluations)');
  });
});

describe('mock/live display parity', () => {
  it('does not present an address as measured walking access', () => {
    const row = candidateRow();
    row.places = {
      id: 'place-1',
      name: '店舗',
      address: '東京都豊島区1-2-3',
      metadata: null,
      fallback_image_key: null,
    };

    expect(mapCandidateRow(row, [], [], []).place).toMatchObject({
      address: '東京都豊島区1-2-3',
      access: undefined,
    });
  });

  it('keeps live member presence unknown instead of marking everyone online', () => {
    expect(mapInvestigationMember({
      user_id: 'member-1',
      display_name: '参加者',
      role: 'editor',
    })).toEqual({
      id: 'member-1',
      displayName: '参加者',
      role: 'editor',
    });
  });

  it('maps only non-empty vote comments without changing vote values', () => {
    const mapped = mapCandidateRow(candidateRow(), [], [], [
      {
        candidate_id: 'candidate-1',
        user_id: 'member-1',
        value: 1,
        comment: '  辛い料理が多そう  ',
      },
      {
        candidate_id: 'candidate-1',
        user_id: 'member-2',
        value: 0,
        comment: '   ',
      },
    ]);

    expect(mapped.votes).toEqual({ 'member-1': 1, 'member-2': 0 });
    expect(mapped.voteComments).toEqual({
      'member-1': '辛い料理が多そう',
    });
  });

  it('builds the live votes upsert row with a trimmed comment or null', () => {
    expect(buildVoteMutationRow(
      'investigation-1',
      'candidate-1',
      'member-1',
      -1,
      '  辛い料理が多そう  ',
    )).toEqual({
      investigation_id: 'investigation-1',
      candidate_id: 'candidate-1',
      user_id: 'member-1',
      value: -1,
      comment: '辛い料理が多そう',
    });
    expect(buildVoteMutationRow(
      'investigation-1',
      'candidate-1',
      'member-1',
      0,
      '   ',
    ).comment).toBeNull();
  });
});

const evidenceOf = (
  id: string,
  observedAt: string,
  value: { min: number; max: number },
  sourceUrl = `https://official.example/${id}`
): Evidence => ({
  id,
  placeId: 'place-1',
  investigationId: null,
  scope: 'shared',
  sourceType: 'other_public_page',
  sourceUrl,
  sourceTitle: '公開ページ (official.example)',
  excerpt: `夕食予算: ${value.min}〜${value.max}円`,
  structuredClaims: [{ key: 'budget_dinner', value, rawText: 'neutral' }],
  observedAt,
  sourceQuality: 0.8,
  freshnessScore: 1,
});

const candidateRow = (): CandidateRow => ({
  id: 'candidate-1',
  investigation_id: 'investigation-1',
  place_id: 'place-1',
  score: 0,
  rank: 1,
  summary: null,
  pros: [],
  cons: [],
  places: null,
});

const evidenceWithClaim = (
  id: string,
  claim: Evidence['structuredClaims'][number]
): Evidence => ({
  ...evidenceOf(id, '2026-08-16T10:00:00.000Z', { min: 1000, max: 2000 }),
  excerpt: claim.rawText,
  structuredClaims: [claim],
});

describe('Evidence mapping safety', () => {
  it('sorts by observedAt desc and id asc independent of query order', () => {
    const newestA = evidenceOf('a', '2026-08-16T10:00:00.000Z', { min: 1000, max: 2000 });
    const newestB = evidenceOf('b', '2026-08-16T10:00:00.000Z', { min: 2000, max: 3000 });
    const old = evidenceOf('z', '2026-08-15T10:00:00.000Z', { min: 9000, max: 9999 });
    expect(prepareEvidenceForDisplay([old, newestB, newestA]).map((row) => row.id)).toEqual([
      'a',
      'b',
      'z',
    ]);
    expect(prepareEvidenceForDisplay([newestA, old, newestB]).map((row) => row.id)).toEqual([
      'a',
      'b',
      'z',
    ]);
  });

  it('keeps first-hit claim mapping deterministic across permutations', () => {
    const row: CandidateRow = {
      id: 'candidate-1',
      investigation_id: 'investigation-1',
      place_id: 'place-1',
      score: 0,
      rank: 1,
      summary: null,
      pros: [],
      cons: [],
      places: {
        id: 'place-1',
        name: '店',
        address: null,
        lat: null,
        lng: null,
        metadata: null,
        fallback_image_key: null,
      },
    };
    const newest = evidenceOf('new', '2026-08-16T10:00:00.000Z', { min: 1000, max: 2000 });
    const old = evidenceOf('old', '2026-08-15T10:00:00.000Z', { min: 9000, max: 9999 });
    expect(mapCandidateRow(row, [old, newest], [], []).place.budget).toBe('1000〜2000円');
    expect(mapCandidateRow(row, [newest, old], [], []).place.budget).toBe('1000〜2000円');
  });

  it('rejects unsafe schemes, userinfo, and cross-investigation query content', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'ftp://official.example/menu',
      'https://user:secret@official.example/menu',
    ]) {
      expect(safePublicEvidenceUrl(url)).toBeUndefined();
    }
    const leaked = evidenceOf(
      'leaked',
      '2026-08-16T10:00:00.000Z',
      { min: 1000, max: 2000 },
      'https://official.example/menu?q=秘密&token=abc'
    );
    expect(prepareEvidenceForDisplay([leaked])).toEqual([]);
  });

  it('fails closed when a nonunknown evaluation has no display-safe Evidence ID', () => {
    const row: CandidateRow = {
      id: 'candidate-1',
      investigation_id: 'investigation-1',
      place_id: 'place-1',
      score: 0,
      rank: 1,
      summary: null,
      pros: [],
      cons: [],
      places: null,
    };
    const mapped = mapCandidateRow(row, [], [{
      candidate_id: 'candidate-1',
      requirement_id: 'requirement-1',
      state: 'match',
      confidence: 0.9,
      explanation: 'legacy assertion',
      evidence_ids: ['foreign-or-filtered'],
    }], []);
    expect(mapped.evaluations).toEqual([{
      requirementId: 'requirement-1',
      state: 'unknown',
      confidence: 0,
      explanation: '表示可能なEvidenceを確認できないため判定を保留しました',
      evidenceIds: [],
    }]);
  });

  it('fails closed when a legacy deterministic evaluation cites an unrelated Evidence claim', () => {
    const row: CandidateRow = {
      id: 'candidate-1',
      investigation_id: 'investigation-1',
      place_id: 'place-1',
      score: 0,
      rank: 1,
      summary: null,
      pros: [],
      cons: [],
      places: null,
    };
    const unrelated: Evidence = {
      ...evidenceOf('hours-only', '2026-08-16T10:00:00.000Z', { min: 1000, max: 2000 }),
      structuredClaims: [{ key: 'opening_hours', value: '17:00-23:00', rawText: '営業時間: 17:00〜23:00' }],
    };
    const mapped = mapCandidateRow(row, [unrelated], [{
      candidate_id: 'candidate-1',
      requirement_id: 'requirement-payment',
      state: 'match',
      confidence: 0.9,
      explanation: 'legacy assertion',
      evidence_ids: [unrelated.id],
    }], [], new Set(), [{
      id: 'requirement-payment',
      text: 'クレジットカード利用可能',
      normalizedText: 'クレジットカード利用可能',
      kind: 'payment',
      priority: 'must',
      weight: 1,
    }]);
    expect(mapped.evaluations[0]).toMatchObject({
      state: 'unknown',
      confidence: 0,
      evidenceIds: [],
    });
  });

  it.each([
    {
      label: 'payment',
      requirement: {
        id: 'requirement-payment',
        text: 'クレジットカード利用可能',
        normalizedText: 'クレジットカード利用可能',
        kind: 'payment' as const,
        priority: 'must' as const,
        weight: 1,
      },
      claim: { key: 'card_accepted' as const, value: false, rawText: 'カード利用不可' },
    },
    {
      label: 'budget',
      requirement: {
        id: 'requirement-budget',
        text: '予算3000円以下',
        normalizedText: '予算3000円以下',
        kind: 'budget' as const,
        priority: 'must' as const,
        weight: 1,
      },
      claim: {
        key: 'budget_dinner' as const,
        value: { min: 5000, max: 6000 },
        rawText: '夕食予算: 5000〜6000円',
      },
    },
    {
      label: 'reservation',
      requirement: {
        id: 'requirement-reservation',
        text: '予約可能',
        normalizedText: '予約可能',
        kind: 'reservation' as const,
        priority: 'must' as const,
        weight: 1,
      },
      claim: { key: 'reservation' as const, value: false, rawText: '予約不可' },
    },
    {
      label: 'time',
      requirement: {
        id: 'requirement-time',
        text: '朝食営業',
        normalizedText: '朝食営業',
        kind: 'time' as const,
        priority: 'must' as const,
        weight: 1,
      },
      claim: {
        key: 'opening_hours' as const,
        value: '17:00-23:00',
        rawText: '営業時間: 17:00〜23:00',
      },
    },
  ])('fails closed when a legacy $label match cites an opposite claim value', ({ requirement, claim }) => {
    const evidence = evidenceWithClaim(`evidence-${requirement.id}`, claim);
    const mapped = mapCandidateRow(candidateRow(), [evidence], [{
      candidate_id: 'candidate-1',
      requirement_id: requirement.id,
      state: 'match',
      confidence: 0.9,
      explanation: 'legacy assertion',
      evidence_ids: [evidence.id],
    }], [], new Set(), [requirement]);

    expect(mapped.evaluations[0]).toMatchObject({
      state: 'unknown',
      confidence: 0,
      evidenceIds: [],
    });
  });

  it('keeps a deterministic state only when the cited claim value supports that exact state', () => {
    const paymentRequirement = {
      id: 'requirement-payment',
      text: 'クレジットカード利用可能',
      normalizedText: 'クレジットカード利用可能',
      kind: 'payment' as const,
      priority: 'must' as const,
      weight: 1,
    };
    const cardEvidence = evidenceWithClaim('card-supported', {
      key: 'card_accepted',
      value: true,
      rawText: 'カード利用可能',
    });
    const mappedPayment = mapCandidateRow(candidateRow(), [cardEvidence], [{
      candidate_id: 'candidate-1',
      requirement_id: paymentRequirement.id,
      state: 'match',
      confidence: 0.9,
      explanation: 'カードを利用できます',
      evidence_ids: [cardEvidence.id],
    }], [], new Set(), [paymentRequirement]);
    expect(mappedPayment.evaluations[0]).toMatchObject({
      state: 'match',
      evidenceIds: ['card-supported'],
    });

    const partyRequirement = {
      id: 'requirement-party',
      text: '4人で利用可能',
      normalizedText: '4人で利用可能',
      kind: 'party_size' as const,
      priority: 'must' as const,
      weight: 1,
    };
    const capacityEvidence = evidenceWithClaim('capacity-supported', {
      key: 'capacity',
      value: 20,
      rawText: '総席数: 20席',
    });
    const mappedParty = mapCandidateRow(candidateRow(), [capacityEvidence], [{
      candidate_id: 'candidate-1',
      requirement_id: partyRequirement.id,
      state: 'partial',
      confidence: 0.8,
      explanation: '総席数は足りますが同時利用は未確認です',
      evidence_ids: [capacityEvidence.id],
    }], [], new Set(), [partyRequirement]);
    expect(mappedParty.evaluations[0]).toMatchObject({
      state: 'partial',
      evidenceIds: ['capacity-supported'],
    });
  });

  it.each([
    {
      label: '許容幅内',
      range: { min: 3100, max: 3500 },
      state: 'partial' as const,
    },
    {
      label: '許容幅境界',
      range: { min: 3600, max: 4000 },
      state: 'partial' as const,
    },
    {
      label: '許容幅超過',
      range: { min: 3601, max: 4000 },
      state: 'mismatch' as const,
    },
  ])('mirrors the backend vague-budget tolerance at $label', ({ range, state }) => {
    const requirement = {
      id: 'requirement-vague-budget',
      text: 'お手頃',
      normalizedText: 'お手頃',
      kind: 'budget' as const,
      priority: 'must' as const,
      weight: 1,
    };
    const evidence = evidenceWithClaim(`budget-${range.min}`, {
      key: 'budget_dinner',
      value: range,
      rawText: `夕食予算: ${range.min}〜${range.max}円`,
    });
    const mapped = mapCandidateRow(candidateRow(), [evidence], [{
      candidate_id: 'candidate-1',
      requirement_id: requirement.id,
      state,
      confidence: 0.6,
      explanation: 'コード突合済み',
      evidence_ids: [evidence.id],
    }], [], new Set(), [requirement]);
    expect(mapped.evaluations[0]).toMatchObject({ state, evidenceIds: [evidence.id] });
  });

  it('infers a single deterministic intent for a user-added null-kind requirement', () => {
    const requirement = {
      id: 'requirement-user-added',
      text: 'カード利用可',
      normalizedText: 'カード利用可',
      // DBのkind=nullはmapRequirementでotherへ正規化される。
      kind: 'other' as const,
      priority: 'must' as const,
      weight: 1,
      userAdded: true,
    };
    const opposite = evidenceWithClaim('user-added-opposite', {
      key: 'card_accepted',
      value: false,
      rawText: 'カード利用不可',
    });
    const mapped = mapCandidateRow(candidateRow(), [opposite], [{
      candidate_id: 'candidate-1',
      requirement_id: requirement.id,
      state: 'match',
      confidence: 0.9,
      explanation: 'legacy assertion',
      evidence_ids: [opposite.id],
    }], [], new Set(), [requirement]);
    expect(mapped.evaluations[0]).toMatchObject({
      state: 'unknown',
      confidence: 0,
      evidenceIds: [],
    });
  });

  it('does not infer deterministic proof for an explicit parser other row', () => {
    const requirement = {
      id: 'requirement-parser-other',
      text: 'カード利用可',
      normalizedText: 'カード利用可',
      kind: 'other' as const,
      priority: 'must' as const,
      weight: 1,
    };
    const evidence = evidenceWithClaim('parser-other-card', {
      key: 'card_accepted',
      value: true,
      rawText: 'カード利用可能',
    });
    const mapped = mapCandidateRow(candidateRow(), [evidence], [{
      candidate_id: 'candidate-1',
      requirement_id: requirement.id,
      state: 'match',
      confidence: 0.9,
      explanation: 'parser other assertion',
      evidence_ids: [evidence.id],
    }], [], new Set(), [requirement]);
    expect(mapped.evaluations[0]).toMatchObject({
      state: 'unknown',
      confidence: 0,
      evidenceIds: [],
    });
  });

  it.each([
    { text: 'カード不要', claim: { key: 'card_accepted' as const, value: true, rawText: 'カード利用可' } },
    { text: '予約しない', claim: { key: 'reservation' as const, value: true, rawText: '予約可' } },
    {
      text: '予算未定',
      claim: {
        key: 'budget_dinner' as const,
        value: { min: 1000, max: 2000 },
        rawText: '夕食予算: 1000〜2000円',
      },
    },
    { text: '朝は避けたい', claim: { key: 'opening_hours' as const, value: '6:00-10:00', rawText: '営業時間: 6:00〜10:00' } },
  ])('quarantines an unparseable deterministic explicit-other row: $text', ({ text, claim }) => {
    const requirement = {
      id: `requirement-${text}`,
      text,
      normalizedText: text,
      kind: 'other' as const,
      priority: 'must' as const,
      weight: 1,
    };
    const evidence = evidenceWithClaim(`evidence-${text}`, claim);
    const mapped = mapCandidateRow(candidateRow(), [evidence], [{
      candidate_id: 'candidate-1',
      requirement_id: requirement.id,
      state: 'match',
      confidence: 0.9,
      explanation: 'legacy semantic assertion',
      evidence_ids: [evidence.id],
    }], [], new Set(), [requirement]);
    expect(mapped.evaluations[0]).toMatchObject({
      state: 'unknown',
      confidence: 0,
      evidenceIds: [],
    });
  });

  it.each([
    { text: '予算未定', userAdded: true },
    { text: 'カード決済OK', userAdded: false },
    { text: '予約OK', userAdded: false },
    { text: '予算は安め希望', userAdded: false },
    { text: '条件なし', userAdded: false },
    { text: 'おまかせ', userAdded: true },
    { text: '指定しない', userAdded: false },
    { text: '何でもよい', userAdded: false },
    { text: 'どちらでもいい', userAdded: false },
    { text: '下限なし', userAdded: false },
    { text: '制限なし', userAdded: false },
    { text: '上限無し', userAdded: false },
    { text: '条件は無し', userAdded: false },
    { text: '何でも可', userAdded: false },
    { text: '人数こだわらない', userAdded: true },
  ])('quarantines unsupported deterministic wording regardless of parser provenance: $text', ({ text, userAdded }) => {
    const requirement = {
      id: `requirement-unsupported-${text}`,
      text,
      normalizedText: text,
      kind: 'other' as const,
      priority: 'must' as const,
      weight: 1,
      userAdded,
    };
    const neutralEvidence: Evidence = {
      ...evidenceOf(`neutral-${text}`, '2026-08-16T10:00:00.000Z', { min: 1000, max: 2000 }),
      excerpt: '公開ページ',
      structuredClaims: [],
    };
    const mapped = mapCandidateRow(candidateRow(), [neutralEvidence], [{
      candidate_id: 'candidate-1',
      requirement_id: requirement.id,
      state: 'match',
      confidence: 0.9,
      explanation: 'legacy semantic assertion',
      evidence_ids: [neutralEvidence.id],
    }], [], new Set(), [requirement]);
    expect(mapped.evaluations[0]).toMatchObject({ state: 'unknown', evidenceIds: [] });
  });

  it.each(
    [
      'カードで支払える',
      '池袋でカードで支払える',
      '予約をお願いしたい',
      '予算を抑えたい',
      '人数は少なめ',
      '朝に食べたい',
    ]
      .flatMap((text) => [false, true].map((userAdded) => ({ text, userAdded })))
  )('mirrors the backend potential-intent quarantine for $text (userAdded=$userAdded)', ({ text, userAdded }) => {
    const requirement = {
      id: `requirement-potential-${text}-${userAdded}`,
      text,
      normalizedText: text,
      kind: 'other' as const,
      priority: 'must' as const,
      weight: 1,
      userAdded,
    };
    const neutralEvidence: Evidence = {
      ...evidenceOf(`potential-${text}-${userAdded}`, '2026-08-16T10:00:00.000Z', { min: 1000, max: 2000 }),
      excerpt: '公開ページ',
      structuredClaims: [],
    };
    const mapped = mapCandidateRow(candidateRow(), [neutralEvidence], [{
      candidate_id: 'candidate-1',
      requirement_id: requirement.id,
      state: 'match',
      confidence: 0.9,
      explanation: 'legacy semantic assertion',
      evidence_ids: [neutralEvidence.id],
    }], [], new Set(), [requirement]);
    expect(mapped.evaluations[0]).toMatchObject({ state: 'unknown', evidenceIds: [] });
  });

  it.each([
    'カードゲームができる',
    '朝霞市',
    '夜景がきれい',
    '朝鮮料理',
    'ランチコース',
    '朝食ビュッフェ',
    '朝食メニュー',
    '夜ご飯コース',
    '予約語',
    'おまかせコース',
    '時間制限なしでゆっくり',
    '未定食堂',
  ])(
    'keeps an ordinary semantic explicit-other requirement outside the deterministic quarantine: %s',
    (text) => {
      const requirement = {
        id: `requirement-semantic-${text}`,
        text,
        normalizedText: text,
        kind: 'other' as const,
        priority: 'should' as const,
        weight: 0.5,
      };
      const neutralEvidence: Evidence = {
        ...evidenceOf(`semantic-${text}`, '2026-08-16T10:00:00.000Z', { min: 1000, max: 2000 }),
        excerpt: '公開ページ',
        structuredClaims: [],
      };
      const mapped = mapCandidateRow(candidateRow(), [neutralEvidence], [{
        candidate_id: 'candidate-1',
        requirement_id: requirement.id,
        state: 'match',
        confidence: 0.8,
        explanation: 'current citation assertion',
        evidence_ids: [neutralEvidence.id],
      }], [], new Set(), [requirement]);
      expect(mapped.evaluations[0]).toMatchObject({
        state: 'match',
        evidenceIds: [neutralEvidence.id],
      });
    }
  );

  it('shares the source-attestation display vectors across parser and user-added provenance', () => {
    const mapLegacyState = (text: string, userAdded: boolean) => {
      const requirement = {
        id: `requirement-vector-${text}-${userAdded}`,
        text,
        normalizedText: text,
        kind: 'other' as const,
        priority: 'should' as const,
        weight: 0.5,
        userAdded,
      };
      const neutralEvidence: Evidence = {
        ...evidenceOf(`vector-${text}-${userAdded}`, '2026-08-16T10:00:00.000Z', { min: 1000, max: 2000 }),
        excerpt: '公開ページ',
        structuredClaims: [],
      };
      return mapCandidateRow(candidateRow(), [neutralEvidence], [{
        candidate_id: 'candidate-1',
        requirement_id: requirement.id,
        state: 'match',
        confidence: 0.8,
        explanation: 'legacy semantic assertion',
        evidence_ids: [neutralEvidence.id],
      }], [], new Set(), [requirement]).evaluations[0].state;
    };

    for (const userAdded of [false, true]) {
      for (const text of sourceDisplayVectors.quarantine) {
        expect(mapLegacyState(text, userAdded)).toBe('unknown');
      }
      for (const text of sourceDisplayVectors.semantic) {
        expect(mapLegacyState(text, userAdded)).toBe('match');
      }
      for (const domain of sourceDisplayVectors.noConstraintDomains) {
        for (const form of sourceDisplayVectors.noConstraintForms) {
          const text = `${domain}${form}`;
          const expected = sourceDisplayVectors.noConstraintSemanticExceptions.includes(text)
            ? 'match'
            : 'unknown';
          expect(mapLegacyState(text, userAdded), `${text} userAdded=${userAdded}`).toBe(expected);
        }
      }
    }
  });

  it.each([
    { hours: '24:00-1:00', expected: 'match' as const },
    { hours: '24:01-1:00', expected: 'unknown' as const },
  ])('mirrors the backend 24:00 opening-hours boundary for $hours', ({ hours, expected }) => {
    const requirement = {
      id: 'requirement-late-night',
      text: '深夜',
      normalizedText: '深夜',
      kind: 'time' as const,
      priority: 'must' as const,
      weight: 1,
    };
    const evidence = evidenceWithClaim(`hours-${hours}`, {
      key: 'opening_hours',
      value: hours,
      rawText: `営業時間: ${hours}`,
    });
    const mapped = mapCandidateRow(candidateRow(), [evidence], [{
      candidate_id: 'candidate-1',
      requirement_id: requirement.id,
      state: 'match',
      confidence: 0.9,
      explanation: '営業時間突合',
      evidence_ids: [evidence.id],
    }], [], new Set(), [requirement]);
    expect(mapped.evaluations[0]).toMatchObject({
      state: expected,
      evidenceIds: expected === 'match' ? [evidence.id] : [],
    });
  });

  it('rejects non-finite or impossible numeric claims at the display boundary', () => {
    const partyRequirement = {
      id: 'requirement-party-invalid',
      text: '4人で利用可能',
      normalizedText: '4人で利用可能',
      kind: 'party_size' as const,
      priority: 'must' as const,
      weight: 1,
    };
    const invalidCapacity = evidenceWithClaim('invalid-capacity', {
      key: 'capacity',
      value: Number.POSITIVE_INFINITY,
      rawText: 'invalid capacity',
    });
    const mapped = mapCandidateRow(candidateRow(), [invalidCapacity], [{
      candidate_id: 'candidate-1',
      requirement_id: partyRequirement.id,
      state: 'partial',
      confidence: 0.8,
      explanation: 'invalid legacy assertion',
      evidence_ids: [invalidCapacity.id],
    }], [], new Set(), [partyRequirement]);
    expect(mapped.evaluations[0]).toMatchObject({
      state: 'unknown',
      confidence: 0,
      evidenceIds: [],
    });
  });
});
