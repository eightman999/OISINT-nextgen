// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { router } from 'expo-router';
import { Linking } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Footer } from '@/components/Footer';
import { FOOTER_CREDIT_TEST_ID } from '@/lib/attribution';

// Footer は expo-router の router.push を使うため、jsdom 単体テストではモックする。
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Footer', () => {
  it('未設定でも Geoapify の帰属表記を表示する', () => {
    const previous = process.env.EXPO_PUBLIC_PLACE_PROVIDER;
    delete process.env.EXPO_PUBLIC_PLACE_PROVIDER;
    try {
      const { getByText, queryByText } = render(<Footer />);

      getByText('© OpenStreetMap contributors');
      getByText('Powered by Geoapify');
      expect(queryByText('Powered by ホットペッパーグルメ Webサービス')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_PLACE_PROVIDER;
      else process.env.EXPO_PUBLIC_PLACE_PROVIDER = previous;
    }
  });

  // PLACE_PROVIDER=geoapify へ切り替えたときにクレジットが追随することの回帰テスト（#530）
  it('実データの attribution_policy があれば環境変数より優先して表示する', () => {
    // backend が geoapify なのに EXPO_PUBLIC_PLACE_PROVIDER を戻し忘れた状況を再現する
    const previous = process.env.EXPO_PUBLIC_PLACE_PROVIDER;
    process.env.EXPO_PUBLIC_PLACE_PROVIDER = 'unknown-provider';
    try {
      const { getByText, queryByText } = render(
        <Footer attributionPolicies={['osm_odbl_attribution']} />
      );

      getByText('© OpenStreetMap contributors');
      getByText('Powered by Geoapify');
      expect(queryByText('Powered by ホットペッパーグルメ Webサービス')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_PLACE_PROVIDER;
      else process.env.EXPO_PUBLIC_PLACE_PROVIDER = previous;
    }
  });

  // owner 決定 2026-08-21 (#559): Overture のライセンスはフッターへ列挙せず、
  // 「データ提供元・ライセンス」ページへのリンクだけを置く。
  it('overture の候補ではフッターにクレジットを出さず、未使用の provider も出さない', () => {
    // policy が「フッターには出さない」を指しているのに環境変数側へ fallback すると、
    // 使っていない Geoapify をクレジットしてしまう
    const previous = process.env.EXPO_PUBLIC_PLACE_PROVIDER;
    process.env.EXPO_PUBLIC_PLACE_PROVIDER = 'geoapify';
    try {
      const { queryByText, queryAllByTestId } = render(
        <Footer attributionPolicies={['overture_cdla_attribution']} />
      );

      expect(queryAllByTestId(FOOTER_CREDIT_TEST_ID)).toHaveLength(0);
      expect(queryByText('Powered by Geoapify')).toBeNull();
      expect(queryByText('© OpenStreetMap contributors')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_PLACE_PROVIDER;
      else process.env.EXPO_PUBLIC_PLACE_PROVIDER = previous;
    }
  });

  it('Overture と Geoapify が混在したら Geoapify の表記義務だけ残す', () => {
    const { getByText, queryByText } = render(
      <Footer attributionPolicies={['overture_cdla_attribution', 'osm_odbl_attribution']} />
    );

    getByText('© OpenStreetMap contributors');
    getByText('Powered by Geoapify');
    expect(queryByText('© Overture Maps Foundation')).toBeNull();
  });

  it('データ提供元・ライセンスへのリンクをフッターから開ける（#559）', () => {
    const { getByTestId } = render(<Footer />);
    const link = getByTestId('footer-data-sources');

    expect(link.textContent).toContain('データ提供元');
    fireEvent.click(link);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/data-sources' });
  });

  it('英語フッターにもデータ提供元・ライセンスへのリンクを出す（#559）', () => {
    const { getByTestId } = render(<Footer locale="en" />);

    expect(getByTestId('footer-data-sources').textContent).toContain('Data sources');
  });

  it('EXPO_PUBLIC_PLACE_PROVIDER=geoapify では OSM と Geoapify のクレジットを表示する', () => {
    const previous = process.env.EXPO_PUBLIC_PLACE_PROVIDER;
    process.env.EXPO_PUBLIC_PLACE_PROVIDER = 'geoapify';
    try {
      const { getByText, queryByText } = render(<Footer />);

      getByText('© OpenStreetMap contributors');
      getByText('Powered by Geoapify');
      expect(queryByText('Powered by ホットペッパーグルメ Webサービス')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_PLACE_PROVIDER;
      else process.env.EXPO_PUBLIC_PLACE_PROVIDER = previous;
    }
  });

  it('クレジット押下で Geoapify のサイトを開く', () => {
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const { getByText } = render(<Footer />);

    fireEvent.click(getByText('Powered by Geoapify'));

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith('https://www.geoapify.com/');
  });

  // 電気通信事業法 27 条の 12（外部送信規律）の公表ページへの 1 クリック導線の回帰テスト（#271）。
  it('「外部送信について」リンクを表示し、押下で /external-transmission へ遷移する', () => {
    // vi.fn() の呼び出し履歴は restoreAllMocks では消えないため、テスト独立性のため明示的に消す。
    vi.mocked(router.push).mockClear();
    const { getByTestId, getByText } = render(<Footer />);

    getByText('外部送信について ↗');
    fireEvent.click(getByTestId('footer-external-transmission'));

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/external-transmission' });
  });

  // APPI 法17/21/32条・施行令10条の公表事項（プライバシーポリシー）への常時導線の回帰テスト（#278）。
  it('「プライバシー」リンクを表示し、押下で /privacy へ遷移する', () => {
    vi.mocked(router.push).mockClear();
    const { getByTestId, getByText } = render(<Footer />);

    getByText('プライバシー ↗');
    fireEvent.click(getByTestId('footer-privacy'));

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/privacy' });
  });

  it('公開アカウント削除ページへのリンクを表示し、押下で /account-deletion へ遷移する（#641）', () => {
    vi.mocked(router.push).mockClear();
    const { getByTestId, getByText } = render(<Footer />);

    getByText('アカウント削除 ↗');
    fireEvent.click(getByTestId('footer-account-deletion'));

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/account-deletion' });
  });

  it('利用規約と特商法表記へのリンクを表示する', () => {
    vi.mocked(router.push).mockClear();
    const { getByTestId, getByText } = render(<Footer />);

    getByText('利用規約 ↗');
    getByText('特商法表記 ↗');

    fireEvent.click(getByTestId('footer-terms'));
    fireEvent.click(getByTestId('footer-commercial-transactions'));

    expect(router.push).toHaveBeenNthCalledWith(1, { pathname: '/terms' });
    expect(router.push).toHaveBeenNthCalledWith(2, { pathname: '/commercial-transactions' });
  });

  it('英語版フッターから英語の法務文書へ遷移する', () => {
    vi.mocked(router.push).mockClear();
    const { getByTestId, getByText } = render(<Footer locale="en" />);

    getByText('Privacy ↗');
    getByText('Terms of service ↗');
    fireEvent.click(getByTestId('footer-privacy'));
    fireEvent.click(getByTestId('footer-terms'));

    expect(router.push).toHaveBeenNthCalledWith(1, { pathname: '/en/privacy' });
    expect(router.push).toHaveBeenNthCalledWith(2, { pathname: '/en/terms' });
  });
});
