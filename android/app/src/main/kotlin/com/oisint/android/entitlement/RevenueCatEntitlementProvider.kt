package com.oisint.android.entitlement

import android.app.Activity
import android.content.Context
import com.revenuecat.purchases.CustomerInfo
import com.revenuecat.purchases.Offering
import com.revenuecat.purchases.Package
import com.revenuecat.purchases.Purchases
import com.revenuecat.purchases.PurchasesConfiguration
import com.revenuecat.purchases.PurchasesTransactionException
import com.revenuecat.purchases.PurchaseParams
import com.revenuecat.purchases.awaitCustomerInfo
import com.revenuecat.purchases.awaitLogIn
import com.revenuecat.purchases.awaitLogOut
import com.revenuecat.purchases.awaitOfferings
import com.revenuecat.purchases.awaitPurchase
import com.revenuecat.purchases.awaitRestore
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * RevenueCat Android SDK の唯一の実装境界。
 *
 * SDKは匿名状態のままconfigureせず、Supabaseの恒久UUIDをlogInできた後だけ
 * identityを固定する。UI/ViewModelにはRevenueCatの型や商品ID以外のSDK知識を漏らさない。
 */
class RevenueCatEntitlementProvider(
    private val context: Context,
    private val apiKey: String,
    private val fetchServerEntitlement: suspend (String) -> EntitlementStatus = { EntitlementStatus() },
) : EntitlementProvider {

    private val _status = MutableStateFlow(EntitlementStatus())
    override val status: StateFlow<EntitlementStatus> = _status.asStateFlow()
    private val _isAuthenticated = MutableStateFlow(false)
    override val isAuthenticated: StateFlow<Boolean> = _isAuthenticated.asStateFlow()

    private var currentUserId: String? = null
    private val purchases: Purchases get() = Purchases.sharedInstance

    override suspend fun refresh() {
        requireConfiguredUser()
        purchases.awaitCustomerInfo()
        val userId = currentUserId ?: throw EntitlementAnonymousException()
        try {
            _status.value = verifiedServerStatus(userId)
        } catch (error: Exception) {
            _status.value = EntitlementStatus()
            throw error
        }
    }

    override suspend fun offerings(): List<PlusPackage> {
        requireConfiguredUser()
        return purchases.awaitOfferings().current.plusPackages()
    }

    override suspend fun purchase(
        activity: Activity,
        pkg: PlusPackage,
    ): EntitlementStatus {
        requireConfiguredUser()
        require(pkg.id in RevenueCatEntitlementContract.PURCHASE_PRODUCTS) {
            "requested product is not supported"
        }
        val target = purchases.awaitOfferings().current.requirePlusPurchasePackage(pkg.id)
        return try {
            val result = purchases.awaitPurchase(
                PurchaseParams.Builder(activity, target).build(),
            )
            val sdkStatus = result.customerInfo.toStatus()
            try {
                val serverStatus = verifiedServerStatus(currentUserId ?: throw EntitlementAnonymousException())
                _status.value = serverStatus
                if (!serverStatus.isPlus && sdkStatus.isPlus) throw EntitlementPendingException()
                serverStatus
            } catch (error: EntitlementPendingException) {
                _status.value = EntitlementStatus()
                throw error
            } catch (_: Exception) {
                _status.value = EntitlementStatus()
                throw EntitlementPendingException()
            }
        } catch (error: PurchasesTransactionException) {
            if (error.userCancelled) {
                throw EntitlementPurchaseCancelledException()
            }
            throw error
        }
    }

    override suspend fun restore(): EntitlementStatus {
        requireConfiguredUser()
        val sdkStatus = purchases.awaitRestore().toStatus()
        try {
            val serverStatus = verifiedServerStatus(currentUserId ?: throw EntitlementAnonymousException())
            _status.value = serverStatus
            if (!serverStatus.isPlus && sdkStatus.isPlus) throw EntitlementPendingException()
            return serverStatus
        } catch (error: EntitlementPendingException) {
            _status.value = EntitlementStatus()
            throw error
        } catch (_: Exception) {
            _status.value = EntitlementStatus()
            throw EntitlementPendingException()
        }
    }

    override suspend fun logIn(appUserId: String) {
        val canonicalId = canonicalPermanentUserId(appUserId)
            ?: throw EntitlementAnonymousException()
        check(apiKey.isNotBlank()) { "RevenueCat public key is not configured" }

        if (!Purchases.isConfigured) {
            Purchases.configure(
                PurchasesConfiguration.Builder(context, apiKey)
                    .appUserID(canonicalId)
                    .build(),
            )
        } else if (currentUserId != canonicalId) {
            purchases.awaitLogIn(canonicalId)
        }
        purchases.awaitCustomerInfo()
        currentUserId = canonicalId
        _isAuthenticated.value = true
        _status.value = runCatching { verifiedServerStatus(canonicalId) }
            .getOrDefault(EntitlementStatus())
    }

    override suspend fun logOut() {
        if (Purchases.isConfigured && currentUserId != null) {
            try {
                purchases.awaitLogOut()
            } finally {
                currentUserId = null
                _isAuthenticated.value = false
                _status.value = EntitlementStatus()
            }
        } else {
            currentUserId = null
            _isAuthenticated.value = false
            _status.value = EntitlementStatus()
        }
    }

    private fun requireConfiguredUser() {
        if (apiKey.isBlank()) throw EntitlementNotConfiguredException()
        if (currentUserId == null || !Purchases.isConfigured) {
            throw EntitlementAnonymousException()
        }
    }

    private fun CustomerInfo.toStatus(): EntitlementStatus {
        val plus = entitlements[RevenueCatEntitlementContract.ENTITLEMENT]
        val productId = plus?.productIdentifier
        if (plus == null || productId !in RevenueCatEntitlementContract.PRODUCTS) {
            return EntitlementStatus()
        }
        val expiresAt = plus.expirationDate?.toInstant()?.toString()
        // 請求失敗の正当なgraceは entitlement の期限が過去でも、商品別の
        // SubscriptionInfo が持つ明示的なgrace期限までアクセスを維持する。
        val gracePeriodExpiresAt = plus.productIdentifier
            .let { subscriptionsByProductIdentifier[it]?.gracePeriodExpiresDate }
            ?.toInstant()
            ?.toString()
        return EntitlementStatus(
            isPlus = isVerifiedPlusStatus(
                plus.isActive,
                productId,
                expiresAt,
                gracePeriodExpiresAt,
            ),
            willRenew = plus.willRenew,
            expiresAt = expiresAt,
            gracePeriodExpiresAt = gracePeriodExpiresAt,
            store = plus.store.name,
            productIdentifier = productId,
        )
    }

    /** SDK値をPlusへ昇格させず、同じ恒久subjectのserver行だけを正本にする。 */
    private suspend fun verifiedServerStatus(userId: String): EntitlementStatus {
        val candidate = fetchServerEntitlement(userId)
        val productId = candidate.productIdentifier
        val lifecycle = candidate.lifecycleState
        if (!candidate.isPlus || productId !in RevenueCatEntitlementContract.PRODUCTS) {
            return EntitlementStatus()
        }
        if (lifecycle != null && lifecycle !in setOf("active", "canceled", "grace", "billing_issue")) {
            return EntitlementStatus()
        }
        val verified = isVerifiedPlusStatus(
            isActive = true,
            productId = productId,
            expiresAt = candidate.expiresAt,
            gracePeriodExpiresAt = candidate.gracePeriodExpiresAt,
        )
        return if (verified) candidate else EntitlementStatus()
    }

    private companion object {
        fun canonicalPermanentUserId(value: String): String? = runCatching {
            UUID.fromString(value).toString()
        }.getOrNull()?.takeIf { it.equals(value, ignoreCase = true) }
    }
}

/** SDK の購入用 ID を保持し、表示した base plan と購入対象を一致させる。 */
internal fun Offering?.plusPackages(): List<PlusPackage> {
    if (this?.identifier != RevenueCatEntitlementContract.OFFERING) return emptyList()
    return availablePackages
        .filter { it.product.id in RevenueCatEntitlementContract.PURCHASE_PRODUCTS }
        .map {
            PlusPackage(
                id = it.product.id,
                title = it.product.title,
                priceString = it.product.price.formatted,
                period = it.product.period?.iso8601 ?: "",
            )
        }
}

internal fun Offering?.requirePlusPurchasePackage(productId: String): Package {
    require(productId in RevenueCatEntitlementContract.PURCHASE_PRODUCTS) {
        "requested product is not supported"
    }
    require(this?.identifier == RevenueCatEntitlementContract.OFFERING) {
        "default offering is unavailable"
    }
    return availablePackages.firstOrNull { it.product.id == productId }
        ?: throw IllegalArgumentException("requested product is unavailable")
}
