// デザイン仕様 (docs/design/OISINT_UI_HTML_CSS_design_spec.md) のカラーパレット
import { Platform } from 'react-native';

export const colors = {
  bg: '#f1ece2',
  canvas: '#fbf8f1',
  surface: '#fffdf8',
  surfaceSoft: '#e9e1d4',
  surfaceQuiet: '#fcfbf8',
  surfaceDisabled: '#f1f1f1',
  // 純白 / 純黒。colors.surface（#fffdf8）/ colors.black（#1d2923 の墨色）とは意味が違うため別名で持つ。
  // white は ActivityIndicator や色付き背景上の前景、pureBlack は QR コードの暗モジュール用（#219）。
  white: '#ffffff',
  pureBlack: '#000000',

  text: '#1d2923',
  textSecondary: '#4f5c55',
  textTertiary: '#59655e',
  textOnColorDark: '#101713',
  placeholder: '#9ca3af',

  border: '#d4c9b8',
  borderSoft: '#e5dbcd',

  black: '#1d2923',
  blackHover: '#33463b',

  orange: '#b23915',
  orangeHover: '#922d10',
  orangeSoft: '#ffb19a',
  // orange 枠線と組むピル状チップの淡背景（ログイン済み表示・トップ導線）。orangeSoft より淡い（#219）
  orangeFaint: '#fff5f0',
  amber: '#c9953b',
  red: '#c9574d',

  success: '#2c9a66',
  successSoft: '#e8f5ee',
  warning: '#8a5700',
  warningSoft: '#fff3d9',
  danger: '#e14d4d',
  dangerSoft: '#fdeaea',
  // infoSoft上のリンク・補助文言がWCAG AA 4.5:1を満たす濃度。
  info: '#1d5fa8',
  infoSoft: '#eef5fb',
  googleBlue: '#4285f4',
  googleSoft: '#f1f5fb',
  importSoft: '#f4f8fc',
  hearingSoft: '#f3f8fc',

  chipBg: '#faf5ec',
  sidebarBg: '#f4ede1',
  activeBg: '#fce9dc',
} as const;

export const tagColors = {
  green: { color: '#277c56', background: '#e6f4ed' },
  blue: { color: '#1c727b', background: '#e5f4f6' },
  orange: { color: '#b23915', background: '#fff0e6' },
  red: { color: '#bd3030', background: '#fde9e9' },
} as const;

export const sceneColors = {
  company: { accent: colors.orange, soft: colors.activeBg },
  omotenashi: { accent: '#49655d', soft: '#edf3ef' },
  travel: { accent: colors.warning, soft: colors.warningSoft },
} as const;

// 機能別パレット（#219）。コンポーネント側で色リテラルを発明しないための置き場。
// 名前はその機能での役割を表し、値の変更はテーマ側の判断で行う。

// 候補カード / 候補詳細の Evidence 補助テキスト
export const evidenceColors = {
  summary: '#555d63',
  positive: '#39765c',
  price: '#4e555b',
} as const;

// ヘルプ画面（app/help.tsx）と挿絵（HelpScreenshot）
export const guideColors = {
  decision: '#7aa5a8',
  participant: '#6c9da1',
  evidenceBorder: '#ffd8c8',
  faqBorder: '#f9b098',
  faqSurface: '#fffaf7',
  faqRule: '#ffe2d7',
  closingSurface: '#fff0e8',
  resultPrimary: '#d87945',
  resultSecondary: '#b76859',
  resultUnknown: '#7899a0',
} as const;

// サポート系フォーム（support / SupportFormFields）
export const supportColors = {
  replyAccent: '#6b9da0',
  errorBorder: '#f4b2b2',
  successBorder: '#b7e0c8',
} as const;

// DEMO・アカウント画面の濃色パネル
export const darkPanelColors = {
  lead: '#b8c1bb',
  border: '#415047',
  count: '#8fa097',
  muted: '#9eaaa2',
  label: '#c6cec9',
  controlBorder: '#536158',
  controlMark: '#809087',
  struck: '#8d9991',
  success: '#78d4a8',
  actionBorder: '#708078',
  body: '#aeb9b2',
  bodyMuted: '#819087',
  accountActionBorder: '#6e7d75',
} as const;

// 参加者アバターの識別色（MemberList）
export const memberAvatarColors = [
  '#f4a000',
  '#f4511e',
  colors.success,
  colors.info,
  '#83abb2',
] as const;

// ペルソナ較正シナリオのアクセント（src/lib/personaCalibration.ts）
export const personaAccentColors = {
  tamuraHealth: colors.success,
  eightmanDecider: colors.info,
  familySafety: colors.amber,
  localExplorer: '#9a5d32',
} as const;

export const rankColors = ['#d99a00', '#ef3e3e', '#ef5a18', '#83abb2', '#e2a65e'] as const;

function relativeLuminance(hexColor: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hexColor);
  if (!match) throw new Error(`6桁のHEXカラーが必要です: ${hexColor}`);

  const value = match[1];
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function readableTextColor(background: string): string {
  return contrastRatio(colors.textOnColorDark, background) >=
    contrastRatio(colors.surface, background)
    ? colors.textOnColorDark
    : colors.surface;
}

export function rankColor(rank: number): string {
  return rankColors[Math.min(Math.max(rank, 1), rankColors.length) - 1];
}

export const radius = {
  xs: 6,
  sm: 9,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

// design.html: .logo / .rank-badge / .match 等は Manrope（Web のみ適用）
export const fonts = {
  brand: Platform.OS === 'web' ? 'Manrope, "Noto Sans JP", sans-serif' : undefined,
  ui: Platform.OS === 'web' ? '"Noto Sans JP", system-ui, sans-serif' : undefined,
} as const;

// design.html: .food-cell / .restaurant-image のジャンル別カラー（gradient の第1色を採用）
const genreColorMap: [string, string][] = [
  ['ラーメン', '#f6a636'],
  ['つけ麺', '#f6a636'],
  ['バーガー', '#c77947'],
  ['アメリカン', '#c77947'],
  ['寿司', '#e84c4c'],
  ['カフェ', '#d4b996'],
  ['パンケーキ', '#d4b996'],
  ['ピザ', '#f4c430'],
  ['イタリアン', '#f4c430'],
  ['居酒屋', '#7cb0b5'],
  ['焼鳥', '#7cb0b5'],
  ['焼肉', '#b94d4d'],
  ['ステーキ', '#b94d4d'],
  ['ファミレス', '#7cb87c'],
  ['定食', '#6c9bd1'],
  ['フレンチ', '#2a2a2a'],
];

export function genreColor(genre?: string): string {
  if (genre) {
    for (const [key, color] of genreColorMap) {
      if (genre.includes(key)) return color;
    }
  }
  return '#83abb2';
}
