package com.oisint.android.ui.account

import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import com.oisint.android.testing.StringResources
import com.oisint.android.R
import android.content.Intent
import com.oisint.android.auth.AuthController
import com.oisint.android.auth.AuthState
import com.oisint.android.auth.AuthSwitchConfirmationRequired
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AccountViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun anonymousEmailSwitchRequiresExplicitConfirmation() = runTest(dispatcher.scheduler) {
        val controller = FakeAuthController(AuthState.Anonymous("00000000-0000-4000-8000-000000000001"))
        val viewModel = AccountViewModel(controller)
        runCurrent()
        viewModel.onEmailChanged("person@example.com")
        viewModel.onPasswordChanged("password")
        viewModel.signIn()
        runCurrent()

        assertEquals(R.string.account_error_switch_confirmation, viewModel.uiState.value.errorMessage)
        assertTrue(StringResources.ja(R.string.account_error_switch_confirmation).contains("確認欄"))
        assertEquals(0, controller.signInCalls)

        viewModel.onConfirmAccountSwitchChanged(true)
        viewModel.signIn()
        runCurrent()
        assertEquals(1, controller.signInCalls)
        assertEquals(R.string.account_notice_signed_in, viewModel.uiState.value.noticeMessage)
        assertEquals("アカウントに接続しました。", StringResources.ja(R.string.account_notice_signed_in))
    }

    @Test
    fun googleLinkIsAvailableToAnonymousState() = runTest(dispatcher.scheduler) {
        val controller = FakeAuthController(AuthState.Anonymous("00000000-0000-4000-8000-000000000001"))
        val viewModel = AccountViewModel(controller)
        runCurrent()

        viewModel.connectGoogle()
        runCurrent()

        assertEquals(1, controller.googleCalls)
        assertEquals(R.string.account_notice_google_opening, viewModel.uiState.value.noticeMessage)
    }

    @Test
    fun googleLinkFailureKeepsAnonymousOwnerAndDoesNotShowSuccessNotice() = runTest(dispatcher.scheduler) {
        val originalUserId = "00000000-0000-4000-8000-000000000001"
        val controller = FakeAuthController(
            initial = AuthState.Anonymous(originalUserId),
            googleError = IllegalStateException("identity collision"),
        )
        val viewModel = AccountViewModel(controller)
        runCurrent()

        viewModel.connectGoogle()
        runCurrent()

        assertEquals(1, controller.googleCalls)
        assertEquals(AuthState.Anonymous(originalUserId), viewModel.uiState.value.authState)
        assertNotNull(viewModel.uiState.value.errorMessage)
        assertNull(viewModel.uiState.value.noticeMessage)
    }

    @Test
    fun accountDeletionRequiresTwoClicksAndUsesAuthenticatedSubject() = runTest(dispatcher.scheduler) {
        val controller = FakeAuthController(
            initial = AuthState.Authenticated(
                "00000000-0000-4000-8000-000000000002",
                "person@example.com",
            ),
        )
        val viewModel = AccountViewModel(controller)
        runCurrent()

        viewModel.requestAccountDeletion()
        runCurrent()
        assertTrue(viewModel.uiState.value.confirmAccountDeletion)
        assertEquals(0, controller.deleteCalls)

        viewModel.requestAccountDeletion()
        runCurrent()
        assertEquals(1, controller.deleteCalls)
        assertEquals(AuthState.SignedOut, viewModel.uiState.value.authState)
        assertTrue(viewModel.uiState.value.email.isEmpty())
        assertTrue(viewModel.uiState.value.password.isEmpty())
    }

    private class FakeAuthController(
        initial: AuthState,
        private val googleError: Throwable? = null,
    ) : AuthController {
        private val _state = MutableStateFlow(initial)
        override val state: StateFlow<AuthState> = _state
        var signInCalls = 0
        var googleCalls = 0
        var deleteCalls = 0

        override suspend fun initialize() = Unit

        override suspend fun signInWithEmail(email: String, password: String, confirmAccountSwitch: Boolean) {
            if (_state.value is AuthState.Anonymous && !confirmAccountSwitch) {
                throw AuthSwitchConfirmationRequired()
            }
            signInCalls += 1
            _state.value = AuthState.Authenticated("00000000-0000-4000-8000-000000000002", email)
        }

        override suspend fun signUpWithEmail(email: String, password: String, confirmAccountSwitch: Boolean) =
            signInWithEmail(email, password, confirmAccountSwitch)

        override suspend fun beginGoogleAuth() {
            googleCalls += 1
            googleError?.let { throw it }
        }

        override fun handleDeepLink(intent: Intent) = Unit
        override suspend fun signOut() { _state.value = AuthState.SignedOut }
        override suspend fun deleteAccount() {
            deleteCalls += 1
            _state.value = AuthState.SignedOut
        }
    }
}
