import Foundation
import Supabase
import Testing
@testable import OISINTKit

/// 実SDKのリクエストと確認待ちsession境界を、外部送信なしで検証する。
@Suite(.serialized) struct EmailSignUpTransportTests {
    private final class MemoryStorage: AuthLocalStorage, @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String: Data] = [:]
        func store(key: String, value: Data) throws {
            lock.lock(); defer { lock.unlock() }
            values[key] = value
        }
        func retrieve(key: String) throws -> Data? {
            lock.lock(); defer { lock.unlock() }
            return values[key]
        }
        func remove(key: String) throws {
            lock.lock(); defer { lock.unlock() }
            values.removeValue(forKey: key)
        }
    }

    private struct FailingStorage: AuthLocalStorage {
        func store(key: String, value: Data) throws { throw URLError(.cannotWriteToFile) }
        func retrieve(key: String) throws -> Data? { nil }
        func remove(key: String) throws {}
    }

    private final class Transport: URLProtocol {
        nonisolated(unsafe) static var requests: [(URLRequest, Data)] = []
        nonisolated(unsafe) static var response = Data()
        nonisolated(unsafe) static var status = 200
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            var body = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open()
                defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }
                    body.append(contentsOf: buffer.prefix(count))
                }
            }
            Self.requests.append((request, body))
            let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json", "X-Supabase-Api-Version": "2024-01-01"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: request.url?.lastPathComponent == "logout" ? Data("{}".utf8) : Self.response)
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    private let userJSON = #"{"id":"00000000-0000-4000-8000-000000000588","aud":"authenticated","app_metadata":{},"user_metadata":{},"email":"user@example.com","created_at":"2026-09-22T00:00:00Z","updated_at":"2026-09-22T00:00:00Z","is_anonymous":false}"#

    private func makeClient(storage: any AuthLocalStorage = MemoryStorage()) -> SupabaseClient {
        Transport.requests = []
        Transport.status = 200
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Transport.self]
        return SupabaseClient(
            supabaseURL: URL(string: "https://signup-fixture.supabase.co")!, supabaseKey: "fixture-public-key",
            options: .init(auth: .init(storage: storage, autoRefreshToken: false),
                           global: .init(session: URLSession(configuration: config)))
        )
    }

    @Test func signUpNormalizesEmailAndRequestsConfirmationWithoutSigningIn() async throws {
        let client = makeClient()
        Transport.response = Data(userJSON.utf8)
        let service = AuthService(client: client)
        try await service.signUpWithEmail(email: " USER@Example.com ", password: "ExamplePass123", confirmAccountSwitch: false)
        let (request, data) = try #require(Transport.requests.first)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(request.url?.path == "/auth/v1/signup")
        #expect(request.httpMethod == "POST")
        #expect(body["email"] as? String == "user@example.com")
        #expect(body["password"] as? String == "ExamplePass123")
        #expect(body["code_challenge"] != nil)
        let redirect = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "redirect_to" }?.value
        #expect(redirect == "oisint://account")
        #expect(client.auth.currentSession == nil)
        #expect(await service.currentState() == .signedOut)
    }

    @Test func resendUsesSignupTypeAndSameRedirect() async throws {
        let client = makeClient()
        Transport.response = Data("{}".utf8)
        try await AuthService(client: client).resendSignUpConfirmation(email: " USER@Example.com ")
        let (request, data) = try #require(Transport.requests.first)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(request.url?.path == "/auth/v1/resend")
        #expect(body["email"] as? String == "user@example.com")
        #expect(body["type"] as? String == "signup")
        #expect(body["password"] == nil)
        #expect(client.auth.currentSession == nil)
    }

    @Test func invalidRegistrationDoesNotSendRequest() async throws {
        let service = AuthService(client: makeClient())
        await #expect(throws: OISINTError.self) {
            try await service.signUpWithEmail(email: "bad-address", password: "short", confirmAccountSwitch: false)
        }
        #expect(Transport.requests.isEmpty)
    }

    @Test func unexpectedAutoConfirmedSessionIsRemoved() async throws {
        let client = makeClient()
        let session = "{\"access_token\":\"fixture-access\",\"token_type\":\"bearer\",\"expires_in\":3600,\"expires_at\":4102444800,\"refresh_token\":\"fixture-refresh\",\"user\":\(userJSON)}"
        Transport.response = Data(session.utf8)
        await #expect(throws: EmailConfirmationUnavailable.self) {
            try await AuthService(client: client).signUpWithEmail(email: "user@example.com", password: "ExamplePass123", confirmAccountSwitch: false)
        }
        #expect(client.auth.currentSession == nil)
        #expect(Transport.requests.last?.0.url?.path == "/auth/v1/logout")
    }

    @Test func successfulEmailLoginRequiresPersistedSession() async throws {
        for storage: any AuthLocalStorage in [MemoryStorage(), FailingStorage()] {
            let client = makeClient(storage: storage)
            Transport.response = Data("{\"access_token\":\"fixture-access\",\"token_type\":\"bearer\",\"expires_in\":3600,\"expires_at\":4102444800,\"refresh_token\":\"fixture-refresh\",\"user\":\(userJSON)}".utf8)
            let service = AuthService(client: client)
            if storage is FailingStorage {
                await #expect(throws: EmailLoginFailure.sessionPersistence) {
                    try await service.signInWithEmail(email: "user@example.com", password: "fixture", confirmAccountSwitch: false)
                }
                #expect(await service.currentState() == .signedOut)
            } else {
                let state = try await service.signInWithEmail(email: "user@example.com", password: "fixture", confirmAccountSwitch: false)
                #expect(state.isAuthenticated)
                #expect(state.userId == "00000000-0000-4000-8000-000000000588")
                #expect(await service.currentState() == state)
            }
        }
    }

    @Test func emailLoginFailuresPreserveSafeReasonWithoutProviderMessage() async throws {
        let cases: [(String, EmailLoginFailure)] = [
            ("email_not_confirmed", .unconfirmed),
            ("invalid_credentials", .invalidCredentials),
            ("over_request_rate_limit", .rateLimited),
            ("unexpected_failure", .unavailable),
        ]
        for (code, expected) in cases {
            let client = makeClient()
            Transport.status = 400
            Transport.response = try JSONSerialization.data(withJSONObject: [
                "code": code, "msg": "private-provider-detail"
            ])
            do {
                _ = try await AuthService(client: client).signInWithEmail(
                    email: "user@example.com", password: "fixture", confirmAccountSwitch: false
                )
                Issue.record("Rejected credentials must not log in")
            } catch let failure as EmailLoginFailure {
                #expect(failure == expected)
                #expect(!failure.localizedDescription.contains("private-provider-detail"))
            }
            #expect(client.auth.currentSession == nil)
        }
        #expect(EmailLoginFailure.from(URLError(.notConnectedToInternet)) == .unavailable)
    }
}
