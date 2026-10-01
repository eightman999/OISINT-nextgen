import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { Footer } from '@/components/Footer';
import {
  CALIBRATION_QUESTIONS,
  PERSONA_SCENARIOS,
  TASTE_AXIS_IDS,
  calibratePersona,
  getPersonaScenario,
  type PersonaScenario,
  type TasteAxis,
} from '@/lib/personaCalibration';
import { clearLocalPersonalization, saveCalibrationLocally } from '@/lib/personalization';
import { useAuth } from '@/providers/AuthProvider';
import { colors, darkPanelColors, fonts, radius } from '@/theme';

const BRAND_LOGO = require('../assets/branding/oisint-logo-horizontal-transparent.png');

type DemoStage = 'choose' | 'questions' | 'result';

const AXIS_SHORT_LABELS: Record<TasteAxis, string> = {
  evidence: '根拠',
  health: '体調',
  quiet: '静けさ',
  value: '価格',
  novelty: '発見',
  groupFit: '全員適合',
};

export default function DemoScreen() {
  const { userId, isAnonymous } = useAuth();
  const { width } = useWindowDimensions();
  const isWide = width >= 900;
  const [stage, setStage] = useState<DemoStage>('choose');
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answerIds, setAnswerIds] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [persistedByDemo, setPersistedByDemo] = useState(false);
  const [includedLikes, setIncludedLikes] = useState<string[]>([]);
  const [includedAvoid, setIncludedAvoid] = useState<string[]>([]);

  const selectedPersona = getPersonaScenario(selectedPersonaId);
  const currentQuestion = CALIBRATION_QUESTIONS[questionIndex];
  const selectedOptionId = currentQuestion ? answerIds[currentQuestion.id] : undefined;
  const result = useMemo(
    () =>
      selectedPersonaId && stage === 'result'
        ? calibratePersona(selectedPersonaId, answerIds)
        : null,
    [answerIds, selectedPersonaId, stage],
  );
  const editableResult = useMemo(() => {
    if (!result) return null;
    const selectedLikes = new Set(includedLikes);
    const selectedAvoid = new Set(includedAvoid);
    return {
      ...result,
      profile: {
        ...result.profile,
        likes: result.profile.likes.filter((tag) => selectedLikes.has(tag)),
        avoid: result.profile.avoid.filter((tag) => selectedAvoid.has(tag)),
      },
    };
  }, [includedAvoid, includedLikes, result]);
  const personalizationSubject = userId
    ? { id: userId, kind: isAnonymous ? ('anonymous' as const) : ('permanent' as const) }
    : undefined;

  const beginQuestions = () => {
    if (!selectedPersonaId) return;
    setAnswerIds({});
    setQuestionIndex(0);
    setSaved(false);
    setPersistedByDemo(false);
    setIncludedLikes([]);
    setIncludedAvoid([]);
    setStage('questions');
  };

  const chooseAnswer = (optionId: string) => {
    if (!currentQuestion) return;
    setAnswerIds((current) => ({ ...current, [currentQuestion.id]: optionId }));
  };

  const continueQuestions = () => {
    if (!currentQuestion || !selectedOptionId) return;
    if (questionIndex === CALIBRATION_QUESTIONS.length - 1) {
      if (!selectedPersonaId) return;
      const nextResult = calibratePersona(selectedPersonaId, answerIds);
      setIncludedLikes(nextResult.profile.likes);
      setIncludedAvoid(nextResult.profile.avoid);
      setStage('result');
      return;
    }
    setQuestionIndex((current) => current + 1);
  };

  const goBack = () => {
    if (questionIndex === 0) {
      setStage('choose');
      return;
    }
    setQuestionIndex((current) => current - 1);
  };

  const saveResult = () => {
    if (!editableResult) return;
    saveCalibrationLocally(editableResult, personalizationSubject);
    setSaved(true);
    setPersistedByDemo(true);
  };

  const searchWithResult = () => {
    if (!editableResult) return;
    saveCalibrationLocally(editableResult, personalizationSubject);
    setPersistedByDemo(true);
    router.push('/' as never);
  };

  const toggleResultTag = (kind: 'likes' | 'avoid', tag: string) => {
    const update = kind === 'likes' ? setIncludedLikes : setIncludedAvoid;
    update((current) =>
      current.includes(tag)
        ? current.filter((candidate) => candidate !== tag)
        : [...current, tag],
    );
    setSaved(false);
  };

  const reviewAnswers = () => {
    setQuestionIndex(0);
    setSaved(false);
    setStage('questions');
  };

  const discardResult = () => {
    if (persistedByDemo) clearLocalPersonalization(personalizationSubject);
    resetDemo();
  };

  const resetDemo = () => {
    setStage('choose');
    setSelectedPersonaId(null);
    setQuestionIndex(0);
    setAnswerIds({});
    setSaved(false);
    setPersistedByDemo(false);
    setIncludedLikes([]);
    setIncludedAvoid([]);
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        testID="demo-page"
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.shell}>
          <DemoHeader isWide={isWide} onReset={resetDemo} />

          {stage === 'choose' ? (
            <ChooseScenario
              isWide={isWide}
              selectedPersona={selectedPersona}
              onSelect={setSelectedPersonaId}
              onContinue={beginQuestions}
            />
          ) : null}

          {stage === 'questions' && selectedPersona && currentQuestion ? (
            <QuestionStage
              isWide={isWide}
              persona={selectedPersona}
              questionIndex={questionIndex}
              selectedOptionId={selectedOptionId}
              onChoose={chooseAnswer}
              onBack={goBack}
              onContinue={continueQuestions}
            />
          ) : null}

          {stage === 'result' && result && editableResult ? (
            <ResultStage
              isWide={isWide}
              result={editableResult}
              availableLikes={result.profile.likes}
              availableAvoid={result.profile.avoid}
              includedLikes={includedLikes}
              includedAvoid={includedAvoid}
              saved={saved}
              persistedByDemo={persistedByDemo}
              onSave={saveResult}
              onSearch={searchWithResult}
              onReview={reviewAnswers}
              onDiscard={discardResult}
              onRestart={resetDemo}
              onToggleTag={toggleResultTag}
            />
          ) : null}
        </View>
        <Footer />
      </ScrollView>
    </View>
  );
}

