package com.oisint.android.auth

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthControllerTest {
    @Test
    fun anonymousDoesNotBindRevenueCatIdentity() = runTest {
        val calls = mutableListOf<String>()
        val synchronizer = EntitlementIdentitySynchronizer(
            bind = { calls += "bind:$it" },
            clear = { calls += "clear" },
        )

        synchronizer.synchronize(AuthState.Anonymous("00000000-0000-4000-8000-000000000001"))

        assertEquals(listOf("clear"), calls)
    }

    @Test
    fun authenticatedUserBindsAndSwitchClearsOldIdentityFirst() = runTest {
        val calls = mutableListOf<String>()
        val synchronizer = EntitlementIdentitySynchronizer(
            bind = { calls += "bind:$it" },
            clear = { calls += "clear" },
        )
        val first = "00000000-0000-4000-8000-000000000001"
        val second = "00000000-0000-4000-8000-000000000002"

        synchronizer.synchronize(AuthState.Authenticated(first, "one@example.com"))
        synchronizer.synchronize(AuthState.Authenticated(second, "two@example.com"))

        assertEquals(listOf("bind:$first", "clear", "bind:$second"), calls)
    }

    @Test
    fun signedOutAndErrorNeverKeepPreviousIdentity() = runTest {
        val calls = mutableListOf<String>()
        val synchronizer = EntitlementIdentitySynchronizer(
            bind = { calls += "bind:$it" },
            clear = { calls += "clear" },
        )
        val userId = "00000000-0000-4000-8000-000000000001"

        synchronizer.synchronize(AuthState.Authenticated(userId, null))
        synchronizer.synchronize(AuthState.SignedOut)
        synchronizer.synchronize(AuthState.Error("safe"))

        assertEquals(listOf("bind:$userId", "clear", "clear"), calls)
    }

    @Test
    fun unavailableAuthIsFailClosedAndNotAStandaloneAnonymousSession() = runTest {
        val controller = UnavailableAuthController()

        assertTrue(controller.state.value is AuthState.Error)
        assertTrue(runCatching { controller.signInWithEmail("a@example.com", "password", false) }.isFailure)
    }

    @Test
    fun nonUuidAuthenticatedStateCannotReachRevenueCat() = runTest {
        val calls = mutableListOf<String>()
        val synchronizer = EntitlementIdentitySynchronizer(
            bind = { calls += "bind:$it" },
            clear = { calls += "clear" },
        )

        synchronizer.synchronize(AuthState.Authenticated("not-a-uuid", null))

        assertEquals(listOf("clear"), calls)
    }

    @Test
    fun uppercaseUuidIsCanonicalizedBeforeRevenueCatBind() = runTest {
        val calls = mutableListOf<String>()
        val synchronizer = EntitlementIdentitySynchronizer(
            bind = { calls += "bind:$it" },
            clear = { calls += "clear" },
        )

        synchronizer.synchronize(
            AuthState.Authenticated(
                "00000000-0000-4000-8000-0000000000AB".uppercase(),
                null,
            ),
        )

        assertEquals(listOf("bind:00000000-0000-4000-8000-0000000000ab"), calls)
    }
}
