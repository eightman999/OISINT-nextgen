package com.oisint.android.data

import com.oisint.android.data.mock.MockData
import com.oisint.android.data.mock.MockDataProvider
import com.oisint.android.model.CreateInvestigationRequest
import com.oisint.android.model.Investigation
import com.oisint.android.model.InvestigationStatus
import com.oisint.android.model.JoinInvestigationRequest
import com.oisint.android.model.RerankInvestigationRequest
import com.oisint.android.model.RerankTrigger
import com.oisint.android.model.RunInvestigationRequest
import kotlin.random.Random
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * MockDataProvider の挙動テスト（providers/mock.ts / data/mock.ts と同数・同挙動の検証。
 * Phase 2 完了条件）。simulateRun は TestScope の仮想時間で検証する。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MockDataProviderTest {

    // ---- MockData の件数（src/data/mock.ts と同数） ----

    @Test
    fun mockDataCountsMatchMockTs() {
        val inv = MockData.mockInvestigation
        assertEquals("inv-001", inv.id)
        assertEquals(3, inv.members.size)
        assertEquals(5, inv.requirements.size)
        assertEquals(3, inv.candidates.size)
        val storeA = inv.candidates.first { it.id == "c-1" }
        assertEquals(2, storeA.evidence.size)
        assertEquals(1, storeA.contradictions.size)
        // 店 B・C は evidence 0 件
        assertEquals(0, inv.candidates.first { it.id == "c-2" }.evidence.size)
        assertEquals(0, inv.candidates.first { it.id == "c-3" }.evidence.size)
        // 矛盾は opening_hours の 60 分ずれ（entries 2 件）
        assertEquals("opening_hours", storeA.contradictions[0].key)
        assertEquals(2, storeA.contradictions[0].entries.size)
        assertEquals("complete", inv.status.wire)
        assertEquals("8/23 池袋 夜飯", inv.title)
    }

    // ---- setVote: votes 反映 + listener 通知 ----

    @Test
    fun setVoteUpdatesVotesAndNotifiesListener() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(1))
        val received = mutableListOf<Investigation>()
        provider.subscribeInvestigation("inv-001") { received.add(it) }
        assertEquals("購読直後に現状が 1 回通知される", 1, received.size)

        val userId = provider.getUserId()
        provider.setVote("inv-001", "c-2", 1)

        assertEquals("setVote 後に listener へ通知される", 2, received.size)
        val updated = received.last()
        val candidate = updated.candidates.first { it.id == "c-2" }
        assertEquals(1, candidate.votes[userId])
        // 既存の他ユーザー票は保持
        assertEquals(0, candidate.votes["u-1"])

        // 存在しない candidate は黙って無視（mock.ts L264-277 の false 相当）
        provider.setVote("inv-001", "c-999", 1)
        assertEquals(2, received.size)
    }

    @Test
    fun setVoteStoresTrimmedCommentAndBlankCommentClearsIt() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(12))
        val userId = provider.getUserId()

        provider.setVote("inv-001", "c-1", 1, "  辛い料理が多そう  ")
        var candidate = provider.getInvestigation("inv-001")!!.candidates.first { it.id == "c-1" }
        assertEquals("辛い料理が多そう", candidate.voteComments[userId])
        assertEquals(1, candidate.votes[userId])

        // trim 後に空になる入力は同じ投票行のコメントを削除する（票自体は保持）。
        provider.setVote("inv-001", "c-1", 0, " \t\n ")
        candidate = provider.getInvestigation("inv-001")!!.candidates.first { it.id == "c-1" }
        assertFalse(candidate.voteComments.containsKey(userId))
        assertEquals(0, candidate.votes[userId])
    }

    // ---- addRequirement: requirements 増加 + listener 通知 / 権限エラー ----

    @Test
    fun addRequirementAppendsAndNotifiesForOwner() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(2))
        val userId = provider.getUserId()
        val created = provider.createInvestigation(
            CreateInvestigationRequest(query = "池袋 肉 静か", displayName = "テスト", userId = userId, idempotencyKey = "mock-test-1", authSubject = userId),
        )
        val received = mutableListOf<Investigation>()
        provider.subscribeInvestigation(created.investigationId) { received.add(it) }
        val before = received.last().requirements.size

        provider.addRequirement(created.investigationId, "個室")

        val after = received.last()
        assertEquals(before + 1, after.requirements.size)
        val added = after.requirements.last()
        assertEquals("個室", added.text)
        assertEquals("個室", added.normalizedText)
        assertEquals("other", added.kind.wire)
        assertEquals("should", added.priority.wire)
        assertEquals(0.5, added.weight, 0.0)
    }

    @Test
    fun addRequirementFailsForNonMember() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(3))
        // seed 調査 inv-001 の members は u-1/u-2/u-3 のみ（mockUserId は非メンバー）
        try {
            provider.addRequirement("inv-001", "個室")
            fail("権限エラーになるはず")
        } catch (e: IllegalStateException) {
            assertEquals("条件を追加する権限がありません", e.message)
        }
    }

    // ---- createInvestigation ----

    @Test
    fun createInvestigationBuildsOwnerAndTruncatesTitle() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(4))
        val longQuery = "あ".repeat(40)
        val res = provider.createInvestigation(
            CreateInvestigationRequest(query = longQuery, displayName = "まさ", userId = "user-x", idempotencyKey = "mock-test-2", authSubject = "user-x"),
        )
        assertEquals(32, res.shareToken.length)
        val inv = provider.getInvestigation(res.investigationId)
        assertNotNull(inv)
        inv!!
        assertEquals("あ".repeat(30), inv.title) // query.slice(0, 30)
        assertEquals(InvestigationStatus.Recalling, inv.status)
        assertEquals(longQuery, inv.rawQuery)
        assertEquals(5, inv.requirements.size) // mock requirements を複製
        assertEquals(0, inv.candidates.size)
        assertEquals(1, inv.members.size)
        assertEquals("user-x", inv.members[0].id) // memberIdentity = userId 優先
        assertEquals("owner", inv.members[0].role)
    }

    // ---- runInvestigation: 800ms ごとのステップ進行（仮想時間） ----

    @Test
    fun runInvestigationProgressesThroughStepsToComplete() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(5))
        val created = provider.createInvestigation(
            CreateInvestigationRequest(query = "池袋", displayName = "まさ", userId = "user-r", idempotencyKey = "mock-test-3", authSubject = "user-r"),
        )
        val id = created.investigationId
        val statuses = mutableListOf<InvestigationStatus>()
        provider.subscribeInvestigation(id) { statuses.add(it.status) }

        provider.runInvestigation(RunInvestigationRequest(id))
        runCurrent()
        assertEquals(InvestigationStatus.Recalling, provider.getInvestigation(id)!!.status)

        advanceTimeBy(801); runCurrent()
        assertEquals(InvestigationStatus.Searching, provider.getInvestigation(id)!!.status)
        advanceTimeBy(801); runCurrent()
        assertEquals(InvestigationStatus.CollectingEvidence, provider.getInvestigation(id)!!.status)
        advanceTimeBy(801); runCurrent()
        assertEquals(InvestigationStatus.Evaluating, provider.getInvestigation(id)!!.status)
        advanceTimeBy(801); runCurrent()
        assertEquals(InvestigationStatus.Ranking, provider.getInvestigation(id)!!.status)
        advanceTimeBy(801); runCurrent()

        val completed = provider.getInvestigation(id)!!
        assertEquals(InvestigationStatus.Complete, completed.status)
        assertEquals("complete で候補 3 件が投入される", 3, completed.candidates.size)
        assertEquals(listOf(1, 2, 3), completed.candidates.map { it.rank })
        assertEquals("candidates の investigationId が差し替わる", id, completed.candidates[0].investigationId)
    }

    // ---- rerankInvestigation ----

    @Test
    fun rerankByVoteSortsByVoteSum() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(6))
        // seed inv-001 は complete。vote 合計: c-1=2, c-2=-1, c-3=1 → c-1, c-3, c-2
        val res = provider.rerankInvestigation(
            RerankInvestigationRequest("inv-001", RerankTrigger.Vote),
        )
        assertTrue(res.reranked)
        val inv = provider.getInvestigation("inv-001")!!
        assertEquals(listOf("c-1", "c-3", "c-2"), inv.candidates.map { it.id })
        assertEquals(listOf(1, 2, 3), inv.candidates.map { it.rank })
    }

    @Test
    fun rerankReturnsFalseWhenNotComplete() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(7))
        val created = provider.createInvestigation(
            CreateInvestigationRequest(query = "池袋", displayName = "まさ", userId = "user-z", idempotencyKey = "mock-test-4", authSubject = "user-z"),
        )
        // status=recalling のままなので reranked=false
        val res = provider.rerankInvestigation(
            RerankInvestigationRequest(created.investigationId, RerankTrigger.Vote),
        )
        assertEquals(false, res.reranked)
    }

    // ---- joinInvestigation ----

    @Test
    fun joinInvestigationAddsEditorIdempotently() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(8))
        // seed の shareToken は 0123456789abcdef0123456789abcdef（mock.ts L140-144）
        val res = provider.joinInvestigation(
            JoinInvestigationRequest(
                shareToken = "0123456789abcdef0123456789abcdef",
                displayName = "ゲスト",
                userId = "guest-1",
            ),
        )
        assertEquals("inv-001", res.investigationId)
        assertEquals("8/23 池袋 夜飯", res.title)
        val inv = provider.getInvestigation("inv-001")!!
        assertEquals(4, inv.members.size)
        assertEquals("editor", inv.members.last().role)

        // 冪等: 再参加でも成功しメンバー数は増えない
        provider.joinInvestigation(
            JoinInvestigationRequest(
                shareToken = "0123456789abcdef0123456789abcdef",
                displayName = "ゲスト",
                userId = "guest-1",
            ),
        )
        assertEquals(4, provider.getInvestigation("inv-001")!!.members.size)
    }

    @Test
    fun joinInvestigationFailsForUnknownToken() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(9))
        try {
            provider.joinInvestigation(
                JoinInvestigationRequest(shareToken = "ffffffffffffffffffffffffffffffff", displayName = "x"),
            )
            fail("見つからないはず")
        } catch (e: IllegalStateException) {
            assertEquals("調査が見つかりません", e.message)
        }
    }

    @Test
    fun subscribeReturnsUnsubscribe() = runTest {
        val provider = MockDataProvider(backgroundScope, Random(10))
        val received = mutableListOf<Investigation>()
        val unsubscribe = provider.subscribeInvestigation("inv-001") { received.add(it) }
        assertEquals(1, received.size)
        unsubscribe()
        provider.setVote("inv-001", "c-1", -1)
        assertEquals("解除後は通知されない", 1, received.size)
    }
}
