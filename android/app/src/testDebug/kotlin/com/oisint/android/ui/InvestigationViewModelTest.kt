package com.oisint.android.ui

import com.oisint.android.R
import com.oisint.android.data.DataProvider
import com.oisint.android.data.InvestigationListener
import com.oisint.android.data.mock.MockDataProvider
import com.oisint.android.model.CreateInvestigationRequest
import com.oisint.android.model.InvestigationStatus
import com.oisint.android.model.LocationSelection
import com.oisint.android.model.RerankInvestigationRequest
import com.oisint.android.model.RerankInvestigationResponse
import com.oisint.android.ui.home.HomeViewModel
import com.oisint.android.ui.investigation.InvestigationViewModel
import kotlin.random.Random
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * ViewModel の状態遷移テスト（Phase 3/5 完了条件）。
 * - 作成 → run 投げっぱなし → status 進行で UiState が更新される
 * - 投票 3 連打で rerank(vote) が 500ms debounce により 1 回だけ呼ばれる
 * - requirement_added は即時 rerank
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InvestigationViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    /** rerank 呼び出しを記録するスパイ（他は MockDataProvider へ委譲） */
    private class SpyProvider(private val delegate: DataProvider) : DataProvider by delegate {
        val rerankCalls = mutableListOf<RerankInvestigationRequest>()
        override suspend fun rerankInvestigation(req: RerankInvestigationRequest): RerankInvestigationResponse {
            rerankCalls.add(req)
            return delegate.rerankInvestigation(req)
        }
    }

    private class CreateRequestSpyProvider(private val delegate: DataProvider) : DataProvider by delegate {
        var request: CreateInvestigationRequest? = null
        override suspend fun createInvestigation(req: CreateInvestigationRequest) =
            delegate.createInvestigation(req).also { request = req }
    }

    private class SwitchingUserProvider(private val delegate: DataProvider) : DataProvider by delegate {
        var userIdReads = 0
        var runCalls = 0
        var request: CreateInvestigationRequest? = null

        override suspend fun getUserId(): String {
            userIdReads += 1
            return if (userIdReads == 1) "user-old" else "user-new"
        }

        override suspend fun createInvestigation(req: CreateInvestigationRequest) =
            delegate.createInvestigation(req).also { request = req }

        override suspend fun runInvestigation(req: com.oisint.android.model.RunInvestigationRequest): com.oisint.android.model.RunInvestigationResponse {
            runCalls += 1
            return delegate.runInvestigation(req)
        }
    }

    private class TimeoutThenSuccessProvider(private val delegate: DataProvider) : DataProvider by delegate {
        val requests = mutableListOf<CreateInvestigationRequest>()
        private var shouldTimeout = true

        override suspend fun getUserId(): String = "bootstrap-user"

        override suspend fun createInvestigation(req: CreateInvestigationRequest) =
            req.also { requests.add(it) }.let {
                if (shouldTimeout) {
                    shouldTimeout = false
                    throw IllegalStateException("timeout")
                }
                delegate.createInvestigation(it)
            }
    }

    private class DoubleTapProvider(private val delegate: DataProvider) : DataProvider by delegate {
        var createCalls = 0

        override suspend fun createInvestigation(req: CreateInvestigationRequest) =
            req.let {
                createCalls += 1
                delay(100)
                delegate.createInvestigation(it)
            }
    }

    @Test
    fun homeCreateThenRunProgressesStatusIntoUiState() = runTest(dispatcher.scheduler) {
        val provider = MockDataProvider(backgroundScope, Random(11))
        val homeVm = HomeViewModel(provider)

        homeVm.onQueryChange("池袋で3人。肉。")
        homeVm.onDisplayNameChange("まさ")
        homeVm.handleStart()
        runCurrent()

        val nav = homeVm.uiState.value.navigateTo
        assertNotNull("作成成功で遷移イベントが立つ", nav)
        val (id, shareToken) = nav!!
        assertEquals(32, shareToken.length)

        // 詳細画面の ViewModel が購読し、simulateRun の進行が UiState に反映される
        val invVm = InvestigationViewModel(provider, id)
        runCurrent()
        assertEquals(InvestigationStatus.Recalling, invVm.uiState.value.investigation?.status)

        advanceTimeBy(801); runCurrent()
        assertEquals(InvestigationStatus.Searching, invVm.uiState.value.investigation?.status)

        advanceTimeBy(801 * 4L); runCurrent()
        val finalState = invVm.uiState.value
        assertEquals(InvestigationStatus.Complete, finalState.investigation?.status)
        assertEquals(3, finalState.investigation?.candidates?.size)
        assertEquals("最初の候補が自動選択される", "c-1", finalState.selectedCandidateId)
    }

    @Test
    fun homeGpsLocationAddsCurrentAreaWithoutCoordinates() = runTest(dispatcher.scheduler) {
        val provider = CreateRequestSpyProvider(MockDataProvider(backgroundScope, Random(17)))
        val homeVm = HomeViewModel(provider)
        homeVm.onLocationChange(
            LocationSelection(
                label = "現在地付近",
                source = "gps",
                latitude = 35.681236,
                longitude = 139.767125,
            ),
        )
        homeVm.onQueryChange("静かな店")

        homeVm.handleStart()
        runCurrent()

        assertEquals("場所: 現在地付近 / 静かな店", provider.request?.query)
        assertFalse(provider.request!!.query.contains("35.681236"))
        assertFalse(provider.request!!.query.contains("139.767125"))
    }

    @Test
    fun homeDoesNotSendOldCreateResultToNewAuthSubject() = runTest(dispatcher.scheduler) {
        val provider = SwitchingUserProvider(MockDataProvider(backgroundScope, Random(18)))
        val homeVm = HomeViewModel(provider)
        homeVm.onQueryChange("池袋で3人。肉。")
        homeVm.onDisplayNameChange("まさ")

        homeVm.handleStart()
        runCurrent()

        assertNull("subject切替後は旧create結果で遷移しない", homeVm.uiState.value.navigateTo)
        assertEquals("新subjectへ切り替わった後は旧調査をrunしない", 0, provider.runCalls)
        assertFalse("旧requestの所有終了後はloadingを解除する", homeVm.uiState.value.loading)
        assertEquals("create requestには必須keyとsubject束縛がある", "user-old", provider.request?.authSubject)
        assertTrue(provider.request?.idempotencyKey?.isNotEmpty() == true)
    }

    @Test
    fun homeDoubleTapStartsOneCreateAndOwnerFinallyReleasesLoading() = runTest(dispatcher.scheduler) {
        val provider = DoubleTapProvider(MockDataProvider(backgroundScope, Random(20)))
        val homeVm = HomeViewModel(provider)
        homeVm.onQueryChange("池袋で3人。肉。")
        homeVm.onDisplayNameChange("まさ")

        homeVm.handleStart()
        homeVm.handleStart()
        runCurrent()

        assertEquals("高速二重tapはcreateを1回だけ開始する", 1, provider.createCalls)
        assertTrue("create中はloadingを所有する", homeVm.uiState.value.loading)

        advanceTimeBy(100)
        runCurrent()
        assertFalse("所有requestのfinallyでloadingを解除する", homeVm.uiState.value.loading)
        assertNotNull(homeVm.uiState.value.navigateTo)
    }

    @Test
    fun homeTimeoutThenBootstrapRetryReusesKeyForSameSubject() = runTest(dispatcher.scheduler) {
        val provider = TimeoutThenSuccessProvider(MockDataProvider(backgroundScope, Random(19)))
        val homeVm = HomeViewModel(provider)
        homeVm.onQueryChange("池袋で3人。肉。")
        homeVm.onDisplayNameChange("まさ")

        homeVm.handleStart()
        runCurrent()
        assertEquals("初回timeout後も同一subjectのkeyを保持する", 1, provider.requests.size)
        assertFalse(homeVm.uiState.value.loading)
        assertNull(homeVm.uiState.value.navigateTo)

        homeVm.handleStart()
        runCurrent()
        assertEquals(2, provider.requests.size)
        assertEquals(
            "bootstrap中のUI確定後retryでも同一logical create keyを使う",
            provider.requests[0].idempotencyKey,
            provider.requests[1].idempotencyKey,
        )
        assertTrue(provider.requests.all { it.authSubject == "bootstrap-user" })
        assertNotNull(homeVm.uiState.value.navigateTo)
    }

    @Test
    fun voteTripleTapDebouncesRerankToSingleCall() = runTest(dispatcher.scheduler) {
        val provider = SpyProvider(MockDataProvider(backgroundScope, Random(12)))
        val vm = InvestigationViewModel(provider, "inv-001")
        runCurrent()
        assertNotNull(vm.uiState.value.investigation)

        // 3 連打（500ms 以内）
        vm.vote("c-1", 1)
        advanceTimeBy(100); runCurrent()
        vm.vote("c-1", 0)
        advanceTimeBy(100); runCurrent()
        vm.vote("c-1", 1)
        runCurrent()
        assertEquals("debounce 中は rerank されない", 0, provider.rerankCalls.size)

        advanceTimeBy(501); runCurrent()
        assertEquals("500ms 後に 1 回だけ rerank(vote)", 1, provider.rerankCalls.size)
        assertEquals("vote", provider.rerankCalls[0].trigger.wire)

        // 投票自体は即時反映されている
        val userId = provider.getUserId()
        assertEquals(1, vm.uiState.value.investigation?.candidates?.first { it.id == "c-1" }?.votes?.get(userId))
    }

    @Test
    fun addRequirementTriggersImmediateRerank() = runTest(dispatcher.scheduler) {
        val inner = MockDataProvider(backgroundScope, Random(13))
        val provider = SpyProvider(inner)
        // owner として新規調査を作る（seed inv-001 では mockUserId が非メンバーのため）
        val created = inner.createInvestigation(
            CreateInvestigationRequest(query = "池袋", displayName = "まさ", userId = inner.getUserId(), idempotencyKey = "investigation-test-1", authSubject = inner.getUserId()),
        )
        val vm = InvestigationViewModel(provider, created.investigationId)
        runCurrent()

        vm.setAddingRequirement(true)
        vm.onNewRequirementTextChange("個室")
        vm.addRequirement()
        runCurrent()

        assertEquals("即時に 1 回 rerank される（debounce なし）", 1, provider.rerankCalls.size)
        assertEquals("requirement_added", provider.rerankCalls[0].trigger.wire)
        assertTrue(
            "requirements に追加が反映される",
            vm.uiState.value.investigation!!.requirements.any { it.text == "個室" },
        )
        assertEquals("入力がクリアされる", "", vm.uiState.value.newRequirementText)
    }

    @Test
    fun missingIdShowsError() = runTest(dispatcher.scheduler) {
        val provider = MockDataProvider(backgroundScope, Random(14))
        val vm = InvestigationViewModel(provider, null)
        runCurrent()
        assertEquals(R.string.investigation_error_missing_id, vm.uiState.value.error)
        assertNull(vm.uiState.value.investigation)
    }

    @Test
    fun unknownIdShowsNotFoundError() = runTest(dispatcher.scheduler) {
        val provider = MockDataProvider(backgroundScope, Random(15))
        val vm = InvestigationViewModel(provider, "inv-does-not-exist")
        runCurrent()
        assertEquals(R.string.investigation_error_not_found, vm.uiState.value.error)
    }

    /** subscribe が解除されることの検証用フェイク */
    private class UnsubscribeTrackingProvider(private val delegate: DataProvider) : DataProvider by delegate {
        var unsubscribed = false
        override fun subscribeInvestigation(id: String, listener: InvestigationListener): () -> Unit {
            val inner = delegate.subscribeInvestigation(id, listener)
            return {
                unsubscribed = true
                inner()
            }
        }
    }

    @Test
    fun retryReloadsAndResubscribes() = runTest(dispatcher.scheduler) {
        val provider = UnsubscribeTrackingProvider(MockDataProvider(backgroundScope, Random(16)))
        val vm = InvestigationViewModel(provider, "inv-001")
        runCurrent()
        assertNotNull(vm.uiState.value.investigation)

        vm.retry()
        runCurrent()
        assertTrue("retry で旧購読が解除される", provider.unsubscribed)
        assertNotNull(vm.uiState.value.investigation)
    }
}
