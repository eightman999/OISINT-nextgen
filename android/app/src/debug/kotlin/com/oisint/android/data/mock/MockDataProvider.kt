package com.oisint.android.data.mock

import com.oisint.android.data.DataProvider
import com.oisint.android.data.InvestigationListener
import com.oisint.android.data.normalizeVoteComment
import com.oisint.android.model.CreateInvestigationRequest
import com.oisint.android.model.CreateInvestigationResponse
import com.oisint.android.model.Investigation
import com.oisint.android.model.InvestigationMember
import com.oisint.android.model.InvestigationStatus
import com.oisint.android.model.JoinInvestigationRequest
import com.oisint.android.model.JoinInvestigationResponse
import com.oisint.android.model.Requirement
import com.oisint.android.model.RequirementKind
import com.oisint.android.model.RequirementPriority
import com.oisint.android.model.RerankInvestigationRequest
import com.oisint.android.model.RerankInvestigationResponse
import com.oisint.android.model.RerankTrigger
import com.oisint.android.model.RunInvestigationRequest
import com.oisint.android.model.RunInvestigationResponse
import com.oisint.android.model.VoteValue
import java.time.Instant
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Mock provider。正典は `src/lib/providers/mock.ts`（299 行）の挙動移植。
 * - モデルは immutable data class のため、TS 版の deep clone（JSON.parse/stringify）は不要
 *   （listener へ渡すスナップショットが後続変更の影響を受けない性質が copy で自動的に成立）。
 * - simulateRun は TS の setInterval(800ms) をコルーチン delay(800) に対応させる
 *   （テストは TestScope の仮想時間で検証）。
 */
