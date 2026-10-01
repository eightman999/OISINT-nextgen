// @vitest-environment jsdom
// 参加画面 app/i/[token].tsx のエラー表示と参加後遷移（#93 / spec.md §25.4）。
// join-investigation Edge Function の実応答（404 / 409 の error 文言）をモックし、
// ユーザー可読なメッセージへ変換されることを検証する。
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { router } from 'expo-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getInvestigationPreviewByShareToken, joinInvestigation } from '@/lib/api';
import { recordGrowthShareOpen } from '@/lib/growthLoop';

import JoinScreen from '../../../app/i/[token]';

// share_token は 16 byte hex（migrations/0002_tables.sql:28）。実形式に揃える。
const VALID_TOKEN = '0123456789abcdef0123456789abcdef';
let currentToken = VALID_TOKEN;
let authState = {
  userId: 'user-1',
  displayName: 'テスト参加者',
  status: 'authenticated' as const,
  isAnonymous: false,
};

vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
  useLocalSearchParams: () => ({ token: currentToken }),
}));

vi.mock('expo-router/head', () => ({
  default: () => null,
}));

vi.mock('@/providers/AuthProvider', () => ({
  useAuth: () => ({ ...authState, setDisplayName: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({
  getInvestigationByShareToken: vi.fn(() => undefined),
  // master 側 #266/#269 で追加されたプレビュー取得。本テストの関心外のため null 固定
  getInvestigationPreviewByShareToken: vi.fn(() => Promise.resolve(null)),
  joinInvestigation: vi.fn(),
}));

vi.mock('@/lib/growthLoop', () => ({
  recordGrowthShareOpen: vi.fn(() => Promise.resolve(true)),
}));

// #272: 同意ゲートは本テストの関心外。同意済みとしてモーダルを出さない。
vi.mock('@/lib/termsConsent', () => ({
  TERMS_CONSENT_LABEL: '利用規約とプライバシーポリシーに同意します。',
  markTermsConsentRecordedLocally: vi.fn(),
  recordTermsConsentForAccount: vi.fn(),
  isTermsConsentRecordedLocally: () => true,
  ensureTermsConsentForAction: () => Promise.resolve({ status: 'ready' }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentToken = VALID_TOKEN;
  authState = {
    userId: 'user-1',
    displayName: 'テスト参加者',
    status: 'authenticated',
    isAnonymous: false,
  };
});

async function joinAndReadError(getByTestId: (id: string) => HTMLElement): Promise<HTMLElement> {
  fireEvent.click(getByTestId('join-button'));
  await waitFor(() => getByTestId('join-error'));
  return getByTestId('join-error');
}

describe('JoinScreen', () => {
  it('参加成功時に shareToken 付きで調査画面へ遷移する', async () => {
    vi.mocked(joinInvestigation).mockResolvedValueOnce({
      investigationId: 'inv-1',
      title: '静かな焼肉',
    });
    const { getByTestId } = render(<JoinScreen />);

    fireEvent.click(getByTestId('join-button'));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith({
        pathname: '/investigations/[id]',
        params: { id: 'inv-1', shareToken: VALID_TOKEN, joined: '1' },
      });
    });
    expect(joinInvestigation).toHaveBeenCalledWith({
      shareToken: VALID_TOKEN,
      displayName: 'テスト参加者',
      userId: 'user-1',
    });
  });

  it('Aの参加完了がBへ切り替えた画面へ反映されず、Bの名前をAへ送らない', async () => {
    let resolveJoin: ((value: { investigationId: string; title: string }) => void) | undefined;
    vi.mocked(joinInvestigation).mockImplementationOnce(
      () => new Promise((resolve) => { resolveJoin = resolve; }),
    );
    const { getByTestId, rerender } = render(<JoinScreen />);
    fireEvent.click(getByTestId('join-button'));
    await waitFor(() => expect(joinInvestigation).toHaveBeenCalledWith({
      shareToken: VALID_TOKEN,
      displayName: 'テスト参加者',
      userId: 'user-1',
    }));

    authState = {
      userId: 'user-2',
      displayName: 'Bの表示名',
      status: 'authenticated',
      isAnonymous: false,
    };
    rerender(<JoinScreen />);
    expect((getByTestId('join-name') as HTMLInputElement).value).toBe('Bの表示名');

    resolveJoin?.({ investigationId: 'stale-a', title: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.push).not.toHaveBeenCalled();
    expect(vi.mocked(joinInvestigation).mock.calls[0]?.[0]).toMatchObject({
      displayName: 'テスト参加者',
      userId: 'user-1',
    });
  });

  it('参加上限（20人）の Edge Function 応答を可読メッセージへ変換する', async () => {
    // join-investigation/index.ts の 409 応答文言（参加人数が上限に達しています）
    vi.mocked(joinInvestigation).mockRejectedValueOnce(
      new Error('参加人数が上限に達しています')
    );
    const { getByTestId } = render(<JoinScreen />);

    const error = await joinAndReadError(getByTestId);
    expect(error.textContent).toBe(
      'この調査は参加人数の上限に達しています。発行した人にご相談ください。'
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it('mock provider の上限エラー文言も同じ可読メッセージへ変換する', async () => {
    // src/lib/providers/mock.ts の文言（参加人数の上限に達しています）
    vi.mocked(joinInvestigation).mockRejectedValueOnce(
      new Error('参加人数の上限に達しています')
    );
    const { getByTestId } = render(<JoinScreen />);

    const error = await joinAndReadError(getByTestId);
    expect(error.textContent).toBe(
      'この調査は参加人数の上限に達しています。発行した人にご相談ください。'
    );
  });

  it('存在しない調査（404）は無効・期限切れとして案内し内部文言を出さない', async () => {
    // join-investigation/index.ts の 404 応答文言（調査が見つかりません）
    vi.mocked(joinInvestigation).mockRejectedValueOnce(new Error('調査が見つかりません'));
    const { getByTestId } = render(<JoinScreen />);

    const error = await joinAndReadError(getByTestId);
    expect(error.textContent).toBe(
      '共有URLが無効です。発行した人に新しいURLを依頼してください。'
    );
    expect(error.textContent).not.toContain('調査が見つかりません');
  });

  it('share_token の形式が壊れた共有URLは参加操作を待たずに案内する', async () => {
    // 途中で切れた・余計な文字が付いたURLは join-investigation が必ず 404 を返す。
    // クリックさせてから知らせる必要がないため、開いた時点で案内する。
    currentToken = 'not-a-token';
    const { getByTestId } = render(<JoinScreen />);

    expect(getByTestId('join-error').textContent).toBe(
      '共有URLが無効です。発行した人に新しいURLを依頼してください。'
    );
    // 再試行の余地は残す（URL を開き直せば復帰できる）
    expect((getByTestId('join-button') as HTMLButtonElement).disabled).toBe(false);
    expect(joinInvestigation).not.toHaveBeenCalled();
  });

  it('正しい形式の token では参加前にエラーを出さない', () => {
    const { getByTestId, queryByTestId } = render(<JoinScreen />);

    expect(queryByTestId('join-error')).toBeNull();
    expect(getByTestId('join-first-action-guide').textContent).toContain('まず1票');
  });

  it('安全なpreview取得後に共有閲覧を1回だけ記録する', async () => {
    vi.mocked(getInvestigationPreviewByShareToken).mockResolvedValue({
      title: '共同調査',
      status: 'complete',
      memberCount: 1,
    });
    const { rerender } = render(<JoinScreen />);

    await waitFor(() => expect(recordGrowthShareOpen).toHaveBeenCalledWith(VALID_TOKEN));
    rerender(<JoinScreen />);
    expect(recordGrowthShareOpen).toHaveBeenCalledTimes(1);
  });

  it('通信失敗などその他のエラーは汎用メッセージで再試行を促す', async () => {
    vi.mocked(joinInvestigation).mockRejectedValueOnce(new Error('fetch failed'));
    const { getByTestId } = render(<JoinScreen />);

    const error = await joinAndReadError(getByTestId);
    expect(error.textContent).toBe(
      '共有調査に接続できませんでした。通信状態を確認して、もう一度お試しください。'
    );
    expect(getByTestId('join-error-retry')).toBeTruthy();
  });

  it('期限切れは無効URLと区別した案内を表示する', async () => {
    vi.mocked(joinInvestigation).mockRejectedValueOnce(new Error('共有リンクの有効期限が切れています'));
    const { getByTestId } = render(<JoinScreen />);

    const error = await joinAndReadError(getByTestId);
    expect(error.textContent).toContain('有効期限が切れています');
    expect(getByTestId('join-error-retry')).toBeTruthy();
  });

  it('参加前プレビューの通信失敗も画面へ返し、再試行できる', async () => {
    vi.mocked(getInvestigationPreviewByShareToken).mockRejectedValueOnce(new Error('network down'));
    const { getByTestId } = render(<JoinScreen />);

    await waitFor(() => getByTestId('join-error'));
    expect(getByTestId('join-error').textContent).toContain('通信状態');
    expect(getByTestId('join-error-retry')).toBeTruthy();
  });
});
