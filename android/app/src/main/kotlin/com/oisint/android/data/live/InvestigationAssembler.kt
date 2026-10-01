package com.oisint.android.data.live

import com.oisint.android.model.Candidate
import com.oisint.android.model.Evidence
import com.oisint.android.model.Investigation
import com.oisint.android.model.InvestigationMember
import com.oisint.android.model.InvestigationStatus
import com.oisint.android.model.MatchState
import com.oisint.android.model.Place
import com.oisint.android.model.Requirement
import com.oisint.android.model.RequirementEvaluation
import com.oisint.android.model.RequirementKind
import com.oisint.android.model.RequirementPriority
import com.oisint.android.model.StructuredClaim
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Investigation 集約読み取り（live.ts L104-172 Row 群 + L214-323 fetchInvestigation の移植）。
 * 6 クエリ並列 → candidate の place_id 群で shared evidence + investigation 紐付き evidence を
 * 追加取得 → id 重複排除 → rank 昇順で組み立て。
 */
class InvestigationAssembler(private val client: SupabaseClient) {

    // ---- Row 型（snake_case。live.ts L104-172 と同名） ----

    @Serializable
    data class RequirementRow(
        val id: String,
        val text: String,
        @SerialName("normalized_text") val normalizedText: String? = null,
        val kind: String? = null,
        val priority: String? = null,
        val weight: Double? = null,
    )

    @Serializable
    data class PlaceRow(
        val id: String,
        val name: String,
        val address: String? = null,
        val metadata: JsonObject? = null,
    )

    @Serializable
    data class CandidateRow(
        val id: String,
        @SerialName("investigation_id") val investigationId: String,
        @SerialName("place_id") val placeId: String,
        val score: Double? = null,
        val rank: Int? = null,
        val summary: String? = null,
        val places: PlaceRow? = null,
    )

    @Serializable
    data class EvaluationRow(
        @SerialName("candidate_id") val candidateId: String,
        @SerialName("requirement_id") val requirementId: String,
        val state: String,
        val confidence: Double? = null,
        val explanation: String? = null,
        @SerialName("evidence_ids") val evidenceIds: List<String>? = null,
    )

    @Serializable
    data class EvidenceRow(
        val id: String,
        @SerialName("place_id") val placeId: String,
        @SerialName("investigation_id") val investigationId: String? = null,
        val scope: String,
        @SerialName("source_type") val sourceType: String,
        @SerialName("source_url") val sourceUrl: String,
        @SerialName("source_title") val sourceTitle: String? = null,
        val excerpt: String? = null,
        @SerialName("structured_claims") val structuredClaims: JsonElement? = null,
        @SerialName("observed_at") val observedAt: String,
        @SerialName("source_quality") val sourceQuality: Double? = null,
        @SerialName("freshness_score") val freshnessScore: Double? = null,
    )

    @Serializable
    data class VoteRow(
        @SerialName("candidate_id") val candidateId: String,
        @SerialName("user_id") val userId: String,
        val value: Int,
        val comment: String? = null,
    )

    @Serializable
    data class InvestigationRow(
        val id: String,
        val title: String,
        // investigations.raw_query は safe-column select に含めず、owner RPC の
        // 戻り値だけで補完する。joined member/public は null (#151)。
        @SerialName("raw_query") val rawQuery: String? = null,
        val status: String,
        @SerialName("share_token") val shareToken: String,
        @SerialName("created_at") val createdAt: String,
        @SerialName("updated_at") val updatedAt: String,
    )

    @Serializable
    data class OwnerRawQueryRow(
        @SerialName("raw_query") val rawQuery: String,
    )

    @Serializable
    data class MemberRow(
        @SerialName("user_id") val userId: String,
        @SerialName("display_name") val displayName: String? = null,
        val role: String? = null,
        @SerialName("joined_at") val joinedAt: String? = null,
    )

