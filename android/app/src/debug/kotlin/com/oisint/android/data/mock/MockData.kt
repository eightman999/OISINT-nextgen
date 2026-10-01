package com.oisint.android.data.mock

import com.oisint.android.model.Candidate
import com.oisint.android.model.Contradiction
import com.oisint.android.model.ContradictionEntry
import com.oisint.android.model.Evidence
import com.oisint.android.model.Investigation
import com.oisint.android.model.InvestigationMember
import com.oisint.android.model.InvestigationStatus
import com.oisint.android.model.MatchState
import com.oisint.android.model.Place
import com.oisint.android.model.PlaceUrls
import com.oisint.android.model.Requirement
import com.oisint.android.model.RequirementEvaluation
import com.oisint.android.model.RequirementKind
import com.oisint.android.model.RequirementPriority
import com.oisint.android.model.StructuredClaim
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Mock データ。正典は `src/data/mock.ts`（204 行の 1:1 移植。日本語文言は一字一句同一）。
 * US1 デモがネットワーク無しで完走するための全データ（spec.md §26 / CLAUDE.md の mock 規律）。
 */
object MockData {

    const val INVESTIGATION_ID = "inv-001"

    /** mock.ts L11-15 */
    val mockMembers: List<InvestigationMember> = listOf(
        InvestigationMember(id = "u-1", displayName = "まさくん", isOnline = true, role = "owner"),
        InvestigationMember(id = "u-2", displayName = "ゆい", isOnline = true, role = "editor"),
        InvestigationMember(id = "u-3", displayName = "たくみ", isOnline = false, role = "viewer"),
    )

    /** mock.ts L17-58 */
    val mockRequirements: List<Requirement> = listOf(
        Requirement(
            id = "r-1",
            text = "池袋",
            normalizedText = "東京都豊島区池袋周辺",
            kind = RequirementKind.Location,
            priority = RequirementPriority.Must,
            weight = 1.0,
        ),
        Requirement(
            id = "r-2",
            text = "3人で3000円前後",
            normalizedText = "ディナー予算 2500〜3500円程度",
            kind = RequirementKind.Budget,
            priority = RequirementPriority.Must,
            weight = 1.0,
        ),
        Requirement(
            id = "r-3",
            text = "肉",
            normalizedText = "肉料理を提供",
            kind = RequirementKind.Cuisine,
            priority = RequirementPriority.Must,
            weight = 0.9,
        ),
        Requirement(
            id = "r-4",
            text = "カード可",
            normalizedText = "クレジットカード利用可能",
            kind = RequirementKind.Payment,
            priority = RequirementPriority.Must,
            weight = 0.8,
        ),
        Requirement(
            id = "r-5",
            text = "静かめ",
            normalizedText = "落ち着いた雰囲気",
            kind = RequirementKind.Atmosphere,
            priority = RequirementPriority.Should,
            weight = 0.6,
        ),
    )

    /** mock.ts L60-97（店 A の Evidence 2 件） */
    val baseEvidenceA: List<Evidence> = listOf(
        Evidence(
            id = "e-a-1",
            placeId = "p-a",
            investigationId = INVESTIGATION_ID,
            scope = "shared",
            sourceType = "Official Website",
            sourceUrl = "https://example.com/shop-a",
            sourceTitle = "店A 公式サイト",
            excerpt = "予算 2500〜3500円。クレジットカード利用可。23時まで営業。",
            structuredClaims = listOf(
                StructuredClaim(
                    key = "budget_dinner",
                    value = buildJsonObject { put("min", 2500); put("max", 3500) },
                    rawText = "予算 2500〜3500円",
                ),
                StructuredClaim(
                    key = "card_accepted",
                    value = JsonPrimitive(true),
                    rawText = "クレジットカード利用可",
                ),
                StructuredClaim(
                    key = "opening_hours",
                    value = JsonPrimitive("17:00-23:00"),
                    rawText = "23時まで営業",
                ),
            ),
            observedAt = "2026-08-14",
            sourceQuality = 1.0,
            freshnessScore = 1.0,
        ),
        Evidence(
            id = "e-a-2",
            placeId = "p-a",
            investigationId = INVESTIGATION_ID,
            scope = "shared",
            sourceType = "Major Review Platform",
            sourceUrl = "https://tabelog.com/shop-a",
            sourceTitle = "食べログ 店A",
            excerpt = "ディナー 3000円程度。静かな雰囲気。営業時間 17:00〜22:00。",
            structuredClaims = listOf(
                StructuredClaim(
                    key = "budget_dinner",
                    value = buildJsonObject { put("min", 3000); put("max", 3000) },
                    rawText = "ディナー 3000円程度",
                ),
                StructuredClaim(
                    key = "noise_level",
                    value = JsonPrimitive("quiet"),
                    rawText = "静かな雰囲気",
                ),
                StructuredClaim(
                    key = "opening_hours",
                    value = JsonPrimitive("17:00-22:00"),
                    rawText = "営業時間 17:00〜22:00",
                ),
            ),
            observedAt = "2026-08-10",
            sourceQuality = 0.75,
            freshnessScore = 0.8,
        ),
    )

