package com.oisint.android.ui.investigation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.oisint.android.data.DataProvider
import com.oisint.android.model.Investigation
import com.oisint.android.model.RerankInvestigationRequest
import com.oisint.android.model.RerankTrigger
import com.oisint.android.model.RunInvestigationReason
import com.oisint.android.model.RunInvestigationRequest
import com.oisint.android.model.VoteValue
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Investigation 詳細画面の状態。正典は `src/hooks/useInvestigation.ts`（初期取得 + 購読 + retry）と
 * `app/investigations/[id].tsx` のハンドラ群（handleVote L114-130 の 500ms debounce、
 * handleAddRequirement L73-93 の即時 rerank、handleRetryRun L95-110）。
 */
data class InvestigationUiState(
    val investigation: Investigation? = null,
    val loading: Boolean = true,
    val error: String? = null,
    val actionError: String = "",
    val selectedCandidateId: String? = null,
    val retrying: Boolean = false,
    val addingRequirement: Boolean = false,
    val newRequirementText: String = "",
    val shareCopied: Boolean = false,
    val currentUserId: String? = null,
)

class InvestigationViewModel(
    private val provider: DataProvider,
    private val investigationId: String?,
) : ViewModel() {

    private val _uiState = MutableStateFlow(InvestigationUiState())
    val uiState: StateFlow<InvestigationUiState> = _uiState.asStateFlow()

    private var unsubscribe: (() -> Unit)? = null
    private var voteRerankJob: Job? = null
    private var shareCopiedJob: Job? = null

    init {
        load()
    }

    /** useInvestigation.ts: 初期取得 + subscribe。retry で再実行 */
    private fun load() {
        unsubscribe?.invoke()
        unsubscribe = null
        if (investigationId.isNullOrEmpty()) {
            _uiState.update { it.copy(loading = false, error = "調査IDが指定されていません") }
            return
        }
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val userId = try {
                    provider.getUserId()
                } catch (_: Exception) {
                    null // 認証失敗は UI へ漏らさない（AuthProvider.tsx と同じサイレント方針）
                }
                val investigation = provider.getInvestigation(investigationId)
                if (investigation == null) {
                    _uiState.update {
                        it.copy(loading = false, error = "調査が見つかりません", currentUserId = userId)
                    }
                    return@launch
                }
                _uiState.update { state ->
                    state.copy(
                        investigation = investigation,
                        loading = false,
                        currentUserId = userId,
                        selectedCandidateId = state.selectedCandidateId
                            ?: investigation.candidates.firstOrNull()?.id,
                    )
                }
                unsubscribe = provider.subscribeInvestigation(investigationId) { updated ->
                    _uiState.update { state ->
                        state.copy(
                            investigation = updated,
                            // [id].tsx L49-53: 最初の候補を自動選択
                            selectedCandidateId = state.selectedCandidateId
                                ?: updated.candidates.firstOrNull()?.id,
                        )
                    }
                }
            } catch (_: Exception) {
                _uiState.update { it.copy(loading = false, error = "調査データを読み込めませんでした") }
            }
        }
    }

    /** useInvestigation.ts の retry() */
    fun retry() = load()

    fun selectCandidate(candidateId: String) =
        _uiState.update { it.copy(selectedCandidateId = candidateId) }

    fun onNewRequirementTextChange(value: String) =
        _uiState.update { it.copy(newRequirementText = value) }

    fun setAddingRequirement(adding: Boolean) =
        _uiState.update { it.copy(addingRequirement = adding, actionError = "") }

    /** [id].tsx L55-71 handleShare 相当（クリップボードコピーは画面側。ここは表示状態管理のみ） */
    fun onShareCopied() {
        _uiState.update { it.copy(shareCopied = true, actionError = "") }
        shareCopiedJob?.cancel()
        shareCopiedJob = viewModelScope.launch {
            delay(2200)
            _uiState.update { it.copy(shareCopied = false) }
        }
    }

    /** [id].tsx L73-93 handleAddRequirement（成功で入力クリア → 即時 rerank(requirement_added)） */
    fun addRequirement() {
        val state = _uiState.value
        val text = state.newRequirementText.trim()
        val investigation = state.investigation
        if (text.isEmpty() || investigation == null) return

        _uiState.update { it.copy(actionError = "") }
        if (state.currentUserId == null) {
            _uiState.update { it.copy(actionError = "条件を追加する権限がありません。") }
            return
        }
        viewModelScope.launch {
            try {
                provider.addRequirement(investigation.id, text)
                _uiState.update { it.copy(newRequirementText = "", addingRequirement = false) }
                provider.rerankInvestigation(
                    RerankInvestigationRequest(investigation.id, RerankTrigger.RequirementAdded),
                )
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(actionError = "条件の追加または候補の再評価に失敗しました。再試行してください。")
                }
            }
        }
    }

    /** [id].tsx L95-110 handleRetryRun */
    fun retryRun() {
        val investigation = _uiState.value.investigation
        if (investigation == null) {
            retry()
            return
        }
        _uiState.update { it.copy(actionError = "", retrying = true) }
        viewModelScope.launch {
            try {
                // [id].tsx L274-279: anchor 不足の受理応答は再試行エラーではなく入力待ち。
                val response = provider.runInvestigation(RunInvestigationRequest(investigation.id))
                if (response.reason == RunInvestigationReason.LocationAnchorRequired) {
                    _uiState.update {
                        it.copy(
                            actionError =
                                "現在地を検索に使用できませんでした。駅名・地名を入力してください。",
                        )
                    }
                    return@launch
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(actionError = "調査を再試行できませんでした。時間を置いてもう一度お試しください。")
                }
            } finally {
                _uiState.update { it.copy(retrying = false) }
            }
        }
    }

    /**
     * [id].tsx L112-130 handleVote:
     * 投票は即時（失敗 → actionError）。rerank(trigger=vote) は 500ms debounce
     * （spec.md §25.3 の呼び出し規律。連打では最後の 1 回だけ rerank が飛ぶ）。
     */
    fun vote(candidateId: String, value: VoteValue) {
        vote(candidateId, value, null)
    }

    /** 票と任意コメントを同じ votes 行へ保存し、票変更時と同じ debounce rerank を行う。 */
    fun vote(candidateId: String, value: VoteValue, comment: String?) {
        val state = _uiState.value
        val investigation = state.investigation ?: return
        if (state.currentUserId == null) return

        viewModelScope.launch {
            try {
                provider.setVote(investigation.id, candidateId, value, comment)
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(actionError = "投票を保存できませんでした。通信状態を確認してください。")
                }
            }
        }
        voteRerankJob?.cancel()
        voteRerankJob = viewModelScope.launch {
            delay(500)
            try {
                provider.rerankInvestigation(
                    RerankInvestigationRequest(investigation.id, RerankTrigger.Vote),
                )
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(actionError = "投票を保存しましたが、順位の更新に失敗しました。")
                }
            }
        }
    }

    override fun onCleared() {
        unsubscribe?.invoke()
        unsubscribe = null
        super.onCleared()
    }
}
