import { StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';
import type { Place } from '@/types';

interface CandidateLocationCardProps {
  place: Place;
}

function hasUsableCoordinates(place: Place): boolean {
  return (
    typeof place.lat === 'number' &&
    Number.isFinite(place.lat) &&
    place.lat >= -90 &&
    place.lat <= 90 &&
    typeof place.lng === 'number' &&
    Number.isFinite(place.lng) &&
    place.lng >= -180 &&
    place.lng <= 180
  );
}

/**
 * 外部地図を開く前に、候補の住所と座標有無だけをOISINT内で確認する。
 * 精密座標や地図タイルは表示せず、共有画面の不用意な位置情報露出を避ける。
 */
export function CandidateLocationCard({ place }: CandidateLocationCardProps) {
  const address = place.address?.trim();
  const coordinatesAvailable = hasUsableCoordinates(place);

  return (
    <View
      testID="candidate-location-card"
      accessibilityLabel={`${place.name}の位置情報${
        address ? `。住所は${address}` : '。住所は未確認です'
      }。${coordinatesAvailable ? '位置座標を確認済みです' : '位置座標は未確認です'}`}
      style={styles.card}
    >
      <View style={styles.header}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.pin}>
          <Text style={styles.pinText}>⌖</Text>
        </View>
        <View style={styles.copy}>
          <Text style={styles.kicker}>LOCATION / 候補位置</Text>
          <Text testID="candidate-location-address" style={styles.address}>
            {address ?? '住所はEvidenceで確認できていません'}
          </Text>
        </View>
      </View>
      <Text testID="candidate-location-precision-note" style={styles.note}>
        {coordinatesAvailable
          ? '位置座標は検索・道順リンクにだけ使用し、数値はこの画面や共有URLに表示しません。'
          : '精密位置は未確認です。外部地図を開いた後も店名・住所を照合してください。'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pin: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.infoSoft,
  },
  pinText: {
    color: colors.info,
    fontSize: 22,
    fontWeight: '800',
  },
  copy: {
    flex: 1,
    gap: 3,
  },
  kicker: {
    color: colors.textTertiary,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  address: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  note: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 16,
  },
});
