// place_facts（supabase/migrations/0007_p1_accumulation.sql / spec.md §44.5）の表示判定と整形。
// 候補詳細の Evidence 表示に「複数調査を跨いだ確度・矛盾フラグ」を反映するための純ロジック（issue #333）。
// place_facts が無い/薄いキーはここで弾かれ、既存の Evidence ベース表示のみにフォールバックする。
import type { PlaceFact } from '@/types';

// 「薄い」判定のしきい値: 矛盾が無く、裏取り Evidence が 1 件以下の fact は
// 単一 Evidence の再掲にしかならないため表示しない（既存 Evidence 表示へフォールバック）。
export const MIN_DISPLAY_EVIDENCE_COUNT = 2;

// 表示してよい fact か。confidence の値域外（0..1 の外 / 非数）は clamp せず
// 表示しない（§30 と同方針: unknown を捏造で埋めない）。
// conflicting=true は件数に関わらず警告として表示する（§15: 矛盾を潰さない）。
export function isDisplayableFact(fact: PlaceFact): boolean {
  const validConfidence =
    Number.isFinite(fact.confidence) && fact.confidence >= 0 && fact.confidence <= 1;
  if (!validConfidence) return false;
  if (fact.conflicting) return true;
  return fact.evidenceCount >= MIN_DISPLAY_EVIDENCE_COUNT;
}

// 表示対象の選別と並び順（決定論）: 矛盾ありを先頭に、以降は key 昇順。
export function selectDisplayFacts(facts: PlaceFact[]): PlaceFact[] {
  return facts.filter(isDisplayableFact).sort((a, b) => {
    if (a.conflicting !== b.conflicting) return a.conflicting ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

// ClaimKey（§13）+ feedback 由来キー（0007 submit_place_feedback）の日本語ラベル。
// 未知キーは推測で訳さず key をそのまま出す。
const FACT_KEY_LABELS: Record<string, string> = {
  opening_hours: '営業時間',
  closed_days: '定休日',
  budget_dinner: '夜の予算',
  card_accepted: 'カード利用',
  reservation: '予約',
  private_room: '個室',
  capacity: '席数',
  genre: 'ジャンル',
  noise_level: '静かさ',
  time_limit: '時間制限',
  non_smoking: '禁煙',
  wifi_available: 'Wi-Fi',
  child_friendly: '子連れ対応',
  nearest_station_walk_minutes: '最寄り駅から徒歩',
  category: 'カテゴリ',
  price_range: '料金帯',
  amenities: '設備',
  'lodging.room_type': '客室タイプ',
  'lodging.check_in_time': 'チェックイン',
  'lodging.check_out_time': 'チェックアウト',
  'rental_space.equipment': 'レンタル設備',
  space_comfort: '席の快適さ',
  value_for_money: 'コスパ',
  service_quality: '接客',
};

export function factKeyLabel(key: string): string {
  return FACT_KEY_LABELS[key] ?? key;
}

// 来店後フィードバック集計値（spec.md §44.5 'quiet' | 'loud' 等）の既知トークンのみ訳す。
const FEEDBACK_VALUE_LABELS: Record<string, string> = {
  quiet: '静か',
  loud: 'にぎやか',
};

// place_facts.value（jsonb）の控えめな整形。未知の形は JSON 文字列のまま出し、捏造しない。
export function formatFactValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '不明';
  if (typeof value === 'boolean') return value ? 'あり' : 'なし';
  if (typeof value === 'number') {
    if (key === 'capacity') return `${value}席`;
    if (key === 'nearest_station_walk_minutes') return `${value}分`;
    return String(value);
  }
  if (typeof value === 'string') return FEEDBACK_VALUE_LABELS[value] ?? value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.min === 'number' && typeof record.max === 'number') {
      const range =
        record.min === record.max ? `${record.min}` : `${record.min}〜${record.max}`;
      return key === 'budget_dinner' ? `${range}円` : range;
    }
    // 来店後フィードバック集計値 {value, count, share}（0007 submit_place_feedback）
    if (typeof record.value === 'string') {
      return FEEDBACK_VALUE_LABELS[record.value] ?? record.value;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
