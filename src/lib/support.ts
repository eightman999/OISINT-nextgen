import { Linking } from 'react-native';

export type SupportHandoffResult = 'opened' | 'copied' | 'unavailable';

// correction は誤情報の訂正・削除申立て（#267）。contact / feedback と同じ mailto 下書き / コピー方式で送る。
export type SupportMessageKind = 'contact' | 'feedback' | 'correction';

const SUPPORT_KIND_LABELS: Record<SupportMessageKind, string> = {
  contact: 'お問い合わせ',
  feedback: 'フィードバック',
  correction: '情報の訂正・削除申立て',
};

export interface SupportMessage {
  kind: SupportMessageKind;
  subject: string;
  fields: { label: string; value: string }[];
}

export const hasConfiguredSupportEmail = Boolean(process.env.EXPO_PUBLIC_SUPPORT_EMAIL?.trim());

// 設定済みのメール窓口。未設定ビルドでは null（サポート画面での受付先表示に使う）。
export const configuredSupportEmail = process.env.EXPO_PUBLIC_SUPPORT_EMAIL?.trim() || null;

// メール窓口（EXPO_PUBLIC_SUPPORT_EMAIL）が未設定のビルドで実在する受付先（#338 / #331）。
// コピーした内容はこの Issues ページへ貼り付けて報告してもらう。
export const SUPPORT_ISSUES_URL = 'https://github.com/eightman999/OISINT/issues';

export function supportMessageBody(message: SupportMessage): string {
  return [
    `OISINT ${SUPPORT_KIND_LABELS[message.kind]}`,
    '',
    ...message.fields.flatMap(({ label, value }) => [`【${label}】`, value || '（未入力）', '']),
    '---',
    'この内容はOISINTのサポート画面から作成されました。',
  ].join('\n');
}

export async function handoffSupportMessage(
  message: SupportMessage
): Promise<SupportHandoffResult> {
  const body = supportMessageBody(message);
  const supportEmail = process.env.EXPO_PUBLIC_SUPPORT_EMAIL?.trim();

  if (supportEmail) {
    const mailto = `mailto:${supportEmail}?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(body)}`;
    try {
      await Linking.openURL(mailto);
      return 'opened';
    } catch {
      // メールアプリがない環境では、下のコピー経路へフォールバックする。
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(body);
      return 'copied';
    } catch {
      return 'unavailable';
    }
  }

  return 'unavailable';
}
