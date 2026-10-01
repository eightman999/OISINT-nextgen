import Foundation
import Testing
@testable import OISINTKit
import OISINTKitDebugFixtures

private actor AuthStateFixture: AuthProviding {
    let authenticated = AuthSessionState(
        status: .authenticated,
        userId: "00000000-0000-4000-8000-000000000571",
        email: "user@example.com"
    )

    func ensureUserId() async throws -> String { authenticated.userId! }
    func currentState() async -> AuthSessionState { authenticated }
    func signInWithGoogle() async throws -> AuthSessionState { authenticated }
    func signInWithEmail(email: String, password: String, confirmAccountSwitch: Bool) async throws -> AuthSessionState { authenticated }
    func signUpWithEmail(email: String, password: String, confirmAccountSwitch: Bool) async throws {}
    func resendSignUpConfirmation(email: String) async throws {}
    func signOut() async throws -> AuthSessionState { .signedOut }
    func deleteAccount() async throws -> AuthSessionState { .signedOut }
    func handleOAuthCallback(_ url: URL) async throws -> AuthSessionState { authenticated }
}

private actor FailingGoogleAuthFixture: AuthProviding {
    let anonymous = AuthSessionState(
        status: .anonymous,
        userId: "00000000-0000-4000-8000-000000000579"
    )

    func ensureUserId() async throws -> String { anonymous.userId! }
    func currentState() async -> AuthSessionState { anonymous }
    func signInWithGoogle() async throws -> AuthSessionState {
        throw OISINTError("identity collision")
    }
    func signInWithEmail(email: String, password: String, confirmAccountSwitch: Bool) async throws -> AuthSessionState { anonymous }
    func signUpWithEmail(email: String, password: String, confirmAccountSwitch: Bool) async throws {}
    func resendSignUpConfirmation(email: String) async throws {}
    func signOut() async throws -> AuthSessionState { .signedOut }
    func deleteAccount() async throws -> AuthSessionState { .signedOut }
    func handleOAuthCallback(_ url: URL) async throws -> AuthSessionState { anonymous }
}

private actor SwitchingAuthStateFixture: AuthProviding {
    private var state: AuthSessionState

    init(state: AuthSessionState) {
        self.state = state
    }

    func setState(_ next: AuthSessionState) {
        state = next
    }

    func ensureUserId() async throws -> String { state.userId! }
    func currentState() async -> AuthSessionState { state }
    func signInWithGoogle() async throws -> AuthSessionState { state }
    func signInWithEmail(email: String, password: String, confirmAccountSwitch: Bool) async throws -> AuthSessionState { state }
    func signUpWithEmail(email: String, password: String, confirmAccountSwitch: Bool) async throws {}
    func resendSignUpConfirmation(email: String) async throws {}
    func signOut() async throws -> AuthSessionState { .signedOut }
    func deleteAccount() async throws -> AuthSessionState { .signedOut }
    func handleOAuthCallback(_ url: URL) async throws -> AuthSessionState { state }
}

private actor EmailSignUpFixture: AuthProviding {
    let initial: AuthSessionState
    let failure: Bool
    let loginFailure: EmailLoginFailure?
    init(initial: AuthSessionState = .signedOut, failure: Bool = false, loginFailure: EmailLoginFailure? = nil) {
        self.initial = initial
        self.failure = failure
        self.loginFailure = loginFailure
    }
    func ensureUserId() async throws -> String { initial.userId ?? "unused" }
    func currentState() async -> AuthSessionState { initial }
    func signInWithGoogle() async throws -> AuthSessionState { initial }
    func signInWithEmail(email: String, password: String, confirmAccountSwitch: Bool) async throws -> AuthSessionState {
        if let loginFailure { throw loginFailure }
        return initial
    }
    func signUpWithEmail(email: String, password: String, confirmAccountSwitch: Bool) async throws {
        if initial.userId != nil && !confirmAccountSwitch { throw AuthSwitchConfirmationRequired() }
        if failure { throw OISINTError("provider detail must not reach UI") }
    }
    func resendSignUpConfirmation(email: String) async throws {
        if failure { throw OISINTError("provider detail must not reach UI") }
    }
    func signOut() async throws -> AuthSessionState { .signedOut }
    func deleteAccount() async throws -> AuthSessionState { .signedOut }
    func handleOAuthCallback(_ url: URL) async throws -> AuthSessionState {
        AuthSessionState(status: .authenticated, userId: "00000000-0000-4000-8000-000000000585")
    }
}