    /** live.ts L214-323 fetchInvestigation */
    suspend fun fetch(id: String): Investigation? = coroutineScope {
        // 6 クエリ並列（live.ts L215-226）
        val invDeferred = async {
            client.from("investigations").select(
                Columns.raw("id, title, status, share_token, created_at, updated_at"),
            ) {
                filter { eq("id", id) }
                limit(1)
            }.decodeList<InvestigationRow>().firstOrNull()
        }
        val reqDeferred = async {
            client.from("requirements").select {
                filter { eq("investigation_id", id) }
            }.decodeList<RequirementRow>()
        }
        val candDeferred = async {
            client.from("candidates").select(
                Columns.raw("id, investigation_id, place_id, score, rank, summary, places (id, name, address, metadata)"),
            ) {
                filter { eq("investigation_id", id) }
            }.decodeList<CandidateRow>()
        }
        val evalDeferred = async {
            client.from("requirement_evaluations").select {
                filter { eq("investigation_id", id) }
            }.decodeList<EvaluationRow>()
        }
        val voteDeferred = async {
            client.from("votes").select(Columns.raw("candidate_id, user_id, value, comment")) {
                filter { eq("investigation_id", id) }
            }.decodeList<VoteRow>()
        }
        val memberDeferred = async {
            client.postgrest.rpc(
                "get_investigation_members",
                buildJsonObject { put("inv", id) },
            ).decodeList<MemberRow>()
        }
        val ownerRawQueryDeferred = async {
            client.postgrest.rpc(
                "get_investigation_owner_raw_query",
                buildJsonObject { put("p_investigation", id) },
            ).decodeList<OwnerRawQueryRow>()
        }

        val inv = invDeferred.await() ?: return@coroutineScope null
        val requirementRows = reqDeferred.await()
        val candidateRows = candDeferred.await()
        val evaluationRows = evalDeferred.await()
        val voteRows = voteDeferred.await()
        val memberRows = memberDeferred.await()
        // RPC側でJWT subjectがownerかを検証する。member/publicは空行であり、
        // safe-columnのinvestigations行からraw_queryを推測・復元しない (#151)。
        val ownerRawQuery = ownerRawQueryDeferred.await().firstOrNull()?.rawQuery ?: ""

        // shared evidence + investigation 紐付き evidence（live.ts L234-246）
        val placeIds = candidateRows.map { it.placeId }.distinct()
        val sharedEvidenceRows = if (placeIds.isNotEmpty()) {
            client.from("evidence").select {
                filter {
                    eq("scope", "shared")
                    isIn("place_id", placeIds)
                }
            }.decodeList<EvidenceRow>()
        } else {
            emptyList()
        }
        val scopedEvidenceRows = client.from("evidence").select {
            filter { eq("investigation_id", id) }
        }.decodeList<EvidenceRow>()

        // id 重複排除（live.ts L247-252）
        val evidence = (sharedEvidenceRows + scopedEvidenceRows)
            .distinctBy { it.id }
            .map { mapEvidence(it) }

        assemble(
            inv,
            ownerRawQuery,
            requirementRows,
            candidateRows,
            evaluationRows,
            voteRows,
            memberRows,
            evidence,
        )
    }

    private fun mapEvidence(row: EvidenceRow): Evidence {
        // structured_claims は jsonb 配列。要素は {key, value, rawText} を想定し、
        // 欠落フィールドは防御的に無視する（AI 由来データのため。ai-output-guard 規律）
        val claims = (row.structuredClaims as? JsonArray)?.mapNotNull { element ->
            val obj = element as? JsonObject ?: return@mapNotNull null
            val key = (obj["key"] as? JsonElement)?.jsonPrimitive?.content ?: return@mapNotNull null
            StructuredClaim(
                key = key,
                value = obj["value"] ?: kotlinx.serialization.json.JsonNull,
                rawText = obj["rawText"]?.jsonPrimitive?.content ?: "",
            )
        } ?: emptyList()
        return Evidence(
            id = row.id,
            placeId = row.placeId,
            investigationId = row.investigationId,
            scope = row.scope,
            sourceType = row.sourceType,
            sourceUrl = row.sourceUrl,
            sourceTitle = row.sourceTitle,
            excerpt = row.excerpt ?: "",
            structuredClaims = claims,
            observedAt = row.observedAt,
            sourceQuality = row.sourceQuality ?: 0.0,
            freshnessScore = row.freshnessScore ?: 0.0,
        )
    }

    /** live.ts L204-212 extractGenre: structured_claims の key='genre' の value[0] */
    private fun extractGenre(evidence: List<Evidence>): String? {
        for (e in evidence) {
            val claim = e.structuredClaims.firstOrNull { it.key == "genre" }
            val value = claim?.value
            if (value is JsonArray && value.isNotEmpty()) {
                return value.jsonArray[0].jsonPrimitive.content
            }
        }
        return null
    }

