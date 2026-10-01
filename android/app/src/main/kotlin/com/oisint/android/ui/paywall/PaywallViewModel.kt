package com.oisint.android.ui.paywall

import android.app.Activity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.oisint.android.entitlement.EntitlementAnonymousException
import com.oisint.android.entitlement.EntitlementNotConfiguredException
import com.oisint.android.entitlement.EntitlementPendingException
import com.oisint.android.entitlement.EntitlementProvider
import com.oisint.android.entitlement.EntitlementPurchaseCancelledException
import com.oisint.android.entitlement.EntitlementStatus
import com.oisint.android.entitlement.PlusPackage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class PaywallUiState(
    val status: EntitlementStatus = EntitlementStatus(),
    val isAuthenticated: Boolean = false,
    val packages: List<PlusPackage> = emptyList(),
    val loadingPackages: Boolean = true,
    val purchasingId: String? = null,
    val restoring: Boolean = false,
    val errorMessage: String = "",
    val noticeMessage: String = "",
) {
    val busy: Boolean get() = purchasingId != null || restoring
}

class PaywallViewModel(private val provider: EntitlementProvider) : ViewModel() {
    private val _uiState = MutableStateFlow(PaywallUiState())
    val uiState: StateFlow<PaywallUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            provider.status.collect { value -> _uiState.update { it.copy(status = value) } }
        }
        viewModelScope.launch {
            provider.isAuthenticated.collect { value ->
                _uiState.update { it.copy(isAuthenticated = value) }
                // Authが起動後に匿名から恒久UUIDへbindされるため、初期の未設定時に
                // 失敗した offerings 読み込みを、恒久identity確定後に再試行する。
                if (value) refresh()
            }
        }
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            runCatching { provider.refresh() }
            try {
                val packages = provider.offerings()
                _uiState.update { it.copy(packages = packages, loadingPackages = false) }
            } catch (_: EntitlementNotConfiguredException) {
                _uiState.update {
                    it.copy(
                        loadingPackages = false,
                        errorMessage = "購入設定を確認できません。現在は無料プランをご利用ください。",
                    )
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(
                        loadingPackages = false,
                        errorMessage = "プラン情報を取得できませんでした。時間をおいて再試行してください。",
                    )
                }
            }
        }
    }

    fun purchase(activity: Activity, packageId: String) {
        val state = _uiState.value
        if (state.busy) return
        if (!state.isAuthenticated) {
            _uiState.update {
                it.copy(
                    errorMessage = "匿名利用中は購入できません。アカウント登録後にお試しください。",
                    noticeMessage = "",
                )
            }
            return
        }
        val target = state.packages.firstOrNull { it.id == packageId } ?: return
        _uiState.update { it.copy(purchasingId = packageId, errorMessage = "", noticeMessage = "") }
        viewModelScope.launch {
            try {
                provider.purchase(activity, target)
                _uiState.update { it.copy(noticeMessage = "OISINT Plus に加入しました。") }
            } catch (_: EntitlementPendingException) {
                _uiState.update {
                    it.copy(noticeMessage = "購入を受け付けました。サーバー反映後にPlus状態を確認します。")
                }
            } catch (_: EntitlementPurchaseCancelledException) {
                _uiState.update { it.copy(noticeMessage = "購入をキャンセルしました。") }
            } catch (_: EntitlementAnonymousException) {
                _uiState.update {
                    it.copy(errorMessage = "匿名利用中は購入できません。アカウント登録後にお試しください。")
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(errorMessage = "購入処理に失敗しました。時間をおいて再試行してください。")
                }
            } finally {
                _uiState.update { it.copy(purchasingId = null) }
            }
        }
    }

    fun restore() {
        if (_uiState.value.busy) return
        if (!_uiState.value.isAuthenticated) {
            _uiState.update {
                it.copy(
                    errorMessage = "匿名利用中は購入を復元できません。アカウント登録後にお試しください。",
                    noticeMessage = "",
                )
            }
            return
        }
        _uiState.update { it.copy(restoring = true, errorMessage = "", noticeMessage = "") }
        viewModelScope.launch {
            try {
                val restored = provider.restore()
                _uiState.update {
                    it.copy(
                        noticeMessage = if (restored.isPlus) {
                            "購入を復元しました。"
                        } else {
                            "復元できる購入が見つかりませんでした。"
                        },
                    )
                }
            } catch (_: EntitlementPendingException) {
                _uiState.update {
                    it.copy(noticeMessage = "復元を受け付けました。サーバー反映後にPlus状態を確認します。")
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(errorMessage = "復元処理に失敗しました。時間をおいて再試行してください。")
                }
            } finally {
                _uiState.update { it.copy(restoring = false) }
            }
        }
    }
}
