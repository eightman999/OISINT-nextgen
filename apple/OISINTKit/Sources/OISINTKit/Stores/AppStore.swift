import Foundation
import Observation

/// 画面遷移先（Expo Router の /investigations/[id] と /i/[token] に対応）
public enum AppRoute: Hashable, Sendable {
    case investigation(id: String, shareToken: String?)
    case join(token: String)
    case account
}

/// Web AuthProvider と同じ signed-out/anonymous/authenticated の状態機械。
public enum AuthStatus: String, Sendable, Equatable {
    case loading
    #if DEBUG
    case mock
    #endif
    case signedOut = "signed_out"
    case anonymous
    case authenticated
    case disabled
    case error
}

/// 端末ローカルの閲覧履歴 1 件（計画書 §3.6-3。spec.md §33 に従い raw_query や他人の情報は保存しない）
public struct InvestigationHistoryEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: String { investigationId }
    public var investigationId: String
    public var shareToken: String?
    public var title: String
    public var updatedAt: String

    public init(investigationId: String, shareToken: String?, title: String, updatedAt: String) {
        self.investigationId = investigationId
        self.shareToken = shareToken
        self.title = title
        self.updatedAt = updatedAt
    }
}

/// アプリ全体の状態（provider / 認証 / ローカル履歴 / ナビゲーション）。
/// AuthProvider.tsx の userId / displayName 管理を移植。
@MainActor
@Observable
public final class AppStore {
    public let provider: any DataProvider
    public let mode: DataProviderMode
    public let entitlementProvider: any EntitlementProviding
    public private(set) var userId: String?
    public private(set) var authStatus: AuthStatus
    public private(set) var authEmail: String?
    public private(set) var authAvatarURL: String?
    public private(set) var authErrorMessage: String?
    public private(set) var authNoticeMessage: String?
    /// Authは成功していても課金SDK同期に失敗し得るため、認証エラーと分離する。
    public private(set) var entitlementErrorMessage: String?
    public private(set) var providerErrorMessage: String?
    public private(set) var authBusy = false
    /// AuthProvider.tsx: trim() して空なら null
    public private(set) var displayName: String?
    public private(set) var history: [InvestigationHistoryEntry] = []
    public var path: [AppRoute] = []

    private let defaults: UserDefaults
    private let authService: (any AuthProviding)?
    private static let historyLimit = 20
    private var authGeneration: UInt64 = 0

    public init(
        provider: any DataProvider,
        mode: DataProviderMode,
        entitlementProvider: any EntitlementProviding = UnavailableEntitlementProvider(),
        defaults: UserDefaults = .standard,
        authService: (any AuthProviding)? = nil,
        providerErrorMessage: String? = nil
    ) {
        self.provider = provider
        self.mode = mode
        self.entitlementProvider = entitlementProvider
        self.defaults = defaults
        self.authService = authService
        self.providerErrorMessage = providerErrorMessage
        #if DEBUG
        self.authStatus = authService == nil ? (mode == .mock ? .mock : .disabled) : .loading
        #else
        self.authStatus = authService == nil ? .disabled : .loading
        #endif
        self.authEmail = nil
        self.authAvatarURL = nil
        self.authErrorMessage = nil
        self.entitlementErrorMessage = nil
        // 旧globalキーは別subjectへ帰属させない。所有者を証明できない端末履歴を
        // 起動時に破棄し、正規subject確定後に専用キーだけ読む。
        defaults.removeObject(forKey: Self.legacyHistoryKey)
        defaults.removeObject(forKey: Self.legacyDisplayNameKey)
        self.displayName = nil
        self.history = []
    }

    /// 起動時に userId を確定（mock は即時、live は匿名サインイン。失敗の詳細は UI へ漏らさない = AuthProvider.tsx と同じ）
    public func bootstrap() async {
        let generation = beginIdentityTransition()
        authBusy = true
        defer { if isCurrent(generation) { authBusy = false } }
        do {
            let bootstrapUserID = try await provider.getUserId()
            guard isCurrent(generation) else { return }
            userId = bootstrapUserID
            #if DEBUG
            if mode == .mock {
                authStatus = .mock
                loadSubjectLocalState()
                return
            }
            #endif
            guard mode == .live else {
                authStatus = .disabled
                return
            }
            guard let authService else {
                authStatus = .disabled
                return
            }
            let state = await authService.currentState()
            try await synchronizeAuth(state, logInToEntitlement: true, generation: generation)
        } catch {
            guard isCurrent(generation) else { return }
            await failClosedAuth(String(localized: "認証状態を確認できませんでした。時間をおいて再度お試しください。", bundle: .module))
        }
    }

