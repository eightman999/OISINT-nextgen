import Foundation
import Testing
@testable import OISINTKit

private let testSubject = "00000000-0000-4000-8000-000000000571"

private func testJWT(subject: String) -> String {
    let payload = try! JSONSerialization.data(withJSONObject: ["sub": subject])
        .base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    return "header.\(payload).signature"
}

/// URLProtocol スタブで request 形状（path / method / Authorization / body JSON キー）を検証（計画書 Phase 2）
@Suite(.serialized) struct WorkerAPIClientTests {
    @Test func timeoutLayersAreOrderedFromInnerToOuter() {
        #expect(APIEndpointTimeoutPolicy.edgeReceipt < APIEndpointTimeoutPolicy.workerReceipt)
        #expect(APIEndpointTimeoutPolicy.workerReceipt < APIEndpointTimeoutPolicy.receipt)
        #expect(APIEndpointTimeoutPolicy.edgeSynchronousCreate < APIEndpointTimeoutPolicy.workerSynchronousCreate)
        #expect(APIEndpointTimeoutPolicy.workerSynchronousCreate < APIEndpointTimeoutPolicy.synchronousCreate)
        #expect(APIEndpointTimeoutPolicy.edgeSynchronousRerank < APIEndpointTimeoutPolicy.workerSynchronousRerank)
        #expect(APIEndpointTimeoutPolicy.workerSynchronousRerank < APIEndpointTimeoutPolicy.synchronousRerank)
        #expect(APIEndpointTimeoutPolicy.synchronousCreate >= APIEndpointTimeoutPolicy.receipt)
        #expect(APIEndpointTimeoutPolicy.synchronousRerank > APIEndpointTimeoutPolicy.receipt)
    }

