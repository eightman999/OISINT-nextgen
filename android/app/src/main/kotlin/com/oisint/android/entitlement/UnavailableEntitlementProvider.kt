package com.oisint.android.entitlement

import android.app.Activity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** 公開key/外部設定がない場合のfail-closed境界。Plusを推測付与しない。 */
class UnavailableEntitlementProvider : EntitlementProvider {
    private val _status = MutableStateFlow(EntitlementStatus())
    override val status: StateFlow<EntitlementStatus> = _status.asStateFlow()
    private val _isAuthenticated = MutableStateFlow(false)
    override val isAuthenticated: StateFlow<Boolean> = _isAuthenticated.asStateFlow()
    override suspend fun refresh() = throw EntitlementNotConfiguredException()
    override suspend fun offerings(): List<PlusPackage> = throw EntitlementNotConfiguredException()
    override suspend fun purchase(activity: Activity, pkg: PlusPackage): EntitlementStatus =
        throw EntitlementNotConfiguredException()
    override suspend fun restore(): EntitlementStatus = throw EntitlementNotConfiguredException()
    override suspend fun logIn(appUserId: String) = throw EntitlementNotConfiguredException()
    override suspend fun logOut() { _status.value = EntitlementStatus() }
}
