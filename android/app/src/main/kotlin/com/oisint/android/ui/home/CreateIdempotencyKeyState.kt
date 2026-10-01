package com.oisint.android.ui.home

import java.util.UUID

/** Process-lifetime state for one logical create retry sequence. */
internal class CreateIdempotencyKeyState(
    private val keyFactory: () -> String = { UUID.randomUUID().toString().lowercase() },
) {
    private var fingerprint: String? = null
    private var key: String? = null

    @Synchronized
    fun keyFor(subject: String, input: String, displayName: String): String {
        val nextFingerprint = listOf(subject, input, displayName).joinToString("\u0000")
        if (fingerprint == nextFingerprint) key?.let { return it }
        return keyFactory().also {
            fingerprint = nextFingerprint
            key = it
        }
    }

    /**
     * 古いcreate/run responseが後続subject・入力のretry keyを消さないよう、
     * responseが発行した全identity要素とkeyが一致したときだけclearする。
     */
    @Synchronized
    fun clearIfMatches(
        subject: String,
        input: String,
        displayName: String,
        idempotencyKey: String,
    ): Boolean {
        val expectedFingerprint = listOf(subject, input, displayName).joinToString("\u0000")
        if (fingerprint != expectedFingerprint || key != idempotencyKey) return false
        fingerprint = null
        key = null
        return true
    }
}