    /// テスト用スタブ。リクエストを記録し固定レスポンスを返す
    final class StubURLProtocol: URLProtocol {
        nonisolated(unsafe) static var lastRequest: URLRequest?
        nonisolated(unsafe) static var lastBody: Data?
        nonisolated(unsafe) static var responseStatus: Int = 200
        nonisolated(unsafe) static var responseBody: Data = Data("{}".utf8)

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            Self.lastRequest = request
            // httpBody は URLSession が httpBodyStream に変換するため stream から読む
            if let stream = request.httpBodyStream {
                stream.open()
                var data = Data()
                let bufferSize = 4096
                let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
                defer { buffer.deallocate() }
                while stream.hasBytesAvailable {
                    let read = stream.read(buffer, maxLength: bufferSize)
                    if read <= 0 { break }
                    data.append(buffer, count: read)
                }
                stream.close()
                Self.lastBody = data
            } else {
                Self.lastBody = request.httpBody
            }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: Self.responseStatus,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Self.responseBody)
            client?.urlProtocolDidFinishLoading(self)
        }

        override func stopLoading() {}
    }

    func makeClient(baseURL: URL = URL(string: "https://api.oisint.com")!) -> WorkerAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return WorkerAPIClient(
            baseURL: baseURL,
            session: URLSession(configuration: config),
            tokenProvider: { testJWT(subject: testSubject) }
        )
    }

    func bodyJSON() throws -> [String: String] {
        let data = try #require(StubURLProtocol.lastBody)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: String])
    }

    @Test func createInvestigationRequestShape() async throws {
        StubURLProtocol.responseStatus = 200
        StubURLProtocol.responseBody = Data(
            #"{"investigationId": "3f2b8a10-0000-4000-8000-000000000001", "shareToken": "0123456789abcdef0123456789abcdef"}"#.utf8
        )
        let response = try await makeClient().createInvestigation(
            query: "池袋で3人。肉。",
            displayName: "まさくん",
            idempotencyKey: "create-boundary-key",
            authSubject: testSubject
        )

        let request = try #require(StubURLProtocol.lastRequest)
        #expect(request.url?.path == "/v1/investigations")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(testJWT(subject: testSubject))")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "create-boundary-key")
        #expect(request.timeoutInterval == APIEndpointTimeoutPolicy.synchronousCreate)
        let body = try bodyJSON()
        #expect(body == ["query": "池袋で3人。肉。", "displayName": "まさくん"])
        #expect(response.shareToken == "0123456789abcdef0123456789abcdef")
    }

    @Test func runInvestigationRequestShape() async throws {
        StubURLProtocol.responseStatus = 202
        StubURLProtocol.responseBody = Data(#"{"status": "recalling"}"#.utf8)
        let response = try await makeClient().runInvestigation(investigationId: "abc-123")

        let request = try #require(StubURLProtocol.lastRequest)
        #expect(request.url?.path == "/v1/investigations/abc-123/research")
        #expect(request.httpMethod == "POST")
        #expect(request.timeoutInterval == APIEndpointTimeoutPolicy.receipt)
        #expect(response.status == .recalling)
    }

    @Test func rerankInvestigationRequestShape() async throws {
        StubURLProtocol.responseStatus = 200
        StubURLProtocol.responseBody = Data(#"{"reranked": true}"#.utf8)
        let response = try await makeClient().rerankInvestigation(investigationId: "abc-123", trigger: .vote)

        let request = try #require(StubURLProtocol.lastRequest)
        #expect(request.url?.path == "/v1/investigations/abc-123/rerank")
        #expect(request.timeoutInterval == APIEndpointTimeoutPolicy.receipt)
        let body = try bodyJSON()
        #expect(body == ["trigger": "vote"])
        #expect(response.reranked)
    }

    @Test func requirementAddedRerankUsesSynchronousBudget() async throws {
        StubURLProtocol.responseStatus = 200
        StubURLProtocol.responseBody = Data(#"{"reranked": true}"#.utf8)
        _ = try await makeClient().rerankInvestigation(
            investigationId: "abc-123",
            trigger: .requirementAdded
        )

        let request = try #require(StubURLProtocol.lastRequest)
        #expect(request.timeoutInterval == APIEndpointTimeoutPolicy.synchronousRerank)
    }

    @Test func rerankTriggerRawValues() {
        // §25.3 / Worker: trigger は "vote" | "requirement_added" | "requirement_removed"
        #expect(RerankTrigger.vote.rawValue == "vote")
        #expect(RerankTrigger.requirementAdded.rawValue == "requirement_added")
        #expect(RerankTrigger.requirementRemoved.rawValue == "requirement_removed")
    }

    @Test func joinInvestigationRequestShape() async throws {
        StubURLProtocol.responseStatus = 200
        StubURLProtocol.responseBody = Data(#"{"investigationId": "inv-001", "title": "8/23 池袋 夜飯"}"#.utf8)
        let response = try await makeClient().joinInvestigation(
            shareToken: "0123456789abcdef0123456789abcdef", displayName: "ゲスト"
        )

        let request = try #require(StubURLProtocol.lastRequest)
        #expect(request.url?.path == "/v1/investigations/join")
        let body = try bodyJSON()
        #expect(body == ["shareToken": "0123456789abcdef0123456789abcdef", "displayName": "ゲスト"])
        #expect(response.title == "8/23 池袋 夜飯")
    }

    @Test func errorPayloadMessageIsUsed() async throws {
        // §1.3: エラー形式 { "error": "<日本語メッセージ>" }
        StubURLProtocol.responseStatus = 409
        StubURLProtocol.responseBody = Data(#"{"error": "参加人数が上限に達しています"}"#.utf8)
        await #expect(throws: OISINTError("参加人数が上限に達しています")) {
            _ = try await makeClient().joinInvestigation(shareToken: "deadbeef", displayName: "x")
        }
    }

    @Test func nonJSONErrorFallsBackToStatusMessage() async throws {
        // live.ts: JSON でない/error キーが無い場合は `API エラー (status)`
        StubURLProtocol.responseStatus = 500
        StubURLProtocol.responseBody = Data("Internal Server Error".utf8)
        await #expect(throws: OISINTError("API エラー (500)")) {
            _ = try await makeClient().runInvestigation(investigationId: "abc")
        }
    }

    @Test func invalidShareTokenInResponseIsRejected() async throws {
        // Zod 相当: shareToken が ^[0-9a-f]{32}$ でなければ拒否
        StubURLProtocol.responseStatus = 200
        StubURLProtocol.responseBody = Data(
            #"{"investigationId": "3f2b8a10-0000-4000-8000-000000000001", "shareToken": "INVALID"}"#.utf8
        )
        await #expect(throws: OISINTError.self) {
            _ = try await makeClient().createInvestigation(
                query: "q",
                displayName: "d",
                idempotencyKey: "invalid-response-key",
                authSubject: testSubject
            )
        }
    }

    @Test func oldSubjectKeyIsNotSentWithNewBearerToken() async throws {
        let oldSubject = "00000000-0000-4000-8000-000000000571"
        let newSubject = "00000000-0000-4000-8000-000000000572"
        let payload = try JSONSerialization.data(withJSONObject: ["sub": newSubject])
        let encodedPayload = payload.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let token = "header.\(encodedPayload).signature"
        let client = WorkerAPIClient(
            baseURL: URL(string: "https://api.oisint.com")!,
            session: URLSession(configuration: .ephemeral),
            tokenProvider: { token }
        )

        await #expect(throws: OISINTError(
            "認証状態が切り替わったため、調査作成を中止しました"
        )) {
            _ = try await client.createInvestigation(
                query: "池袋",
                displayName: "利用者",
                idempotencyKey: "old-subject-key",
                authSubject: oldSubject
            )
        }
    }

    @Test func hostileAPIOriginsAreRejectedBeforeNetwork() async {
        for value in [
            "http://api.oisint.com",
            "https://api.oisint.com:8443",
            "https://user:secret@api.oisint.com",
            "https://api.oisint.com/v1",
            "https://api.oisint.com?next=https://evil.example",
            "https://attacker.example",
        ] {
            await #expect(throws: OISINTError.self) {
                _ = try await makeClient(baseURL: URL(string: value)!).runInvestigation(investigationId: "abc")
            }
        }
    }

    @Test func responseUnknownFieldsAreRejected() async {
        StubURLProtocol.responseStatus = 200
        StubURLProtocol.responseBody = Data(
            #"{"status": "recalling", "unexpected": "leak"}"#.utf8
        )
        await #expect(throws: OISINTError.self) {
            _ = try await makeClient().runInvestigation(investigationId: "abc")
        }
    }

    @Test func oversizedAndInvalidUtf8ResponsesFailClosed() async {
        StubURLProtocol.responseStatus = 200
        StubURLProtocol.responseBody = Data(repeating: 0x78, count: 128 * 1024 + 1)
        await #expect(throws: OISINTError.self) {
            _ = try await makeClient().runInvestigation(investigationId: "abc")
        }
        StubURLProtocol.responseBody = Data([0xff, 0xfe, 0xfd])
        await #expect(throws: OISINTError.self) {
            _ = try await makeClient().runInvestigation(investigationId: "abc")
        }
    }

    @Test func redirectDelegateRejectsCredentialForwarding() {
        let delegate = NoRedirectDelegate()
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: URL(string: "https://api.oisint.com/v1/research")!)
        let response = HTTPURLResponse(
            url: task.originalRequest?.url ?? URL(string: "https://api.oisint.com")!,
            statusCode: 302,
            httpVersion: nil,
            headerFields: ["Location": "https://attacker.example/collect"]
        )!
        var redirectedRequest: URLRequest? = URLRequest(url: URL(string: "https://attacker.example/collect")!)
        delegate.urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: redirectedRequest!) {
            redirectedRequest = $0
        }
        #expect(redirectedRequest == nil)
    }
}
