package com.oisint.android.ui.join

import com.oisint.android.R
import androidx.annotation.StringRes
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
    /** 表示用エラー（string resource ID）。null はエラーなし。 */
    @StringRes val errorMessage: Int? = null,
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
                it.copy(errorMessage = R.string.join_error_missing_token)
            }
            return
        }
        _uiState.update { it.copy(loading = true, errorMessage = null) }
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
                            // provider/API が返す日本語エラー文言での分岐（サーバ契約。翻訳しない）
                            message.contains("見つかりません") -> R.string.join_error_invalid_link
                            message.contains("上限") -> R.string.join_error_full
                            else -> R.string.join_error_connection
                        },
                    )
                }
            } finally {
                _uiState.update { it.copy(loading = false) }
            }
        }
    }
}