    /** mock.ts L99-204 */
    val mockInvestigation: Investigation = Investigation(
        id = INVESTIGATION_ID,
        title = "8/23 池袋 夜飯",
        status = InvestigationStatus.Complete,
        rawQuery = "池袋 / 3人 / 3000円 / 肉 / 静かめ",
        requirements = mockRequirements,
        members = mockMembers,
        shareToken = "share-token-mock-001",
        createdAt = "2026-08-14T10:00:00Z",
        updatedAt = "2026-08-14T10:05:00Z",
        candidates = listOf(
            Candidate(
                id = "c-1",
                investigationId = INVESTIGATION_ID,
                place = Place(
                    id = "p-a",
                    name = "店A",
                    address = "東京都豊島区池袋1-2-3",
                    genre = "焼肉",
                    access = "池袋駅 東口から徒歩5分",
                    budget = "2500〜3500円",
                    open = "17:00",
                    close = "23:00",
                    card = "可",
                    urls = PlaceUrls(pc = "https://example.com/shop-a"),
                ),
                score = 0.91,
                rank = 1,
                evaluations = listOf(
                    RequirementEvaluation("r-1", MatchState.Match, 0.98, "池袋駅東口から徒歩5分", listOf("e-a-1")),
                    RequirementEvaluation("r-2", MatchState.Match, 0.95, "ディナー 2500〜3500円", listOf("e-a-1")),
                    RequirementEvaluation("r-3", MatchState.Match, 0.99, "焼肉メニューあり", listOf("e-a-1")),
                    RequirementEvaluation("r-4", MatchState.Match, 0.99, "クレジットカード利用可", listOf("e-a-1")),
                    RequirementEvaluation(
                        "r-5",
                        MatchState.Partial,
                        0.61,
                        "レビューは静かとあり、公式には明記なし",
                        listOf("e-a-2"),
                    ),
                ),
                evidence = baseEvidenceA,
                contradictions = listOf(
                    Contradiction(
                        placeId = "p-a",
                        key = "opening_hours",
                        entries = listOf(
                            ContradictionEntry("e-a-1", JsonPrimitive("17:00-23:00"), 1.0),
                            ContradictionEntry("e-a-2", JsonPrimitive("17:00-22:00"), 0.75),
                        ),
                    ),
                ),
                votes = mapOf("u-1" to 1, "u-2" to 1, "u-3" to 0),
            ),
            Candidate(
                id = "c-2",
                investigationId = INVESTIGATION_ID,
                place = Place(
                    id = "p-b",
                    name = "店B",
                    address = "東京都豊島区池袋4-5-6",
                    genre = "居酒屋",
                    access = "池袋駅 西口から徒歩7分",
                    budget = "3000〜4000円",
                    open = "17:00",
                    close = "22:00",
                    card = "可",
                    urls = PlaceUrls(pc = "https://example.com/shop-b"),
                ),
                score = 0.84,
                rank = 2,
                evaluations = listOf(
                    RequirementEvaluation("r-1", MatchState.Match, 0.95, "池袋駅西口から徒歩7分", emptyList()),
                    RequirementEvaluation("r-2", MatchState.Partial, 0.72, "予算 3000〜4000円でやや高め", emptyList()),
                    RequirementEvaluation("r-3", MatchState.Match, 0.88, "肉メニューあり", emptyList()),
                    RequirementEvaluation("r-4", MatchState.Match, 0.97, "カード可", emptyList()),
                    RequirementEvaluation("r-5", MatchState.Mismatch, 0.3, "居酒屋で騒がしいレビューあり", emptyList()),
                ),
                evidence = emptyList(),
                contradictions = emptyList(),
                votes = mapOf("u-1" to 0, "u-2" to -1, "u-3" to 0),
            ),
            Candidate(
                id = "c-3",
                investigationId = INVESTIGATION_ID,
                place = Place(
                    id = "p-c",
                    name = "店C",
                    address = "東京都豊島区池袋7-8-9",
                    genre = "ステーキ",
                    access = "池袋駅 南口から徒歩10分",
                    budget = "2500〜3500円",
                    open = "18:00",
                    close = "22:00",
                    card = "不明",
                    urls = PlaceUrls(pc = "https://example.com/shop-c"),
                ),
                score = 0.79,
                rank = 3,
                evaluations = listOf(
                    RequirementEvaluation("r-1", MatchState.Match, 0.9, "池袋駅南口から徒歩10分", emptyList()),
                    RequirementEvaluation("r-2", MatchState.Match, 0.93, "予算 2500〜3500円", emptyList()),
                    RequirementEvaluation("r-3", MatchState.Match, 0.95, "ステーキ専門店", emptyList()),
                    RequirementEvaluation("r-4", MatchState.Unknown, 0.35, "支払い情報が見つからない", emptyList()),
                    RequirementEvaluation(
                        "r-5",
                        MatchState.Partial,
                        0.55,
                        "落ち着いた店内の声も、賑やかな声もあり",
                        emptyList(),
                    ),
                ),
                evidence = emptyList(),
                contradictions = emptyList(),
                votes = mapOf("u-1" to -1, "u-2" to 1, "u-3" to 1),
            ),
        ),
    )
}
