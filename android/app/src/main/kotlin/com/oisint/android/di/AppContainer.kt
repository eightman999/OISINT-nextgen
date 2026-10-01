package com.oisint.android.di

import android.content.Context
import com.oisint.android.BuildConfig
import com.oisint.android.auth.AuthController
import com.oisint.android.auth.EntitlementIdentitySynchronizer
import com.oisint.android.auth.UnavailableAuthController
import com.oisint.android.data.DataProvider
import com.oisint.android.data.UnavailableDataProvider
import com.oisint.android.data.live.LiveDataProvider
import com.oisint.android.data.live.OisintApiClient
import com.oisint.android.data.live.SupabaseClients
import com.oisint.android.entitlement.EntitlementProvider
import com.oisint.android.entitlement.RevenueCatEntitlementProvider
import com.oisint.android.entitlement.UnavailableEntitlementProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/**
 * 手動 DI コンテナ（計画書 §2.6）。
 * mock/live の分岐はこの provider factory 1 箇所のみに閉じる（spec.md §26 と同じ規律。
 * UI・ViewModel に mock/live の if を書かない。verify.sh --full の層規約 grep が検査する）。
 */
class AppContainer(private val context: Context) {

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var liveClients: SupabaseClients? = null

    val dataProvider: DataProvider = when (BuildConfig.DATA_PROVIDER_MODE) {
        "live" -> {
            if (BuildConfig.OISINT_SUPABASE_URL.isNotEmpty() && BuildConfig.OISINT_SUPABASE_ANON_KEY.isNotEmpty()) {
                try {
                    val clients = SupabaseClients(
                        supabaseUrl = BuildConfig.OISINT_SUPABASE_URL,
                        supabaseAnonKey = BuildConfig.OISINT_SUPABASE_ANON_KEY,
                        allowLocalhost = BuildConfig.BUILD_TYPE == "debug",
                    )
                    val api = OisintApiClient(
                        apiBaseUrl = BuildConfig.OISINT_API_URL,
                        tokenProvider = { clients.accessToken() },
                        allowLocalhost = BuildConfig.BUILD_TYPE == "debug",
                    )
                    liveClients = clients
                    LiveDataProvider(clients, api, appScope)
                } catch (_: IllegalArgumentException) {
                    // URL/secret設定の不備で起動を中断せず、ネットワーク境界をUnavailableへ閉じる。
                    UnavailableDataProvider()
                }
            } else {
                // Releaseはmockへフォールバックせず、設定不足を安全側へ倒す。
                UnavailableDataProvider()
            }
        }
        "mock" -> VariantProviderFactory.dataProvider(appScope)
        else -> UnavailableDataProvider()
    }

    /**
     * 課金providerはSupabase恒久UUIDへbindされるまでSDKをconfigureしない。
     * 公開keyが無いreleaseはUnavailableへ倒し、課金状態を推測しない。
     */
    val entitlementProvider: EntitlementProvider = when (BuildConfig.DATA_PROVIDER_MODE) {
        "mock" -> VariantProviderFactory.entitlementProvider()
        "live" -> if (BuildConfig.REVENUECAT_PUBLIC_API_KEY.isBlank()) {
            UnavailableEntitlementProvider()
        } else {
            RevenueCatEntitlementProvider(
                context,
                BuildConfig.REVENUECAT_PUBLIC_API_KEY,
                fetchServerEntitlement = { userId ->
                    liveClients?.fetchServerEntitlement(userId) ?: com.oisint.android.entitlement.EntitlementStatus()
                },
            )
        }
        else -> UnavailableEntitlementProvider()
    }

    /** Auth UIが観測するSupabase状態。fixtureはdebug modeでのみ選ぶ。 */
    val authController: AuthController = when {
        liveClients != null -> liveClients!!
        BuildConfig.DATA_PROVIDER_MODE == "mock" && BuildConfig.BUILD_TYPE == "debug" -> VariantProviderFactory.authController()
        else -> UnavailableAuthController()
    }
    val authState = authController.state

    private val entitlementIdentitySynchronizer = EntitlementIdentitySynchronizer(
        bind = { userId -> bindEntitlementIdentity(userId, anonymous = false) },
        clear = { clearEntitlementIdentity() },
    )

    init {
        // Auth状態をRevenueCat identityへ変換する箇所を1つに限定する。
        appScope.launch {
            authController.state.collect { state ->
                try {
                    entitlementIdentitySynchronizer.synchronize(state)
                } catch (_: Exception) {
                    // SDK障害はAuth成功を壊さず、entitlementだけFreeへ閉じる。
                    runCatching { clearEntitlementIdentity() }
                }
            }
        }
        appScope.launch { authController.initialize() }
    }

    /** 外部Auth link後など、認証subjectが確定した時に一度だけ呼ぶ境界。 */
    suspend fun bindEntitlementIdentity(userId: String, anonymous: Boolean) {
        if (anonymous) entitlementProvider.logOut() else entitlementProvider.logIn(userId)
    }

    /** logout/account switch時に旧userのPlus状態を残さない。 */
    suspend fun clearEntitlementIdentity() {
        entitlementProvider.logOut()
    }

    suspend fun signInWithEmail(email: String, password: String, confirmAccountSwitch: Boolean) {
        authController.signInWithEmail(email, password, confirmAccountSwitch)
    }

    suspend fun signUpWithEmail(email: String, password: String, confirmAccountSwitch: Boolean) {
        authController.signUpWithEmail(email, password, confirmAccountSwitch)
    }

    suspend fun beginGoogleAuth() {
        authController.beginGoogleAuth()
    }

    fun handleAuthDeepLink(intent: android.content.Intent) {
        authController.handleDeepLink(intent)
    }

    suspend fun signOut() {
        authController.signOut()
    }

    /**
     * join 画面の候補プレビュー（i/[token].tsx L17 = api.ts getInvestigationByShareToken。
     * mock のみ返す・live は null = Web と同一挙動）。ui 層は data.mock を import しない規約のため、
     * mock 分岐はここ（DI 層）に閉じる。
     */
    val previewInvestigationByShareToken: (String) -> com.oisint.android.model.Investigation? =
        { token -> VariantProviderFactory.previewInvestigationByShareToken(dataProvider, token) }
}
