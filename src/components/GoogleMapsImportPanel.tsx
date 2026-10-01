import type { ChangeEvent, ElementType } from 'react';
import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  localSnapshotFromStoredPreferenceProfile,
  saveStoredPreferenceProfile,
  type StoredPreferenceProfile,
} from '@/lib/accountRepository';
import {
  GoogleMapsImportError,
  parseGoogleMapsTakeout,
  selectInferredTasteLabels,
  selectInferredTasteSignals,
  type InferredTasteSignal,
  type GoogleMapsImportSummary,
} from '@/lib/googleMapsImport';
import {
  commitImportedTasteMerge,
  createImportedTasteMerge,
  emptyPersonalizationSnapshot,
  type LocalPersonalizationSnapshot,
  type PersonalizationSubject,
} from '@/lib/personalization';
import { PREFERENCE_CONTEXT_LABELS } from '@/lib/preferenceLearning';
import {
  PERSONALIZATION_CONSENT_LABEL,
  PERSONALIZATION_CONSENT_VERSION,
} from '@/lib/personalizationConsent';
import { colors, fonts, radius } from '@/theme';

const WebFileInput = 'input' as ElementType;
const TAKEOUT_URL = 'https://takeout.google.com/settings/takeout';
const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface GoogleMapsImportPanelProps {
  isAuthenticated: boolean;
  subject?: PersonalizationSubject;
  /** 認証済み取込では、payload作成時点のcloud正本を明示的に渡す。 */
  baseProfile?: StoredPreferenceProfile | null;
  /** account画面のcloud正本読込が完了するまでCAS対象の取込を開始しない。 */
  baseProfileLoaded?: boolean;
  onApplied?: (snapshot: LocalPersonalizationSnapshot) => void;
}