@MainActor
private final class FailingEntitlementFixture: EntitlementProviding {
    var currentStatus = EntitlementStatus()

    func refresh() async throws {}
    func offerings() async throws -> [PlusPackage] { [] }
    func purchase(_ package: PlusPackage) async throws -> EntitlementStatus { throw EntitlementError.message("fixture") }
    func restore() async throws -> EntitlementStatus { currentStatus }
    func logIn(appUserID: String) async throws { throw EntitlementError.message("SDK unavailable") }
    func logOut() async throws { currentStatus = EntitlementStatus() }
}

@MainActor
private final class DelayedEntitlementFixture: EntitlementProviding {
    var currentStatus = EntitlementStatus()
    var failOfferings = false
    private(set) var loggedIn = false
    private var loginStarted = false
    private var startWaiter: CheckedContinuation<Void, Never>?
    private var finishLogin: CheckedContinuation<Void, Never>?

    func waitForLogin() async {
        if loginStarted { return }
        await withCheckedContinuation { startWaiter = $0 }
    }

    func completeLogin() { finishLogin?.resume(); finishLogin = nil }
    func logIn(appUserID: String) async throws {
        await withCheckedContinuation { continuation in
            finishLogin = continuation
            loginStarted = true
            startWaiter?.resume()
            startWaiter = nil
        }
        loggedIn = true
    }
    func logOut() async throws { loggedIn = false }
    func refresh() async throws {}
    func offerings() async throws -> [PlusPackage] {
        guard loggedIn else { throw EntitlementError.notConfigured }
        if failOfferings { throw EntitlementError.message("fixture failure") }
        return []
    }
    func purchase(_ package: PlusPackage) async throws -> EntitlementStatus { currentStatus }
    func restore() async throws -> EntitlementStatus {
        guard loggedIn else { throw EntitlementError.notConfigured }
        return currentStatus
    }
}

@MainActor
@Suite struct AppStoreAuthTests {
    @Test func bootstrapWaitsForBillingLoginBeforeEnablingPaywall() async throws {
        let billing = DelayedEntitlementFixture()
        let app = AppStore(
            provider: MockProvider(), mode: .live, entitlementProvider: billing,
            defaults: UserDefaults(suiteName: "billing-bootstrap-\(UUID().uuidString)")!,
            authService: AuthStateFixture()
        )
        let bootstrap = Task { await app.bootstrap() }
        await billing.waitForLogin()
        #expect(app.isAuthenticated)
        #expect(app.authBusy)
        #expect(app.entitlementUserID == nil)
        billing.completeLogin()
        await bootstrap.value
        #expect(!app.authBusy)
        #expect(app.entitlementUserID == app.userId)
        #expect(app.entitlementUserID != nil)

        // 課金SDKが同期済みなら、商品一覧が空でも失敗しても復元の資格を失わない。
        #expect(try await billing.offerings().isEmpty)
        #expect(app.entitlementUserID != nil)
        _ = try await billing.restore()
        billing.failOfferings = true
        await #expect(throws: EntitlementError.self) { try await billing.offerings() }
        #expect(app.entitlementUserID != nil)
        _ = try await billing.restore()
    }

    @Test func delayedBootstrapCannotReenableBillingAfterSignOut() async {
        let billing = DelayedEntitlementFixture()
        let app = AppStore(
            provider: MockProvider(), mode: .live, entitlementProvider: billing,
            defaults: UserDefaults(suiteName: "billing-signout-\(UUID().uuidString)")!,
            authService: AuthStateFixture()
        )
        let bootstrap = Task { await app.bootstrap() }
        await billing.waitForLogin()
        await app.signOut()
        billing.completeLogin()
        await bootstrap.value
        #expect(app.authStatus == .signedOut)
        #expect(!app.authBusy)
        #expect(app.entitlementUserID == nil)
        #expect(!billing.loggedIn)
    }

