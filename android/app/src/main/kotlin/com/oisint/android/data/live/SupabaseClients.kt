package com.oisint.android.data.live

import android.content.Intent
import com.oisint.android.auth.AuthController
import com.oisint.android.auth.AuthState
import com.oisint.android.auth.AuthSwitchConfirmationRequired
import com.oisint.android.entitlement.EntitlementStatus
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.Auth
import io.github.jan.supabase.auth.FlowType
import io.github.jan.supabase.auth.SignOutScope
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.handleDeeplinks
import io.github.jan.supabase.auth.providers.Google
import io.github.jan.supabase.auth.providers.builtin.Email
import io.github.jan.supabase.createSupabaseClient
import io.github.jan.supabase.postgrest.Postgrest
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.realtime.Realtime
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.utils.io.readAvailable
import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

internal object SupabaseEndpointPolicy {
    fun requireValid(value: String, allowLocalhost: Boolean = false): String {
        val normalized = value.trim().trimEnd('/')
        val uri = runCatching { URI(normalized) }.getOrNull()
            ?: throw IllegalArgumentException("Supabase接続先が不正です")
        val host = uri.host?.lowercase()
        val isLocalhost = host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
        val validHost = host != null && (
            host.matches(Regex("[a-z0-9][a-z0-9-]*\\.supabase\\.co")) ||
                (allowLocalhost && isLocalhost)
            )
        require(
            (uri.scheme.equals("https", ignoreCase = true) ||
                (allowLocalhost && uri.scheme.equals("http", ignoreCase = true) && isLocalhost)) &&
                (uri.port == -1 || uri.port == 443 || (allowLocalhost && isLocalhost)) &&
                validHost &&
                uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/"),
        ) { "Supabase接続先が不正です" }
        return if (isLocalhost) {
            "${uri.scheme.lowercase()}://${uri.rawAuthority}"
        } else {
            "https://$host"
        }
    }
}

internal fun isValidBoundedContentLength(value: String?, maxBytes: Long): Boolean {
    if (value == null) return true
    val parsed = value.toLongOrNull() ?: return false
    return parsed >= 0 && parsed <= maxBytes
}

/**
 * supabase-kt クライアント初期化と匿名サインイン（live.ts L38-53 ensureUserId の移植）。
 *
 * - anon key のみをクライアントに置く（spec.md §34。service role は Edge Function 側）。
 * - セッション永続化（T7 実測）: auth-kt のデフォルト SessionManager
 *   （multiplatform-settings → Android では SharedPreferences）に保存され、
 *   プロセス再起動後も匿名セッションが維持される。
 */
