import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Footer } from '@/components/Footer';
import {
  SupportChoiceGroup,
  SupportField,
  SupportNotice,
  SupportPrivacyNote,
  SupportSubmitButton,
} from '@/components/SupportFormFields';
import { SupportHeader } from '@/components/SupportHeader';
import { hasConfiguredSupportEmail, handoffSupportMessage } from '@/lib/support';
import { colors, fonts, radius } from '@/theme';

// #267: 誤情報の訂正・削除・異議申立ての受付フォーム。
// contact と同じ mailto 下書き / コピー方式（src/lib/support.ts）で送る。
// 運用手順（受領→暫定「確認中」化→確認→反映→記録）は docs/legal/correction-request-procedure.md。

const REQUEST_TYPE_OPTIONS = [
  { value: 'correction', label: '訂正', description: '判定（○△×?）や営業情報が実際と違う' },
  { value: 'deletion', label: '削除', description: '表示や掲載自体の削除を求める' },
  { value: 'objection', label: '異議申立て', description: '表示内容に異議がある・説明を求める' },
];

const STANDPOINT_OPTIONS = [
  { value: 'store', label: '店舗関係者', description: '対象店舗の経営者・従業員・代理人' },
  { value: 'user', label: '利用者', description: 'OISINTの利用者として誤りに気づいた' },
  { value: 'other', label: 'その他', description: '上のどちらにも当てはまらない' },
];

const DEFAMATION_OPTIONS = [
  { value: 'no', label: '含まない' },
  {
    value: 'yes',
    label: '含む（優先して確認します）',
    description: '名誉毀損・信用毀損にあたるという主張を含む申立て',
  },
];

type CorrectionStatus = 'idle' | 'error' | 'opened' | 'copied' | 'unavailable';

