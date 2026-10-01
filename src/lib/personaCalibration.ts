import { personaAccentColors } from '@/theme';
import type { TasteHealthGoal, TasteProfile } from '@/types';

export const TASTE_AXIS_IDS = [
  'evidence',
  'health',
  'quiet',
  'value',
  'novelty',
  'groupFit',
] as const;

export type TasteAxis = (typeof TASTE_AXIS_IDS)[number];
export type TasteScores = Record<TasteAxis, number>;
export type PersonaSource = 'interview' | 'hypothesis';

export interface PersonaScenario {
  id: string;
  name: string;
  descriptor: string;
  quote: string;
  situation: string;
  source: PersonaSource;
  sourceLabel: string;
  accent: string;
  tags: string[];
  seedScores: TasteScores;
  seedProfile: TasteProfile;
  searchExample: string;
}

export interface CalibrationOption {
  id: string;
  label: string;
  description: string;
  deltas: Partial<TasteScores>;
  likes?: string[];
  avoid?: string[];
  healthGoal?: TasteHealthGoal;
}

export interface CalibrationQuestion {
  id: string;
  prompt: string;
  note: string;
  options: CalibrationOption[];
}

export interface TasteTrait {
  axis: TasteAxis;
  label: string;
  score: number;
  explanation: string;
}

export interface PersonaCalibrationResult {
  persona: PersonaScenario;
  scores: TasteScores;
  topTraits: TasteTrait[];
  profile: TasteProfile;
  answerIds: Record<string, string>;
  completedAnswers: number;
  modelVersion: string;
}

export const PERSONA_MODEL_VERSION = 'scenario-calibration-v1';

export const TASTE_AXIS_META: Record<TasteAxis, { label: string; explanation: string }> = {
  evidence: {
    label: '根拠を確かめたい',
    explanation: '点数より、公式情報・更新日・複数ソースの一致を重視します。',
  },
  health: {
    label: '体調に合わせたい',
    explanation: '満腹感だけでなく、食後の負担や食事上の制約を守ります。',
  },
  quiet: {
    label: '落ち着いて過ごしたい',
    explanation: '会話のしやすさ、席の余白、滞在の落ち着きを優先します。',
  },
  value: {
    label: '納得できる価格にしたい',
    explanation: '安さだけでなく、目的に対して支払う価値があるかを見ます。',
  },
  novelty: {
    label: '知らない一軒に出会いたい',
    explanation: '定番だけに寄らず、ローカル店や新しい味を候補に残します。',
  },
  groupFit: {
    label: '全員が困らない店にしたい',
    explanation: '一人の満点より、参加者の条件をまとめた納得解を優先します。',
  },
};

