package com.oisint.android.entitlement

import android.app.Activity
import java.time.Instant
import kotlinx.coroutines.flow.StateFlow

/** RevenueCat型をUIへ漏らさないPlus entitlement境界。 */
data class EntitlementStatus(
    val isPlus: Boolean = false,
    val willRenew: Boolean? = null,
    val expiresAt: String? = null,
    val gracePeriodExpiresAt: String? = null,
    val store: String? = null,
    val productIdentifier: String? = null,
    val lifecycleState: String? = null,
)

data class PlusPackage(
    val id: String,
    val title: String,
    val priceString: String,
    val period: String,
)

class EntitlementPurchaseCancelledException : Exception()
class EntitlementPendingException : Exception()
class EntitlementAnonymousException : Exception()
class EntitlementNotConfiguredException : Exception()

interface EntitlementProvider {
    val status: StateFlow<EntitlementStatus>
    /** 恒久Auth subjectへSDK identityをbind済みか。匿名/未設定はfalse。 */
    val isAuthenticated: StateFlow<Boolean>
    suspend fun refresh()
    suspend fun offerings(): List<PlusPackage>
    suspend fun purchase(activity: Activity, pkg: PlusPackage): EntitlementStatus
    suspend fun restore(): EntitlementStatus
    suspend fun logIn(appUserId: String)
    suspend fun logOut()
}

object RevenueCatEntitlementContract {
    const val ENTITLEMENT = "plus"
    const val OFFERING = "default"
    const val MONTHLY_PRODUCT = "oisint_plus_monthly"
    const val ANNUAL_PRODUCT = "oisint_plus_annual"
    // Server entitlement の product_id は引き続き bare ID のみ。
    val PRODUCTS = setOf(MONTHLY_PRODUCT, ANNUAL_PRODUCT)
    // Google StoreProduct.id は productId:basePlanId。購入候補だけで明示的に許可する。
    val PURCHASE_PRODUCTS = PRODUCTS + setOf(
        "$MONTHLY_PRODUCT:monthly2",
        "$ANNUAL_PRODUCT:2annual",
    )
}

/** SDKのactive flagだけではPlusを表示しない。期限証明は必須で、null/不正/過去はFree。 */
internal fun isVerifiedPlusStatus(
    isActive: Boolean,
    productId: String?,
    expiresAt: String?,
    gracePeriodExpiresAt: String? = null,
    nowMs: Long = System.currentTimeMillis(),
): Boolean {
    if (!isActive || productId !in RevenueCatEntitlementContract.PRODUCTS) return false
    val expiryMs = expiresAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    val graceMs = gracePeriodExpiresAt?.let {
        runCatching { Instant.parse(it).toEpochMilli() }.getOrNull()
    }
    return (expiryMs != null && expiryMs > nowMs) ||
        (graceMs != null && graceMs > nowMs)
}
