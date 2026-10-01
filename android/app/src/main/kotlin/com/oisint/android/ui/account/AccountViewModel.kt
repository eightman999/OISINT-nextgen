package com.oisint.android.ui.account

import com.oisint.android.R
import androidx.annotation.StringRes
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
    /** 表示用メッセージ（string resource ID）。null は非表示。 */
    @StringRes val errorMessage: Int? = null,
    @StringRes val noticeMessage: Int? = null,
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
                            errorMessage = null,
                            noticeMessage = null,
                        )
                    } else {
                        current.copy(authState = authState, errorMessage = null)
                    }
                }
            }
        }
    }

    fun onEmailChanged(value: String) = _uiState.update { it.copy(email = value, errorMessage = null) }
    fun onPasswordChanged(value: String) = _uiState.update { it.copy(password = value, errorMessage = null) }
    fun onConfirmAccountSwitchChanged(value: Boolean) =
        _uiState.update { it.copy(confirmAccountSwitch = value, errorMessage = null) }

    /** 1回目は確認状態だけを表示し、2回目でEdge Functionを呼ぶ。 */
    fun requestAccountDeletion() {
        val current = _uiState.value
        if (current.authState !is AuthState.Authenticated && current.authState !is AuthState.Anonymous) return
        if (!current.confirmAccountDeletion) {
            _uiState.update { it.copy(confirmAccountDeletion = true, errorMessage = null) }
            return
        }
        val expectedSubject = subjectKey(current.authState)
        runAuthAction(expectedSubject) {
            authController.deleteAccount()
        }
    }

    fun cancelAccountDeletion() =
        _uiState.update { it.copy(confirmAccountDeletion = false, errorMessage = null) }

    fun signIn() = runAuthAction {
        val state = _uiState.value
        authController.signInWithEmail(state.email, state.password, state.confirmAccountSwitch)
        // AuthState collectorがsubject切替の個人state resetを完了してから、
        // 新subject向けの成功通知を設定する。
        yield()
        _uiState.update { it.copy(noticeMessage = R.string.account_notice_signed_in) }
    }

    fun signUp() = runAuthAction {
        val state = _uiState.value
        authController.signUpWithEmail(state.email, state.password, state.confirmAccountSwitch)
        yield()
        _uiState.update { it.copy(noticeMessage = R.string.account_notice_signed_up) }
    }

    fun connectGoogle() = runAuthAction {
        authController.beginGoogleAuth()
        _uiState.update { it.copy(noticeMessage = R.string.account_notice_google_opening) }
    }

    fun signOut() = runAuthAction {
        authController.signOut()
        _uiState.update { it.copy(noticeMessage = R.string.account_notice_signed_out) }
    }

    private fun runAuthAction(expectedSubject: String? = null, action: suspend () -> Unit) {
        if (_uiState.value.busy) return
        _uiState.update { it.copy(busy = true, errorMessage = null, noticeMessage = null) }
        viewModelScope.launch {
            try {
                action()
                if (expectedSubject != null && subjectKey(_uiState.value.authState) == expectedSubject) {
                    val notice = if (authController.lastDeleteLocalCleanupFailed) {
                        R.string.account_notice_deleted_cleanup_failed
                    } else {
                        R.string.account_notice_deleted
                    }
                    _uiState.update { it.copy(noticeMessage = notice, confirmAccountDeletion = false) }
                }
            } catch (_: AuthSwitchConfirmationRequired) {
                _uiState.update {
                    it.copy(errorMessage = R.string.account_error_switch_confirmation)
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(errorMessage = R.string.account_error_auth_failed)
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