    @Test func loginErrorsAreNotAllReportedAsIncorrectPassword() async {
        for failure in [EmailLoginFailure.unconfirmed, .unavailable, .rateLimited, .invalidCredentials] {
            let app = AppStore(
                provider: MockProvider(), mode: .live,
                defaults: UserDefaults(suiteName: "login-error-\(UUID().uuidString)")!,
                authService: EmailSignUpFixture(loginFailure: failure)
            )
            await app.signInWithEmail(email: "user@example.com", password: "fixture")
            #expect(app.authErrorMessage == failure.localizedDescription)
            #expect(!app.isAuthenticated)
            #expect(!app.authBusy)
        }
    }

    @Test func signUpWaitsForConfirmationAndKeepsAnonymousHistory() async {
        let subject = "00000000-0000-4000-8000-000000000586"
        let app = AppStore(
            provider: MockProvider(), mode: .live,
            defaults: UserDefaults(suiteName: "signup-\(UUID().uuidString)")!,
            authService: EmailSignUpFixture(initial: AuthSessionState(status: .anonymous, userId: subject))
        )
        await app.bootstrap()
        app.recordHistory(.init(investigationId: "owned", shareToken: nil, title: "own", updatedAt: "2026-09-22"))
        let rejected = await app.signUpWithEmail(email: "user@example.com", password: "ExamplePass123")
        #expect(!rejected)
        #expect(app.authErrorMessage?.contains("確認欄") == true)
        #expect(app.userId == subject)

        let accepted = await app.signUpWithEmail(email: "user@example.com", password: "ExamplePass123", confirmAccountSwitch: true)
        #expect(accepted)
        #expect(app.authStatus == .anonymous)
        #expect(app.userId == subject)
        #expect(app.history.map(\.investigationId) == ["owned"])
        #expect(app.authNoticeMessage != nil)
        #expect(app.authErrorMessage == nil)
        #expect(!app.authBusy)
        #expect(!app.entitlementProvider.currentStatus.isPlus)

        await app.handleOpenURL(URL(string: "oisint://account?code=fixture")!)
        #expect(app.isAuthenticated)
        #expect(app.history.isEmpty)
        #expect(app.authNoticeMessage == nil)
        #expect(!app.authBusy)
    }

    @Test func failedSignUpAndResendDoNotExposeProviderDetailsOrGrantAccess() async {
        let app = AppStore(
            provider: MockProvider(), mode: .live,
            defaults: UserDefaults(suiteName: "signup-failure-\(UUID().uuidString)")!,
            authService: EmailSignUpFixture(failure: true)
        )
        await app.bootstrap()
        let accepted = await app.signUpWithEmail(email: "user@example.com", password: "ExamplePass123")
        #expect(!accepted)
        #expect(app.authStatus == .signedOut)
        #expect(app.authNoticeMessage == nil)
        #expect(app.authErrorMessage?.contains("provider detail") == false)
        #expect(!app.authBusy)
        await app.resendSignUpConfirmation(email: "user@example.com")
        #expect(app.authErrorMessage?.contains("再送できません") == true)
        #expect(app.authNoticeMessage == nil)
        #expect(!app.isAuthenticated)
        #expect(!app.authBusy)
    }

    @Test func signUpValidationMatchesPasswordPolicy() {
        #expect(EmailRegistrationValidation.message(email: " user@example.com ", password: "ExamplePass123", confirmation: "ExamplePass123") == nil)
        for email in ["", "user", "user@", "user @example.com", "user@@example.com"] {
            #expect(EmailRegistrationValidation.message(email: email, password: "ExamplePass123", confirmation: "ExamplePass123") != nil)
        }
        for password in ["shortA1", "alllowercase123", "ALLUPPERCASE123", "MissingDigitsOnly"] {
            #expect(EmailRegistrationValidation.message(email: "user@example.com", password: password, confirmation: password) != nil)
        }
        #expect(EmailRegistrationValidation.message(email: "user@example.com", password: "ExamplePass123", confirmation: "DifferentPass123")?.contains("一致しません") == true)
    }

    @Test func googleLinkFailureKeepsAnonymousOwner() async {
        let defaults = UserDefaults(suiteName: "auth-failure-(UUID().uuidString)")!
        let originalUserId = "00000000-0000-4000-8000-000000000579"
        let app = AppStore(
            provider: MockProvider(),
            mode: .live,
            defaults: defaults,
            authService: FailingGoogleAuthFixture()
        )

        await app.bootstrap()
        await app.signInWithGoogle()

        #expect(app.authStatus == .anonymous)
        #expect(app.userId == originalUserId)
        #expect(app.authErrorMessage != nil)
        #expect(app.authErrorMessage?.isEmpty == false)
    }

