package com.oisint.android.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * ドメインモデル。正典は `src/types/index.ts`（1:1 移植。フィールド名・optional・リテラル値を保存）。
 * PostgREST 行（snake_case）は Phase 6 の live 層で別 Row クラスとして受け、
 * ここへ変換する（live.ts の Row interface 群 L104-172 に対応）。
 */

/** types/index.ts L3-12 */
@Serializable
enum class InvestigationStatus(val wire: String) {
    @SerialName("draft") Draft("draft"),
    @SerialName("parsing") Parsing("parsing"),
    @SerialName("recalling") Recalling("recalling"),
    @SerialName("searching") Searching("searching"),
    @SerialName("collecting_evidence") CollectingEvidence("collecting_evidence"),
    @SerialName("evaluating") Evaluating("evaluating"),
    @SerialName("ranking") Ranking("ranking"),
    @SerialName("complete") Complete("complete"),
    @SerialName("failed") Failed("failed");

    companion object {
        fun fromWire(value: String?): InvestigationStatus? = entries.firstOrNull { it.wire == value }
    }
}

/** types/index.ts L14-25 */
@Serializable
enum class RequirementKind(val wire: String) {
    @SerialName("location") Location("location"),
    @SerialName("budget") Budget("budget"),
    @SerialName("cuisine") Cuisine("cuisine"),
    @SerialName("payment") Payment("payment"),
    @SerialName("reservation") Reservation("reservation"),
    @SerialName("atmosphere") Atmosphere("atmosphere"),
    @SerialName("party_size") PartySize("party_size"),
    @SerialName("time") Time("time"),
    @SerialName("access") Access("access"),
    @SerialName("dietary") Dietary("dietary"),
    @SerialName("other") Other("other");

    companion object {
        fun fromWire(value: String?): RequirementKind = entries.firstOrNull { it.wire == value } ?: Other
    }
}

/** types/index.ts L27 */
@Serializable
enum class RequirementPriority(val wire: String) {
    @SerialName("must") Must("must"),
    @SerialName("should") Should("should"),
    @SerialName("nice") Nice("nice");

    companion object {
        fun fromWire(value: String?): RequirementPriority = entries.firstOrNull { it.wire == value } ?: Should
    }
}

/** types/index.ts L29 */
@Serializable
enum class MatchState(val wire: String) {
    @SerialName("match") Match("match"),
    @SerialName("partial") Partial("partial"),
    @SerialName("mismatch") Mismatch("mismatch"),
    @SerialName("unknown") Unknown("unknown");

