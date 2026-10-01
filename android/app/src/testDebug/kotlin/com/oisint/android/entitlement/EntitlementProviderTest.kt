package com.oisint.android.entitlement

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EntitlementProviderTest {
    private val userId = "00000000-0000-4000-8000-000000000571"

    @Test
    fun anonymousCannotRestoreOrPurchaseAndDoesNotBecomeAuthenticated() = runTest {
        val provider = MockEntitlementProvider()
        assertFalse(provider.isAuthenticated.value)
        val error = runCatching { provider.restore() }.exceptionOrNull()
        assertTrue(error is EntitlementAnonymousException)
        assertFalse(provider.status.value.isPlus)
    }

    @Test
    fun permanentIdentityReceivesOnlyContractPackagesAndLogoutClearsState() = runTest {
        val provider = MockEntitlementProvider()
        val packages = provider.offerings()
        assertEquals(
            setOf(
                RevenueCatEntitlementContract.MONTHLY_PRODUCT,
                RevenueCatEntitlementContract.ANNUAL_PRODUCT,
            ),
            packages.map { it.id }.toSet(),
        )
        provider.logIn(userId)
        assertTrue(provider.isAuthenticated.value)
        assertFalse(provider.status.value.isPlus)
        provider.logOut()
        assertFalse(provider.isAuthenticated.value)
        assertFalse(provider.status.value.isPlus)
    }

    @Test
    fun nonUuidIdentityIsRejected() = runTest {
        val provider = MockEntitlementProvider()
        val error = runCatching { provider.logIn("\$RCAnonymousID:123") }.exceptionOrNull()
        assertTrue(error is EntitlementAnonymousException)
        assertFalse(provider.isAuthenticated.value)
    }

    @Test
    fun sdkActiveFlagDoesNotGrantWithoutFiniteFutureExpiry() {
        val now = 1_000_000L
        assertTrue(
            isVerifiedPlusStatus(
                isActive = true,
                productId = RevenueCatEntitlementContract.MONTHLY_PRODUCT,
                expiresAt = "1970-01-01T00:16:41Z",
                nowMs = now,
            ),
        )
        assertFalse(
            isVerifiedPlusStatus(
                isActive = true,
                productId = RevenueCatEntitlementContract.MONTHLY_PRODUCT,
                expiresAt = null,
                nowMs = now,
            ),
        )
        assertTrue(
            isVerifiedPlusStatus(
                isActive = true,
                productId = RevenueCatEntitlementContract.MONTHLY_PRODUCT,
                expiresAt = null,
                gracePeriodExpiresAt = "1970-01-01T00:16:41Z",
                nowMs = now,
            ),
        )
        assertFalse(
            isVerifiedPlusStatus(
                isActive = true,
                productId = RevenueCatEntitlementContract.MONTHLY_PRODUCT,
                expiresAt = null,
                gracePeriodExpiresAt = "not-a-timestamp",
                nowMs = now,
            ),
        )
        assertFalse(
            isVerifiedPlusStatus(
                isActive = true,
                productId = RevenueCatEntitlementContract.MONTHLY_PRODUCT,
                expiresAt = "1970-01-01T00:16:39Z",
                nowMs = now,
            ),
        )
        assertFalse(
            isVerifiedPlusStatus(
                isActive = true,
                productId = "oisint_plus_pro",
                expiresAt = "2099-01-01T00:00:00Z",
                nowMs = now,
            ),
        )
    }

    companion object {
        private const val RCAnonymousID = "RCAnonymousID"
    }
}
