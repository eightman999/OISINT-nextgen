import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import type { ImageSourcePropType, StyleProp, ViewStyle } from 'react-native';

import { resolveRestaurantImage } from '@/lib/restaurantImages';
import { colors, genreColor, radius } from '@/theme';
import type { Place } from '@/types';

// 候補カード / 詳細で共有。許可済み店舗写真がない場合や読込失敗時は色面のみ表示する。

type HeroPlace = Pick<Place, 'id' | 'photo' | 'fallbackImageKey' | 'genre'>;

export interface RestaurantHeroImageState {
  heroColor: string;
  source: ImageSourcePropType | null;
  onError?: () => void;
}

export function useRestaurantHeroImage(place: HeroPlace): RestaurantHeroImageState {
  const requestedHeroImage = resolveRestaurantImage({
    photo: place.photo,
    fallbackImageKey: place.fallbackImageKey,
    genre: place.genre,
    fallbackSeed: place.id,
  });
  const [failedRemoteUri, setFailedRemoteUri] = useState<string | null>(null);
  const resolvedHeroImage =
    requestedHeroImage.kind === 'remote' && requestedHeroImage.uri === failedRemoteUri
      ? { kind: 'none' as const }
      : requestedHeroImage;

  return {
    heroColor: genreColor(place.genre),
    source: resolvedHeroImage.kind === 'remote' ? { uri: resolvedHeroImage.uri } : null,
    onError:
      resolvedHeroImage.kind === 'remote'
        ? () => setFailedRemoteUri(resolvedHeroImage.uri)
        : undefined,
  };
}

interface RestaurantHeroImageProps {
  hero: RestaurantHeroImageState;
  genre?: string;
  style?: StyleProp<ViewStyle>;
  /** 画像上に重ねるオーバーレイ（ランクバッジ等） */
  children?: ReactNode;
}

export function RestaurantHeroImage({ hero, genre, style, children }: RestaurantHeroImageProps) {
  return (
    <View
      style={[
        styles.imageWrap,
        !hero.source && styles.withoutPhoto,
        { backgroundColor: hero.heroColor },
        style,
      ]}
    >
      {hero.source ? (
        <Image
          source={hero.source}
          style={styles.heroImage}
          resizeMode="cover"
          accessible={false}
          accessibilityIgnoresInvertColors
          onError={hero.onError}
        />
      ) : null}
      <View pointerEvents="none" style={styles.imageScrim} />
      <Text style={styles.imageLabel}>{genre ?? 'グルメ'}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  imageWrap: {
    position: 'relative',
    aspectRatio: 1.8,
    justifyContent: 'flex-end',
    padding: 8,
    overflow: 'hidden',
  },
  withoutPhoto: {
    aspectRatio: undefined,
    minHeight: 72,
  },
  heroImage: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    // 明示しないと RN-web が静的アセットの実寸（例: 1280px）を width に採用し、
    // どの幅でも imageWrap の外へはみ出す（#220）。cover の切り抜きもここで正しくなる。
    width: '100%',
    height: '100%',
  },
  imageScrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(12, 14, 14, 0.16)',
  },
  imageLabel: {
    alignSelf: 'flex-start',
    color: colors.white,
    backgroundColor: 'rgba(29, 41, 35, 0.88)',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 15,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
    zIndex: 1,
  },
});