    public var isAnonymous: Bool { authStatus == .anonymous }
    public var isAuthenticated: Bool { authStatus == .authenticated }

    /// 購入・復元・商品取得は恒久アカウントの課金SDK同期が完了してから許可する。
    public var entitlementUserID: String? {
        isAuthenticated && !authBusy && entitlementErrorMessage == nil ? userId : nil
    }

    public func signInWithGoogle() async {
        guard mode == .live, let authService else {
            authErrorMessage = String(localized: "GoogleログインはSupabaseの本番設定後に利用できます。", bundle: .module)
            return
        }
        let previousState = currentAuthSessionState()
        let generation = beginIdentityTransition()
        authBusy = true
        authErrorMessage = nil
        do {
            let state = try await authService.signInWithGoogle()
            try await synchronizeAuth(state, logInToEntitlement: true, generation: generation)
        } catch {
            guard isCurrent(generation) else { return }
            applyAuthState(previousState)
            authErrorMessage = String(localized: "Googleログインを開始できませんでした。設定を確認して再度お試しください。", bundle: .module)
        }
        if isCurrent(generation) { authBusy = false }
    }

    public func signInWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Bool = false
    ) async {
        guard mode == .live, let authService else {
            authErrorMessage = String(localized: "メールログインはSupabaseの本番設定後に利用できます。", bundle: .module)
            return
        }
        let previousState = currentAuthSessionState()
        let generation = beginIdentityTransition()
        authBusy = true
        authErrorMessage = nil
        do {
            let state = try await authService.signInWithEmail(
                email: email,
                password: password,
                confirmAccountSwitch: confirmAccountSwitch
            )
            try await synchronizeAuth(state, logInToEntitlement: true, generation: generation)
        } catch is AuthSwitchConfirmationRequired {
            guard isCurrent(generation) else { return }
            applyAuthState(previousState)
            authErrorMessage = String(localized: "別のアカウントへ切り替える場合は、確認欄にチェックしてください。", bundle: .module)
        } catch {
            guard isCurrent(generation) else { return }
            let message = (error as? EmailLoginFailure)?.localizedDescription
                ?? String(localized: "ログインを完了できませんでした。通信状態を確認して再度お試しください。", bundle: .module)
            if previousState.userId != nil {
                applyAuthState(previousState)
                authErrorMessage = message
            } else {
                await failClosedAuth(message)
            }
        }
        if isCurrent(generation) { authBusy = false }
    }

    @discardableResult
    public func signUpWithEmail(email: String, password: String, confirmAccountSwitch: Bool = false) async -> Bool {
        guard !authBusy, !isAuthenticated else { return false }
        guard mode == .live, let authService else {
            authErrorMessage = String(localized: "新規登録はSupabaseの本番設定後に利用できます。", bundle: .module)
            return false
        }
        let generation = authGeneration
        authBusy = true
        authErrorMessage = nil
        authNoticeMessage = nil
        defer { if isCurrent(generation) { authBusy = false } }
        do {
            try await authService.signUpWithEmail(
                email: email, password: password, confirmAccountSwitch: confirmAccountSwitch
            )
            guard isCurrent(generation) else { return false }
            authNoticeMessage = String(localized: "確認メールを送信しました。メール内のリンクを開き、確認後にこの画面でログインしてください。届かない場合は迷惑メールも確認してください。登録済みの場合はログインしてください。", bundle: .module)
            return true
        } catch is AuthSwitchConfirmationRequired {
            guard isCurrent(generation) else { return false }
            authErrorMessage = String(localized: "別のアカウントを作成する場合は、確認欄にチェックしてください。", bundle: .module)
        } catch is EmailConfirmationUnavailable {
            guard isCurrent(generation) else { return false }
            await failClosedAuth(String(localized: "メール確認の設定を確認できないため、新規登録を完了できませんでした。サポートへお問い合わせください。", bundle: .module))
        } catch {
            guard isCurrent(generation) else { return false }
            authErrorMessage = String(localized: "登録を受け付けられませんでした。入力内容と通信状態を確認してください。登録済みの場合はログインし、再送する場合は時間をおいてお試しください。", bundle: .module)
        }
        return false
    }

    public func resendSignUpConfirmation(email: String) async {
        guard !authBusy, !isAuthenticated, mode == .live, let authService else { return }
        let generation = authGeneration
        authBusy = true
        authErrorMessage = nil
        authNoticeMessage = nil
        defer { if isCurrent(generation) { authBusy = false } }
        do {
            try await authService.resendSignUpConfirmation(email: email)
            guard isCurrent(generation) else { return }
            authNoticeMessage = String(localized: "確認待ちのアカウントがある場合は確認メールを再送しました。メール内のリンクを開いてください。", bundle: .module)
        } catch {
            guard isCurrent(generation) else { return }
            authErrorMessage = String(localized: "確認メールを再送できませんでした。時間をおいて再度お試しください。", bundle: .module)
        }
    }

    public func signOut() async {
        guard mode == .live, let authService else {
            #if DEBUG
            authStatus = mode == .mock ? .mock : .disabled
            #else
            authStatus = .disabled
            #endif
            try? await entitlementProvider.logOut()
            return
        }
        let generation = beginIdentityTransition()
        authBusy = true
        authErrorMessage = nil
        do {
            let state = try await authService.signOut()
            guard isCurrent(generation) else { return }
            applyAuthState(state)
            do {
                try await entitlementProvider.logOut()
                entitlementErrorMessage = nil
            } catch {
                // Authのlogout成功は維持し、課金SDKの失敗だけを別状態にする。
                entitlementErrorMessage = String(localized: "Plusの状態を解除できません。次回起動時に再試行します。", bundle: .module)
            }
        } catch {
            guard isCurrent(generation) else { return }
            await failClosedAuth(String(localized: "ログアウトできませんでした。通信状態を確認して再度お試しください。", bundle: .module))
        }
        if isCurrent(generation) { authBusy = false }
    }

    public func deleteAccount() async {
        guard mode == .live, let authService, userId != nil else {
            authErrorMessage = String(localized: "アカウント削除には認証が必要です。", bundle: .module)
            return
        }
        let deletedUserId = userId
        let generation = beginIdentityTransition()
        authBusy = true
        do {
            let state = try await authService.deleteAccount()
            guard isCurrent(generation) else { return }
            applyAuthState(state)
            if state.localSessionCleanupFailed {
                authErrorMessage = String(localized: "サーバー上のアカウントを削除しましたが、端末セッションの破棄に失敗しました。アプリを再起動して再確認してください。", bundle: .module)
            }
            if let deletedUserId { purgeLocalState(for: deletedUserId) }
            try? await entitlementProvider.logOut()
            entitlementErrorMessage = nil
        } catch {
            guard isCurrent(generation) else { return }
            await failClosedAuth(String(localized: "アカウントを削除できませんでした。通信状態を確認して再度お試しください。", bundle: .module))
        }
        if isCurrent(generation) { authBusy = false }
    }

    public func handleOpenURL(_ url: URL) async {
        guard DeepLink.isAuthCallback(url), let authService else { return }
        let generation = beginIdentityTransition()
        authBusy = true
        defer { if isCurrent(generation) { authBusy = false } }
        do {
            let state = try await authService.handleOAuthCallback(url)
            try await synchronizeAuth(state, logInToEntitlement: true, generation: generation)
        } catch {
            guard isCurrent(generation) else { return }
            await failClosedAuth(String(localized: "認証リンクを確認できませんでした。確認メールを再送するか、再度ログインしてください。", bundle: .module))
        }
    }

    private func synchronizeAuth(
        _ state: AuthSessionState,
        logInToEntitlement: Bool,
        generation: UInt64? = nil
    ) async throws {
        if let generation, !isCurrent(generation) { return }
        applyAuthState(state)
        guard logInToEntitlement, mode == .live else { return }
        guard state.isAuthenticated, let userId = state.userId else {
            try? await entitlementProvider.logOut()
            entitlementErrorMessage = nil
            return
        }
        do {
            try await entitlementProvider.logIn(appUserID: userId)
            if let generation, !isCurrent(generation) {
                try? await entitlementProvider.logOut()
                return
            }
            entitlementErrorMessage = nil
        } catch {
            // Supabase Authの確定状態は維持し、課金だけFree/fail-closedへ倒す。
            // このエラーを上位へthrowするとログイン成功を「パスワード不正」と誤表示する。
            try? await entitlementProvider.logOut()
            entitlementErrorMessage = String(localized: "Plusの状態を確認できません。無料プランとして継続します。", bundle: .module)
        }
    }

    private func applyAuthState(_ state: AuthSessionState) {
        switch state.status {
        case .signedOut:
            userId = nil
            authStatus = .signedOut
            authEmail = nil
            authAvatarURL = nil
            displayName = nil
            history = []
        case .anonymous:
            userId = state.userId
            authStatus = .anonymous
            authEmail = nil
            authAvatarURL = nil
            // displayName はアカウントプロフィールであり、端末履歴とは別物。
            // subject切替時に前アカウントの表示名を残さない。
            displayName = state.displayName
            loadSubjectLocalState()
        case .authenticated:
            userId = state.userId
            authStatus = .authenticated
            authEmail = state.email
            authAvatarURL = state.avatarURL
            // 同一subject内のローカル編集は setDisplayName が保持するが、
            // 認証状態の再適用では新subjectのprofileを正本として明示的に反映する。
            displayName = state.displayName
            loadSubjectLocalState()
        }
    }

    public func setDisplayName(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        displayName = trimmed.isEmpty ? nil : trimmed
        guard let key = subjectKey else { return }
        defaults.set(displayName, forKey: Self.displayNameKey(for: key))
    }

    /// subject切替中は旧プロフィールと課金状態をrender前に隠す。
    private func beginIdentityTransition() -> UInt64 {
        authGeneration &+= 1
        userId = nil
        authStatus = .loading
        authEmail = nil
        authAvatarURL = nil
        authErrorMessage = nil
        authNoticeMessage = nil
        entitlementErrorMessage = nil
        displayName = nil
        history = []
        return authGeneration
    }

    private func isCurrent(_ generation: UInt64) -> Bool {
        authGeneration == generation
    }

    private func currentAuthSessionState() -> AuthSessionState {
        let status: AuthSessionStatus
        switch authStatus {
        case .anonymous:
            status = .anonymous
        case .authenticated:
            status = .authenticated
        default:
            status = .signedOut
        }
        return AuthSessionState(
            status: status,
            userId: userId,
            email: authEmail,
            displayName: displayName,
            avatarURL: authAvatarURL
        )
    }

    private func failClosedAuth(_ message: String) async {
        userId = nil
        authStatus = .error
        authEmail = nil
        authAvatarURL = nil
        displayName = nil
        history = []
        authErrorMessage = message
        entitlementErrorMessage = nil
        try? await entitlementProvider.logOut()
    }

    // MARK: - subject-bound ローカル履歴（旧globalキーはquarantineして読まない）

    private var subjectKey: String? {
        #if DEBUG
        if mode == .mock && userId == nil { return "mock-local" }
        #endif
        guard let userId, !userId.isEmpty else { return nil }
        #if DEBUG
        guard [.mock, .anonymous, .authenticated].contains(authStatus) else { return nil }
        #else
        guard [.anonymous, .authenticated].contains(authStatus) else { return nil }
        #endif
        return userId.lowercased()
    }

    private static func historyKey(for subject: String) -> String {
        "oisint.history.subject.\(subject)"
    }

    private static func displayNameKey(for subject: String) -> String {
        "oisint.displayName.subject.\(subject)"
    }

    private static let legacyHistoryKey = "oisint.history"
    private static let legacyDisplayNameKey = "oisint.displayName"

    private func loadSubjectLocalState() {
        let serverDisplayName = displayName
        guard let key = subjectKey else {
            history = []
            displayName = nil
            return
        }
        guard let data = defaults.data(forKey: Self.historyKey(for: key)),
              let entries = try? JSONDecoder().decode([InvestigationHistoryEntry].self, from: data)
        else {
            history = []
            displayName = defaults.string(forKey: Self.displayNameKey(for: key))
                .flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
                ?? serverDisplayName
            return
        }
        history = entries
        displayName = defaults.string(forKey: Self.displayNameKey(for: key))
            .flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
            ?? serverDisplayName
    }

    public func recordHistory(_ entry: InvestigationHistoryEntry) {
        guard let key = subjectKey else {
            history = []
            return
        }
        var next = history.filter { $0.investigationId != entry.investigationId }
        next.insert(entry, at: 0)
        if next.count > Self.historyLimit {
            next = Array(next.prefix(Self.historyLimit))
        }
        history = next
        if let data = try? JSONEncoder().encode(next) {
            defaults.set(data, forKey: Self.historyKey(for: key))
        }
    }

    /// 永久削除成功時だけ対象subjectの端末履歴・表示名を消す。旧globalキーも
    /// 旧subjectへ安全に帰属できないため、同時に破棄する。
    public func purgeLocalState(for userId: String) {
        let key = userId.lowercased()
        defaults.removeObject(forKey: Self.historyKey(for: key))
        defaults.removeObject(forKey: Self.displayNameKey(for: key))
        defaults.removeObject(forKey: Self.legacyHistoryKey)
        defaults.removeObject(forKey: Self.legacyDisplayNameKey)
        if subjectKey == key {
            history = []
            displayName = nil
        }
    }

    // MARK: - ナビゲーション

    public func openInvestigation(id: String, shareToken: String?) {
        path.append(.investigation(id: id, shareToken: shareToken))
    }
}
