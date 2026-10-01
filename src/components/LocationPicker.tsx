import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useState } from 'react';

import { colors, radius } from '@/theme';
import type { LocationSelection } from '@/types';

interface LocationPickerProps {
  value: LocationSelection | null;
  onChange: (location: LocationSelection | null) => void;
  // GPS取得中は親側の検索開始を止めるための通知。取得完了前に検索されると
  // 「現在地を使う」の選択がそのままフォームから落ち、GPSで得た座標が
  // 一切使われないまま通常検索になってしまう (#317)。
  onResolvingChange?: (resolving: boolean) => void;
}

type LocationStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'unsupported' | 'error';

export function LocationPicker({ value, onChange, onResolvingChange }: LocationPickerProps) {
  const [manualLocation, setManualLocation] = useState(
    value?.source === 'map' ? value.label : ''
  );
  const [status, setStatus] = useState<LocationStatus>(value?.source === 'gps' ? 'granted' : 'idle');
  const [errorMessage, setErrorMessage] = useState('');

  const requestGps = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('unsupported');
      setErrorMessage('このブラウザでは位置情報を取得できません。場所を入力してください。');
      return;
    }

    setStatus('requesting');
    setErrorMessage('');
    onResolvingChange?.(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        onChange({
          label: '現在地付近',
          source: 'gps',
          latitude: coords.latitude,
          longitude: coords.longitude,
        });
        setStatus('granted');
        onResolvingChange?.(false);
      },
      (error) => {
        const denied = error.code === error.PERMISSION_DENIED;
        setStatus(denied ? 'denied' : 'error');
        setErrorMessage(
          denied
            ? '位置情報が許可されていません。下の入力欄から場所を指定できます。'
            : '現在地を取得できませんでした。場所を入力して続けてください。'
        );
        onResolvingChange?.(false);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  };

  const openMap = () => {
    const query = manualLocation.trim() || '現在地';
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    void Linking.openURL(mapUrl).catch(() => {
      setErrorMessage('地図を開けませんでした。場所名を入力してそのまま使えます。');
    });
  };

  const useManualLocation = () => {
    const label = manualLocation.trim();
    if (!label) return;
    onChange({ label, source: 'map' });
    setStatus('idle');
    setErrorMessage('');
  };

  const clearLocation = () => {
    onChange(null);
    setManualLocation('');
    setStatus('idle');
    setErrorMessage('');
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>01 / 場所</Text>
          <Text style={styles.title}>いまいる場所から探す</Text>
          <Text style={styles.description}>
            現在地検索を実行するときだけ座標をGeoapifyへ送信します。調査・共有データには保存しません。許可しない場合は駅名や地名を入力できます。
          </Text>
        </View>
        {value && (
          <Pressable
            testID="location-clear"
            accessibilityRole="button"
            accessibilityLabel="場所の選択をクリア"
            onPress={clearLocation}
            style={styles.clearButton}
          >
            <Text style={styles.clearButtonText}>クリア</Text>
          </Pressable>
        )}
      </View>

      {value ? (
        <View testID="location-selected" style={styles.selectedLocation}>
          <View style={styles.selectedDot} />
          <View style={styles.selectedCopy}>
            <Text style={styles.selectedLabel}>{value.label}</Text>
            <Text style={styles.selectedMeta}>
              {value.source === 'gps' ? 'GPSで取得した現在地付近' : '地図・入力から指定'}
            </Text>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.actionRow}>
            <Pressable
              testID="location-gps"
              accessibilityRole="button"
              accessibilityLabel={status === 'requesting' ? '現在地を取得中' : '現在地を使う'}
              onPress={requestGps}
              disabled={status === 'requesting'}
              style={[styles.primaryButton, status === 'requesting' && styles.disabledButton]}
            >
              <Text style={styles.primaryButtonText}>
                {status === 'requesting' ? '取得中…' : '◎ 現在地を使う'}
              </Text>
            </Pressable>
            <Text style={styles.orText}>または</Text>
          </View>

          <View style={styles.manualRow}>
            <TextInput
              testID="location-map-input"
              accessibilityLabel="検索する場所"
              accessibilityHint="駅名や地名だけを入力してください。人数、予算、料理、好みは下の条件欄へ入力してください"
              value={manualLocation}
              onChangeText={setManualLocation}
              placeholder="例：池袋駅、渋谷"
              placeholderTextColor={colors.textTertiary}
              style={styles.manualInput}
              returnKeyType="done"
              onSubmitEditing={useManualLocation}
            />
            <Pressable
              testID="location-map-open"
              accessibilityRole="button"
              accessibilityLabel="入力した場所を地図で確認"
              onPress={openMap}
              style={styles.mapButton}
            >
              <Text style={styles.mapButtonText}>地図で確認</Text>
            </Pressable>
          </View>
          <Text testID="location-input-guide" style={styles.inputGuide}>
            場所欄には駅名・地名だけを入力します（例：池袋駅）。人数・予算・料理・雰囲気などは、下の「探したいお店の条件」欄に入力してください。入力後は「この場所で検索条件にする」を押します。
          </Text>
          <Pressable
            testID="location-use-manual"
            accessibilityRole="button"
            accessibilityLabel="この場所を検索条件にする"
            onPress={useManualLocation}
            disabled={!manualLocation.trim()}
            style={[styles.manualApply, !manualLocation.trim() && styles.disabledOutline]}
          >
            <Text style={styles.manualApplyText}>この場所で検索条件にする</Text>
          </Pressable>
        </>
      )}

      {errorMessage ? (
        <Text testID="location-error" accessibilityRole="alert" style={styles.errorText}>
          {errorMessage}
        </Text>
      ) : (
        <Text style={styles.helperText}>
          {status === 'granted'
            ? '検索実行中だけ座標をGeoapifyへ送信し、OISINTの調査・共有データには保存しません。'
            : 'GPSを拒否しても、駅名や地名を入力して続けられます。'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceQuiet,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  headerCopy: {
    flex: 1,
    gap: 3,
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: colors.orange,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  description: {
    fontSize: 11,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  clearButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  clearButtonText: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  primaryButton: {
    minHeight: 38,
    paddingHorizontal: 15,
    borderRadius: radius.sm,
    backgroundColor: colors.black,
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: colors.surface,
    fontSize: 12,
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.55,
  },
  orText: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  manualRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  manualInput: {
    flex: 1,
    minHeight: 38,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 13,
  },
  mapButton: {
    minHeight: 38,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  mapButtonText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text,
  },
  manualApply: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  manualApplyText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.orange,
  },
  disabledOutline: {
    opacity: 0.45,
  },
  selectedLocation: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 11,
    borderRadius: radius.sm,
    backgroundColor: colors.successSoft,
  },
  selectedDot: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
  },
  selectedCopy: {
    gap: 2,
  },
  selectedLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
  },
  selectedMeta: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  helperText: {
    fontSize: 10,
    lineHeight: 15,
    color: colors.textTertiary,
  },
  inputGuide: {
    fontSize: 11,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  errorText: {
    fontSize: 11,
    lineHeight: 17,
    color: colors.danger,
  },
});
