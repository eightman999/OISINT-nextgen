package com.oisint.android.ui.paywall

import com.oisint.android.R
import androidx.annotation.StringRes
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
    /** 表示用メッセージ（string resource ID）。null は非表示。 */
    @StringRes val errorMessage: Int? = null,
    @StringRes val noticeMessage: Int? = null,
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
                        errorMessage = R.string.paywall_error_not_configured,
                    )
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(
                        loadingPackages = false,
                        errorMessage = R.string.paywall_error_plans_failed,
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
                    errorMessage = R.string.paywall_error_anonymous_purchase,
                    noticeMessage = null,
                )
            }
            return
        }
        val target = state.packages.firstOrNull { it.id == packageId } ?: return
        _uiState.update { it.copy(purchasingId = packageId, errorMessage = null, noticeMessage = null) }
        viewModelScope.launch {
            try {
                provider.purchase(activity, target)
                _uiState.update { it.copy(noticeMessage = R.string.paywall_notice_purchased) }
            } catch (_: EntitlementPendingException) {
                _uiState.update {
                    it.copy(noticeMessage = R.string.paywall_notice_purchase_pending)
                }
            } catch (_: EntitlementPurchaseCancelledException) {
                _uiState.update { it.copy(noticeMessage = R.string.paywall_notice_purchase_cancelled) }
            } catch (_: EntitlementAnonymousException) {
                _uiState.update {
                    it.copy(errorMessage = R.string.paywall_error_anonymous_purchase)
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(errorMessage = R.string.paywall_error_purchase_failed)
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
                    errorMessage = R.string.paywall_error_anonymous_restore,
                    noticeMessage = null,
                )
            }
            return
        }
        _uiState.update { it.copy(restoring = true, errorMessage = null, noticeMessage = null) }
        viewModelScope.launch {
            try {
                val restored = provider.restore()
                _uiState.update {
                    it.copy(
                        noticeMessage = if (restored.isPlus) {
                            R.string.paywall_notice_restored
                        } else {
                            R.string.paywall_notice_nothing_to_restore
                        },
                    )
                }
            } catch (_: EntitlementPendingException) {
                _uiState.update {
                    it.copy(noticeMessage = R.string.paywall_notice_restore_pending)
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(errorMessage = R.string.paywall_error_restore_failed)
                }
            } finally {
                _uiState.update { it.copy(restoring = false) }
            }
        }
    }
}