export default function CorrectionScreen() {
  const { url } = useLocalSearchParams<{ url?: string }>();
  const { width } = useWindowDimensions();
  const isWide = width >= 780;
  const [requestType, setRequestType] = useState(REQUEST_TYPE_OPTIONS[0].value);
  const [standpoint, setStandpoint] = useState(STANDPOINT_OPTIONS[0].value);
  const [defamation, setDefamation] = useState(DEFAMATION_OPTIONS[0].value);
  const [targetUrl, setTargetUrl] = useState(typeof url === 'string' ? url : '');
  const [placeName, setPlaceName] = useState('');
  const [targetItem, setTargetItem] = useState('');
  const [correctInfo, setCorrectInfo] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<CorrectionStatus>('idle');

  const requiredFilled =
    Boolean(placeName.trim()) && Boolean(targetItem.trim()) && Boolean(correctInfo.trim());

  const handleSubmit = async () => {
    if (!requiredFilled) {
      setStatus('error');
      return;
    }
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) {
      setStatus('error');
      return;
    }

    const typeLabel =
      REQUEST_TYPE_OPTIONS.find((option) => option.value === requestType)?.label ?? '訂正';
    const standpointLabel =
      STANDPOINT_OPTIONS.find((option) => option.value === standpoint)?.label ?? 'その他';
    const includesDefamation = defamation === 'yes';

    const result = await handoffSupportMessage({
      kind: 'correction',
      subject: `[OISINT]${includesDefamation ? '【至急】' : ''} 情報の訂正・削除申立て / ${typeLabel}`,
      fields: [
        { label: '申立ての種類', value: typeLabel },
        { label: '申立人の立場', value: standpointLabel },
        { label: '対象URL（共有トークン）', value: targetUrl.trim() },
        { label: '店舗名', value: placeName.trim() },
        { label: '該当する判定または表示項目', value: targetItem.trim() },
        { label: '正しい情報（削除・異議の場合はその内容）', value: correctInfo.trim() },
        { label: '根拠URL', value: evidenceUrl.trim() },
        { label: '連絡先（メールアドレス）', value: email.trim() },
        {
          label: '名誉毀損・信用毀損の主張',
          value: includesDefamation ? '含む（至急対応を希望）' : '含まない',
        },
      ],
    });
    setStatus(result === 'opened' ? 'opened' : result === 'copied' ? 'copied' : 'unavailable');
  };

  const submitLabel = hasConfiguredSupportEmail ? 'メール作成画面を開く ↗' : '内容をコピーする';

  return (
    <View style={styles.wrapper}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={[styles.container, isWide && styles.containerWide]}>
          <SupportHeader current="correction" />

          <View style={styles.intro}>
            <Text style={styles.eyebrow}>CORRECTION REQUEST</Text>
            <Text style={styles.title}>この情報の訂正を、{'\n'}ここから依頼できます。</Text>
            <Text style={styles.copy}>
              OISINTが表示した判定（○△×?）や営業情報の誤りについて、店舗関係者・利用者のどちらからでも訂正・削除・異議申立てができます。確認が済むまで、該当の表示は暫定的に「?（確認中）」へ切り替える運用です。
            </Text>
          </View>

          <View style={[styles.formLayout, isWide && styles.formLayoutWide]}>
            <View testID="correction-form" style={styles.formCard}>
              <SupportChoiceGroup
                label="申立ての種類"
                options={REQUEST_TYPE_OPTIONS}
                value={requestType}
                onChange={setRequestType}
              />
              <SupportChoiceGroup
                label="申立人の立場"
                options={STANDPOINT_OPTIONS}
                value={standpoint}
                onChange={setStandpoint}
              />
              <SupportField
                testID="correction-target-url"
                label="対象URL（共有トークン）"
                hint="対象の画面のURL"
                value={targetUrl}
                onChangeText={setTargetUrl}
                placeholder="例：https://oisint.com/i/…"
              />
              <SupportField
                testID="correction-place-name"
                label="店舗名"
                hint="必須"
                value={placeName}
                onChangeText={(value) => {
                  setPlaceName(value);
                  if (status === 'error') setStatus('idle');
                }}
                placeholder="例：居酒屋◯◯ 池袋店"
              />
              <SupportField
                testID="correction-item"
                label="該当する判定または表示項目"
                hint="必須"
                value={targetItem}
                onChangeText={(value) => {
                  setTargetItem(value);
                  if (status === 'error') setStatus('idle');
                }}
                placeholder="例：「カード可」の×判定、営業時間の表示"
              />
              <SupportField
                testID="correction-correct-info"
                label="正しい情報"
                hint="必須。削除・異議の場合はその内容と理由"
                value={correctInfo}
                onChangeText={(value) => {
                  setCorrectInfo(value);
                  if (status === 'error') setStatus('idle');
                }}
                placeholder="例：クレジットカードは2026年から利用可能です"
                multiline
              />
              <SupportField
                testID="correction-evidence-url"
                label="根拠URL"
                hint="任意。公式サイトなど"
                value={evidenceUrl}
                onChangeText={setEvidenceUrl}
                placeholder="例：https://example.com/official"
              />
              <SupportField
                testID="correction-email"
                label="連絡先（メールアドレス）"
                hint="結果の回答が必要な場合"
                value={email}
                onChangeText={setEmail}
                placeholder="例：you@example.com"
                keyboardType="email-address"
              />
              <SupportChoiceGroup
                label="名誉毀損・信用毀損の主張"
                options={DEFAMATION_OPTIONS}
                value={defamation}
                onChange={setDefamation}
              />
              {status === 'error' ? (
                <SupportNotice tone="error">
                  店舗名・該当する判定または表示項目・正しい情報を入力し、メールアドレスを入力した場合は形式を確認してください。
                </SupportNotice>
              ) : null}
              {status === 'opened' ? (
                <SupportNotice tone="success">メール作成画面を開きました。内容を確認して送信してください。</SupportNotice>
              ) : null}
              {status === 'copied' ? (
                <SupportNotice tone="success">内容をコピーしました。サポート窓口のメールに貼り付けて送信してください。</SupportNotice>
              ) : null}
              {status === 'unavailable' ? (
                <SupportNotice tone="error">この環境ではメール作成やコピーを開けません。入力内容を選択して保存してください。</SupportNotice>
              ) : null}
              <SupportSubmitButton
                testID="correction-submit"
                label={submitLabel}
                disabled={!requiredFilled}
                onPress={() => void handleSubmit()}
              />
              <SupportPrivacyNote />
            </View>

            <View style={[styles.sideNote, isWide && styles.sideNoteWide]}>
              <Text style={styles.sideEyebrow}>WHAT HAPPENS NEXT</Text>
              <Text style={styles.sideTitle}>受領後の流れ</Text>
              <View style={styles.sideList}>
                <SideStep
                  number="01"
                  title="受領と暫定対応"
                  copy="内容を確認し、該当する判定・表示を暫定的に「?（確認中）」へ切り替えます"
                />
                <SideStep
                  number="02"
                  title="一次情報で確認"
                  copy="公式サイトや店舗への確認など、一次情報と照合します"
                />
                <SideStep
                  number="03"
                  title="反映と回答"
                  copy="確認結果を表示へ反映します。連絡先があれば結果を回答します"
                />
              </View>
              <View style={styles.sideCallout}>
                <Text style={styles.sideCalloutTitle}>一次対応の目安</Text>
                <Text style={styles.sideCalloutCopy}>
                  目安の営業日数は現在準備中です。確定し次第、この画面に明記します。名誉毀損・信用毀損の主張を含む申立ては、運営者へ直ちに引き継ぎ優先して確認します。
                </Text>
              </View>
            </View>
          </View>
        </View>
      </ScrollView>
      <Footer />
    </View>
  );
}

