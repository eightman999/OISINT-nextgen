package com.oisint.android.di

import com.oisint.android.data.DataProvider
import com.oisint.android.data.mock.MockDataProvider
import com.oisint.android.auth.AuthController
import com.oisint.android.auth.MockAuthController
import com.oisint.android.entitlement.EntitlementProvider
import com.oisint.android.entitlement.MockEntitlementProvider
import com.oisint.android.model.Investigation
import kotlinx.coroutines.CoroutineScope

/** Debug variantだけがローカルfixtureを実装する。Release variantには同名のfail-closed実装がある。 */
internal object VariantProviderFactory {
    fun dataProvider(scope: CoroutineScope): DataProvider = MockDataProvider(scope)

    fun entitlementProvider(): EntitlementProvider = MockEntitlementProvider()

    fun authController(): AuthController = MockAuthController()

    fun previewInvestigationByShareToken(provider: DataProvider, token: String): Investigation? =
        (provider as? MockDataProvider)?.findByShareToken(token)
}
