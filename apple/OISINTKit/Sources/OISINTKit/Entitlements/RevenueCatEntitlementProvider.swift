import Foundation
import RevenueCat

/// RevenueCat SDKとの接触面。恒久Supabase user idをlogInし、匿名購入を作らない。
@MainActor
public final class RevenueCatEntitlementProvider: EntitlementProviding {
    public static let plusEntitlementIdentifier = "plus"
    public static let defaultOfferingIdentifier = "default"
    public static let monthlyProductIdentifier = "oisint_plus_monthly"
    public static let annualProductIdentifier = "oisint_plus_annual"

    public private(set) var currentStatus = EntitlementStatus()
    private let apiKey: String
    private let fetchServerEntitlement: ServerEntitlementFetcher
    private var purchases: Purchases?
    private var packagesByProductIdentifier: [String: RevenueCat.Package] = [:]
    private var currentAppUserID: String?

    public init(
        apiKey: String,
        fetchServerEntitlement: @escaping ServerEntitlementFetcher = { _ in EntitlementStatus() }
    ) {
        self.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        self.fetchServerEntitlement = fetchServerEntitlement
    }

    public func refresh() async throws {
        guard let purchases, let appUserID = currentAppUserID else { throw EntitlementError.notConfigured }
        _ = try await purchases.customerInfo()
        do {
            currentStatus = try await verifiedServerStatus(for: appUserID)
        } catch {
            currentStatus = EntitlementStatus()
            throw error
        }
    }

    public func offerings() async throws -> [PlusPackage] {
        guard let purchases, currentAppUserID != nil else { throw EntitlementError.notConfigured }
        guard let current = try await purchases.offerings().current,
              current.identifier == Self.defaultOfferingIdentifier else {
            packagesByProductIdentifier = [:]
            return []
        }
        let packages = current.availablePackages.filter { package in
            Self.allowedProductIdentifiers.contains(package.storeProduct.productIdentifier)
        }
        packagesByProductIdentifier = Dictionary(uniqueKeysWithValues: packages.map { ($0.storeProduct.productIdentifier, $0) })
        return packages.map { package in
            PlusPackage(
                id: package.storeProduct.productIdentifier,
                displayName: package.storeProduct.localizedTitle,
                priceString: package.storeProduct.localizedPriceString,
                period: Self.periodLabel(package.storeProduct.subscriptionPeriod)
            )
        }
    }

    public func purchase(_ package: PlusPackage) async throws -> EntitlementStatus {
        guard let purchases else { throw EntitlementError.notConfigured }
        guard let appUserID = currentAppUserID, UUID(uuidString: appUserID) != nil else {
            throw EntitlementError.anonymousNotAllowed
        }
        guard let product = Self.allowedProductIdentifiers.first(where: { $0 == package.id }),
              let revenueCatPackage = packagesByProductIdentifier[product] else {
            throw EntitlementError.packageUnavailable
        }
        let result = try await purchases.purchase(package: revenueCatPackage)
        if result.userCancelled { throw EntitlementError.cancelled }
        let sdkStatus = status(from: result.customerInfo)
        do {
            let serverStatus = try await verifiedServerStatus(for: appUserID)
            currentStatus = serverStatus
            if !serverStatus.isPlus && sdkStatus.isPlus {
                throw EntitlementError.pending
            }
            return serverStatus
        } catch let error as EntitlementError {
            currentStatus = EntitlementStatus()
            throw error
        } catch {
            currentStatus = EntitlementStatus()
            throw EntitlementError.pending
        }
    }

    public func restore() async throws -> EntitlementStatus {
        guard let purchases, let appUserID = currentAppUserID else { throw EntitlementError.anonymousNotAllowed }
        let sdkStatus = status(from: try await purchases.restorePurchases())
        do {
            let serverStatus = try await verifiedServerStatus(for: appUserID)
            currentStatus = serverStatus
            if !serverStatus.isPlus && sdkStatus.isPlus {
                throw EntitlementError.pending
            }
            return serverStatus
        } catch let error as EntitlementError {
            currentStatus = EntitlementStatus()
            throw error
        } catch {
            currentStatus = EntitlementStatus()
            throw EntitlementError.pending
        }
    }

