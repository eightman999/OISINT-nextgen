import Foundation

// src/types/index.ts の逐語移植（計画書 §2.3: camelCase プロパティ。DB 行型は DatabaseRows.swift）

// MARK: - 列挙型

public enum InvestigationStatus: String, Codable, Sendable, CaseIterable {
    case draft
    case parsing
    case recalling
    case searching
    case collectingEvidence = "collecting_evidence"
    case evaluating
    case ranking
    case complete
    case failed
}

public enum RequirementKind: String, Codable, Sendable {
    case location
    case budget
    case cuisine
    case payment
    case reservation
    case atmosphere
    case partySize = "party_size"
    case time
    case access
    case dietary
    case other
}

public enum RequirementPriority: String, Codable, Sendable {
    case must
    case should
    case nice
}

public enum MatchState: String, Codable, Sendable, CaseIterable {
    case match
    case partial
    case mismatch
    case unknown
}

public enum VoteValue: Int, Codable, Sendable, CaseIterable {
    case down = -1
    case neutral = 0
    case up = 1
}

/// structured_claims の既知キー（types/index.ts ClaimKey）。
/// StructuredClaim.key 自体は live データの未知キーを許容するため String（validation.ts が z.string() で受けるのと同値）。
public enum ClaimKey: String, Sendable {
    case openingHours = "opening_hours"
    case closedDays = "closed_days"
    case budgetDinner = "budget_dinner"
    case cardAccepted = "card_accepted"
    case reservation
    case privateRoom = "private_room"
    case capacity
    case genre
    case noiseLevel = "noise_level"
    case timeLimit = "time_limit"
}

// MARK: - ドメイン型

public struct Requirement: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var text: String
    public var normalizedText: String
    public var kind: RequirementKind
    public var priority: RequirementPriority
    public var weight: Double

    public init(id: String, text: String, normalizedText: String, kind: RequirementKind, priority: RequirementPriority, weight: Double) {
        self.id = id
        self.text = text
        self.normalizedText = normalizedText
        self.kind = kind
        self.priority = priority
        self.weight = weight
    }
}

public struct RequirementEvaluation: Codable, Sendable, Equatable {
    public var requirementId: String
    public var state: MatchState
    public var confidence: Double
    public var explanation: String
    public var evidenceIds: [String]

    public init(requirementId: String, state: MatchState, confidence: Double, explanation: String, evidenceIds: [String]) {
        self.requirementId = requirementId
        self.state = state
        self.confidence = confidence
        self.explanation = explanation
        self.evidenceIds = evidenceIds
    }
}

public struct StructuredClaim: Codable, Sendable, Equatable {
    public var key: String
    public var value: JSONValue
    public var rawText: String

    public init(key: String, value: JSONValue, rawText: String) {
        self.key = key
        self.value = value
        self.rawText = rawText
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        value = try container.decodeIfPresent(JSONValue.self, forKey: .value) ?? .null
        // validation.ts: rawText: z.string().optional().default('')
        rawText = try container.decodeIfPresent(String.self, forKey: .rawText) ?? ""
    }
}

public enum EvidenceScope: String, Codable, Sendable {
    case shared
    case investigation
}

public struct Evidence: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var placeId: String
    public var investigationId: String?
    public var scope: EvidenceScope
    public var sourceType: String
    public var sourceUrl: String
    public var sourceTitle: String?
    public var excerpt: String
    public var structuredClaims: [StructuredClaim]
    public var observedAt: String
    public var sourceQuality: Double
    public var freshnessScore: Double

    public init(id: String, placeId: String, investigationId: String?, scope: EvidenceScope, sourceType: String, sourceUrl: String, sourceTitle: String?, excerpt: String, structuredClaims: [StructuredClaim], observedAt: String, sourceQuality: Double, freshnessScore: Double) {
        self.id = id
        self.placeId = placeId
        self.investigationId = investigationId
        self.scope = scope
        self.sourceType = sourceType
        self.sourceUrl = sourceUrl
        self.sourceTitle = sourceTitle
        self.excerpt = excerpt
        self.structuredClaims = structuredClaims
        self.observedAt = observedAt
        self.sourceQuality = sourceQuality
        self.freshnessScore = freshnessScore
    }
}

public struct ContradictionEntry: Codable, Sendable, Equatable {
    public var evidenceId: String
    public var value: JSONValue
    public var sourceQuality: Double

    public init(evidenceId: String, value: JSONValue, sourceQuality: Double) {
        self.evidenceId = evidenceId
        self.value = value
        self.sourceQuality = sourceQuality
    }
}

public struct Contradiction: Codable, Sendable, Equatable {
    public var placeId: String
    public var key: String
    public var entries: [ContradictionEntry]

    public init(placeId: String, key: String, entries: [ContradictionEntry]) {
        self.placeId = placeId
        self.key = key
        self.entries = entries
    }
}

public struct PlaceURLs: Codable, Sendable, Equatable {
    public var pc: String?

    public init(pc: String?) {
        self.pc = pc
    }
}

public struct Place: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var address: String?
    public var genre: String?
    public var access: String?
    public var budget: String?
    public var open: String?
    public var close: String?
    public var card: String?
    public var urls: PlaceURLs?
    public var photo: String?

    public init(id: String, name: String, address: String? = nil, genre: String? = nil, access: String? = nil, budget: String? = nil, open: String? = nil, close: String? = nil, card: String? = nil, urls: PlaceURLs? = nil, photo: String? = nil) {
        self.id = id
        self.name = name
        self.address = address
        self.genre = genre
        self.access = access
        self.budget = budget
        self.open = open
        self.close = close
        self.card = card
        self.urls = urls
        self.photo = photo
    }
}

public struct Candidate: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var investigationId: String
    public var place: Place
    public var score: Double
    public var rank: Int
    public var evaluations: [RequirementEvaluation]
    public var evidence: [Evidence]
    public var contradictions: [Contradiction]
    public var votes: [String: VoteValue]

    public init(id: String, investigationId: String, place: Place, score: Double, rank: Int, evaluations: [RequirementEvaluation], evidence: [Evidence], contradictions: [Contradiction], votes: [String: VoteValue]) {
        self.id = id
        self.investigationId = investigationId
        self.place = place
        self.score = score
        self.rank = rank
        self.evaluations = evaluations
        self.evidence = evidence
        self.contradictions = contradictions
        self.votes = votes
    }
}

public enum MemberRole: String, Codable, Sendable {
    case owner
    case editor
    case viewer
}

public struct InvestigationMember: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var displayName: String
    public var isOnline: Bool?
    public var role: MemberRole?

    public init(id: String, displayName: String, isOnline: Bool? = nil, role: MemberRole? = nil) {
        self.id = id
        self.displayName = displayName
        self.isOnline = isOnline
        self.role = role
    }
}

public struct Investigation: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var status: InvestigationStatus
    public var rawQuery: String
    public var requirements: [Requirement]
    public var candidates: [Candidate]
    public var members: [InvestigationMember]
    public var shareToken: String
    public var createdAt: String
    public var updatedAt: String

    public init(id: String, title: String, status: InvestigationStatus, rawQuery: String, requirements: [Requirement], candidates: [Candidate], members: [InvestigationMember], shareToken: String, createdAt: String, updatedAt: String) {
        self.id = id
        self.title = title
        self.status = status
        self.rawQuery = rawQuery
        self.requirements = requirements
        self.candidates = candidates
        self.members = members
        self.shareToken = shareToken
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