class MockDataProvider(
    private val scope: CoroutineScope,
    private val random: Random = Random.Default,
) : DataProvider {

    private val investigations = LinkedHashMap<String, Investigation>()
    private val listeners = HashMap<String, MutableSet<InvestigationListener>>()
    private val activeRuns = HashMap<String, Job>()
    private val lock = Any()

    /** mock.ts L23-25: 'u-' + 16進8桁 */
    private val mockUserId: String =
        "u-" + (1..8).joinToString("") { random.nextInt(16).toString(16) }

    init {
        // mock.ts L140-144: seed（share token は e2e と同じ 32 桁 hex）
        val seed = MockData.mockInvestigation.copy(shareToken = "0123456789abcdef0123456789abcdef")
        investigations[seed.id] = seed
    }

    private fun now(): String = Instant.now().toString()

    /** mock.ts L31-33 */
    private fun memberIdentity(userId: String?, displayName: String): String {
        val trimmed = userId?.trim()
        return if (!trimmed.isNullOrEmpty()) trimmed else "display-name:${displayName.trim()}"
    }

    /** mock.ts L35-46 */
    private fun notify(investigation: Investigation) {
        val subscribed = synchronized(lock) { listeners[investigation.id]?.toList() } ?: return
        subscribed.forEach { listener ->
            try {
                listener(investigation)
            } catch (_: Throwable) {
                // listener の例外で provider を壊さない（mock.ts L42-44）
            }
        }
    }

    private fun update(id: String, transform: (Investigation) -> Investigation): Investigation? {
        val next = synchronized(lock) {
            val current = investigations[id] ?: return null
            val updated = transform(current)
            investigations[id] = updated
            updated
        }
        notify(next)
        return next
    }

    /** mock.ts L48-54 */
    private fun updateStatus(id: String, status: InvestigationStatus) {
        update(id) { it.copy(status = status, updatedAt = now()) }
    }

    /** mock.ts L132-138: UUID v4 互換 */
    private fun generateUuid(): String =
        "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".map { c ->
            when (c) {
                'x' -> random.nextInt(16).toString(16)
                'y' -> ((random.nextInt(16) and 0x3) or 0x8).toString(16)
                else -> c.toString()
            }
        }.joinToString("")

    /** mock.ts L56-106: 800ms ごとにステップを進め、complete で候補を投入 */
    private fun simulateRun(id: String) {
        synchronized(lock) {
            if (activeRuns.containsKey(id)) return
            val investigation = investigations[id] ?: return
            if (investigation.status == InvestigationStatus.Complete) return
        }

        val steps = listOf(
            InvestigationStatus.Recalling,
            InvestigationStatus.Searching,
            InvestigationStatus.CollectingEvidence,
            InvestigationStatus.Evaluating,
            InvestigationStatus.Ranking,
            InvestigationStatus.Complete,
        )
        updateStatus(id, steps[0])

        val job = scope.launch {
            try {
                var index = 0
                while (true) {
                    delay(800)
                    index += 1
                    if (index >= steps.size) break
                    val exists = synchronized(lock) { investigations.containsKey(id) }
                    if (!exists) break

                    if (steps[index] == InvestigationStatus.Complete) {
                        update(id) { current ->
                            current.copy(
                                candidates = MockData.mockInvestigation.candidates.mapIndexed { i, candidate ->
                                    candidate.copy(investigationId = id, rank = i + 1)
                                },
                                status = InvestigationStatus.Complete,
                                updatedAt = now(),
                            )
                        }
                        break
                    }
                    updateStatus(id, steps[index])
                }
            } finally {
                synchronized(lock) { activeRuns.remove(id) }
            }
        }
        synchronized(lock) { activeRuns[id] = job }
    }

    /** mock.ts L108-130: vote は投票合計点の降順、rank を 1..N に振り直し */
    private fun computeRerankedCandidates(
        investigation: Investigation,
        trigger: RerankTrigger,
    ): List<com.oisint.android.model.Candidate> {
        var candidates = investigation.candidates
        if (trigger == RerankTrigger.Vote) {
            candidates = candidates.sortedByDescending { candidate -> candidate.votes.values.sum() }
        }
        return candidates.mapIndexed { index, candidate -> candidate.copy(rank = index + 1) }
    }

    /** mock.ts L147-175 */
    override suspend fun createInvestigation(req: CreateInvestigationRequest): CreateInvestigationResponse {
        val investigationId = generateUuid()
        val shareToken = (1..32).joinToString("") { random.nextInt(16).toString(16) }
        val timestamp = now()
        val investigation = Investigation(
            id = investigationId,
            title = req.query.take(30).ifEmpty { "新しい調査" },
            status = InvestigationStatus.Recalling,
            rawQuery = req.query,
            requirements = MockData.mockInvestigation.requirements,
            candidates = emptyList(),
            members = listOf(
                InvestigationMember(
                    id = memberIdentity(req.userId, req.displayName),
                    displayName = req.displayName,
                    isOnline = true,
                    role = "owner",
                ),
            ),
            shareToken = shareToken,
            createdAt = timestamp,
            updatedAt = timestamp,
        )
        synchronized(lock) { investigations[investigationId] = investigation }
        notify(investigation)
        return CreateInvestigationResponse(investigationId, shareToken)
    }

    /** mock.ts L177-182 */
    override suspend fun runInvestigation(req: RunInvestigationRequest): RunInvestigationResponse {
        val investigation = synchronized(lock) { investigations[req.investigationId] }
            ?: throw IllegalStateException("調査が見つかりません")
        simulateRun(req.investigationId)
        return RunInvestigationResponse(investigation.status)
    }

    /** mock.ts L184-192 */
    override suspend fun rerankInvestigation(req: RerankInvestigationRequest): RerankInvestigationResponse {
        val investigation = synchronized(lock) { investigations[req.investigationId] }
            ?: throw IllegalStateException("調査が見つかりません")
        if (investigation.status != InvestigationStatus.Complete) {
            return RerankInvestigationResponse(reranked = false)
        }
        update(req.investigationId) { current ->
            current.copy(
                candidates = computeRerankedCandidates(current, req.trigger),
                updatedAt = now(),
            )
        }
        return RerankInvestigationResponse(reranked = true)
    }

    /** mock.ts L194-214（editor で参加。冪等: 既参加でも成功。上限 20 人） */
    override suspend fun joinInvestigation(req: JoinInvestigationRequest): JoinInvestigationResponse {
        val investigation = synchronized(lock) {
            investigations.values.firstOrNull { it.shareToken == req.shareToken }
        } ?: throw IllegalStateException("調査が見つかりません")

        val memberId = memberIdentity(req.userId, req.displayName)
        if (investigation.members.none { it.id == memberId }) {
            if (investigation.members.size >= 20) {
                throw IllegalStateException("参加人数の上限に達しています")
            }
            update(investigation.id) { current ->
                current.copy(
                    members = current.members + InvestigationMember(
                        id = memberId,
                        displayName = req.displayName,
                        isOnline = true,
                        role = "editor",
                    ),
                    updatedAt = now(),
                )
            }
        }
        return JoinInvestigationResponse(investigation.id, investigation.title)
    }

    /** mock.ts L216-218 */
    override suspend fun getInvestigation(id: String): Investigation? =
        synchronized(lock) { investigations[id] }

    /** mock.ts L257-262 getInvestigationByShareTokenSync（join プレビュー用。mock のみの機能） */
    fun findByShareToken(shareToken: String): Investigation? =
        synchronized(lock) { investigations.values.firstOrNull { it.shareToken == shareToken } }

    /** mock.ts L220-232（登録時に現状を即時通知） */
    override fun subscribeInvestigation(id: String, listener: InvestigationListener): () -> Unit {
        synchronized(lock) {
            listeners.getOrPut(id) { mutableSetOf() }.add(listener)
        }
        val investigation = synchronized(lock) { investigations[id] }
        if (investigation != null) {
            try {
                listener(investigation)
            } catch (_: Throwable) {
                // 画面側 listener の例外で購読自体は成功させる（mock.ts L225-229）
            }
        }
        return {
            synchronized(lock) { listeners[id]?.remove(listener) }
        }
    }

    /** mock.ts L234-236 + L264-277（存在しない candidate は黙って無視） */
    override suspend fun setVote(investigationId: String, candidateId: String, value: VoteValue) {
        setVote(investigationId, candidateId, value, null)
    }

    /** mock.ts と同じく、コメントは投票者ごとに同じ vote 行へ保存する。 */
    override suspend fun setVote(
        investigationId: String,
        candidateId: String,
        value: VoteValue,
        comment: String?,
    ) {
        val investigation = synchronized(lock) { investigations[investigationId] } ?: return
        if (investigation.candidates.none { it.id == candidateId }) return
        update(investigationId) { current ->
            current.copy(
                candidates = current.candidates.map { candidate ->
                    if (candidate.id == candidateId) {
                        val normalizedComment = normalizeVoteComment(comment)
                        val nextComments = if (normalizedComment == null) {
                            candidate.voteComments - mockUserId
                        } else {
                            candidate.voteComments + (mockUserId to normalizedComment)
                        }
                        candidate.copy(
                            votes = candidate.votes + (mockUserId to value),
                            voteComments = nextComments,
                        )
                    } else {
                        candidate
                    }
                },
                updatedAt = now(),
            )
        }
    }

    /** mock.ts L238-242 + L279-299（owner/editor のみ。失敗は throw） */
    override suspend fun addRequirement(investigationId: String, text: String) {
        val investigation = synchronized(lock) { investigations[investigationId] }
            ?: throw IllegalStateException("条件を追加する権限がありません")
        val member = investigation.members.firstOrNull { it.id == mockUserId }
        if (member?.role != "owner" && member?.role != "editor") {
            throw IllegalStateException("条件を追加する権限がありません")
        }
        update(investigationId) { current ->
            current.copy(
                requirements = current.requirements + Requirement(
                    id = "req-${generateUuid()}",
                    text = text,
                    normalizedText = text,
                    kind = RequirementKind.Other,
                    priority = RequirementPriority.Should,
                    weight = 0.5,
                ),
                updatedAt = now(),
            )
        }
    }

    /** mock.ts L244-246 */
    override suspend fun getUserId(): String = mockUserId
}
