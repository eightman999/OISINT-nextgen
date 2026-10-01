import { router } from 'expo-router';
import { useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { Footer } from '@/components/Footer';
import {
  SupportChoiceGroup,
  SupportField,
  SupportNotice,
  SupportPrivacyNote,
  SupportSubmitButton,
} from '@/components/SupportFormFields';
import { SupportHeader } from '@/components/SupportHeader';
import { SUPPORT_ISSUES_URL, hasConfiguredSupportEmail, handoffSupportMessage } from '@/lib/support';
import { colors, fonts, radius } from '@/theme';

const CONTACT_OPTIONS = [
  { value: 'how-to', label: '使い方について', description: '画面の操作や機能を知りたい' },
  { value: 'bug', label: '不具合を報告', description: '表示・操作・共有がうまくいかない' },
  { value: 'account', label: '共有・参加について', description: '招待URLやメンバーのことで困っている' },
  { value: 'other', label: 'その他', description: '上のどれにも当てはまらない相談' },
];

type ContactStatus = 'idle' | 'error' | 'opened' | 'copied' | 'unavailable';

export default function ContactScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 780;
  const [category, setCategory] = useState(CONTACT_OPTIONS[0].value);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<ContactStatus>('idle');

  const handleSubmit = async () => {
    if (!message.trim()) {
      setStatus('error');
      return;
    }
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) {
      setStatus('error');
      return;
    }

    const selected = CONTACT_OPTIONS.find((option) => option.value === category);
    const result = await handoffSupportMessage({
      kind: 'contact',
      subject: `[OISINT] お問い合わせ / ${selected?.label ?? 'その他'}`,
      fields: [
        { label: '相談の種類', value: selected?.label ?? 'その他' },
        { label: 'お名前', value: name.trim() },
        { label: '返信先メールアドレス', value: email.trim() },
        { label: 'お問い合わせ内容', value: message.trim() },
      ],
    });
    setStatus(result === 'opened' ? 'opened' : result === 'copied' ? 'copied' : 'unavailable');
  };

  const submitLabel = hasConfiguredSupportEmail ? 'メール作成画面を開く ↗' : '内容をコピーする';

  return (
    <View style={styles.wrapper}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={[styles.container, isWide && styles.containerWide]}>
          <SupportHeader current="contact" />

          <View style={styles.intro}>
            <Text style={styles.eyebrow}>お問い合わせ窓口</Text>
            <Text style={styles.title}>状況を整理して、{ '\n' }お問い合わせください。</Text>
            <Text style={styles.copy}>
              何が起きたか、どの画面で困ったかを書いてください。返信が必要な場合だけ、メールアドレスを入力します。
            </Text>
            {/* #267: 店舗情報の誤りは専用フォームへ。フッター→お問い合わせ→訂正依頼の2クリック導線 */}
            <Pressable
              testID="contact-correction-link"
              accessibilityRole="link"
              accessibilityLabel="この情報の訂正を依頼する（訂正・削除・異議申立てフォームを開く）"
              onPress={() => router.push('/correction' as never)}
              style={styles.correctionCallout}
            >
              <Text style={styles.correctionCalloutTitle}>店舗情報の誤り（判定・営業情報）ですか？</Text>
              <Text style={styles.correctionCalloutLink}>この情報の訂正を依頼する ↗</Text>
            </Pressable>
          </View>

          <View style={[styles.formLayout, isWide && styles.formLayoutWide]}>
            <View style={styles.formCard}>
              <SupportChoiceGroup
                label="相談の種類"
                options={CONTACT_OPTIONS}
                value={category}
                onChange={setCategory}
              />
              <SupportField
                testID="contact-name"
                label="お名前"
                hint="任意"
                value={name}
                onChangeText={setName}
                placeholder="例：山田 花子"
              />
              <SupportField
                testID="contact-email"
                label="返信先メールアドレス"
                hint="返信が必要な場合のみ"
                value={email}
                onChangeText={setEmail}
                placeholder="例：you@example.com"
                keyboardType="email-address"
              />
              <SupportField
                testID="contact-message"
                label="お問い合わせ内容"
                hint="必須"
                value={message}
                onChangeText={(value) => {
                  setMessage(value);
                  if (status === 'error') setStatus('idle');
                }}
                placeholder="どの画面で、何をしようとして、どうなったかを書いてください"
                multiline
              />
              {status === 'error' ? (
                <SupportNotice tone="error">
                  お問い合わせ内容を入力し、メールアドレスを入力した場合は形式を確認してください。
                </SupportNotice>
              ) : null}
              {status === 'opened' ? (
                <SupportNotice tone="success">メール作成画面を開きました。内容を確認して送信してください。</SupportNotice>
              ) : null}
              {status === 'copied' ? (
                <View style={styles.copiedGuide}>
                  <SupportNotice tone="success">内容をコピーしました。まだ送信はされていません。GitHubのIssuesページに貼り付けて報告してください。</SupportNotice>
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="OISINTのGitHub Issuesページを開く"
                    onPress={() => {
                      Linking.openURL(SUPPORT_ISSUES_URL).catch(() => {});
                    }}
                    style={styles.issuesLink}
                  >
                    <Text style={styles.issuesLinkText}>GitHub Issues を開く ↗</Text>
                  </Pressable>
                </View>
              ) : null}
              {status === 'unavailable' ? (
                <SupportNotice tone="error">この環境ではメール作成やコピーを開けません。入力内容を選択して保存してください。</SupportNotice>
              ) : null}
              <SupportSubmitButton
                testID="contact-submit"
                label={submitLabel}
                disabled={!message.trim()}
                onPress={() => void handleSubmit()}
              />
              <SupportPrivacyNote />
            </View>

            <View style={[styles.sideNote, isWide && styles.sideNoteWide]}>
              <Text style={styles.sideEyebrow}>解決のヒント</Text>
              <Text style={styles.sideTitle}>早く解決するために</Text>
              <View style={styles.sideList}>
                <SideTip number="01" title="画面の名前" copy="例：候補一覧、共有画面、場所選択" />
                <SideTip number="02" title="再現手順" copy="どのボタンを押したか、順番に" />
                <SideTip number="03" title="表示された文言" copy="エラーや案内をそのまま" />
              </View>
              <View style={styles.sideCallout}>
                <Text style={styles.sideCalloutTitle}>スクリーンショットも歓迎</Text>
                <Text style={styles.sideCalloutCopy}>
                  {hasConfiguredSupportEmail
                    ? '個人情報が写っていないことを確認して、メールに添付してください。'
                    : '個人情報が写っていないことを確認して、GitHubのIssueに添付してください。'}
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

function SideTip({ number, title, copy }: { number: string; title: string; copy: string }) {
  return (
    <View style={styles.sideTip}>
      <Text style={styles.sideNumber}>{number}</Text>
      <View style={styles.sideTipBody}>
        <Text style={styles.sideTipTitle}>{title}</Text>
        <Text style={styles.sideTipCopy}>{copy}</Text>
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
  correctionCallout: {
    marginTop: 10,
    gap: 2,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
    alignSelf: 'flex-start',
  },
  correctionCalloutTitle: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  correctionCalloutLink: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '700',
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
  copiedGuide: {
    gap: 8,
  },
  issuesLink: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  issuesLinkText: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
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
  sideTip: {
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
  sideTipBody: {
    flex: 1,
    gap: 2,
  },
  sideTipTitle: {
    color: colors.surface,
    fontSize: 11,
    fontWeight: '800',
  },
  sideTipCopy: {
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
