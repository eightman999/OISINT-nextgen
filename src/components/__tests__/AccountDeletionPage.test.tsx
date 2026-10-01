// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { router } from 'expo-router';
import { Linking } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountDeletionPage } from '@/components/AccountDeletionPage';

vi.mock('expo-router', () => ({ router: { push: vi.fn(), replace: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AccountDeletionPage (#641)', () => {
  it('日本語ページにアプリ内手順と外部削除依頼の両方を表示する', () => {
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const { getByTestId, getByText } = render(<AccountDeletionPage />);

    getByText('OISINT（美味しント）のアカウント削除ページです。アプリ内の操作、またはアプリを使えない場合の外部からの削除依頼を案内します。');
    getByText('「アカウントと個人データを削除」を選ぶ');
    getByText('アカウントとプロフィール');
    getByText('最終更新から6か月で匿名化します。依頼文・タイトルを消去し、整理済みの検索文・embedding・条件本文を匿名化または削除します。');

    fireEvent.click(getByTestId('account-deletion-page-email-link'));
    expect(openURL).toHaveBeenCalledWith(
      'mailto:contact@example.com?subject=OISINT%20%E3%82%A2%E3%82%AB%E3%82%A6%E3%83%B3%E3%83%88%E5%89%8A%E9%99%A4%E4%BE%9D%E9%A0%BC',
    );

    fireEvent.click(getByTestId('account-deletion-page-contact-link'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/contact' });
  });

  it('英語ページも同じ削除対象と保持期間を公開する', () => {
    const { getByTestId, getByText } = render(<AccountDeletionPage locale="en" />);

    expect(getByTestId('account-deletion-page-en')).toBeTruthy();
    getByText('Review the deletion methods first');
    getByText('The Supabase Auth account and the email address, Google-login profile information, display name, and profile-image URL held by OISINT are deleted.');
    getByText('Anonymized six months after the last update. Request text and title are removed, and organized search text, embeddings, and condition text are anonymized or deleted.');
  });
});
