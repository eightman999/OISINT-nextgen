import Foundation
import Supabase

/// AppStore が監視する Supabase 認証状態。
public enum AuthSessionStatus: String, Sendable, Equatable {
    case signedOut
    case anonymous
    case authenticated
}

/// Supabase の User / Session を UI が扱う値型へ変換したもの。
public struct AuthSessionState: Sendable, Equatable {
    public let status: AuthSessionStatus
    public let userId: String?
    public let email: String?
    public let displayName: String?
    public let avatarURL: String?
    /// server削除後のlocal-only session purge失敗をUIへ明示する。
    public let localSessionCleanupFailed: Bool

    public var isAnonymous: Bool { status == .anonymous }
    public var isAuthenticated: Bool { status == .authenticated }

    public init(
        status: AuthSessionStatus,
        userId: String? = nil,
        email: String? = nil,
        displayName: String? = nil,
        avatarURL: String? = nil,
        localSessionCleanupFailed: Bool = false
    ) {
        self.status = status
        self.userId = userId
        self.email = email
        self.displayName = displayName
        self.avatarURL = avatarURL
        self.localSessionCleanupFailed = localSessionCleanupFailed
    }

    public static let signedOut = AuthSessionState(status: .signedOut)
}

/// Supabase 型を UI/課金境界の外へ出さない認証契約。
public protocol AuthProviding: Sendable {
    func ensureUserId() async throws -> String
    func currentState() async -> AuthSessionState
    func signInWithGoogle() async throws -> AuthSessionState
    func signInWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Bool
    ) async throws -> AuthSessionState
    func signUpWithEmail(email: String, password: String, confirmAccountSwitch: Bool) async throws
    func resendSignUpConfirmation(email: String) async throws
    func signOut() async throws -> AuthSessionState
    func deleteAccount() async throws -> AuthSessionState
    func handleOAuthCallback(_ url: URL) async throws -> AuthSessionState
}

/// 既存の認証subjectを別の恒久アカウントへ切り替えるときの明示確認。
public struct AuthSwitchConfirmationRequired: Error, Sendable, Equatable {
    public init() {}
}

/// 確認なしでsessionを返すサーバー設定では、新規登録をログイン成功扱いにしない。
public struct EmailConfirmationUnavailable: Error, Sendable {
    public init() {}
}

public enum EmailLoginFailure: Error, LocalizedError, Sendable, Equatable {
    case unconfirmed, invalidCredentials, rateLimited, unavailable, sessionPersistence

    public var errorDescription: String? {
        switch self {
        case .unconfirmed:
            return "メール確認が完了していません。最新の確認メールのリンクを開いてください。"
        case .invalidCredentials:
            return "メールまたはパスワードが正しくありません。登録時のパスワードを入力してください。"
        case .rateLimited:
            return "ログインの試行回数が上限に達しました。時間をおいて再度お試しください。"
        case .unavailable:
            return "認証サービスに接続できませんでした。通信状態を確認して再度お試しください。"
        case .sessionPersistence:
            return "ログイン情報を端末に保存できませんでした。アプリの署名・Keychain設定を確認してください。"
        }
    }

    static func from(_ error: Error) -> Self {
        guard let error = error as? AuthError else { return .unavailable }
        switch error.errorCode {
        case .emailNotConfirmed: return .unconfirmed
        case .invalidCredentials: return .invalidCredentials
        case .overRequestRateLimit: return .rateLimited
        default: return .unavailable
        }
    }
}

enum EmailRegistrationValidation {
    static func message(email: String, password: String, confirmation: String) -> String? {
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard email.range(of: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", options: .regularExpression) != nil else {
            return "メールアドレスを確認してください。"
        }
        guard password.count >= 12,
              password.range(of: "[a-z]", options: .regularExpression) != nil,
              password.range(of: "[A-Z]", options: .regularExpression) != nil,
              password.range(of: "[0-9]", options: .regularExpression) != nil else {
            return "パスワードは12文字以上で、英大文字・英小文字・数字を含めてください。"
        }
        guard password == confirmation else { return "確認用パスワードが一致しません。" }
        return nil
    }
}

