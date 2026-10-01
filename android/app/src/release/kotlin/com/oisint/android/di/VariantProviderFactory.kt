package com.oisint.android.di

import com.oisint.android.data.DataProvider
import com.oisint.android.data.UnavailableDataProvider
import com.oisint.android.auth.AuthController
import com.oisint.android.auth.UnavailableAuthController
import com.oisint.android.entitlement.EntitlementProvider
import com.oisint.android.entitlement.UnavailableEntitlementProvider
import com.oisint.android.model.Investigation
import kotlinx.coroutines.CoroutineScope

/** Release variantではfixtureを参照せず、予期しないmock指定も安全側へ閉じる。 */
internal object VariantProviderFactory {
    fun dataProvider(scope: CoroutineScope): DataProvider = UnavailableDataProvider()

    fun entitlementProvider(): EntitlementProvider = UnavailableEntitlementProvider()

    fun authController(): AuthController = UnavailableAuthController()

    fun previewInvestigationByShareToken(provider: DataProvider, token: String): Investigation? = null
}
