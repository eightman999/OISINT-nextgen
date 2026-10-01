package com.oisint.android.data

import com.oisint.android.data.live.OisintApiClient
import com.oisint.android.data.live.ApiTimeoutPolicy
import com.oisint.android.model.CreateInvestigationRequest
import com.oisint.android.model.JoinInvestigationRequest
import com.oisint.android.model.RerankInvestigationRequest
import com.oisint.android.model.RerankTrigger
import com.oisint.android.model.RunInvestigationRequest
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.content.TextContent
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assert.assertThrows
import org.junit.Test

private fun testJwt(subject: String): String {
    val payload = java.util.Base64.getUrlEncoder().withoutPadding()
        .encodeToString("{\"sub\":\"$subject\"}".toByteArray())
    return "header.$payload.signature"
}

/**
 * OisintApiClient のテスト（Phase 6 完了条件）:
 * パス組み立て 4 本・Bearer 付与・{error} の例外化・camelCase ボディを MockEngine で検証。
 * 期待値は live.ts L62-102 callApi / L329-364 と openapi.yaml。
 */
class OisintApiClientTest {

    @Test
    fun apiOriginIsReleaseLockedAndLocalhostIsDebugOnly() {
        assertEquals("https://api.oisint.com", com.oisint.android.data.live.ApiEndpointPolicy.requireValid("https://api.oisint.com/", false))
        assertEquals("https://localhost", com.oisint.android.data.live.ApiEndpointPolicy.requireValid("https://localhost/", true))
        assertEquals("http://127.0.0.1:8787", com.oisint.android.data.live.ApiEndpointPolicy.requireValid("http://127.0.0.1:8787/", true))
        listOf(
            "http://api.oisint.com",
            "https://api.oisint.com/v1",
            "https://user:pass@api.oisint.com",
            "https://api.oisint.com?next=https://evil.example",
            "https://localhost",
            "https://evil.example",
        ).forEach { value ->
            assertThrows(IllegalArgumentException::class.java) {
                com.oisint.android.data.live.ApiEndpointPolicy.requireValid(value, false)
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            com.oisint.android.data.live.ApiEndpointPolicy.requireValid("http://127.0.0.1:8787", false)
        }
    }

    private fun jsonHeaders() = headersOf(HttpHeaders.ContentType, "application/json")

    private fun requestBodyText(request: HttpRequestData): String =
        (request.body as TextContent).text

    private fun client(
        recorded: MutableList<HttpRequestData>,
        status: HttpStatusCode = HttpStatusCode.OK,
        body: String,
        token: String = testJwt("test-subject"),
    ): OisintApiClient {
        val engine = MockEngine { request ->
            recorded.add(request)
            respond(content = body, status = status, headers = jsonHeaders())
        }
        return OisintApiClient(
            apiBaseUrl = "https://api.oisint.com/", // 末尾スラッシュは除去される（live.ts L62-64）
            tokenProvider = { token },
            engine = engine,
        )
    }

    @Test
    fun createInvestigationPostsToV1InvestigationsWithBearerAndCamelCase() = runTest {
        val recorded = mutableListOf<HttpRequestData>()
        val api = client(
            recorded,
            body = """{"investigationId":"11111111-1111-4111-8111-111111111111","shareToken":"abc123"}""",
        )
        val res = api.createInvestigation(
            CreateInvestigationRequest(
                query = "池袋 肉",
                displayName = "まさ",
                idempotencyKey = "create-boundary-key",
                authSubject = "test-subject",
            ),
        )
        assertEquals("11111111-1111-4111-8111-111111111111", res.investigationId)
        assertEquals("abc123", res.shareToken)

        val request = recorded.single()
        assertEquals("https://api.oisint.com/v1/investigations", request.url.toString())
        assertEquals("POST", request.method.value)
        assertEquals("Bearer ${testJwt("test-subject")}", request.headers[HttpHeaders.Authorization])
        assertEquals("create-boundary-key", request.headers["Idempotency-Key"])
        val sent = Json.parseToJsonElement(requestBodyText(request)).jsonObject
        assertEquals("池袋 肉", sent["query"]?.jsonPrimitive?.content)
        assertEquals("まさ", sent["displayName"]?.jsonPrimitive?.content)
        // userId 未指定時はボディに含まれない（explicitNulls=false）
        assertFalse(sent.containsKey("userId"))
        assertFalse(sent.containsKey("idempotencyKey"))
        assertTimeoutOrdering()
    }

    private fun assertTimeoutOrdering() {
        assertTrue(ApiTimeoutPolicy.EDGE_RECEIPT_TIMEOUT_MS < ApiTimeoutPolicy.WORKER_RECEIPT_TIMEOUT_MS)
        assertTrue(ApiTimeoutPolicy.WORKER_RECEIPT_TIMEOUT_MS < ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS)
        assertTrue(ApiTimeoutPolicy.EDGE_SYNCHRONOUS_CREATE_TIMEOUT_MS < ApiTimeoutPolicy.WORKER_SYNCHRONOUS_CREATE_TIMEOUT_MS)
        assertTrue(ApiTimeoutPolicy.WORKER_SYNCHRONOUS_CREATE_TIMEOUT_MS < ApiTimeoutPolicy.SYNCHRONOUS_CREATE_TIMEOUT_MS)
        assertTrue(ApiTimeoutPolicy.EDGE_SYNCHRONOUS_RERANK_TIMEOUT_MS < ApiTimeoutPolicy.WORKER_SYNCHRONOUS_RERANK_TIMEOUT_MS)
        assertTrue(ApiTimeoutPolicy.WORKER_SYNCHRONOUS_RERANK_TIMEOUT_MS < ApiTimeoutPolicy.SYNCHRONOUS_RERANK_TIMEOUT_MS)
        assertTrue(ApiTimeoutPolicy.SYNCHRONOUS_CREATE_TIMEOUT_MS >= ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS)
        assertTrue(ApiTimeoutPolicy.SYNCHRONOUS_RERANK_TIMEOUT_MS > ApiTimeoutPolicy.RECEIPT_TIMEOUT_MS)
    }

    @Test
    fun runInvestigationPostsToResearchPath() = runTest {
        val recorded = mutableListOf<HttpRequestData>()
        val api = client(recorded, body = """{"status":"recalling"}""")
        val res = api.runInvestigation(
            RunInvestigationRequest("22222222-2222-4222-8222-222222222222"),
        )
        assertEquals("recalling", res.status.wire)
        assertEquals(
            "https://api.oisint.com/v1/investigations/22222222-2222-4222-8222-222222222222/research",
            recorded.single().url.toString(),
        )
        // Worker の runResearchBodySchema は strict で searchAnchor だけを許可する。
        // investigationId を body に入れると本番で 400 になる回帰防止。
        val sent = Json.parseToJsonElement(requestBodyText(recorded.single())).jsonObject
        assertFalse(sent.containsKey("investigationId"))
    }

    @Test
    fun runInvestigationSendsSearchAnchorWhenPresent() = runTest {
        val recorded = mutableListOf<HttpRequestData>()
        val api = client(recorded, body = """{"status":"recalling"}""")
        api.runInvestigation(
            RunInvestigationRequest(
                "22222222-2222-4222-8222-222222222222",
                searchAnchor = com.oisint.android.model.LocationSearchAnchor(35.7295, 139.7109),
            ),
        )
        val sent = Json.parseToJsonElement(requestBodyText(recorded.single())).jsonObject
        assertEquals(35.7295, sent["searchAnchor"]?.jsonObject?.get("lat")?.jsonPrimitive?.content?.toDouble())
        assertEquals(139.7109, sent["searchAnchor"]?.jsonObject?.get("lng")?.jsonPrimitive?.content?.toDouble())
        assertFalse(sent.containsKey("investigationId"))
    }

    @Test
    fun runInvestigationDecodesAnchorRequiredReason() = runTest {
        val recorded = mutableListOf<HttpRequestData>()
        val api = client(
            recorded,
            status = HttpStatusCode.Accepted,
            body = """{"status":"draft","reason":"location_anchor_required","message":"x"}""",
        )
        val res = api.runInvestigation(
            RunInvestigationRequest("22222222-2222-4222-8222-222222222222"),
        )
        assertEquals("draft", res.status.wire)
        assertEquals(
            com.oisint.android.model.RunInvestigationReason.LocationAnchorRequired,
            res.reason,
        )
    }

    @Test
    fun rerankInvestigationPostsTriggerEnum() = runTest {
        val recorded = mutableListOf<HttpRequestData>()
        val api = client(recorded, body = """{"reranked":true}""")
        val res = api.rerankInvestigation(
            RerankInvestigationRequest("33333333-3333-4333-8333-333333333333", RerankTrigger.RequirementAdded),
        )
        assertTrue(res.reranked)
        val request = recorded.single()
        assertEquals(
            "https://api.oisint.com/v1/investigations/33333333-3333-4333-8333-333333333333/rerank",
            request.url.toString(),
        )
        val sent = Json.parseToJsonElement(requestBodyText(request)).jsonObject
        // RerankTrigger は wire 値（snake_case）で送られる
        assertEquals("requirement_added", sent["trigger"]?.jsonPrimitive?.content)
    }

    @Test
    fun joinInvestigationPostsToJoinPath() = runTest {
        val recorded = mutableListOf<HttpRequestData>()
        val api = client(
            recorded,
            body = """{"investigationId":"44444444-4444-4444-8444-444444444444","title":"8/23 池袋 夜飯"}""",
        )
        val res = api.joinInvestigation(
            JoinInvestigationRequest(shareToken = "0123456789abcdef0123456789abcdef", displayName = "ゲスト"),
        )
        assertEquals("8/23 池袋 夜飯", res.title)
        assertEquals(
            "https://api.oisint.com/v1/investigations/join",
            recorded.single().url.toString(),
        )
    }

    @Test
    fun errorBodyBecomesExceptionMessage() = runTest {
        // live.ts L91-98: {error} フィールドがあればその文言
        val recorded = mutableListOf<HttpRequestData>()
        val api = client(
            recorded,
            status = HttpStatusCode.NotFound,
            body = """{"error":"調査が見つかりません"}""",
        )
        try {
            api.joinInvestigation(JoinInvestigationRequest(shareToken = "ffff", displayName = "x"))
            fail("例外になるはず")
        } catch (e: OisintApiClient.ApiException) {
            assertEquals("調査が見つかりません", e.message)
        }
    }

    @Test
    fun nonJsonErrorFallsBackToStatusCode() = runTest {
        // live.ts L92-97: JSON でない/error 無しは `API エラー (status)`
        val recorded = mutableListOf<HttpRequestData>()
        val api = client(recorded, status = HttpStatusCode.BadGateway, body = "upstream broke")
        try {
            api.runInvestigation(RunInvestigationRequest("55555555-5555-4555-8555-555555555555"))
            fail("例外になるはず")
        } catch (e: OisintApiClient.ApiException) {
            assertEquals("API エラー (502)", e.message)
        }
    }

    @Test
    fun oversizedResponseFailsClosedBeforeJsonDecode() = runTest {
        val recorded = mutableListOf<HttpRequestData>()
        val api = client(recorded, body = "x".repeat(128 * 1024 + 1))
        val error = runCatching {
            api.runInvestigation(RunInvestigationRequest("66666666-6666-4666-8666-666666666666"))
        }.exceptionOrNull()
        assertTrue(error is OisintApiClient.ApiException)
    }

    @Test
    fun oldSubjectKeyIsNotSentWithNewBearerToken() = runTest {
        val recorded = mutableListOf<HttpRequestData>()
        val subject = "00000000-0000-4000-8000-000000000571"
        val otherSubject = "00000000-0000-4000-8000-000000000572"
        fun jwt(sub: String): String {
            val payload = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"sub\":\"$sub\"}".toByteArray())
            return "header.$payload.signature"
        }
        val api = client(
            recorded,
            body = """{"investigationId":"11111111-1111-4111-8111-111111111111","shareToken":"abc123"}""",
            token = jwt(otherSubject),
        )
        val error = runCatching {
            api.createInvestigation(
                CreateInvestigationRequest(
                    query = "池袋",
                    displayName = "利用者",
                    idempotencyKey = "old-subject-key",
                    authSubject = subject,
                ),
            )
        }.exceptionOrNull()
        assertTrue(error is OisintApiClient.AuthIdentityChangedException)
        assertTrue(recorded.isEmpty())
    }
}