    @Test func switchingPermanentIdentityClearsOldProfileDisplayName() async {
        let defaults = UserDefaults(suiteName: "auth-switch-(UUID().uuidString)")!
        let fixture = SwitchingAuthStateFixture(
            state: AuthSessionState(
                status: .authenticated,
                userId: "00000000-0000-4000-8000-000000000580",
                email: "a@example.com",
                displayName: "A profile"
            )
        )
        let app = AppStore(
            provider: MockProvider(),
            mode: .live,
            defaults: defaults,
            authService: fixture
        )

        await app.bootstrap()
        #expect(app.displayName == "A profile")

        await fixture.setState(
            AuthSessionState(
                status: .authenticated,
                userId: "00000000-0000-4000-8000-000000000581",
                email: "b@example.com"
            )
        )
        await app.bootstrap()

        #expect(app.userId == "00000000-0000-4000-8000-000000000581")
        #expect(app.displayName == nil)
    }

    @Test func entitlementSyncFailureDoesNotDemoteSuccessfulAuth() async {
        let defaults = UserDefaults(suiteName: "auth-(UUID().uuidString)")!
        let app = AppStore(
            provider: MockProvider(),
            mode: .live,
            entitlementProvider: FailingEntitlementFixture(),
            defaults: defaults,
            authService: AuthStateFixture()
        )

        await app.signInWithEmail(email: "user@example.com", password: "password")

        #expect(app.authStatus == .authenticated)
        #expect(app.userId == "00000000-0000-4000-8000-000000000571")
        #expect(app.authErrorMessage == nil)
        #expect(app.entitlementErrorMessage != nil)
        #expect(app.entitlementUserID == nil)
        #expect(app.entitlementProvider.currentStatus.isPlus == false)
    }

    @Test func localHistoryIsBoundToSubjectAndSameUuidLinkOnly() async {
        let defaults = UserDefaults(suiteName: "history-switch-(UUID().uuidString)")!
        let first = "00000000-0000-4000-8000-000000000582"
        let second = "00000000-0000-4000-8000-000000000583"
        let fixture = SwitchingAuthStateFixture(
            state: AuthSessionState(status: .anonymous, userId: first)
        )
        let app = AppStore(
            provider: MockProvider(),
            mode: .live,
            defaults: defaults,
            authService: fixture
        )
        await app.bootstrap()
        app.recordHistory(InvestigationHistoryEntry(
            investigationId: "private-a",
            shareToken: "token-a",
            title: "Aのみ",
            updatedAt: "2026-08-24T00:00:00Z"
        ))
        #expect(app.history.count == 1)

        await fixture.setState(AuthSessionState(status: .authenticated, userId: second))
        await app.bootstrap()
        #expect(app.history.isEmpty)
        #expect(app.displayName == nil)

        // 別UUIDへ旧local同意/履歴を帰属させず、同一UUIDの匿名→恒久だけ復元する。
        await fixture.setState(AuthSessionState(status: .authenticated, userId: first))
        await app.bootstrap()
        #expect(app.history.map(\.investigationId) == ["private-a"])
    }

    @Test func legacyUnscopedHistoryIsNotAutoAttributed() async {
        let defaults = UserDefaults(suiteName: "history-legacy-(UUID().uuidString)")!
        let legacy = [InvestigationHistoryEntry(
            investigationId: "legacy-private",
            shareToken: "legacy-token",
            title: "旧端末",
            updatedAt: "2026-08-24T00:00:00Z"
        )]
        if let data = try? JSONEncoder().encode(legacy) {
            defaults.set(data, forKey: "oisint.history")
        }
        let fixture = SwitchingAuthStateFixture(state: AuthSessionState(
            status: .authenticated,
            userId: "00000000-0000-4000-8000-000000000584"
        ))
        let app = AppStore(provider: MockProvider(), mode: .live, defaults: defaults, authService: fixture)
        await app.bootstrap()
        #expect(app.history.isEmpty)
        #expect(defaults.data(forKey: "oisint.history") == nil)
    }
}
