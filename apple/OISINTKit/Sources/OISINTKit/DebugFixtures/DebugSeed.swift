import Foundation
#if DEBUG

/// src/data/mock.ts のDebug fixture転記（計画書 §1.9）。
/// 値を変えない: inv-001 / 「8/23 池袋 夜飯」 / 候補 3 件（店A/店B/店C）/ requirements 5 件 / members 3 人。
public enum MockSeed {
    static let investigationId = "inv-001"

    public static let members: [InvestigationMember] = [
        InvestigationMember(id: "u-1", displayName: "まさくん", isOnline: true, role: .owner),
        InvestigationMember(id: "u-2", displayName: "ゆい", isOnline: true, role: .editor),
        InvestigationMember(id: "u-3", displayName: "たくみ", isOnline: false, role: .viewer),
    ]

    public static let requirements: [Requirement] = [
        Requirement(id: "r-1", text: "池袋", normalizedText: "東京都豊島区池袋周辺", kind: .location, priority: .must, weight: 1),
        Requirement(id: "r-2", text: "3人で3000円前後", normalizedText: "ディナー予算 2500〜3500円程度", kind: .budget, priority: .must, weight: 1),
        Requirement(id: "r-3", text: "肉", normalizedText: "肉料理を提供", kind: .cuisine, priority: .must, weight: 0.9),
        Requirement(id: "r-4", text: "カード可", normalizedText: "クレジットカード利用可能", kind: .payment, priority: .must, weight: 0.8),
        Requirement(id: "r-5", text: "静かめ", normalizedText: "落ち着いた雰囲気", kind: .atmosphere, priority: .should, weight: 0.6),
    ]

    static let baseEvidenceA: [Evidence] = [
        Evidence(
            id: "e-a-1",
            placeId: "p-a",
            investigationId: investigationId,
            scope: .shared,
            sourceType: "Official Website",
            sourceUrl: "https://example.com/shop-a",
            sourceTitle: "店A 公式サイト",
            excerpt: "予算 2500〜3500円。クレジットカード利用可。23時まで営業。",
            structuredClaims: [
                StructuredClaim(key: "budget_dinner", value: .object(["min": .number(2500), "max": .number(3500)]), rawText: "予算 2500〜3500円"),
                StructuredClaim(key: "card_accepted", value: .bool(true), rawText: "クレジットカード利用可"),
                StructuredClaim(key: "opening_hours", value: .string("17:00-23:00"), rawText: "23時まで営業"),
            ],
            observedAt: "2026-08-14",
            sourceQuality: 1,
            freshnessScore: 1
        ),
        Evidence(
            id: "e-a-2",
            placeId: "p-a",
            investigationId: investigationId,
            scope: .shared,
            sourceType: "Major Review Platform",
            sourceUrl: "https://tabelog.com/shop-a",
            sourceTitle: "食べログ 店A",
            excerpt: "ディナー 3000円程度。静かな雰囲気。営業時間 17:00〜22:00。",
            structuredClaims: [
                StructuredClaim(key: "budget_dinner", value: .object(["min": .number(3000), "max": .number(3000)]), rawText: "ディナー 3000円程度"),
                StructuredClaim(key: "noise_level", value: .string("quiet"), rawText: "静かな雰囲気"),
                StructuredClaim(key: "opening_hours", value: .string("17:00-22:00"), rawText: "営業時間 17:00〜22:00"),
            ],
            observedAt: "2026-08-10",
            sourceQuality: 0.75,
            freshnessScore: 0.8
        ),
    ]

