import { useEventListener } from 'expo';
import { VideoView, useVideoPlayer, type VideoSource } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Image,
  type ImageSourcePropType,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, radius } from '@/theme';

type ProductConceptVideoProps = {
  source: VideoSource;
  webFallbackSource?: VideoSource;
  posterSource: ImageSourcePropType;
};

type MountedConceptVideoProps = {
  source: VideoSource;
  onError: () => void;
  onFirstFrame: () => void;
};

/**
 * WebのHTML videoは同じURIの再要求を省略することがあるため、失敗した試行だけ
 * 解決済みURIへ試行番号を付ける。assetId/数値sourceを含むnativeの契約は変更しない。
 */
function sourceForAttempt(source: VideoSource, attempt: number): VideoSource {
  if (Platform.OS !== 'web' || attempt <= 1) return source;

  const assetId =
    typeof source === 'number'
      ? source
      : source && typeof source === 'object' && typeof source.assetId === 'number'
        ? source.assetId
        : null;
  const resolvedAsset =
    assetId !== null
      ? Image.resolveAssetSource?.(assetId as ImageSourcePropType)
      : null;
  const uri =
    typeof source === 'string'
      ? source
      : source && typeof source === 'object' && typeof source.uri === 'string'
        ? source.uri
        : resolvedAsset?.uri ?? null;
  if (!uri) return source;

  const hashIndex = uri.indexOf('#');
  const base = hashIndex >= 0 ? uri.slice(0, hashIndex) : uri;
  const hash = hashIndex >= 0 ? uri.slice(hashIndex) : '';
  const separator = base.includes('?') ? '&' : '?';
  const retryUri = `${base}${separator}oisint-video-retry=${attempt}${hash}`;

  if (typeof source === 'string' || typeof source === 'number') return retryUri;
  if (source && typeof source === 'object') return { ...source, uri: retryUri };
  return source;
}

function sourceForBrowser(primary: VideoSource, webFallback?: VideoSource): VideoSource {
  if (Platform.OS !== 'web' || !webFallback || typeof document === 'undefined') {
    return primary;
  }

  const probe = document.createElement('video');
  const supportsPrimary = probe.canPlayType('video/mp4; codecs="avc1.4D4028"') !== '';
  const supportsFallback = probe.canPlayType('video/webm; codecs="vp09.00.31.08"') !== '';
  return !supportsPrimary && supportsFallback ? webFallback : primary;
}

