package com.oisint.android.ui.account

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.oisint.android.auth.AuthController
import com.oisint.android.auth.AuthState
import com.oisint.android.auth.AuthSwitchConfirmationRequired
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield

data class AccountUiState(
    val authState: AuthState = AuthState.Loading,
    val email: String = "",
    val password: String = "",
    val confirmAccountSwitch: Boolean = false,
    val confirmAccountDeletion: Boolean = false,
    val busy: Boolean = false,
    val errorMessage: String = "",
    val noticeMessage: String = "",
)

class AccountViewModel(private val authController: AuthController) : ViewModel() {
    private val _uiState = MutableStateFlow(AccountUiState())
    val uiState: StateFlow<AccountUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            var previousSubjectKey: String? = null
            authController.state.collect { authState ->
                val nextSubjectKey = subjectKey(authState)
                _uiState.update { current ->
                    if (previousSubjectKey != nextSubjectKey) {
                        previousSubjectKey = nextSubjectKey
                        current.copy(
                            authState = authState,
                            email = "",
                            password = "",
                            confirmAccountSwitch = false,
                            confirmAccountDeletion = false,
                            busy = false,
                            errorMessage = "",
                            noticeMessage = "",
                        )
                    } else {
                        current.copy(authState = authState, errorMessage = "")
                    }
                }
            }
        }
    }

    fun onEmailChanged(value: String) = _uiState.update { it.copy(email = value, errorMessage = "") }
    fun onPasswordChanged(value: String) = _uiState.update { it.copy(password = value, errorMessage = "") }
    fun onConfirmAccountSwitchChanged(value: Boolean) =
        _uiState.update { it.copy(confirmAccountSwitch = value, errorMessage = "") }

    /** 1回目は確認状態だけを表示し、2回目でEdge Functionを呼ぶ。 */
    fun requestAccountDeletion() {
        val current = _uiState.value
        if (current.authState !is AuthState.Authenticated && current.authState !is AuthState.Anonymous) return
        if (!current.confirmAccountDeletion) {
            _uiState.update { it.copy(confirmAccountDeletion = true, errorMessage = "") }
            return
        }
        val expectedSubject = subjectKey(current.authState)
        runAuthAction(expectedSubject) {
            authController.deleteAccount()
        }
    }

    fun cancelAccountDeletion() =
        _uiState.update { it.copy(confirmAccountDeletion = false, errorMessage = "") }

    fun signIn() = runAuthAction {
        val state = _uiState.value
        authController.signInWithEmail(state.email, state.password, state.confirmAccountSwitch)
        // AuthState collectorがsubject切替の個人state resetを完了してから、
        // 新subject向けの成功通知を設定する。
        yield()
        _uiState.update { it.copy(noticeMessage = "アカウントに接続しました。") }
    }

    fun signUp() = runAuthAction {
        val state = _uiState.value
        authController.signUpWithEmail(state.email, state.password, state.confirmAccountSwitch)
        yield()
        _uiState.update { it.copy(noticeMessage = "登録処理を開始しました。確認メールが届く場合があります。") }
    }

    fun connectGoogle() = runAuthAction {
        authController.beginGoogleAuth()
        _uiState.update { it.copy(noticeMessage = "Google認証を開いています。完了後にこの画面へ戻ってください。") }
    }

    fun signOut() = runAuthAction {
        authController.signOut()
        _uiState.update { it.copy(noticeMessage = "ログアウトしました。") }
    }

    private fun runAuthAction(expectedSubject: String? = null, action: suspend () -> Unit) {
        if (_uiState.value.busy) return
        _uiState.update { it.copy(busy = true, errorMessage = "", noticeMessage = "") }
        viewModelScope.launch {
            try {
                action()
                if (expectedSubject != null && subjectKey(_uiState.value.authState) == expectedSubject) {
                    val notice = if (authController.lastDeleteLocalCleanupFailed) {
                        "サーバー上のアカウントを削除しました。端末セッションの破棄に失敗したため、アプリを再起動して再確認してください。"
                    } else {
                        "アカウントを削除しました。"
                    }
                    _uiState.update { it.copy(noticeMessage = notice, confirmAccountDeletion = false) }
                }
            } catch (_: AuthSwitchConfirmationRequired) {
                _uiState.update {
                    it.copy(errorMessage = "別のアカウントへ切り替える場合は、確認欄にチェックしてください。")
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(errorMessage = "認証を完了できませんでした。入力内容と設定を確認してください。")
                }
            } finally {
                if (expectedSubject == null || subjectKey(_uiState.value.authState) == expectedSubject) {
                    _uiState.update { it.copy(busy = false) }
                }
            }
        }
    }

    private fun subjectKey(state: AuthState): String? = when (state) {
        is AuthState.Authenticated -> "permanent:${state.userId}"
        is AuthState.Anonymous -> "anonymous:${state.userId}"
        else -> null
    }
}