export const PERSONA_SCENARIOS: PersonaScenario[] = [
  {
    id: 'tamura-health',
    name: '田村 修',
    descriptor: '50歳・健康を整えたい管理職',
    quote: '旨いものは諦めたくない。でも、食後に後悔する店は避けたい。',
    situation: '出張帰りに同僚と静かに食事。脂を控えつつ、質のよい日本酒を少し楽しみたい。',
    source: 'interview',
    sourceLabel: '既存デモヒアリング由来',
    accent: personaAccentColors.tamuraHealth,
    tags: ['脂控えめ', '静かな会話', '量より質'],
    seedScores: {
      evidence: 76,
      health: 92,
      quiet: 82,
      value: 54,
      novelty: 42,
      groupFit: 62,
    },
    seedProfile: {
      likes: ['和食', '野菜', '日本酒'],
      avoid: ['揚げ物', '騒がしい'],
      allergies: '',
      healthGoal: 'diet',
    },
    searchExample: '出張帰りに4人。脂っこくない和食で、静かに話せる店。予算5,000円。',
  },
  {
    id: 'eightman-decider',
    name: 'eightman',
    descriptor: '20代前半・情報系学生',
    quote: '店を探したいんじゃない。今の条件で、一番よさそうな答えが欲しい。',
    situation: '複数の出発地、予算、予約、決済、滞在時間をまとめて比較し、幹事として決め切りたい。',
    source: 'interview',
    sourceLabel: '既存デモヒアリング由来',
    accent: personaAccentColors.eightmanDecider,
    tags: ['情報統合', '町中華', '条件比較'],
    seedScores: {
      evidence: 94,
      health: 38,
      quiet: 48,
      value: 74,
      novelty: 70,
      groupFit: 88,
    },
    seedProfile: {
      likes: ['中華', '麺', '個人店'],
      avoid: ['根拠のない高評価'],
      allergies: '',
      healthGoal: 'none',
    },
    searchExample: '3人が集まりやすく、夜に予約できる鍋。予算5,000円、カード可、長居しやすい店。',
  },
  {
    id: 'family-safety',
    name: '家族の条件を守る人',
    descriptor: '制約を先に確認する家族幹事',
    quote: 'おすすめより先に、食べられないものと席の条件を確実にしたい。',
    situation: '子どもや家族と外食。アレルギー、禁煙、席、移動負担を一つずつ確認したい。',
    source: 'hypothesis',
    sourceLabel: '探索用の仮説シナリオ',
    accent: personaAccentColors.familySafety,
    tags: ['安全確認', '家族利用', '失敗回避'],
    seedScores: {
      evidence: 88,
      health: 78,
      quiet: 66,
      value: 64,
      novelty: 28,
      groupFit: 94,
    },
    seedProfile: {
      likes: ['野菜', '子連れOK'],
      avoid: ['喫煙', '混雑'],
      allergies: '',
      healthGoal: 'none',
    },
    searchExample: '家族4人。禁煙で席に余裕があり、食事制限を店に確認できる。駅から近い店。',
  },
  {
    id: 'local-explorer',
    name: '旅先の一軒を掘る人',
    descriptor: '名物より自分の舌を信じたい旅行者',
    quote: '観光地の定番ではなく、ここでしか食べられない一軒に出会いたい。',
    situation: '旅先でローカル店を探索。新しさは欲しいが、営業状況とアクセスは根拠で確かめたい。',
    source: 'hypothesis',
    sourceLabel: '探索用の仮説シナリオ',
    accent: personaAccentColors.localExplorer,
    tags: ['郷土料理', '個人店', '新しい味'],
    seedScores: {
      evidence: 70,
      health: 34,
      quiet: 46,
      value: 52,
      novelty: 96,
      groupFit: 44,
    },
    seedProfile: {
      likes: ['郷土料理', '個人店', '季節料理'],
      avoid: ['観光客向けチェーン'],
      allergies: '',
      healthGoal: 'none',
    },
    searchExample: '旅先で、その土地らしい夕食。観光客向けではなく、今夜営業している個人店。',
  },
];

export const CALIBRATION_QUESTIONS: CalibrationQuestion[] = [
  {
    id: 'protect',
    prompt: '今日の外食で、最初に守りたいものは？',
    note: '「理想」ではなく、店を外すときの基準で選んでください。',
    options: [
      {
        id: 'body',
        label: '食後の体調',
        description: '脂・量・食事制限を先に見る',
        deltas: { health: 22, evidence: 6 },
        likes: ['野菜', '和食'],
        avoid: ['揚げ物'],
        healthGoal: 'diet',
      },
      {
        id: 'group',
        label: '一緒に行く人',
        description: '全員の条件が大きく外れないこと',
        deltas: { groupFit: 22, evidence: 5 },
      },
      {
        id: 'budget',
        label: '予算の納得感',
        description: '目的に対して払いすぎないこと',
        deltas: { value: 22, groupFit: 3 },
        avoid: ['高価格'],
      },
      {
        id: 'discovery',
        label: '新しい発見',
        description: 'いつもの候補から少し外れること',
        deltas: { novelty: 22, value: -3 },
        likes: ['個人店', '季節料理'],
      },
    ],
  },
  {
    id: 'trust',
    prompt: '初めての店を、何で信用しますか？',
    note: '星の数ではなく、最後に背中を押す情報を選びます。',
    options: [
      {
        id: 'official',
        label: '公式情報と更新日',
        description: '営業時間・メニュー・予約条件を確認',
        deltas: { evidence: 22 },
      },
      {
        id: 'recent-reviews',
        label: '最近の具体的な口コミ',
        description: '件数より、状況が自分と近い投稿',
        deltas: { evidence: 12, novelty: 5 },
      },
      {
        id: 'known-person',
        label: '好みが近い人の実体験',
        description: '自分と似た選び方をする人を参考にする',
        deltas: { groupFit: 10, novelty: 8 },
      },
      {
        id: 'intuition',
        label: '写真と直感',
        description: '雰囲気が合えば、まず試してみる',
        deltas: { novelty: 18, evidence: -8 },
      },
    ],
  },
  {
    id: 'atmosphere',
    prompt: '同じ料理なら、どの空間を選びますか？',
    note: '誰と行くかは、今回いちばん多い場面を想像してください。',
    options: [
      {
        id: 'calm',
        label: '静かで余白がある',
        description: '会話しやすく、急かされない',
        deltas: { quiet: 22, health: 3 },
        avoid: ['騒がしい'],
      },
      {
        id: 'lively',
        label: 'にぎやかで活気がある',
        description: '多少の音より、場の楽しさ',
        deltas: { quiet: -14, groupFit: 8 },
      },
      {
        id: 'compact',
        label: '短時間で使いやすい',
        description: '席より立地と回転のよさ',
        deltas: { value: 12, quiet: -4 },
      },
      {
        id: 'character',
        label: '店主や土地の個性がある',
        description: '整いすぎていなくても記憶に残る',
        deltas: { novelty: 18, evidence: 2 },
        likes: ['個人店'],
      },
    ],
  },
  {
    id: 'tradeoff',
    prompt: '条件が全部そろわないとき、何を残しますか？',
    note: 'ここが、あなたの店選びで一番強い重みになります。',
    options: [
      {
        id: 'certainty',
        label: '失敗しない根拠',
        description: '少し無難でも、確認できる店',
        deltas: { evidence: 18, novelty: -7 },
      },
      {
        id: 'special',
        label: 'その店ならではの魅力',
        description: '多少の不明があっても試したい',
        deltas: { novelty: 20, evidence: -4 },
      },
      {
        id: 'price',
        label: '価格とアクセス',
        description: '全員が無理なく使えること',
        deltas: { value: 18, groupFit: 10 },
      },
      {
        id: 'conversation',
        label: '一緒に過ごす時間',
        description: '料理より、会話と滞在のしやすさ',
        deltas: { quiet: 14, groupFit: 18 },
      },
    ],
  },
];

