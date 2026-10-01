package com.oisint.android.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CreateIdempotencyKeyStateTest {
    @Test
    fun timeoutRetryReusesKeyForSameAuthAndInput() {
        var issued = 0
        val state = CreateIdempotencyKeyState { "key-${++issued}" }

        val first = state.keyFor("user-a", "池袋", "利用者")
        val retry = state.keyFor("user-a", "池袋", "利用者")

        assertEquals(first, retry)
        assertEquals(1, issued)
    }

    @Test
    fun inputAuthAndSuccessRotateKey() {
        var issued = 0
        val state = CreateIdempotencyKeyState { "key-${++issued}" }

        val first = state.keyFor("user-a", "池袋", "利用者")
        val changedInput = state.keyFor("user-a", "新宿", "利用者")
        val changedAuth = state.keyFor("user-b", "新宿", "利用者")
        assertTrue(state.clearIfMatches("user-b", "新宿", "利用者", changedAuth))
        val afterSuccess = state.keyFor("user-b", "新宿", "利用者")

        assertNotEquals(first, changedInput)
        assertNotEquals(changedInput, changedAuth)
        assertNotEquals(changedAuth, afterSuccess)
        assertEquals(4, issued)
    }

    @Test
    fun lateOldResponseCannotClearNewRetryKey() {
        var issued = 0
        val state = CreateIdempotencyKeyState { "key-${++issued}" }

        val oldKey = state.keyFor("user-old", "池袋", "利用者")
        val newKey = state.keyFor("user-new", "池袋", "利用者")

        assertFalse(
            state.clearIfMatches("user-old", "池袋", "利用者", oldKey),
        )
        assertEquals(
            "新subjectの同一入力retry keyは旧response後着でも保持する",
            newKey,
            state.keyFor("user-new", "池袋", "利用者"),
        )
        assertTrue(state.clearIfMatches("user-new", "池袋", "利用者", newKey))
    }
}
