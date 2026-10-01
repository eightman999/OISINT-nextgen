package com.oisint.android.data.live

import com.oisint.android.model.CreateInvestigationRequest
import com.oisint.android.model.CreateInvestigationResponse
import com.oisint.android.model.JoinInvestigationRequest
import com.oisint.android.model.JoinInvestigationResponse
import com.oisint.android.model.LocationSearchAnchor
import com.oisint.android.model.RerankInvestigationRequest
import com.oisint.android.model.RerankInvestigationResponse
import com.oisint.android.model.RunInvestigationRequest
import com.oisint.android.model.RunInvestigationResponse
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.timeout
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
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Cloudflare Worker `https://api.oisint.com` の /v1 API を呼ぶクライアント
 * （live.ts L62-102 callApi + L329-364 の 4 メソッド移植）。
 *
 * - 認証: `Authorization: Bearer <Supabase セッションの access_token>`
 * - エラー: レスポンス body に `{ "error": string }` があればその文言、無ければ `API エラー (status)`
 * - パス（計画書 §1.2 実測表）:
 *   POST /v1/investigations                  → create-investigation
 *   POST /v1/investigations/{id}/research    → run-investigation
 *   POST /v1/investigations/{id}/rerank      → rerank-investigation
 *   POST /v1/investigations/join             → join-investigation
 */