class SupabaseClients(
    supabaseUrl: String,
    supabaseAnonKey: String,
    allowLocalhost: Boolean = false,
) : AuthController {

    companion object {
        const val AUTH_REDIRECT_URI = "oisint://account"
        private const val ACCOUNT_DELETION_TIMEOUT_MS = 5_000L
        private const val MAX_ACCOUNT_DELETION_RESPONSE_BYTES = 16 * 1024L
    }

    private val validatedSupabaseUrl = SupabaseEndpointPolicy.requireValid(supabaseUrl, allowLocalhost)

    val client: SupabaseClient = createSupabaseClient(
        supabaseUrl = validatedSupabaseUrl,
        supabaseKey = supabaseAnonKey,
    ) {
        install(Auth) {
            flowType = FlowType.PKCE
            scheme = "oisint"
            host = "account"
            defaultRedirectUrl = AUTH_REDIRECT_URI
        }
        install(Postgrest)
        install(Realtime)
    }

    private val supabaseBaseUrl = validatedSupabaseUrl
    private val anonKey = supabaseAnonKey
    private val accountDeletionHttp = HttpClient(OkHttp) {
        engine {
            config { followRedirects(false) }
        }
        install(HttpTimeout) {
            requestTimeoutMillis = ACCOUNT_DELETION_TIMEOUT_MS
            connectTimeoutMillis = ACCOUNT_DELETION_TIMEOUT_MS
            socketTimeoutMillis = ACCOUNT_DELETION_TIMEOUT_MS
        }
    }

    private val sessionMutex = Mutex()
    private val authCallbackScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow<AuthState>(AuthState.Loading)
    override val state: StateFlow<AuthState> = _state.asStateFlow()
    @Volatile
    override var lastDeleteLocalCleanupFailed: Boolean = false
        private set

    /**
     * live.ts L38-53: 既存セッションがあればその user id、無ければ signInAnonymously()。
     * 失敗時はキャッシュせず例外（Promise キャッシュの sessionPromise=null リセットに対応）。
     */
    suspend fun ensureUserId(): String = sessionMutex.withLock {
        client.auth.currentSessionOrNull()?.user?.id?.let { return it }
        try {
            client.auth.signInAnonymously()
        } catch (e: Exception) {
            throw IllegalStateException("匿名サインインに失敗しました: ${e.message ?: "unknown"}", e)
        }
        client.auth.currentSessionOrNull()?.user?.id
            ?: throw IllegalStateException("匿名サインインに失敗しました: unknown")
    }

    /** callApi が Authorization ヘッダに載せる access token（live.ts L69-71） */
    suspend fun accessToken(): String {
        ensureUserId()
        return client.auth.currentSessionOrNull()?.accessToken
            ?: throw IllegalStateException("認証セッションがありません")
    }

    /** 課金SDKへ匿名subjectを渡さないための認証状態（JWTのuser情報を正本にする）。 */
    suspend fun isCurrentUserAnonymous(): Boolean =
        client.auth.currentUserOrNull()?.isAnonymous == true

    @Serializable
    private data class ServerEntitlementRow(
        @SerialName("user_id") val userId: String? = null,
        @SerialName("entitlement_id") val entitlementId: String? = null,
        @SerialName("offering_id") val offeringId: String? = null,
        @SerialName("product_id") val productId: String? = null,
        @SerialName("app_user_id") val appUserId: String? = null,
        val store: String? = null,
        @SerialName("is_active") val isActive: Boolean? = null,
        @SerialName("lifecycle_state") val lifecycleState: String? = null,
        @SerialName("expires_at") val expiresAt: String? = null,
        @SerialName("will_renew") val willRenew: Boolean? = null,
        @SerialName("grace_period_expires_at") val gracePeriodExpiresAt: String? = null,
    )

    private val strictJson = Json {
        ignoreUnknownKeys = false
        isLenient = false
    }

    /** NativeのPlus表示もWebと同じ `get_my_entitlement` server正本を読む。 */
    suspend fun fetchServerEntitlement(userId: String): EntitlementStatus {
        val current = client.auth.currentUserOrNull()
        if (current == null || current.isAnonymous == true || current.id != userId) {
            return EntitlementStatus()
        }
        val rows = client.postgrest.rpc("get_my_entitlement").decodeList<ServerEntitlementRow>()
        val row = rows.firstOrNull() ?: return EntitlementStatus()
        if (row.userId != userId || row.appUserId != userId ||
            row.entitlementId != "plus" || row.offeringId != "default" ||
            row.isActive != true || row.productId !in setOf(
                "oisint_plus_monthly",
                "oisint_plus_annual",
            ) || row.lifecycleState !in setOf("active", "canceled", "grace", "billing_issue")
        ) {
            return EntitlementStatus()
        }
        val expiry = row.expiresAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
        val grace = row.gracePeriodExpiresAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
        val now = Instant.now()
        if ((expiry == null || !expiry.isAfter(now)) && (grace == null || !grace.isAfter(now))) {
            return EntitlementStatus()
        }
        return EntitlementStatus(
            isPlus = true,
            willRenew = row.willRenew,
            expiresAt = expiry?.toString(),
            gracePeriodExpiresAt = grace?.toString(),
            store = row.store,
            productIdentifier = row.productId,
            lifecycleState = row.lifecycleState,
        )
    }

    override suspend fun initialize() {
        try {
            client.auth.awaitInitialization()
            // A manual identity link keeps the same subject. Older local sessions can therefore
            // still describe the user as anonymous even though GoTrue already attached Google.
            // Reconcile anonymous cached sessions against the authoritative server user once on
            // startup so an app restart can recover from a callback that was interrupted.
            if (client.auth.currentUserOrNull()?.isAnonymous == true) {
                runCatching { refreshAuthoritativeUserId() }
            }
            val userId = ensureUserId()
            publishState(userId)
        } catch (_: Exception) {
            // Auth failure is a separate state from entitlement failure. Do not expose
            // provider/server error text or turn it into a password error in the UI.
            _state.value = AuthState.Error("認証状態を取得できませんでした。時間をおいて再試行してください。")
        }
    }

    override suspend fun signInWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Boolean,
    ) = sessionMutex.withLock {
        val normalizedEmail = validateCredentials(email, password)
        requireSwitchConfirmationIfNeeded(confirmAccountSwitch)
        client.auth.signInWith(Email) {
            this.email = normalizedEmail
            this.password = password
        }
        val userId = client.auth.currentUserOrNull()?.id
            ?: throw IllegalStateException("認証セッションを確認できませんでした")
        publishState(userId)
    }

    override suspend fun signUpWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Boolean,
    ) = sessionMutex.withLock {
        val normalizedEmail = validateCredentials(email, password)
        requireSwitchConfirmationIfNeeded(confirmAccountSwitch)
        client.auth.signUpWith(Email) {
            this.email = normalizedEmail
            this.password = password
        }
        val user = client.auth.currentUserOrNull()
        if (user != null) {
            publishState(user.id)
        } else {
            _state.value = AuthState.SignedOut
        }
    }

    override suspend fun beginGoogleAuth() {
        sessionMutex.withLock {
            val current = client.auth.currentUserOrNull()
            if (current?.isAnonymous == true) {
                // OAuth link is deliberately used for anonymous users: Supabase keeps the
                // current UUID instead of silently creating an account with a new subject.
                client.auth.linkIdentity(Google, redirectUrl = AUTH_REDIRECT_URI)
            } else {
                client.auth.signInWith(Google, redirectUrl = AUTH_REDIRECT_URI)
            }
        }
    }

    override fun handleDeepLink(intent: Intent) {
        client.handleDeeplinks(
            intent,
            onSessionSuccess = {
                // `linkIdentity` updates GoTrue immediately, but the callback session can still
                // contain the pre-link anonymous user. Refresh the JWT and fetch the server user
                // before publishing UI state or binding the RevenueCat identity.
                authCallbackScope.launch {
                    sessionMutex.withLock {
                        try {
                            val userId = refreshAuthoritativeUserId()
                            publishState(userId)
                        } catch (_: Exception) {
                            _state.value = AuthState.Error("Google認証を完了できませんでした。もう一度お試しください。")
                        }
                    }
                }
            },
            onError = {
                _state.value = AuthState.Error("Google認証を完了できませんでした。もう一度お試しください。")
            },
        )
    }

    override suspend fun signOut() = sessionMutex.withLock {
        client.auth.signOut(SignOutScope.LOCAL)
        _state.value = AuthState.SignedOut
    }

    override suspend fun deleteAccount() = sessionMutex.withLock {
        lastDeleteLocalCleanupFailed = false
        val user = client.auth.currentUserOrNull()
            ?: throw IllegalStateException("認証セッションがありません")
        val token = client.auth.currentSessionOrNull()?.accessToken
            ?: throw IllegalStateException("認証セッションがありません")
        val response = accountDeletionHttp.post(
            "$supabaseBaseUrl/functions/v1/delete-account",
        ) {
            header(HttpHeaders.Authorization, "Bearer $token")
            header("apikey", anonKey)
            contentType(ContentType.Application.Json)
            // Edge Functionはbodyを受け取るが、削除対象は常にJWT subjectだけで決める。
            setBody("{}")
        }
        val contentLengthHeader = response.headers[HttpHeaders.ContentLength]
        val contentLength = contentLengthHeader?.toLongOrNull()
        if (!isValidBoundedContentLength(contentLengthHeader, MAX_ACCOUNT_DELETION_RESPONSE_BYTES)) {
            throw IllegalStateException(
                if (contentLength != null && contentLength < 0) "削除応答のサイズが不正です"
                else "削除応答が大きすぎます",
            )
        }
        val bytes = response.bodyAsChannel().readBounded(MAX_ACCOUNT_DELETION_RESPONSE_BYTES)
        if (!response.status.isSuccess()) {
            throw IllegalStateException("アカウントを削除できませんでした")
        }
        val body = decodeUtf8Strict(bytes)
        val decoded = runCatching { strictJson.decodeFromString<DeleteResponse>(body) }
            .getOrElse { throw IllegalStateException("アカウントを削除できませんでした") }
        if (!decoded.deleted) throw IllegalStateException("アカウントを削除できませんでした")
        // Edge Function側でAuth userを削除済み。server成功は撤回せず、端末状態は
        // 失敗しても即時signed-outへ倒す。SDKの永続SessionManager消去失敗はUIへ明示し、
        // 次回起動で旧subjectを復元しないための再試行対象として記録する。
        try {
            client.auth.signOut(SignOutScope.LOCAL)
        } catch (_: Exception) {
            lastDeleteLocalCleanupFailed = true
        }
        _state.value = AuthState.SignedOut
    }

    @Serializable
    private data class DeleteResponse(val deleted: Boolean)

    private suspend fun refreshAuthoritativeUserId(): String {
        client.auth.refreshCurrentSession()
        val user = client.auth.retrieveUserForCurrentSession(updateSession = true)
        return user.id
    }

    private suspend fun io.ktor.utils.io.ByteReadChannel.readBounded(maxBytes: Long): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(4 * 1024)
        while (!isClosedForRead) {
            val count = readAvailable(buffer, 0, buffer.size)
            if (count < 0) break
            if (output.size().toLong() + count > maxBytes) {
                throw IllegalStateException("削除応答が大きすぎます")
            }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun decodeUtf8Strict(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: Exception) {
        throw IllegalStateException("削除応答を解釈できません")
    }

    private fun publishState(userId: String) {
        val user = client.auth.currentUserOrNull()
        if (user == null || user.id != userId) {
            _state.value = AuthState.Error("認証状態を確認できませんでした。")
            return
        }
        _state.value = if (user.isAnonymous == true) {
            AuthState.Anonymous(userId)
        } else {
            AuthState.Authenticated(userId, user.email)
        }
    }

    private fun validateCredentials(email: String, password: String): String {
        val normalized = email.trim()
        require(normalized.isNotEmpty() && normalized.contains("@")) { "メールアドレスを入力してください" }
        require(password.isNotEmpty()) { "パスワードを入力してください" }
        return normalized
    }

    private fun requireSwitchConfirmationIfNeeded(confirmAccountSwitch: Boolean) {
        val current = client.auth.currentUserOrNull()
        val hasActiveSession = client.auth.currentSessionOrNull() != null && current != null
        if (hasActiveSession && !confirmAccountSwitch) {
            throw AuthSwitchConfirmationRequired()
        }
    }
}
