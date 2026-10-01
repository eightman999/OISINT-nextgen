package com.oisint.android.entitlement

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.oisint.android.BuildConfig
import com.oisint.android.OisintApplication
import com.oisint.android.auth.AuthState
import com.revenuecat.purchases.CacheFetchPolicy
import com.revenuecat.purchases.LogLevel
import com.revenuecat.purchases.ProductType
import com.revenuecat.purchases.Purchases
import com.revenuecat.purchases.PurchasesException
import com.revenuecat.purchases.awaitCustomerInfo
import com.revenuecat.purchases.awaitGetProducts
import com.revenuecat.purchases.awaitOfferings
import com.revenuecat.purchases.models.GoogleStoreProduct
import java.io.File
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Opt-in, non-purchasing device evidence. Uses the app's existing permanent login only.
 * Never configures an anonymous identity, changes a catalog, or launches a purchase.
 * Reports contain public product metadata and booleans, never keys or account identifiers.
 */
@RunWith(AndroidJUnit4::class)
class LiveBillingReadbackTest {
    private val app: OisintApplication
        get() = InstrumentationRegistry.getInstrumentation()
            .targetContext.applicationContext as OisintApplication

    @Before
    fun requireExplicitLiveRun() {
        assumeTrue(
            "Explicit liveBillingReadback=true is required",
            InstrumentationRegistry.getArguments().getString("liveBillingReadback") == "true",
        )
        Purchases.logLevel = LogLevel.ERROR
    }

    @Test
    fun permanentIdentityInitializesGoogleSdk() = record("initialization") { report ->
        awaitAuthenticatedSdk(report)
    }

    @Test
    fun googleProductsReadBackWithoutPurchase() = record("products") { report ->
        val sdk = awaitAuthenticatedSdk(report)
        // Direct store lookup is independent of RevenueCat offering/entitlement mapping.
        val products = withTimeout(30_000) {
            sdk.awaitGetProducts(EXPECTED.keys.toList(), ProductType.SUBS)
        }
        report.put("returnedProductCount", products.size)
        val rows = JSONArray()
        val matches = EXPECTED.map { (productId, expected) ->
            val matching = products.filterIsInstance<GoogleStoreProduct>().filter {
                it.productId == productId && it.basePlanId == expected.basePlan
            }
            val product = matching.singleOrNull()
            val row = JSONObject().put("requestedProductId", productId)
                .put("expectedBasePlanId", expected.basePlan)
                .put("matchingCount", matching.size)
            if (product != null) {
                row.put("id", product.id)
                    .put("productId", product.productId)
                    .put("basePlanId", product.basePlanId)
                    .put("period", product.period?.iso8601 ?: JSONObject.NULL)
                    .put("priceMicros", product.price.amountMicros)
                    .put("currency", product.price.currencyCode)
                    .put("localizedPrice", product.price.formatted)
            }
            val matchesExpected = product != null &&
                product.id == "$productId:${expected.basePlan}" &&
                product.period?.iso8601 == expected.period &&
                product.price.amountMicros == expected.priceMicros &&
                product.price.currencyCode == "JPY" && product.price.formatted.isNotBlank()
            row.put("matchesExpected", matchesExpected)
            rows.put(row)
            matchesExpected
        }
        report.put("products", rows)
        // Mapping is intentionally absent during pre-activation work. Observe, do not invent it.
        try {
            val offering = withTimeout(30_000) { sdk.awaitOfferings().current }
            report.put("defaultOfferingPresent", offering?.identifier == "default")
                .put("offeringPackageCount", offering?.availablePackages?.size ?: 0)
                .put("expectedGoogleOfferingProductCount", offering?.availablePackages?.count {
                    it.product.id in EXPECTED.map { (id, spec) -> "$id:${spec.basePlan}" }
                } ?: 0)
        } catch (error: Exception) {
            report.put("offeringsError", safeError(error))
        }
        check(matches.all { it }) { "Expected Google products are not available with verified metadata" }
    }

    private suspend fun awaitAuthenticatedSdk(report: JSONObject): Purchases {
        val container = app.container
        report.put("liveBuild", BuildConfig.DATA_PROVIDER_MODE == "live")
            .put("googleKeyConfigured", BuildConfig.REVENUECAT_PUBLIC_API_KEY.startsWith("goog_"))
            .put("packageMatches", app.packageName == "com.oisint.android")
        check(BuildConfig.DATA_PROVIDER_MODE == "live")
        check(BuildConfig.REVENUECAT_PUBLIC_API_KEY.startsWith("goog_"))
        check(container.entitlementProvider is RevenueCatEntitlementProvider)
        report.put("permanentAuth", false).put("sdkAuthenticated", false)
        val auth = withTimeout(30_000) {
            while (container.authState.value !is AuthState.Authenticated) delay(250)
            container.authState.value as AuthState.Authenticated
        }
        report.put("permanentAuth", true)
        withTimeout(30_000) {
            while (!container.entitlementProvider.isAuthenticated.value) delay(250)
        }
        report.put("sdkAuthenticated", true).put("sdkConfigured", Purchases.isConfigured)
        check(Purchases.isConfigured)
        val sdk = Purchases.sharedInstance
        report.put("anonymous", sdk.isAnonymous)
            .put("identityMatchesPermanentAuth", sdk.appUserID.equals(auth.userId, ignoreCase = true))
            .put("store", sdk.store.name)
        check(!sdk.isAnonymous)
        check(sdk.appUserID.equals(auth.userId, ignoreCase = true))
        check(sdk.store.name == "PLAY_STORE")
        withTimeout(30_000) { sdk.awaitCustomerInfo(CacheFetchPolicy.FETCH_CURRENT) }
        report.put("customerInfoNetworkReadback", true)
        return sdk
    }

    private fun record(name: String, operation: suspend (JSONObject) -> Unit) = runBlocking {
        val report = JSONObject().put("observedAtEpochMs", System.currentTimeMillis())
            .put("kind", name).put("result", "FAIL").put("purchaseAttempted", false)
            .put("runId", InstrumentationRegistry.getArguments().getString("billingReadbackRunId", ""))
        var failed = false
        try {
            operation(report)
            report.put("result", "PASS")
        } catch (error: Exception) {
            failed = true
            report.put("error", safeError(error))
        } finally {
            File(app.filesDir, "billing-readback-$name.json").writeText(report.toString(2))
        }
        if (failed) throw AssertionError("Live Billing $name failed; inspect sanitized readback JSON")
    }

    private fun safeError(error: Exception): String =
        if (error is PurchasesException) error.code.name else error.javaClass.simpleName

    private data class Expected(val basePlan: String, val period: String, val priceMicros: Long)

    private companion object {
        // Assertions, not application prices: the observed values always come from the store SDK.
        val EXPECTED = linkedMapOf(
            "oisint_plus_monthly" to Expected("monthly2", "P1M", 580_000_000L),
            "oisint_plus_annual" to Expected("2annual", "P1Y", 4_800_000_000L),
        )
    }
}
