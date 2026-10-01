// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CandidateCard } from '@/components/CandidateCard';
import { mockInvestigation, mockMembers, mockRequirements } from '@/data/mock';

afterEach(cleanup);

// PR #154 が pros/cons 表示を追加予定のため、スナップショットは使わず
// getByText / getByTestId / getByLabelText のターゲット照会のみでピン留めする。
const [candidateA, candidateB, candidateC] = mockInvestigation.candidates;

describe('CandidateCard', () => {
  it('renders the place name, rank badge, and genre hero label', () => {
    const { getByTestId, getByText, getByLabelText } = render(
      <CandidateCard
        candidate={candidateA}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    getByText('店A');
    getByLabelText('候補1位 店A。候補の詳細を表示');
    const card = getByTestId('inv-candidate-1');
    within(card).getByText('焼肉'); // hero ラベル（ジャンル）
    expect(within(card).queryByText('イメージ')).toBeNull();
    expect(card.querySelector('img')).toBeNull();
    within(card).getByText('1'); // rank バッジ
    getByTestId('inv-rank-1');
  });

  it('rejects the retired provider photo without displaying a generated substitute', () => {
    const remoteCandidate = {
      ...candidateA,
      place: {
        ...candidateA.place,
        photo: 'https://imgfp.hotp.jp/restaurant.jpg',
      },
    };
    const { getByTestId, getByLabelText } = render(
      <CandidateCard
        candidate={remoteCandidate}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    const card = getByTestId('inv-candidate-1');
    getByLabelText('候補1位 店A。候補の詳細を表示');
    expect(within(card).queryByText('イメージ')).toBeNull();
    expect(card.querySelector('img')).toBeNull();
    expect(within(card).queryByText('画像提供：ホットペッパー グルメ')).toBeNull();
  });

  it('shows one match symbol per evaluation state (○△ for c-1)', () => {
    const { getAllByLabelText, getAllByText } = render(
      <CandidateCard
        candidate={candidateA}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    // r-1〜r-4 = match, r-5 = partial
    expect(getAllByLabelText('条件を満たす')).toHaveLength(4);
    expect(getAllByLabelText('一部満たす')).toHaveLength(1);
    expect(getAllByText('○')).toHaveLength(4);
    expect(getAllByText('△')).toHaveLength(1);
  });

  it('shows × for mismatch and ? for unknown evaluations', () => {
    const mismatch = render(
      <CandidateCard
        candidate={candidateB}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );
    expect(mismatch.getAllByLabelText('条件を満たさない')).toHaveLength(1);
    expect(mismatch.getAllByText('×')).toHaveLength(1);
    mismatch.unmount();

    const unknown = render(
      <CandidateCard
        candidate={candidateC}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );
    expect(unknown.getAllByLabelText('判定不明')).toHaveLength(1);
    expect(unknown.getAllByText('?')).toHaveLength(1);
  });

  it('summarizes matched requirement counts', () => {
    const { getByTestId } = render(
      <CandidateCard
        candidate={candidateC}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    expect(getByTestId('inv-fill-3').textContent).toBe('条件 3/5件が一致');
  });

  it('shows the contradiction tag only when contradictions exist', () => {
    const withContradiction = render(
      <CandidateCard
        candidate={candidateA}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );
    withContradiction.getByText('⚠ 矛盾1件');
    withContradiction.unmount();

    const withoutContradiction = render(
      <CandidateCard
        candidate={candidateB}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );
    expect(withoutContradiction.queryByText(/矛盾/)).toBeNull();
  });

  it('lists must-requirements that are unknown/mismatch as 要確認 (c-3 only)', () => {
    const gap = render(
      <CandidateCard
        candidate={candidateC}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );
    expect(gap.getByTestId('inv-gap-3').textContent).toBe(
      '要確認: クレジットカード利用可能'
    );
    gap.unmount();

    const noGap = render(
      <CandidateCard
        candidate={candidateB}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );
    expect(noGap.queryByTestId('inv-gap-2')).toBeNull();
    expect(noGap.queryByText(/要確認/)).toBeNull();
  });

  it('suppresses the rank-1 recommendation badge when a must requirement is unknown (#312)', () => {
    const unresolvedRankOne = {
      ...candidateC,
      rank: 1,
    };
    const { getByTestId, getByLabelText, queryByTestId } = render(
      <CandidateCard
        candidate={unresolvedRankOne}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    expect(queryByTestId('inv-rank-1')).toBeNull();
    expect(getByTestId('inv-rank-unverified-1').textContent).toBe('調査不足');
    expect(getByTestId('inv-gap-1').textContent).toBe(
      '未確認の必須条件あり: クレジットカード利用可能'
    );
    getByLabelText('1位候補ですが、必須条件が未確認のためおすすめ未確定です');
  });

  it('treats a must requirement without an evaluation as unresolved', () => {
    const missingMustEvaluation = {
      ...candidateA,
      evaluations: candidateA.evaluations.filter(
        (evaluation) => evaluation.requirementId !== 'r-4'
      ),
    };
    const { getByTestId, queryByTestId } = render(
      <CandidateCard
        candidate={missingMustEvaluation}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    expect(queryByTestId('inv-rank-1')).toBeNull();
    expect(getByTestId('inv-rank-unverified-1').textContent).toBe('調査不足');
    expect(getByTestId('inv-gap-1').textContent).toBe(
      '未確認の必須条件あり: クレジットカード利用可能'
    );
    expect(queryByTestId('inv-mismatch-1')).toBeNull();
  });

  it('keeps a mismatch-only must requirement in the standard confirmation gap', () => {
    const mismatchedMustEvaluation = {
      ...candidateA,
      evaluations: candidateA.evaluations.map((evaluation) =>
        evaluation.requirementId === 'r-4'
          ? { ...evaluation, state: 'mismatch' as const }
          : evaluation
      ),
    };
    const { getByTestId, queryByTestId } = render(
      <CandidateCard
        candidate={mismatchedMustEvaluation}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    expect(getByTestId('inv-rank-1').textContent).toBe('1');
    expect(queryByTestId('inv-rank-unverified-1')).toBeNull();
    expect(getByTestId('inv-gap-1').textContent).toBe(
      '要確認: クレジットカード利用可能'
    );
    expect(queryByTestId('inv-mismatch-1')).toBeNull();
  });

  it('preserves first-state and any-mismatch semantics for duplicate requirement evaluations', () => {
    const paymentEvaluation = candidateC.evaluations.find(
      (evaluation) => evaluation.requirementId === 'r-4'
    );
    expect(paymentEvaluation).toBeDefined();

    const duplicateMustEvaluation = {
      ...candidateC,
      rank: 1,
      evaluations: [
        ...candidateC.evaluations,
        { ...paymentEvaluation!, state: 'mismatch' as const },
      ],
    };
    const { getByTestId, queryByTestId } = render(
      <CandidateCard
        candidate={duplicateMustEvaluation}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    expect(queryByTestId('inv-rank-1')).toBeNull();
    expect(getByTestId('inv-gap-1').textContent).toBe(
      '未確認の必須条件あり: クレジットカード利用可能'
    );
    expect(getByTestId('inv-mismatch-1').textContent).toBe(
      '不適合の必須条件: クレジットカード利用可能'
    );
  });

  it('renders info tags, opening hours, and the budget line for c-1', () => {
    const { getByText } = render(
      <CandidateCard
        candidate={candidateA}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    getByText('徒歩5分');
    getByText('予算 2500〜3500円');
    getByText('カード可');
    getByText('営業 17:00〜23:00');
    // 原文は全角スペース（予算目安　…）だが、RTL の normalizer が半角スペースへ畳む。
    getByText('予算目安 2500〜3500円 / 人');
  });

  it('omits the card-accepted tag when the fixture says 不明 (c-3)', () => {
    const { queryByText } = render(
      <CandidateCard
        candidate={candidateC}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    expect(queryByText('カード可')).toBeNull();
  });

  // #346: 「誰がどの候補に投票したか」の内訳表示。0 票（どちらでも）も明示投票として表示する。
  it('shows the vote breakdown grouped by 👍/🤔/👎 with member names and counts', () => {
    const { getByTestId, queryByTestId } = render(
      <CandidateCard
        candidate={candidateA}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    const upRow = getByTestId('inv-vote-up-1');
    within(upRow).getByText('👍');
    within(upRow).getByText('まさくん、ゆい');
    within(upRow).getByText('2票');

    const neutralRow = getByTestId('inv-vote-neutral-1');
    within(neutralRow).getByText('🤔');
    within(neutralRow).getByText('たくみ');
    within(neutralRow).getByText('1票');

    // 👎 票が無い候補では行きたくない行を出さない。
    expect(queryByTestId('inv-vote-down-1')).toBeNull();
    // 全員に票があるので未投票行も出さない。
    expect(queryByTestId('inv-vote-none-1')).toBeNull();
  });

  it('shows 👎 voters for candidates with down votes (c-3)', () => {
    const { getByTestId } = render(
      <CandidateCard
        candidate={candidateC}
        members={mockMembers}
        requirements={mockRequirements}
      />
    );

    const downRow = getByTestId('inv-vote-down-3');
    within(downRow).getByText('👎');
    within(downRow).getByText('まさくん');
    const upRow = getByTestId('inv-vote-up-3');
    within(upRow).getByText('ゆい、たくみ');
  });

  it('marks the current user vote with （自分） (#346)', () => {
    const { getByTestId } = render(
      <CandidateCard
        candidate={candidateA}
        members={mockMembers}
        requirements={mockRequirements}
        currentUserId="u-2"
      />
    );

    within(getByTestId('inv-vote-up-1')).getByText('まさくん、ゆい（自分）');
  });

  it('lists members without a vote entry as 未投票 and keeps 不明 for unknown voters', () => {
    // live では未投票 = votes に行が無い状態。u-2 / u-3 は行が無いので未投票扱い。
    const partialVotes = {
      ...candidateA,
      votes: { 'u-1': 1, 'u-9': -1 } as typeof candidateA.votes,
    };
    const { getByTestId } = render(
      <CandidateCard
        candidate={partialVotes}
        members={mockMembers}
        requirements={mockRequirements}
        currentUserId="u-3"
      />
    );

    const noneRow = getByTestId('inv-vote-none-1');
    within(noneRow).getByText('未投票');
    within(noneRow).getByText('ゆい、たくみ（自分）');
    // members に居ない投票者は既存の流儀どおり不明。
    within(getByTestId('inv-vote-down-1')).getByText('不明');
  });

  it('invokes onPress when the card is pressed', () => {
    const onPress = vi.fn();
    const { getByTestId } = render(
      <CandidateCard
        candidate={candidateA}
        members={mockMembers}
        requirements={mockRequirements}
        onPress={onPress}
      />
    );

    fireEvent.click(getByTestId('inv-candidate-1'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
