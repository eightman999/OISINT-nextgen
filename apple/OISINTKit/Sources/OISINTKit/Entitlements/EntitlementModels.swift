import Foundation

/// UI/Storeから独立したPlus状態。RevenueCat固有の型はこの境界を越えない。
public struct EntitlementStatus: Sendable, Equatable {
    public let isPlus: Bool
    public let willRenew: Bool?
    public let expiresAt: Date?
    public let gracePeriodExpiresAt: Date?
    public let store: String?
    /// Server の正本で検証した商品。SDKのactive flagだけでは値を埋めない。
    public let productIdentifier: String?
    public let lifecycleState: String?

    public init(
        isPlus: Bool = false,
        willRenew: Bool? = nil,
        expiresAt: Date? = nil,
        gracePeriodExpiresAt: Date? = nil,
        store: String? = nil,
        productIdentifier: String? = nil,
        lifecycleState: String? = nil
    ) {
        self.isPlus = isPlus
        self.willRenew = willRenew
        self.expiresAt = expiresAt
        self.gracePeriodExpiresAt = gracePeriodExpiresAt
        self.store = store
        self.productIdentifier = productIdentifier
        self.lifecycleState = lifecycleState
    }
}

public struct PlusPackage: Identifiable, Sendable, Equatable, Hashable {
    public let id: String
    public let displayName: String
    public let priceString: String
    public let period: String

    public init(id: String, displayName: String, priceString: String, period: String) {
        self.id = id
        self.displayName = displayName
        self.priceString = priceString
        self.period = period
    }
}

public enum EntitlementError: Error, LocalizedError, Sendable, Equatable {
    case cancelled
    case packageUnavailable
    case anonymousNotAllowed
    case notConfigured
    case pending
    case message(String)

    public var errorDescription: String? {
        switch self {
        case .cancelled: return String(localized: "購入をキャンセルしました。", bundle: .module)
        case .packageUnavailable: return String(localized: "購入プランを読み込めませんでした。", bundle: .module)
        case .anonymousNotAllowed: return String(localized: "購入には恒久アカウントの接続が必要です。", bundle: .module)
        case .notConfigured: return String(localized: "購入機能は現在設定されていません。", bundle: .module)
        case .pending: return String(localized: "購入を受け付けました。サーバー反映を待ってからPlus状態を確認します。", bundle: .module)
        case .message(let message): return message
        }
    }
}
