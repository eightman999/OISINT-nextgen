import Foundation

// PostgREST が返す DB 行（snake_case）。計画書 §1.5 / live.ts L108-172 の Row interface の移植。
// LiveProvider（Phase 6）が使用し、ModelsDecodingTests が §1.5 逐語 fixture で decode を検証する。

public struct InvestigationRow: Codable, Sendable, Equatable {
    public var id: String
    public var title: String
    /// `investigations.raw_query` は safe-column select に含めない。owner のみ
    /// 専用 RPC の戻り値で補完し、joined member/public では nil のままにする (#151)。
    public var rawQuery: String?
    public var status: String
    public var shareToken: String
    public var createdAt: String
    public var updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, title, status
        case rawQuery = "raw_query"
        case shareToken = "share_token"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

/// Owner-only RPC `get_investigation_owner_raw_query` の戻り行 (#151)。
public struct OwnerRawQueryRow: Codable, Sendable, Equatable {
    public var rawQuery: String

    enum CodingKeys: String, CodingKey {
        case rawQuery = "raw_query"
    }
}

public struct RequirementRow: Codable, Sendable, Equatable {
    public var id: String
    public var text: String
    public var normalizedText: String?
    public var kind: String?
    public var priority: String?
    public var weight: Double?

    enum CodingKeys: String, CodingKey {
        case id, text, kind, priority, weight
        case normalizedText = "normalized_text"
    }

    /// live.ts mapRequirement の移植（null フォールバック込み）
    public func toRequirement() -> Requirement {
        Requirement(
            id: id,
            text: text,
            normalizedText: normalizedText ?? text,
            kind: kind.flatMap(RequirementKind.init(rawValue:)) ?? .other,
            priority: priority.flatMap(RequirementPriority.init(rawValue:)) ?? .should,
            weight: weight ?? 0.5
        )
    }
}

public struct PlaceRow: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var address: String?
    public var metadata: [String: JSONValue]?
}

public struct CandidateRow: Codable, Sendable, Equatable {
    public var id: String
    public var investigationId: String
    public var placeId: String
    public var score: Double?
    public var rank: Int?
    public var summary: String?
    public var places: PlaceRow?

    enum CodingKeys: String, CodingKey {
        case id, score, rank, summary, places
        case investigationId = "investigation_id"
        case placeId = "place_id"
    }
}

public struct EvaluationRow: Codable, Sendable, Equatable {
    public var candidateId: String
    public var requirementId: String
    public var state: String
    public var confidence: Double?
    public var explanation: String?
    public var evidenceIds: [String]?

    enum CodingKeys: String, CodingKey {
        case state, confidence, explanation
        case candidateId = "candidate_id"
        case requirementId = "requirement_id"
        case evidenceIds = "evidence_ids"
    }
}

public struct EvidenceRow: Codable, Sendable, Equatable {
    public var id: String
    public var placeId: String
    public var investigationId: String?
    public var scope: String
    public var sourceType: String
    public var sourceUrl: String
    public var sourceTitle: String?
    public var excerpt: String?
    public var structuredClaims: [StructuredClaim]?
    public var observedAt: String
    public var sourceQuality: Double?
    public var freshnessScore: Double?

    enum CodingKeys: String, CodingKey {
        case id, scope, excerpt
        case placeId = "place_id"
        case investigationId = "investigation_id"
        case sourceType = "source_type"
        case sourceUrl = "source_url"
        case sourceTitle = "source_title"
        case structuredClaims = "structured_claims"
        case observedAt = "observed_at"
        case sourceQuality = "source_quality"
        case freshnessScore = "freshness_score"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        placeId = try container.decode(String.self, forKey: .placeId)
        investigationId = try container.decodeIfPresent(String.self, forKey: .investigationId)
        scope = try container.decode(String.self, forKey: .scope)
        sourceType = try container.decode(String.self, forKey: .sourceType)
        sourceUrl = try container.decode(String.self, forKey: .sourceUrl)
        sourceTitle = try container.decodeIfPresent(String.self, forKey: .sourceTitle)
        excerpt = try container.decodeIfPresent(String.self, forKey: .excerpt)
        // live.ts mapEvidence: Array.isArray(structured_claims) でなければ []（不正 jsonb を許容）
        structuredClaims = try? container.decodeIfPresent([StructuredClaim].self, forKey: .structuredClaims)
        observedAt = try container.decode(String.self, forKey: .observedAt)
        sourceQuality = try container.decodeIfPresent(Double.self, forKey: .sourceQuality)
        freshnessScore = try container.decodeIfPresent(Double.self, forKey: .freshnessScore)
    }

    /// live.ts mapEvidence の移植
    public func toEvidence() -> Evidence {
        Evidence(
            id: id,
            placeId: placeId,
            investigationId: investigationId,
            scope: scope == "investigation" ? .investigation : .shared,
            sourceType: sourceType,
            sourceUrl: sourceUrl,
            sourceTitle: sourceTitle,
            excerpt: excerpt ?? "",
            structuredClaims: structuredClaims ?? [],
            observedAt: observedAt,
            sourceQuality: sourceQuality ?? 0,
            freshnessScore: freshnessScore ?? 0
        )
    }
}

public struct VoteRow: Codable, Sendable, Equatable {
    public var candidateId: String
    public var userId: String
    public var value: Int

    enum CodingKeys: String, CodingKey {
        case value
        case candidateId = "candidate_id"
        case userId = "user_id"
    }
}

/// RPC get_investigation_members の戻り行（migrations/0005_rpc.sql）
public struct MemberRow: Codable, Sendable, Equatable {
    public var userId: String
    public var displayName: String
    public var role: String?
    public var joinedAt: String?

    enum CodingKeys: String, CodingKey {
        case role
        case userId = "user_id"
        case displayName = "display_name"
        case joinedAt = "joined_at"
    }

    /// live.ts members マッピングの移植（isOnline: true 固定、role null は viewer）
    public func toMember() -> InvestigationMember {
        InvestigationMember(
            id: userId,
            displayName: displayName,
            isOnline: true,
            role: role.flatMap(MemberRole.init(rawValue:)) ?? .viewer
        )
    }
}