    public func logIn(appUserID: String) async throws {
        guard let canonicalAppUserID = Self.canonicalPermanentUserID(appUserID) else {
            throw EntitlementError.anonymousNotAllowed
        }
        guard !apiKey.isEmpty else { throw EntitlementError.notConfigured }
        let nextStatus: EntitlementStatus
        if let purchases {
            if currentAppUserID != canonicalAppUserID {
                let result = try await purchases.logIn(canonicalAppUserID)
                _ = result.customerInfo
                nextStatus = (try? await verifiedServerStatus(for: canonicalAppUserID)) ?? EntitlementStatus()
            } else {
                nextStatus = (try? await verifiedServerStatus(for: canonicalAppUserID)) ?? EntitlementStatus()
            }
        } else {
            // RevenueCat keeps its singleton configured after logOut(). Reuse it when
            // this provider was recreated instead of calling configure twice.
            let alreadyConfigured = Purchases.isConfigured
            let configured: Purchases
            if alreadyConfigured {
                configured = Purchases.shared
            } else {
                configured = Purchases.configure(withAPIKey: apiKey, appUserID: canonicalAppUserID)
            }
            purchases = configured
            if alreadyConfigured {
                let result = try await configured.logIn(canonicalAppUserID)
                _ = result.customerInfo
                nextStatus = (try? await verifiedServerStatus(for: canonicalAppUserID)) ?? EntitlementStatus()
            } else {
                _ = try await configured.customerInfo()
                nextStatus = (try? await verifiedServerStatus(for: canonicalAppUserID)) ?? EntitlementStatus()
            }
        }
        currentStatus = nextStatus
        currentAppUserID = canonicalAppUserID
    }

    public func logOut() async throws {
        defer {
            packagesByProductIdentifier = [:]
            currentAppUserID = nil
            currentStatus = EntitlementStatus()
        }
        if let purchases { _ = try await purchases.logOut() }
    }

    static func canonicalPermanentUserID(_ value: String) -> String? {
        UUID(uuidString: value)?.uuidString.lowercased()
    }

    private func status(from customerInfo: CustomerInfo) -> EntitlementStatus {
        guard let entitlement = customerInfo.entitlements[Self.plusEntitlementIdentifier],
              Self.allowedProductIdentifiers.contains(entitlement.productIdentifier) else {
            return EntitlementStatus()
        }
        let expirationDate = entitlement.expirationDate
        let gracePeriodExpiresAt = customerInfo
            .subscriptionsByProductIdentifier[entitlement.productIdentifier]?
            .gracePeriodExpiresDate
        return EntitlementStatus(
            isPlus: Self.isVerifiedPlusStatus(
                isActive: entitlement.isActive,
                productIdentifier: entitlement.productIdentifier,
                expirationDate: expirationDate,
                gracePeriodExpiresAt: gracePeriodExpiresAt
            ),
            willRenew: entitlement.willRenew,
            expiresAt: expirationDate,
            gracePeriodExpiresAt: gracePeriodExpiresAt,
            store: String(describing: entitlement.store),
            productIdentifier: entitlement.productIdentifier
        )
    }

    /// Serverのfinite expiry/graceと許可商品を再確認する。SDK状態はここを通らない限りUIへ出さない。
    private func verifiedServerStatus(for appUserID: String) async throws -> EntitlementStatus {
        let candidate = try await fetchServerEntitlement(appUserID)
        guard candidate.isPlus,
              let productIdentifier = candidate.productIdentifier,
              Self.allowedProductIdentifiers.contains(productIdentifier),
              candidate.lifecycleState == nil || ["active", "canceled", "grace", "billing_issue"].contains(candidate.lifecycleState!),
              Self.isVerifiedPlusStatus(
                  isActive: true,
                  productIdentifier: productIdentifier,
                  expirationDate: candidate.expiresAt,
                  gracePeriodExpiresAt: candidate.gracePeriodExpiresAt
              ) else {
            return EntitlementStatus()
        }
        return candidate
    }

    /// SDKのactive flagだけではPlusを表示しない。期限証明は必須である。
    static func isVerifiedPlusStatus(
        isActive: Bool,
        productIdentifier: String?,
        expirationDate: Date?,
        gracePeriodExpiresAt: Date? = nil,
        now: Date = Date()
    ) -> Bool {
        guard isActive,
              let productIdentifier,
              allowedProductIdentifiers.contains(productIdentifier) else {
            return false
        }
        let finiteFutureExpiration = expirationDate.map { $0.timeIntervalSince1970.isFinite && $0 > now } ?? false
        let finiteFutureGrace = gracePeriodExpiresAt.map { $0.timeIntervalSince1970.isFinite && $0 > now } ?? false
        return finiteFutureExpiration || finiteFutureGrace
    }

    private static let allowedProductIdentifiers: Set<String> = [monthlyProductIdentifier, annualProductIdentifier]

    private static func periodLabel(_ period: SubscriptionPeriod?) -> String {
        guard let period else { return String(localized: "サブスクリプション", bundle: .module) }
        let value = period.value
        switch period.unit {
        case .day: return value == 1 ? String(localized: "日ごと", bundle: .module) : String(localized: "\(value)日ごと", bundle: .module)
        case .week: return value == 1 ? String(localized: "週間ごと", bundle: .module) : String(localized: "\(value)週間ごと", bundle: .module)
        case .month: return value == 1 ? String(localized: "月ごと", bundle: .module) : String(localized: "\(value)か月ごと", bundle: .module)
        case .year: return value == 1 ? String(localized: "年ごと", bundle: .module) : String(localized: "\(value)年ごと", bundle: .module)
        @unknown default: return String(localized: "サブスクリプション", bundle: .module)
        }
    }
}