export function GoogleMapsImportPanel({
  isAuthenticated,
  subject,
  baseProfile,
  baseProfileLoaded = true,
  onApplied,
}: GoogleMapsImportPanelProps) {
  const [summary, setSummary] = useState<GoogleMapsImportSummary | null>(null);
  const [fileName, setFileName] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    setBusy(true);
    setErrorMessage('');
    setSuccessMessage('');
    setSummary(null);
    setSelectedLabels([]);
    setConsent(false);

    try {
      if (file.size > MAX_FILE_BYTES) {
        throw new GoogleMapsImportError('too_large', 'ファイルは5MB以下にしてください。');
      }
      const text = await file.text();
      const nextSummary = parseGoogleMapsTakeout(text, file.name);
      setFileName(file.name.slice(0, 120));
      setSummary(nextSummary);
      setSelectedLabels(nextSummary.inferredLikes.map((signal) => signal.label));
    } catch (error) {
      setFileName('');
      setSelectedLabels([]);
      setErrorMessage(
        error instanceof GoogleMapsImportError
          ? error.message
          : 'ファイルを読み取れませんでした。別の書き出しファイルをお試しください。',
      );
    } finally {
      setBusy(false);
    }
  };

  const applySummary = async () => {
    if (!summary || !consent) return;
    const selectedSignals = selectInferredTasteSignals(summary, selectedLabels);
    const selectedLikes = selectedSignals.map((signal) => signal.label);
    if (selectedLikes.length === 0) return;
    setBusy(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      if (isAuthenticated && !baseProfileLoaded) {
        throw new Error('保存済みプロフィールを確認中です。少し待ってから再度お試しください。');
      }
      const cloudBase = isAuthenticated
        ? baseProfile
          ? localSnapshotFromStoredPreferenceProfile(baseProfile)
          : emptyPersonalizationSnapshot()
        : undefined;
      const merge = createImportedTasteMerge(
        selectedLikes,
        [],
        selectedSignals,
        subject,
        cloudBase,
      );
      if (isAuthenticated) {
        await saveStoredPreferenceProfile(
          merge.snapshot,
          {
            profileExists: baseProfile !== null && baseProfile !== undefined,
            updatedAt: baseProfile?.updatedAt ?? null,
          },
          'maps_takeout',
        );
      }
      commitImportedTasteMerge(merge, subject);
      onApplied?.(merge.snapshot);
      setSuccessMessage(
        isAuthenticated
          ? '集約した好みだけを、この端末とアカウントに保存しました。'
          : '集約した好みだけを、この端末に保存しました。',
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : '好みプロフィールへ反映できませんでした。',
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleSignal = (label: string) => {
    setConsent(false);
    setSelectedLabels((current) =>
      current.includes(label)
        ? current.filter((candidate) => candidate !== label)
        : [...current, label],
    );
  };

  const selectedCount = summary
    ? selectInferredTasteLabels(summary, selectedLabels).length
    : 0;

  return (
    <View testID="maps-import-panel" style={styles.container}>
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text style={styles.kicker}>任意機能 / 端末内で解析</Text>
          <Text style={styles.title}>Google Mapsの保存リストから学ぶ</Text>
          <Text style={styles.lead}>
            Googleログインとは別の任意機能です。Takeoutの「Saved」CSV/JSONを、このブラウザ内だけで集計します。
          </Text>
        </View>
        <View style={styles.localBadge}>
          <View style={styles.localDot} />
          <Text style={styles.localBadgeText}>ファイルは端末内のみ</Text>
        </View>
      </View>

      <View style={styles.boundaryGrid}>
        <BoundaryItem mark="✓" title="使う" text="明示タグ・リスト名・粗い利用場面" positive />
        <BoundaryItem mark="×" title="使わない" text="店舗名・URL・住所・座標" />
        <BoundaryItem mark="×" title="対象外" text="タイムライン・位置履歴" />
      </View>

      <View style={styles.steps}>
        <View style={styles.stepRow}>
          <Text style={styles.stepNumber}>01</Text>
          <View style={styles.stepCopy}>
            <Text style={styles.stepTitle}>Google Takeoutで「Saved」を選ぶ</Text>
            <Text style={styles.stepText}>「Mapsのタイムライン」ではなく、保存済みリストを書き出します。</Text>
          </View>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Google Takeoutを別画面で開く"
            onPress={() => void Linking.openURL(TAKEOUT_URL)}
            style={styles.takeoutLink}
          >
            <Text style={styles.takeoutLinkText}>Takeoutを開く ↗</Text>
          </Pressable>
        </View>

        <View style={styles.stepRow}>
          <Text style={styles.stepNumber}>02</Text>
          <View style={styles.stepCopy}>
            <Text style={styles.stepTitle}>解凍したCSVまたはJSONを選ぶ</Text>
            <Text style={styles.stepText}>ZIPは開かず、5MB以下のファイルを1件ずつ確認します。</Text>
          </View>
          {Platform.OS === 'web' ? (
            <WebFileInput
              data-testid="maps-import-file"
              aria-label="Google Takeoutの保存済みリストを選択"
              type="file"
              accept=".csv,.json,.geojson,text/csv,application/json,application/geo+json"
              disabled={busy}
              onChange={handleFile}
              style={webInputStyle}
            />
          ) : (
            <Text style={styles.webOnly}>Web版で利用できます</Text>
          )}
        </View>
      </View>

      {errorMessage ? (
        <Text testID="maps-import-error" accessibilityRole="alert" style={styles.errorText}>
          {errorMessage}
        </Text>
      ) : null}

      {summary ? (
        <View testID="maps-import-preview" style={styles.preview}>
          <View style={styles.previewHeader}>
            <View>
              <Text style={styles.previewKicker}>プレビュー / 未保存</Text>
              <Text style={styles.previewTitle}>保存する傾向を選ぶ</Text>
            </View>
            <View style={styles.fileMeta}>
              <Text numberOfLines={1} style={styles.fileName}>{fileName}</Text>
              <Text style={styles.fileCount}>{summary.recordCount}件を端末内で確認</Text>
            </View>
          </View>

          <View style={styles.signalRow}>
            {summary.inferredLikes.length > 0 ? (
              summary.inferredLikes.map((signal, index) => {
                const selected = selectedLabels.includes(signal.label);
                return (
                  <Pressable
                    key={signal.label}
                    testID={`maps-import-signal-${index}`}
                    accessibilityRole="checkbox"
                    accessibilityLabel={
                      selected
                        ? `${signal.label}${signalContextLabel(signal)}を好みから外す`
                        : `${signal.label}${signalContextLabel(signal)}を好みへ追加`
                    }
                    accessibilityState={{ checked: selected }}
                    aria-checked={selected}
                    onPress={() => toggleSignal(signal.label)}
                    style={[styles.signalChip, !selected && styles.signalChipOff]}
                  >
                    <View style={[styles.signalCheck, selected && styles.signalCheckOn]}>
                      <Text style={[styles.signalCheckText, selected && styles.signalCheckTextOn]}>
                        {selected ? '✓' : '+'}
                      </Text>
                    </View>
                    <Text style={[styles.signalLabel, !selected && styles.signalLabelOff]}>
                      {signal.label}
                    </Text>
                    <Text style={styles.signalOrigin}>{signalOriginLabel(signal)}</Text>
                    {signal.contexts.length > 0 ? (
                      <Text style={styles.signalContext}>{signalContextLabel(signal)}</Text>
                    ) : null}
                    <Text style={styles.signalCount}>{signal.matches}</Text>
                  </Pressable>
                );
              })
            ) : (
              <Text style={styles.noSignals}>保存できる料理傾向は見つかりませんでした。</Text>
            )}
          </View>

          <Text style={styles.discardedText}>
            {selectedCount}件を選択中。{summary.discardedDetailFields}個のURL・住所・座標などの詳細フィールドを破棄しました。
          </Text>

          <Pressable
            testID="maps-import-consent"
            accessibilityRole="checkbox"
            accessibilityLabel="表示された集約タグだけを好みプロフィールへ追加することに同意"
            accessibilityState={{ checked: consent }}
            aria-checked={consent}
            onPress={() => setConsent((current) => !current)}
            style={styles.consentRow}
          >
            <View style={[styles.checkbox, consent && styles.checkboxChecked]}>
              {consent ? <Text style={styles.checkmark}>✓</Text> : null}
            </View>
            <Text style={styles.consentText}>
              選んだ集約タグと、同じ保存項目に現れた粗い利用場面だけを好みプロフィールへ追加し、端末内に既にある集約プロフィールと合わせて、{PERSONALIZATION_CONSENT_LABEL}ことに同意します（{PERSONALIZATION_CONSENT_VERSION}）。元ファイル、検索文、店名、個別の行動IDは保存しません。
            </Text>
          </Pressable>

          <Pressable
            testID="maps-import-apply"
            accessibilityRole="button"
            accessibilityState={{
              disabled: !consent || busy || selectedCount === 0,
            }}
            disabled={!consent || busy || selectedCount === 0}
            onPress={() => void applySummary()}
            style={[
              styles.applyButton,
              (!consent || busy || selectedCount === 0) && styles.disabled,
            ]}
          >
            <Text style={styles.applyButtonText}>{busy ? '反映中…' : '集約タグだけを反映する'}</Text>
          </Pressable>
        </View>
      ) : null}

      {successMessage ? (
        <Text testID="maps-import-success" accessibilityRole="alert" style={styles.successText}>
          ✓ {successMessage}
        </Text>
      ) : null}
    </View>
  );
}

function signalOriginLabel(signal: InferredTasteSignal): string {
  if (signal.origins.includes('explicit_tag')) return 'タグ';
  if (signal.origins.includes('list_name')) return 'リスト';
  return '本文';
}

function signalContextLabel(signal: InferredTasteSignal): string {
  if (signal.contexts.length === 0) return '';
  return ` / ${signal.contexts.map((context) => PREFERENCE_CONTEXT_LABELS[context]).join('・')}`;
}

function BoundaryItem({
  mark,
  title,
  text,
  positive = false,
}: {
  mark: string;
  title: string;
  text: string;
  positive?: boolean;
}) {
  return (
    <View style={styles.boundaryItem}>
      <Text style={[styles.boundaryMark, positive && styles.boundaryMarkPositive]}>{mark}</Text>
      <View>
        <Text style={styles.boundaryTitle}>{title}</Text>
        <Text style={styles.boundaryText}>{text}</Text>
      </View>
    </View>
  );
}

const webInputStyle = {
  maxWidth: 230,
  padding: '9px 11px',
  border: `1px solid ${colors.border}`,
  borderRadius: 9,
  background: colors.surface,
  color: colors.text,
  fontSize: 10,
  cursor: 'pointer',
};

const styles = StyleSheet.create({
  container: {
    padding: 25,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  headingRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 18,
  },
  headingCopy: {
    flex: 1,
    minWidth: 250,
    maxWidth: '100%',
  },
  kicker: {
    color: colors.info,
    fontFamily: fonts.brand,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1,
  },
  title: {
    marginTop: 7,
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
  },
  lead: {
    maxWidth: 700,
    marginTop: 8,
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 18,
  },
  localBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radius.pill,
  },
  localDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.info,
  },
  localBadgeText: {
    color: colors.info,
    fontFamily: fonts.brand,
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.7,
  },
  boundaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 20,
  },
  boundaryItem: {
    minWidth: 185,
    maxWidth: '100%',
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.canvas,
  },
  boundaryMark: {
    color: colors.red,
    fontFamily: fonts.brand,
    fontSize: 15,
    fontWeight: '800',
  },
  boundaryMarkPositive: {
    color: colors.success,
  },
  boundaryTitle: {
    color: colors.text,
    fontSize: 9,
    fontWeight: '800',
  },
  boundaryText: {
    marginTop: 2,
    color: colors.textTertiary,
    fontSize: 8,
  },
  steps: {
    marginTop: 20,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  stepRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  stepNumber: {
    color: colors.orange,
    fontFamily: fonts.brand,
    fontSize: 10,
    fontWeight: '800',
  },
  stepCopy: {
    minWidth: 210,
    maxWidth: '100%',
    flex: 1,
  },
  stepTitle: {
    color: colors.text,
    fontSize: 10,
    fontWeight: '800',
  },
  stepText: {
    marginTop: 3,
    color: colors.textTertiary,
    fontSize: 8,
    lineHeight: 14,
  },
  takeoutLink: {
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
  },
  takeoutLinkText: {
    color: colors.info,
    fontSize: 9,
    fontWeight: '700',
  },
  webOnly: {
    color: colors.textTertiary,
    fontSize: 9,
  },
  errorText: {
    marginTop: 14,
    padding: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.dangerSoft,
    color: colors.danger,
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 16,
  },
  preview: {
    marginTop: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radius.md,
    backgroundColor: colors.importSoft,
  },
  previewHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 14,
  },
  previewKicker: {
    color: colors.info,
    fontFamily: fonts.brand,
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  previewTitle: {
    marginTop: 4,
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
  },
  fileMeta: {
    maxWidth: 260,
    alignItems: 'flex-end',
  },
  fileName: {
    maxWidth: 260,
    color: colors.textSecondary,
    fontSize: 8,
    fontWeight: '700',
  },
  fileCount: {
    marginTop: 3,
    color: colors.textTertiary,
    fontSize: 7,
  },
  signalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 16,
  },
  signalChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  signalChipOff: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
    opacity: 0.68,
  },
  signalCheck: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
  },
  signalCheckOn: {
    borderColor: colors.info,
    backgroundColor: colors.info,
  },
  signalCheckText: {
    color: colors.textTertiary,
    fontSize: 9,
    fontWeight: '800',
  },
  signalCheckTextOn: {
    color: colors.surface,
  },
  signalLabel: {
    color: colors.text,
    fontSize: 9,
    fontWeight: '700',
  },
  signalLabelOff: {
    color: colors.textTertiary,
    textDecorationLine: 'line-through',
  },
  signalCount: {
    color: colors.info,
    fontFamily: fonts.brand,
    fontSize: 8,
    fontWeight: '800',
  },
  signalOrigin: {
    color: colors.textTertiary,
    fontFamily: fonts.brand,
    fontSize: 6,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  signalContext: {
    color: colors.info,
    fontSize: 7,
    fontWeight: '700',
  },
  noSignals: {
    color: colors.textSecondary,
    fontSize: 9,
  },
  discardedText: {
    marginTop: 13,
    color: colors.textTertiary,
    fontSize: 8,
  },
  consentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 17,
  },
  checkbox: {
    width: 19,
    height: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },
  checkboxChecked: {
    borderColor: colors.info,
    backgroundColor: colors.info,
  },
  checkmark: {
    color: colors.surface,
    fontSize: 11,
    fontWeight: '800',
  },
  consentText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 8,
    lineHeight: 15,
  },
  applyButton: {
    minHeight: 43,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 15,
    borderRadius: radius.sm,
    backgroundColor: colors.info,
  },
  applyButtonText: {
    color: colors.surface,
    fontSize: 10,
    fontWeight: '800',
  },
  disabled: {
    opacity: 0.35,
  },
  successText: {
    marginTop: 14,
    padding: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.successSoft,
    color: colors.success,
    fontSize: 9,
    fontWeight: '700',
  },
});