/// Supabase 認証（匿名セッションの durable 化 + Google / email ログイン）。
/// 匿名セッションから Google を link すると Supabase user id を維持する。
public actor AuthService: AuthProviding {
    /// Supabase config.toml の exact allow-list と一致する native redirect。
    public static let oauthRedirectURL = URL(string: "oisint://account")!

    private let client: SupabaseClient
    private let supabaseURL: URL?
    private let supabaseAnonKey: String?
    private let deletionSession: URLSession
    private var sessionTask: Task<String, Error>?

    public init(client: SupabaseClient, supabaseURL: URL? = nil, supabaseAnonKey: String? = nil) {
        self.client = client
        self.supabaseURL = supabaseURL
        self.supabaseAnonKey = supabaseAnonKey
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        self.deletionSession = URLSession(
            configuration: configuration,
            delegate: NoRedirectDelegate(),
            delegateQueue: nil
        )
    }

    public func ensureUserId() async throws -> String {
        if let task = sessionTask {
            return try await task.value
        }
        let client = self.client
        let task = Task<String, Error> {
            if let session = try? await client.auth.session {
                return session.user.id.uuidString.lowercased()
            }
            do {
                let session = try await client.auth.signInAnonymously()
                return session.user.id.uuidString.lowercased()
            } catch {
                throw OISINTError("匿名サインインに失敗しました")
            }
        }
        sessionTask = task
        do {
            return try await task.value
        } catch {
            sessionTask = nil
            throw error
        }
    }

    public func accessToken() async throws -> String {
        _ = try await ensureUserId()
        guard let session = try? await client.auth.session else {
            throw OISINTError("認証セッションがありません")
        }
        return session.accessToken
    }

    public func isAnonymous() async -> Bool {
        await currentState().isAnonymous
    }

    public func currentState() async -> AuthSessionState {
        guard let session = try? await client.auth.session else {
            return .signedOut
        }
        return Self.state(from: session)
    }

    /// 匿名ユーザーでは linkIdentity を使い、別恒久ユーザーへの誤移転を防ぐ。
    public func signInWithGoogle() async throws -> AuthSessionState {
        let current = await currentState()
        if current.isAnonymous {
            try await client.auth.linkIdentity(
                provider: .google,
                scopes: "openid email profile",
                redirectTo: Self.oauthRedirectURL
            )
            return await currentState()
        }

        #if canImport(AuthenticationServices)
        _ = try await client.auth.signInWithOAuth(
            provider: .google,
            redirectTo: Self.oauthRedirectURL,
            scopes: "openid email profile",
            configure: { _ in }
        )
        #else
        _ = try await client.auth.signInWithOAuth(
            provider: .google,
            redirectTo: Self.oauthRedirectURL,
            scopes: "openid email profile",
            launchFlow: { @MainActor _ in
                throw OISINTError("OAuth を開始できません")
            }
        )
        #endif
        sessionTask = nil
        return await currentState()
    }

    public func signInWithEmail(
        email: String,
        password: String,
        confirmAccountSwitch: Bool
    ) async throws -> AuthSessionState {
        if (await currentState().userId != nil) && !confirmAccountSwitch {
            throw AuthSwitchConfirmationRequired()
        }
        let normalizedEmail = Self.normalizeEmailLogin(email)
        let session: Session
        do {
            session = try await client.auth.signIn(email: normalizedEmail, password: password)
        } catch {
            throw EmailLoginFailure.from(error)
        }
        sessionTask = nil
        let persistedState = await currentState()
        guard persistedState.isAuthenticated,
              persistedState.userId == session.user.id.uuidString.lowercased() else {
            throw EmailLoginFailure.sessionPersistence
        }
        return persistedState
    }

    public func signOut() async throws -> AuthSessionState {
        try await client.auth.signOut()
        sessionTask = nil
        return .signedOut
    }

    public func signUpWithEmail(email: String, password: String, confirmAccountSwitch: Bool) async throws {
        if (await currentState().userId != nil) && !confirmAccountSwitch {
            throw AuthSwitchConfirmationRequired()
        }
        if let message = EmailRegistrationValidation.message(email: email, password: password, confirmation: password) {
            throw OISINTError(message)
        }
        let response = try await client.auth.signUp(
            email: Self.normalizeEmailLogin(email),
            password: password,
            redirectTo: Self.oauthRedirectURL
        )
        guard response.session == nil else {
            // config.toml の enable_confirmations=true と異なる応答を受け入れない。
            try? await client.auth.signOut(scope: .local)
            sessionTask = nil
            throw EmailConfirmationUnavailable()
        }
        // 確認待ちのuserを現在のsubjectへ適用しない。匿名session/履歴を維持する。
    }

    public func resendSignUpConfirmation(email: String) async throws {
        try await client.auth.resend(
            email: Self.normalizeEmailLogin(email),
            type: .signup,
            emailRedirectTo: Self.oauthRedirectURL
        )
    }

    /// 本人JWTで同じSupabase Edge Functionを呼ぶ。service roleやraw payloadは端末へ持ち込まない。
    public func deleteAccount() async throws -> AuthSessionState {
        guard await currentState().userId != nil else {
            throw OISINTError("認証セッションがありません")
        }
        guard let supabaseURL, let supabaseAnonKey,
              Self.isValidSupabaseOrigin(supabaseURL),
              let endpoint = URL(string: "/functions/v1/delete-account", relativeTo: supabaseURL)?.absoluteURL,
              let session = try? await client.auth.session else {
            throw OISINTError("アカウント削除の接続先が設定されていません")
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let (bytes, urlResponse) = try await deletionSession.bytes(for: request)
        guard let response = urlResponse as? HTTPURLResponse, response.statusCode == 200 else {
            throw OISINTError("アカウントを削除できませんでした")
        }
        let contentLengthHeader = response.value(forHTTPHeaderField: "Content-Length")
        let contentLength = contentLengthHeader.flatMap(Int.init)
        guard contentLengthHeader == nil ||
            (contentLength != nil && contentLength! >= 0 && contentLength! <= 16 * 1024) else {
            throw OISINTError("アカウント削除の応答が大きすぎます")
        }
        var data = Data()
        data.reserveCapacity(min(contentLength ?? 16 * 1024, 16 * 1024))
        for try await byte in bytes {
            if data.count >= 16 * 1024 {
                throw OISINTError("アカウント削除の応答が大きすぎます")
            }
            data.append(byte)
        }
        guard Self.decodeDeleteResponse(data) else {
            throw OISINTError("アカウントを削除できませんでした")
        }
        var localCleanupFailed = false
        do {
            try await client.auth.signOut()
        } catch {
            localCleanupFailed = true
        }
        sessionTask = nil
        return AuthSessionState(status: .signedOut, localSessionCleanupFailed: localCleanupFailed)
    }

    /// Edgeの削除応答は exact `{ "deleted": true }` だけを受け付ける。
    /// raw bytesをfatal UTF-8で先に検証し、未知キーや型の曖昧な値を通さない。
    static func decodeDeleteResponse(_ data: Data) -> Bool {
        guard String(data: data, encoding: .utf8) != nil,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["deleted"]),
              let decoded = try? JSONDecoder().decode(DeleteResponse.self, from: data) else {
            return false
        }
        return decoded.deleted
    }

    private struct DeleteResponse: Decodable {
        let deleted: Bool
    }

    private static func isValidSupabaseOrigin(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(),
              host.range(of: "^[a-z0-9][a-z0-9-]*\\.supabase\\.co$", options: .regularExpression) != nil,
              url.user == nil, url.password == nil,
              url.port == nil || url.port == 443,
              url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return false }
        return true
    }

    public func handleOAuthCallback(_ url: URL) async throws -> AuthSessionState {
        _ = try await client.auth.session(from: url)
        sessionTask = nil
        return await currentState()
    }

    public static func normalizeEmailLogin(_ identifier: String) -> String {
        let normalized = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        #if DEBUG
        return normalized.uppercased() == "TEST" ? "test@example.com" : normalized.lowercased()
        #else
        return normalized.lowercased()
        #endif
    }

    private static func state(from session: Session) -> AuthSessionState {
        let user = session.user
        let anonymous = user.isAnonymous
        return AuthSessionState(
            status: anonymous ? .anonymous : .authenticated,
            userId: user.id.uuidString.lowercased(),
            email: anonymous ? nil : user.email,
            displayName: anonymous ? nil : metadataString(user.userMetadata, keys: ["display_name", "full_name", "name"]),
            avatarURL: anonymous ? nil : metadataString(user.userMetadata, keys: ["avatar_url", "picture"])
        )
    }

    private static func metadataString(_ metadata: [String: AnyJSON], keys: [String]) -> String? {
        for key in keys {
            if let value = metadata[key]?.stringValue, !value.isEmpty {
                return value
            }
        }
        return nil
    }
}
