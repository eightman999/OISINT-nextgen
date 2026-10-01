package com.oisint.android.ui.paywall

import android.app.Activity
import com.oisint.android.entitlement.EntitlementProvider
import com.oisint.android.entitlement.EntitlementStatus
import com.oisint.android.entitlement.PlusPackage
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PaywallViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun authenticatedBindRetriesOfferingsAfterInitialAnonymousState() =
        runTest(dispatcher.scheduler) {
            val provider = FakeEntitlementProvider()
            val viewModel = PaywallViewModel(provider)
            runCurrent()
            assertTrue(provider.offeringsCalls.get() >= 1)
            assertTrue(viewModel.uiState.value.packages.isEmpty())

            provider.authenticated.value = true
            runCurrent()

            assertTrue(viewModel.uiState.value.isAuthenticated)
            assertFalse(viewModel.uiState.value.packages.isEmpty())
            assertTrue(provider.offeringsCalls.get() >= 2)
        }

    private class FakeEntitlementProvider : EntitlementProvider {
        val authenticated = MutableStateFlow(false)
        val offeringsCalls = AtomicInteger(0)
        private val _status = MutableStateFlow(EntitlementStatus())
        override val status: StateFlow<EntitlementStatus> = _status.asStateFlow()
        override val isAuthenticated: StateFlow<Boolean> = authenticated.asStateFlow()

        override suspend fun refresh() = Unit

        override suspend fun offerings(): List<PlusPackage> {
            offeringsCalls.incrementAndGet()
            if (!authenticated.value) return emptyList()
            return listOf(PlusPackage("oisint_plus_monthly", "月額", "¥1", "P1M"))
        }

        override suspend fun purchase(activity: Activity, pkg: PlusPackage) =
            EntitlementStatus()

        override suspend fun restore() = EntitlementStatus()

        override suspend fun logIn(appUserId: String) {
            authenticated.value = true
        }

        override suspend fun logOut() {
            authenticated.value = false
            _status.value = EntitlementStatus()
        }
    }
}