export function ProductConceptVideo({
  source,
  webFallbackSource,
  posterSource,
}: ProductConceptVideoProps) {
  const [loadRequested, setLoadRequested] = useState(false);
  const [firstFrameRendered, setFirstFrameRendered] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const playbackSource = sourceForBrowser(source, webFallbackSource);

  const requestLoad = () => {
    setFirstFrameRendered(false);
    setLoadFailed(false);
    setAttempt((current) => current + 1);
    setLoadRequested(true);
  };

  const handlePlaybackError = () => {
    setLoadFailed(true);
    setLoadRequested(false);
    setFirstFrameRendered(false);
  };

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <View style={styles.labelDot} />
        <Text testID="concept-video-label" style={styles.label}>
          コンセプト映像
        </Text>
        <Text style={styles.meta}>約16秒・無音・字幕付き</Text>
      </View>

      <View
        testID="concept-video-frame"
        role="group"
        accessibilityLabel="OISINTのコンセプト映像プレイヤー"
        style={styles.frame}
      >
        {loadRequested ? (
          <MountedConceptVideo
            key={attempt}
            source={sourceForAttempt(playbackSource, attempt)}
            onError={handlePlaybackError}
            onFirstFrame={() => setFirstFrameRendered(true)}
          />
        ) : null}

        {!firstFrameRendered ? (
          <Image
            testID="concept-video-poster"
            accessibilityLabel="OISINTコンセプト映像のプレビュー"
            source={posterSource}
            resizeMode="cover"
            style={styles.poster}
          />
        ) : null}

        {!loadRequested ? (
          <View style={styles.actionOverlay}>
            <Pressable
              testID={loadFailed ? 'concept-video-retry' : 'concept-video-load'}
              accessibilityRole="button"
              accessibilityLabel={
                loadFailed ? 'コンセプト映像をもう一度読み込む' : 'コンセプト映像を読み込む'
              }
              accessibilityHint="押すまで動画データは読み込みません"
              onPress={requestLoad}
              style={({ pressed }) => [styles.loadButton, pressed && styles.loadButtonPressed]}
            >
              <Text style={styles.playIcon}>▶</Text>
              <Text style={styles.loadButtonText}>
                {loadFailed ? 'もう一度試す' : '映像を見る'}
              </Text>
            </Pressable>
          </View>
        ) : !firstFrameRendered ? (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator color={colors.surface} />
            <Text style={styles.loadingText}>映像を読み込んでいます</Text>
          </View>
        ) : null}
      </View>

      {loadFailed ? (
        <View testID="concept-video-error" accessibilityRole="alert" style={styles.errorBox}>
          <Text style={styles.errorTitle}>映像を読み込めませんでした</Text>
          <Text style={styles.errorText}>
            通信状態をご確認ください。下の文章要約からも、映像と同じ内容を確認できます。
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function MountedConceptVideo({ source, onError, onFirstFrame }: MountedConceptVideoProps) {
  const player = useVideoPlayer(source, (createdPlayer) => {
    createdPlayer.loop = false;
    createdPlayer.staysActiveInBackground = false;
    createdPlayer.showNowPlayingNotification = false;
  });
  const videoViewRef = useRef<VideoView>(null);
  const firstContentReadyRef = useRef(false);
  const errorHandledRef = useRef(false);
  const markFirstContentReady = useCallback(() => {
    if (firstContentReadyRef.current) return;
    firstContentReadyRef.current = true;
    onFirstFrame();
  }, [onFirstFrame]);

  useEffect(() => {
    // readyToPlay/errorがstatusChange購読より先に発火した場合も、現在のplayer状態から
    // posterとエラー表示を確実に同期する。Webでは初期化のタイミング差を吸収するため
    // 短時間だけ状態を再確認する。
    let pollId: ReturnType<typeof setInterval> | undefined;
    let completed = false;
    const syncPlayerStatus = () => {
      const nativeVideo =
        Platform.OS === 'web'
          ? (videoViewRef.current?.nativeRef.current as HTMLVideoElement | null | undefined)
          : null;
      // expo-video Webはsource設定がeffectより先に完了するとstatusChangeと
      // onFirstFrameRenderの両方を取り逃す。公開nativeRefのreadyStateを同じ
      // terminal判定へ入れ、実フレームが利用可能(HAVE_CURRENT_DATA)ならposterを外す。
      if (player.status === 'readyToPlay' || (nativeVideo?.readyState ?? 0) >= 2) {
        completed = true;
        markFirstContentReady();
        if (pollId !== undefined) clearInterval(pollId);
      } else if ((player.status === 'error' || nativeVideo?.error) && !errorHandledRef.current) {
        completed = true;
        errorHandledRef.current = true;
        onError();
        if (pollId !== undefined) clearInterval(pollId);
      }
    };
    syncPlayerStatus();
    if (Platform.OS !== 'web' || completed) return;

    pollId = setInterval(syncPlayerStatus, 50);
    return () => {
      if (pollId !== undefined) clearInterval(pollId);
    };
  }, [markFirstContentReady, onError, player]);

  useEffect(() => {
    const pauseWhenInactive = (state: AppStateStatus) => {
      if (state !== 'active') player.pause();
    };
    const appStateSubscription = AppState.addEventListener('change', pauseWhenInactive);

    const pauseWhenDocumentIsHidden = () => {
      if (document.visibilityState !== 'visible') player.pause();
    };
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', pauseWhenDocumentIsHidden);
    }

    return () => {
      appStateSubscription.remove();
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', pauseWhenDocumentIsHidden);
      }
    };
  }, [player]);

  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'error') onError();
    // Expo Webではloadeddata/onFirstFrameRenderより先にreadyToPlayになるため、
    // どちらの通知経路でもposterを外せるようにする。
    if (status === 'readyToPlay') markFirstContentReady();
  });

  return (
    <VideoView
      ref={videoViewRef}
      testID="concept-video-view"
      player={player}
      nativeControls
      contentFit="contain"
      playsInline
      allowsPictureInPicture={false}
      startsPictureInPictureAutomatically={false}
      fullscreenOptions={{ enable: true }}
      onFirstFrameRender={markFirstContentReady}
      style={styles.video}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    gap: 12,
  },
  labelRow: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  labelDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.orange,
  },
  label: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
  },
  meta: {
    color: colors.textTertiary,
    fontSize: 11,
  },
  frame: {
    position: 'relative',
    width: '100%',
    aspectRatio: 16 / 9,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.black,
  },
  video: {
    width: '100%',
    height: '100%',
  },
  poster: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: '100%',
    height: '100%',
  },
  actionOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(29, 41, 35, 0.18)',
  },
  loadButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.55)',
    borderRadius: radius.pill,
    backgroundColor: 'rgba(29, 41, 35, 0.94)',
  },
  loadButtonPressed: {
    backgroundColor: colors.blackHover,
  },
  playIcon: {
    color: colors.surface,
    fontSize: 13,
  },
  loadButtonText: {
    color: colors.surface,
    fontSize: 13,
    fontWeight: '800',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    pointerEvents: 'none',
    backgroundColor: 'rgba(29, 41, 35, 0.42)',
  },
  loadingText: {
    color: colors.surface,
    fontSize: 12,
    fontWeight: '700',
  },
  errorBox: {
    gap: 4,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.sm,
    backgroundColor: colors.dangerSoft,
  },
  errorTitle: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '800',
  },
  errorText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 19,
  },
});
