import Foundation

// Edge Function 4 本の I/F（計画書 §1.3-1.4。Worker api.oisint.com /v1 経由）と
// src/lib/validation.ts の Zod 検証の移植

public struct CreateInvestigationRequest: Codable, Sendable, Equatable {
    public var query: String
    public var displayName: String
    /// Mock/live provider で同一参加者を識別するための任意の安定ID（types/index.ts 逐語）
    public var userId: String?
    /// timeout後の再送を同じinvestigationへ収束させるHTTP header用キー。
    public var idempotencyKey: String = ""
    /// create開始時にHomeが観測したsubject。HTTP bodyには含めず、WorkerAPIClientがJWTと照合する。
    public var authSubject: String = ""

    private enum CodingKeys: String, CodingKey {
        case query
        case displayName
        case userId
    }

    public init(
        query: String,
        displayName: String,
        userId: String? = nil,
        idempotencyKey: String,
        authSubject: String
    ) {
        self.query = query
        self.displayName = displayName
        self.userId = userId
        self.idempotencyKey = idempotencyKey
        self.authSubject = authSubject
    }
}

public struct CreateInvestigationResponse: Codable, Sendable, Equatable {
    public var investigationId: String
    public var shareToken: String

    public init(investigationId: String, shareToken: String) {
        self.investigationId = investigationId
        self.shareToken = shareToken
    }
}

public struct RunInvestigationRequest: Codable, Sendable, Equatable {
    public var investigationId: String

    public init(investigationId: String) {
        self.investigationId = investigationId
    }
}

public struct RunInvestigationResponse: Codable, Sendable, Equatable {
    public var status: InvestigationStatus

    public init(status: InvestigationStatus) {
        self.status = status
    }
}

public enum RerankTrigger: String, Codable, Sendable {
    case vote
    case requirementAdded = "requirement_added"
    case requirementRemoved = "requirement_removed"
}

public struct RerankInvestigationRequest: Codable, Sendable, Equatable {
    public var investigationId: String
    public var trigger: RerankTrigger

    public init(investigationId: String, trigger: RerankTrigger) {
        self.investigationId = investigationId
        self.trigger = trigger
    }
}

public struct RerankInvestigationResponse: Codable, Sendable, Equatable {
    public var reranked: Bool

    public init(reranked: Bool) {
        self.reranked = reranked
    }
}

public struct JoinInvestigationRequest: Codable, Sendable, Equatable {
    public var shareToken: String
    public var displayName: String
    /// 未指定時は displayName を後方互換の識別子として扱う（types/index.ts 逐語）
    public var userId: String?

    public init(shareToken: String, displayName: String, userId: String? = nil) {
        self.shareToken = shareToken
        self.displayName = displayName
        self.userId = userId
    }
}

public struct JoinInvestigationResponse: Codable, Sendable, Equatable {
    public var investigationId: String
    public var title: String

    public init(investigationId: String, title: String) {
        self.investigationId = investigationId
        self.title = title
    }
}

public struct APIErrorPayload: Codable, Sendable, Equatable {
    public var error: String
}

/// API / provider のエラー（日本語メッセージは Web と逐語一致させる）
public struct OISINTError: Error, LocalizedError, Equatable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// src/lib/validation.ts の Zod スキーマ相当の検証（decode 後の追加制約）
public enum ResponseValidation {
    /// createInvestigationResponseSchema: investigationId は uuid、shareToken は ^[0-9a-f]{32}$
    public static func validate(_ response: CreateInvestigationResponse) throws {
        guard UUID(uuidString: response.investigationId) != nil else {
            throw OISINTError("レスポンス検証に失敗しました: investigationId が UUID ではありません")
        }
        guard response.shareToken.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else {
            throw OISINTError("レスポンス検証に失敗しました: shareToken の形式が不正です")
        }
    }

    /// joinInvestigationResponseSchema: investigationId は min(1)
    public static func validate(_ response: JoinInvestigationResponse) throws {
        guard !response.investigationId.isEmpty else {
            throw OISINTError("レスポンス検証に失敗しました: investigationId が空です")
        }
    }
}
