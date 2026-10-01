import Foundation

/// 公開SDK key/RevenueCat project未設定時のfail-closed provider。Plusを推測で付与しない。
@MainActor
public final class UnavailableEntitlementProvider: EntitlementProviding {
    public private(set) var currentStatus = EntitlementStatus()

    public init() {}
    public func refresh() async throws { throw EntitlementError.notConfigured }
    public func offerings() async throws -> [PlusPackage] { throw EntitlementError.notConfigured }
    public func purchase(_ package: PlusPackage) async throws -> EntitlementStatus { throw EntitlementError.notConfigured }
    public func restore() async throws -> EntitlementStatus { throw EntitlementError.notConfigured }
    public func logIn(appUserID: String) async throws { throw EntitlementError.notConfigured }
    public func logOut() async throws { currentStatus = EntitlementStatus() }
}
