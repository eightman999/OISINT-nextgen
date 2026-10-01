// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { Linking } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CandidateDetail } from '@/components/CandidateDetail';
import { mockInvestigation, mockRequirements } from '@/data/mock';
import { mockPlaceFacts } from '@/data/mockPlaceFacts';
import { generateDecisionText } from '@/lib/decisionText';
import { googleMapsDirectionsUrlForPlace } from '@/lib/googleMapsUrl';

afterEach(() => {
  cleanup();
  // clipboard を注入したテスト後は必ず素の jsdom (clipboard 未実装) へ戻す。
  Reflect.deleteProperty(navigator, 'clipboard');
});

const [candidateA, candidateB, candidateC] = mockInvestigation.candidates;

describe('CandidateDetail', () => {
  it('renders the evidence list with titles, excerpts, and source URLs', () => {
    const { getAllByTestId, getByText } = render(
      <CandidateDetail candidate={candidateA} requirements={mockRequirements} />
    );

    getByText('店A 公式サイト');
    getByText('食べログ 店A');
    getByText('予算 2500〜3500円。クレジットカード利用可。23時まで営業。');
    const urls = getAllByTestId('evidence-source-url').map((node) => node.textContent);
    expect(urls).toEqual(['https://example.com/shop-a', 'https://tabelog.com/shop-a']);
  });

  it('does not expose an actionable link for an unsafe Evidence URL', () => {
    const unsafeEvidence = {
      ...candidateA,
      evidence: [{ ...candidateA.evidence[0], sourceUrl: 'javascript:alert(1)' }],
    };
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const { getByText, queryByLabelText, queryByTestId } = render(
      <CandidateDetail candidate={unsafeEvidence} requirements={mockRequirements} />
    );
    getByText(candidateA.evidence[0].sourceTitle!);
    expect(queryByLabelText(`${candidateA.evidence[0].sourceTitle}。Evidenceを開く`)).toBeNull();
    expect(queryByTestId('evidence-source-url')).toBeNull();
    expect(openURL).not.toHaveBeenCalled();
    openURL.mockRestore();
  });

  it('labels each evaluation with its evidence source domain', () => {
    const { getByTestId } = render(
      <CandidateDetail candidate={candidateA} requirements={mockRequirements} />
    );

    // r-1 (location) は e-a-1 (公式サイト) 由来、r-5 (atmosphere) は e-a-2 (食べログ) 由来。
    expect(getByTestId('inv-claim-source-location').textContent).toBe(
      '店A 公式サイト · example.com'
    );
    expect(getByTestId('inv-claim-source-atmosphere').textContent).toBe(
      '食べログ 店A · tabelog.com'
    );
  });

  it('shows ? and 出典不明 for unknown evaluations instead of asserting without evidence (§36 Rule 6)', () => {
    const { getAllByLabelText, getAllByText, getByTestId } = render(
      <CandidateDetail candidate={candidateC} requirements={mockRequirements} />
    );

    expect(getAllByLabelText('判定不明')).toHaveLength(1);
    expect(getAllByText('?')).toHaveLength(1);
    // c-3 は evidenceIds が空なので出典は「出典不明」と明示される。
    expect(getByTestId('inv-claim-source-payment').textContent).toBe('出典不明');
  });

  it('shows the empty-evidence message and the verification footnote', () => {
    const { getByTestId, queryAllByTestId } = render(
      <CandidateDetail candidate={candidateC} requirements={mockRequirements} />
    );

    expect(getByTestId('candidate-evidence-empty').textContent).toBe(
      'Evidenceはまだ収集されていません'
    );
    expect(queryAllByTestId('evidence-source-url')).toHaveLength(0);
    expect(getByTestId('inv-evidence-footnote').textContent).toContain(
      '引用は原文照合していません'
    );
  });

  it('renders both sides of a contradiction with their evidence ids (§15)', () => {
    const { getByTestId } = render(
      <CandidateDetail candidate={candidateA} requirements={mockRequirements} />
    );

    const section = within(getByTestId('inv-contradiction'));
    section.getByText('⚠ 矛盾');
    section.getByText('opening_hours');
    section.getByText('e-a-1: 17:00-23:00');
    section.getByText('e-a-2: 17:00-22:00');
  });

  it('omits the contradiction section when there are no contradictions', () => {
    const { queryByTestId } = render(
      <CandidateDetail candidate={candidateB} requirements={mockRequirements} />
    );

    expect(queryByTestId('inv-contradiction')).toBeNull();
  });

  it('hides the decision-text section without an investigation and shows it with one', () => {
    const withoutInvestigation = render(
      <CandidateDetail candidate={candidateA} requirements={mockRequirements} />
    );
    expect(withoutInvestigation.queryByTestId('decision-text')).toBeNull();
    withoutInvestigation.unmount();

    const withInvestigation = render(
      <CandidateDetail
        candidate={candidateA}
        investigation={mockInvestigation}
        requirements={mockRequirements}
      />
    );
    withInvestigation.getByTestId('decision-button');
  });

  it('previews the short format first and switches to the detailed format', () => {
    const { getByTestId, getByText, queryByText } = render(
      <CandidateDetail
        candidate={candidateA}
        investigation={mockInvestigation}
        requirements={mockRequirements}
      />
    );

    expect(queryByText(/店名: 店A/)).toBeNull();
    fireEvent.click(getByTestId('decision-button'));
    getByText(/店名: 店A/);
    expect(queryByText(/落とした2件の理由:/)).toBeNull();

    fireEvent.click(getByTestId('decision-detailed'));
    getByText(/落とした2件の理由:/);
  });

  it('preserves decision format and copy status while the section is temporarily hidden', () => {
    const { getByTestId, getByText, queryByTestId, rerender } = render(
      <CandidateDetail
        candidate={candidateA}
        investigation={mockInvestigation}
        requirements={mockRequirements}
      />
    );

    fireEvent.click(getByTestId('decision-button'));
    fireEvent.click(getByTestId('decision-detailed'));
    fireEvent.click(getByTestId('decision-copy'));
    getByText('この環境ではコピーできません。テキストを長押しして選択してください。');

    rerender(<CandidateDetail candidate={candidateB} requirements={mockRequirements} />);
    expect(queryByTestId('decision-text')).toBeNull();

    rerender(
      <CandidateDetail
        candidate={candidateB}
        investigation={mockInvestigation}
        requirements={mockRequirements}
      />
    );
    expect(getByTestId('decision-detailed').getAttribute('aria-checked')).toBe('true');
    getByText(/店名: 店B/);
    getByText('この環境ではコピーできません。テキストを長押しして選択してください。');
  });

  it('falls back to the unavailable message when navigator.clipboard is missing (jsdom default)', () => {
    const { getByTestId, getByText, queryByText } = render(
      <CandidateDetail
        candidate={candidateA}
        investigation={mockInvestigation}
        requirements={mockRequirements}
      />
    );

    fireEvent.click(getByTestId('decision-button'));
    // idle 状態ではどちらのステータス文も出ない。
    expect(queryByText('コピーしました')).toBeNull();
    expect(queryByText(/この環境ではコピーできません/)).toBeNull();

    fireEvent.click(getByTestId('decision-copy'));
    getByText('この環境ではコピーできません。テキストを長押しして選択してください。');
  });

  it('reports コピーしました and writes exactly the generateDecisionText output for the selected format', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const { findByText, getByTestId } = render(
      <CandidateDetail
        candidate={candidateA}
        investigation={mockInvestigation}
        requirements={mockRequirements}
      />
    );

    // 契約: コピーは generateDecisionText の出力そのものを書き込む。
    // CandidateDetail は generateDecisionText(investigation, candidate, { mapUrl }) を
    // mapUrl = Google Maps 検索 URL (address 優先、無ければ name) で呼ぶため、ここでも同じ引数を鏡写しにする。
    const expected = generateDecisionText(mockInvestigation, candidateA, {
      mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        candidateA.place.address ?? candidateA.place.name
      )}`,
    });

    fireEvent.click(getByTestId('decision-button'));
    fireEvent.click(getByTestId('decision-copy'));

    await findByText('コピーしました');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('店名: 店A'); // 可読性のための部分一致 (完全一致の前提確認)
    expect(writeText.mock.calls[0][0]).toBe(expected.short); // 初期選択は短い版

    // 詳しい版へ切り替えて再コピーすると detailed の全文がそのまま書き込まれる。
    fireEvent.click(getByTestId('decision-detailed'));
    fireEvent.click(getByTestId('decision-copy'));

    await findByText('コピーしました');
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls[1][0]).toBe(expected.detailed);
  });

  it('opens Google Maps directions to the place when 道順を見る is pressed', () => {
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    const onMapOpened = vi.fn();
    const { getByTestId } = render(
      <CandidateDetail
        candidate={candidateA}
        requirements={mockRequirements}
        onMapOpened={onMapOpened}
      />
    );

    fireEvent.click(getByTestId('candidate-directions-open'));

    expect(openURL).toHaveBeenCalledWith(googleMapsDirectionsUrlForPlace(candidateA.place));
    expect(openURL.mock.calls[0][0]).toContain('https://www.google.com/maps/dir/?api=1&destination=');
    openURL.mockRestore();
  });

  // #109: 店舗写真（§3 P1）。カードと同じ解決順・開示・クレジット表記をヒーローとして共有する。
  it('does not render bundled generated photos in the detail hero', () => {
    const { getByText, queryByText, container } = render(
      <CandidateDetail candidate={candidateA} requirements={mockRequirements} />
    );

    expect(container.querySelector('img')).toBeNull();
    getByText('焼肉'); // hero ラベル（ジャンル）
    expect(queryByText('イメージ')).toBeNull();
  });

  it('rejects the retired provider photo without displaying a generated substitute (§27)', () => {
    const remoteCandidate = {
      ...candidateA,
      place: { ...candidateA.place, photo: 'https://imgfp.hotp.jp/restaurant.jpg' },
    };
    const { container, queryByText } = render(
      <CandidateDetail candidate={remoteCandidate} requirements={mockRequirements} />
    );

    expect(container.querySelector('img')).toBeNull();
    expect(queryByText('イメージ')).toBeNull();
    expect(queryByText('画像提供：ホットペッパー グルメ')).toBeNull();
  });

  // #109: 店舗ページ・予約導線（places.metadata.shopUrl → place.urls.pc）
  it('opens the shop page URL when 店舗ページ・予約 is pressed', () => {
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    const { getByLabelText, getByTestId } = render(
      <CandidateDetail candidate={candidateA} requirements={mockRequirements} />
    );

    getByLabelText('店Aの店舗ページを開く。予約もこちらから');
    fireEvent.click(getByTestId('candidate-shop-open'));

    expect(openURL).toHaveBeenCalledWith('https://example.com/shop-a');
    openURL.mockRestore();
  });

  it('hides the shop link when the place has no shop URL', () => {
    const withoutUrls = { ...candidateA, place: { ...candidateA.place, urls: undefined } };
    const { queryByTestId } = render(
      <CandidateDetail candidate={withoutUrls} requirements={mockRequirements} />
    );

    expect(queryByTestId('candidate-shop-open')).toBeNull();
  });

  it('rejects non-https shop URLs instead of rendering a link (fail closed)', () => {
    const insecure = {
      ...candidateA,
      place: { ...candidateA.place, urls: { pc: 'http://example.com/shop-a' } },
    };
    const { queryByTestId } = render(
      <CandidateDetail candidate={insecure} requirements={mockRequirements} />
    );

    expect(queryByTestId('candidate-shop-open')).toBeNull();
  });

  it('forwards vote changes from the embedded VoteButtons', () => {
    const onVoteChange = vi.fn();
    const { getByLabelText } = render(
      <CandidateDetail
        candidate={candidateA}
        requirements={mockRequirements}
        userVote={1}
        onVoteChange={onVoteChange}
      />
    );

    fireEvent.click(getByLabelText('行きたくない'));
    expect(onVoteChange).toHaveBeenCalledWith(-1);
  });

  it('saves an optional trimmed vote comment and renders member comments', () => {
    const onVoteChange = vi.fn();
    const candidate = {
      ...candidateA,
      voteComments: { 'u-2': '個室が良さそう' },
    };
    const { getByLabelText, getByTestId } = render(
      <CandidateDetail
        candidate={candidate}
        investigation={mockInvestigation}
        requirements={mockRequirements}
        userVote={1}
        userVoteComment="前のコメント"
        onVoteChange={onVoteChange}
      />
    );

    expect(getByTestId('vote-comment-u-2').textContent).toContain(
      'ゆい: 個室が良さそう',
    );
    fireEvent.change(getByLabelText('投票の任意コメント'), {
      target: { value: '  辛い料理が多そう  ' },
    });
    fireEvent.click(getByLabelText('投票コメントを保存'));
    expect(onVoteChange).toHaveBeenCalledWith(1, '辛い料理が多そう');
  });

  it('renders vote comments in deterministic member-id order', () => {
    const candidate = {
      ...candidateA,
      voteComments: {
        'u-3': 'テラス席希望',
        'u-1': '駅から近い',
        'u-2': '個室が良さそう',
      },
    };
    const { getByTestId } = render(
      <CandidateDetail
        candidate={candidate}
        investigation={mockInvestigation}
        requirements={mockRequirements}
      />
    );

    const comments = getByTestId('vote-comments');
    expect(Array.from(comments.children).map((child) => child.getAttribute('data-testid'))).toEqual([
      'vote-comment-u-1',
      'vote-comment-u-2',
      'vote-comment-u-3',
    ]);
  });

  // #346: 未投票（userVote 未指定）では「どちらでも」を選択済みに見せない。
  // 自分の投票が反映されて初めてボタンが選択状態になる。
  it('keeps vote buttons unselected until the user has voted (userVote undefined)', () => {
    const { getByLabelText } = render(
      <CandidateDetail candidate={candidateA} requirements={mockRequirements} />
    );

    // 注: RN-web ~0.21 は accessibilityState を DOM へ転送しないため、
    // VoteButtons.test.tsx と同じく class の同一性で非選択状態をピン留めする。
    const like = getByLabelText('行きたい');
    const neutral = getByLabelText('どちらでも');
    const dislike = getByLabelText('行きたくない');
    expect(like.className).toBe(neutral.className);
    expect(neutral.className).toBe(dislike.className);
  });

  it('place_facts の確度と矛盾警告を Evidence 表示に反映する（#333）', () => {
    const { getByTestId, queryByTestId } = render(
      <CandidateDetail
        candidate={candidateA}
        requirements={mockRequirements}
        placeFacts={mockPlaceFacts['p-a']}
      />
    );

    getByTestId('place-facts');
    expect(getByTestId('place-fact-conflict-opening_hours').textContent).toContain(
      '複数の調査で矛盾があります'
    );
    expect(getByTestId('place-fact-card_accepted').textContent).toContain('確度 100%');
    // 薄いキー（noise_level: 根拠1件）は表示されず Evidence ベース表示のまま
    expect(queryByTestId('place-fact-noise_level')).toBeNull();
  });

  it('place_facts が無い/未指定なら既存の Evidence 表示のみでフォールバックする（#333）', () => {
    const withoutProp = render(
      <CandidateDetail candidate={candidateA} requirements={mockRequirements} />
    );
    expect(withoutProp.queryByTestId('place-facts')).toBeNull();
    withoutProp.getByText('店A 公式サイト'); // 既存 Evidence 表示は変わらない
    withoutProp.unmount();

    const withEmpty = render(
      <CandidateDetail
        candidate={candidateC}
        requirements={mockRequirements}
        placeFacts={[]}
      />
    );
    expect(withEmpty.queryByTestId('place-facts')).toBeNull();
    withEmpty.getByText('Evidenceはまだ収集されていません');
  });

  it('records the current user visit and feedback without exposing a user id', async () => {
    const onSave = vi.fn(async (_input: unknown) => {});
    const { getByTestId, queryByText } = render(
      <CandidateDetail
        candidate={candidateA}
        requirements={mockRequirements}
        placeFeedback={{ onSave }}
      />
    );

    expect(queryByText(/他の利用者/)).toBeNull();
    fireEvent.click(getByTestId('place-feedback-visited'));
    fireEvent.click(getByTestId('place-feedback-rating-1'));
    fireEvent.click(getByTestId('place-feedback-aspect-choice-noise'));
    fireEvent.click(getByTestId('place-feedback-aspect-value-choice-noise-quiet'));
    fireEvent.click(getByTestId('place-feedback-save'));

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      visitedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      rating: 1,
      aspect: 'noise',
      aspectValue: 'quiet',
    }));
    expect(JSON.stringify(onSave.mock.calls[0][0])).not.toContain('userId');
  });

  it('does not render a sub-threshold aggregate and renders only safe aggregate values', () => {
    const onSave = vi.fn(async () => {});
    const belowThreshold = render(
      <CandidateDetail
        candidate={candidateA}
        requirements={mockRequirements}
        placeFeedback={{
          onSave,
          summary: {
            placeId: 'p-a',
            visitedCount: 0,
            ratingCount: 0,
            ratingAverage: null,
            aspects: [],
          },
        }}
      />
    );
    expect(belowThreshold.queryByTestId('place-feedback-summary')).toBeNull();
    belowThreshold.unmount();

    const safe = render(
      <CandidateDetail
        candidate={candidateA}
        requirements={mockRequirements}
        placeFeedback={{
          onSave,
          summary: {
            placeId: 'p-a',
            visitedCount: 3,
            ratingCount: 3,
            ratingAverage: 0.33,
            aspects: [
              { aspect: 'noise', aspectValue: 'quiet', count: 3 },
              { aspect: 'noise', aspectValue: '店内は静かです', count: 3 },
            ],
          },
        }}
      />
    );
    safe.getByTestId('place-feedback-summary');
    safe.getByText(/3人以上の来店記録/);
    safe.getByText(/平均評価 \+0\.33/);
    safe.getByText(/静かさ：静か/);
    expect(safe.queryByText(/静かさ：quiet/)).toBeNull();
    expect(safe.queryByText(/店内は静かです/)).toBeNull();
  });

  it('discards an unsaved visit, rating, and aspect when switching places', async () => {
    const saveA = vi.fn(async () => {});
    const saveB = vi.fn(async () => {});
    const { getByTestId, queryByTestId, rerender } = render(
      <CandidateDetail
        candidate={candidateA}
        requirements={mockRequirements}
        placeFeedback={{ onSave: saveA }}
      />,
    );
    fireEvent.change(getByTestId('place-feedback-visited-at'), { target: { value: '2026-09-21' } });
    fireEvent.click(getByTestId('place-feedback-rating-1'));
    fireEvent.click(getByTestId('place-feedback-aspect-choice-noise'));
    fireEvent.click(getByTestId('place-feedback-aspect-value-choice-noise-quiet'));

    // 同じ店舗の再renderでは下書きを維持する。
    rerender(
      <CandidateDetail candidate={candidateA} requirements={mockRequirements} placeFeedback={{ onSave: saveA }} />,
    );
    expect((getByTestId('place-feedback-visited-at') as HTMLInputElement).value).toBe('2026-09-21');

    rerender(
      <CandidateDetail candidate={candidateB} requirements={mockRequirements} placeFeedback={{ onSave: saveB }} />,
    );
    expect((getByTestId('place-feedback-visited-at') as HTMLInputElement).value).toBe('');
    expect(getByTestId('place-feedback-rating-1').getAttribute('aria-checked')).toBe('false');
    expect(getByTestId('place-feedback-aspect-choice-noise').getAttribute('aria-checked')).toBe('false');
    expect(queryByTestId('place-feedback-aspect-value-choice-noise-quiet')).toBeNull();
    fireEvent.click(getByTestId('place-feedback-save'));
    expect(saveB).not.toHaveBeenCalled();

    fireEvent.click(getByTestId('place-feedback-rating--1'));
    fireEvent.click(getByTestId('place-feedback-save'));
    await vi.waitFor(() => expect(saveB).toHaveBeenCalledWith({ rating: -1 }));
    expect(saveA).not.toHaveBeenCalled();
  });
});
