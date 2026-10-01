package com.oisint.android.entitlement

import android.app.Activity
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** unit/fixture専用provider。公開UIはこの型名・内部状態を表示しない。 */
class MockEntitlementProvider : EntitlementProvider {
    private val _status = MutableStateFlow(EntitlementStatus())
    override val status: StateFlow<EntitlementStatus> = _status.asStateFlow()
    private val _isAuthenticated = MutableStateFlow(false)
    override val isAuthenticated: StateFlow<Boolean> = _isAuthenticated.asStateFlow()
    private var appUserId: String? = null

    override suspend fun refresh() = Unit

    override suspend fun offerings() = listOf(
        PlusPackage(RevenueCatEntitlementContract.MONTHLY_PRODUCT, "OISINT Plus 月額", "テスト価格", "P1M"),
        PlusPackage(RevenueCatEntitlementContract.ANNUAL_PRODUCT, "OISINT Plus 年額", "テスト価格", "P1Y"),
    )

    override suspend fun purchase(activity: Activity, pkg: PlusPackage): EntitlementStatus {
        if (!RevenueCatEntitlementContract.PRODUCTS.contains(pkg.id)) throw IllegalArgumentException()
        if (appUserId == null) throw EntitlementAnonymousException()
        return grant()
    }

    override suspend fun restore(): EntitlementStatus {
        if (appUserId == null) throw EntitlementAnonymousException()
        return _status.value
    }

    override suspend fun logIn(appUserId: String) {
        val canonical = runCatching { UUID.fromString(appUserId).toString() }.getOrNull()
        if (canonical == null || canonical != appUserId.lowercase()) {
            throw EntitlementAnonymousException()
        }
        this.appUserId = appUserId
        _isAuthenticated.value = true
    }

    override suspend fun logOut() {
        appUserId = null
        _isAuthenticated.value = false
        _status.value = EntitlementStatus()
    }

    private fun grant(): EntitlementStatus {
        val result = EntitlementStatus(
            isPlus = true,
            willRenew = true,
            expiresAt = Instant.now().plusSeconds(30L * 24 * 60 * 60).toString(),
            store = "TEST_STORE",
        )
        _status.value = result
        return result
    }
}