function DemoHeader({ isWide, onReset }: { isWide: boolean; onReset: () => void }) {
  const { isAuthenticated, displayName, email } = useAuth();

  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="デモの最初に戻る"
        onPress={onReset}
        style={styles.brandButton}
      >
        <View style={styles.logoPlate}>
          <Image
            source={BRAND_LOGO}
            resizeMode="contain"
            style={[styles.logo, !isWide && styles.logoCompact]}
          />
        </View>
        <View style={styles.demoBadge}>
          <Text style={styles.demoBadgeText}>PUBLIC DEMO</Text>
        </View>
      </Pressable>
      <View style={styles.headerActions}>
        {isWide ? <Text style={styles.localOnly}>回答はこの端末だけ</Text> : null}
        <Pressable
          testID="demo-login-link"
          accessibilityRole="button"
          accessibilityLabel={
            isAuthenticated
              ? `アカウント画面を開く（${displayName || email || 'ログイン中'}）`
              : 'ログイン画面を開く'
          }
          onPress={() => router.push('/account' as never)}
          style={[styles.loginButton, isAuthenticated && styles.loginButtonAuthenticated]}
        >
          {isAuthenticated ? (
            <View style={styles.connectedDot} />
          ) : null}
          <Text
            style={[styles.loginButtonText, isAuthenticated && styles.loginButtonTextAuthenticated]}
            numberOfLines={1}
          >
            {isAuthenticated ? (displayName || email?.split('@')[0] || 'アカウント') : 'ログイン'}
          </Text>
          <Text style={[styles.loginArrow, isAuthenticated && styles.loginArrowAuthenticated]}>↗</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ChooseScenario({
  isWide,
  selectedPersona,
  onSelect,
  onContinue,
}: {
  isWide: boolean;
  selectedPersona: PersonaScenario | undefined;
  onSelect: (personaId: string) => void;
  onContinue: () => void;
}) {
  return (
    <View>
      <View style={[styles.hero, isWide && styles.heroWide]}>
        <View style={styles.heroCopy}>
          <View style={styles.eyebrowRow}>
            <Text style={styles.eyebrow}>TASTE CALIBRATION / 01</Text>
            <View style={styles.eyebrowRule} />
          </View>
          <Text testID="demo-title" style={[styles.heroTitle, !isWide && styles.heroTitleCompact]}>
            {isWide
              ? '似た人を試すと、\n自分の好みが見えてくる。'
              : '似た人を試すと、\n自分の好みが\n見えてくる。'}
          </Text>
          <Text style={styles.heroLead}>
            年齢や肩書きであなたを決めるテストではありません。近い場面を入口にして、4つの選択から「店選びで何を守る人か」を見つけます。
          </Text>
          <View style={styles.heroFacts}>
            <HeroFact number="04" label="シナリオ" />
            <View style={styles.factDivider} />
            <HeroFact number="04" label="質問" />
            <View style={styles.factDivider} />
            <HeroFact number="約2分" label="所要時間" />
          </View>
        </View>

        <View style={styles.mapPreview}>
          <View style={styles.mapGrid} />
          <View style={[styles.mapRoute, styles.mapRouteOne]} />
          <View style={[styles.mapRoute, styles.mapRouteTwo]} />
          <View style={styles.mapCompass}>
            <Text style={styles.mapCompassNorth}>N</Text>
            <View style={styles.compassNeedle} />
          </View>
          <View style={[styles.mapPin, styles.mapPinOne]}>
            <Text style={styles.mapPinNumber}>01</Text>
          </View>
          <View style={[styles.mapPin, styles.mapPinTwo]}>
            <Text style={styles.mapPinNumber}>02</Text>
          </View>
          <View style={[styles.mapPin, styles.mapPinThree]}>
            <Text style={styles.mapPinNumber}>03</Text>
          </View>
          <Text style={styles.mapCaption}>YOUR TASTE IS A ROUTE, NOT A LABEL.</Text>
          <Text style={styles.mapTitle}>味覚航海図</Text>
          <Text style={styles.mapDescription}>人物像 ＝ 出発点{`\n`}あなたの回答 ＝ 進む方角</Text>
        </View>
      </View>

      <View style={styles.sectionHeading}>
        <View>
          <Text style={styles.sectionIndex}>STARTING POINT</Text>
          <Text style={styles.sectionTitle}>いちばん「自分にありそう」な場面は？</Text>
        </View>
        <Text style={styles.sectionNote}>完全一致ではなく、気になるものを選べば十分です。</Text>
      </View>

      <View testID="persona-grid" style={styles.personaGrid}>
        {PERSONA_SCENARIOS.map((persona, index) => (
          <PersonaCard
            key={persona.id}
            index={index}
            persona={persona}
            selected={selectedPersona?.id === persona.id}
            isWide={isWide}
            onPress={() => onSelect(persona.id)}
          />
        ))}
      </View>

      <View style={[styles.selectionDock, isWide && styles.selectionDockWide]}>
        <View style={styles.selectionCopy}>
          <Text style={styles.selectionLabel}>SELECTED SCENARIO</Text>
          {selectedPersona ? (
            <>
              <Text testID="selected-persona-name" style={styles.selectionTitle}>
                {selectedPersona.name}
              </Text>
              <Text style={styles.selectionText}>{selectedPersona.situation}</Text>
            </>
          ) : (
            <>
              <Text style={styles.selectionTitle}>まだ選ばれていません</Text>
              <Text style={styles.selectionText}>4つのうち、少しでも近いカードを一枚選んでください。</Text>
            </>
          )}
        </View>
        <Pressable
          testID="demo-start-calibration"
          accessibilityRole="button"
          accessibilityLabel="4つの質問を始める"
          accessibilityState={{ disabled: !selectedPersona }}
          disabled={!selectedPersona}
          onPress={onContinue}
          style={[styles.primaryButton, !selectedPersona && styles.buttonDisabled]}
        >
          <Text style={styles.primaryButtonText}>4つの質問へ</Text>
          <Text style={styles.primaryButtonArrow}>→</Text>
        </Pressable>
      </View>

      <View style={styles.methodNote}>
        <Text style={styles.methodNoteNumber}>※</Text>
        <Text style={styles.methodNoteText}>
          「50歳男性」「20代学生」は既存デモ設定から作ったシナリオです。残り2件は探索用の仮説。どれを選んでも、人物像の影響は弱い初期値にとどめ、4つの回答を優先して結果を計算します。
        </Text>
      </View>
    </View>
  );
}

function HeroFact({ number, label }: { number: string; label: string }) {
  return (
    <View>
      <Text style={styles.factNumber}>{number}</Text>
      <Text style={styles.factLabel}>{label}</Text>
    </View>
  );
}

function PersonaCard({
  persona,
  index,
  selected,
  isWide,
  onPress,
}: {
  persona: PersonaScenario;
  index: number;
  selected: boolean;
  isWide: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={`persona-${persona.id}`}
      accessibilityRole="radio"
      accessibilityLabel={`${persona.name}、${persona.descriptor}`}
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      onPress={onPress}
      style={[
        styles.personaCard,
        isWide && styles.personaCardWide,
        selected && { borderColor: persona.accent, borderWidth: 2 },
      ]}
    >
      <View style={styles.personaTopline}>
        <Text style={[styles.personaNumber, { color: persona.accent }]}>
          {String(index + 1).padStart(2, '0')}
        </Text>
        <View
          style={[
            styles.sourceBadge,
            { backgroundColor: persona.source === 'interview' ? colors.successSoft : colors.warningSoft },
          ]}
        >
          <View style={[styles.sourceDot, { backgroundColor: persona.accent }]} />
          <Text style={styles.sourceText}>{persona.sourceLabel}</Text>
        </View>
      </View>
      <Text style={styles.personaName}>{persona.name}</Text>
      <Text style={styles.personaDescriptor}>{persona.descriptor}</Text>
      <View style={[styles.quoteRule, { backgroundColor: persona.accent }]} />
      <Text style={styles.personaQuote}>「{persona.quote}」</Text>
      <Text style={styles.personaSituation}>{persona.situation}</Text>
      <View style={styles.tagRow}>
        {persona.tags.map((tag) => (
          <View key={tag} style={styles.tag}>
            <Text style={styles.tagText}>{tag}</Text>
          </View>
        ))}
      </View>
      <View style={styles.personaFooter}>
        <Text style={[styles.selectText, selected && { color: persona.accent }]}>
          {selected ? 'この場面から始める' : 'この場面を選ぶ'}
        </Text>
        <View style={[styles.radio, selected && { borderColor: persona.accent }]}>
          {selected ? <View style={[styles.radioCore, { backgroundColor: persona.accent }]} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

function QuestionStage({
  isWide,
  persona,
  questionIndex,
  selectedOptionId,
  onChoose,
  onBack,
  onContinue,
}: {
  isWide: boolean;
  persona: PersonaScenario;
  questionIndex: number;
  selectedOptionId: string | undefined;
  onChoose: (optionId: string) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const question = CALIBRATION_QUESTIONS[questionIndex];
  const progress = ((questionIndex + 1) / CALIBRATION_QUESTIONS.length) * 100;

  return (
    <View style={styles.questionPage}>
      <View style={styles.questionProgressHeader}>
        <View>
          <Text style={styles.sectionIndex}>TASTE CALIBRATION</Text>
          <Text style={styles.progressCount}>
            {String(questionIndex + 1).padStart(2, '0')} / {String(CALIBRATION_QUESTIONS.length).padStart(2, '0')}
          </Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: persona.accent }]} />
        </View>
      </View>

      <View style={[styles.questionLayout, isWide && styles.questionLayoutWide]}>
        <View style={styles.scenarioRail}>
          <Text style={styles.railLabel}>YOUR START</Text>
          <Text style={[styles.railNumber, { color: persona.accent }]}>⌁</Text>
          <Text style={styles.railName}>{persona.name}</Text>
          <Text style={styles.railDescriptor}>{persona.descriptor}</Text>
          <View style={[styles.railLine, { backgroundColor: persona.accent }]} />
          <Text style={styles.railText}>
            人物像は出発点です。ここからの回答で、違う方向へ進んでも構いません。
          </Text>
        </View>

        <View style={styles.questionMain}>
          <Text style={styles.questionKicker}>QUESTION {String(questionIndex + 1).padStart(2, '0')}</Text>
          <Text testID="calibration-question" style={styles.questionTitle}>{question.prompt}</Text>
          <Text style={styles.questionNote}>{question.note}</Text>

          <View accessibilityRole="radiogroup" style={styles.optionGrid}>
            {question.options.map((option, optionIndex) => {
              const selected = selectedOptionId === option.id;
              return (
                <Pressable
                  key={option.id}
                  testID={`calibration-option-${option.id}`}
                  accessibilityRole="radio"
                  accessibilityLabel={`${option.label}。${option.description}`}
                  accessibilityState={{ checked: selected }}
                  aria-checked={selected}
                  onPress={() => onChoose(option.id)}
                  style={[
                    styles.optionCard,
                    isWide && styles.optionCardWide,
                    selected && { borderColor: persona.accent, backgroundColor: `${persona.accent}0d` },
                  ]}
                >
                  <View style={styles.optionTopline}>
                    <Text style={[styles.optionIndex, selected && { color: persona.accent }]}>
                      {String(optionIndex + 1).padStart(2, '0')}
                    </Text>
                    <View style={[styles.radio, selected && { borderColor: persona.accent }]}>
                      {selected ? <View style={[styles.radioCore, { backgroundColor: persona.accent }]} /> : null}
                    </View>
                  </View>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  <Text style={styles.optionDescription}>{option.description}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.questionActions}>
            <Pressable accessibilityRole="button" onPress={onBack} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>← 戻る</Text>
            </Pressable>
            <Pressable
              testID="calibration-next"
              accessibilityRole="button"
              accessibilityState={{ disabled: !selectedOptionId }}
              disabled={!selectedOptionId}
              onPress={onContinue}
              style={[styles.primaryButton, !selectedOptionId && styles.buttonDisabled]}
            >
              <Text style={styles.primaryButtonText}>
                {questionIndex === CALIBRATION_QUESTIONS.length - 1 ? '航海図を見る' : '次の質問へ'}
              </Text>
              <Text style={styles.primaryButtonArrow}>→</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

function ResultStage({
  isWide,
  result,
  availableLikes,
  availableAvoid,
  includedLikes,
  includedAvoid,
  saved,
  persistedByDemo,
  onSave,
  onSearch,
  onReview,
  onDiscard,
  onRestart,
  onToggleTag,
}: {
  isWide: boolean;
  result: ReturnType<typeof calibratePersona>;
  availableLikes: string[];
  availableAvoid: string[];
  includedLikes: string[];
  includedAvoid: string[];
  saved: boolean;
  persistedByDemo: boolean;
  onSave: () => void;
  onSearch: () => void;
  onReview: () => void;
  onDiscard: () => void;
  onRestart: () => void;
  onToggleTag: (kind: 'likes' | 'avoid', tag: string) => void;
}) {
  return (
    <View style={styles.resultPage}>
      <View style={styles.resultIntro}>
        <Text style={styles.sectionIndex}>YOUR TASTE CHART / COMPLETE</Text>
        <Text testID="calibration-result-title" style={styles.resultTitle}>
          あなたは、{`\n`}{result.topTraits[0].label}人。
        </Text>
        <Text style={styles.resultLead}>
          {result.persona.name}の場面から出発しましたが、結果は4つの回答を優先して計算しています。これは診断名ではなく、次の店選びを少し速くするための現在地です。
        </Text>
      </View>

      <View style={[styles.resultLayout, isWide && styles.resultLayoutWide]}>
        <View style={[styles.chartCard, isWide && styles.chartCardWide]}>
          <View style={styles.chartHeader}>
            <View>
              <Text style={styles.chartKicker}>TASTE COORDINATES</Text>
              <Text style={styles.chartTitle}>味覚航海図</Text>
            </View>
            <View style={[styles.startBadge, { borderColor: result.persona.accent }]}>
              <View style={[styles.sourceDot, { backgroundColor: result.persona.accent }]} />
              <Text style={styles.startBadgeText}>出発点: {result.persona.name}</Text>
            </View>
          </View>

          <View style={styles.axisList}>
            {TASTE_AXIS_IDS.map((axis) => (
              <View key={axis} style={styles.axisRow}>
                <View style={styles.axisLabelRow}>
                  <Text style={styles.axisLabel}>{AXIS_SHORT_LABELS[axis]}</Text>
                  <Text style={styles.axisValue}>{result.scores[axis]}</Text>
                </View>
                <View style={styles.axisTrack}>
                  <View
                    style={[
                      styles.axisFill,
                      {
                        width: `${result.scores[axis]}%`,
                        backgroundColor:
                          result.topTraits.some((trait) => trait.axis === axis)
                            ? result.persona.accent
                            : colors.border,
                      },
                    ]}
                  />
                </View>
              </View>
            ))}
          </View>

          <View style={styles.chartLegend}>
            <View style={[styles.legendLine, { backgroundColor: result.persona.accent }]} />
            <Text style={styles.legendText}>上位3項目</Text>
            <View style={[styles.legendLine, { backgroundColor: colors.border }]} />
            <Text style={styles.legendText}>補助項目</Text>
          </View>
        </View>

        <View style={[styles.traitColumn, isWide && styles.traitColumnWide]}>
          {result.topTraits.map((trait, index) => (
            <View key={trait.axis} style={styles.traitCard}>
              <View style={styles.traitTopline}>
                <Text style={styles.traitRank}>0{index + 1}</Text>
                <Text style={[styles.traitScore, { color: result.persona.accent }]}>{trait.score}</Text>
              </View>
              <Text style={styles.traitTitle}>{trait.label}</Text>
              <Text style={styles.traitExplanation}>{trait.explanation}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={[styles.nextStepCard, isWide && styles.nextStepCardWide]}>
        <View style={[styles.nextStepCopy, isWide && styles.nextStepCopyWide]}>
          <Text style={styles.sectionIndex}>NEXT ROUTE</Text>
          <Text style={styles.nextStepTitle}>この好みを、実際の店探しに使う</Text>
          <View testID="demo-preference-editor" style={styles.preferenceEditor}>
            <View style={styles.preferenceEditorHeader}>
              <View style={styles.preferenceEditorCopy}>
                <Text style={styles.preferenceEditorKicker}>ROUTE MANIFEST / KEEP OR REMOVE</Text>
                <Text style={styles.preferenceEditorTitle}>保存したい仮説だけを残す</Text>
              </View>
              <Text style={styles.preferenceEditorCount}>
                {includedLikes.length + includedAvoid.length} / {availableLikes.length + availableAvoid.length}
              </Text>
            </View>
            <Text style={styles.preferenceEditorNote}>
              人物像と回答から出た候補です。自分と違うものは、保存前に外せます。
            </Text>
            <EditablePreferenceGroup
              kind="likes"
              label="好きの候補"
              tags={availableLikes}
              selectedTags={includedLikes}
              accent={result.persona.accent}
              onToggle={onToggleTag}
            />
            <EditablePreferenceGroup
              kind="avoid"
              label="避けたい候補"
              tags={availableAvoid}
              selectedTags={includedAvoid}
              accent={result.persona.accent}
              onToggle={onToggleTag}
            />
          </View>
          <View style={styles.privacyNote}>
            <Text style={styles.privacyIcon}>⌁</Text>
            <Text style={styles.privacyText}>
              選んだ集約タグだけを保存します。「端末に保存」または「この好みで店を探す」を押すまで保存せず、デモ回答そのものは送信しません。
            </Text>
          </View>
          {saved ? (
            <Text testID="demo-saved-message" accessibilityRole="alert" style={styles.savedText}>
              ✓ この端末の好みプロフィールに保存しました
            </Text>
          ) : null}
        </View>
        <View style={styles.nextStepActions}>
          <Pressable testID="demo-use-profile" accessibilityRole="button" onPress={onSearch} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>この好みで店を探す</Text>
            <Text style={styles.primaryButtonArrow}>→</Text>
          </Pressable>
          <Pressable
            testID="demo-save-local"
            accessibilityRole="button"
            onPress={onSave}
            style={styles.outlineButton}
          >
            <Text style={styles.outlineButtonText}>
              {saved ? '保存済み' : persistedByDemo ? '変更をこの端末に保存' : 'この端末だけに保存'}
            </Text>
          </Pressable>
          <Pressable
            testID="demo-review-answers"
            accessibilityRole="button"
            onPress={onReview}
            style={styles.outlineButton}
          >
            <Text style={styles.outlineButtonText}>回答を見直す</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/account' as never)}
            style={styles.textButton}
          >
            <Text style={styles.textButtonText}>Googleログインで引き継ぐ ↗</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.resultResetActions}>
        <Pressable accessibilityRole="button" onPress={onRestart} style={styles.restartButton}>
          <Text style={styles.restartButtonText}>別のシナリオでもう一度試す</Text>
        </Pressable>
        <Pressable
          testID="demo-discard-result"
          accessibilityRole="button"
          onPress={onDiscard}
          style={styles.discardButton}
        >
          <Text style={styles.discardButtonText}>
            {saved ? '保存した結果を破棄する' : '結果を破棄して最初に戻る'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function EditablePreferenceGroup({
  kind,
  label,
  tags,
  selectedTags,
  accent,
  onToggle,
}: {
  kind: 'likes' | 'avoid';
  label: string;
  tags: string[];
  selectedTags: string[];
  accent: string;
  onToggle: (kind: 'likes' | 'avoid', tag: string) => void;
}) {
  if (tags.length === 0) return null;

  return (
    <View style={styles.preferenceGroup}>
      <Text style={styles.preferenceGroupLabel}>{label}</Text>
      <View style={styles.editableTagRow}>
        {tags.map((tag, index) => {
          const selected = selectedTags.includes(tag);
          return (
            <Pressable
              key={tag}
              testID={`demo-${kind}-tag-${index}`}
              accessibilityRole="checkbox"
              accessibilityLabel={
                selected ? `${tag}を保存候補から外す` : `${tag}を保存候補に戻す`
              }
              accessibilityState={{ checked: selected }}
              aria-checked={selected}
              onPress={() => onToggle(kind, tag)}
              style={[
                styles.editableTag,
                selected
                  ? { borderColor: accent, backgroundColor: `${accent}2b` }
                  : styles.editableTagOff,
              ]}
            >
              <Text style={[styles.editableTagMark, selected && { color: accent }]}>
                {selected ? '✓' : '+'}
              </Text>
              <Text style={[styles.editableTagText, !selected && styles.editableTagTextOff]}>
                {tag}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  shell: {
    width: '100%',
    maxWidth: 1180,
    marginHorizontal: 'auto',
    paddingHorizontal: 24,
    paddingBottom: 72,
  },
  header: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  brandButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  logoPlate: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: 4,
    backgroundColor: colors.white,
  },
  logo: {
    width: 118,
    height: 36,
  },
  logoCompact: {
    width: 98,
    height: 32,
  },
  demoBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.orange,
    borderRadius: radius.pill,
  },
  demoBadgeText: {
    fontFamily: fonts.brand,
    color: colors.orange,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.9,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  localOnly: {
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: '600',
  },
  loginButton: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.text,
    borderRadius: radius.pill,
  },
  loginButtonAuthenticated: {
    borderColor: colors.orange,
    backgroundColor: colors.orangeFaint,
  },
  connectedDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
  },
  loginButtonText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
    maxWidth: 120,
  },
  loginButtonTextAuthenticated: {
    color: colors.text,
  },
  loginArrow: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
  },
  loginArrowAuthenticated: {
    color: colors.orange,
  },
  hero: {
    gap: 36,
    paddingTop: 62,
    paddingBottom: 70,
  },
  heroWide: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 64,
  },
  heroCopy: {
    flex: 1,
    justifyContent: 'center',
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
  },
  eyebrow: {
    fontFamily: fonts.brand,
    color: colors.orange,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  eyebrowRule: {
    width: 62,
    height: 1,
    backgroundColor: colors.orange,
  },
  heroTitle: {
    color: colors.text,
    fontSize: 43,
    fontWeight: '800',
    letterSpacing: -1.7,
    lineHeight: 59,
  },
  heroTitleCompact: {
    fontSize: 34,
    lineHeight: 48,
  },
  heroLead: {
    maxWidth: 610,
    marginTop: 20,
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 27,
  },
  heroFacts: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    marginTop: 32,
  },
  factNumber: {
    fontFamily: fonts.brand,
    color: colors.text,
    fontSize: 19,
    fontWeight: '800',
  },
  factLabel: {
    marginTop: 2,
    color: colors.textTertiary,
    fontSize: 9,
    fontWeight: '700',
  },
  factDivider: {
    width: 1,
    height: 34,
    backgroundColor: colors.border,
  },
  mapPreview: {
    position: 'relative',
    minHeight: 390,
    flex: 0.78,
    overflow: 'hidden',
    padding: 28,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.canvas,
  },
  mapGrid: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    opacity: 0.46,
    backgroundColor: colors.canvas,
    borderWidth: 24,
    borderColor: 'rgba(42, 119, 199, 0.05)',
  },
  mapRoute: {
    position: 'absolute',
    height: 2,
    backgroundColor: colors.info,
    opacity: 0.5,
    transformOrigin: 'left center',
  },
  mapRouteOne: {
    top: 128,
    left: 80,
    width: 250,
    transform: [{ rotate: '18deg' }],
  },
  mapRouteTwo: {
    top: 238,
    left: 117,
    width: 184,
    transform: [{ rotate: '-30deg' }],
  },
  mapCompass: {
    position: 'absolute',
    top: 24,
    right: 24,
    width: 54,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
  },
  mapCompassNorth: {
    position: 'absolute',
    top: 5,
    color: colors.info,
    fontFamily: fonts.brand,
    fontSize: 8,
    fontWeight: '800',
  },
  compassNeedle: {
    width: 2,
    height: 24,
    backgroundColor: colors.orange,
    transform: [{ rotate: '24deg' }],
  },
  mapPin: {
    position: 'absolute',
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  mapPinOne: {
    top: 106,
    left: 60,
  },
  mapPinTwo: {
    top: 180,
    right: 72,
  },
  mapPinThree: {
    top: 258,
    left: 122,
  },
  mapPinNumber: {
    fontFamily: fonts.brand,
    color: colors.info,
    fontSize: 9,
    fontWeight: '800',
  },
  mapCaption: {
    position: 'absolute',
    left: 28,
    bottom: 75,
    color: colors.textTertiary,
    fontFamily: fonts.brand,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  mapTitle: {
    position: 'absolute',
    left: 28,
    bottom: 36,
    color: colors.text,
    fontSize: 26,
    fontWeight: '800',
  },
  mapDescription: {
    position: 'absolute',
    right: 26,
    bottom: 33,
    color: colors.textSecondary,
    fontSize: 9,
    fontWeight: '600',
    lineHeight: 16,
  },
  sectionHeading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 16,
    marginBottom: 24,
  },
  sectionIndex: {
    color: colors.orange,
    fontFamily: fonts.brand,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  sectionTitle: {
    marginTop: 8,
    color: colors.text,
    fontSize: 25,
    fontWeight: '800',
    lineHeight: 36,
  },
  sectionNote: {
    maxWidth: 310,
    color: colors.textTertiary,
    fontSize: 11,
    lineHeight: 19,
  },
  personaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  personaCard: {
    width: '100%',
    minHeight: 350,
    padding: 22,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  personaCardWide: {
    width: '48.8%',
    flexGrow: 1,
  },
  personaTopline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  personaNumber: {
    fontFamily: fonts.brand,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  sourceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  sourceDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
  },
  sourceText: {
    color: colors.textSecondary,
    fontSize: 8,
    fontWeight: '700',
  },
  personaName: {
    marginTop: 24,
    color: colors.text,
    fontSize: 23,
    fontWeight: '800',
  },
  personaDescriptor: {
    marginTop: 5,
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  quoteRule: {
    width: 34,
    height: 2,
    marginTop: 22,
    marginBottom: 13,
  },
  personaQuote: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 24,
  },
  personaSituation: {
    marginTop: 11,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 20,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 18,
  },
  tag: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.pill,
    backgroundColor: colors.canvas,
  },
  tagText: {
    color: colors.textSecondary,
    fontSize: 9,
    fontWeight: '600',
  },
  personaFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 'auto',
    paddingTop: 22,
  },
  selectText: {
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: '700',
  },
  radio: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  radioCore: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
  },
  selectionDock: {
    gap: 24,
    marginTop: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.text,
    borderRadius: radius.md,
    backgroundColor: colors.text,
  },
  selectionDockWide: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  selectionCopy: {
    flex: 1,
  },
  selectionLabel: {
    color: colors.amber,
    fontFamily: fonts.brand,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1,
  },
  selectionTitle: {
    marginTop: 7,
    color: colors.surface,
    fontSize: 17,
    fontWeight: '800',
  },
  selectionText: {
    maxWidth: 720,
    marginTop: 5,
    color: darkPanelColors.lead,
    fontSize: 10,
    lineHeight: 18,
  },
  primaryButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingHorizontal: 22,
    borderRadius: radius.sm,
    backgroundColor: colors.orange,
  },
  primaryButtonText: {
    color: colors.surface,
    fontSize: 12,
    fontWeight: '800',
  },
  primaryButtonArrow: {
    color: colors.surface,
    fontFamily: fonts.brand,
    fontSize: 15,
    fontWeight: '800',
  },
  buttonDisabled: {
    opacity: 0.35,
  },
  methodNote: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
    paddingHorizontal: 4,
  },
  methodNoteNumber: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
  },
  methodNoteText: {
    flex: 1,
    color: colors.textTertiary,
    fontSize: 9,
    lineHeight: 17,
  },
  questionPage: {
    paddingTop: 40,
  },
  questionProgressHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 24,
    paddingBottom: 28,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  progressCount: {
    marginTop: 5,
    color: colors.text,
    fontFamily: fonts.brand,
    fontSize: 25,
    fontWeight: '800',
  },
  progressTrack: {
    width: '58%',
    height: 4,
    overflow: 'hidden',
    borderRadius: radius.pill,
    backgroundColor: colors.borderSoft,
  },
  progressFill: {
    height: 4,
    borderRadius: radius.pill,
  },
  questionLayout: {
    gap: 38,
    paddingVertical: 48,
  },
  questionLayoutWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 58,
  },
  scenarioRail: {
    minWidth: 210,
    maxWidth: '100%',
    flex: 0.32,
    padding: 22,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  railLabel: {
    color: colors.textTertiary,
    fontFamily: fonts.brand,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1,
  },
  railNumber: {
    marginTop: 18,
    fontSize: 36,
    fontWeight: '400',
  },
  railName: {
    marginTop: 10,
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  railDescriptor: {
    marginTop: 5,
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 17,
  },
  railLine: {
    width: 38,
    height: 2,
    marginVertical: 18,
  },
  railText: {
    color: colors.textTertiary,
    fontSize: 9,
    lineHeight: 17,
  },
  questionMain: {
    flex: 1,
  },
  questionKicker: {
    color: colors.orange,
    fontFamily: fonts.brand,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  questionTitle: {
    maxWidth: 760,
    marginTop: 12,
    color: colors.text,
    fontSize: 31,
    fontWeight: '800',
    lineHeight: 44,
  },
  questionNote: {
    marginTop: 10,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 19,
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 30,
  },
  optionCard: {
    width: '100%',
    minHeight: 138,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  optionCardWide: {
    width: '48.9%',
    flexGrow: 1,
  },
  optionTopline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionIndex: {
    color: colors.textTertiary,
    fontFamily: fonts.brand,
    fontSize: 9,
    fontWeight: '800',
  },
  optionLabel: {
    marginTop: 14,
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
  },
  optionDescription: {
    marginTop: 5,
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 17,
  },
  questionActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    marginTop: 28,
  },
  secondaryButton: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  resultPage: {
    paddingTop: 58,
  },
  resultIntro: {
    alignItems: 'center',
    paddingBottom: 44,
  },
  resultTitle: {
    marginTop: 12,
    color: colors.text,
    fontSize: 39,
    fontWeight: '800',
    letterSpacing: -1.3,
    lineHeight: 54,
    textAlign: 'center',
  },
  resultLead: {
    maxWidth: 680,
    marginTop: 17,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 23,
    textAlign: 'center',
  },
  resultLayout: {
    gap: 16,
  },
  resultLayoutWide: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  chartCard: {
    padding: 26,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  chartCardWide: {
    flex: 1.4,
  },
  chartHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 14,
  },
  chartKicker: {
    color: colors.info,
    fontFamily: fonts.brand,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1,
  },
  chartTitle: {
    marginTop: 5,
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
  },
  startBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
  },
  startBadgeText: {
    color: colors.textSecondary,
    fontSize: 8,
    fontWeight: '700',
  },
  axisList: {
    gap: 17,
    marginTop: 30,
  },
  axisRow: {
    gap: 7,
  },
  axisLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  axisLabel: {
    color: colors.text,
    fontSize: 10,
    fontWeight: '700',
  },
  axisValue: {
    color: colors.textSecondary,
    fontFamily: fonts.brand,
    fontSize: 10,
    fontWeight: '800',
  },
  axisTrack: {
    height: 8,
    overflow: 'hidden',
    borderRadius: radius.pill,
    backgroundColor: colors.borderSoft,
  },
  axisFill: {
    height: 8,
    borderRadius: radius.pill,
  },
  chartLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 24,
  },
  legendLine: {
    width: 18,
    height: 3,
    borderRadius: radius.pill,
  },
  legendText: {
    marginRight: 8,
    color: colors.textTertiary,
    fontSize: 8,
    fontWeight: '600',
  },
  traitColumn: {
    gap: 10,
  },
  traitColumnWide: {
    flex: 1,
  },
  traitCard: {
    flex: 1,
    minHeight: 128,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.canvas,
  },
  traitTopline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  traitRank: {
    color: colors.textTertiary,
    fontFamily: fonts.brand,
    fontSize: 8,
    fontWeight: '800',
  },
  traitScore: {
    fontFamily: fonts.brand,
    fontSize: 18,
    fontWeight: '800',
  },
  traitTitle: {
    marginTop: 7,
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
  },
  traitExplanation: {
    marginTop: 5,
    color: colors.textSecondary,
    fontSize: 9,
    lineHeight: 16,
  },
  nextStepCard: {
    gap: 25,
    marginTop: 28,
    padding: 28,
    borderWidth: 1,
    borderColor: colors.text,
    borderRadius: radius.md,
    backgroundColor: colors.text,
  },
  nextStepCardWide: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  nextStepCopy: {
    minWidth: 0,
  },
  nextStepCopyWide: {
    flex: 1,
  },
  nextStepTitle: {
    marginTop: 8,
    color: colors.surface,
    fontSize: 20,
    fontWeight: '800',
  },
  preferenceEditor: {
    maxWidth: 660,
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: darkPanelColors.border,
  },
  preferenceEditorHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 16,
  },
  preferenceEditorCopy: {
    flex: 1,
  },
  preferenceEditorKicker: {
    color: colors.amber,
    fontFamily: fonts.brand,
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.7,
  },
  preferenceEditorTitle: {
    marginTop: 4,
    color: colors.surface,
    fontSize: 12,
    fontWeight: '800',
  },
  preferenceEditorCount: {
    color: darkPanelColors.count,
    fontFamily: fonts.brand,
    fontSize: 10,
    fontWeight: '800',
  },
  preferenceEditorNote: {
    marginTop: 6,
    color: darkPanelColors.muted,
    fontSize: 8,
    lineHeight: 14,
  },
  preferenceGroup: {
    marginTop: 12,
    gap: 7,
  },
  preferenceGroupLabel: {
    color: darkPanelColors.label,
    fontSize: 8,
    fontWeight: '700',
  },
  editableTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  editableTag: {
    minHeight: 31,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderRadius: radius.pill,
  },
  editableTagOff: {
    borderColor: darkPanelColors.controlBorder,
    backgroundColor: 'transparent',
    opacity: 0.72,
  },
  editableTagMark: {
    color: darkPanelColors.controlMark,
    fontFamily: fonts.brand,
    fontSize: 9,
    fontWeight: '800',
  },
  editableTagText: {
    color: colors.surface,
    fontSize: 8,
    fontWeight: '700',
  },
  editableTagTextOff: {
    color: darkPanelColors.struck,
    textDecorationLine: 'line-through',
  },
  privacyNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    maxWidth: 650,
    marginTop: 15,
  },
  privacyIcon: {
    color: colors.amber,
    fontSize: 14,
  },
  privacyText: {
    flex: 1,
    color: darkPanelColors.muted,
    fontSize: 8,
    lineHeight: 15,
  },
  savedText: {
    marginTop: 12,
    color: darkPanelColors.success,
    fontSize: 10,
    fontWeight: '700',
  },
  nextStepActions: {
    minWidth: 230,
    maxWidth: '100%',
    gap: 9,
  },
  outlineButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: darkPanelColors.actionBorder,
    borderRadius: radius.sm,
  },
  outlineButtonText: {
    color: colors.surface,
    fontSize: 10,
    fontWeight: '700',
  },
  textButton: {
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textButtonText: {
    color: colors.amber,
    fontSize: 9,
    fontWeight: '700',
  },
  restartButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
  },
  resultResetActions: {
    alignItems: 'center',
    gap: 10,
    marginTop: 26,
  },
  discardButton: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  discardButtonText: {
    color: colors.danger,
    fontSize: 8,
    fontWeight: '700',
  },
  restartButtonText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
});
