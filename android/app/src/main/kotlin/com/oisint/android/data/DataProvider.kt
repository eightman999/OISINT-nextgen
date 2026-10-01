package com.oisint.android.data

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

/** types/index.ts L198 InvestigationListener */
typealias InvestigationListener = (Investigation) -> Unit

/** 投票コメントの wire 表現。空白だけの入力は DB の NULL（削除相当）に揃える。 */
internal fun normalizeVoteComment(comment: String?): String? =
    comment?.trim()?.takeIf { it.isNotEmpty() }

/**
 * データ提供層の interface。正典は `src/lib/providers/types.ts`（34 行）。
 * メソッド名・引数・意味を 1:1 に保つ（#208 Apple 版との契約整合の共通根拠。計画書 §2.3）。
 */
interface DataProvider {
    // Edge Functions（書き込みは必ずこの4本を経由 §25）
    suspend fun createInvestigation(req: CreateInvestigationRequest): CreateInvestigationResponse
    suspend fun runInvestigation(req: RunInvestigationRequest): RunInvestigationResponse
    suspend fun rerankInvestigation(req: RerankInvestigationRequest): RerankInvestigationResponse
    suspend fun joinInvestigation(req: JoinInvestigationRequest): JoinInvestigationResponse

    // 読み取り（live は PostgREST SELECT + Realtime §20, §23）
    suspend fun getInvestigation(id: String): Investigation?
    fun subscribeInvestigation(id: String, listener: InvestigationListener): () -> Unit

    // RLS が直接許可している書き込み（votes upsert / requirements insert §23）
    // 3 引数版は既存呼び出しとの互換性のため残す。コメント付き保存は下の overload を使う。
    suspend fun setVote(investigationId: String, candidateId: String, value: VoteValue)

    /**
     * votes.comment を含む upsert。空白だけのコメントは null（既存コメントの削除相当）として扱う。
     * 旧 provider 実装でも 3 引数版へフォールバックできるよう既定実装を持たせる。
     */
    suspend fun setVote(
        investigationId: String,
        candidateId: String,
        value: VoteValue,
        comment: String?,
    ) {
        setVote(investigationId, candidateId, value)
    }
    suspend fun addRequirement(investigationId: String, text: String)

    // 認証済みユーザー ID（live は Supabase 匿名認証、mock はローカル生成）
    suspend fun getUserId(): String
}
