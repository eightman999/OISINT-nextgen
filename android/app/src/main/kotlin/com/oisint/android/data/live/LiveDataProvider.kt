package com.oisint.android.data.live

import com.oisint.android.data.DataProvider
import com.oisint.android.data.InvestigationListener
import com.oisint.android.data.normalizeVoteComment
import com.oisint.android.model.CreateInvestigationRequest
import com.oisint.android.model.CreateInvestigationResponse
import com.oisint.android.model.Investigation
import com.oisint.android.model.JoinInvestigationRequest
import com.oisint.android.model.JoinInvestigationResponse
import com.oisint.android.model.RerankInvestigationRequest
import com.oisint.android.model.RerankInvestigationResponse
import com.oisint.android.model.RunInvestigationRequest
import com.oisint.android.model.RunInvestigationResponse
import com.oisint.android.model.VoteValue
import io.github.jan.supabase.postgrest.from
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Live provider（live.ts の全体移植。計画書 §2.3）。
 * - 書き込み系 4 本は api.oisint.com（Worker）経由（spec.md §25。クライアントから
 *   Edge Function を直接叩かない）
 * - votes / requirements は RLS が直接許可する書き込み（§23）
 * - 読み取りは PostgREST 直 + Realtime 300ms debounce 再取得
 */
class LiveDataProvider(
    private val clients: SupabaseClients,
    private val api: OisintApiClient,
    scope: CoroutineScope,
) : DataProvider {

    private val assembler = InvestigationAssembler(clients.client)
    private val realtime = RealtimeSubscriber(clients.client, assembler, scope)

    override suspend fun createInvestigation(req: CreateInvestigationRequest): CreateInvestigationResponse {
        clients.ensureUserId()
        // live.ts L330-335: userId フィールドは API へ送らない（サーバは JWT から解決）
        return api.createInvestigation(req.copy(userId = null))
    }

    override suspend fun runInvestigation(req: RunInvestigationRequest): RunInvestigationResponse {
        clients.ensureUserId()
        return api.runInvestigation(req)
    }

    override suspend fun rerankInvestigation(req: RerankInvestigationRequest): RerankInvestigationResponse {
        clients.ensureUserId()
        return api.rerankInvestigation(req)
    }

    override suspend fun joinInvestigation(req: JoinInvestigationRequest): JoinInvestigationResponse {
        clients.ensureUserId()
        return api.joinInvestigation(req.copy(userId = null))
    }

    override suspend fun getInvestigation(id: String): Investigation? {
        clients.ensureUserId()
        return assembler.fetch(id)
    }

    override fun subscribeInvestigation(id: String, listener: InvestigationListener): () -> Unit =
        realtime.subscribe(id, listener)

    @Serializable
    internal data class VoteUpsert(
        @SerialName("investigation_id") val investigationId: String,
        @SerialName("candidate_id") val candidateId: String,
        @SerialName("user_id") val userId: String,
        val value: Int,
        // nullable かつ default なしにして、コメント削除時の JSON null を wire へ含める。
        val comment: String?,
    )

    /** live.ts L484-501: votes upsert（onConflict candidate_id,user_id） */
    override suspend fun setVote(investigationId: String, candidateId: String, value: VoteValue) {
        setVote(investigationId, candidateId, value, null)
    }

    /** votes.comment は trim 済みの値、空白のみは null として同じ行へ upsert する。 */
    override suspend fun setVote(
        investigationId: String,
        candidateId: String,
        value: VoteValue,
        comment: String?,
    ) {
        val userId = clients.ensureUserId()
        try {
            clients.client.from("votes").upsert(
                VoteUpsert(
                    investigationId = investigationId,
                    candidateId = candidateId,
                    userId = userId,
                    value = value,
                    comment = normalizeVoteComment(comment),
                ),
            ) {
                onConflict = "candidate_id,user_id"
            }
        } catch (e: Exception) {
            throw IllegalStateException("投票に失敗しました: ${e.message}", e)
        }
    }

    @Serializable
    private data class RequirementInsert(
        @SerialName("investigation_id") val investigationId: String,
        @SerialName("created_by") val createdBy: String,
        val text: String,
        @SerialName("normalized_text") val normalizedText: String,
    )

    /** live.ts L503-513: requirements insert（normalized_text = text） */
    override suspend fun addRequirement(investigationId: String, text: String) {
        val userId = clients.ensureUserId()
        try {
            clients.client.from("requirements").insert(
                RequirementInsert(investigationId, userId, text, text),
            )
        } catch (e: Exception) {
            throw IllegalStateException("条件の追加に失敗しました: ${e.message}", e)
        }
    }

    override suspend fun getUserId(): String = clients.ensureUserId()
}