internal object ApiEndpointPolicy {
    fun requireValid(value: String, allowLocalhost: Boolean): String {
        val normalized = value.trim().trimEnd('/')
        val uri = runCatching { URI(normalized) }.getOrNull()
            ?: throw IllegalArgumentException("API接続先が不正です")
        val host = uri.host?.lowercase()
        val isLocalhost = host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
        val validHost = host == "api.oisint.com" ||
            (allowLocalhost && isLocalhost)
        require(
            (uri.scheme.equals("https", ignoreCase = true) ||
                (allowLocalhost && uri.scheme.equals("http", ignoreCase = true) && isLocalhost)) &&
                (uri.port == -1 || uri.port == 443 || (allowLocalhost && isLocalhost)) &&
                validHost && uri.rawUserInfo == null && uri.rawQuery == null &&
                uri.rawFragment == null && (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/"),
        ) { "API接続先が不正です" }
        return if (isLocalhost) "${uri.scheme.lowercase()}://${uri.rawAuthority}" else "https://$host"
    }
}

/**
 * API response budgets are endpoint contracts.  Research only waits for the
 * short enqueue receipt; create and requirement-added rerank wait for the
 * synchronous server-side work.
 */
internal object ApiTimeoutPolicy {
    const val EDGE_RECEIPT_TIMEOUT_MS = 5_000L
    const val EDGE_SYNCHRONOUS_CREATE_TIMEOUT_MS = 10_000L
    const val EDGE_SYNCHRONOUS_RERANK_TIMEOUT_MS = 155_000L
    const val WORKER_RECEIPT_TIMEOUT_MS = 10_000L
    const val WORKER_SYNCHRONOUS_CREATE_TIMEOUT_MS = 14_000L
    const val WORKER_SYNCHRONOUS_RERANK_TIMEOUT_MS = 180_000L
    const val RECEIPT_TIMEOUT_MS = 15_000L
    const val SYNCHRONOUS_CREATE_TIMEOUT_MS = 15_000L
    const val SYNCHRONOUS_RERANK_TIMEOUT_MS = 210_000L
}

class OisintApiClient(
    apiBaseUrl: String,
    private val tokenProvider: suspend () -> String,
    engine: HttpClientEngine? = null,
    allowLocalhost: Boolean = false,
) {
    private val baseUrl = ApiEndpointPolicy.requireValid(apiBaseUrl, allowLocalhost)
    private companion object { const val MAX_RESPONSE_BYTES = 128 * 1024L }

    private val json = Json {
        ignoreUnknownKeys = false
        encodeDefaults = false
        explicitNulls = false
    }

    private val http = if (engine == null) {
        HttpClient(OkHttp) {
            engine {
                config {
                    followRedirects(false)
                    followSslRedirects(false)
                }
            }
            install(io.ktor.client.plugins.HttpTimeout) {
                requestTimeoutMillis = ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS
                connectTimeoutMillis = ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS
                socketTimeoutMillis = ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS
            }
        }
    } else {
        HttpClient(engine) {
            install(io.ktor.client.plugins.HttpTimeout) {
                requestTimeoutMillis = ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS
                connectTimeoutMillis = ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS
                socketTimeoutMillis = ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS
            }
        }
    }

    open class ApiException(message: String) : Exception(message)

    class AuthIdentityChangedException : ApiException(
        "認証状態が切り替わったため、調査作成を中止しました",
    )

    private suspend inline fun <reified Req, reified Res> post(
        path: String,
        body: Req,
        timeoutMillis: Long = ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS,
        idempotencyKey: String? = null,
        expectedSubject: String? = null,
    ): Res {
        val token = tokenProvider()
        if (expectedSubject != null && !hasExpectedJwtSubject(token, expectedSubject)) {
            // 認証切替中は古いHome keyを新JWTへ決して送らない。
            throw AuthIdentityChangedException()
        }
        val response = http.post("$baseUrl$path") {
            header(HttpHeaders.Authorization, "Bearer $token")
            if (idempotencyKey != null) header("Idempotency-Key", idempotencyKey)
            contentType(ContentType.Application.Json)
            timeout {
                requestTimeoutMillis = timeoutMillis
                connectTimeoutMillis = timeoutMillis
                socketTimeoutMillis = timeoutMillis
            }
            setBody(json.encodeToString(kotlinx.serialization.serializer<Req>(), body))
        }
        val contentLength = response.headers[HttpHeaders.ContentLength]?.toLongOrNull()
        if (response.headers[HttpHeaders.ContentLength] != null && contentLength == null) {
            throw ApiException("API応答のサイズが不正です")
        }
        if (contentLength != null && contentLength > MAX_RESPONSE_BYTES) {
            throw ApiException("API応答が大きすぎます")
        }
        val text = decodeUtf8Strict(response.bodyAsChannel().readBounded(MAX_RESPONSE_BYTES))
        if (!response.status.isSuccess()) {
            // live.ts L91-98: {error} フィールドを優先、無ければ status コード
            val message = try {
                json.decodeFromString<com.oisint.android.model.ApiError>(text).error
            } catch (_: SerializationException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            }
            throw ApiException(message ?: "API エラー (${response.status.value})")
        }
        return try {
            json.decodeFromString(text)
        } catch (_: SerializationException) {
            throw ApiException("API応答を解釈できません")
        }
    }

    private suspend fun io.ktor.utils.io.ByteReadChannel.readBounded(maxBytes: Long): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(4 * 1024)
        while (!isClosedForRead) {
            val count = readAvailable(buffer, 0, buffer.size)
            if (count < 0) break
            if (output.size().toLong() + count > maxBytes) throw ApiException("API応答が大きすぎます")
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
        throw ApiException("API応答を解釈できません")
    }

    suspend fun createInvestigation(req: CreateInvestigationRequest): CreateInvestigationResponse =
        post(
            "/v1/investigations",
            CreateInvestigationBody(query = req.query, displayName = req.displayName),
            timeoutMillis = ApiTimeoutPolicy.SYNCHRONOUS_CREATE_TIMEOUT_MS,
            idempotencyKey = req.idempotencyKey,
            expectedSubject = req.authSubject,
        )

    suspend fun runInvestigation(req: RunInvestigationRequest): RunInvestigationResponse =
        post(
            "/v1/investigations/${req.investigationId}/research",
            // live.ts L689: body は searchAnchor のみ。Worker の schema は strict で、
            // investigationId を混入すると 400 になる。
            RunResearchBody(searchAnchor = req.searchAnchor),
        )

    suspend fun rerankInvestigation(req: RerankInvestigationRequest): RerankInvestigationResponse =
        post(
            "/v1/investigations/${req.investigationId}/rerank",
            req,
            timeoutMillis = if (req.trigger == com.oisint.android.model.RerankTrigger.RequirementAdded) {
                ApiTimeoutPolicy.SYNCHRONOUS_RERANK_TIMEOUT_MS
            } else {
                ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS
            },
        )

    suspend fun joinInvestigation(req: JoinInvestigationRequest): JoinInvestigationResponse =
        post("/v1/investigations/join", req)

    @kotlinx.serialization.Serializable
    private data class CreateInvestigationBody(
        val query: String,
        val displayName: String,
    )

    /** encodeDefaults=false なので searchAnchor=null では `{}` が送られる。 */
    @kotlinx.serialization.Serializable
    private data class RunResearchBody(
        val searchAnchor: LocationSearchAnchor? = null,
    )

    private fun hasExpectedJwtSubject(token: String, expectedSubject: String): Boolean {
        val payload = token.split('.').getOrNull(1) ?: return false
        return runCatching {
            val jsonPayload = java.util.Base64.getUrlDecoder().decode(payload)
            json.parseToJsonElement(jsonPayload.toString(Charsets.UTF_8))
                .jsonObject["sub"]?.jsonPrimitive?.content == expectedSubject
        }.getOrDefault(false)
    }
}
