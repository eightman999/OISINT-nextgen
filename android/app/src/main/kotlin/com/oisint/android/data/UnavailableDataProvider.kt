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

/**
 * 外部設定不足または未知のprovider mode用のfail-closed境界。
 * 公開Releaseでローカルfixtureへフォールバックせず、データを捏造しない。
 */
class UnavailableDataProvider : DataProvider {
    override suspend fun createInvestigation(req: CreateInvestigationRequest): CreateInvestigationResponse = unavailable()
    override suspend fun runInvestigation(req: RunInvestigationRequest): RunInvestigationResponse = unavailable()
    override suspend fun rerankInvestigation(req: RerankInvestigationRequest): RerankInvestigationResponse = unavailable()
    override suspend fun joinInvestigation(req: JoinInvestigationRequest): JoinInvestigationResponse = unavailable()
    override suspend fun getInvestigation(id: String): Investigation? = unavailable()
    override fun subscribeInvestigation(id: String, listener: InvestigationListener): () -> Unit = unavailable()
    override suspend fun setVote(investigationId: String, candidateId: String, value: VoteValue): Unit = unavailable()
    override suspend fun addRequirement(investigationId: String, text: String): Unit = unavailable()
    override suspend fun getUserId(): String = unavailable()

    private fun unavailable(): Nothing =
        throw IllegalStateException("データ提供設定を確認できません。現在は操作できません。")
}
