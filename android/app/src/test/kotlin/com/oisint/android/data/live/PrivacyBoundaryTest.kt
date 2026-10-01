package com.oisint.android.data.live

import kotlinx.serialization.json.Json
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class PrivacyBoundaryTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun safeInvestigationRowDoesNotRequireRawQuery() {
        val row = json.decodeFromString<InvestigationAssembler.InvestigationRow>(
            """
            {
              "id": "00000000-0000-4000-8000-000000000151",
              "title": "共有調査",
              "status": "complete",
              "share_token": "0123456789abcdef0123456789abcdef",
              "created_at": "2026-08-14T10:00:00Z",
              "updated_at": "2026-08-14T10:05:00Z"
            }
            """.trimIndent(),
        )

        assertNull(row.rawQuery)
        assertEquals("共有調査", row.title)
    }

    @Test
    fun supabaseOriginRejectsCredentialAndRedirectLikeUrls() {
        assertEquals(
            "https://project-ref.supabase.co",
            SupabaseEndpointPolicy.requireValid("https://project-ref.supabase.co/"),
        )
        listOf(
            "http://project-ref.supabase.co",
            "https://project-ref.supabase.co:8443",
            "https://project-ref.supabase.co/rest/v1",
            "https://user:secret@project-ref.supabase.co",
            "https://project-ref.supabase.co?redirect=https://evil.example",
            "https://evil.example/project-ref.supabase.co",
        ).forEach { value ->
            assertThrows(IllegalArgumentException::class.java) {
                SupabaseEndpointPolicy.requireValid(value)
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            SupabaseEndpointPolicy.requireValid("http://127.0.0.1:54321")
        }
        assertEquals(
            "http://127.0.0.1:54321",
            SupabaseEndpointPolicy.requireValid("http://127.0.0.1:54321/", allowLocalhost = true),
        )
        assertEquals(
            "https://localhost:54321",
            SupabaseEndpointPolicy.requireValid("https://localhost:54321", allowLocalhost = true),
        )
    }

    @Test
    fun accountDeletionContentLengthRejectsNegativeAndOversizeValues() {
        assertTrue(isValidBoundedContentLength(null, 16 * 1024))
        assertTrue(isValidBoundedContentLength("0", 16 * 1024))
        assertTrue(isValidBoundedContentLength("16384", 16 * 1024))
        assertFalse(isValidBoundedContentLength("-1", 16 * 1024))
        assertFalse(isValidBoundedContentLength("16385", 16 * 1024))
        assertFalse(isValidBoundedContentLength("not-a-number", 16 * 1024))
    }
}