    private fun assemble(
        inv: InvestigationRow,
        ownerRawQuery: String,
        requirementRows: List<RequirementRow>,
        candidateRows: List<CandidateRow>,
        evaluationRows: List<EvaluationRow>,
        voteRows: List<VoteRow>,
        memberRows: List<MemberRow>,
        evidence: List<Evidence>,
    ): Investigation {
        val requirements = requirementRows.map { row ->
            Requirement(
                id = row.id,
                text = row.text,
                normalizedText = row.normalizedText ?: row.text,
                kind = RequirementKind.fromWire(row.kind),
                priority = RequirementPriority.fromWire(row.priority),
                weight = row.weight ?: 0.5,
            )
        }
        // Presence はまだ購読していないため、live の在席状態は unknown（null）にする。
        // mock の決定的な疑似在席状態を live の全員 online として再現しない。
        val members = memberRows.map(::mapLiveMember)
        val votesByCandidate = voteRows.groupBy { it.candidateId }
        val evaluationsByCandidate = evaluationRows.groupBy { it.candidateId }
        val evidenceByPlace = evidence.groupBy { it.placeId }

        val candidates = candidateRows.map { row ->
            val candidateEvidence = evidenceByPlace[row.placeId] ?: emptyList()
            val candidateVotes = votesByCandidate[row.id] ?: emptyList()
            Candidate(
                id = row.id,
                investigationId = row.investigationId,
                // genre は evidence の structured_claims から抽出（live.ts L204-212, L281）。
                // places.metadata は select するが未使用（live.ts と同一挙動）。
                place = mapLivePlace(row.places, row.placeId, extractGenre(candidateEvidence)),
                score = row.score ?: 0.0,
                rank = row.rank ?: 99,
                evaluations = (evaluationsByCandidate[row.id] ?: emptyList()).map { eval ->
                    RequirementEvaluation(
                        requirementId = eval.requirementId,
                        state = MatchState.fromWire(eval.state),
                        confidence = eval.confidence ?: 0.0,
                        explanation = eval.explanation ?: "",
                        evidenceIds = eval.evidenceIds ?: emptyList(),
                    )
                },
                evidence = candidateEvidence,
                // live.ts L305: live では常に空（candidates.cons は未読。T5 の既知事項）
                contradictions = emptyList(),
                votes = candidateVotes.associate { it.userId to it.value },
                voteComments = mapVoteComments(candidateVotes),
            )
        }.sortedBy { it.rank } // live.ts L309: (a.rank||99)-(b.rank||99) 相当（rank は 99 fallback 済み）

        return Investigation(
            id = inv.id,
            title = inv.title,
            status = InvestigationStatus.fromWire(inv.status) ?: InvestigationStatus.Failed,
            rawQuery = ownerRawQuery,
            requirements = requirements,
            candidates = candidates,
            members = members,
            shareToken = inv.shareToken,
            createdAt = inv.createdAt,
            updatedAt = inv.updatedAt,
        )
    }
}

/**
 * votes.comment を候補詳細表示用へ変換する。DB の PK は candidate_id + user_id だが、
 * 入力行の順序に依存しないよう投票者ID・コメントで正規化してから 1 件に確定する。
 * NULL / trim 後の空文字は表示対象から除外する。
 */
internal fun mapVoteComments(rows: List<InvestigationAssembler.VoteRow>): Map<String, String> =
    rows.asSequence()
        .mapNotNull { row ->
            row.comment?.trim()?.takeIf { it.isNotEmpty() }?.let { row.userId to it }
        }
        .sortedWith(compareBy<Pair<String, String>> { it.first }.thenBy { it.second })
        .distinctBy { it.first }
        .toMap(LinkedHashMap())

/**
 * live の safe-column place を表示モデルへ変換する。徒歩経路を検証する情報は別途取得
 * していないため、住所を access として再利用しない。
 */
internal fun mapLivePlace(
    row: InvestigationAssembler.PlaceRow?,
    fallbackPlaceId: String,
    genre: String?,
): Place = Place(
    id = fallbackPlaceId,
    name = row?.name ?: "不明な店舗",
    address = row?.address,
    genre = genre,
    access = null,
)

/**
 * Presence 未実装の live member を UI モデルへ変換する。
 * `isOnline = null` は未接続（unknown）を表し、MemberRow の online dot を隠す。
 */
internal fun mapLiveMember(row: InvestigationAssembler.MemberRow): InvestigationMember =
    InvestigationMember(
        id = row.userId,
        displayName = row.displayName ?: "ゲスト",
        role = row.role,
    )
