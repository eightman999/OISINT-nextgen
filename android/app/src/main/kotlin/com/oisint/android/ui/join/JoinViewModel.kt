package com.oisint.android.ui.join

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.oisint.android.data.DataProvider
import com.oisint.android.model.Investigation
import com.oisint.android.model.JoinInvestigationRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 共有参加画面の状態。正典は `app/i/[token].tsx`（handleJoin L19-53、エラー 3 分岐 L42-49）。
 */
data class JoinUiState(
    val displayName: String = "",
    val loading: Boolean = false,
    val errorMessage: String = "",
    val preview: Investigation? = null,
    /** 参加成功時に一度だけ発火する遷移イベント（investigationId, shareToken） */
    val navigateTo: Pair<String, String>? = null,
)

class JoinViewModel(
    private val provider: DataProvider,
    private val token: String?,
    previewByShareToken: (String) -> Investigation?,
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        // i/[token].tsx L17: preview は mock のみ（live は null）
        JoinUiState(preview = token?.let(previewByShareToken)),
    )
    val uiState: StateFlow<JoinUiState> = _uiState.asStateFlow()

    fun onDisplayNameChange(value: String) = _uiState.update { it.copy(displayName = value) }
    fun onNavigated() = _uiState.update { it.copy(navigateTo = null) }

    /** i/[token].tsx L19-53 handleJoin */
    fun join() {
        val name = _uiState.value.displayName.trim().ifEmpty { "ゲスト" }
        if (token.isNullOrEmpty()) {
            _uiState.update {
                it.copy(errorMessage = "共有URLに参加用トークンがありません。URLをもう一度開いてください。")
            }
            return
        }
        _uiState.update { it.copy(loading = true, errorMessage = "") }
        viewModelScope.launch {
            try {
                val userId = try {
                    provider.getUserId()
                } catch (_: Exception) {
                    null
                }
                val res = provider.joinInvestigation(
                    JoinInvestigationRequest(shareToken = token, displayName = name, userId = userId),
                )
                _uiState.update { it.copy(navigateTo = res.investigationId to token) }
            } catch (e: Exception) {
                val message = e.message ?: ""
                _uiState.update {
                    it.copy(
                        errorMessage = when {
                            message.contains("見つかりません") ->
                                "共有URLが無効か期限切れです。発行した人に新しいURLを依頼してください。"
                            message.contains("上限") ->
                                "この調査は参加人数の上限に達しています。発行した人にご相談ください。"
                            else ->
                                "共有調査に接続できませんでした。通信状態を確認して、もう一度お試しください。"
                        },
                    )
                }
            } finally {
                _uiState.update { it.copy(loading = false) }
            }
        }
    }
}