    public static let investigation = Investigation(
        id: investigationId,
        title: "8/23 池袋 夜飯",
        status: .complete,
        rawQuery: "池袋 / 3人 / 3000円 / 肉 / 静かめ",
        requirements: requirements,
        candidates: [
            Candidate(
                id: "c-1",
                investigationId: investigationId,
                place: Place(
                    id: "p-a",
                    name: "店A",
                    address: "東京都豊島区池袋1-2-3",
                    genre: "焼肉",
                    access: "池袋駅 東口から徒歩5分",
                    budget: "2500〜3500円",
                    open: "17:00",
                    close: "23:00",
                    card: "可",
                    urls: PlaceURLs(pc: "https://example.com/shop-a")
                ),
                score: 0.91,
                rank: 1,
                evaluations: [
                    RequirementEvaluation(requirementId: "r-1", state: .match, confidence: 0.98, explanation: "池袋駅東口から徒歩5分", evidenceIds: ["e-a-1"]),
                    RequirementEvaluation(requirementId: "r-2", state: .match, confidence: 0.95, explanation: "ディナー 2500〜3500円", evidenceIds: ["e-a-1"]),
                    RequirementEvaluation(requirementId: "r-3", state: .match, confidence: 0.99, explanation: "焼肉メニューあり", evidenceIds: ["e-a-1"]),
                    RequirementEvaluation(requirementId: "r-4", state: .match, confidence: 0.99, explanation: "クレジットカード利用可", evidenceIds: ["e-a-1"]),
                    RequirementEvaluation(requirementId: "r-5", state: .partial, confidence: 0.61, explanation: "レビューは静かとあり、公式には明記なし", evidenceIds: ["e-a-2"]),
                ],
                evidence: baseEvidenceA,
                contradictions: [
                    Contradiction(
                        placeId: "p-a",
                        key: "opening_hours",
                        entries: [
                            ContradictionEntry(evidenceId: "e-a-1", value: .string("17:00-23:00"), sourceQuality: 1),
                            ContradictionEntry(evidenceId: "e-a-2", value: .string("17:00-22:00"), sourceQuality: 0.75),
                        ]
                    ),
                ],
                votes: ["u-1": .up, "u-2": .up, "u-3": .neutral]
            ),
            Candidate(
                id: "c-2",
                investigationId: investigationId,
                place: Place(
                    id: "p-b",
                    name: "店B",
                    address: "東京都豊島区池袋4-5-6",
                    genre: "居酒屋",
                    access: "池袋駅 西口から徒歩7分",
                    budget: "3000〜4000円",
                    open: "17:00",
                    close: "22:00",
                    card: "可",
                    urls: PlaceURLs(pc: "https://example.com/shop-b")
                ),
                score: 0.84,
                rank: 2,
                evaluations: [
                    RequirementEvaluation(requirementId: "r-1", state: .match, confidence: 0.95, explanation: "池袋駅西口から徒歩7分", evidenceIds: []),
                    RequirementEvaluation(requirementId: "r-2", state: .partial, confidence: 0.72, explanation: "予算 3000〜4000円でやや高め", evidenceIds: []),
                    RequirementEvaluation(requirementId: "r-3", state: .match, confidence: 0.88, explanation: "肉メニューあり", evidenceIds: []),
                    RequirementEvaluation(requirementId: "r-4", state: .match, confidence: 0.97, explanation: "カード可", evidenceIds: []),
                    RequirementEvaluation(requirementId: "r-5", state: .mismatch, confidence: 0.3, explanation: "居酒屋で騒がしいレビューあり", evidenceIds: []),
                ],
                evidence: [],
                contradictions: [],
                votes: ["u-1": .neutral, "u-2": .down, "u-3": .neutral]
            ),
            Candidate(
                id: "c-3",
                investigationId: investigationId,
                place: Place(
                    id: "p-c",
                    name: "店C",
                    address: "東京都豊島区池袋7-8-9",
                    genre: "ステーキ",
                    access: "池袋駅 南口から徒歩10分",
                    budget: "2500〜3500円",
                    open: "18:00",
                    close: "22:00",
                    card: "不明",
                    urls: PlaceURLs(pc: "https://example.com/shop-c")
                ),
                score: 0.79,
                rank: 3,
                evaluations: [
                    RequirementEvaluation(requirementId: "r-1", state: .match, confidence: 0.9, explanation: "池袋駅南口から徒歩10分", evidenceIds: []),
                    RequirementEvaluation(requirementId: "r-2", state: .match, confidence: 0.93, explanation: "予算 2500〜3500円", evidenceIds: []),
                    RequirementEvaluation(requirementId: "r-3", state: .match, confidence: 0.95, explanation: "ステーキ専門店", evidenceIds: []),
                    RequirementEvaluation(requirementId: "r-4", state: .unknown, confidence: 0.35, explanation: "支払い情報が見つからない", evidenceIds: []),
                    RequirementEvaluation(requirementId: "r-5", state: .partial, confidence: 0.55, explanation: "落ち着いた店内の声も、賑やかな声もあり", evidenceIds: []),
                ],
                evidence: [],
                contradictions: [],
                votes: ["u-1": .down, "u-2": .up, "u-3": .up]
            ),
        ],
        members: members,
        shareToken: "share-token-mock-001",
        createdAt: "2026-08-14T10:00:00Z",
        updatedAt: "2026-08-14T10:05:00Z"
    )
}
#endif
