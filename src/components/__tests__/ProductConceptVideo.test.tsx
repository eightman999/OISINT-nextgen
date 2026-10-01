// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Image } from 'react-native';

import { ProductConceptVideo } from '@/components/ProductConceptVideo';

type MockPlayer = {
  loop: boolean;
  staysActiveInBackground: boolean;
  showNowPlayingNotification: boolean;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
};

type StatusListener = (payload: { status: 'idle' | 'loading' | 'readyToPlay' | 'error' }) => void;

const videoMocks = vi.hoisted(() => ({
  useVideoPlayer: vi.fn(),
  useEventListener: vi.fn(),
  players: [] as MockPlayer[],
  statusListener: undefined as StatusListener | undefined,
  viewProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock('expo', () => ({
  useEventListener: (
    player: MockPlayer,
    eventName: string,
    listener: StatusListener,
  ) => videoMocks.useEventListener(player, eventName, listener),
}));

vi.mock('expo-video', () => ({
  useVideoPlayer: (
    source: unknown,
    setup?: (player: MockPlayer) => void,
  ) => videoMocks.useVideoPlayer(source, setup),
  VideoView: (props: Record<string, unknown> & { testID?: string }) => {
    videoMocks.viewProps = props;
    return <div data-testid={props.testID} />;
  },
}));

beforeEach(() => {
  videoMocks.players.length = 0;
  videoMocks.statusListener = undefined;
  videoMocks.viewProps = undefined;
  videoMocks.useVideoPlayer.mockReset();
  videoMocks.useEventListener.mockReset();

  videoMocks.useVideoPlayer.mockImplementation(
    (_source: unknown, setup?: (player: MockPlayer) => void) => {
      const player: MockPlayer = {
        loop: true,
        staysActiveInBackground: true,
        showNowPlayingNotification: true,
        pause: vi.fn(),
        play: vi.fn(),
      };
      setup?.(player);
      videoMocks.players.push(player);
      return player;
    },
  );
  videoMocks.useEventListener.mockImplementation(
    (_player: MockPlayer, eventName: string, listener: StatusListener) => {
      if (eventName === 'statusChange') videoMocks.statusListener = listener;
    },
  );
});

afterEach(() => {
  cleanup();
});

const source = { uri: '/concept-video.mp4' };
const webFallbackSource = { uri: '/concept-video.webm' };
const posterSource = { uri: '/concept-video-poster.jpg' };

describe('ProductConceptVideo', () => {
  it('押下前はposterだけを表示し、動画playerを生成しない', () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <ProductConceptVideo source={source} posterSource={posterSource} />,
    );

    getByText('コンセプト映像');
    getByText('約16秒・無音・字幕付き');
    getByTestId('concept-video-poster');
    getByTestId('concept-video-load');
    expect(getByTestId('concept-video-frame').getAttribute('role')).toBe('group');
    expect(queryByTestId('concept-video-view')).toBeNull();
    expect(videoMocks.useVideoPlayer).not.toHaveBeenCalled();
  });

  it('明示操作後だけplayerを生成し、controls/fullscreenを有効・autoplay/loop/PiP/backgroundを無効にする', () => {
    const { getByTestId } = render(
      <ProductConceptVideo source={source} posterSource={posterSource} />,
    );

    fireEvent.click(getByTestId('concept-video-load'));

    expect(videoMocks.useVideoPlayer).toHaveBeenCalledTimes(1);
    expect(videoMocks.players).toHaveLength(1);
    expect(videoMocks.players[0]).toMatchObject({
      loop: false,
      staysActiveInBackground: false,
      showNowPlayingNotification: false,
    });
    expect(videoMocks.players[0].play).not.toHaveBeenCalled();
    expect(videoMocks.viewProps).toMatchObject({
      nativeControls: true,
      contentFit: 'contain',
      playsInline: true,
      allowsPictureInPicture: false,
      startsPictureInPictureAutomatically: false,
      fullscreenOptions: { enable: true },
    });
  });

  it('最初のframeが描画されるまでposterを維持する', () => {
    const { getByTestId, queryByTestId } = render(
      <ProductConceptVideo source={source} posterSource={posterSource} />,
    );

    fireEvent.click(getByTestId('concept-video-load'));
    getByTestId('concept-video-poster');

    act(() => {
      (videoMocks.viewProps?.onFirstFrameRender as (() => void) | undefined)?.();
    });

    expect(queryByTestId('concept-video-poster')).toBeNull();
  });

  it('readyToPlayでも最初のコンテンツ準備完了としてposterを外す', () => {
    const { getByTestId, queryByTestId } = render(
      <ProductConceptVideo source={source} posterSource={posterSource} />,
    );

    fireEvent.click(getByTestId('concept-video-load'));

    act(() => {
      videoMocks.statusListener?.({ status: 'readyToPlay' });
    });

    expect(queryByTestId('concept-video-poster')).toBeNull();
  });

  it('documentがhiddenになったらWeb再生を停止する', () => {
    const { getByTestId } = render(
      <ProductConceptVideo source={source} posterSource={posterSource} />,
    );

    fireEvent.click(getByTestId('concept-video-load'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(videoMocks.players[0].pause).toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('load error時はposter・文章案内・retryを表示し、新しいplayerで再試行する', () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <ProductConceptVideo source={source} posterSource={posterSource} />,
    );

    fireEvent.click(getByTestId('concept-video-load'));
    act(() => {
      videoMocks.statusListener?.({ status: 'error' });
    });

    getByTestId('concept-video-poster');
    getByTestId('concept-video-error');
    getByText('映像を読み込めませんでした');
    getByText(/文章要約からも/);
    expect(queryByTestId('concept-video-view')).toBeNull();

    fireEvent.click(getByTestId('concept-video-retry'));
    expect(videoMocks.useVideoPlayer).toHaveBeenCalledTimes(2);
    expect(videoMocks.useVideoPlayer.mock.calls[0]?.[0]).toEqual(source);
    expect(videoMocks.useVideoPlayer.mock.calls[1]?.[0]).toEqual({
      uri: '/concept-video.mp4?oisint-video-retry=2',
    });
    getByTestId('concept-video-view');
  });

  it('Webで数値asset IDを解決し、retry時だけ解決済みURIへqueryを付ける', () => {
    const imageWithResolver = Image as unknown as {
      resolveAssetSource?: (source: number) => { uri: string } | null;
    };
    const previousResolver = imageWithResolver.resolveAssetSource;
    imageWithResolver.resolveAssetSource = vi.fn(() => ({ uri: '/resolved-concept-video.mp4' }));

    try {
      const { getByTestId } = render(
        <ProductConceptVideo source={42} posterSource={posterSource} />,
      );

      fireEvent.click(getByTestId('concept-video-load'));
      act(() => {
        videoMocks.statusListener?.({ status: 'error' });
      });
      fireEvent.click(getByTestId('concept-video-retry'));

      expect(videoMocks.useVideoPlayer.mock.calls[1]?.[0]).toBe(
        '/resolved-concept-video.mp4?oisint-video-retry=2',
      );
    } finally {
      if (previousResolver) imageWithResolver.resolveAssetSource = previousResolver;
      else delete imageWithResolver.resolveAssetSource;
    }
  });

  it('H.264非対応・VP9対応のWebブラウザでWebMを選択する', () => {
    const canPlayType = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockImplementation((type) => (type.includes('webm') ? 'probably' : ''));

    try {
      const { getByTestId } = render(
        <ProductConceptVideo
          source={source}
          webFallbackSource={webFallbackSource}
          posterSource={posterSource}
        />,
      );

      fireEvent.click(getByTestId('concept-video-load'));
      expect(videoMocks.useVideoPlayer.mock.calls[0]?.[0]).toEqual(webFallbackSource);
    } finally {
      canPlayType.mockRestore();
    }
  });
});
