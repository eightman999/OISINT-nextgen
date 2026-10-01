package com.oisint.android.auth

import android.content.Intent
import java.util.UUID
import kotlinx.coroutines.flow.StateFlow

/**
 * Android版のAuth状態。課金SDKへ渡してよいsubjectは Authenticated のUUIDだけ。
 * Anonymous は調査を継続できるが、RevenueCat identityには使わない。
 */
sealed interface AuthState {
    data object Loading : AuthState
    data class Anonymous(val userId: String) : AuthState
    data class Authenticated(val userId: String, val email: String?) : AuthState
    data object SignedOut : AuthState
    data class Error(val message: String) : AuthState
}

class AuthSwitchConfirmationRequired : IllegalStateException()

/** Auth UIとSupabase実装の境界。secretやservice roleはこの契約に含めない。 */
interface AuthController {
    val state: StateFlow<AuthState>

    /** server削除後のlocal session purge失敗をUIへ明示する。既定は警告なし。 */
    val lastDeleteLocalCleanupFailed: Boolean
        get() = false

    suspend fun initialize()
    suspend fun signInWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Boolean,
    )

    suspend fun signUpWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Boolean,
    )

    suspend fun beginGoogleAuth()
    fun handleDeepLink(intent: Intent)
    suspend fun signOut()

    /** Supabase Edge Function delete-account。認証済みJWT以外を受け付けない。 */
    suspend fun deleteAccount()
}

/** Auth遷移を課金SDK identityへ反映する。switch時は旧identityを先に消す。 */
class EntitlementIdentitySynchronizer(
    private val bind: suspend (String) -> Unit,
    private val clear: suspend () -> Unit,
) {
    private var boundUserId: String? = null

    suspend fun synchronize(next: AuthState) {
        when (next) {
            is AuthState.Authenticated -> {
                val canonicalUserId = canonicalUuid(next.userId)
                if (canonicalUserId == null) {
                    clear()
                    boundUserId = null
                    return
                }
                if (boundUserId != null && boundUserId != canonicalUserId) {
                    clear()
                    boundUserId = null
                }
                bind(canonicalUserId)
                boundUserId = canonicalUserId
            }

            else -> {
                clear()
                boundUserId = null
            }
        }
    }

    private fun canonicalUuid(value: String): String? = runCatching {
        val trimmed = value.trim()
        val canonical = UUID.fromString(trimmed).toString()
        canonical.takeIf { it.equals(trimmed, ignoreCase = true) }
    }.getOrNull()
}

/** Releaseの設定不足用。匿名AuthやGoogle遷移を推測実行せず、画面へ安全に失敗を返す。 */
class UnavailableAuthController : AuthController {
    private val _state = kotlinx.coroutines.flow.MutableStateFlow<AuthState>(
        AuthState.Error("認証設定を確認できません。現在はアカウント操作を利用できません。"),
    )
    override val state: StateFlow<AuthState> = _state

    override suspend fun initialize() = Unit

    override suspend fun signInWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Boolean,
    ) = unavailable()

    override suspend fun signUpWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Boolean,
    ) = unavailable()

    override suspend fun beginGoogleAuth() = unavailable()

    override fun handleDeepLink(intent: Intent) {
        _state.value = AuthState.Error("認証設定を確認できません。現在はアカウント操作を利用できません。")
    }

    override suspend fun signOut() {
        _state.value = AuthState.SignedOut
    }

    override suspend fun deleteAccount() = unavailable()

    private fun unavailable(): Nothing =
        throw IllegalStateException("認証設定を確認できません")
}