function SideStep({ number, title, copy }: { number: string; title: string; copy: string }) {
  return (
    <View style={styles.sideStep}>
      <Text style={styles.sideNumber}>{number}</Text>
      <View style={styles.sideStepBody}>
        <Text style={styles.sideStepTitle}>{title}</Text>
        <Text style={styles.sideStepCopy}>{copy}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 32,
  },
  container: {
    width: '100%',
    maxWidth: 980,
    alignSelf: 'center',
    gap: 24,
  },
  containerWide: {
    gap: 30,
  },
  intro: {
    maxWidth: 680,
    gap: 5,
  },
  eyebrow: {
    color: colors.orange,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.3,
    fontFamily: fonts.brand,
  },
  title: {
    color: colors.text,
    fontSize: 30,
    lineHeight: 41,
    fontWeight: '800',
    letterSpacing: -1.1,
  },
  copy: {
    marginTop: 6,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 20,
  },
  formLayout: {
    gap: 14,
  },
  formLayoutWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  formCard: {
    flex: 1,
    gap: 19,
    padding: 17,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  sideNote: {
    width: '100%',
    padding: 17,
    borderRadius: radius.lg,
    backgroundColor: colors.black,
  },
  sideNoteWide: {
    width: 280,
    flexShrink: 0,
  },
  sideEyebrow: {
    color: colors.amber,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
    fontFamily: fonts.brand,
  },
  sideTitle: {
    marginTop: 6,
    color: colors.surface,
    fontSize: 20,
    fontWeight: '800',
  },
  sideList: {
    gap: 12,
    marginTop: 22,
  },
  sideStep: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  sideNumber: {
    width: 24,
    color: colors.orange,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: fonts.brand,
  },
  sideStepBody: {
    flex: 1,
    gap: 2,
  },
  sideStepTitle: {
    color: colors.surface,
    fontSize: 11,
    fontWeight: '800',
  },
  sideStepCopy: {
    color: 'rgba(255, 255, 255, 0.58)',
    fontSize: 10,
    lineHeight: 16,
  },
  sideCallout: {
    marginTop: 24,
    paddingTop: 13,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.2)',
  },
  sideCalloutTitle: {
    color: colors.orangeSoft,
    fontSize: 11,
    fontWeight: '800',
  },
  sideCalloutCopy: {
    marginTop: 4,
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 10,
    lineHeight: 16,
  },
});
