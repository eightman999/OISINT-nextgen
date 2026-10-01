import Foundation
#if DEBUG

/// unit test専用の決定的Debug provider。アプリの公開文言・本番providerからは参照しない。
@MainActor
public final class MockEntitlementProvider: EntitlementProviding {
    public private(set) var currentStatus = EntitlementStatus()
    public private(set) var appUserID: String?

    public init() {}
    public func refresh() async throws {}
    public func offerings() async throws -> [PlusPackage] {
        [
            PlusPackage(id: "oisint_plus_monthly", displayName: "OISINT Plus 月額", priceString: "テスト価格", period: "月額"),
            PlusPackage(id: "oisint_plus_annual", displayName: "OISINT Plus 年額", priceString: "テスト価格", period: "年額"),
        ]
    }
    public func purchase(_ package: PlusPackage) async throws -> EntitlementStatus {
        guard package.id == "oisint_plus_monthly" || package.id == "oisint_plus_annual" else {
            throw EntitlementError.packageUnavailable
        }
        guard let appUserID, UUID(uuidString: appUserID) != nil else {
            throw EntitlementError.anonymousNotAllowed
        }
        currentStatus = EntitlementStatus(isPlus: true, willRenew: true, expiresAt: Date().addingTimeInterval(2_592_000), store: "TEST_STORE")
        return currentStatus
    }
    public func restore() async throws -> EntitlementStatus {
        guard appUserID != nil else { throw EntitlementError.anonymousNotAllowed }
        return currentStatus
    }
    public func logIn(appUserID: String) async throws {
        guard let canonical = UUID(uuidString: appUserID)?.uuidString.lowercased() else {
            throw EntitlementError.anonymousNotAllowed
        }
        self.appUserID = canonical
    }
    public func logOut() async throws { appUserID = nil; currentStatus = EntitlementStatus() }
}
#endif