    companion object {
        fun fromWire(value: String?): MatchState = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

/** types/index.ts L31: -1 | 0 | 1 */
typealias VoteValue = Int

/** types/index.ts L33 */
@Serializable
enum class TasteHealthGoal(val wire: String) {
    @SerialName("none") None("none"),
    @SerialName("diet") Diet("diet"),
    @SerialName("high_protein") HighProtein("high_protein"),
}

/** types/index.ts L35-40 */
@Serializable
data class TasteProfile(
    val likes: List<String> = emptyList(),
    val avoid: List<String> = emptyList(),
    val allergies: String = "",
    val healthGoal: TasteHealthGoal = TasteHealthGoal.None,
)

/** types/index.ts L42-47 */
@Serializable
data class LocationSelection(
    val label: String,
    val source: String, // 'gps' | 'map'
    val latitude: Double? = null,
    val longitude: Double? = null,
)

/** types/index.ts L49-56 */
@Serializable
data class Requirement(
    val id: String,
    val text: String,
    val normalizedText: String,
    val kind: RequirementKind,
    val priority: RequirementPriority,
    val weight: Double,
)

/** types/index.ts L58-64 */
@Serializable
data class RequirementEvaluation(
    val requirementId: String,
    val state: MatchState,
    val confidence: Double,
    val explanation: String,
    val evidenceIds: List<String>,
)

/**
 * types/index.ts L81-91 ClaimKey は 10 種の union だが、live データの拡張キーで
 * デコードが落ちないよう String で保持する（比較は定数で行う）。
 */
object ClaimKeys {
    const val OPENING_HOURS = "opening_hours"
    const val GENRE = "genre"
}

/** types/index.ts L93-97。value: unknown は JsonElement で保持 */
@Serializable
data class StructuredClaim(
    val key: String,
    val value: JsonElement,
    val rawText: String,
)

/** types/index.ts L66-79 */
@Serializable
data class Evidence(
    val id: String,
    val placeId: String,
    val investigationId: String?,
    val scope: String, // 'shared' | 'investigation'
    val sourceType: String,
    val sourceUrl: String,
    val sourceTitle: String? = null,
    val excerpt: String,
    val structuredClaims: List<StructuredClaim>,
    val observedAt: String,
    val sourceQuality: Double,
    val freshnessScore: Double,
)

/** types/index.ts L99-103 */
@Serializable
data class ContradictionEntry(
    val evidenceId: String,
    val value: JsonElement,
    val sourceQuality: Double,
)

@Serializable
data class Contradiction(
    val placeId: String,
    val key: String,
    val entries: List<ContradictionEntry>,
)

/** types/index.ts L105-117 */
@Serializable
data class PlaceUrls(val pc: String? = null)

@Serializable
data class Place(
    val id: String,
    val name: String,
    val address: String? = null,
    val genre: String? = null,
    val access: String? = null,
    val budget: String? = null,
    val open: String? = null,
    val close: String? = null,
    val card: String? = null,
    val urls: PlaceUrls? = null,
    val photo: String? = null,
)

/** types/index.ts L119-129 */
@Serializable
data class Candidate(
    val id: String,
    val investigationId: String,
    val place: Place,
    val score: Double,
    val rank: Int,
    val evaluations: List<RequirementEvaluation>,
    val evidence: List<Evidence>,
    val contradictions: List<Contradiction>,
    val votes: Map<String, VoteValue>,
    /** votes.comment。空文字は保持せず、投票者IDごとの任意コメントだけを載せる。 */
    val voteComments: Map<String, String> = emptyMap(),
)

/** types/index.ts L131-136 */
@Serializable
data class InvestigationMember(
    val id: String,
    val displayName: String,
    val isOnline: Boolean? = null,
    val role: String? = null, // 'owner' | 'editor' | 'viewer'
)

/** types/index.ts L138-149 */
@Serializable
data class Investigation(
    val id: String,
    val title: String,
    val status: InvestigationStatus,
    val rawQuery: String,
    val requirements: List<Requirement>,
    val candidates: List<Candidate>,
    val members: List<InvestigationMember>,
    val shareToken: String,
    val createdAt: String,
    val updatedAt: String,
)

/** types/index.ts L151-156 */
@Serializable
data class CreateInvestigationRequest(
    val query: String,
    val displayName: String,
    /** Mock/live provider で同一参加者を識別するための任意の安定ID。 */
    val userId: String? = null,
    /** timeout後の再送を同じinvestigationへ収束させるHTTP header用キー。 */
    val idempotencyKey: String,
    /** create開始時にHomeが観測したsubject。API clientがBearer JWTと照合する。 */
    val authSubject: String,
)

/** types/index.ts L158-161 */
@Serializable
data class CreateInvestigationResponse(
    val investigationId: String,
    val shareToken: String,
)

/** types/index.ts L86-92。現在地検索のためだけに run request へ渡す一時 anchor。DB・共有URLへ保存しない。 */
@Serializable
data class LocationSearchAnchor(val lat: Double, val lng: Double)

/** types/index.ts L163-165 + L328-332（searchAnchor は GPS 許可時だけ送る） */
@Serializable
data class RunInvestigationRequest(
    val investigationId: String,
    val searchAnchor: LocationSearchAnchor? = null,
)

/** types/index.ts L334（'location_anchor_required'） */
@Serializable
enum class RunInvestigationReason(val wire: String) {
    @SerialName("location_anchor_required") LocationAnchorRequired("location_anchor_required"),
}

/** types/index.ts L167-169 + L335-339 */
@Serializable
data class RunInvestigationResponse(
    val status: InvestigationStatus,
    val reason: RunInvestigationReason? = null,
    val message: String? = null,
)

/** types/index.ts L171 */
@Serializable
enum class RerankTrigger(val wire: String) {
    @SerialName("vote") Vote("vote"),
    @SerialName("requirement_added") RequirementAdded("requirement_added"),
    @SerialName("requirement_removed") RequirementRemoved("requirement_removed"),
}

/** types/index.ts L173-176 */
@Serializable
data class RerankInvestigationRequest(
    val investigationId: String,
    val trigger: RerankTrigger,
)

/** types/index.ts L178-180 */
@Serializable
data class RerankInvestigationResponse(val reranked: Boolean)

/** types/index.ts L182-187 */
@Serializable
data class JoinInvestigationRequest(
    val shareToken: String,
    val displayName: String,
    /** 未指定時は displayName を後方互換の識別子として扱う。 */
    val userId: String? = null,
)

/** types/index.ts L189-192 */
@Serializable
data class JoinInvestigationResponse(
    val investigationId: String,
    val title: String,
)

/** types/index.ts L194-196 */
@Serializable
data class ApiError(val error: String)
