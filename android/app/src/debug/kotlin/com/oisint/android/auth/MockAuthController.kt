package com.oisint.android.auth

import android.content.Intent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Debug variant専用のローカルAuth fixture。Release source setには含めない。 */
internal class MockAuthController : AuthController {
    private val _state = MutableStateFlow<AuthState>(AuthState.SignedOut)
    override val state: StateFlow<AuthState> = _state

    override suspend fun initialize() = Unit

    override suspend fun signInWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Boolean,
    ) {
        throw IllegalStateException("live認証はRelease設定でのみ利用できます")
    }

    override suspend fun signUpWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Boolean,
    ) {
        throw IllegalStateException("live認証はRelease設定でのみ利用できます")
    }

    override suspend fun beginGoogleAuth() {
        throw IllegalStateException("live認証はRelease設定でのみ利用できます")
    }

    override fun handleDeepLink(intent: Intent) = Unit

    override suspend fun signOut() = Unit

    override suspend fun deleteAccount() {
        throw IllegalStateException("live認証はRelease設定でのみ利用できます")
    }
}
