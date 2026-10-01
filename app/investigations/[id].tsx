import { router, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { ComparisonPanel, EvidencePanel, VotePanel } from '@/components/BottomPanels';
import { CandidateCard } from '@/components/CandidateCard';
import { CandidateDetail } from '@/components/CandidateDetail';
import { CorrectionLink } from '@/components/CorrectionLink';
import { DisclaimerNote } from '@/components/DisclaimerNote';
import { Footer } from '@/components/Footer';
import { GrowthLoopProgress } from '@/components/GrowthLoopProgress';
import { InvestigationEventLog } from '@/components/InvestigationEventLog';
import { InvestigationDeleteControl } from '@/components/InvestigationDeleteControl';
import { MemberList } from '@/components/MemberList';
import { NotificationToast } from '@/components/NotificationToast';
import { ProgressIndicator } from '@/components/ProgressIndicator';
import { RankingDisclosure } from '@/components/RankingDisclosure';
import { RecallPreferenceNote } from '@/components/RecallPreferenceNote';
import { RequirementList } from '@/components/RequirementList';
import { SensitiveInputNote } from '@/components/SensitiveInputNote';
import { ShareQrCode } from '@/components/ShareQrCode';
import { ShareTokenRotate } from '@/components/ShareTokenRotate';
import { ShareVisibilityNote } from '@/components/ShareVisibilityNote';
import { UserActionError } from '@/components/UserActionError';
import { VisibilityToggle } from '@/components/VisibilityToggle';
import { useInvestigation } from '@/hooks/useInvestigation';
import { useInvestigationNotifications } from '@/hooks/useInvestigationNotifications';
import { usePlaceFeedback } from '@/hooks/usePlaceFeedback';
import { usePlaceFacts } from '@/hooks/usePlaceFacts';
import {
  addRequirement,
  isLiveDataProvider,
  removeRequirement,
  rerankInvestigation,
  runInvestigation,
  setVote,
} from '@/lib/api';
import { deleteInvestigation } from '@/lib/investigationRepository';
import { recordGrowthReturn } from '@/lib/growthLoop';
import {
  recognizeCandidateBehavior,
  type CandidateBehaviorAction,
} from '@/lib/behaviorRecognition';
import { recordPreferenceObservationLocally } from '@/lib/personalization';
import { saveResearchAgainPrefill } from '@/lib/researchPrefill';
import { buildShareUrl } from '@/lib/shareUrl';
import { retryAfterAmbiguousMutation } from '@/lib/userActionRetry';
import { LOCATION_ANCHOR_REQUIRED_MESSAGE } from '@/lib/validation';
import { useAuth } from '@/providers/AuthProvider';
import { colors, radius } from '@/theme';
import type { Candidate, Requirement, VoteValue } from '@/types';

type RerankTrigger = 'vote' | 'requirement_added' | 'requirement_removed';
type ActionRetry =
  | { kind: 'vote'; candidateId: string; value: VoteValue; comment?: string }
  | { kind: 'refresh' }
  | { kind: 'rerank'; trigger: RerankTrigger }
  | null;

// 公開ページの URL（#115）。Web の origin から組み立て、非Webでは相対パスを返す。
function publicPageUrl(investigationId: string): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/p/${investigationId}`;
  }
  return `/p/${investigationId}`;
}

function isPermissionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /(権限|permission|forbidden|403)/iu.test(message);
}

export default function InvestigationScreen() {
  const { id, shareToken, joined } = useLocalSearchParams<{
    id: string;
    shareToken?: string;
    joined?: string;
  }>();
  const { userId, isAnonymous, status: authStatus } = useAuth();
  const investigationSubjectKey = `${authStatus}:${isAnonymous ? `anonymous:${userId ?? 'unknown'}` : userId ?? 'signed_out'}`;
  const personalizationSubject = useMemo(
    () => userId
      ? { id: userId, kind: isAnonymous ? ('anonymous' as const) : ('permanent' as const) }
      : undefined,
    [isAnonymous, userId],
  );
  const { investigation, loading, error, retry } = useInvestigation(id, investigationSubjectKey);
  const { width } = useWindowDimensions();
  const isWide = width >= 760;
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removingRequirementId, setRemovingRequirementId] = useState<string | null>(null);
  const [newRequirement, setNewRequirement] = useState('');
  const [shareCopied, setShareCopied] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionRetry, setActionRetry] = useState<ActionRetry>(null);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rotatedShareToken, setRotatedShareToken] = useState<string | null>(null);
  // React state更新より先に到達する連打も含め、書き込みと再評価を一度に一つへ絞る。
  const actionInFlightRef = useRef(false);
  const voteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voteInFlightKeysRef = useRef(new Set<string>());
  const returnRecordedKeysRef = useRef(new Set<string>());

  // in-app 通知（#114）。調査完了・新規投票を Realtime で受け toast 表示する。
  const { notifications } = useInvestigationNotifications(investigation?.id, investigationSubjectKey);
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>([]);
  const visibleNotifications = notifications.filter(
    (notification) => !dismissedNotificationIds.includes(notification.id)
  );

  // 選択中候補の place_facts（§44.5）。early return より前に置く（rules of hooks）。
  const selectedPlaceId = (
    investigation?.candidates.find((c) => c.id === selectedCandidateId) ??
    investigation?.candidates[0]
  )?.place.id;
  const placeFacts = usePlaceFacts(selectedPlaceId);
  const placeFeedback = usePlaceFeedback(selectedPlaceId, placeFacts, { userId, isAnonymous });

  // 共有参加直後はreturnに数えない。後日の直リンク/通知からの再訪だけを、
  // participant stateの初回timestampへ圧縮する（失敗しても本体表示は継続）。
  useEffect(() => {
    if (!investigation?.id || !userId || joined === '1') return;
    const key = `${investigationSubjectKey}:${investigation.id}`;
    if (returnRecordedKeysRef.current.has(key)) return;
    returnRecordedKeysRef.current.add(key);
    void recordGrowthReturn(investigation.id).catch(() => {
      returnRecordedKeysRef.current.delete(key);
    });
  }, [investigation?.id, investigationSubjectKey, joined, userId]);

  const collaborationRefreshKey = useMemo(() => {
    if (!investigation) return 'loading';
    return [
      investigation.members.length,
      investigation.requirements.length,
      ...investigation.candidates.map((candidate) =>
        `${candidate.id}:${candidate.rank}:${Object.keys(candidate.votes).length}`
      ),
    ].join('|');
  }, [investigation]);

  // 共有リンク再発行（#177）後は URL パラメータの旧 token より新 token を優先する。
  // 画面遷移で shareToken パラメータが落ちた場合も、調査本体が持つ share_token を使う（§25.4）。
  const effectiveShareToken = rotatedShareToken ?? shareToken;
  const shareUrl = buildShareUrl({
    paramToken: effectiveShareToken,
    investigationShareToken: investigation?.shareToken,
    investigationId: id,
  });

  const handleShare = useCallback(() => {
    setActionError('');
    setActionRetry(null);
    if (typeof window !== 'undefined' && window.navigator?.clipboard) {
      window.navigator.clipboard.writeText(shareUrl).then(
        () => {
          setShareCopied(true);
          window.setTimeout(() => setShareCopied(false), 2200);
        },
        () => {
          setShareCopied(false);
          setActionError('共有URLをコピーできませんでした。URLを選択してコピーしてください。');
        }
      );
    } else {
      setActionError('この環境では共有URLを自動コピーできません。URLを選択してコピーしてください。');
    }
  }, [shareUrl]);

  const handleAddRequirement = useCallback(async () => {
    const text = newRequirement.trim();
    if (!text || !investigation) return;
    if (actionInFlightRef.current) return;

    actionInFlightRef.current = true;
    setActionError('');
    setActionRetry(null);
    if (!userId) {
      setActionError('条件を追加する権限がありません。');
      actionInFlightRef.current = false;
      return;
    }
    try {
      await addRequirement(investigation.id, text, userId);
    } catch (error) {
      // 応答喪失時は server 側で成功済みの可能性があるため、同じ INSERT を直接再送しない。
      if (isPermissionFailure(error)) {
        setActionError('条件を追加できませんでした。権限を確認してください。');
      } else {
        setActionError('条件の追加結果を確認できませんでした。画面を更新して確認してください。');
        setActionRetry({ kind: retryAfterAmbiguousMutation('add-requirement') });
      }
      actionInFlightRef.current = false;
      return;
    }

    setNewRequirement('');
    setAdding(false);
    try {
      await rerankInvestigation({
        investigationId: investigation.id,
        trigger: 'requirement_added',
      });
    } catch {
      setActionError('条件は追加されましたが、候補の再評価に失敗しました。再試行してください。');
      setActionRetry({ kind: 'rerank', trigger: 'requirement_added' });
    } finally {
      actionInFlightRef.current = false;
    }
  }, [investigation, newRequirement, userId]);

  const handleRemoveRequirement = useCallback(async (requirement: Requirement) => {
    if (!investigation || !userId || removingRequirementId || actionInFlightRef.current) return;

    actionInFlightRef.current = true;
    setActionError('');
    setActionRetry(null);
    setRemovingRequirementId(requirement.id);
    try {
      await removeRequirement(investigation.id, requirement.id, userId);
    } catch (error) {
      // DELETE も応答だけ失われる場合があるため、同じ削除を直接再送しない。
      if (isPermissionFailure(error)) {
        setActionError('条件を削除できませんでした。権限を確認してください。');
      } else {
        setActionError('条件の削除結果を確認できませんでした。画面を更新して確認してください。');
        setActionRetry({ kind: retryAfterAmbiguousMutation('remove-requirement') });
      }
      setRemovingRequirementId(null);
      actionInFlightRef.current = false;
      return;
    }

    try {
      await rerankInvestigation({
        investigationId: investigation.id,
        trigger: 'requirement_removed',
      });
    } catch {
      setActionError('条件は削除されましたが、候補の再評価に失敗しました。再試行してください。');
      setActionRetry({ kind: 'rerank', trigger: 'requirement_removed' });
    } finally {
      setRemovingRequirementId(null);
      actionInFlightRef.current = false;
    }
  }, [investigation, removingRequirementId, userId]);

  const handleRetryRun = useCallback(async () => {
    if (!investigation) {
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      retry();
      actionInFlightRef.current = false;
      return;
    }
    if (actionInFlightRef.current) return;

    actionInFlightRef.current = true;
    setActionError('');
    setActionRetry(null);
    setRetrying(true);
    try {
      const response = await runInvestigation({ investigationId: investigation.id });
      if (response.reason === 'location_anchor_required') {
        setActionError(LOCATION_ANCHOR_REQUIRED_MESSAGE);
        return;
      }
    } catch {
      setActionError('調査を再試行できませんでした。時間を置いてもう一度お試しください。');
    } finally {
      setRetrying(false);
      actionInFlightRef.current = false;
    }
  }, [investigation, retry]);

  const handleDeleteInvestigation = useCallback(async () => {
    if (!investigation || deleting) return;
    setActionError('');
    setActionRetry(null);
    setDeleting(true);
    try {
      await deleteInvestigation(investigation.id);
      // 削除後に元の raw_query / share token を含むURLへ戻らない。
      router.replace('/');
    } catch {
      setActionError('調査を削除できませんでした。権限と通信状態を確認してください。');
      setDeleting(false);
    }
  }, [deleting, investigation]);

  const handleResearchAgain = useCallback(() => {
    // raw_query は owner 専用列。joined member には live provider が空文字を返すため、
    // 条件引継ぎ導線も owner のみに限定して共有画面からの漏えいを防ぐ (#151 / §33)。
    if (!investigation?.rawQuery) return;
    // Web では sessionStorage 経由で raw_query をトップ画面へ渡す。非Web環境や
    // 保存失敗時は prefill なしでトップへ戻るだけにする（prefill は補助機能）。
    saveResearchAgainPrefill(investigation.rawQuery, personalizationSubject);
    router.push('/');
  }, [investigation, personalizationSubject]);

  const handleVote = useCallback(
    (candidate: Candidate, value: VoteValue, comment?: string) => {
      if (!investigation || !userId) return;
      const voteKey = `${investigation.id}:${candidate.id}`;
      if (voteInFlightKeysRef.current.has(voteKey)) return;

      voteInFlightKeysRef.current.add(voteKey);
      setActionError('');
      setActionRetry(null);
      if (voteTimer.current) clearTimeout(voteTimer.current);

      void (async () => {
        try {
          await setVote(
            investigation.id,
            candidate.id,
            value,
            userId,
            comment,
          );
          rememberCandidateBehavior(
            candidate,
            value > 0 ? 'vote_up' : value < 0 ? 'vote_down' : null,
            `vote:${investigation.id}:${candidate.id}:${value}`,
            investigation.requirements,
            personalizationSubject,
          );
        } catch {
          setActionError('投票を保存できませんでした。通信状態を確認してください。');
          setActionRetry({
            kind: 'vote',
            candidateId: candidate.id,
            value,
            ...(comment ? { comment } : {}),
          });
          voteInFlightKeysRef.current.delete(voteKey);
          return;
        }
        // 同じ候補への保存が完了したら再操作を許可する。DB側のupsertが最終的な重複防止を担う。
        voteInFlightKeysRef.current.delete(voteKey);

        voteTimer.current = setTimeout(() => {
          void rerankInvestigation({ investigationId: investigation.id, trigger: 'vote' })
            .catch(() => {
              setActionError('投票を保存しましたが、順位の更新に失敗しました。再試行してください。');
              setActionRetry({ kind: 'rerank', trigger: 'vote' });
            })
            .finally(() => {
              voteTimer.current = null;
            });
        }, 500);
      })();
    },
    [investigation, personalizationSubject, userId]
  );

  const handleRetryAction = useCallback(async () => {
    const pending = actionRetry;
    if (!pending || !investigation || actionInFlightRef.current) return;
    if (!userId && pending.kind !== 'rerank' && pending.kind !== 'refresh') {
      setActionError('この操作を再試行する権限がありません。');
      return;
    }

    actionInFlightRef.current = true;
    setActionError('');
    try {
      if (pending.kind === 'vote') {
        await setVote(
          investigation.id,
          pending.candidateId,
          pending.value,
          userId!,
          pending.comment,
        );
        await rerankInvestigation({ investigationId: investigation.id, trigger: 'vote' });
      } else if (pending.kind === 'refresh') {
        // 曖昧な add/remove の応答は直接再送せず、最新snapshotで存在を確認する。
        retry();
      } else {
        await rerankInvestigation({
          investigationId: investigation.id,
          trigger: pending.trigger,
        });
      }
      setActionRetry(null);
    } catch {
      const message =
        pending.kind === 'vote'
          ? '投票を再試行できませんでした。通信状態を確認してください。'
          : pending.kind === 'refresh'
            ? '画面を更新できませんでした。通信状態を確認して、もう一度お試しください。'
              : '候補の再評価を再試行できませんでした。時間を置いてもう一度お試しください。';
      setActionError(message);
      setActionRetry(pending);
    } finally {
      setRemovingRequirementId(null);
      actionInFlightRef.current = false;
    }
  }, [actionRetry, investigation, retry, userId]);

  // shareToken パラメータ付きで開かれ得るURLのため検索エンジンへ露出させない
  // （#179 / spec.md §8, §33）。全 return パスに含める。
  const noindexMeta = (
    <Head>
      <meta name="robots" content="noindex, nofollow" />
    </Head>
  );

  if (loading) {
    return (
      <>
        {noindexMeta}
        <LoadingState />
      </>
    );
  }

  if (!investigation) {
    return (
      <View testID="inv-load-error" style={styles.center}>
        {noindexMeta}
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error ?? '調査を読み込めませんでした'}
        </Text>
        <Pressable
          testID="inv-load-retry"
          accessibilityRole="button"
          accessibilityLabel="調査を再読み込み"
          onPress={retry}
          style={styles.retryButton}
        >
          <Text style={styles.retryButtonText}>再読み込み</Text>
        </Pressable>
      </View>
    );
  }

  const selectedCandidate =
    investigation.candidates.find((c) => c.id === selectedCandidateId) ??
    investigation.candidates[0];
  const currentMember = investigation.members.find((member) => member.id === userId);
  const canEditRequirements = currentMember?.role === 'owner' || currentMember?.role === 'editor';
  const canResearchAgain = currentMember?.role === 'owner' && investigation.rawQuery.length > 0;
  // #312: rank は §17 の score のまま保持する。一方で rank=1 に未評価/unknown の
  // must が残る場合、結果一覧を「おすすめ」と断定しない。
  const topCandidate = [...investigation.candidates].sort((a, b) => a.rank - b.rank)[0];
  const topCandidateHasUnresolvedMust = Boolean(
    topCandidate &&
      investigation.requirements
        .filter((requirement) => requirement.priority === 'must')
        .some((requirement) => {
          const evaluation = topCandidate.evaluations.find(
            (entry) => entry.requirementId === requirement.id
          );
          return !evaluation || evaluation.state === 'unknown';
        })
  );

  return (
    <View style={styles.wrapper}>
      {noindexMeta}
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scroll}>
        {actionError ? (
          <UserActionError
            testID="inv-action-error"
            message={actionError}
            onRetry={actionRetry ? () => void handleRetryAction() : undefined}
            retryLabel="操作をもう一度試す"
          />
        ) : null}

        {investigation.status === 'failed' && (
          <View testID="inv-failed" style={styles.failedState}>
            <Text accessibilityRole="alert" style={styles.failedText}>
              調査の実行に失敗しました。
            </Text>
            <Pressable
              testID="inv-retry"
              accessibilityRole="button"
              accessibilityLabel="調査を再試行"
              onPress={() => void handleRetryRun()}
              disabled={retrying}
              style={[styles.retryButton, retrying && styles.disabledButton]}
            >
              {retrying ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.retryButtonText}>再試行</Text>}
            </Pressable>
          </View>
        )}

        <View testID="inv-context" style={styles.header}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>{investigation.title}</Text>
            <Pressable
              testID="inv-share"
              accessibilityRole="button"
              accessibilityLabel={shareCopied ? '共有URLをコピーしました' : '共有URLをコピー'}
              onPress={handleShare}
              disabled={investigation.candidates.length === 0}
              style={[
                styles.shareButton,
                investigation.candidates.length === 0 && styles.disabledShareButton,
              ]}
            >
              <Text style={styles.shareButtonText}>{shareCopied ? 'コピーしました' : '共有する'}</Text>
            </Pressable>
          </View>
          <Text testID="inv-share-url" style={styles.subtitle}>{shareUrl}</Text>
          {/* 共有URLの QR コード（#93 / spec.md §25.4）。候補0件では共有ボタンと同様に出さない */}
          {investigation.candidates.length > 0 ? (
            <ShareQrCode testID="inv-share-qr" url={shareUrl} />
          ) : null}
          {/* 共有前に「誰に何が見えるか」を明示（#275 / 電気通信事業法4条）: 共有ボタン・共有URLの近傍に常設 */}
          <ShareVisibilityNote />
          {currentMember?.role === 'owner' && (
            <ShareTokenRotate
              investigationId={investigation.id}
              userId={userId ?? undefined}
              onRotated={setRotatedShareToken}
            />
          )}
          <MemberList members={investigation.members} />

          {/* 公開/非公開切り替え（#115）。owner のみ表示。PATCH は owner 以外 403 */}
          <VisibilityToggle
            investigationId={investigation.id}
            visibility={investigation.visibility ?? 'private'}
            canToggle={currentMember?.role === 'owner'}
            onVisibilityChange={() => {
              // 購読が次の snapshot で反映する。ローカルでは即時反映しない。
            }}
          />
          {investigation.visibility === 'public' && (
            <Text testID="inv-public-link" style={styles.publicLinkNote}>
              公開ページ: {publicPageUrl(investigation.id)}
            </Text>
          )}
          <InvestigationDeleteControl
            canDelete={
              isLiveDataProvider &&
              currentMember?.role === 'owner' &&
              currentMember?.id === userId
            }
            busy={deleting}
            onDelete={handleDeleteInvestigation}
          />
        </View>

        <View testID="inv-progress">
          <ProgressIndicator status={investigation.status} />
        </View>

        <GrowthLoopProgress
          investigationId={investigation.id}
          refreshKey={collaborationRefreshKey}
          fallbackParticipantCount={investigation.members.filter((member) => member.role !== 'owner').length}
        />

        {/* 調査ログ（investigation_events）の進捗表示（#332） */}
        <InvestigationEventLog investigation={investigation} />

        {/* 「前回このメンバーは…」過去嗜好表示（#111 / §16.1）。recall_preference の集計値のみ */}
        <RecallPreferenceNote investigation={investigation} />

        <RequirementList
          requirements={investigation.requirements}
          onAddPress={canEditRequirements ? () => setAdding(true) : undefined}
          onRemovePress={canEditRequirements ? handleRemoveRequirement : undefined}
          removingRequirementId={removingRequirementId}
        />

        {adding && (
          <View style={styles.addRequirement}>
            <TextInput
              testID="inv-requirement-input"
              accessibilityLabel="追加する条件"
              accessibilityHint="調査に追加したい条件を入力してください"
              style={styles.addInput}
              value={newRequirement}
              onChangeText={setNewRequirement}
              placeholder="追加する条件"
              placeholderTextColor={colors.placeholder}
            />
            {/* #280: 要配慮個人情報（APPI 法20条2項）の注意喚起。追加条件も Gemini へ渡る */}
            <SensitiveInputNote />
            <View style={styles.addButtons}>
              <Pressable
                testID="inv-requirement-cancel"
                accessibilityRole="button"
                accessibilityLabel="条件追加をキャンセル"
                onPress={() => setAdding(false)}
                style={styles.cancelButton}
              >
                <Text style={styles.cancelButtonText}>キャンセル</Text>
              </Pressable>
              <Pressable
                testID="inv-requirement-submit"
                accessibilityRole="button"
                accessibilityLabel="条件を追加"
                onPress={handleAddRequirement}
                disabled={!newRequirement.trim()}
                style={[
                  styles.addButton,
                  !newRequirement.trim() && styles.disabledButton,
                ]}
              >
                <Text style={styles.addButtonText}>追加</Text>
              </Pressable>
            </View>
          </View>
        )}

        <View testID="inv-candidates" style={styles.candidatesSection}>
          <View style={styles.sectionHeading}>
            <Text testID="inv-candidates-heading" style={styles.heading}>
              {topCandidateHasUnresolvedMust ? '候補の比較結果' : 'おすすめのレストラン'}
            </Text>
            <Text style={styles.headingCount}>
              {investigation.candidates.length}件の候補が見つかりました
            </Text>
          </View>
          {/* 情報の限界表示（#266）: 候補カード一覧に常設 */}
          <DisclaimerNote />
          {/* ランキングの性質開示（#269）: 順位の意味・投票の影響・非金銭性を結果画面に常設 */}
          <RankingDisclosure />
          <View style={[styles.candidateList, isWide && styles.candidateListWide]}>
            {investigation.candidates.length === 0 && investigation.status === 'complete' ? (
              <View testID="inv-empty-complete" accessibilityLiveRegion="polite">
                <Text testID="inv-empty" accessibilityRole="alert" style={styles.empty}>
                  条件に合う候補店が見つかりませんでした。条件を追加して再検索してください。
                </Text>
              </View>
            ) : investigation.candidates.length === 0 && investigation.status === 'failed' ? (
              <View testID="inv-empty-failed" accessibilityLiveRegion="polite">
                <Text testID="inv-empty" accessibilityRole="alert" style={styles.empty}>
                  調査の実行に失敗し、候補店が見つかりませんでした。上の再試行をお試しください。
                </Text>
              </View>
            ) : investigation.candidates.length === 0 ? (
                <View accessibilityLiveRegion="polite" style={styles.loadingCandidates}>
                  <ActivityIndicator />
                  <Text style={styles.empty}>候補店を探索中です…</Text>
                  <View style={styles.skeletonList}>
                    {[1, 2, 3].map((index) => (
                      <CandidateSkeleton key={index} index={index} />
                    ))}
                  </View>
                </View>
            ) : null}
            {investigation.candidates.map((candidate) => (
              <View key={candidate.id} style={isWide ? styles.candidateCell : undefined}>
                <CandidateCard
                  candidate={candidate}
                  members={investigation.members}
                  requirements={investigation.requirements}
                  currentUserId={userId ?? undefined}
                  isSelected={candidate.id === selectedCandidate?.id}
                  onPress={() => {
                    setSelectedCandidateId(candidate.id);
                    rememberCandidateBehavior(
                      candidate,
                      'candidate_opened',
                      `candidate-open:${investigation.id}:${candidate.id}`,
                      investigation.requirements,
                      personalizationSubject,
                    );
                  }}
                />
              </View>
            ))}
          </View>
          {canResearchAgain && (
            <Pressable
              testID="inv-research-again"
              accessibilityRole="button"
              accessibilityLabel="条件を変えてもう一度調べる"
              accessibilityHint="検索文を引き継いでトップ画面に戻ります"
              onPress={handleResearchAgain}
              style={styles.researchAgainButton}
            >
              <Text style={styles.researchAgainButtonText}>条件を変えてもう一度調べる</Text>
            </Pressable>
          )}
        </View>

        {investigation.candidates.length > 0 && (
          <>
            <ComparisonPanel
              candidates={investigation.candidates}
              requirements={investigation.requirements}
              isWide={isWide}
            />
            <View style={[styles.bottomGrid, isWide && styles.bottomGridWide]}>
              <VotePanel
                candidates={investigation.candidates}
                onVotePress={() =>
                  setSelectedCandidateId(
                    [...investigation.candidates].sort((a, b) => a.rank - b.rank)[0]?.id ?? null
                  )
                }
              />
              <EvidencePanel
                evidence={investigation.candidates.flatMap((c) => c.evidence)}
              />
            </View>
          </>
        )}

        {selectedCandidate && (
          <View style={styles.detailSection}>
            <CandidateDetail
              candidate={selectedCandidate}
              investigation={investigation}
              requirements={investigation.requirements}
              placeFacts={placeFacts}
              placeFeedback={{
                formKey: placeFeedback.formKey,
                feedback: placeFeedback.feedback,
                summary: placeFeedback.summary,
                loading: placeFeedback.loading,
                saving: placeFeedback.saving,
                error: placeFeedback.error,
                onSave: placeFeedback.save,
                personalizationApplied: placeFeedback.personalizationApplied,
                personalizationSaving: placeFeedback.personalizationSaving,
                personalizationError: placeFeedback.personalizationError,
                personalizationReasons: placeFeedback.personalizationReasons,
                applyFeedbackToPersonalization: placeFeedback.applyFeedbackToPersonalization,
              }}
              // votes に自分の行が無い間は undefined（未投票）を渡し、
              // 投票して初めてボタンが選択状態になる（#346）
              userVote={userId ? selectedCandidate.votes[userId] : undefined}
              userVoteComment={
                userId ? selectedCandidate.voteComments?.[userId] : undefined
              }
              onVoteChange={(value, comment) =>
                handleVote(selectedCandidate, value, comment)
              }
              onMapOpened={() =>
                rememberCandidateBehavior(
                  selectedCandidate,
                  'map_opened',
                  `map-open:${investigation.id}:${selectedCandidate.id}`,
                  investigation.requirements,
                  personalizationSubject,
                )
              }
              onDecisionCopied={() =>
                rememberCandidateBehavior(
                  selectedCandidate,
                  'decision_copied',
                  `decision-copy:${investigation.id}:${selectedCandidate.id}`,
                  investigation.requirements,
                  personalizationSubject,
                )
              }
            />
          </View>
        )}

        {/* 情報の限界表示（#266）: 結果画面に常設 */}
        <DisclaimerNote />
        {/* 誤情報の訂正・削除申立て導線（#267）: 免責1行に隣接して常設 */}
        <CorrectionLink targetUrl={shareUrl} />

        <View style={styles.bottomSpacer} />
      </ScrollView>
      <NotificationToast
        notifications={visibleNotifications}
        onDismiss={(id) =>
          setDismissedNotificationIds((current) =>
            current.includes(id) ? current : [...current, id]
          )
        }
      />
      <Footer
        attributionPolicies={[
          ...new Set(
            investigation.candidates.flatMap((candidate) =>
              candidate.place.attributionPolicies ?? []
            )
          ),
        ]}
      />
    </View>
  );
}

function rememberCandidateBehavior(
  candidate: Candidate,
  action: CandidateBehaviorAction | null,
  eventKey: string,
  requirements: readonly Requirement[],
  subject?: { id: string; kind: 'anonymous' | 'permanent' },
): void {
  if (!action) return;
  recordPreferenceObservationLocally(
    recognizeCandidateBehavior({ eventKey, action, candidate, requirements }),
    undefined,
    subject,
  );
}

function LoadingState() {
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel="調査を読み込み中"
      style={styles.center}
    >
      <ActivityIndicator accessibilityLabel="読み込み中" size="large" />
      <Text style={styles.loadingText}>調査を読み込んでいます…</Text>
    </View>
  );
}

function CandidateSkeleton({ index }: { index: number }) {
  return (
    <View
      testID={`candidate-skeleton-${index}`}
      accessibilityElementsHidden
      style={styles.skeletonCard}
    >
      <View style={styles.skeletonImage} />
      <View style={styles.skeletonBody}>
        <View style={[styles.skeletonLine, styles.skeletonTitleLine]} />
        <View style={styles.skeletonLine} />
        <View style={[styles.skeletonLine, styles.skeletonShortLine]} />
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
  scroll: {
    padding: 20,
    gap: 20,
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: colors.bg,
  },
  loadingText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  failedState: {
    gap: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  failedText: {
    color: colors.danger,
    fontSize: 14,
    fontWeight: '700',
  },
  retryButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: radius.sm,
    backgroundColor: colors.orange,
  },
  retryButtonText: {
    color: colors.surface,
    fontSize: 13,
    fontWeight: '700',
  },
  header: {
    gap: 12,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    letterSpacing: -0.5,
    color: colors.text,
    flex: 1,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  publicLinkNote: {
    fontSize: 11,
    color: colors.info,
    lineHeight: 16,
  },
  shareButton: {
    backgroundColor: colors.surface,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  shareButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  disabledShareButton: {
    opacity: 0.45,
  },
  heading: {
    fontSize: 16,
    fontWeight: 'bold',
    color: colors.text,
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 4,
  },
  headingCount: {
    fontSize: 10,
    color: colors.textSecondary,
  },
  candidatesSection: {
    gap: 8,
  },
  researchAgainButton: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  researchAgainButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  candidateList: {
    gap: 10,
  },
  candidateListWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  candidateCell: {
    flex: 1,
  },
  bottomGrid: {
    gap: 10,
  },
  bottomGridWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  empty: {
    fontSize: 14,
    color: colors.textTertiary,
    textAlign: 'center',
    paddingVertical: 20,
  },
  loadingCandidates: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 20,
  },
  skeletonList: {
    width: '100%',
    gap: 10,
  },
  skeletonCard: {
    flexDirection: 'row',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  skeletonImage: {
    width: 92,
    minHeight: 78,
    backgroundColor: colors.borderSoft,
  },
  skeletonBody: {
    flex: 1,
    justifyContent: 'center',
    gap: 8,
    padding: 12,
  },
  skeletonLine: {
    height: 8,
    width: '80%',
    borderRadius: radius.pill,
    backgroundColor: colors.borderSoft,
  },
  skeletonTitleLine: {
    width: '55%',
    height: 11,
    backgroundColor: colors.border,
  },
  skeletonShortLine: {
    width: '38%',
  },
  detailSection: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bottomSpacer: {
    height: 24,
  },
  addRequirement: {
    gap: 8,
  },
  addInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: 12,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  addButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.sm,
    alignItems: 'center',
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  cancelButtonText: {
    color: colors.textSecondary,
    fontWeight: 'bold',
  },
  addButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.sm,
    alignItems: 'center',
    backgroundColor: colors.black,
  },
  addButtonText: {
    color: colors.surface,
    fontWeight: 'bold',
  },
  disabledButton: {
    backgroundColor: colors.border,
  },
});
