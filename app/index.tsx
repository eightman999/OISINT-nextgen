import { Link, router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { Footer } from '@/components/Footer';
import { LocationPicker } from '@/components/LocationPicker';
import { TermsConsentModal } from '@/components/TermsConsentModal';
import { TermsConsentNotice } from '@/components/TermsConsentNotice';
import { UserActionError } from '@/components/UserActionError';
import { PreferenceHearingCard } from '@/components/PreferenceHearingCard';
import { SensitiveInputNote } from '@/components/SensitiveInputNote';
import { TasteProfilePanel } from '@/components/TasteProfilePanel';
import { createInvestigation, getUserId, isLiveDataProvider, runInvestigation } from '@/lib/api';
import {
  buildInvestigationInputFingerprint,
  resolveInvestigationRunTarget,
  type PendingInvestigationRun,
} from '@/lib/startInvestigationRetry';
import { ensureTermsConsentForAction } from '@/lib/termsConsent';
import {
  recognizeProfileEdit,
  recognizeSearchBehavior,
} from '@/lib/behaviorRecognition';
import {
  confirmedPreferenceHintsToQuery,
  loadLocalPersonalization,
  recordPreferenceObservationLocally,
  tasteProfileForCurrentContext,
} from '@/lib/personalization';
import { useAuth } from '@/providers/AuthProvider';
import {
  DEFAULT_TASTE_PROFILE,
  loadTasteProfile,
  locationToQuery,
  saveTasteProfile,
  tasteProfileToQuery,
} from '@/lib/profile';
import { consumeResearchAgainPrefill } from '@/lib/researchPrefill';
import { CreateIdempotencyState } from '@/lib/createIdempotencyState';
import {
  LOCATION_ANCHOR_REQUIRED_MESSAGE,
} from '@/lib/validation';
import { colors, fonts, radius, sceneColors } from '@/theme';
import type { LocationSelection, TasteProfile } from '@/types';

const BRAND_LOGO = require('../assets/branding/oisint-logo-horizontal-transparent.png');
const BRAND_ART = require('../assets/branding/oisint-logo-stacked-transparent.png');
const USE_NATIVE_DRIVER = Platform.OS !== 'web';

const FILTER_CHIPS = ['禁煙', '個室', 'カード可', '徒歩5分以内', 'Wi-Fi', '静か', '子連れOK'];

const SEARCH_FIELD_GUIDANCE =
  '場所は上の「場所」欄に駅名・地名だけを入力し、人数・予算・料理・雰囲気などは下の「探したいお店の条件」欄に入力してください。';

type PendingRunState = {
  subject: string;
  target: PendingInvestigationRun;
};

function isUnknownRunAcceptance(error: unknown): boolean {
  // A response-less network failure (or an unparseable response) can happen
  // after the server committed the accepted run.  Only explicit HTTP errors
  // are definite rejection; the rest must converge on the existing result.
  if (!error || typeof error !== 'object') return true;
  const status = (error as { status?: unknown }).status;
  return !Number.isInteger(status);
}

function locationSearchAnchor(location: LocationSelection | null) {
  if (location?.source !== 'gps') return undefined;
  const lat = location.latitude;
  const lng = location.longitude;
  if (
    typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180
  ) {
    return undefined;
  }
  return { lat, lng };
}

const SCENES = [
  {
    id: 'home-template-company',
    index: '01',
    label: '会社の飲み会',
    title: 'ちゃんと話せる、肉の夜',
    query: '池袋で3人。3000円くらい。肉。カード可。静かめ。',
    location: '池袋',
    people: '3人',
    budget: '3,000円前後',
    note: '仕事の話も、近況も。声が届く店。',
    accent: sceneColors.company.accent,
    soft: sceneColors.company.soft,
  },
  {
    id: 'home-template-omotenashi',
    index: '02',
    label: '接待・会食',
    title: '落ち着いて選ぶ、和食の席',
    query: '新宿で4人。ひとり6000円前後。個室。落ち着いた和食。',
    location: '新宿',
    people: '4人',
    budget: '6,000円前後',
    note: '店選びの理由まで、きちんと持っていく。',
    accent: sceneColors.omotenashi.accent,
    soft: sceneColors.omotenashi.soft,
  },
  {
    id: 'home-template-travel',
    index: '03',
    label: '旅行先',
    title: '知らない街で、外さない一軒',
    query: '渋谷で2人。ランチ。写真映えするカフェ。駅から徒歩5分以内。',
    location: '渋谷',
    people: '2人',
    budget: 'ランチ',
    note: 'せっかくの一日を、店探しで終わらせない。',
    accent: sceneColors.travel.accent,
    soft: sceneColors.travel.soft,
  },
  {
    id: 'home-template-family',
    index: '04',
    label: '家族・グループ',
    // 既存 personaCalibration の family-safety descriptor をそのまま再利用する。
    title: '制約を先に確認する家族幹事',
    query: '家族4人。禁煙で席に余裕があり、食事制限を店に確認できる。駅から近い店。',
    location: '駅から近い',
    people: '家族4人',
    budget: '食事制限',
    // 既存 personaCalibration の quote をそのまま再利用する。
    note: 'おすすめより先に、食べられないものと席の条件を確実にしたい。',
    // 9pxの場面番号でもWCAG AAを満たす濃色を使う（#2c9a66は背景上で不足）。
    accent: colors.textSecondary,
    soft: colors.successSoft,
  },
] as const;

const PROCESS_STEPS = [
  {
    index: '01',
    title: '場面から書き込む',
    text: '人数、予算、空気感。うまく言葉にできない条件も、そのままで。',
  },
  {
    index: '02',
    title: '候補の裏側を確かめる',
    text: '公開情報と出典を並べて、良さそうだけで終わらせない。',
  },
  {
    index: '03',
    title: 'みんなで「これだね」へ',
    text: '共有した画面で条件を足し、最後は自分たちの判断で決める。',
  },
];

export default function HomeScreen() {
  const { userId, displayName, setDisplayName, isAuthenticated, isAnonymous, email } = useAuth();
  const personalizationSubject = userId
    ? { id: userId, kind: isAnonymous ? ('anonymous' as const) : ('permanent' as const) }
    : undefined;
  const authSubjectKey = userId
    ? `${isAnonymous ? 'anonymous' : 'permanent'}:${userId}`
    : 'signed-out';
  const { width } = useWindowDimensions();
  const [clientWidth, setClientWidth] = useState<number | null>(null);
  const isWide = (clientWidth ?? width) >= 920;
  const isCompact = (clientWidth ?? width) < 600;
  // raw_query は auth subject を確認した effect で一度だけ消費する。render中に
  // sessionStorage を読むと、A→B切替時にAの入力を一paint表示するため初期値は空にする。
  const [query, setQuery] = useState('');
  const [customName, setCustomName] = useState<string | null>(null);
  const setLocalName = (val: string) => setCustomName(val);
  const [selectedChips, setSelectedChips] = useState<string[]>([]);
  const [location, setLocation] = useState<LocationSelection | null>(null);
  // GPS取得完了前に検索できてしまうと「現在地を使う」の選択が黙って落ちる (#317)
  const [locationResolving, setLocationResolving] = useState(false);
  const [selectedSceneId, setSelectedSceneId] = useState<
    (typeof SCENES)[number]['id'] | null
  >(SCENES[0].id);
  const [tasteProfile, setTasteProfile] = useState<TasteProfile>(() => {
    return personalizationSubject
      ? loadTasteProfile(personalizationSubject)
      : DEFAULT_TASTE_PROFILE;
  });
  const [tasteProfileSubjectKey, setTasteProfileSubjectKey] = useState(authSubjectKey);
  const [inputSubjectKey, setInputSubjectKey] = useState(authSubjectKey);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [guidanceMessage, setGuidanceMessage] = useState('');
  // #272: 規約同意ゲート。未同意なら調査開始前にモーダルを出す。
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [pendingStartAfterConsent, setPendingStartAfterConsent] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  // Animated.Value はcomponent lifetimeで一度だけ生成する。ref.currentをrender中に読む形を避ける。
  const [briefProgress] = useState(() => new Animated.Value(1));
  const [livePulse] = useState(() => new Animated.Value(0));
  const scrollRef = useRef<ScrollView>(null);
  const queryInputRef = useRef<TextInput>(null);
  // 検索ボックスのスクロール位置 = workbench(page基準) + searchBox(workbenchMain基準) をonLayoutで記録する。
  const workbenchOffsetY = useRef<number | null>(null);
  const searchBoxOffsetY = useRef<number | null>(null);
  // 規約確認の非同期処理中も含め、同じ入力からの二重作成を同期的に防ぐ。
  const startInFlightRef = useRef(false);
  // create 成功後の run 受付だけが失敗した場合は、同じ調査を再利用して再createを避ける。
  const authSubjectKeyRef = useRef(authSubjectKey);
  const authGenerationRef = useRef(0);
  const pendingRunRef = useRef<PendingRunState | null>(null);
  const createIdempotencyStateRef = useRef(new CreateIdempotencyState());
  const inputFingerprintRef = useRef('');
  const activeCreateSubjectRef = useRef<string | null>(null);
  const activeCreateRunRef = useRef<symbol | null>(null);

  useEffect(() => {
    if (authSubjectKeyRef.current === authSubjectKey) return;
    authSubjectKeyRef.current = authSubjectKey;
    authGenerationRef.current += 1;
    const preservesActiveCreate = activeCreateSubjectRef.current === userId && userId !== null;
    if (!preservesActiveCreate) {
      pendingRunRef.current = null;
      startInFlightRef.current = false;
    }
    const nextTasteSubject = userId
      ? { id: userId, kind: isAnonymous ? ('anonymous' as const) : ('permanent' as const) }
      : undefined;
    if (!preservesActiveCreate) {
      setTasteProfile(nextTasteSubject ? loadTasteProfile(nextTasteSubject) : DEFAULT_TASTE_PROFILE);
    }
    setTasteProfileSubjectKey(authSubjectKey);
    setInputSubjectKey(authSubjectKey);
    if (!preservesActiveCreate) {
      // A different subject must not inherit the previous person's unfinished
      // search, location, chips, or manually entered name. The render guard below
      // hides these values before this effect runs.
      setQuery('');
      setCustomName(null);
      setSelectedChips([]);
      setLocation(null);
      setSelectedSceneId(SCENES[0].id);
      setLoading(false);
      setPendingStartAfterConsent(false);
      setShowTermsModal(false);
      setErrorMessage('');
    }
  }, [authSubjectKey, isAnonymous, userId]);

  useEffect(() => {
    const subject = userId
      ? { id: userId, kind: isAnonymous ? ('anonymous' as const) : ('permanent' as const) }
      : undefined;
    let active = true;
    const nextQuery = subject ? consumeResearchAgainPrefill(subject) : '';
    queueMicrotask(() => {
      if (active) setQuery(nextQuery);
    });
    return () => {
      active = false;
    };
  }, [authSubjectKey, isAnonymous, userId]);

  const tasteProfileMatchesSubject = tasteProfileSubjectKey === authSubjectKey;
  const inputsMatchSubject = inputSubjectKey === authSubjectKey;
  const visibleTasteProfile = tasteProfileMatchesSubject ? tasteProfile : DEFAULT_TASTE_PROFILE;
  const visibleQuery = inputsMatchSubject ? query : '';
  const visibleSelectedChips = useMemo(
    () => (inputsMatchSubject ? selectedChips : []),
    [inputsMatchSubject, selectedChips],
  );
  const visibleLocation = inputsMatchSubject ? location : null;
  const visibleCustomName = inputsMatchSubject ? customName : null;
  const localName = visibleCustomName ?? (displayName || '');
  const currentInputFingerprint = useMemo(() => buildInvestigationInputFingerprint({
    query: visibleQuery.trim(),
    selectedChips: visibleSelectedChips,
    location: visibleLocation,
    displayName: localName.trim() || 'ゲスト',
    tasteProfile: visibleTasteProfile,
  }), [visibleQuery, visibleSelectedChips, visibleLocation, localName, visibleTasteProfile]);
  useEffect(() => {
    inputFingerprintRef.current = currentInputFingerprint;
  }, [currentInputFingerprint]);

  const selectedScene = SCENES.find((scene) => scene.id === selectedSceneId);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      livePulse.setValue(1);
      return undefined;
    }

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
        Animated.timing(livePulse, {
          toValue: 0,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
      ])
    );
    pulse.start();

    return () => pulse.stop();
  }, [livePulse, reduceMotion]);

  const focusBrief = () => {
    briefProgress.stopAnimation();
    briefProgress.setValue(reduceMotion ? 1 : 0);
    if (!reduceMotion) {
      Animated.spring(briefProgress, {
        toValue: 1,
        damping: 16,
        stiffness: 180,
        mass: 0.8,
        useNativeDriver: USE_NATIVE_DRIVER,
      }).start();
    }
  };

  const selectScene = (scene: (typeof SCENES)[number]) => {
    setSelectedSceneId(scene.id);
    setQuery(scene.query);
    focusBrief();
  };

  const clearScene = () => {
    setSelectedSceneId(null);
    setQuery('');
    focusBrief();
  };

  const focusSearchInput = () => {
    // Webのfocus()は即時スクロールを伴うため、先にfocusしてからscrollToで最終位置を整える。
    // query自体はselectScene()で反映済みなので、ここでは検索欄への遷移だけを行う。
    queryInputRef.current?.focus();
    const workbenchY = workbenchOffsetY.current;
    const searchBoxY = searchBoxOffsetY.current;
    if (workbenchY != null && searchBoxY != null) {
      scrollRef.current?.scrollTo({
        y: Math.max(0, workbenchY + searchBoxY - 14),
        animated: !reduceMotion,
      });
    }
  };

  const toggleChip = (chip: string) => {
    setSelectedChips((prev) =>
      prev.includes(chip) ? prev.filter((c) => c !== chip) : [...prev, chip]
    );
  };

  const handleStart = async () => {
    const name = localName.trim() || 'ゲスト';
    if (!visibleQuery.trim() || !inputsMatchSubject || !tasteProfileMatchesSubject) return;
    if (startInFlightRef.current) return;

    startInFlightRef.current = true;
    setLoading(true);
    setErrorMessage('');
    setGuidanceMessage('');
    const requestSubjectKey = authSubjectKeyRef.current;
    const requestGeneration = authGenerationRef.current;
    const requestRunToken = Symbol('create-investigation');
    activeCreateRunRef.current = requestRunToken;
    let requestUserId: string | null = null;
    let requestIdempotencyKey: string | null = null;
    const isCurrentSubject = () =>
      authSubjectKeyRef.current === requestSubjectKey &&
      authGenerationRef.current === requestGeneration;

    try {
      // #272: 永続ユーザーはserver正本を確認してから、未同意ならモーダルで中断する。
      const consent = await ensureTermsConsentForAction();
      if (consent.status === 'needs-consent') {
        if (!isCurrentSubject()) return;
        setPendingStartAfterConsent(true);
        setShowTermsModal(true);
        return;
      }
      if (consent.status === 'error') {
        if (!isCurrentSubject()) return;
        setErrorMessage(consent.message);
        return;
      }

      // 匿名bootstrapを含め、createのkeyを発行する直前にproviderの認証subjectを
      // 確定する。Homeのrender stateだけでkeyを先に作らず、live provider側でも
      // 同じsubjectとBearer JWTのsnapshotを照合する。
      requestUserId = await getUserId();
      if (!isCurrentSubject() || (userId !== null && userId !== requestUserId)) return;
      // getUserId待ちの間に入力が編集された場合、古いclosureの入力で
      // createを開始しない。次の明示retryで新fingerprint/keyを発行する。
      if (inputFingerprintRef.current !== currentInputFingerprint) return;
      activeCreateSubjectRef.current = requestUserId;

      const inputFingerprint = currentInputFingerprint;
      requestIdempotencyKey = createIdempotencyStateRef.current.keyFor(
        requestUserId,
        inputFingerprint,
      );
      const pendingState = pendingRunRef.current;
      let pendingRun = pendingState?.subject === requestUserId
        ? resolveInvestigationRunTarget(pendingState.target, inputFingerprint)
        : null;
      if (!pendingRun) {
        // Only explicit demo/hearing answers become fixed, coarse hints. Behavior-only beliefs are
        // kept out of the request so the agent cannot amplify its own unconfirmed inference.
        const personalizationSnapshot = loadLocalPersonalization(personalizationSubject);
        const confirmedPreferenceHints = confirmedPreferenceHintsToQuery(
          personalizationSnapshot,
          visibleQuery.trim(),
          visibleSelectedChips,
        );
        const contextualTasteProfile = tasteProfileForCurrentContext(
          personalizationSnapshot,
          visibleTasteProfile,
          visibleQuery.trim(),
          visibleSelectedChips,
        );
        const fullQuery = [
          locationToQuery(visibleLocation),
          visibleQuery.trim(),
          ...visibleSelectedChips,
          tasteProfileToQuery(contextualTasteProfile),
          confirmedPreferenceHints,
        ]
          .filter(Boolean)
          .join(' / ');
        setDisplayName(name);

        inputFingerprintRef.current = inputFingerprint;

        const created = await createInvestigation({
          query: fullQuery,
          displayName: name,
          idempotencyKey: requestIdempotencyKey,
          authSubject: requestUserId,
          // Mock providerだけはJWTの代わりに現在のsubjectでownerを再現する。
          // live APIにはuserIdを送らず、所有者は検証済みJWTからサーバーが決める。
          ...(!isLiveDataProvider ? { userId: requestUserId } : {}),
        });
        if ((await getUserId()) !== requestUserId) {
          // 認証切替後に返った旧subjectの結果は、新subjectの画面へ反映しない。
          createIdempotencyStateRef.current.clearIfMatches(
            requestUserId,
            inputFingerprint,
            requestIdempotencyKey,
          );
          return;
        }
        if (inputFingerprintRef.current !== inputFingerprint) {
          createIdempotencyStateRef.current.clearIfMatches(
            requestUserId,
            inputFingerprint,
            requestIdempotencyKey,
          );
          return;
        }
        const createdTarget = resolveInvestigationRunTarget(null, inputFingerprint, {
          investigationId: created.investigationId,
          shareToken: created.shareToken,
          inputFingerprint,
        });
        if (!createdTarget) return;
        pendingRun = createdTarget;
        pendingRunRef.current = {
          subject: requestUserId,
          target: createdTarget,
        };

        recordPreferenceObservationLocally(
          recognizeSearchBehavior({
          eventKey: `search:${created.investigationId}`,
            query: visibleQuery.trim(),
            selectedChips: visibleSelectedChips,
          }),
          visibleTasteProfile,
          personalizationSubject,
        );
      }

      if (!pendingRun) {
        if (!isCurrentSubject()) return;
        setErrorMessage('調査を開始できませんでした。もう一度お試しください。');
        return;
      }
      if (inputFingerprintRef.current !== inputFingerprint) {
        createIdempotencyStateRef.current.clearIfMatches(
          requestUserId,
          inputFingerprint,
          requestIdempotencyKey,
        );
        return;
      }

      // /research は server-side enqueue 完了までだけ待つ。調査本体の完了は
      // 結果画面の Realtime 購読で受けるため、非terminal status のまま即遷移する。
      let runResponse: Awaited<ReturnType<typeof runInvestigation>>;
      try {
        runResponse = await runInvestigation({
          investigationId: pendingRun.investigationId,
          searchAnchor: locationSearchAnchor(visibleLocation),
        });
      } catch (error) {
        if ((await getUserId()) !== requestUserId) return;
        if (inputFingerprintRef.current !== inputFingerprint) {
          createIdempotencyStateRef.current.clearIfMatches(
            requestUserId,
            inputFingerprint,
            requestIdempotencyKey,
          );
          return;
        }
        if (isUnknownRunAcceptance(error)) {
          // The POST may have committed before a client timeout/socket failure.
          // Reuse the created investigation and let its screen reconcile status
          // through its normal owner read/Realtime path; never create again.
          router.push({
            pathname: '/investigations/[id]',
            params: {
              id: pendingRun.investigationId,
              shareToken: pendingRun.shareToken,
              acceptance: 'checking',
            },
          });
          pendingRunRef.current = null;
          createIdempotencyStateRef.current.clearIfMatches(
            requestUserId,
            inputFingerprint,
            requestIdempotencyKey,
          );
          return;
        }
        throw error;
      }
      if ((await getUserId()) !== requestUserId) return;
      if (inputFingerprintRef.current !== inputFingerprint) {
        createIdempotencyStateRef.current.clearIfMatches(
          requestUserId,
          inputFingerprint,
          requestIdempotencyKey,
        );
        return;
      }
      if (runResponse.reason === 'location_anchor_required') {
        // current_location の anchor 欠落は実行失敗ではなく、入力を補えば再開できる
        // draft。汎用エラーへ混ぜず、場所選択を促す案内として表示する (#317)。
        setGuidanceMessage(
          `${LOCATION_ANCHOR_REQUIRED_MESSAGE} 「現在地を使う」を選択するか、上の「場所」欄に駅名・地名を入力してから、もう一度お試しください。`,
        );
        return;
      }

      router.push({
        pathname: '/investigations/[id]',
        params: { id: pendingRun.investigationId, shareToken: pendingRun.shareToken },
      });
      pendingRunRef.current = null;
      createIdempotencyStateRef.current.clearIfMatches(
        requestUserId,
        inputFingerprint,
        requestIdempotencyKey,
      );
    } catch {
      if (!isCurrentSubject()) return;
      setErrorMessage(
        `調査を開始できませんでした。${SEARCH_FIELD_GUIDANCE} 手動入力した場合は「この場所で検索条件にする」を押してください。通信状態も確認して、もう一度お試しください。`,
      );
    } finally {
      // auth切替直後のsubject照合でcreate前returnしても、開始処理自身が持つ
      // tokenでloadingを必ず解放する。後続の新しい開始処理があればtokenが
      // 置き換わるため、旧requestが新requestのloadingを解除することはない。
      if (activeCreateRunRef.current === requestRunToken) {
        activeCreateRunRef.current = null;
        activeCreateSubjectRef.current = null;
        setLoading(false);
        startInFlightRef.current = false;
      }
    }
  };

  const handleTermsAccepted = () => {
    setShowTermsModal(false);
    if (pendingStartAfterConsent) {
      setPendingStartAfterConsent(false);
      void handleStart();
    }
  };

  const canStart = !loading && !locationResolving && inputsMatchSubject && tasteProfileMatchesSubject && !!visibleQuery.trim();

  const handleTasteProfileChange = (nextProfile: TasteProfile) => {
    const observation = recognizeProfileEdit(
      visibleTasteProfile,
      nextProfile,
      `profile-edit:${Date.now()}:${visibleTasteProfile.likes.length}:${nextProfile.likes.length}:${visibleTasteProfile.avoid.length}:${nextProfile.avoid.length}`,
    );
    setTasteProfile(nextProfile);
    saveTasteProfile(nextProfile, personalizationSubject);
    recordPreferenceObservationLocally(observation, nextProfile, personalizationSubject);
  };

  const previewTags = Array.from(
    new Set([
      visibleLocation?.label ?? selectedScene?.location,
      selectedScene?.people,
      selectedScene?.budget,
      visibleTasteProfile.likes[0] ?? '肉',
      visibleSelectedChips[0] ?? '静かめ',
    ])
  ).filter((tag): tag is string => Boolean(tag)).slice(0, 5);

  const briefAnimatedStyle = reduceMotion
    ? undefined
    : {
        opacity: briefProgress,
        transform: [
          {
            translateY: briefProgress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }),
          },
        ],
      };

  const liveDotStyle = reduceMotion
    ? undefined
    : {
        opacity: livePulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }),
        transform: [
          { scale: livePulse.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.15] }) },
        ],
      };

  return (
    <View style={styles.wrapper}>
      <ScrollView
        ref={scrollRef}
        style={styles.scrollView}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={styles.page}
          onLayout={({ nativeEvent }) => {
            if (nativeEvent.layout.width > 0) setClientWidth(nativeEvent.layout.width);
          }}
        >
          <View testID="home-topbar" style={[styles.topbar, !isWide && styles.topbarCompact]}>
            <Image
              accessibilityLabel="OISINT ロゴ"
              source={BRAND_LOGO}
              resizeMode="contain"
              style={[styles.logoImage, isWide && styles.logoImageWide]}
            />
            <View style={[styles.topbarRight, !isWide && styles.topbarRightCompact]}>
              <View
                testID="home-topbar-nav"
                style={[styles.topbarNav, !isWide && styles.topbarNavCompact]}
              >
                <Link href="/concept" asChild>
                  <Pressable
                    testID="home-concept-video"
                    accessibilityRole="link"
                    accessibilityLabel="OISINTのコンセプトを開く"
                    style={styles.topbarHelp}
                  >
                    <Text style={styles.topbarHelpText}>コンセプト</Text>
                  </Pressable>
                </Link>
                <Pressable
                  testID="home-demo"
                  accessibilityRole="button"
                  accessibilityLabel="好み発見デモを開く"
                  onPress={() => router.push('/DEMO' as never)}
                  style={styles.topbarHelp}
                >
                  <Text style={styles.topbarHelpText}>好み発見</Text>
                </Pressable>
                <Pressable
                  testID="home-account"
                  accessibilityRole="button"
                  accessibilityLabel={
                    isAuthenticated
                      ? `アカウント設定を開く（${displayName || email || 'ログイン中'}）`
                      : 'アカウント画面を開く'
                  }
                  onPress={() => router.push('/account' as never)}
                  style={[styles.topbarHelp, isAuthenticated && styles.topbarAccountAuthenticated]}
                >
                  {isAuthenticated ? (
                    <View style={styles.accountBadgeDot} />
                  ) : null}
                  <Text
                    style={[styles.topbarHelpText, isAuthenticated && styles.topbarAccountText]}
                    numberOfLines={1}
                  >
                    {isAuthenticated ? (displayName || email?.split('@')[0] || 'アカウント') : 'ログイン'}
                  </Text>
                </Pressable>
                {isWide ? (
                  <Pressable
                    testID="home-support"
                    accessibilityRole="button"
                    accessibilityLabel="ヘルプとサポートを開く"
                    onPress={() => router.push({ pathname: '/support' } as never)}
                    style={styles.topbarHelp}
                  >
                    <Text style={styles.topbarHelpText}>サポート ↗</Text>
                  </Pressable>
                ) : null}
              </View>
              {isWide ? (
                <Text style={styles.topbarCaption}>
                  Open Intelligence for Savory Information, Navigation &amp; Taste
                </Text>
              ) : null}
              <View
                testID="home-live-pill"
                style={[styles.livePill, !isWide && styles.livePillCompact]}
              >
                <Animated.View style={[styles.liveDot, liveDotStyle]} />
                <Text style={styles.livePillText}>今夜の相談室</Text>
              </View>
            </View>
          </View>

          <View
            testID="lp-hero"
            style={[
              styles.hero,
              isWide && { flexDirection: 'row', alignItems: 'stretch' },
            ]}
          >
            <View style={styles.heroCopy}>
              <View style={styles.kickerRow}>
                {/* 3秒訴求の1行（誰が・何を・どう楽になるか）。文言の正本は docs/design/copy-audit.md（#221）。README冒頭と一致させる */}
                <Text testID="lp-pitch" style={styles.kicker}>幹事の店選びを、出典つきでみんなで決める</Text>
                <View style={styles.kickerRule} />
              </View>
              <Text style={[styles.heroTitle, !isWide && styles.heroTitleCompact]}>
                {isWide
                  ? '「どこ行く？」を、\n「ここがいい」に変える。'
                  : '「どこ行く？」を、\n「ここがいい」へ。'}
              </Text>
              <Text style={styles.heroLead}>
                店を当てるためじゃない。{ '\n' }人数も、予算も、その日の空気も持ち寄って、{ '\n' }みんなが納得できる一軒を見つけるための入口です。
              </Text>
              <View style={[styles.heroSignals, !isWide && styles.heroSignalsCompact]}>
                <View style={styles.heroSignal}>
                  <Text style={styles.heroSignalNumber}>01</Text>
                  <View>
                    <Text style={styles.heroSignalLabel}>人数・予算・気分</Text>
                    <Text style={styles.heroSignalNote}>うまく言葉にできなくても大丈夫</Text>
                  </View>
                </View>
                <View
                  style={[
                    styles.heroSignalDivider,
                    !isWide && styles.heroSignalDividerCompact,
                  ]}
                />
                <View style={styles.heroSignal}>
                  <Text style={styles.heroSignalNumber}>02</Text>
                  <View>
                    <Text style={styles.heroSignalLabel}>理由まで一緒に見る</Text>
                    <Text style={styles.heroSignalNote}>「ここがいい」をみんなで決める</Text>
                  </View>
                </View>
              </View>
            </View>

            <Animated.View
              testID="lp-brief-card"
              style={[styles.briefCard, isWide && styles.briefCardWide, briefAnimatedStyle]}
            >
              <View style={styles.briefTopline}>
                <Text style={styles.briefKicker}>今夜のしおり</Text>
                <Text style={styles.briefCode}>
                  {selectedScene ? `場面 ${selectedScene.index}` : '自由入力'}
                </Text>
              </View>
              <View style={styles.illustrationFrame}>
                <Image
                  source={BRAND_ART}
                  resizeMode="contain"
                  accessibilityLabel="フォークを囲んだ虫眼鏡のOISINTイラスト"
                  style={styles.illustrationImage}
                />
              </View>
              <Text style={styles.briefTitle}>
                みんなの条件を、{ '\n' }一枚にまとめる
              </Text>
              <View style={styles.briefRule} />
              <View style={styles.briefRows}>
                <BriefRow label="場面" value={selectedScene?.label ?? '自由入力'} />
                <BriefRow
                  label="気分"
                  value={selectedScene?.note ?? '場面を選ばず、条件を自由に入力'}
                />
                <View style={styles.briefTagRow}>
                  {previewTags.map((tag) => (
                    <View key={tag} style={styles.briefTag}>
                      <Text style={styles.briefTagText}>{tag}</Text>
                    </View>
                  ))}
                </View>
              </View>
              <Pressable
                testID="lp-brief-to-search"
                accessibilityRole="button"
                accessibilityLabel="検索欄へ移動して条件を整える"
                accessibilityHint="選んだ場面の条件が入った検索欄へ移動します"
                onPress={focusSearchInput}
                style={styles.briefBottomline}
              >
                <Text style={styles.briefBottomText}>場所 / 人数 / 予算 / 好み</Text>
                <Text style={styles.briefArrow}>↗</Text>
              </Pressable>
            </Animated.View>
          </View>

          <View style={[styles.sectionIntro, isCompact && styles.sectionIntroCompact]}>
            <View>
              <Text style={styles.sectionEyebrow}>まずは場面から</Text>
              <Text style={styles.sectionTitle}>まずは、今夜の状況を選ぶ。</Text>
            </View>
            <Text style={styles.sectionHint}>選んだあとに、場所や条件を自由に書き足せます。</Text>
          </View>

          <View
            testID="lp-scene-grid"
            accessibilityRole="radiogroup"
            accessibilityLabel="今夜の場面"
            style={[styles.sceneGrid, isWide && styles.sceneGridWide]}
          >
            {SCENES.map((scene) => {
              const selected = scene.id === selectedSceneId;
              return (
                <Pressable
                  key={scene.id}
                  testID={scene.id}
                  onPress={() => selectScene(scene)}
                  accessibilityRole="radio"
                  // ラジオは checked が選択状態のARIA表現。selectedはdivでは許可されない。
                  accessibilityState={{ checked: selected }}
                  aria-checked={selected}
                  style={[
                    styles.sceneCard,
                    { borderColor: selected ? scene.accent : colors.borderSoft },
                    selected && { backgroundColor: scene.soft },
                  ]}
                >
                  <View style={styles.sceneTopline}>
                    <Text style={[styles.sceneIndex, { color: scene.accent }]}>場面 {scene.index}</Text>
                    <Text style={[styles.sceneCheck, selected && { color: scene.accent }]}>
                      {selected ? '選択中' : '選ぶ'}
                    </Text>
                  </View>
                  <Text style={styles.sceneLabel}>{scene.label}</Text>
                  <Text style={styles.sceneTitle}>{scene.title}</Text>
                  <Text style={styles.sceneNote}>{scene.note}</Text>
                  <View style={styles.sceneMetaRow}>
                    <Text style={styles.sceneMeta}>{scene.location}</Text>
                    <Text style={styles.sceneMeta}>{scene.people}</Text>
                    <Text style={styles.sceneMeta}>{scene.budget}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            testID="lp-scene-clear"
            accessibilityRole="button"
            accessibilityLabel="シーンを選ばず自由入力する"
            accessibilityHint="シーンの入力を消去し、検索条件を自由に入力します"
            onPress={clearScene}
            style={styles.sceneClear}
          >
            <Text style={styles.sceneClearText}>シーンを選ばず自由入力</Text>
          </Pressable>

          {/* 操作カードと説明カードを独立させ、見出し・境界・余白で役割を分ける（#308） */}
          <View
            testID="lp-workbench"
            onLayout={({ nativeEvent }) => {
              workbenchOffsetY.current = nativeEvent.layout.y;
            }}
            style={[styles.workbench, isWide && styles.workbenchWide]}
          >
            <View
              testID="lp-workbench-main"
              style={[styles.workbenchMain, isWide && styles.workbenchMainWide]}
            >
              <View style={styles.workbenchHeading}>
                <View style={styles.workbenchHeadingCopy}>
                  <Text style={styles.sectionEyebrow}>ここから調べる</Text>
                  <Text style={styles.sectionTitle}>今夜の条件を、もう少しだけ具体的に。</Text>
                </View>
                <Text style={styles.workbenchMicrocopy}>新しい店探しをはじめる</Text>
              </View>

              <View style={styles.workbenchIntro}>
                <View style={styles.workbenchMarker}>
                  <Text style={styles.workbenchMarkerText}>店</Text>
                </View>
                <View style={styles.workbenchIntroCopy}>
                  <Text style={styles.workbenchTitle}>いまの気分を、そのまま書く</Text>
                  <Text style={styles.workbenchDescription}>
                    「静かめ」「駅から近い」「誰かが喜ぶ」も立派な条件。あとから場所と好みを足せます。
                  </Text>
                </View>
              </View>

              <LocationPicker
                value={visibleLocation}
                onChange={setLocation}
                onResolvingChange={setLocationResolving}
              />

              <TasteProfilePanel
                value={visibleTasteProfile}
                onChange={handleTasteProfileChange}
                isAuthenticated={isAuthenticated}
                onImportFromMaps={() => router.push('/account' as never)}
              />

              <PreferenceHearingCard
                key={authSubjectKey}
                profile={visibleTasteProfile}
                onProfileChange={setTasteProfile}
                subject={personalizationSubject}
              />

              <TermsConsentNotice testID="terms-consent-start" />

              <Text testID="home-query-guide" style={styles.searchGuide}>
                場所を指定した場合は、ここに人数・予算・料理・雰囲気などの条件を入力します。
              </Text>

              <View
                testID="lp-search-box"
                onLayout={({ nativeEvent }) => {
                  searchBoxOffsetY.current = nativeEvent.layout.y;
                }}
                style={[styles.searchBox, isWide && { flexDirection: 'row', alignItems: 'center' }]}
              >
                <TextInput
                  ref={queryInputRef}
                  testID="home-query"
                  style={styles.searchInput}
                  value={visibleQuery}
                  onChangeText={setQuery}
                  placeholder={
                    Platform.OS === 'web'
                      ? '例：3人で、3000円くらい。肉。カード可。静かめ。'
                      : '例：池袋で、みんなが話しやすい肉の店を探して'
                  }
                  placeholderTextColor={colors.textTertiary}
                  multiline
                  accessibilityLabel="探したいお店の条件"
                  accessibilityHint="場所は上の場所欄に入力し、ここには人数、予算、料理、好みなどを入力してください"
                />
                <Pressable
                  testID="home-start"
                  accessibilityRole="button"
                  accessibilityLabel={loading ? '調査を開始中' : '調査を開始'}
                  accessibilityHint={
                    canStart
                      ? '入力した条件で候補を探します'
                      : '検索条件を入力すると押せます'
                  }
                  accessibilityState={{ disabled: !canStart, busy: loading }}
                  onPress={handleStart}
                  disabled={!canStart}
                  style={[styles.searchButton, !canStart && styles.disabledButton]}
                >
                  {loading ? (
                    <ActivityIndicator color={colors.white} />
                  ) : (
                    <Text style={styles.searchButtonText}>捜査をはじめる ↗</Text>
                  )}
                </Pressable>
              </View>
              {/* #280: 要配慮個人情報（APPI 法20条2項）の注意喚起。raw_query は Gemini へ渡る */}
              <SensitiveInputNote />
              {guidanceMessage ? (
                <View
                  testID="home-location-guidance"
                  accessibilityLiveRegion="polite"
                  style={styles.locationGuidance}
                >
                  <Text style={styles.locationGuidanceText}>{guidanceMessage}</Text>
                </View>
              ) : null}
              {errorMessage ? (
                <UserActionError
                  testID="home-error"
                  message={errorMessage}
                  onRetry={() => void handleStart()}
                  retryLabel="同じ条件でもう一度試す"
                />
              ) : null}

              <View style={styles.filterRow}>
                {FILTER_CHIPS.map((chip) => {
                  const active = visibleSelectedChips.includes(chip);
                  return (
                    <Pressable
                      key={chip}
                      onPress={() => toggleChip(chip)}
                      accessibilityRole="checkbox"
                      accessibilityLabel={
                        active ? `${chip}を検索条件から外す` : `${chip}を検索条件に追加`
                      }
                      accessibilityState={{ checked: active }}
                      aria-checked={active}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {active ? '✓ ' : '+ '}{chip}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* 600px未満は global.css が縦積みへ切り替える（#220）。
                  nameInput の minWidth:190 がカード幅を超えて右へはみ出すため。 */}
              <View testID="lp-identity-row" style={styles.identityRow}>
                <View style={styles.identityCopy}>
                  <Text style={styles.identityLabel}>呼ばれる名前</Text>
                  <Text style={styles.identityHint}>共有したときに表示されます</Text>
                </View>
                <TextInput
                  testID="home-display-name"
                  accessibilityLabel="表示名"
                  accessibilityHint="任意です。共有したときに表示されます"
                  style={styles.nameInput}
                  value={localName}
                  onChangeText={setLocalName}
                  placeholder="表示名（任意）"
                  placeholderTextColor={colors.textTertiary}
                />
              </View>

              <View style={styles.examples}>
                <Text style={styles.examplesTitle}>別のシーン：</Text>
                {SCENES.map((scene) => (
                  <Pressable
                    key={scene.id}
                    testID={`quick-${scene.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${scene.label}のシーンを選ぶ`}
                    onPress={() => selectScene(scene)}
                    style={styles.exampleItem}
                  >
                    <Text style={styles.exampleItemText}>{scene.label}</Text>
                  </Pressable>
                ))}
              </View>

              <Text testID="impulse-exit" style={styles.impulseExit}>
                急ぎなら、場所と条件を一文だけで開始できます。調査の途中でも、みんなで条件を足せます。
              </Text>
            </View>

            <View
              testID="lp-workbench-aside"
              style={[styles.workbenchAside, isWide && styles.workbenchAsideWide]}
            >
              <View style={styles.asideLabelRow}>
                <Text style={styles.asideLabel}>選び方の流れ</Text>
                <Text style={styles.asideArrow}>↘</Text>
              </View>
              <Text style={styles.asideTitle}>話しながら、{ '\n' }候補が見えてくる。</Text>
              <Text style={styles.asideText}>
                候補を並べて終わりではなく、条件を持ち寄るたびに「じゃあ、ここはどう？」が見えてくる。
              </Text>
              <View style={styles.asideRule} />
              {PROCESS_STEPS.map((step) => (
                <View key={step.index} style={styles.processStep}>
                  <Text style={styles.processIndex}>{step.index}</Text>
                  <View style={styles.processCopy}>
                    <Text style={styles.processTitle}>{step.title}</Text>
                    <Text style={styles.processText}>{step.text}</Text>
                  </View>
                </View>
              ))}
              <View style={styles.asideStamp}>
                <Text style={styles.asideStampText}>理由を見ながら、ちゃんと決める</Text>
              </View>
            </View>
          </View>
        </View>
      </ScrollView>
      <TermsConsentModal
        visible={showTermsModal}
        onAccept={handleTermsAccepted}
        onClose={() => {
          setShowTermsModal(false);
          setPendingStartAfterConsent(false);
        }}
      />
      <Footer />
    </View>
  );
}

function BriefRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.briefRow}>
      <Text style={styles.briefRowLabel}>{label}</Text>
      <Text style={styles.briefRowValue} numberOfLines={2}>
        {value}
      </Text>
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
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 54,
  },
  page: {
    width: '100%',
    maxWidth: 1240,
    alignSelf: 'center',
  },
  topbar: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 18,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    backgroundColor: colors.white,
    marginBottom: 42,
  },
  topbarCompact: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 6,
  },
  logoImage: {
    width: 152,
    height: 46,
  },
  logoImageWide: {
    width: 184,
    height: 54,
  },
  topbarRight: {
    alignItems: 'flex-end',
    gap: 8,
  },
  topbarRightCompact: {
    width: '100%',
    alignItems: 'stretch',
  },
  topbarNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  topbarNavCompact: {
    justifyContent: 'space-between',
  },
  topbarHelp: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  topbarAccountAuthenticated: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.orangeFaint,
    borderWidth: 1,
    borderColor: colors.orange,
  },
  accountBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
  },
  topbarAccountText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '800',
    maxWidth: 120,
  },
  topbarHelpText: {
    color: colors.orange,
    fontSize: 11,
    fontWeight: '800',
  },
  topbarCaption: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textTertiary,
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    backgroundColor: colors.canvas,
  },
  livePillCompact: {
    alignSelf: 'flex-end',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.orange,
  },
  livePillText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.text,
  },
  hero: {
    flexDirection: 'column',
    gap: 34,
    marginBottom: 58,
  },
  heroWide: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 54,
  },
  heroCopy: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 12,
  },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  kicker: {
    fontFamily: fonts.brand,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: colors.orange,
  },
  kickerRule: {
    width: 54,
    height: 1,
    backgroundColor: colors.orange,
    opacity: 0.7,
  },
  heroTitle: {
    maxWidth: 680,
    fontSize: 44,
    lineHeight: 58,
    fontWeight: '800',
    letterSpacing: -1.8,
    color: colors.text,
  },
  heroTitleCompact: {
    fontSize: 34,
    lineHeight: 48,
    letterSpacing: -1.4,
  },
  heroLead: {
    maxWidth: 570,
    marginTop: 20,
    fontSize: 14,
    lineHeight: 26,
    color: colors.textSecondary,
  },
  heroSignals: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    marginTop: 32,
  },
  heroSignalsCompact: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 12,
    marginTop: 26,
  },
  heroSignal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  heroSignalNumber: {
    fontFamily: fonts.brand,
    fontSize: 18,
    lineHeight: 30,
    fontWeight: '800',
    color: colors.orange,
  },
  heroSignalLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text,
  },
  heroSignalNote: {
    marginTop: 2,
    fontSize: 10,
    color: colors.textTertiary,
  },
  heroSignalDivider: {
    width: 1,
    height: 32,
    backgroundColor: colors.border,
  },
  heroSignalDividerCompact: {
    width: '100%',
    height: 1,
  },
  briefCard: {
    minHeight: 480,
    flexGrow: 0,
    flexShrink: 1,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  // 上限付き固定幅（#220）。global.css の width:min(390px,100%) と値を揃え、
  // 親が 390px 未満でも viewport からはみ出さないようにする。
  briefCardWide: {
    width: 390,
    maxWidth: '100%',
  },
  briefTopline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  briefKicker: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.orange,
  },
  illustrationFrame: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 248,
    marginTop: 16,
    overflow: 'hidden',
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  illustrationImage: {
    width: '100%',
    height: 250,
  },
  briefCode: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textTertiary,
  },
  briefTitle: {
    marginTop: 18,
    fontSize: 24,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.7,
    color: colors.text,
  },
  briefRule: {
    height: 1,
    marginVertical: 22,
    backgroundColor: colors.borderSoft,
  },
  briefRows: {
    gap: 15,
  },
  briefRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 18,
  },
  briefRowLabel: {
    width: 55,
    paddingTop: 2,
    fontSize: 9,
    fontWeight: '800',
    color: colors.textTertiary,
  },
  briefRowValue: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.text,
  },
  briefTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 3,
  },
  briefTag: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.activeBg,
  },
  briefTagText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  briefBottomline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 32,
    paddingTop: 15,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  briefBottomText: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.textTertiary,
  },
  briefArrow: {
    fontSize: 18,
    color: colors.orange,
  },
  sectionIntro: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 20,
    marginBottom: 16,
  },
  sectionIntroCompact: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 8,
  },
  sectionEyebrow: {
    fontFamily: fonts.brand,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: colors.orange,
  },
  sectionTitle: {
    marginTop: 7,
    fontSize: 21,
    lineHeight: 31,
    fontWeight: '800',
    letterSpacing: -0.5,
    color: colors.text,
  },
  sectionHint: {
    maxWidth: 280,
    paddingBottom: 3,
    fontSize: 11,
    lineHeight: 18,
    textAlign: 'right',
    color: colors.textSecondary,
  },
  sceneGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 11,
    marginBottom: 54,
  },
  sceneGridWide: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
  },
  sceneCard: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '48%',
    minWidth: 0,
    minHeight: 174,
    justifyContent: 'space-between',
    padding: 17,
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },
  sceneClear: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    marginTop: -42,
    marginBottom: 42,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  sceneClearText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  sceneTopline: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sceneIndex: {
    fontFamily: fonts.brand,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  sceneCheck: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textTertiary,
  },
  sceneLabel: {
    marginTop: 22,
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  sceneTitle: {
    marginTop: 4,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '800',
    letterSpacing: -0.3,
    color: colors.text,
  },
  sceneNote: {
    marginTop: 5,
    fontSize: 10,
    lineHeight: 16,
    color: colors.textSecondary,
  },
  sceneMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 15,
  },
  sceneMeta: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.bg,
    fontSize: 9,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  // 操作カード内の見出し行。説明カードと独立した見出しを持たせる（#308）
  workbenchHeading: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  workbenchHeadingCopy: {
    flex: 1,
  },
  workbenchMicrocopy: {
    paddingBottom: 3,
    fontSize: 10,
    fontWeight: '700',
    color: colors.textTertiary,
  },
  // 外枠はカードではなく透明なレイアウト行。操作と説明は別カードとして余白で分離する
  workbench: {
    flexDirection: 'column',
    gap: 26,
  },
  workbenchWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 26,
  },
  // 操作カード: 白背景 + 上辺アクセントで「ここから調べる」主役を示す（影は使わない #309）
  workbenchMain: {
    gap: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopWidth: 3,
    borderTopColor: colors.orange,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },
  workbenchMainWide: {
    flex: 1,
    padding: 28,
  },
  workbenchIntro: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    paddingBottom: 4,
  },
  workbenchMarker: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.orange,
  },
  workbenchMarkerText: {
    fontFamily: fonts.brand,
    fontSize: 14,
    fontWeight: '800',
    color: colors.surface,
  },
  workbenchIntroCopy: {
    flex: 1,
    gap: 3,
  },
  workbenchTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text,
  },
  workbenchDescription: {
    fontSize: 11,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  searchGuide: {
    fontSize: 11,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  searchBox: {
    gap: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },
  searchBoxWide: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchInput: {
    flex: 1,
    minHeight: 48,
    padding: 0,
    fontSize: 13,
    lineHeight: 21,
    color: colors.text,
    textAlignVertical: 'top',
  },
  searchButton: {
    minWidth: 154,
    maxWidth: '100%',
    minHeight: 46,
    paddingHorizontal: 17,
    borderRadius: 3,
    backgroundColor: colors.black,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchButtonText: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.surface,
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
    lineHeight: 18,
  },
  locationGuidance: {
    padding: 11,
    borderWidth: 1,
    borderColor: colors.orange,
    borderRadius: radius.sm,
    backgroundColor: colors.activeBg,
  },
  locationGuidanceText: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.text,
  },
  disabledButton: {
    backgroundColor: colors.border,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  chip: {
    minHeight: 29,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.pill,
    backgroundColor: colors.chipBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: {
    borderColor: colors.orange,
    backgroundColor: colors.activeBg,
  },
  chipText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: colors.orange,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 3,
  },
  identityCopy: {
    gap: 2,
  },
  identityLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text,
  },
  identityHint: {
    fontSize: 10,
    color: colors.textTertiary,
  },
  nameInput: {
    minWidth: 190,
    maxWidth: 260,
    minHeight: 38,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    fontSize: 12,
    color: colors.text,
  },
  examples: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 7,
    marginTop: 2,
  },
  examplesTitle: {
    fontSize: 10,
    color: colors.textTertiary,
  },
  exampleItem: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.pill,
    backgroundColor: colors.chipBg,
  },
  exampleItemText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  impulseExit: {
    fontSize: 10,
    lineHeight: 16,
    color: colors.textTertiary,
  },
  // 説明カード: 濃色ベージュ + 影なしの独立カードで「読みもの」であることを示す
  workbenchAside: {
    gap: 16,
    padding: 22,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: 4,
    backgroundColor: colors.surfaceSoft,
  },
  workbenchAsideWide: {
    flex: 1,
    padding: 28,
  },
  asideLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  asideLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.orange,
  },
  asideArrow: {
    fontSize: 20,
    color: colors.orange,
  },
  asideTitle: {
    fontSize: 24,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.7,
    color: colors.text,
  },
  asideText: {
    fontSize: 11,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  asideRule: {
    height: 1,
    backgroundColor: colors.border,
  },
  processStep: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  processIndex: {
    width: 22,
    paddingTop: 1,
    fontFamily: fonts.brand,
    fontSize: 10,
    fontWeight: '800',
    color: colors.orange,
  },
  processCopy: {
    flex: 1,
    gap: 3,
  },
  processTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.text,
  },
  processText: {
    fontSize: 10,
    lineHeight: 16,
    color: colors.textSecondary,
  },
  asideStamp: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 2,
  },
  asideStampText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.textSecondary,
  },
});
