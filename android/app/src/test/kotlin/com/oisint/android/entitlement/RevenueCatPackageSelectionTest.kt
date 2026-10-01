package com.oisint.android.entitlement

import com.android.billingclient.api.ProductDetails
import com.revenuecat.purchases.Offering
import com.revenuecat.purchases.Package
import com.revenuecat.purchases.PackageType
import com.revenuecat.purchases.PresentedOfferingContext
import com.revenuecat.purchases.ProductType
import com.revenuecat.purchases.models.GoogleStoreProduct
import com.revenuecat.purchases.models.Period
import com.revenuecat.purchases.models.Price
import com.revenuecat.purchases.models.StoreProduct
import com.revenuecat.purchases.models.TestStoreProduct
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RevenueCatPackageSelectionTest {
    private val monthly = "oisint_plus_monthly"
    private val annual = "oisint_plus_annual"

    @Test
    fun googleSdkIdsSurviveOfferingsAndResolveTheExactPurchasePackage() {
        val month = pkg(google(monthly, "monthly2", "P1M", "¥580"))
        val year = pkg(google(annual, "2annual", "P1Y", "¥4,800"))
        val offering = offering(month, year)

        // Exercise the actual SDK getter, not a fake composite product ID.
        assertEquals("$monthly:monthly2", month.product.id)
        assertEquals("$annual:2annual", year.product.id)
        val displayed = offering.plusPackages()
        assertEquals(listOf("$monthly:monthly2", "$annual:2annual"), displayed.map { it.id })
        assertEquals(listOf("¥580", "¥4,800"), displayed.map { it.priceString })
        assertEquals(listOf("P1M", "P1Y"), displayed.map { it.period })
        assertSame(month, offering.requirePlusPurchasePackage(displayed[0].id))
        assertSame(year, offering.requirePlusPurchasePackage(displayed[1].id))
    }

    @Test
    fun unknownOrSwappedBasePlansCannotBeDisplayedOrSelectedForPurchase() {
        for ((product, basePlan) in listOf(monthly to "unknown", monthly to "2annual", annual to "monthly2")) {
            val candidate = pkg(google(product, basePlan))
            val offering = offering(candidate)
            assertTrue(offering.plusPackages().isEmpty())
            assertThrows(IllegalArgumentException::class.java) {
                offering.requirePlusPurchasePackage(candidate.product.id)
            }
        }
    }

    @Test
    fun knownGooglePlanDoesNotResolveToAnotherPlanOrBareProduct() {
        val offering = offering(pkg(google(monthly, "unknown")), pkg(testStore(monthly)))
        assertThrows(IllegalArgumentException::class.java) {
            offering.requirePlusPurchasePackage("$monthly:monthly2")
        }
    }

    @Test
    fun bareTestStoreProductsRemainCompatible() {
        val month = pkg(testStore(monthly))
        val year = pkg(testStore(annual))
        val offering = offering(month, year)
        assertEquals(listOf(monthly, annual), offering.plusPackages().map { it.id })
        assertSame(month, offering.requirePlusPurchasePackage(monthly))
        assertSame(year, offering.requirePlusPurchasePackage(annual))
    }

    @Test
    fun missingOrNonDefaultOfferingCannotProvidePurchaseTargets() {
        val other = Offering("other", "fixture", emptyMap(), listOf(pkg(google(monthly, "monthly2"))))
        for (offering in listOf(null, other)) {
            assertTrue(offering.plusPackages().isEmpty())
            assertThrows(IllegalArgumentException::class.java) {
                offering.requirePlusPurchasePackage("$monthly:monthly2")
            }
        }
    }

    @Test
    fun suffixesAndUnrelatedProductIdsRemainRejected() {
        for (id in listOf("$monthly:monthly2:offer", "$annual:2annual:offer", "$monthly:monthly2 ", "other:monthly2")) {
            val offering = offering(pkg(testStore(id)))
            assertTrue(offering.plusPackages().isEmpty())
            assertThrows(IllegalArgumentException::class.java) { offering.requirePlusPurchasePackage(id) }
        }
    }

    @Test
    fun purchaseIdsDoNotBroadenServerEntitlementVerification() {
        val expiry = "2030-01-01T00:00:00Z"
        for (id in listOf(monthly, annual)) {
            assertTrue(isVerifiedPlusStatus(true, id, expiry, nowMs = 0))
        }
        for (id in listOf("$monthly:monthly2", "$annual:2annual", "$monthly:unknown")) {
            assertFalse(isVerifiedPlusStatus(true, id, expiry, nowMs = 0))
        }
        assertFalse(isVerifiedPlusStatus(true, monthly, null, nowMs = 0))
        assertFalse(isVerifiedPlusStatus(false, monthly, expiry, nowMs = 0))
        assertFalse(isVerifiedPlusStatus(true, monthly, expiry, nowMs = Long.MAX_VALUE))
    }

    private fun offering(vararg packages: Package) =
        Offering("default", "fixture", emptyMap(), packages.toList())

    private fun pkg(product: StoreProduct) =
        Package("fixture", PackageType.CUSTOM, product, PresentedOfferingContext("default"))

    private fun google(
        product: String,
        basePlan: String,
        period: String = "P1M",
        formattedPrice: String = "fixture price",
    ): GoogleStoreProduct = GoogleStoreProduct(
        productId = product,
        basePlanId = basePlan,
        type = ProductType.SUBS,
        price = Price(formattedPrice, 1_000_000, "JPY"),
        name = "fixture",
        title = "fixture title",
        description = "fixture description",
        period = Period(1, if (period == "P1Y") Period.Unit.YEAR else Period.Unit.MONTH, period),
        subscriptionOptions = null,
        defaultOption = null,
        productDetails = inertProductDetails(),
        presentedOfferingContext = PresentedOfferingContext("default"),
    )

    private fun testStore(id: String) = TestStoreProduct(
        id = id,
        name = "fixture",
        title = "fixture title",
        description = "fixture description",
        price = Price("fixture price", 1_000_000, "JPY"),
        period = Period(1, Period.Unit.MONTH, "P1M"),
        freeTrialPricingPhase = null,
        introPricePricingPhase = null,
    )

    private fun inertProductDetails(): ProductDetails {
        // The local JVM cannot run Android's JSON-backed Billing constructor. This opaque,
        // unused dependency only satisfies GoogleStoreProduct's non-null constructor slot;
        // actual SDK ID/price/period getters run above, and no Billing operation is invoked.
        val allocator = Class.forName("sun.misc.Unsafe")
        val field = allocator.getDeclaredField("theUnsafe").apply { isAccessible = true }
        return allocator.getMethod("allocateInstance", Class::class.java)
            .invoke(field.get(null), ProductDetails::class.java) as ProductDetails
    }
}
