import Foundation

/// 課金SDKの結果ではなく、Supabase `get_my_entitlement` を読むserver正本。
/// エラー時は呼び出し側がFreeへ倒し、SDKの状態をPlusへ昇格させない。
public typealias ServerEntitlementFetcher = @Sendable (String) async throws -> EntitlementStatus

/// 課金SDKとUIの境界。画面はこのprotocolと値型だけを参照する。
@MainActor
public protocol EntitlementProviding: AnyObject, Sendable {
    var currentStatus: EntitlementStatus { get }
    func refresh() async throws
    func offerings() async throws -> [PlusPackage]
    func purchase(_ package: PlusPackage) async throws -> EntitlementStatus
    func restore() async throws -> EntitlementStatus
    func logIn(appUserID: String) async throws
    func logOut() async throws
}
