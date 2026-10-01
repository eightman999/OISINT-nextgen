import Foundation

final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// API response budgets are endpoint contracts.  Research only waits for the
/// short enqueue receipt; create and requirement-added rerank wait for the
/// synchronous server-side work.
enum APIEndpointTimeoutPolicy {
    static let edgeReceipt: TimeInterval = 5
    static let edgeSynchronousCreate: TimeInterval = 10
    static let edgeSynchronousRerank: TimeInterval = 155
    static let workerReceipt: TimeInterval = 10
    static let workerSynchronousCreate: TimeInterval = 14
    static let workerSynchronousRerank: TimeInterval = 180
    static let receipt: TimeInterval = 15
    static let synchronousCreate: TimeInterval = 15
    static let synchronousRerank: TimeInterval = 210
}

/// create開始時に同一auth sessionから扱うsubjectとBearer tokenの値型。
public struct AuthSessionSnapshot: Sendable, Equatable {
    public let subject: String
    public let accessToken: String

    public init(subject: String, accessToken: String) {
        self.subject = subject
        self.accessToken = accessToken
    }
}

/// Cloudflare Worker `https://api.oisint.com/v1/*` の 4 エンドポイントクライアント
/// （計画書 §1.4 / live.ts callApi の移植。書き込みは必ずこの 4 本を経由する spec.md §25）
public struct WorkerAPIClient: Sendable {
    public let baseURL: URL
    let session: URLSession
    let allowLocalhost: Bool
    private static let maxResponseBytes = 128 * 1024
    /// 認証済み JWT（access_token）の取得。live.ts は呼び出しごとに supabase.auth.getSession() から取る
    let tokenProvider: @Sendable () async throws -> String

    public init(
        baseURL: URL,
        session: URLSession? = nil,
        allowLocalhost: Bool = false,
        tokenProvider: @escaping @Sendable () async throws -> String
    ) {
        self.baseURL = baseURL
        self.session = session ?? URLSession(
            configuration: .ephemeral,
            delegate: NoRedirectDelegate(),
            delegateQueue: nil
        )
        self.allowLocalhost = allowLocalhost
        self.tokenProvider = tokenProvider
    }

    // MARK: - エンドポイント（パス・メソッド・body は live.ts L330-364 逐語）

    public func createInvestigation(
        query: String,
        displayName: String,
        idempotencyKey: String,
        authSubject: String
    ) async throws -> CreateInvestigationResponse {
        let response: CreateInvestigationResponse = try await call(
            "POST", "/v1/investigations",
            body: ["query": query, "displayName": displayName],
            timeout: APIEndpointTimeoutPolicy.synchronousCreate,
            idempotencyKey: idempotencyKey,
            expectedSubject: authSubject
        )
        try ResponseValidation.validate(response)
        return response
    }

    public func runInvestigation(investigationId: String) async throws -> RunInvestigationResponse {
        // 投げっぱなし前提（§25.2）。呼び出し側は完了を待たず Realtime で進捗を受ける
        try await call(
            "POST",
            "/v1/investigations/\(investigationId)/research",
            body: nil,
            timeout: APIEndpointTimeoutPolicy.receipt
        )
    }

    public func rerankInvestigation(investigationId: String, trigger: RerankTrigger) async throws -> RerankInvestigationResponse {
        try await call(
            "POST", "/v1/investigations/\(investigationId)/rerank",
            body: ["trigger": trigger.rawValue],
            timeout: trigger == .requirementAdded
                ? APIEndpointTimeoutPolicy.synchronousRerank
                : APIEndpointTimeoutPolicy.receipt
        )
    }

    public func joinInvestigation(shareToken: String, displayName: String) async throws -> JoinInvestigationResponse {
        let response: JoinInvestigationResponse = try await call(
            "POST", "/v1/investigations/join",
            body: ["shareToken": shareToken, "displayName": displayName]
        )
        try ResponseValidation.validate(response)
        return response
    }

    // MARK: - callApi（live.ts L66-102 の移植）

    func call<Response: Decodable>(
        _ method: String,
        _ path: String,
        body: [String: String]?,
        timeout: TimeInterval = APIEndpointTimeoutPolicy.receipt,
        idempotencyKey: String? = nil,
        expectedSubject: String? = nil
    ) async throws -> Response {
        let token = try await tokenProvider()
        let snapshot = AuthSessionSnapshot(
            subject: Self.jwtSubject(token) ?? "",
            accessToken: token
        )
        if let expectedSubject,
           snapshot.subject.isEmpty || snapshot.subject != expectedSubject {
            // auth切替中は旧Home keyを新JWTへ送らず、送信前にfail closedする。
            throw OISINTError("認証状態が切り替わったため、調査作成を中止しました")
        }

        guard Self.isValidAPIOrigin(baseURL, allowLocalhost: allowLocalhost) else {
            throw OISINTError("API接続先が不正です")
        }
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.timeoutInterval = timeout
        request.httpMethod = method
        request.setValue("Bearer \(snapshot.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }

        let (bytes, urlResponse) = try await session.bytes(for: request)
        guard let http = urlResponse as? HTTPURLResponse else {
            throw OISINTError("API エラー (不明なレスポンス)")
        }

        var data = Data()
        data.reserveCapacity(min(Self.maxResponseBytes, 16 * 1024))
        for try await byte in bytes {
            if data.count >= Self.maxResponseBytes {
                throw OISINTError("API応答が大きすぎます")
            }
            data.append(byte)
        }
        guard String(data: data, encoding: .utf8) != nil else {
            throw OISINTError("API応答を解釈できません")
        }

        if !(200...299).contains(http.statusCode) {
            // live.ts: payload.error（日本語メッセージ）を優先、無ければ `API エラー (status)`
            if Self.hasExactKeys(data, allowed: ["error"]),
               let payload = try? JSONDecoder().decode(APIErrorPayload.self, from: data) {
                throw OISINTError(payload.error)
            }
            throw OISINTError("API エラー (\(http.statusCode))")
        }

        guard Self.hasExactResponseKeys(data, path: path) else {
            throw OISINTError("レスポンス検証に失敗しました: 不明なフィールドがあります")
        }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw OISINTError("レスポンス検証に失敗しました: \(error.localizedDescription)")
        }
    }

    private static func isValidAPIOrigin(_ url: URL, allowLocalhost: Bool) -> Bool {
        guard let host = url.host?.lowercased(),
              (url.scheme?.lowercased() == "https" ||
               (allowLocalhost && ["http", "https"].contains(url.scheme?.lowercased()))),
              host == "api.oisint.com" || (allowLocalhost && ["localhost", "127.0.0.1", "::1"].contains(host)),
              url.user == nil, url.port == nil || url.port == 443 || allowLocalhost,
              url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return false }
        return true
    }

    private static func hasExactResponseKeys(_ data: Data, path: String) -> Bool {
        let allowed: Set<String>
        if path.hasSuffix("/research") {
            allowed = ["status"]
        } else if path.hasSuffix("/rerank") {
            allowed = ["reranked"]
        } else if path.hasSuffix("/join") {
            allowed = ["investigationId", "title"]
        } else {
            allowed = ["investigationId", "shareToken"]
        }
        return hasExactKeys(data, allowed: allowed)
    }

    private static func hasExactKeys(_ data: Data, allowed: Set<String>) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        return Set(object.keys) == allowed
    }

    private static func jwtSubject(_ token: String) -> String? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let subject = object["sub"] as? String,
              !subject.isEmpty else { return nil }
        return subject
    }
}