export function getPersonaScenario(id: string | null | undefined): PersonaScenario | undefined {
  return PERSONA_SCENARIOS.find((persona) => persona.id === id);
}

export function calibratePersona(
  personaId: string,
  answerIds: Record<string, string>,
): PersonaCalibrationResult {
  const persona = getPersonaScenario(personaId);
  if (!persona) throw new Error('選択されたシナリオが見つかりません');

  const scores = Object.fromEntries(
    TASTE_AXIS_IDS.map((axis) => [axis, 50 + (persona.seedScores[axis] - 50) * 0.25]),
  ) as TasteScores;
  const likes = [...persona.seedProfile.likes];
  const avoid = [...persona.seedProfile.avoid];
  // A scenario may suggest foods, but it must not assign a health objective.
  // Health state is retained only when the person explicitly chooses it below.
  let healthGoal: TasteHealthGoal = 'none';
  let completedAnswers = 0;

  for (const question of CALIBRATION_QUESTIONS) {
    const optionId = answerIds[question.id];
    const option = question.options.find((candidate) => candidate.id === optionId);
    if (!option) continue;
    completedAnswers += 1;

    for (const axis of TASTE_AXIS_IDS) {
      scores[axis] = clampScore(scores[axis] + (option.deltas[axis] ?? 0));
    }
    likes.push(...(option.likes ?? []));
    avoid.push(...(option.avoid ?? []));
    if (option.healthGoal) healthGoal = option.healthGoal;
  }

  const topTraits = TASTE_AXIS_IDS
    .map((axis) => ({
      axis,
      label: TASTE_AXIS_META[axis].label,
      explanation: TASTE_AXIS_META[axis].explanation,
      score: Math.round(scores[axis]),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);

  return {
    persona,
    scores: mapScores(scores, (score) => Math.round(score)),
    topTraits,
    profile: {
      likes: uniqueStrings(likes),
      avoid: uniqueStrings(avoid),
      allergies: persona.seedProfile.allergies,
      healthGoal,
    },
    answerIds: { ...answerIds },
    completedAnswers,
    modelVersion: PERSONA_MODEL_VERSION,
  };
}

function mapScores(scores: TasteScores, mapper: (score: number) => number): TasteScores {
  return Object.fromEntries(
    TASTE_AXIS_IDS.map((axis) => [axis, mapper(scores[axis])]),
  ) as TasteScores;
}

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
