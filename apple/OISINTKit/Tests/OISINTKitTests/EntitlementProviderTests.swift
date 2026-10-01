import Foundation
import Testing
@testable import OISINTKit
import OISINTKitDebugFixtures

@MainActor
@Suite struct EntitlementProviderTests {
    @Test func anonymousCannotPurchaseAndPermanentIdentityIsRequired() async throws {
        let provider = MockEntitlementProvider()
        let packages = try await provider.offerings()
        #expect(packages.map(\.id) == ["oisint_plus_monthly", "oisint_plus_annual"])
        await #expect(throws: EntitlementError.anonymousNotAllowed) {
            try await provider.purchase(packages[0])
        }
        await #expect(throws: EntitlementError.anonymousNotAllowed) {
            try await provider.logIn(appUserID: "not-a-uuid")
        }
    }

    @Test func accountSwitchAndLogoutClearEntitlementIdentity() async throws {
        let provider = MockEntitlementProvider()
        let firstUser = "00000000-0000-4000-8000-000000000571"
        let secondUser = "00000000-0000-4000-8000-000000000572"
        try await provider.logIn(appUserID: firstUser)
        let monthly = try await provider.offerings()[0]
        #expect(try await provider.purchase(monthly).isPlus)
        try await provider.logOut()
        #expect(provider.currentStatus.isPlus == false)
        #expect(provider.appUserID == nil)
        try await provider.logIn(appUserID: secondUser)
        #expect(provider.appUserID == secondUser)
    }

    @Test func permanentUserIDIsCanonicalizedBeforeRevenueCatIdentityUse() {
        let uppercase = "00000000-0000-4000-8000-0000000005AB"
        #expect(RevenueCatEntitlementProvider.canonicalPermanentUserID(uppercase) == uppercase.lowercased())
        #expect(RevenueCatEntitlementProvider.canonicalPermanentUserID("$RCAnonymousID:abc") == nil)
    }

    @Test func sdkActiveFlagDoesNotGrantWithoutFiniteFutureExpiry() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(
            RevenueCatEntitlementProvider.isVerifiedPlusStatus(
                isActive: true,
                productIdentifier: RevenueCatEntitlementProvider.monthlyProductIdentifier,
                expirationDate: now.addingTimeInterval(1),
                now: now
            )
        )
        #expect(
            !RevenueCatEntitlementProvider.isVerifiedPlusStatus(
                isActive: true,
                productIdentifier: RevenueCatEntitlementProvider.monthlyProductIdentifier,
                expirationDate: nil,
                now: now
            )
        )
        #expect(
            RevenueCatEntitlementProvider.isVerifiedPlusStatus(
                isActive: true,
                productIdentifier: RevenueCatEntitlementProvider.monthlyProductIdentifier,
                expirationDate: nil,
                gracePeriodExpiresAt: now.addingTimeInterval(1),
                now: now
            )
        )
        #expect(
            !RevenueCatEntitlementProvider.isVerifiedPlusStatus(
                isActive: true,
                productIdentifier: RevenueCatEntitlementProvider.monthlyProductIdentifier,
                expirationDate: nil,
                gracePeriodExpiresAt: now.addingTimeInterval(-1),
                now: now
            )
        )
        #expect(
            !RevenueCatEntitlementProvider.isVerifiedPlusStatus(
                isActive: true,
                productIdentifier: RevenueCatEntitlementProvider.monthlyProductIdentifier,
                expirationDate: now.addingTimeInterval(-1),
                now: now
            )
        )
        #expect(
            !RevenueCatEntitlementProvider.isVerifiedPlusStatus(
                isActive: true,
                productIdentifier: "oisint_plus_pro",
                expirationDate: now.addingTimeInterval(1),
                now: now
            )
        )
    }
}
